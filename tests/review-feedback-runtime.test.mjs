import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { reviewRound } from "../shared/review-feedback.mjs";
const require = createRequire(import.meta.url);
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");

async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "review-feedback-test-"));
  const store = new MissionStore(path.join(directory, "review.sqlite3"));
  const m = store.createMission({ title: "审阅", outcome: "明确贡献范围", cwd: directory });
  store.savePlan(m.id, { title: m.title, outcome: m.outcome, tasks: [{ key: "T", title: "调研", description: "核对候选", agentRole: "研究员", dependencies: [], acceptanceCriteria: ["资料可追溯"] }] });
  const id = store.getMission(m.id).tasks[0].id;
  store.updateTask(id, { status: "review", phase: "review", agentThreadId: "worker", worktreePath: directory, result: { summary: "已有候选", acceptance: [{ criterion: "资料可追溯", passed: true, evidence: "现有资料" }], blockers: ["确认模型", "确认 PR 范围"] } });
  store.updateMission(m.id, { status: "review" });
  const task = store.getTask(id);
  const input = { missionId: m.id, taskId: id, reviewFeedback: { round: reviewRound(task), entries: [{ id: "blocker-0", feedback: "先提供两个候选供我比较，不要认领。" }] } };
  try { await run({ store, missionId: m.id, taskId: id, task, input }); }
  finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
}

test("batch feedback reuses one real Worker turn and leaves acceptance gated", () => fixture(async ({ store, missionId, taskId, input }) => {
  const calls = [];
  const o = new MissionOrchestrator({ store, worktrees: { commit() { throw new Error("must not commit"); } }, codex: { async sendTurn(request) { calls.push(request); return { id: "followup" }; } } });
  await assert.rejects(o.acceptTask(missionId, taskId), /不能验收/);
  const { receipt } = await o.sendMessage(input); await o.messageQueues.get("worker");
  assert.equal(calls.length, 1); assert.equal(calls[0].threadId, "worker");
  assert.match(calls[0].prompt, /确认 PR 范围/); assert.match(calls[0].prompt, /先提供两个候选/);
  assert.equal(store.getTask(taskId).status, "running");
  assert.equal(store.getMission(missionId).messages.find(item => item.id === receipt.id).deliveryStatus, "delivered");
  const event = store.listEvents(missionId).items.find(item => item.type === "review.feedback.queued");
  assert.equal(event.payload.entries.length, 1); assert.deepEqual(event.payload.pendingItemIds, ["blocker-1"]);
  await assert.rejects(o.sendMessage(input), /待验收/);
}));

test("stale or cross-task feedback is rejected before any queued receipt", () => fixture(async ({ store, missionId, taskId, input }) => {
  const o = new MissionOrchestrator({ store, worktrees: {}, codex: { sendTurn() { throw new Error("unexpected runtime"); } } });
  const changed = structuredClone(store.getTask(taskId).result); changed.blockers[0] = "新的待确认问题";
  store.updateTask(taskId, { result: changed });
  await assert.rejects(o.sendMessage(input), /更新结果/);
  assert.equal(store.getMission(missionId).messages.length, 0);
}));

test("queue-time cancellation and duplicate feedback never dispatch a second turn", () => fixture(async ({ store, missionId, taskId, input }) => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const o = new MissionOrchestrator({ store, worktrees: {}, codex: { sendTurn() { throw new Error("unexpected runtime"); } } });
  o.messageQueues.set("worker", wait);
  const { receipt } = await o.sendMessage(input);
  await assert.rejects(o.sendMessage(input), /已经入队/);
  store.updateMission(missionId, { status: "canceled" });
  const queue = o.messageQueues.get("worker"); release(); await queue;
  const message = store.getMission(missionId).messages.find(item => item.id === receipt.id);
  assert.equal(message.deliveryStatus, "failed"); assert.match(message.error, /待验收/);
  assert.equal(store.getTask(taskId).status, "review");
}));

test("transport failure preserves review state and permits explicit feedback retry", () => fixture(async ({ store, missionId, taskId, input }) => {
  let failed = true;
  const calls = [];
  const o = new MissionOrchestrator({ store, worktrees: {}, codex: { async sendTurn(request) { calls.push(request); if (failed) throw new Error("offline"); return { id: "retry" }; } } });
  const first = await o.sendMessage(input); await o.messageQueues.get("worker");
  assert.equal(store.getTask(taskId).status, "review");
  assert.equal(store.getMission(missionId).messages.find(item => item.id === first.receipt.id).deliveryStatus, "failed");
  failed = false; await o.sendMessage(input); await o.messageQueues.get("worker");
  assert.equal(calls.length, 2); assert.equal(store.getTask(taskId).status, "running");
}));

test("Stop while attaching review feedback interrupts the late turn without reviving work", () => fixture(async ({ store, missionId, taskId, input }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const interrupted = [];
  const o = new MissionOrchestrator({ store, worktrees: {}, codex: { async sendTurn() { await gate; return { id: "late-turn" }; }, async interrupt(turn) { interrupted.push(turn); } } });
  const { receipt } = await o.sendMessage(input);
  const queue = o.messageQueues.get("worker");
  await o.cancel(missionId);
  release(); await queue;
  assert.equal(store.getMissionStatus(missionId), "canceled");
  assert.equal(store.getTask(taskId).status, "canceled");
  assert.deepEqual(interrupted, [{ threadId: "worker", turnId: "late-turn" }]);
  assert.equal(store.getMission(missionId).messages.find(item => item.id === receipt.id).deliveryStatus, "failed");
}));
