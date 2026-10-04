const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const readline = require("node:readline");
const { assertStrictOutputSchema } = require("./structured-output-schema.cjs");

function resolveCodexBinary() {
  const candidates = [
    process.env.CODEX_BINARY,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    `${process.env.HOME || ""}/Applications/ChatGPT.app/Contents/Resources/codex`,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const found = spawnSync("/usr/bin/which", ["codex"], { encoding: "utf8" }).stdout?.trim();
  return found || "codex";
}

class CodexAppServer extends EventEmitter {
  constructor(options = {}) {
    super();
    // Native Harness mode constructs compatibility services but must not even
    // probe a Codex installation unless an external task actually needs it.
    this.binary = options.binary || null;
    this.spawnProcess = options.spawnProcess || spawn;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.loadedThreads = new Set();
    this.threadModels = new Map();
    this.threadMutations = new Map();
    this.modelCatalog = null;
    this.modelCatalogPromise = null;
  }

  async start() {
    if (this.proc && !this.proc.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.#start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    this.binary ||= resolveCodexBinary();
    const appPath = ["/opt/homebrew/bin", "/usr/local/bin", process.env.PATH || ""].join(":");
    const proc = this.spawnProcess(this.binary, [
      "app-server",
      "--listen",
      "stdio://",
      "--enable",
      "realtime_conversation",
    ], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: appPath },
    });
    this.proc = proc;
    const lines = readline.createInterface({ input: proc.stdout });
    lines.on("line", (line) => this.#handleLine(line));
    proc.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message && !message.includes("could not update PATH")) {
        this.emit("event", { method: "agentDeck/serverLog", params: { message } });
      }
    });
    proc.on("error", (error) => this.#handleExit(error));
    proc.on("exit", (code, signal) => this.#handleExit(new Error(`Codex app-server exited (${code ?? signal})`)));

    await this.request("initialize", {
      clientInfo: { name: "agent_deck", title: "Agent Deck", version: "0.2.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    }, 15000);
    this.notify("initialized", {});
  }

  stop() {
    const proc = this.proc;
    this.proc = null;
    if (proc && !proc.killed) proc.kill("SIGTERM");
    this.loadedThreads.clear();
    this.threadModels.clear();
    this.threadMutations.clear();
    this.modelCatalog = null;
  }

  notify(method, params) {
    this.#write({ method, params });
  }

  request(method, params, timeoutMs = 30000) {
    if (!this.proc?.stdin?.writable) return Promise.reject(new Error("Codex app-server is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      this.#write({ method, id, params });
    });
  }

  async getStatus() {
    await this.start();
    const [accountResult, modelsResult] = await Promise.all([
      this.request("account/read", { refreshToken: false }),
      this.listModels({ refresh: true }),
    ]);
    const version = spawnSync(this.binary, ["--version"], { encoding: "utf8" }).stdout?.trim() || "Codex";
    return {
      available: true,
      authenticated: Boolean(accountResult.account),
      account: accountResult.account,
      requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
      version,
      models: modelsResult,
    };
  }

  async listModels({ refresh = false } = {}) {
    await this.start();
    if (!refresh && this.modelCatalog && Date.now() - this.modelCatalog.at < 30000) return this.modelCatalog.models;
    if (this.modelCatalogPromise) return this.modelCatalogPromise;
    this.modelCatalogPromise = (async () => {
      const models = [];
      const cursors = new Set();
      let cursor;
      for (let page = 0; page < 20; page += 1) {
        const result = await this.request("model/list", { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
        if (!Array.isArray(result.data)) throw new Error("CODEX_MODEL_CATALOG_UNAVAILABLE: 无法读取 Codex 模型列表；请刷新连接后重试。");
        for (const model of result.data) if (!model.hidden && typeof (model.model || model.id) === "string") models.push(model);
        if (!result.nextCursor) {
          this.modelCatalog = { at: Date.now(), models };
          return models;
        }
        if (cursors.has(result.nextCursor)) break;
        cursor = result.nextCursor;
        cursors.add(cursor);
      }
      throw new Error("CODEX_MODEL_CATALOG_UNAVAILABLE: Codex 模型列表分页异常，请刷新连接。");
    })();
    try { return await this.modelCatalogPromise; }
    finally { this.modelCatalogPromise = null; }
  }

  async resolveModel(requested, options) {
    const models = await this.listModels(options);
    const model = String(requested || "").trim();
    const selected = model
      ? models.find(item => (item.model || item.id) === model)
      : models.find(item => item.isDefault) || models[0];
    if (!selected) throw new Error(model
      ? `CODEX_MODEL_NOT_LISTED: 模型 '${model}' 不在本地 Codex 模型列表中。请刷新模型列表并明确选择；不会自动换模型。`
      : "CODEX_MODEL_CATALOG_UNAVAILABLE: Codex 未返回可选模型；不会继承全局模型配置，请检查登录与连接。");
    return selected.model || selected.id;
  }

  async listThreads(cwd) {
    await this.start();
    const result = await this.request("thread/list", {
      limit: 30,
      sortKey: "updated_at",
      sortDirection: "desc",
      archived: false,
      ...(cwd ? { cwd } : {}),
    });
    return result.data || [];
  }

  async startSession({ cwd, title, prompt, model, effort }) {
    const created = await this.createThread({ cwd, title, model });
    const turn = await this.sendTurn({ threadId: created.thread.id, cwd, prompt, model, effort });
    return { ...created, turn };
  }

  async createThread({ cwd, title, model, dynamicTools, ephemeral = false, allowMutations = true }) {
    await this.start();
    const selectedModel = await this.resolveModel(model);
    const started = await this.request("thread/start", {
      cwd,
      model: selectedModel,
      ...(ephemeral ? { ephemeral: true } : {}),
      approvalPolicy: allowMutations ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: allowMutations ? "workspace-write" : "read-only",
      serviceName: "agent_deck",
      ...(dynamicTools?.length ? { dynamicTools } : {}),
    });
    const threadId = started.thread.id;
    this.loadedThreads.add(threadId);
    this.threadModels.set(threadId, started.model || selectedModel);
    this.threadMutations.set(threadId, allowMutations);
    if (title) await this.request("thread/name/set", { threadId, name: title }).catch(() => {});
    return { thread: { ...started.thread, name: title || started.thread.name }, model: started.model || selectedModel };
  }

  async resumeThread(threadId, cwd, allowMutations = this.threadMutations.get(threadId) ?? true) {
    await this.start();
    if (this.loadedThreads.has(threadId)) return null;
    const result = await this.request("thread/resume", {
      threadId,
      ...(cwd ? { cwd } : {}),
      approvalPolicy: allowMutations ? "on-request" : "never",
      approvalsReviewer: "user",
      sandbox: allowMutations ? "workspace-write" : "read-only",
    });
    this.loadedThreads.add(threadId);
    this.threadMutations.set(threadId, allowMutations);
    if (result.model) this.threadModels.set(threadId, result.model);
    return result.thread || result;
  }

  async readThread(threadId, includeTurns = true) {
    await this.start();
    const result = await this.request("thread/read", { threadId, includeTurns });
    return result.thread;
  }

  async archiveThread(threadId) {
    await this.start();
    return this.request("thread/archive", { threadId });
  }

  async sendTurn({ threadId, cwd, prompt, model, effort, outputSchema, additionalContext, allowMutations = this.threadMutations.get(threadId) ?? true }) {
    if (outputSchema) assertStrictOutputSchema(outputSchema);
    await this.resumeThread(threadId, cwd, allowMutations);
    const selectedModel = await this.resolveModel(model || this.threadModels.get(threadId));
    const result = await this.request("turn/start", {
      threadId,
      ...(cwd ? { cwd } : {}),
      model: selectedModel,
      ...(!allowMutations ? { approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } } : {}),
      ...(effort ? { effort } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    this.threadModels.set(threadId, selectedModel);
    this.threadMutations.set(threadId, allowMutations);
    return result.turn;
  }

  async steer({ threadId, turnId, prompt }) {
    await this.start();
    return this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
  }

  async interrupt({ threadId, turnId }) {
    await this.start();
    return this.request("turn/interrupt", { threadId, turnId });
  }

  async injectItems(threadId, text) {
    await this.resumeThread(threadId);
    return this.request("thread/inject_items", {
      threadId,
      items: [{ type: "message", role: "user", content: [{ type: "input_text", text }] }],
    });
  }

  async startRealtime({ threadId, cwd, sdp, voice, version = "v3" }) {
    await this.resumeThread(threadId, cwd);
    return this.request("thread/realtime/start", {
      threadId,
      outputModality: "audio",
      includeStartupContext: true,
      flushTranscriptTailOnSessionEnd: true,
      transport: { type: "webrtc", sdp },
      ...(version ? { version } : {}),
      ...(voice ? { voice } : {}),
    }, 45000);
  }

  async stopRealtime({ threadId }) {
    await this.start();
    return this.request("thread/realtime/stop", { threadId }, 15000);
  }

  respondToApproval({ requestId, decision }) {
    this.#write({ id: requestId, result: { decision } });
  }

  respondToRequest(requestId, result, error) {
    this.#write(error ? { id: requestId, error } : { id: requestId, result });
  }

  #write(message) {
    if (!this.proc?.stdin?.writable) throw new Error("Codex app-server is not running");
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit("event", { method: "agentDeck/serverLog", params: { message: line } });
      return;
    }
    if (message.method) {
      this.emit("event", message);
      return;
    }
    if (message.id != null && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message || `${pending.method} failed`));
      else pending.resolve(message.result);
      return;
    }
    this.emit("event", message);
  }

  #handleExit(error) {
    if (!this.proc) return;
    this.proc = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    this.loadedThreads.clear();
    this.threadModels.clear();
    this.threadMutations.clear();
    this.modelCatalog = null;
    this.emit("event", { method: "agentDeck/serverExit", params: { message: error.message } });
  }
}

module.exports = { CodexAppServer, resolveCodexBinary };
