import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readNoteDraft, saveNoteDraft } from "../src/note-drafts.js";
const require = createRequire(import.meta.url);
const { WaitingCompanion, changes } = require("../desktop/waiting-companion.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");

function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waiting-test-"));
  const store = new MissionStore(path.join(dir, "ledger.sqlite3"));
  const mission = store.createMission({ title: "写一份方案", outcome: "可追溯的方案", cwd: dir });
  store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, tasks: [{ key: "T", title: "调研", description: "资料分析", agentRole: "研究员", dependencies: [], acceptanceCriteria: ["证据"] }] });
  const task = store.getMission(mission.id).tasks[0];
  store.updateMission(mission.id, { status: "running", runtimeMode: "agent_deck" });
  store.updateTask(task.id, { status: "running", phase: "working" });
  const calls = []; let time = 1000;
  const service = new WaitingCompanion({ store, now: () => time, notify: value => { calls.push(value); return true; } });
  try { run({ store, mission, task, service, calls, advance: value => { time += value; } }); }
  finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}
const start = { activity: "quiet", minutes: 5, reminders: "return", criticalReminders: true };

test("human timing and fixed baseline only, no provider or execution mutations", () => fixture(({ store, service, advance, mission, task }) => {
  const before = store.getMission(mission.id);
  const state = service.start(start);
  assert.equal(state.session.deadline, 301000);
  assert.equal(state.session.baseline, undefined);
  advance(10000000);
  assert.equal(service.read().session.deadline, 301000);
  assert.equal(store.getTask(task.id).status, "running");
  assert.deepEqual(store.getMission(mission.id), before);
  assert.throws(() => service.start(start), /已有/);
  assert.throws(() => service.finish("wrong"), /已经结束/);
  assert.equal(service.finish(state.session.id).session.endedAt, 10001000);
  assert.equal(service.read().session, null);
}));

test("return recap counts real completions/artifacts without claiming acceptance", () => fixture(({ store, service, mission, task }) => {
  service.start(start);
  store.addArtifact({ missionId: mission.id, taskId: task.id, title: "报告", summary: "内容", files: ["report.html"] });
  store.updateTask(task.id, { status: "completed" });
  store.updateMission(mission.id, { status: "completed" });
  const other = store.createMission({ title: "新工作", outcome: "不跟踪", cwd: mission.cwd });
  store.updateMission(other.id, { status: "running" });
  const row = service.read().session.changes[0];
  assert.equal(row.newArtifacts, 1); assert.equal(row.newCompleted, 1);
  assert.equal(service.read().session.changes.length, 1);
  assert.equal(service.read().active.length, 1);
  assert.deepEqual(changes([{ id: "gone" }], [])[0].missing, true);
}));

test("ordinary reminders are opt-in, critical reminders separate, notifications deduplicated", () => fixture(({ store, service, calls, mission, task }) => {
  service.start(start);
  store.updateMission(mission.id, { status: "review" }); service.update(); service.update();
  assert.equal(calls.length, 0);
  store.updateTask(task.id, { status: "waiting_approval" }); service.update(); service.update();
  assert.deepEqual(calls, [{ critical: true }]);
  assert.equal(store.getTask(task.id).status, "waiting_approval");
  const id = service.read().session.id; service.finish(id); service.update();
  assert.equal(calls.length, 1);
}));

test("muting critical reminders does not accidentally notify failures as routine readiness", () => fixture(({ store, service, calls, mission, task }) => {
  service.start({ ...start, reminders: "notify", criticalReminders: false });
  store.updateMission(mission.id, { status: "failed" }); store.updateTask(task.id, { status: "blocked" }); service.update();
  assert.equal(calls.length, 0);
  store.updateMission(mission.id, { status: "completed" }); service.update();
  assert.deepEqual(calls, [{ critical: false }]);
}));

test("unavailable OS notification is honest and snapshots are bounded and engine-neutral", () => fixture(({ store, mission, task }) => {
  for (let i = 0; i < 24; i++) { const m = store.createMission({ title: `外部 ${i}`, outcome: "case", cwd: mission.cwd }); store.updateMission(m.id, { status: "running", runtimeMode: "external" }); }
  assert.equal(store.waitingWork().length, 20);
  const projection = store.waitingWork([mission.id])[0];
  assert.equal(projection.id, mission.id);
  assert.equal("spec" in projection, false); assert.equal("messages" in projection, false);
  const service = new WaitingCompanion({ store, notify: () => false }); service.start({ ...start, reminders: "notify" });
  for (const m of service.read().active) store.updateMission(m.id, { status: "completed" });
  service.update(); assert.equal(service.read().notifications, "unavailable");
  assert.equal(store.getTask(task.id).status, "running");
}));

test("invalid choices and empty ledger cannot fabricate active work", () => {
  const service = new WaitingCompanion({ store: { waitingWork: () => [] } });
  assert.throws(() => service.start(start), /没有正在执行/);
  for (const input of [{ ...start, minutes: -2 }, { ...start, activity: "invented" }, { ...start, reminders: "auto-approve" }, { ...start, criticalReminders: "yes" }]) assert.throws(() => service.start(input), /有效/);
});

test("note drafts survive navigation, never replace another note or a newer saved version", () => {
  const data = {}; const storage = { getItem: key => data[key], setItem: (key, value) => { data[key] = value; }, removeItem: key => { delete data[key]; } };
  const note = { id: "one", updatedAt: "v1", title: "标题", body: "原文", outcome: "" };
  const draft = { title: "修改", body: "新背景", outcome: "新标准" };
  saveNoteDraft(note, draft, storage); assert.deepEqual(readNoteDraft(note, storage), draft);
  assert.equal(readNoteDraft({ ...note, id: "two" }, storage).body, "原文");
  assert.equal(readNoteDraft({ ...note, updatedAt: "v2" }, storage).body, "原文");
  saveNoteDraft(note, note, storage); assert.equal(readNoteDraft(note, storage).body, "原文");
});
