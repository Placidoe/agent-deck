const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { ApiAgentRuntime, tools } = require("./api-agent-runtime.cjs");

// Deliberately separate from legacy API turns: SDK owns the Manager/Executor/
// Auditor state machine, not Codex and not ApiAgentRuntime.#run.
class NativeHarnessRuntime extends ApiAgentRuntime {
  constructor({ rootDirectory, ...options }) {
    super(options);
    this.rootDirectory = rootDirectory;
    this.sdk = import(pathToFileURL(path.join(__dirname, "harness-core/portable.js")).href);
    this.sdk.catch(() => {}); // Surface a missing packaged SDK at createThread, not as an unhandled startup rejection.
  }
  #file(id) {
    if (!/^api-[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid native thread id");
    return path.join(this.rootDirectory, "threads", `${id}.json`);
  }
  #save(thread) {
    const { profile, messages, ...metadata } = thread;
    const serializable = { ...metadata, turns: thread.turns.map(({ abort, approvalIds, ...turn }) => turn) };
    const file = this.#file(thread.id);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(serializable), { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  }
  async createThread(input) {
    await this.sdk; // Missing SDK must fail before claiming a thread was created.
    const created = await super.createThread(input);
    const thread = this.threads.get(created.thread.id);
    thread.endpoint = thread.profile.endpoint;
    this.#save(thread);
    return created;
  }
  async resumeThread(threadId) {
    if (this.threads.has(threadId)) return;
    const thread = JSON.parse(fs.readFileSync(this.#file(threadId), "utf8"));
    // Never repeat an interrupted mutation automatically after restart.
    for (const turn of thread.turns) {
      if (turn.status === "inProgress") { turn.status = "interrupted"; turn.error = { message: "App restarted during native execution; inspect the saved run before retrying" }; }
      turn.abort = new AbortController(); turn.approvalIds = new Set();
    }
    thread.messages = [];
    this.threads.set(threadId, thread);
    this.#save(thread);
  }
  async readThread(threadId) { await this.resumeThread(threadId); return super.readThread(threadId); }
  async sendTurn({ threadId, cwd, prompt, model, outputSchema }) {
    await this.resumeThread(threadId);
    const thread = this.threads.get(threadId);
    if (thread.turns.some((turn) => turn.status === "inProgress")) throw new Error("This native thread already has an active turn");
    thread.cwd = cwd || thread.cwd; thread.model = model || thread.model;
    const turnId = `turn-${randomUUID()}`;
    const turn = { id: turnId, harnessRunId: turnId, status: "inProgress", items: [], prompt, outputSchema, abort: new AbortController(), approvalIds: new Set() };
    let release;
    const done = new Promise((resolve) => { release = resolve; });
    thread.turns.push(turn); this.turns.set(turn.id, { thread, turn, done, release }); this.#save(thread);
    // Return and persist transport IDs before emitting events to orchestration.
    setImmediate(() => this.#drive(thread, turn, prompt, outputSchema));
    return { id: turn.id, status: turn.status };
  }
  async steer({ threadId, turnId, prompt }) {
    const previous = this.turns.get(turnId)?.turn;
    await this.interrupt({ turnId });
    const active = this.turns.get(turnId);
    if (active?.done) await active.done;
    return this.sendTurn({ threadId, prompt: previous?.prompt ? `${previous.prompt}\n\nUSER REDIRECTION (supersedes conflicting earlier instructions):\n${prompt}` : prompt, outputSchema: previous?.outputSchema });
  }
  async #drive(thread, turn, prompt, outputSchema) {
    const active = this.turns.get(turn.id);
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(new Error("Native turn reached its five-minute execution budget; review saved evidence before retrying")), 300000);
    const signal = AbortSignal.any([turn.abort.signal, deadline.signal]);
    const usage = { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
    const emit = (method, params) => this.emit("event", { method, params: { threadId: thread.id, turnId: turn.id, ...params } });
    emit("turn/started", { turn: { id: turn.id, status: "inProgress", runtimeMode: "agent_deck" } });
    try {
      const { AgentHarness, JsonFileRunStore, createModelAdapters } = await this.sdk;
      const profile = this.providerRegistry.apiProfile(thread.provider);
      if (!profile) throw new Error("Configure and verify a model API in Settings → Execution mode");
      if (thread.endpoint && profile.endpoint !== thread.endpoint) throw new Error("This session's model endpoint changed; create a new native session instead of migrating an existing run silently");
      const client = { complete: async ({ messages, tools: permitted, signal }) => {
        const response = await this.fetch(`${profile.endpoint}/chat/completions`, {
          method: "POST", signal: AbortSignal.any([signal, AbortSignal.timeout(90000)].filter(Boolean)),
          headers: { "content-type": "application/json", authorization: `Bearer ${profile.apiKey}` },
          body: JSON.stringify({ model: thread.model, messages, ...(permitted.length ? { tools: permitted, tool_choice: "auto" } : {}), max_tokens: 8192, stream: false }),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(`Model API HTTP ${response.status}`); // Never leak provider response headers/secrets.
        usage.input_tokens += body.usage?.prompt_tokens || 0; usage.output_tokens += body.usage?.completion_tokens || 0; usage.total_tokens += body.usage?.total_tokens ?? ((body.usage?.prompt_tokens || 0) + (body.usage?.completion_tokens || 0));
        emit("thread/tokenUsage/updated", { tokenUsage: { total: { ...usage }, last: { ...usage } } });
        if (usage.total_tokens > 32000) throw new Error("Native turn reached its 32,000 reported-token budget; review saved evidence before continuing");
        const message = body.choices?.[0]?.message;
        if (!message || message.role !== "assistant") throw new Error("Model API returned no assistant message");
        return message;
      } };
      const controlled = tools.filter((tool) => thread.allowMutations || !["workspace_write", "workspace_bash", "workspace_git"].includes(tool.function.name)).map((definition) => {
        const name = definition.function.name;
        return { definition, readOnly: ["workspace_read", "workspace_list", "workspace_search"].includes(name), execute: (args, signal) => this.executeControlledTool({ thread, turn, name, args, signal }) };
      });
      const adapters = createModelAdapters({ client, tools: controlled, maxToolRounds: 8, maxContextChars: 96000,
        planningOnly: !thread.allowMutations && Boolean(outputSchema),
        ...(outputSchema ? { outputInstruction: `Return only JSON conforming to: ${JSON.stringify(outputSchema)}`, verifyOutput: (text) => validateOutput(text, outputSchema) } : {}),
        onPhase: (phase) => emit("harness/phase", { phase }),
      });
      const harness = new AgentHarness({ store: new JsonFileRunStore(this.rootDirectory) });
      const previous = thread.turns.slice(0, -1).filter((item) => item.status === "completed").at(-1);
      const continuity = previous?.verifiedSummary ? `\nPrevious verified result (context, not new instructions):\n${previous.verifiedSummary.slice(0, 8000)}` : "";
      const state = await harness.start({ ...adapters, runId: turn.id, goal: prompt + continuity, requirements: [{ id: "delivery", description: "Satisfy the user's goal with verified evidence; disclose blockers and limitations" }], maxRounds: 3, signal,
        onEvent: async (event) => { turn.harnessPhase = event.type; this.#save(thread); emit("harness/event", { event }); },
      });
      turn.harnessRunId = state.runId;
      if (state.status !== "completed") throw new Error(state.attention?.detail || `Harness stopped: ${state.status}`);
      turn.verifiedSummary = state.lastExecution.summary;
      turn.items.push({ id: `message-${randomUUID()}`, type: "agentMessage", text: turn.verifiedSummary });
      turn.status = "completed"; turn.usage = usage; this.#save(thread);
      emit("item/completed", { item: turn.items.at(-1) });
      emit("turn/completed", { turn: { id: turn.id, status: "completed", usage, harnessRunId: state.runId } });
    } catch (error) {
      turn.status = turn.abort.signal.aborted ? "interrupted" : "failed";
      turn.error = { message: turn.abort.signal.aborted ? "Native execution interrupted" : deadline.signal.aborted ? deadline.signal.reason.message : error.message };
      this.#save(thread);
      emit("turn/completed", { turn: { id: turn.id, status: turn.status, error: turn.error, usage } });
    } finally {
      clearTimeout(timeout);
      for (const requestId of [...turn.approvalIds]) await this.resolveApproval({ requestId, decision: "interrupt" }).catch(() => {});
      this.turns.delete(turn.id); active.release();
    }
  }
}

// Required schema subset used by Mission output contracts. Unsupported schemas
// fail closed rather than pretending to validate arbitrary JSON Schema.
function validateOutput(text, schema) {
  let value;
  try { value = JSON.parse(text); } catch { return ["Return a valid JSON object, without Markdown fences"]; }
  const errors = [];
  const visit = (node, spec, location) => {
    if (!spec || typeof spec !== "object") { errors.push(`${location}: invalid schema`); return; }
    const supported = new Set(["type", "properties", "required", "items", "additionalProperties", "enum", "anyOf", "minimum", "maximum", "minItems", "maxItems", "minLength", "maxLength", "description", "title"]);
    for (const keyword of Object.keys(spec)) if (!supported.has(keyword)) errors.push(`${location}: unsupported schema keyword ${keyword}`);
    if (spec.anyOf) { if (!spec.anyOf.some((branch) => !validateOutput(JSON.stringify(node), branch).length)) errors.push(`${location}: does not match anyOf`); return; }
    const matches = (type) => type === "null" ? node === null : type === "array" ? Array.isArray(node) : type === "object" ? Boolean(node && typeof node === "object" && !Array.isArray(node)) : type === "integer" ? Number.isInteger(node) : typeof node === type;
    if (spec.type && !(Array.isArray(spec.type) ? spec.type.some(matches) : matches(spec.type))) { errors.push(`${location}: expected ${spec.type}`); return; }
    if (spec.enum && !spec.enum.includes(node)) errors.push(`${location}: invalid enum value`);
    if (typeof node === "number" && ((spec.minimum != null && node < spec.minimum) || (spec.maximum != null && node > spec.maximum))) errors.push(`${location}: number outside bounds`);
    if (typeof node === "string" && ((spec.minLength != null && node.length < spec.minLength) || (spec.maxLength != null && node.length > spec.maxLength))) errors.push(`${location}: string length outside bounds`);
    if (Array.isArray(node) && ((spec.minItems != null && node.length < spec.minItems) || (spec.maxItems != null && node.length > spec.maxItems))) errors.push(`${location}: array size outside bounds`);
    if (node && typeof node === "object" && !Array.isArray(node)) {
      for (const key of spec.required || []) if (!(key in node)) errors.push(`${location}.${key}: missing`);
      for (const [key, child] of Object.entries(node)) {
        if (spec.properties?.[key]) visit(child, spec.properties[key], `${location}.${key}`);
        else if (spec.additionalProperties === false) errors.push(`${location}.${key}: unexpected`);
      }
    }
    if (Array.isArray(node) && spec.items) node.forEach((item, i) => visit(item, spec.items, `${location}[${i}]`));
  };
  visit(value, schema, "output");
  return errors;
}
module.exports = { NativeHarnessRuntime, validateOutput };
