import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const require = createRequire(import.meta.url);
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { assertDynamicTools } = require("../desktop/dynamic-tool-schema.cjs");
const { MissionOrchestrator, workerTools } = require("../desktop/mission-orchestrator.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");

test("all worker tools use flat app-server specs with per-tool inputSchema", async () => {
  assert.equal(assertDynamicTools(workerTools), workerTools);
  assert.deepEqual(workerTools.map(tool => tool.name), ["send_message", "publish_artifact", "list_context"]);
  const calls = [];
  const client = new CodexAppServer({ binary: "/unused" });
  client.start = async () => {};
  client.resolveModel = async () => "fixture";
  client.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: "fixture" } }; };
  await client.createThread({ dynamicTools: workerTools });
  assert.deepEqual(calls[0].params.dynamicTools, workerTools);
  for (const tool of calls[0].params.dynamicTools) {
    assert.equal(tool.namespace, "agentdeck");
    assert.equal(tool.type, undefined);
    assert.equal(tool.tools, undefined);
    assert.equal(tool.inputSchema.type, "object");
  }
  assert.deepEqual(workerTools[2].inputSchema.required, []);
  // Input tools do not share the all-required strict output contract.
  assert.equal(workerTools[1].inputSchema.required.includes("dataRich"), false);
});

test("invalid dynamic tools fail before starting or requesting the provider", async () => {
  const client = new CodexAppServer({ binary: "/unused" });
  client.start = async () => { throw new Error("must not start"); };
  for (const tools of [
    [{ type: "namespace", name: "agentdeck", tools: workerTools }],
    [{ name: "missing_schema", description: "test" }],
    [workerTools[0], workerTools[0]],
    [{ ...workerTools[0], namespace: "invalid.name" }],
    { tools: workerTools },
  ]) await assert.rejects(client.createThread({ dynamicTools: tools }), /Invalid Codex dynamicTools/);
  assert.doesNotThrow(() => assertDynamicTools(undefined));
  assert.doesNotThrow(() => assertDynamicTools([]));
});

test("namespaced callbacks dispatch context, messages and artifacts only for a real task thread", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-tools-test-"));
  const store = new MissionStore(path.join(root, "ledger.sqlite3"));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const mission = store.createMission({ title: "Isolated fixture", outcome: "Test tools", cwd: root });
  store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, tasks: [{ key: "T1", title: "Tools", description: "Fixture", agentRole: "Worker", dependencies: [], acceptanceCriteria: ["Receipts"], estimatedTokenBudget: 1000 }] });
  const task = store.getMission(mission.id).tasks[0];
  store.updateTask(task.id, { agentThreadId: "fixture-thread", worktreePath: root });
  const replies = [];
  const orchestrator = new MissionOrchestrator({ store, worktrees: {}, codex: { respondToRequest: (...args) => replies.push(args) } });
  const call = (id, tool, args = {}, namespace = "agentdeck", threadId = "fixture-thread") => orchestrator.handleCodexEvent({ id, method: "item/tool/call", params: { threadId, turnId: "fixture-turn", callId: `call-${id}`, namespace, tool, arguments: args } });
  await call(1, "list_context");
  await call(2, "send_message", { to: "unstarted-teammate", topic: "test", message: "Isolated receipt" });
  await call(3, "publish_artifact", { title: "Fixture", summary: "Receipt only", files: [], verified: false, contentType: "reference" });
  for (const [, result, error] of replies) { assert.equal(result.success, true); assert.equal(error, undefined); assert.equal(result.contentItems[0].type, "inputText"); }
  const latest = store.getMission(mission.id);
  assert.equal(latest.artifacts.length, 1);
  assert.equal(latest.artifacts[0].verificationStatus, "unverified");
  assert.equal(latest.messages.at(-1).deliveryStatus, "recorded");
  for (const tool of workerTools) assert.ok(store.listEvents(mission.id).items.some(event => event.type === `bus.tool.${tool.name}`));
  await call(4, "list_context", {}, "other");
  await call(5, "list_context", {}, "agentdeck", "unbound-thread");
  for (const reply of replies.slice(-2)) assert.equal(reply[2].code, -32601);
});

test("retrying a pre-thread failure reuses the worktree and sends the corrected tool contract", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-tools-retry-"));
  const store = new MissionStore(path.join(root, "ledger.sqlite3"));
  t.after(() => { store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const client = new CodexAppServer({ binary: "/unused" });
  client.start = async () => {};
  client.resolveModel = async () => "fixture-model";
  const starts = [];
  client.request = async (method, params) => {
    if (method === "thread/start") {
      starts.push(params);
      if (starts.length === 1) throw new Error("Fixture transport failure before thread creation");
      return { thread: { id: "retry-thread" }, model: "fixture-model" };
    }
    if (method === "turn/start") return { turn: { id: "retry-turn" } };
    return {};
  };
  let creates = 0, reuses = 0;
  const worktrees = {
    assertReady() {},
    create() { creates++; return { path: root, branch: "fixture-branch" }; },
    reuse(savedPath, savedBranch) { reuses++; return { path: savedPath, branch: savedBranch }; },
  };
  const orchestrator = new MissionOrchestrator({ codex: client, store, worktrees });
  const mission = store.createMission({ title: "Fixture retry", outcome: "Tools", cwd: root, executionMode: "code", provider: "codex" });
  store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, tasks: [{ key: "T1", title: "Tools", description: "Fixture", agentRole: "Worker", dependencies: [], acceptanceCriteria: ["Receipt"], estimatedTokenBudget: 1000 }] });
  store.updateMission(mission.id, { status: "running" });
  await orchestrator.dispatchReady(mission.id);
  const failed = store.getMission(mission.id).tasks[0];
  assert.equal(failed.status, "blocked");
  assert.equal(failed.agentThreadId, null);
  await orchestrator.retryTask(mission.id, failed.id);
  const restarted = store.getTask(failed.id);
  assert.equal(restarted.status, "running");
  assert.equal(restarted.worktreePath, failed.worktreePath);
  assert.equal(restarted.agentThreadId, "retry-thread");
  assert.equal(restarted.activeTurnId, "retry-turn");
  assert.equal(creates, 1); assert.equal(reuses, 1);
  assert.deepEqual(starts[1].dynamicTools, workerTools);
});
