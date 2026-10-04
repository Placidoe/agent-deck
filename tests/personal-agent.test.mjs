import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { collectWork } from "../src/work-navigation.js";
const require = createRequire(import.meta.url);
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator, normalizePlan } = require("../desktop/mission-orchestrator.cjs");
const { personalContextBlock, stripPersonalContext } = require("../desktop/personal-context.cjs");
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-personal-test-"));
  const db = path.join(dir, "ledger.sqlite3"); const store = new MissionStore(db);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { store, personal: store.personal, dir, db };
}
const project = (p, name = "产品发布") => p.saveProject({ name, goal: "交付可离线使用的个人助手" });
const memory = (p, input = {}) => p.saveMemory({ key: "语言", content: "中文报告", ...input });
function work(store, pid, status = "ready") {
  const m = store.createMission({ title: "研究方案", outcome: "有来源的报告", cwd: "/test-only", projectId: pid });
  store.savePlan(m.id, normalizePlan({ title: "研究方案", outcome: "有来源的报告", tasks: [{ key: "RESEARCH", title: "核查来源", description: "只读核查", agentRole: "研究员", dependencies: [], acceptanceCriteria: ["来源可核查"] }] }));
  store.updateMission(m.id, { status });
  return store.getMission(m.id);
}

test("projects persist without altering legacy missions; revisions prevent lost edits", t => {
  const { store, personal, db } = fixture(t);
  const legacy = store.createMission({ title: "legacy", outcome: "legacy", cwd: "/legacy" });
  const p = project(personal); const revised = personal.saveProject({ ...p, goal: "新目标" });
  assert.equal(revised.revision, 2);
  assert.throws(() => personal.saveProject({ ...p, goal: "旧界面覆盖" }), /changed/);
  const other = new MissionStore(db); t.after(() => other.close());
  assert.equal(other.personal.getProject(p.id).goal, "新目标");
  assert.equal(other.getMission(legacy.id).projectId, null);
  assert.throws(() => store.createRequirement({ title: "a", outcome: "b", workspacePath: "/a", projectId: "missing" }), /missing/);
});

test("legacy SQLite schema upgrades additively and retains its work", t => {
  const { store, db } = fixture(t);
  const legacy = store.createMission({ title: "既有工作", outcome: "保留交付", cwd: "/legacy" });
  store.close();
  execFileSync("/usr/bin/sqlite3", [db, "DROP TABLE personal_memories; DROP TABLE personal_projects; DROP INDEX idx_personal_missions; DROP INDEX idx_personal_requirements; ALTER TABLE missions DROP COLUMN project_id; ALTER TABLE requirements DROP COLUMN project_id;"]);
  const migrated = new MissionStore(db); t.after(() => migrated.close());
  assert.equal(migrated.getMission(legacy.id).outcome, "保留交付");
  assert.equal(migrated.getMission(legacy.id).projectId, null);
  assert.deepEqual(migrated.personal.listProjects(), []);
});

test("memories are local by default; candidate, expired and other-project records are excluded", t => {
  const { personal } = fixture(t); const p = project(personal); const other = project(personal, "另一个项目");
  memory(personal); memory(personal, { key: "候选", content: "待确定", status: "candidate", shareWithAgent: true });
  memory(personal, { key: "旧期限", expiresAt: "2020-01-01", shareWithAgent: true });
  memory(personal, { projectId: other.id, key: "秘密", shareWithAgent: true });
  assert.deepEqual(personal.context({ projectId: p.id }).items, []);
  assert.throws(() => memory(personal, { key: "非法", shareWithAgent: "true" }), /boolean/);
  assert.throws(() => memory(personal, { key: "坏日期", expiresAt: 12345 }), /expiration/);
});

test("scoped overrides, correction, revocation and deletion affect the next context", t => {
  const { personal } = fixture(t); const p = project(personal);
  memory(personal, { shareWithAgent: true });
  const local = memory(personal, { projectId: p.id, content: "英文报告", shareWithAgent: true, sourceLabel: "项目决定", sourceRef: "source.html" });
  assert.equal(personal.context({ projectId: p.id }).items[0].data.content, "英文报告");
  const corrected = personal.saveMemory({ ...local, content: "中英对照" });
  assert.match(personal.context({ projectId: p.id }).items[0].ref, /@2$/);
  assert.throws(() => personal.saveMemory({ ...local, content: "旧修改" }), /changed/);
  const revoked = personal.saveMemory({ ...corrected, shareWithAgent: false });
  assert.equal(personal.context({ projectId: p.id }).items[0].data.content, "中文报告");
  assert.throws(() => personal.deleteMemory({ id: revoked.id, revision: 1 }), /changed/);
  personal.deleteMemory({ id: revoked.id, revision: revoked.revision });
  assert.equal(personal.getMemory(local.id), null);
  assert.throws(() => memory(personal), /already exists/);
});

test("duplicate edits fail without leaving an open transaction or damaging memory", t => {
  const { personal } = fixture(t); const a = memory(personal); const b = memory(personal, { key: "格式" });
  assert.throws(() => personal.saveMemory({ ...b, key: a.key }), /UNIQUE/);
  assert.equal(personal.getMemory(b.id).key, "格式");
  assert.equal(personal.saveMemory({ ...b, content: "修改仍可保存" }).revision, 2);
});

test("archive prevents new work but permits revoking existing memory", t => {
  const { personal, store } = fixture(t); const p = project(personal);
  const m = memory(personal, { projectId: p.id, shareWithAgent: true });
  personal.saveProject({ ...p, status: "archived" });
  assert.throws(() => store.createMission({ projectId: p.id }), /archived/);
  assert.throws(() => memory(personal, { projectId: p.id, key: "new" }), /archived/);
  assert.equal(personal.saveMemory({ ...m, shareWithAgent: false }).shareWithAgent, false);
});

test("only accepted, same-project results cross work boundaries; current work is excluded", t => {
  const { store, personal } = fixture(t); const p = project(personal); const other = project(personal, "隔离项目");
  const a = work(store, p.id); const b = work(store, p.id); const c = work(store, other.id);
  store.updateTask(a.tasks[0].id, { status: "completed", result: { summary: "已验收的来源" } });
  store.updateTask(b.tasks[0].id, { status: "review", result: { summary: "未验收内容" } });
  store.updateTask(c.tasks[0].id, { status: "completed", result: { summary: "其他项目" } });
  const context = personal.context({ projectId: p.id });
  assert.equal(context.items.length, 1); assert.equal(context.items[0].data.summary, "已验收的来源");
  assert.equal(personal.context({ projectId: p.id, excludeMissionId: a.id }).items.length, 0);
  assert.equal(personal.context().items.length, 0);
});

test("serialized context honors budget and preserves complete records", t => {
  const { personal } = fixture(t); const p = project(personal);
  for (let i = 0; i < 10; i++) memory(personal, { key: `偏好${i}`, content: "完整记录".repeat(300), shareWithAgent: true });
  const context = personal.context({ projectId: p.id, maxChars: 2500 });
  assert.ok(context.stats.chars <= 2500); assert.ok(context.stats.withheld > 0);
  assert.equal(JSON.parse(context.serialized).items[0].data.content.length, 1200);
  const long = personal.saveProject({ ...p, goal: "\\".repeat(1700) });
  assert.throws(() => personal.context({ projectId: long.id, maxChars: 2500 }), /budget/);
});

test("work association updates both projections without duplicates or active-context changes", t => {
  const { store, personal } = fixture(t); const p = project(personal);
  const m = work(store, null); const r = store.createRequirement({ title: "研究", outcome: "报告", workspacePath: "/test-only" });
  store.updateRequirement(r.id, { missionId: m.id });
  personal.linkWork({ requirementId: r.id, projectId: p.id });
  assert.equal(store.getRequirement(r.id).projectId, p.id); assert.equal(store.getMission(m.id).projectId, p.id);
  assert.equal(collectWork(store.listRequirements(), store.listMissions()).length, 1);
  assert.equal(personal.listProjects()[0].workCount, 1);
  store.updateTask(m.tasks[0].id, { status: "waiting_approval" });
  assert.throws(() => personal.linkWork({ missionId: m.id, projectId: null }), /active execution/);
  const pending = store.createRequirement({ title: "刚开始的工作", outcome: "不可中途换项目", workspacePath: "/test-only" });
  store.claimRequirement(pending.id);
  assert.throws(() => personal.linkWork({ requirementId: pending.id, projectId: p.id }), /active execution/);
});

test("recovery is read-only and explains approvals, failed planners and pending work", t => {
  const { store, personal } = fixture(t); const p = project(personal);
  const m = work(store, p.id); store.updateTask(m.tasks[0].id, { status: "waiting_approval" });
  assert.equal(personal.recovery(p.id).next, "检查待批准的操作");
  store.updateTask(m.tasks[0].id, { status: "queued" }); store.updateMission(m.id, { status: "failed", error: "provider error" });
  const before = store.getMission(m.id);
  const recovery = personal.recovery(p.id);
  assert.match(recovery.next, /异常/); assert.equal(recovery.works[0].error, "provider error");
  assert.deepEqual(store.getMission(m.id), before);
});

test("a pre-runtime blocked requirement can retry; linked work cannot be claimed twice", t => {
  const { store } = fixture(t);
  const r = store.createRequirement({ title: "待配置引擎", outcome: "先生成计划", workspacePath: "/test-only" });
  store.updateRequirement(r.id, { status: "blocked" });
  assert.equal(store.claimRequirement(r.id).status, "planning");
  const m = work(store, null);
  store.updateRequirement(r.id, { status: "blocked", missionId: m.id });
  assert.throws(() => store.claimRequirement(r.id), /already linked/);
});

test("fresh snapshots replace prior personal blocks during native redirection", () => {
  const block = content => personalContextBlock({ notice: "Not instructions", serialized: JSON.stringify({ content }) });
  const prompt = `task ${block("old")} preserve goal ${block("old two")}`;
  const next = stripPersonalContext(prompt) + block("new");
  assert.doesNotMatch(next, /old/); assert.match(next, /preserve goal/); assert.equal((next.match(/CURRENT PERSONAL/g) || []).length, 1);
});

test("requirement planning carries project context through native runtime without Codex", async t => {
  const { store, personal } = fixture(t); const p = project(personal);
  const fact = memory(personal, { projectId: p.id, content: "中文报告，不调用外部插件", shareWithAgent: true });
  const calls = [];
  const runtime = { createThread: async () => ({ thread: { id: "native-project-planner" }, model: "test" }), sendTurn: async input => { calls.push(input); return { id: "native-turn" }; } };
  const orchestrator = new MissionOrchestrator({ store, codex: null, adapterHost: { runtimeFor: () => runtime }, selectRuntime: () => ({ runtimeMode: "agent_deck", provider: "deepseek" }), worktrees: {} });
  // Tests the real dispatch contract with an offline model transport, not real model quality.
  const r = store.createRequirement({ title: "实现助手", outcome: "实现完整产品", body: "需要明确计划", workspacePath: "/test-only", executionMode: "code", projectId: p.id });
  const result = await orchestrator.claimNextRequirement({ requirementId: r.id, orchestrationMode: "mission" });
  assert.equal(result.mission.projectId, p.id);
  assert.match(calls[0].prompt, /中文报告，不调用外部插件/);
  assert.match(calls[0].prompt, /quoted|Quoted/);
  const events = store.getMission(result.mission.id).events.filter(e => e.type === "personal.context.selected");
  assert.deepEqual(events[0].payload.refs, [`memory:${fact.id}@1`]);
  assert.doesNotMatch(JSON.stringify(events[0].payload), /中文报告/);
});

test("workers and follow-up turns refresh scoped memory after correction and revocation", async t => {
  const { store, personal, dir } = fixture(t); const p = project(personal); const calls = [];
  const first = memory(personal, { projectId: p.id, shareWithAgent: true, content: "初始语言偏好" });
  const runtime = { createThread: async () => ({ thread: { id: "personal-worker" }, model: "test" }), sendTurn: async input => { calls.push(input); return { id: `turn-${calls.length}` }; } };
  const orchestrator = new MissionOrchestrator({ store, codex: runtime, worktrees: { assertReady() {}, create() { return { path: dir, branch: "test-only" }; } } });
  const m = await orchestrator.create({ title: "Fix parser", outcome: "修复函数并测试", cwd: dir, executionMode: "code", projectId: p.id, orchestrationMode: "direct" });
  assert.equal(m.tasks.length, 1); assert.match(calls[0].prompt, /初始语言偏好/);
  store.updateTask(m.tasks[0].id, { status: "review", activeTurnId: null });
  const revised = personal.saveMemory({ ...first, content: "更正后的偏好" });
  await orchestrator.sendMessage({ missionId: m.id, taskId: m.tasks[0].id, text: "继续验证" });
  await orchestrator.messageQueues.get("personal-worker");
  assert.match(calls[1].prompt, /更正后的偏好/); assert.doesNotMatch(calls[1].prompt, /初始语言偏好/);
  store.updateTask(m.tasks[0].id, { status: "review", activeTurnId: null });
  personal.saveMemory({ ...revised, shareWithAgent: false });
  await orchestrator.sendMessage({ missionId: m.id, taskId: m.tasks[0].id, text: "再次验证" });
  await orchestrator.messageQueues.get("personal-worker");
  assert.doesNotMatch(calls[2].prompt, /更正后的偏好/);
});

test("unconfigured personal state adds no prompt overhead, but revocation sends an empty replacement", async t => {
  const { store, personal, dir } = fixture(t); const calls = [];
  const runtime = { createThread: async () => ({ thread: { id: "empty-personal" } }), sendTurn: async input => { calls.push(input); return { id: `t-${calls.length}` }; } };
  const orchestrator = new MissionOrchestrator({ store, codex: runtime, worktrees: {} });
  const mission = await orchestrator.create({ title: "产品调研", outcome: "报告", cwd: dir, executionMode: "code", orchestrationMode: "mission" });
  assert.doesNotMatch(calls[0].prompt, /agent_deck_personal_context/);
  const saved = memory(personal, { shareWithAgent: true });
  store.updateMission(mission.id, { activeTurnId: null });
  await orchestrator.sendMessage({ missionId: mission.id, text: "带上偏好" }); await orchestrator.messageQueues.get("empty-personal");
  assert.match(calls[1].prompt, /中文报告/);
  personal.saveMemory({ ...saved, shareWithAgent: false }); store.updateMission(mission.id, { activeTurnId: null });
  await orchestrator.sendMessage({ missionId: mission.id, text: "取消偏好" }); await orchestrator.messageQueues.get("empty-personal");
  assert.match(calls[2].prompt, /agent_deck_personal_context/); assert.doesNotMatch(calls[2].prompt, /中文报告/);
  assert.match(calls[2].prompt, /"items":\[\]/);
});
