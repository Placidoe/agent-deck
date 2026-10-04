import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { reviewGate } from "../src/review-gate.js";
const require = createRequire(import.meta.url);
const { NativeHarnessRuntime, validateOutput } = require("../desktop/native-harness-runtime.cjs");
const { ProviderRegistry } = require("../desktop/provider-registry.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { ProviderAdapterHost } = require("../desktop/adapter-host.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");

async function fixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-native-"));
  try { await callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
const profile = { endpoint: "https://model.test/v1", model: "mock-model", apiKey: "never-persist-this-key" };
const response = (content, calls) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content, ...(calls ? { tool_calls: calls } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }), { status: 200 });
const call = (name, args) => [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
function wait(runtime, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { runtime.off("event", listener); reject(new Error("Native runtime event timed out")); }, 5000);
    const listener = (event) => { if (predicate(event)) { clearTimeout(timer); runtime.off("event", listener); resolve(event); } };
    runtime.on("event", listener);
  });
}
const completion = (runtime) => wait(runtime, (event) => event.method === "turn/completed");

test("global native mode persists, never probes Codex, and disallows hidden fallback", async () => fixture(async (directory) => {
  let probes = 0;
  const registry = new ProviderRegistry({ userDataPath: directory, spawn: () => ({ stdout: "" }), codexStatus: async () => { probes++; throw new Error("Codex must not start"); } });
  registry.saveRuntimeSettings({ mode: "agent_deck", modelProvider: "deepseek" });
  const statuses = await registry.status();
  assert.equal(probes, 0);
  assert.equal(statuses.find((item) => item.id === "codex").missionEnabled, false);
  assert.equal(new ProviderRegistry({ userDataPath: directory }).runtimeSettings().mode, "agent_deck");
  assert.throws(() => registry.selectRuntime({ provider: "codex" }), /requires a model API/);
  assert.throws(() => registry.selectRuntime({}), /verify/);
  const host = new ProviderAdapterHost({ codex: {} });
  assert.throws(() => host.runtimeFor({ runtimeMode: "agent_deck", provider: "deepseek" }), /no Codex fallback/);
}));

test("Mission pins its mode while legacy missions stay on their original runtime", async () => fixture(async (directory) => {
  const store = new MissionStore(path.join(directory, "test.sqlite3"));
  try {
    const native = store.createMission({ title: "Native", outcome: "Verify", cwd: directory, provider: "deepseek", runtimeMode: "agent_deck" });
    const legacy = store.createMission({ title: "Legacy", outcome: "Verify", cwd: directory });
    assert.equal(store.getMission(native.id).runtimeMode, "agent_deck");
    assert.equal(store.getMission(legacy.id).runtimeMode, "external");
    const host = new ProviderAdapterHost({ codex: { id: "external" }, apiRuntime: { id: "legacy-api" }, nativeHarness: { id: "sdk" } });
    assert.equal(host.runtimeFor(native).id, "sdk");
    assert.equal(host.runtimeFor(legacy).id, "external");
  } finally { store.close(); }
}));

test("native SDK executes approval-gated write, fresh audit reads output, persists without API secrets", async () => fixture(async (directory) => {
  let calls = 0;
  const requests = [];
  const options = { rootDirectory: path.join(directory, "state"), providerRegistry: { apiProfile: () => profile }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); requests.push(body); calls++;
    if (calls === 1) return response(null, call("workspace_write", { path: "result.txt", content: "Verified output" }));
    if (calls === 2) return response("Created result.txt");
    assert.equal(body.tools.some((tool) => ["workspace_write", "workspace_bash", "workspace_git"].includes(tool.function.name)), false);
    if (calls === 3) return response(null, call("workspace_read", { path: "result.txt" }));
    assert.ok(body.messages.some((message) => message.role === "tool" && /Verified output/.test(message.content)));
    return response('{"passed":true,"summary":"File independently read"}');
  } };
  const runtime = new NativeHarnessRuntime(options);
  const events = []; runtime.on("event", (event) => events.push(event));
  const { thread } = await runtime.createThread({ cwd: directory, provider: "deepseek", allowMutations: true });
  const approved = wait(runtime, (event) => event.method === "item/fileChange/requestApproval");
  const finished = completion(runtime);
  await runtime.sendTurn({ threadId: thread.id, prompt: "Create result.txt" });
  const approval = await approved;
  assert.equal(fs.existsSync(path.join(directory, "result.txt")), false);
  await runtime.resolveApproval({ requestId: approval.id, decision: "accept" });
  const event = await finished;
  assert.equal(event.params.turn.status, "completed");
  assert.equal(event.params.turn.usage.total_tokens, 60);
  assert.equal(calls, 4);
  assert.ok(events.some((event) => event.method === "harness/event" && event.params.event.type === "auditor.finished"));
  const saved = await runtime.readThread(thread.id);
  assert.equal(JSON.stringify(saved).includes(profile.apiKey), false);
  assert.equal(fs.readFileSync(path.join(directory, "state/threads", `${thread.id}.json`), "utf8").includes(profile.apiKey), false);
  const restored = new NativeHarnessRuntime({ ...options, fetchImpl: async () => { throw new Error("Restart must not execute a turn"); } });
  assert.equal((await restored.readThread(thread.id)).turns[0].status, "completed");
  const snapshot = JSON.parse(fs.readFileSync(path.join(directory, "state/runs", event.params.turn.harnessRunId, "snapshot.json")));
  assert.equal(snapshot.status, "completed");
  assert.equal(snapshot.metrics.auditorCalls, 1);
}));

test("planning-only native turn uses structural validation without claiming workspace verification", async () => fixture(async (directory) => {
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(directory, "state"), providerRegistry: { apiProfile: () => profile }, fetchImpl: async (_url, input) => {
    assert.equal(JSON.parse(input.body).tools.some((tool) => tool.function.name === "workspace_write"), false);
    return response('{"title":"Plan"}');
  } });
  const { thread } = await runtime.createThread({ cwd: directory, provider: "deepseek" });
  const finished = completion(runtime);
  await runtime.sendTurn({ threadId: thread.id, prompt: "Plan only", outputSchema: { type: "object", required: ["title"], additionalProperties: false, properties: { title: { type: "string" } } } });
  assert.equal((await finished).params.turn.status, "completed");
}));

test("unknown output-schema keywords and out-of-range values fail closed", () => {
  assert.ok(validateOutput('{"retryLimit":6}', { type: "object", properties: { retryLimit: { type: "integer", maximum: 5 } } }).length);
  assert.ok(validateOutput('"x"', { type: "string", pattern: "^a$" }).length);
});

test("native direct Mission preserves its contract on redirection and reaches an actionable review without Codex", async () => fixture(async (directory) => {
  const store = new MissionStore(path.join(directory, "mission.sqlite3"));
  const requests = [];
  let calls = 0;
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(directory, "state"), providerRegistry: { apiProfile: () => profile }, fetchImpl: async (_url, input) => {
    const body = JSON.parse(input.body); requests.push(body); calls++;
    if (calls <= 2) return response(null, call("workspace_write", { path: calls === 1 ? "obsolete.txt" : "result.txt", content: "Verified redirected output" }));
    if (calls === 3) return response(JSON.stringify({ summary: "Created result.txt", acceptance: [{ criterion: "Output exists", passed: true, evidence: "result.txt" }], changedFiles: ["result.txt"], blockers: [] }));
    if (calls === 4) return response(null, call("workspace_read", { path: "result.txt" }));
    return response('{"passed":true,"summary":"Read redirected output independently"}');
  } });
  const worktrees = {
    assertReady() {},
    create() { const target = path.join(directory, "worker"); fs.mkdirSync(target); return { path: target, branch: "test-native" }; },
    evidence(target) { return { files: fs.readdirSync(target), clean: false, diffStat: "result.txt" }; },
  };
  const codex = new Proxy({}, { get() { throw new Error("Codex must never be accessed"); } });
  const orchestrator = new MissionOrchestrator({ store, worktrees, adapterHost: new ProviderAdapterHost({ codex, nativeHarness: runtime }), selectRuntime: () => ({ runtimeMode: "agent_deck", provider: "deepseek" }) });
  const handling = [];
  runtime.on("event", (event) => handling.push(orchestrator.handleCodexEvent(event)));
  try {
    const approval = wait(runtime, (event) => event.method === "item/fileChange/requestApproval");
    const mission = await orchestrator.create({ title: "Create output", outcome: "Create result.txt", cwd: directory, orchestrationMode: "direct" });
    const first = await approval;
    await Promise.all(handling);
    const task = store.getMission(mission.id).tasks[0];
    assert.equal(task.status, "waiting_approval");
    const redirected = wait(runtime, (event) => event.method === "item/fileChange/requestApproval" && event.id !== first.id);
    const finished = wait(runtime, (event) => event.method === "turn/completed" && event.params.turn.status === "completed");
    await orchestrator.sendMessage({ missionId: mission.id, taskId: task.id, text: "Only create result.txt; do not write obsolete.txt" });
    const second = await redirected;
    await orchestrator.resolveApproval({ missionId: mission.id, requestId: second.id, decision: "accept" });
    const completed = await finished;
    await Promise.all(handling);
    const reviewed = store.getTask(task.id);
    assert.equal(reviewed.status, "review");
    assert.equal(reviewGate(reviewed.result).ready, true);
    assert.equal(fs.existsSync(path.join(reviewed.worktreePath, "obsolete.txt")), false);
    assert.equal(fs.readFileSync(path.join(reviewed.worktreePath, "result.txt"), "utf8"), "Verified redirected output");
    assert.notEqual(completed.params.turn.id, task.activeTurnId);
    assert.ok(requests[1].messages.some((message) => /USER REDIRECTION/.test(message.content)));
    assert.ok(requests[1].messages.some((message) => /acceptance/.test(message.content)));
    assert.equal(store.getMission(mission.id).events.filter((event) => event.type === "provider.thread/tokenUsage/updated").length, 5);
    assert.equal(calls, 5);
  } finally {
    for (const { turn } of runtime.turns.values()) await runtime.interrupt({ turnId: turn.id });
    store.close();
  }
}));

test("external hot-plug boundary validates lifecycle methods and never affects native mode", () => {
  const host = new ProviderAdapterHost({ nativeHarness: { id: "sdk" } });
  const manifest = { id: "claude_code", protocol: "test", stage: "mission_ready", capabilities: [] };
  assert.throws(() => host.registerExternal({ manifest, runtime: {} }), /createThread/);
  const runtime = Object.fromEntries(["createThread", "sendTurn", "steer", "interrupt", "resumeThread", "readThread", "on", "resolveApproval", "pendingApproval"].map((name) => [name, () => {}]));
  host.registerExternal({ manifest, runtime });
  assert.equal(host.runtimeFor({ runtimeMode: "external", provider: "claude_code" }), runtime);
  assert.throws(() => host.registerExternal({ manifest, runtime }), /Cannot replace/);
  assert.equal(host.runtimeFor({ runtimeMode: "agent_deck", provider: "deepseek" }).id, "sdk");
});

test("interrupting a pending native write leaves the file untouched and records an interrupted turn", async () => fixture(async (directory) => {
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(directory, "state"), providerRegistry: { apiProfile: () => profile }, fetchImpl: async () => response(null, call("workspace_write", { path: "not-written.txt", content: "Must not execute" })) });
  const { thread } = await runtime.createThread({ cwd: directory, provider: "deepseek", allowMutations: true });
  const approval = wait(runtime, (event) => event.method === "item/fileChange/requestApproval");
  const finished = completion(runtime);
  const turn = await runtime.sendTurn({ threadId: thread.id, prompt: "Write with approval" });
  await approval;
  await runtime.interrupt({ turnId: turn.id });
  assert.equal((await finished).params.turn.status, "interrupted");
  assert.equal(fs.existsSync(path.join(directory, "not-written.txt")), false);
  assert.equal(runtime.approvals.size, 0);
}));

test("recovery marks an in-flight native turn interrupted without replaying model/tool calls", async () => fixture(async (directory) => {
  const rootDirectory = path.join(directory, "state");
  const options = { rootDirectory, providerRegistry: { apiProfile: () => profile }, fetchImpl: async () => { throw new Error("Recovery must not call the API"); } };
  const runtime = new NativeHarnessRuntime(options);
  const { thread } = await runtime.createThread({ cwd: directory, provider: "deepseek", allowMutations: true });
  const file = path.join(rootDirectory, "threads", `${thread.id}.json`);
  const persisted = JSON.parse(fs.readFileSync(file, "utf8"));
  persisted.turns.push({ id: "turn-interrupted-fixture", status: "inProgress", items: [] });
  fs.writeFileSync(file, JSON.stringify(persisted));
  const restored = await new NativeHarnessRuntime(options).readThread(thread.id);
  assert.equal(restored.turns[0].status, "interrupted");
  assert.match(restored.turns[0].error.message, /inspect the saved run/);
}));

test("native search skips outside-workspace symlinks and bounds traversal", async () => fixture(async (directory) => {
  let calls = 0;
  fs.symlinkSync(os.tmpdir(), path.join(directory, "outside"));
  fs.writeFileSync(path.join(directory, "notes.txt"), "unique-search-evidence");
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(directory, "state"), providerRegistry: { apiProfile: () => profile }, fetchImpl: async () => {
    calls++;
    if (calls === 1 || calls === 3) return response(null, call("workspace_search", { query: "unique-search-evidence" }));
    return response(calls === 2 ? "Found notes.txt" : '{"passed":true,"summary":"Found local evidence"}');
  } });
  const { thread } = await runtime.createThread({ cwd: directory, provider: "deepseek" });
  const finished = completion(runtime);
  await runtime.sendTurn({ threadId: thread.id, prompt: "Search only local files" });
  assert.equal((await finished).params.turn.status, "completed");
}));
