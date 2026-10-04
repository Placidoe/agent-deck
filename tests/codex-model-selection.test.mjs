import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canRetryCodexPlan, isCodexModelFailure, nextMissionAction } from "../src/mission-next-action.js";
const require = createRequire(import.meta.url);
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator, missionPlanSchema } = require("../desktop/mission-orchestrator.cjs");

function fakeClient(catalog = [{ id: "label", model: "catalog-default", isDefault: true }]) {
  const client = new CodexAppServer({ binary: "/not-used" });
  const calls = [];
  client.start = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "model/list") return { data: catalog };
    if (method === "thread/start") return { thread: { id: "thread" }, model: params.model };
    if (method === "turn/start") return { turn: { id: "turn" } };
    return {};
  };
  return { client, calls };
}

test("new threads explicitly use catalog default, pin turns and reuse bounded catalog cache", async () => {
  const { client, calls } = fakeClient();
  const created = await client.createThread({ cwd: "/tmp" });
  await client.sendTurn({ threadId: created.thread.id, prompt: "test" });
  assert.equal(created.model, "catalog-default");
  assert.equal(calls.find(c => c.method === "thread/start").params.model, "catalog-default");
  assert.equal(calls.find(c => c.method === "turn/start").params.model, "catalog-default");
  assert.equal(calls.filter(c => c.method === "model/list").length, 1);
});

test("explicit unsupported models and an empty/broken catalog fail before thread creation", async () => {
  const { client, calls } = fakeClient();
  await assert.rejects(client.createThread({ model: "gpt-6.1-sol" }), /CODEX_MODEL_NOT_LISTED/);
  assert.equal(calls.some(c => c.method === "thread/start"), false);
  await assert.rejects(fakeClient([]).client.resolveModel(), /CATALOG_UNAVAILABLE/);
  const broken = fakeClient().client; broken.request = async () => ({});
  await assert.rejects(broken.resolveModel(), /CATALOG_UNAVAILABLE/);
});

test("catalog refresh is paginated, omits hidden models, uses slugs and coalesces reads", async () => {
  const { client, calls } = fakeClient();
  client.request = async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [{ id: "label", model: "second" }] } : { data: [{ id: "hidden", hidden: true }], nextCursor: "next" };
  };
  assert.deepEqual(await Promise.all([client.resolveModel("second"), client.resolveModel("second")]), ["second", "second"]);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].params.cursor, "next");
  await client.listModels({ refresh: true });
  assert.equal(calls.length, 4);
  client.request = async () => ({ data: [], nextCursor: "loop" });
  await assert.rejects(client.listModels({ refresh: true }), /分页异常/);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-model-test-"));
  const store = new MissionStore(path.join(directory, "ledger.sqlite3"));
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const mission = store.createMission({ title: "Original requirement", outcome: "Original outcome", sourcePrompt: "Keep this requirement", cwd: directory, model: "rejected-model" });
  store.updateMission(mission.id, { status: "failed", mainThreadId: "old-thread", error: "model not supported when using Codex with a ChatGPT account" });
  const run = store.startRun({ missionId: mission.id, agentId: `${mission.id}:main`, threadId: "old-thread", turnId: "old-turn" });
  store.completeRun("old-thread", "old-turn", { status: "failed", error: "original failure" });
  const calls = [];
  const runtime = {
    listModels: async () => [{ id: "default", model: "supported", isDefault: true }],
    resolveModel: async model => { calls.push({ kind: "resolve", model }); if (model !== "supported") throw new Error("CODEX_MODEL_NOT_LISTED"); return model; },
    createThread: async input => { calls.push({ kind: "thread", input }); return { thread: { id: "new-thread" }, model: input.model }; },
    sendTurn: async input => { calls.push({ kind: "turn", input }); return { id: "new-turn" }; },
    interrupt: async input => { calls.push({ kind: "interrupt", input }); },
  };
  const orchestrator = new MissionOrchestrator({ codex: runtime, store, worktrees: {} });
  return { store, mission: store.getMission(mission.id), orchestrator, runtime, calls, run };
}

test("model retry retains requirement/history, creates one planner and never dispatches Workers", async t => {
  const { store, mission, orchestrator, calls, run } = fixture(t);
  const result = await orchestrator.retryPlan({ missionId: mission.id, model: "supported" });
  assert.equal(result.id, mission.id); assert.equal(result.status, "planning");
  assert.equal(result.sourcePrompt, mission.sourcePrompt); assert.equal(result.outcome, mission.outcome);
  assert.equal(result.model, "supported"); assert.equal(result.mainThreadId, "new-thread");
  assert.equal(result.tasks.length, 0); assert.equal(result.spec, null);
  assert.equal(result.runs.find(r => r.id === run.id).status, "failed");
  assert.equal(result.runs.length, 2);
  const request = calls.find(c => c.kind === "turn").input;
  assert.equal(request.outputSchema, missionPlanSchema); assert.equal(request.model, "supported");
  assert.match(request.prompt, /Keep this requirement/);
  assert.equal(store.listMissions().length, 1);
  assert.equal(result.events.some(e => e.type === "planner.retry.requested" && e.payload.previousModel === "rejected-model"), true);
});

test("retry rejects bad models, native missions, active plans and duplicate clicks", async t => {
  const { store, mission, orchestrator, runtime, calls } = fixture(t);
  await assert.rejects(orchestrator.retryPlan({ missionId: mission.id, model: "nope" }), /NOT_LISTED/);
  assert.equal(store.getMission(mission.id).model, "rejected-model");
  assert.equal(calls.some(c => c.kind === "thread"), false);
  store.updateMission(mission.id, { runtimeMode: "agent_deck" });
  await assert.rejects(orchestrator.retryPlan({ missionId: mission.id, model: "supported" }), /只能/);
  store.updateMission(mission.id, { runtimeMode: "external", status: "running" });
  await assert.rejects(orchestrator.retryPlan({ missionId: mission.id, model: "supported" }), /只能/);
  store.updateMission(mission.id, { status: "failed" });
  let release; runtime.resolveModel = () => new Promise(resolve => { release = resolve; });
  const first = orchestrator.retryPlan({ missionId: mission.id, model: "supported" });
  await assert.rejects(orchestrator.retryPlan({ missionId: mission.id, model: "supported" }), /重复/);
  await assert.rejects(orchestrator.sendMessage({ missionId: mission.id, text: "another turn" }), /重试正在提交/);
  release("supported"); await first;
  assert.equal(calls.filter(c => c.kind === "thread").length, 1);
});

test("retry transport failure stays actionable; cancellation during transport is not overwritten", async t => {
  const { store, mission, orchestrator, runtime, calls } = fixture(t);
  runtime.sendTurn = async () => { throw new Error("provider rejected model"); };
  await assert.rejects(orchestrator.retryPlan({ missionId: mission.id, model: "supported" }), /provider rejected/);
  assert.equal(store.getMission(mission.id).status, "failed");
  runtime.sendTurn = async () => { store.updateMission(mission.id, { status: "canceled" }); return { id: "canceled-turn" }; };
  await assert.rejects(orchestrator.retryPlan({ missionId: mission.id, model: "supported" }), /已取消/);
  assert.equal(store.getMission(mission.id).status, "canceled");
  assert.equal(store.getMission(mission.id).activeTurnId, null);
  assert.equal(calls.find(c => c.kind === "interrupt").input.turnId, "canceled-turn");
});

test("model failure view model explains recovery without changing engine or approving work", () => {
  const mission = { provider: "codex", runtimeMode: "external", status: "failed", tasks: [], error: JSON.stringify({ error: { message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account." } }) };
  assert.equal(canRetryCodexPlan(mission), true);
  assert.equal(isCodexModelFailure(mission.error), true);
  assert.equal(nextMissionAction(mission).primaryLabel, "选择模型并重试");
  assert.equal(canRetryCodexPlan({ ...mission, activeTurnId: "active" }), false);
  assert.equal(canRetryCodexPlan({ ...mission, runtimeMode: "agent_deck" }), false);
  assert.equal(isCodexModelFailure("rate limit exceeded"), false);
});
