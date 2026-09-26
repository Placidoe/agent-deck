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
    this.binary = options.binary || resolveCodexBinary();
    this.spawnProcess = options.spawnProcess || spawn;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.loadedThreads = new Set();
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
      this.request("model/list", { limit: 30, includeHidden: false }).catch(() => ({ data: [] })),
    ]);
    const version = spawnSync(this.binary, ["--version"], { encoding: "utf8" }).stdout?.trim() || "Codex";
    return {
      available: true,
      authenticated: Boolean(accountResult.account),
      account: accountResult.account,
      requiresOpenaiAuth: accountResult.requiresOpenaiAuth,
      version,
      models: modelsResult.data || [],
    };
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

  async createThread({ cwd, title, model, dynamicTools }) {
    await this.start();
    const started = await this.request("thread/start", {
      cwd,
      ...(model ? { model } : {}),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
      serviceName: "agent_deck",
      ...(dynamicTools?.length ? { dynamicTools } : {}),
    });
    const threadId = started.thread.id;
    this.loadedThreads.add(threadId);
    if (title) await this.request("thread/name/set", { threadId, name: title }).catch(() => {});
    return { thread: { ...started.thread, name: title || started.thread.name }, model: started.model };
  }

  async resumeThread(threadId, cwd) {
    await this.start();
    if (this.loadedThreads.has(threadId)) return null;
    const result = await this.request("thread/resume", {
      threadId,
      ...(cwd ? { cwd } : {}),
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox: "workspace-write",
    });
    this.loadedThreads.add(threadId);
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

  async sendTurn({ threadId, cwd, prompt, model, effort, outputSchema, additionalContext }) {
    if (outputSchema) assertStrictOutputSchema(outputSchema);
    await this.resumeThread(threadId, cwd);
    const result = await this.request("turn/start", {
      threadId,
      ...(cwd ? { cwd } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(outputSchema ? { outputSchema } : {}),
      ...(additionalContext ? { additionalContext } : {}),
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
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
    this.emit("event", { method: "agentDeck/serverExit", params: { message: error.message } });
  }
}

module.exports = { CodexAppServer, resolveCodexBinary };
