const { EventEmitter } = require("node:events");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { runDebugCommand } = require("./terminal-service.cjs");
const { USER_LANGUAGE_CONTRACT } = require("./user-language.cjs");
const { preauthorizedTool } = require("./execution-mode.cjs");

const MAX_TOOL_ROUNDS = 12;
const MAX_FILE_BYTES = 96 * 1024;
const MAX_WRITE_BYTES = 192 * 1024;
const MAX_GIT_MESSAGE_LENGTH = 240;
const MUTATING_GIT_OPERATIONS = new Set(["stage", "commit"]);
const APPROVAL_STATES = new Set(["requested", "approved", "declined", "executing", "executed", "failed"]);

function inside(root, candidate) {
  const resolvedRoot = fs.realpathSync(root);
  const resolved = path.resolve(resolvedRoot, candidate || ".");
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Tool path is outside the assigned workspace");
  return resolved;
}

function compact(value, limit = 18000) {
  const text = String(value || "");
  return text.length > limit ? `${text.slice(0, limit)}\n… [Agent Deck truncated tool output]` : text;
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\\"'\\\"'")}'`; }

function assertRelativePath(value, label = "path") {
  const candidate = String(value || "").trim();
  if (!candidate) throw new Error(`${label} is required`);
  if (path.isAbsolute(candidate) || candidate === ".." || candidate.startsWith(`..${path.sep}`) || candidate.includes("/../") || candidate.includes("\\..\\") || candidate.startsWith("~")) {
    throw new Error(`${label} must stay inside the assigned workspace`);
  }
  return candidate;
}

// Manual API Workers never receive a general-purpose shell. The narrow set below is
// intentionally limited to common local verification commands. Every command
// still needs a one-time user approval before it can run.
function assertSelectedWorkspaceCommand(command) {
  const source = String(command || "").trim();
  if (!source) throw new Error("Command is required");
  if (source.length > 8000) throw new Error("Command is too long");
  if (/[;&|`$<>\n\r]/.test(source) || /\$\(|\{/.test(source)) throw new Error("Shell chaining, redirects, interpolation, and subshells are not allowed");
  const tokens = source.split(/\s+/);
  if (tokens.some((token) => token === ".." || token.startsWith("../") || token.startsWith("/") || token.startsWith("~") || token === "--prefix" || token === "--cwd")) {
    throw new Error("Command arguments must stay inside the assigned workspace");
  }
  const [bin, verb] = tokens;
  const valid = (
    (["npm", "pnpm", "yarn"].includes(bin) && ["test", "run"].includes(verb)) ||
    (bin === "bun" && ["test", "run"].includes(verb)) ||
    (bin === "node" && verb === "--test") ||
    (bin === "go" && verb === "test") ||
    (bin === "cargo" && ["test", "check"].includes(verb)) ||
    (["python", "python3"].includes(bin) && verb === "-m" && tokens[2] === "pytest") ||
    (bin === "pytest") ||
    (bin === "ruff" && verb === "check") ||
    (bin === "eslint") ||
    (bin === "tsc") ||
    (bin === "vitest") ||
    // `printf` is useful for a deterministic, side-effect-free smoke check.
    // It remains approval-gated like every workspace_bash invocation.
    (bin === "printf" && tokens.length >= 2 && !tokens[1].startsWith("-"))
  );
  if (!valid) throw new Error("This command is outside the API Worker's selected verification-command policy");
  return source;
}

function gitCommand(args) {
  const operation = String(args.operation || "");
  if (["status", "diff", "worktree_status"].includes(operation)) {
    return ({ status: "git status --short", diff: "git diff --", worktree_status: "git worktree list --porcelain" })[operation];
  }
  if (operation === "stage") {
    if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 50) throw new Error("Stage requires 1–50 workspace-relative paths");
    return `git add -- ${args.paths.map((entry) => shellQuote(assertRelativePath(entry, "Git path"))).join(" ")}`;
  }
  if (operation === "commit") {
    const message = String(args.message || "").trim();
    if (!message || message.length > MAX_GIT_MESSAGE_LENGTH || /[\n\r]/.test(message)) throw new Error(`Commit message must be 1–${MAX_GIT_MESSAGE_LENGTH} characters on one line`);
    return `git commit -m ${shellQuote(message)}`;
  }
  throw new Error("Unsupported Git operation");
}

function safeFile(root, candidate) {
  const target = inside(root, candidate);
  const resolvedRoot = fs.realpathSync(root);
  const parent = fs.realpathSync(path.dirname(target));
  const relativeParent = path.relative(resolvedRoot, parent);
  if (relativeParent === ".." || relativeParent.startsWith(`..${path.sep}`) || path.isAbsolute(relativeParent)) throw new Error("Tool path resolves outside the assigned workspace");
  if (!fs.existsSync(target)) return target;
  const resolved = fs.realpathSync(target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Tool path resolves outside the assigned workspace");
  return resolved;
}

function safeDirectory(root, candidate) {
  const target = inside(root, candidate);
  if (!fs.existsSync(target)) throw new Error("Workspace path does not exist");
  const resolvedRoot = fs.realpathSync(root);
  const resolved = fs.realpathSync(target);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Tool path resolves outside the assigned workspace");
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Path is not a directory");
  return resolved;
}

const tools = [
  { type: "function", function: { name: "workspace_list", description: "List files and folders below the assigned workspace. This tool is read-only.", parameters: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, depth: { type: "integer", minimum: 1, maximum: 3 } } } } },
  { type: "function", function: { name: "workspace_read", description: "Read a UTF-8 text file below the assigned workspace. This tool is read-only and truncates very large files.", parameters: { type: "object", additionalProperties: false, required: ["path"], properties: { path: { type: "string" }, startLine: { type: "integer", minimum: 1 }, endLine: { type: "integer", minimum: 1 } } } } },
  { type: "function", function: { name: "workspace_search", description: "Search text files below the assigned workspace with a literal query. This tool is read-only.", parameters: { type: "object", additionalProperties: false, required: ["query"], properties: { query: { type: "string", minLength: 1, maxLength: 160 }, maxResults: { type: "integer", minimum: 1, maximum: 40 } } } } },
  { type: "function", function: { name: "workspace_write", description: "Write one UTF-8 text file inside the assigned workspace. This is a destructive action and always pauses for explicit human approval.", parameters: { type: "object", additionalProperties: false, required: ["path", "content"], properties: { path: { type: "string" }, content: { type: "string", maxLength: MAX_WRITE_BYTES } } } } },
  { type: "function", function: { name: "workspace_bash", description: "Run a Bash command inside the assigned workspace. This is a destructive action and always pauses for explicit human approval. Use it for tests, builds, or carefully scoped local changes.", parameters: { type: "object", additionalProperties: false, required: ["command"], properties: { command: { type: "string", minLength: 1, maxLength: 8000 }, timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 } } } } },
  { type: "function", function: { name: "workspace_git", description: "Inspect the assigned Git worktree, stage selected workspace files, or create one commit. Stage and commit always pause for explicit human approval. Agent Deck creates and assigns worktrees; do not create or remove worktrees from this tool.", parameters: { type: "object", additionalProperties: false, required: ["operation"], properties: { operation: { type: "string", enum: ["status", "diff", "worktree_status", "stage", "commit"] }, paths: { type: "array", minItems: 1, maxItems: 50, items: { type: "string" } }, message: { type: "string", maxLength: MAX_GIT_MESSAGE_LENGTH }, timeoutMs: { type: "integer", minimum: 1000, maximum: 120000 } } } } },
];

class ApiAgentRuntime extends EventEmitter {
  constructor({ providerRegistry, fetchImpl = fetch, commandRunner = runDebugCommand } = {}) {
    super();
    this.providerRegistry = providerRegistry;
    this.fetch = fetchImpl;
    this.commandRunner = commandRunner;
    this.threads = new Map();
    this.turns = new Map();
    this.approvals = new Map();
  }

  async createThread({ cwd, title, model, provider = "deepseek", allowMutations = false, interactionMode = "manual" }) {
    require("./execution-mode.cjs").interactionMode(interactionMode);
    const profile = this.providerRegistry.apiProfile(provider);
    if (!profile) throw new Error(`${provider} is not configured. Save and test its API connection in Settings → Provider adapters.`);
    const id = `api-${randomUUID()}`;
    this.threads.set(id, { id, cwd, name: title || "API session", provider, model: model || profile.model, profile, interactionMode, allowMutations: Boolean(allowMutations), turns: [], messages: [] });
    return { thread: { id, name: title || "API session", cwd }, model: model || profile.model };
  }

  async sendTurn({ threadId, cwd, prompt, model, outputSchema }) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("This API session is no longer available after restart. Create a new API mission turn.");
    const turn = { id: `turn-${randomUUID()}`, status: "inProgress", abort: new AbortController(), items: [], approvalIds: new Set() };
    thread.cwd = cwd || thread.cwd; thread.model = model || thread.model; thread.turns.push(turn); this.turns.set(turn.id, { thread, turn });
    queueMicrotask(() => this.#run(thread, turn, prompt, outputSchema));
    return turn;
  }

  async steer({ threadId, turnId, prompt }) { await this.interrupt({ threadId, turnId }); return this.sendTurn({ threadId, prompt }); }
  async interrupt({ turnId }) {
    const active = this.turns.get(turnId);
    if (active?.turn.status === "inProgress") {
      active.turn.abort.abort();
      for (const requestId of active.turn.approvalIds) this.resolveApproval({ requestId, decision: "interrupt" });
    }
    return { interrupted: Boolean(active) };
  }
  async resolveApproval({ requestId, decision }) {
    const approval = this.approvals.get(requestId);
    if (!approval) throw new Error("This API approval request is no longer pending");
    if (!APPROVAL_STATES.has(decision === "accept" ? "approved" : "declined") || !["accept", "decline", "interrupt"].includes(decision)) throw new Error("Approval decision must be accept or decline");
    this.approvals.delete(requestId);
    approval.turn.approvalIds.delete(requestId);
    approval.resolve(decision);
    const state = decision === "accept" ? "approved" : "declined";
    this.emit("event", { method: "item/approval/resolved", params: { threadId: approval.threadId, turnId: approval.turnId, requestId, decision, state, item: { ...approval.item, state } } });
    return { requestId, decision, state, threadId: approval.threadId, turnId: approval.turnId, item: approval.item };
  }
  pendingApproval(requestId) { return this.approvals.get(requestId); }
  async resumeThread(threadId) { if (!this.threads.has(threadId)) throw new Error("API session is not resident after restart"); }
  async readThread(threadId) { const thread = this.threads.get(threadId); if (!thread) throw new Error("API session is not resident after restart"); const { profile, ...metadata } = thread; return { ...metadata, turns: thread.turns.map(({ abort, approvalIds, ...turn }) => ({ ...turn, approvalIds: [...approvalIds] })) }; }

  // Shared host-controlled tools. The native SDK owns its own execution loop;
  // reusing this broker does not invoke the legacy API conversation runtime.
  async executeControlledTool({ thread, turn, name, args, signal }) {
    signal?.throwIfAborted();
    const destructive = ["workspace_write", "workspace_bash"].includes(name) || (name === "workspace_git" && MUTATING_GIT_OPERATIONS.has(args.operation));
    const type = name === "workspace_bash" ? "commandExecution" : name === "workspace_git" ? "gitOperation" : destructive ? "fileChange" : "mcpToolCall";
    const item = { id: `tool-${randomUUID()}`, type, tool: name, server: "agent-deck-harness", command: args.command, path: args.path, operation: args.operation, approvalRequired: destructive, state: destructive ? "requested" : "executing" };
    this.emit("event", { method: "item/started", params: { threadId: thread.id, turnId: turn.id, item } });
    let result;
    try {
      if (destructive) {
        if (!thread.allowMutations) throw new Error("This phase is read-only");
        this.#validateMutation(thread.cwd, name, args, thread);
        const abortApproval = () => { for (const requestId of [...turn.approvalIds]) this.resolveApproval({ requestId, decision: "interrupt" }).catch(() => {}); };
        signal?.addEventListener("abort", abortApproval, { once: true });
        let decision;
        try { decision = await this.#requestApproval({ threadId: thread.id, turn, item, args }); }
        finally { signal?.removeEventListener("abort", abortApproval); }
        signal?.throwIfAborted();
        if (decision !== "accept") throw new Error("Action declined; no mutation was executed");
      }
      signal?.throwIfAborted();
      result = { text: String(await this.#tool(thread.cwd, name, args, signal, thread)), ok: true };
      if (/\bexit [1-9]\d*|timed out/.test(result.text) && ["workspace_git", "workspace_bash"].includes(name)) result.ok = false;
    } catch (error) {
      result = { text: `Tool error: ${error.message}`, ok: false };
    }
    const completed = { ...item, result: compact(result.text), state: result.ok ? "executed" : "failed", status: result.ok ? "completed" : "failed" };
    turn.items.push(completed);
    this.emit("event", { method: "item/completed", params: { threadId: thread.id, turnId: turn.id, item: completed } });
    signal?.throwIfAborted();
    return result;
  }

  async #run(thread, turn, prompt, outputSchema) {
    const threadId = thread.id;
    this.emit("event", { method: "turn/started", params: { threadId, turn: { id: turn.id, status: "inProgress", provider: thread.provider } } });
    thread.messages.push({ role: "user", content: prompt });
    const contract = outputSchema ? `\n\nReturn the final answer as one valid JSON object that conforms to this schema:\n${JSON.stringify(outputSchema)}` : "";
    const mutationPolicy = thread.allowMutations
      ? thread.interactionMode === "autonomous" ? "The user preauthorized task-scoped writes and general Bash execution. Proceed without routine approval questions; never claim unobserved actions." : "workspace_write and workspace_bash are controlled tools: each call pauses for explicit human approval, and you must never imply that a proposed action already happened."
      : "This is a planning-only session: workspace_write and workspace_bash are unavailable. Propose worker tasks instead of changing files or running commands.";
    const system = `${USER_LANGUAGE_CONTRACT}\n\nYou are an Agent Deck API worker. You may inspect the assigned local workspace with the provided tools. ${mutationPolicy} Never claim a file edit, command execution, test, or artifact that you did not observe. When tools are insufficient, clearly state the blocker.` + contract;
    try {
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        const response = await this.#completion(thread, system, turn.abort.signal);
        const message = response.choices?.[0]?.message;
        if (!message) throw new Error("API returned no assistant message");
        thread.messages.push(message);
        const calls = message.tool_calls || [];
        if (!calls.length) {
          const text = message.content || "";
          turn.items.push({ id: `message-${randomUUID()}`, type: "agentMessage", text });
          this.emit("event", { method: "item/completed", params: { threadId, turnId: turn.id, item: turn.items.at(-1) } });
          turn.status = "completed";
          this.emit("event", { method: "turn/completed", params: { threadId, turn: { id: turn.id, status: "completed", usage: response.usage || null } } });
          return;
        }
        for (const call of calls) {
          const name = call.function?.name || "unknown";
          let args = {};
          let argumentError = null;
          try { args = JSON.parse(call.function?.arguments || "{}"); }
          catch { argumentError = "Tool error: Provider returned malformed tool arguments."; }
          const gitOperation = name === "workspace_git" ? String(args.operation || "") : null;
          const destructive = ["workspace_write", "workspace_bash"].includes(name) || (name === "workspace_git" && MUTATING_GIT_OPERATIONS.has(gitOperation));
          const type = name === "workspace_bash" ? "commandExecution" : name === "workspace_git" ? "gitOperation" : destructive ? "fileChange" : "mcpToolCall";
          const item = { id: call.id, type, server: "agent-deck-api", tool: name, command: args.command, path: args.path, operation: gitOperation, state: destructive ? "requested" : "executing", approvalRequired: destructive };
          this.emit("event", { method: "item/started", params: { threadId, turnId: turn.id, item } });
          let result;
          try {
            if (argumentError) result = argumentError;
            else if (destructive && !thread.allowMutations) result = "Tool error: This planning-only API session cannot execute writes or Bash. Create a worker task for an approval-gated execution session.";
            else if (destructive) {
              this.#validateMutation(thread.cwd, name, args, thread);
              const decision = await this.#requestApproval({ threadId, turn, item, args });
              if (decision !== "accept") result = decision === "interrupt" ? "Tool execution was interrupted before approval." : "Tool execution was declined by the user.";
              else {
                this.emit("event", { method: "item/execution/started", params: { threadId, turnId: turn.id, item: { ...item, state: "executing" } } });
                result = await this.#tool(thread.cwd, name, args, turn.abort.signal, thread);
              }
            } else result = await this.#tool(thread.cwd, name, args);
          }
          catch (error) { result = `Tool error: ${error.message}`; }
          const failed = /^Tool error:/.test(String(result));
          const declined = /^(Tool execution was declined|Tool execution was interrupted)/.test(String(result));
          const completedItem = { ...item, result: compact(result), state: failed ? "failed" : declined ? "declined" : "executed", status: failed ? "failed" : declined ? "declined" : "completed" };
          turn.items.push(completedItem);
          this.emit("event", { method: "item/completed", params: { threadId, turnId: turn.id, item: completedItem } });
          thread.messages.push({ role: "tool", tool_call_id: call.id, content: compact(result) });
        }
      }
      throw new Error(`Tool loop reached its ${MAX_TOOL_ROUNDS}-round safety limit`);
    } catch (error) {
      const interrupted = error.name === "AbortError" || turn.abort.signal.aborted;
      turn.status = interrupted ? "interrupted" : "failed";
      this.emit("event", { method: "turn/completed", params: { threadId, turn: { id: turn.id, status: turn.status, error: interrupted ? null : { message: error.message } } } });
    } finally {
      for (const requestId of turn.approvalIds) this.resolveApproval({ requestId, decision: "interrupt" }).catch(() => {});
      this.turns.delete(turn.id);
    }
  }

  async #completion(thread, system, signal) {
    const response = await this.fetch(`${thread.profile.endpoint}/chat/completions`, {
      method: "POST", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${thread.profile.apiKey}` },
      body: JSON.stringify({ model: thread.model, messages: [{ role: "system", content: system }, ...thread.messages], tools: thread.interactionMode === "autonomous" ? tools.map(preauthorizedTool) : tools, tool_choice: "auto", stream: false }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error?.message || `API responded with HTTP ${response.status}`);
    return body;
  }

  requestControlledApproval({ thread, turn, item, reason, signal }) {
    return new Promise((resolve, reject) => {
      const abort = () => { for (const id of [...turn.approvalIds]) this.resolveApproval({ requestId: id, decision: "interrupt" }).catch(() => {}); };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { signal.removeEventListener("abort", abort); reject(signal.reason); return; }
      this.#requestApproval({ threadId: thread.id, turn, item, args: {}, reason }).then(resolve, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
  }

  #requestApproval({ threadId, turn, item, args, reason: customReason }) {
    const requestId = `api-approval-${randomUUID()}`;
    const thread = this.threads.get(threadId);
    if (thread?.allowMutations && thread.interactionMode === "autonomous") {
      this.emit("event", { method: "item/approval/resolved", params: { threadId, turnId: turn.id, requestId, decision: "accept", state: "approved", reviewer: "autonomous_policy", item: { ...item, state: "approved" } } });
      return Promise.resolve("accept");
    }
    const kind = item.type === "webRead" ? "item/tool/requestApproval" : item.type === "commandExecution" ? "item/commandExecution/requestApproval" : item.type === "gitOperation" ? "item/gitOperation/requestApproval" : "item/fileChange/requestApproval";
    const reason = customReason || (item.type === "commandExecution" ? `API Worker wants to run: ${args.command}` : item.type === "gitOperation" ? `API Worker wants to ${args.operation}${args.message ? `: ${args.message}` : ""}` : `API Worker wants to write: ${args.path}`);
    return new Promise((resolve) => {
      const approval = { requestId, threadId, turnId: turn.id, turn, item, resolve };
      this.approvals.set(requestId, approval);
      turn.approvalIds.add(requestId);
      this.emit("event", { id: requestId, method: kind, params: { threadId, turnId: turn.id, item: { ...item, state: "requested" }, reason, command: args.command || null, path: args.path || null, operation: args.operation || null, state: "requested" } });
    });
  }

  #validateMutation(cwd, name, args, thread) {
    if (!cwd) throw new Error("No workspace is assigned to this API worker");
    if (name === "workspace_write") { safeFile(cwd, assertRelativePath(args.path)); return; }
    if (name === "workspace_bash") { this.#command(args.command, thread); return; }
    if (name === "workspace_git") { gitCommand(args); return; }
    throw new Error(`Unsupported mutation tool: ${name}`);
  }

  #command(command, thread) {
    if (thread?.allowMutations && thread.interactionMode === "autonomous") {
      if (typeof command !== "string" || !command.trim() || command.length > 8000 || command.includes("\0")) throw new Error("Command must contain 1–8000 valid characters");
      return command;
    }
    return assertSelectedWorkspaceCommand(command);
  }

  async #tool(cwd, name, args, signal, thread) {
    if (!cwd) throw new Error("No workspace is assigned to this API worker");
    if (name === "workspace_list") {
      const root = safeDirectory(cwd, args.path || "."); const depth = Math.max(1, Math.min(3, Number(args.depth || 1))); const entries = [];
      const visit = (directory, level) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => ![".git", "node_modules", ".DS_Store"].includes(entry.name)).slice(0, 120)) { const full = path.join(directory, entry.name); entries.push(`${entry.isDirectory() ? "dir" : "file"}\t${path.relative(cwd, full)}`); if (entry.isDirectory() && level < depth) visit(full, level + 1); } };
      visit(root, 1); return entries.slice(0, 300).join("\n");
    }
    if (name === "workspace_read") { const file = safeFile(cwd, args.path); if (!fs.statSync(file).isFile()) throw new Error("Path is not a file"); const lines = fs.readFileSync(file, "utf8").slice(0, MAX_FILE_BYTES).split("\n"); const start = Math.max(1, Number(args.startLine || 1)); const end = Math.min(lines.length, Number(args.endLine || start + 500)); return lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join("\n"); }
    if (name === "workspace_search") {
      const query = String(args.query || "");
      if (!query || query.length > 160) throw new Error("Search query must contain 1–160 characters");
      const matches = []; let visited = 0;
      const max = Math.max(1, Math.min(40, Number(args.maxResults || 20)));
      const visit = (directory) => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          if (matches.length >= max || visited >= 5000) break;
          visited += 1;
          if ([".git", "node_modules", ".DS_Store", ".aws", ".ssh"].includes(entry.name) || entry.name.startsWith(".env") || entry.isSymbolicLink()) continue;
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) visit(safeDirectory(cwd, full));
          else if (entry.isFile() && fs.statSync(full).size < MAX_FILE_BYTES) {
            const line = fs.readFileSync(safeFile(cwd, full), "utf8").split("\n").findIndex((value) => value.includes(query));
            if (line >= 0) matches.push(`${path.relative(cwd, full)}:${line + 1}`);
          }
        }
      };
      visit(safeDirectory(cwd, "."));
      return (matches.join("\n") || "No matches") + (visited >= 5000 ? "\n[Search stopped at its 5000-entry budget]" : "");
    }
    if (name === "workspace_write") {
      const content = String(args.content || "");
      if (Buffer.byteLength(content, "utf8") > MAX_WRITE_BYTES) throw new Error(`Write payload exceeds ${MAX_WRITE_BYTES} bytes`);
      const file = safeFile(cwd, args.path);
      const temporary = path.join(path.dirname(file), `.agent-deck-${randomUUID()}.tmp`);
      fs.writeFileSync(temporary, content, "utf8"); fs.renameSync(temporary, file);
      return `Wrote ${path.relative(fs.realpathSync(cwd), file)} (${Buffer.byteLength(content, "utf8")} bytes).`;
    }
    if (name === "workspace_bash") {
      const command = this.#command(args.command, thread);
      const result = await this.commandRunner({ command, cwd: fs.realpathSync(cwd), signal, timeoutMs: Math.min(120000, Math.max(1000, Number(args.timeoutMs || 120000))) });
      return compact(`exit ${result.exitCode}${result.timedOut ? " · timed out" : ""}\n${result.stdout || ""}${result.stderr ? `\nSTDERR\n${result.stderr}` : ""}`, 24000);
    }
    if (name === "workspace_git") {
      const command = gitCommand(args);
      const result = await this.commandRunner({ command, cwd: fs.realpathSync(cwd), signal, timeoutMs: Math.min(120000, Math.max(1000, Number(args.timeoutMs || 120000))) });
      return compact(`git ${args.operation} · exit ${result.exitCode}${result.timedOut ? " · timed out" : ""}\n${result.stdout || ""}${result.stderr ? `\nSTDERR\n${result.stderr}` : ""}`, 24000);
    }
    throw new Error(`Unsupported API worker tool: ${name}`);
  }
}

module.exports = { ApiAgentRuntime, assertSelectedWorkspaceCommand, gitCommand, APPROVAL_STATES, tools };
