import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import test from "node:test";
import { nextMissionAction } from "../src/mission-next-action.js";
const require = createRequire(import.meta.url);
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { ProviderRegistry } = require("../desktop/provider-registry.cjs");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { ApiAgentRuntime } = require("../desktop/api-agent-runtime.cjs");
const { NativeHarnessRuntime } = require("../desktop/native-harness-runtime.cjs");
const { selfCheckSchema, validateCheck } = require("../desktop/autonomous-execution.cjs");
const { assertStrictOutputSchema } = require("../desktop/structured-output-schema.cjs");
const { saveRuntimeWithConsent } = require("../desktop/runtime-consent.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 200; i++) { if (predicate()) return; await tick(); } throw new Error("Expected state did not arrive"); }
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-autonomous-"));
  const cwd = path.join(root, "source"); fs.mkdirSync(cwd);
  git(cwd, "init", "-q"); git(cwd, "config", "user.name", "QA"); git(cwd, "config", "user.email", "qa@example.test");
  fs.writeFileSync(path.join(cwd, "seed.txt"), "seed\n"); git(cwd, "add", "seed.txt"); git(cwd, "commit", "-qm", "fixture");
  const store = new MissionStore(path.join(root, "test.sqlite3"));
  const worktrees = new WorktreeManager(path.join(root, "worktrees"));
  const calls = []; let seq = 0;
  const runtime = {
    async createThread(input) { const id = `thread-${++seq}`; calls.push({ type: "create", ...input, id }); return { thread: { id }, model: "fixture-model" }; },
    async sendTurn(input) { const id = `turn-${++seq}`; calls.push({ type: "turn", ...input, id }); return { id }; },
    async interrupt(input) { calls.push({ type: "interrupt", ...input }); },
    async resumeThread(...args) { calls.push({ type: "resume", args }); },
    async readThread() { return { turns: [] }; },
  };
  const orchestrator = new MissionOrchestrator({ store, worktrees, codex: runtime });
  const mission = store.createMission({ title: "写两个文件", outcome: "交付两个文件", cwd, executionMode: "code", interactionMode: options.mode || "autonomous" });
  store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, scope: [], constraints: [], nonGoals: [], acceptanceCriteria: ["两个文件存在"], tasks: [
    { key: "A", title: "第一个文件", description: "创建 A.txt", agentRole: "Writer", dependencies: [], acceptanceCriteria: ["A.txt 存在"], estimatedTokenBudget: 1000 },
    { key: "B", title: "第二个文件", description: "读取 A.txt 并创建 B.txt", agentRole: "Writer", dependencies: ["A"], acceptanceCriteria: ["B.txt 存在"], estimatedTokenBudget: 1000 },
  ] });
  t.after(() => { orchestrator.autonomous.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, cwd, store, worktrees, orchestrator, runtime, calls, missionId: mission.id };
}
async function workerDone(f, task, passing = true) {
  fs.writeFileSync(path.join(task.worktreePath, `${task.key}.txt`), task.key);
  await f.orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: task.agentThreadId, turnId: task.activeTurnId, item: { id: `message-${task.activeTurnId}`, type: "agentMessage", text: JSON.stringify({ summary: "文件已创建", acceptance: [{ criterion: task.acceptanceCriteria[0], passed: passing, evidence: passing ? "文件存在" : "测试失败" }], changedFiles: [`${task.key}.txt`], blockers: [] }) } } });
  await f.orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: task.agentThreadId, turn: { id: task.activeTurnId, status: "completed" } } });
}
async function checkDone(f, turn, { passed = true, receipts = true, duplicate = false } = {}) {
  if (receipts) await f.orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.id, item: { id: "inspection", type: "commandExecution", status: "completed", exitCode: 0, aggregatedOutput: "fixture file inspected" } } });
  await f.orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: turn.threadId, turnId: turn.id, item: { id: "answer", type: "agentMessage", text: JSON.stringify({ passed, summary: passed ? "独立核验通过" : "存在问题", feedback: passed ? "" : "请修正文件", checks: [{ criterionIndex: 0, passed, evidence: "读取了实际文件" }] }) } } });
  const event = { method: "turn/completed", params: { threadId: turn.threadId, turn: { id: turn.id, status: "completed" } } };
  await f.orchestrator.handleCodexEvent(event);
  if (duplicate) await f.orchestrator.handleCodexEvent(event);
}
const checks = f => f.calls.filter(call => call.type === "turn" && call.outputSchema === selfCheckSchema);

test("enabling full permissions requires one explicit consent and concurrent disabling wins", async t => {
  const f = fixture(t); const registry = new ProviderRegistry({ userDataPath: f.root }); let warnings = 0;
  const confirm = async () => { warnings++; return true; };
  assert.equal((await saveRuntimeWithConsent(registry, { interactionMode: "autonomous" }, async () => false)).interactionMode, "manual");
  await assert.rejects(saveRuntimeWithConsent(registry, { interactionMode: "bad" }, confirm), /Unknown/);
  assert.equal(warnings, 0);
  await Promise.all([saveRuntimeWithConsent(registry, { interactionMode: "autonomous" }, confirm), saveRuntimeWithConsent(registry, { interactionMode: "autonomous" }, confirm)]);
  assert.equal(warnings, 1);
  await saveRuntimeWithConsent(registry, { interactionMode: "manual" });
  await Promise.all([saveRuntimeWithConsent(registry, { interactionMode: "autonomous" }, confirm), saveRuntimeWithConsent(registry, { interactionMode: "manual" })]);
  assert.equal(registry.runtimeSettings().interactionMode, "manual");
});

test("workspace fingerprints detect same-size edits and committed changes", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "abcd");
  const initial = f.worktrees.fingerprint(f.cwd);
  fs.writeFileSync(path.join(f.cwd, "new.txt"), "wxyz");
  assert.notEqual(initial, f.worktrees.fingerprint(f.cwd));
  const edited = f.worktrees.fingerprint(f.cwd);
  git(f.cwd, "add", "new.txt"); git(f.cwd, "commit", "-qm", "change");
  assert.notEqual(edited, f.worktrees.fingerprint(f.cwd));
});

test("duplicate integration while attaching a checker starts only one thread", async t => {
  const f = fixture(t); let release;
  f.runtime.createThread = async () => { await new Promise(resolve => { release = resolve; }); return { thread: { id: "held-check" } }; };
  const mission = f.store.getMission(f.missionId);
  const pending = f.orchestrator.autonomous.start(mission, null, "integration", f.cwd);
  await tick();
  assert.equal(f.orchestrator.autonomous.busy(f.missionId), true);
  await f.orchestrator.autonomous.start(mission, null, "integration", f.cwd);
  release(); await pending;
  assert.equal(checks(f).length, 1);
});

test("Stop during worker turn attachment interrupts the returned turn without restoring running state", async t => {
  const f = fixture(t); let release;
  f.runtime.sendTurn = async input => { f.calls.push({ type: "turn", ...input, id: "held-worker" }); await new Promise(resolve => { release = resolve; }); return { id: "held-worker" }; };
  const dispatch = f.orchestrator.approve(f.missionId);
  await until(() => Boolean(release)); await f.orchestrator.cancel(f.missionId); release(); await dispatch;
  assert.equal(f.store.getMissionStatus(f.missionId), "canceled");
  assert.ok(f.store.getMission(f.missionId).tasks.every(task => task.status === "canceled" && !task.activeTurnId));
  assert.ok(f.calls.some(call => call.type === "interrupt" && call.turnId === "held-worker"));
});

test("Stop during checker turn attachment interrupts it and never arms late work", async t => {
  const f = fixture(t); let release;
  f.runtime.sendTurn = async input => { f.calls.push({ type: "turn", ...input, id: "held-check" }); await new Promise(resolve => { release = resolve; }); return { id: "held-check" }; };
  const pending = f.orchestrator.autonomous.start(f.store.getMission(f.missionId), null, "integration", f.cwd);
  await until(() => Boolean(release)); await f.orchestrator.cancel(f.missionId); release(); await pending;
  assert.equal(f.store.getMissionStatus(f.missionId), "canceled");
  assert.equal(f.orchestrator.autonomous.jobs.size, 0);
  assert.ok(f.calls.some(call => call.type === "interrupt" && call.turnId === "held-check"));
  assert.equal(f.store.getMission(f.missionId).runs.at(-1).status, "interrupted");
});

test("timed-out checker blocks without accepting or leaving an approval wait", async t => {
  const f = fixture(t); await f.orchestrator.approve(f.missionId);
  f.orchestrator.autonomous.timeoutMs = 20;
  const task = f.store.getMission(f.missionId).tasks[0]; await workerDone(f, task);
  await until(() => checks(f).length === 1); await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.store.getTask(task.id).status, "blocked");
  assert.match(f.store.getTask(task.id).error, /time budget/);
  assert.equal(f.store.countTaskEvents(f.missionId, task.id, "task.verified"), 0);
});

test("recovery attaches the saved checker and consumes receipts without replaying a turn", async t => {
  const f = fixture(t); await f.orchestrator.approve(f.missionId);
  const task = f.store.getMission(f.missionId).tasks[0]; await workerDone(f, task);
  await until(() => checks(f).length === 1); const check = checks(f)[0];
  for (const job of f.orchestrator.autonomous.jobs.values()) clearTimeout(job.timer);
  f.orchestrator.autonomous.jobs.clear();
  f.runtime.readThread = async () => ({ turns: [{ id: check.id, status: "completed", items: [
    { id: "read", type: "commandExecution", status: "completed", exitCode: 0 },
    { id: "answer", type: "agentMessage", text: JSON.stringify({ passed: true, summary: "重新附着并读取证据", feedback: "", checks: [{ criterionIndex: 0, passed: true, evidence: "读到 A.txt" }] }) },
  ] }] });
  await f.orchestrator.autonomous.recover(f.store.getMission(f.missionId));
  assert.equal(checks(f).length, 1);
  assert.equal(f.store.getTask(task.id).status, "completed");
  assert.ok(f.calls.some(call => call.type === "resume" && call.args[0] === check.threadId && call.args[2] === false));
});

test("uncertain attachment after crash is reported instead of replaying a mutation", async t => {
  const f = fixture(t);
  f.store.appendEvent(f.missionId, "autonomous.check.preparing", { kind: "integration_repair" }, { threadId: "uncertain" });
  await f.orchestrator.autonomous.recover(f.store.getMission(f.missionId));
  assert.equal(f.store.getMissionStatus(f.missionId), "blocked");
  assert.match(f.store.getMission(f.missionId).error, /No tool action was replayed/);
  assert.equal(f.calls.length, 0);
  assert.ok(f.store.listAttentionItems().some(item => item.missionId === f.missionId));
});

test("consent defaults to manual, new missions pin it, renderer cannot escalate a mission", t => {
  const f = fixture(t, { mode: "manual" });
  const registry = new ProviderRegistry({ userDataPath: f.root });
  assert.equal(registry.runtimeSettings().interactionMode, "manual");
  assert.equal(registry.selectRuntime({ interactionMode: "autonomous" }).interactionMode, "manual");
  registry.saveRuntimeSettings({ interactionMode: "autonomous" });
  assert.equal(new ProviderRegistry({ userDataPath: f.root }).runtimeSettings().interactionMode, "autonomous");
  assert.equal(f.store.getMission(f.missionId).interactionMode, "manual");
  f.store.updateMission(f.missionId, { interactionMode: "autonomous" });
  assert.equal(f.store.getMission(f.missionId).interactionMode, "manual");
  assert.throws(() => registry.saveRuntimeSettings({ interactionMode: "unknown" }), /Unknown/);
  assert.throws(() => f.store.createMission({ interactionMode: "unknown" }), /Unknown/);
  assert.ok(f.store.listAttentionItems().some(item => item.missionId === f.missionId));
});

test("Codex full-access start/turn/resume are pinned while self-check remains read-only", async () => {
  const client = new CodexAppServer({ binary: "/unused" }); const calls = []; let seq = 0;
  client.start = async () => {}; client.resolveModel = async () => "fixture";
  client.request = async (method, params) => { calls.push({ method, params }); return { thread: { id: `t${++seq}` }, turn: { id: "turn" }, config: {} }; };
  const created = await client.createThread({ cwd: "/tmp", allowMutations: true, interactionMode: "autonomous" });
  await client.sendTurn({ threadId: created.thread.id, prompt: "task" });
  assert.equal(calls.find(call => call.method === "thread/start").params.sandbox, "danger-full-access");
  assert.equal(calls.find(call => call.method === "thread/start").params.approvalPolicy, "never");
  assert.deepEqual(calls.find(call => call.method === "turn/start").params.sandboxPolicy, { type: "dangerFullAccess" });
  await assert.rejects(client.sendTurn({ threadId: created.thread.id, prompt: "task", interactionMode: "manual" }), /Cannot change/);
  await client.createThread({ cwd: "/tmp", selfCheck: true, allowMutations: false });
  const check = calls.filter(call => call.method === "thread/start").at(-1).params;
  assert.equal(check.sandbox, "read-only"); assert.equal(check.config["features.multi_agent"], false);
  client.loadedThreads.clear(); await client.resumeThread("restored", "/tmp", true, "autonomous");
  assert.equal(calls.at(-1).params.sandbox, "danger-full-access");
  await client.resumeThread("review", "/tmp", false, "autonomous");
  assert.equal(calls.at(-1).params.sandbox, "read-only");
  await client.resumeThread("restored-review", "/tmp", false, "manual", { selfCheck: true });
  assert.equal(calls.at(-1).params.config["features.hooks"], false);
  assert.equal(calls.at(-1).params.config["features.multi_agent"], false);
  client.stop();
});

test("autonomous DAG approves, checks at low effort, releases dependencies and checks integration", async t => {
  const f = fixture(t);
  f.orchestrator.autonomous.schedule(f.missionId);
  await until(() => f.store.getMission(f.missionId).tasks[0].status === "running");
  assert.equal(f.store.getMission(f.missionId).tasks[1].status, "queued");
  for (let i = 0; i < 2; i++) {
    const task = f.store.getMission(f.missionId).tasks[i];
    assert.equal(f.calls.find(call => call.type === "create" && call.id === task.agentThreadId).interactionMode, "autonomous");
    await workerDone(f, task);
    await until(() => checks(f).length === i + 1);
    const check = checks(f).at(-1); assert.equal(check.effort, "low"); assert.equal(check.allowMutations, false);
    assert.equal(nextMissionAction(f.store.getMission(f.missionId)), null);
    assert.equal(f.store.listAttentionItems().filter(item => item.kind === "review").length, 0);
    await checkDone(f, check, { duplicate: true });
    assert.equal(f.store.getTask(task.id).phase, "agent_verified");
  }
  await until(() => checks(f).length === 3);
  assert.equal(f.store.getMissionStatus(f.missionId), "integrating");
  await checkDone(f, checks(f).at(-1));
  const result = f.store.getMission(f.missionId);
  assert.equal(result.status, "completed");
  assert.ok(fs.existsSync(path.join(result.integrationPath, "A.txt")));
  assert.ok(fs.existsSync(path.join(result.integrationPath, "B.txt")));
  assert.ok(result.artifacts.every(artifact => artifact.verificationStatus === "agent_verified"));
  assert.equal(result.messages.filter(message => message.source === "user").length, 0);
  assert.equal(f.store.countTaskEvents(f.missionId, result.tasks[0].id, "task.verified"), 1);
});

test("manual DAG keeps human plan/result gates and never starts a self-check", async t => {
  const f = fixture(t, { mode: "manual" });
  await f.orchestrator.autonomous.pump(f.missionId);
  assert.equal(f.calls.length, 0);
  await f.orchestrator.approve(f.missionId);
  await workerDone(f, f.store.getMission(f.missionId).tasks[0]); await tick();
  assert.equal(f.store.getMission(f.missionId).tasks[0].status, "review");
  assert.equal(checks(f).length, 0);
});

test("a real planner completion schedules autonomous approval, never dispatching before completion", async t => {
  const f = fixture(t);
  const template = f.store.getMission(f.missionId).spec;
  const mission = await f.orchestrator.create({ title: "研究并拆解任务 DAG", outcome: "创建两个文件", cwd: f.cwd, executionMode: "auto", interactionMode: "autonomous", orchestrationMode: "mission" });
  const turn = f.calls.find(call => call.type === "turn" && call.threadId === mission.mainThreadId);
  await f.orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: mission.mainThreadId, turnId: turn.id, item: { id: "real-plan-contract", type: "agentMessage", text: JSON.stringify({ ...template, workspace: { strategy: "existing_git", reason: "Fixture Git is ready", trackedFiles: [] } }) } } });
  await tick(); assert.equal(f.store.getMissionStatus(mission.id), "ready");
  assert.equal(f.store.getMission(mission.id).tasks[0].agentThreadId, null);
  await f.orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: mission.mainThreadId, turn: { id: turn.id, status: "completed" } } });
  await until(() => f.store.getMission(mission.id).tasks[0].status === "running");
  assert.equal(f.store.getMission(mission.id).interactionMode, "autonomous");
});

test("conflicting integration is repaired by Main Agent and then independently rechecked", async t => {
  const f = fixture(t);
  const initial = f.store.getMission(f.missionId).spec;
  f.store.savePlan(f.missionId, { ...initial, tasks: initial.tasks.map(task => ({ ...task, dependencies: [] })) });
  await f.orchestrator.approve(f.missionId);
  const tasks = f.store.getMission(f.missionId).tasks;
  assert.ok(tasks.every(task => task.status === "running"));
  for (let i = 0; i < tasks.length; i++) {
    fs.writeFileSync(path.join(tasks[i].worktreePath, "seed.txt"), tasks[i].key + "\n");
    await workerDone(f, tasks[i]); await until(() => checks(f).length >= i + 1); await checkDone(f, checks(f)[i]);
  }
  await until(() => checks(f).length === 3);
  const repair = checks(f)[2]; assert.equal(repair.allowMutations, true); assert.equal(repair.effort, "low");
  assert.equal(f.store.countTaskEvents(f.missionId, null, "autonomous.integration.repair"), 1);
  fs.writeFileSync(path.join(repair.cwd, "seed.txt"), "A+B\n"); git(repair.cwd, "add", "seed.txt"); git(repair.cwd, "commit", "-qm", "Preserve both contributions");
  await checkDone(f, repair); await until(() => checks(f).length === 4);
  const final = checks(f)[3]; assert.equal(final.allowMutations, false); await checkDone(f, final);
  const completed = f.store.getMission(f.missionId); assert.equal(completed.status, "completed");
  assert.equal(fs.readFileSync(path.join(completed.integrationPath, "seed.txt"), "utf8"), "A+B\n");
  for (const task of tasks) git(completed.integrationPath, "merge-base", "--is-ancestor", task.branch, "HEAD");
});

test("failed worker checks get two fresh repairs, then a real blocker, never fake success", async t => {
  const f = fixture(t); await f.orchestrator.approve(f.missionId);
  for (let i = 0; i < 3; i++) {
    const task = f.store.getMission(f.missionId).tasks[0]; await workerDone(f, task, false);
    await until(() => f.store.getTask(task.id).status !== "review");
    if (i < 2) { assert.equal(f.store.getTask(task.id).result, null); assert.equal(f.store.getTask(task.id).status, "running"); }
  }
  assert.equal(f.store.getMissionStatus(f.missionId), "blocked");
  assert.equal(f.store.getMission(f.missionId).tasks[1].status, "queued");
  assert.equal(f.store.countTaskEvents(f.missionId, f.store.getMission(f.missionId).tasks[0].id, "autonomous.repair.started"), 2);
  assert.equal(checks(f).length, 0);
});

test("self-check without inspection triggers correction, not acceptance", async t => {
  const f = fixture(t); await f.orchestrator.approve(f.missionId);
  const task = f.store.getMission(f.missionId).tasks[0]; await workerDone(f, task);
  await until(() => checks(f).length === 1); await checkDone(f, checks(f)[0], { receipts: false });
  assert.equal(f.store.getTask(task.id).status, "running");
  assert.equal(f.store.countTaskEvents(f.missionId, task.id, "task.verified"), 0);
});

test("Stop closes self-check gates before interrupt and ignores late completions", async t => {
  const f = fixture(t); await f.orchestrator.approve(f.missionId);
  const task = f.store.getMission(f.missionId).tasks[0]; await workerDone(f, task);
  await until(() => checks(f).length === 1); const check = checks(f)[0];
  await f.orchestrator.cancel(f.missionId); await checkDone(f, check);
  assert.equal(f.store.getMissionStatus(f.missionId), "canceled");
  assert.equal(f.store.getTask(task.id).status, "canceled");
  assert.ok(f.calls.some(call => call.type === "interrupt" && call.threadId === check.threadId));
  assert.equal(f.store.countTaskEvents(f.missionId, task.id, "task.verified"), 0);
});

test("stale checks never accept a changed result", async t => {
  const f = fixture(t); await f.orchestrator.approve(f.missionId);
  const task = f.store.getMission(f.missionId).tasks[0]; await workerDone(f, task);
  await until(() => checks(f).length === 1);
  f.store.updateTask(task.id, { result: { ...f.store.getTask(task.id).result, summary: "新的结果" } });
  await checkDone(f, checks(f)[0]);
  assert.equal(f.store.getTask(task.id).status, "review");
  assert.equal(f.store.countTaskEvents(f.missionId, task.id, "task.verified"), 0);
});

test("all self-check criteria and actual inspection are required by the strict contract", () => {
  assertStrictOutputSchema(selfCheckSchema);
  const valid = { passed: true, summary: "Checked", feedback: "", checks: [{ criterionIndex: 0, passed: true, evidence: "Read file" }] };
  assert.equal(validateCheck(valid, ["File exists"], 1), null);
  assert.throws(() => validateCheck(valid, ["File exists"], 0), /independently inspecting/);
  assert.throws(() => validateCheck({ ...valid, checks: [] }, ["File exists"], 1), /every acceptance/);
  assert.throws(() => validateCheck({ ...valid, checks: [valid.checks[0], valid.checks[0]] }, ["A", "B"], 1), /duplicate/);
  assert.throws(() => validateCheck({ ...valid, passed: "true" }, ["File exists"], 1), /invalid/);
});

test("native autonomous tool broker skips human permission but validates paths and protects read-only review", async t => {
  const f = fixture(t); const events = []; const commands = [];
  const runtime = new ApiAgentRuntime({ providerRegistry: { apiProfile: () => ({ model: "fixture", endpoint: "https://example.test", apiKey: "unused" }) }, commandRunner: async input => { commands.push(input.command); return { exitCode: 0, stdout: "done" }; } });
  runtime.on("event", event => events.push(event));
  const created = await runtime.createThread({ cwd: f.cwd, provider: "deepseek", allowMutations: true, interactionMode: "autonomous" });
  const thread = runtime.threads.get(created.thread.id); const turn = { id: "turn", items: [], approvalIds: new Set() };
  const result = await runtime.executeControlledTool({ thread, turn, name: "workspace_bash", args: { command: "printf hello && printf world" }, signal: new AbortController().signal });
  assert.equal(result.ok, true); assert.equal(commands.length, 1);
  assert.equal(events.some(event => /requestApproval/.test(event.method)), false);
  assert.ok(events.some(event => event.params.reviewer === "autonomous_policy"));
  assert.equal((await runtime.executeControlledTool({ thread, turn, name: "workspace_write", args: { path: "../escape", content: "no" } })).ok, false);
  thread.allowMutations = false;
  assert.equal((await runtime.executeControlledTool({ thread, turn, name: "workspace_bash", args: { command: "printf no" } })).ok, false);
  assert.equal(commands.length, 1);
});

test("native fast read-only check applies supported DeepSeek low parameter and persists effort", async t => {
  const f = fixture(t); const requests = [];
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(f.root, "native"), providerRegistry: { apiProfile: () => ({ endpoint: "https://api.deepseek.com/v1", model: "deepseek-flash", apiKey: "fixture" }) }, fetchImpl: async (_url, input) => {
    requests.push(JSON.parse(input.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"title":"Check"}' } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  } });
  const created = await runtime.createThread({ cwd: f.cwd, provider: "deepseek", allowMutations: false });
  const done = new Promise(resolve => runtime.on("event", event => { if (event.method === "turn/completed") resolve(event); }));
  await runtime.sendTurn({ threadId: created.thread.id, prompt: "检查", effort: "low", outputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false } });
  assert.equal((await done).params.turn.status, "completed");
  assert.equal(requests[0].reasoning_effort, "low"); assert.equal(requests[0].max_tokens, 4096);
  assert.equal((await runtime.readThread(created.thread.id)).turns[0].effort, "low");
  assert.ok(!requests[0].tools.some(tool => tool.function.name === "workspace_write"));
});

test("native autonomous descriptions and unsupported-model low fallback do not contradict authorization", async t => {
  const f = fixture(t); const requests = [];
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(f.root, "native"), providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "compatible-model", apiKey: "fixture" }) }, fetchImpl: async (_url, input) => {
    requests.push(JSON.parse(input.body));
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"title":"Check"}' } }] }));
  } });
  const created = await runtime.createThread({ cwd: f.cwd, provider: "openai_compatible", allowMutations: false, interactionMode: "autonomous", selfCheck: true });
  const done = new Promise(resolve => runtime.on("event", event => { if (event.method === "turn/completed") resolve(event); }));
  await runtime.sendTurn({ threadId: created.thread.id, prompt: "检查", effort: "low", outputSchema: { type: "object", required: ["title"], properties: { title: { type: "string" } }, additionalProperties: false } });
  assert.equal((await done).params.turn.status, "completed");
  assert.equal(requests[0].reasoning_effort, undefined);
  assert.equal(requests.length, 1); // No redundant model auditor inside self-check.
  const { preauthorizedTool } = require("../desktop/execution-mode.cjs");
  const { tools } = require("../desktop/api-agent-runtime.cjs");
  for (const tool of tools.map(preauthorizedTool)) assert.doesNotMatch(tool.function.description, /always pauses? for explicit human approval/);
});
