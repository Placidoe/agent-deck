import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { workspaceSchema, normalizeWorkspace } = require("../desktop/workspace-policy.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator, missionPlanSchema } = require("../desktop/mission-orchestrator.cjs");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { assertStrictOutputSchema } = require("../desktop/structured-output-schema.cjs");

const git = (cwd, args) => execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
const decision = strategy => ({ strategy, reason: "按实际任务准备环境", trackedFiles: [] });
const plan = workspace => ({ title: "Prepare the task", outcome: "Generate a verified output", scope: ["Output"], nonGoals: [], constraints: [], acceptanceCriteria: ["Output is readable"], workspace,
  tasks: [{ key: "OUTPUT", title: "Generate output", description: "Complete the requested work", agentRole: "Worker", dependencies: [], acceptanceCriteria: ["Output is readable"], estimatedTokenBudget: 2000 }] });
function fixture(t, confirmWorkspaceInitialization, native = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-workspace-"));
  const source = path.join(directory, "source"); fs.mkdirSync(source);
  const store = new MissionStore(path.join(directory, "ledger.sqlite3"));
  const worktrees = new WorktreeManager(path.join(directory, "managed"));
  const calls = []; let seq = 0;
  const runtime = { createThread: async input => { calls.push({ kind: "thread", ...input }); return { thread: { id: `thread-${++seq}` }, model: "fixture-model" }; }, sendTurn: async input => { calls.push({ kind: "turn", ...input }); return { id: `turn-${++seq}` }; }, interrupt: async input => { calls.push({ kind: "interrupt", ...input }); } };
  const orchestrator = new MissionOrchestrator({ store, worktrees, confirmWorkspaceInitialization,
    ...(native ? { adapterHost: { runtimeFor: () => runtime }, selectRuntime: () => ({ runtimeMode: "agent_deck", provider: "deepseek" }), codex: new Proxy({}, { get() { throw new Error("Must not access Codex"); } }) } : { codex: runtime }) });
  t.after(() => { store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const emit = async (mission, value, id = "plan") => orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: store.getMission(mission.id).mainThreadId, item: { id, type: "agentMessage", text: JSON.stringify(value) } } });
  return { source, directory, store, worktrees, calls, runtime, orchestrator, emit };
}

test("workspace schemas remain strict; unsafe paths and silent imports are rejected", () => {
  assertStrictOutputSchema(workspaceSchema); assertStrictOutputSchema(missionPlanSchema);
  for (const file of ["../secret", "/absolute", "src/*", ".git/config", "a\\b", "a\nline", "a/./b"]) assert.throws(() => normalizeWorkspace({ ...decision("initialize_git"), trackedFiles: [file] }));
  assert.throws(() => normalizeWorkspace({ ...decision("managed"), trackedFiles: ["README.md"] }));
});

for (const native of [false, true]) test(`automatic workspace accepts ordinary folders without a task category (${native ? "native" : "external"})`, async t => {
  const f = fixture(t, null, native);
  fs.writeFileSync(path.join(f.source, "input.txt"), "keep original");
  const requirement = f.store.createRequirement({ title: "Build an output", outcome: "Save a file", workspacePath: f.source });
  assert.equal(requirement.executionMode, "auto");
  const { mission } = await f.orchestrator.claimNextRequirement({ requirementId: requirement.id });
  assert.equal(mission.executionMode, "auto"); assert.equal(mission.status, "planning");
  assert.equal(f.calls[0].allowMutations, false); assert.equal(f.calls[1].allowMutations, false);
  assert.match(f.calls[1].prompt, /task-driven, not document\/code categories/);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
  await f.emit(mission, plan(decision("managed")));
  assert.equal(f.store.getMission(mission.id).status, "ready");
  assert.equal(f.store.getMission(mission.id).tasks[0].agentThreadId, null);
  await f.orchestrator.approve(mission.id);
  const running = f.store.getMission(mission.id);
  assert.equal(running.tasks[0].status, "running");
  assert.notEqual(running.executionCwd, f.source);
  assert.equal(f.calls.find(c => c.kind === "thread" && c.allowMutations).referenceRoot, f.source);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
  assert.equal(fs.readFileSync(path.join(f.source, "input.txt"), "utf8"), "keep original");
});

test("Agent-proposed initialization commits only approved files before isolated workers start", async t => {
  let preview;
  const f = fixture(t, async proposal => { preview = proposal; assert.equal(fs.existsSync(path.join(f.source, ".git")), false); return true; });
  fs.writeFileSync(path.join(f.source, "app.js"), "export const app = true;\n");
  fs.writeFileSync(path.join(f.source, "private-notes.txt"), "not part of project");
  const mission = await f.orchestrator.create({ title: "Fix app", outcome: "Implement and test", cwd: f.source });
  await f.emit(mission, plan({ ...decision("initialize_git"), trackedFiles: ["app.js"] }));
  await f.orchestrator.approve(mission.id);
  assert.deepEqual(preview.files.map(file => file.path), ["app.js"]);
  assert.equal(git(f.source, ["ls-files"]), "app.js");
  assert.equal(f.store.getMission(mission.id).tasks[0].status, "running");
  assert.equal(fs.existsSync(path.join(f.store.getMission(mission.id).tasks[0].worktreePath, "private-notes.txt")), false);
  assert.equal(fs.readFileSync(path.join(f.source, "private-notes.txt"), "utf8"), "not part of project");
  assert.equal(git(f.source, ["remote"]), "");
});

test("canceling initialization and duplicate approvals never start or modify work", async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const mission = await f.orchestrator.create({ title: "New project", outcome: "Build project", cwd: f.source });
  await f.emit(mission, plan(decision("initialize_git")));
  const pending = f.orchestrator.approve(mission.id);
  await assert.rejects(f.orchestrator.approve(mission.id), /重复批准/);
  assert.throws(() => f.orchestrator.changeWorkspace(mission.id, f.source, "auto"), /尚未创建/);
  release(false); await pending;
  assert.equal(f.store.getMission(mission.id).status, "ready");
  assert.equal(f.store.getMission(mission.id).tasks[0].agentThreadId, null);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
});

test("file changes or plan cancellation during confirmation invalidate preparation", async t => {
  const f = fixture(t, async () => { fs.writeFileSync(path.join(f.source, "app.js"), "changed after confirmation"); return true; });
  fs.writeFileSync(path.join(f.source, "app.js"), "original");
  const mission = await f.orchestrator.create({ title: "Modify project", outcome: "Implement", cwd: f.source });
  await f.emit(mission, plan({ ...decision("initialize_git"), trackedFiles: ["app.js"] }));
  await assert.rejects(f.orchestrator.approve(mission.id), /确认期间发生了变化/);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
  f.orchestrator.confirmWorkspaceInitialization = async () => { await f.orchestrator.cancel(mission.id); return true; };
  await assert.rejects(f.orchestrator.approve(mission.id), /计划在确认期间/);
  assert.equal(f.store.getMission(mission.id).status, "canceled");
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
});

test("initialization guards secrets, symlinks, directories, parent projects and user staging", t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.source, ".env"), "private");
  fs.writeFileSync(path.join(f.source, "key.txt"), "-----BEGIN PRIVATE KEY-----");
  fs.symlinkSync(path.join(f.source, "key.txt"), path.join(f.source, "linked.txt"));
  for (const file of [".env", "key.txt", "linked.txt", "../outside", "."]) assert.throws(() => f.worktrees.previewInitialization(f.source, [file]));
  const nested = path.join(f.source, "nested"); fs.mkdirSync(nested);
  git(nested, ["init", "-q"]);
  assert.throws(() => f.worktrees.previewInitialization(f.source, []), /具体项目/);
  assert.throws(() => f.worktrees.previewInitialization(os.homedir(), []), /个人父目录/);
  const unborn = path.join(f.directory, "unborn"); fs.mkdirSync(unborn); git(unborn, ["init", "-q"]);
  fs.writeFileSync(path.join(unborn, "user.txt"), "staged by user"); git(unborn, ["add", "user.txt"]);
  assert.throws(() => f.worktrees.previewInitialization(unborn, ["user.txt"]), /暂存内容/);
  assert.equal(git(unborn, ["diff", "--cached", "--name-only"]), "user.txt");
});

test("unstarted legacy workspace assessment preserves task IDs and approval gates", async t => {
  const f = fixture(t);
  const mission = f.store.createMission({ title: "Legacy", outcome: "Keep task", cwd: f.source });
  const legacyPlan = plan(decision("managed")); delete legacyPlan.workspace;
  f.store.savePlan(mission.id, legacyPlan);
  f.store.updateMission(mission.id, { status: "blocked", mainThreadId: "old-planner" });
  const taskId = f.store.getMission(mission.id).tasks[0].id;
  await f.orchestrator.assessWorkspace(mission.id);
  assert.equal(f.store.getMission(mission.id).status, "planning");
  assert.equal(f.store.getMission(mission.id).tasks[0].id, taskId);
  assert.equal(f.calls[1].outputSchema, workspaceSchema);
  await f.emit(mission, decision("managed"), "workspace-decision");
  assert.equal(f.store.getMission(mission.id).status, "ready");
  assert.equal(f.store.getMission(mission.id).tasks[0].id, taskId);
  assert.equal(f.store.getMission(mission.id).tasks[0].agentThreadId, null);
  await f.orchestrator.approve(mission.id);
  await assert.rejects(f.orchestrator.assessWorkspace(mission.id), /尚未创建/);
});

for (const native of [false, true]) test(`approve a legacy ordinary folder assesses first and requires a second approval (${native ? "native" : "external"})`, async t => {
  const f = fixture(t, null, native);
  const mission = f.store.createMission({ title: "Legacy", outcome: "Keep task", cwd: f.source, ...(native ? { runtimeMode: "agent_deck", provider: "deepseek" } : {}) });
  const legacyPlan = plan(decision("managed")); delete legacyPlan.workspace;
  f.store.savePlan(mission.id, legacyPlan);
  const taskId = f.store.getMission(mission.id).tasks[0].id;
  const result = await f.orchestrator.approve(mission.id);
  assert.equal(result.status, "planning");
  assert.equal(result.executionMode, "auto");
  assert.equal(result.spec.workspacePending, true);
  assert.equal(result.tasks[0].id, taskId);
  assert.equal(result.tasks[0].agentThreadId, null);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].allowMutations, false);
  assert.equal(f.calls[1].outputSchema, workspaceSchema);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
  await assert.rejects(f.orchestrator.approve(mission.id), /not ready/);
  await f.emit(mission, decision("managed"), "assessment-on-approve");
  assert.equal(f.store.getMission(mission.id).status, "ready");
  assert.equal(f.store.getMission(mission.id).tasks[0].agentThreadId, null);
  assert.equal(f.store.getMission(mission.id).events.some(e => e.type === "mission.approved"), false);
  assert.equal(f.calls.length, 2);
  await f.orchestrator.approve(mission.id);
  assert.equal(f.store.getMission(mission.id).tasks[0].status, "running");
  assert.equal(f.store.getMission(mission.id).tasks[0].id, taskId);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
});

for (const state of ["unborn", "missing-decision", "stale-git"]) test(`approve recovers workspace ${state} through read-only assessment`, async t => {
  const f = fixture(t);
  const mission = f.store.createMission({ title: "Plan", outcome: "Keep task", cwd: f.source, executionMode: state === "unborn" ? "code" : "auto" });
  const spec = plan(decision("existing_git"));
  if (state === "missing-decision" || state === "unborn") delete spec.workspace;
  if (state === "unborn") git(f.source, ["init", "-q"]);
  f.store.savePlan(mission.id, spec);
  const result = await f.orchestrator.approve(mission.id);
  assert.equal(result.status, "planning");
  assert.equal(result.tasks[0].agentThreadId, null);
  assert.equal(f.calls[1].allowMutations, false);
  assert.equal(fs.readdirSync(f.worktrees.rootDirectory).length, 0);
  if (state === "unborn") assert.throws(() => git(f.source, ["rev-parse", "--verify", "HEAD"]));
});

test("approve cannot silently migrate a legacy plan with an existing worker", async t => {
  const f = fixture(t);
  const mission = f.store.createMission({ title: "Started", outcome: "Do not migrate", cwd: f.source });
  const spec = plan(decision("managed")); delete spec.workspace;
  f.store.savePlan(mission.id, spec);
  f.store.updateTask(f.store.getMission(mission.id).tasks[0].id, { agentThreadId: "existing-worker" });
  await assert.rejects(f.orchestrator.approve(mission.id), /尚未创建/);
  assert.equal(f.calls.length, 0);
  assert.equal(f.store.getMission(mission.id).executionMode, "code");
});

test("missing model decision cannot silently downgrade isolation", async t => {
  const f = fixture(t);
  const mission = await f.orchestrator.create({ title: "Output", outcome: "Save output", cwd: f.source });
  const invalid = plan(decision("managed")); delete invalid.workspace;
  await f.emit(mission, invalid);
  assert.equal(f.store.getMission(mission.id).status, "planning");
  assert.equal(f.store.getMission(mission.id).spec, null);
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
});

test("invalid workspace reassessment remains recoverable without recreating tasks", async t => {
  const f = fixture(t);
  const mission = f.store.createMission({ title: "Legacy", outcome: "Keep task", cwd: f.source });
  f.store.savePlan(mission.id, plan(decision("managed")));
  const taskId = f.store.getMission(mission.id).tasks[0].id;
  await f.orchestrator.assessWorkspace(mission.id);
  await f.emit(mission, { strategy: "invalid" }, "invalid-assessment");
  await f.orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: f.store.getMission(mission.id).mainThreadId, turn: { id: f.store.getMission(mission.id).activeTurnId, status: "completed" } } });
  assert.equal(f.store.getMission(mission.id).status, "blocked");
  assert.equal(f.store.getMission(mission.id).tasks[0].id, taskId);
  await f.orchestrator.assessWorkspace(mission.id);
  assert.equal(f.store.getMission(mission.id).status, "planning");
  assert.equal(fs.existsSync(path.join(f.source, ".git")), false);
});

test("Codex planning is read-only, has no permission escalation, and stays read-only across resume", async () => {
  const client = new CodexAppServer({ binary: "/unused" });
  client.start = async () => {}; client.resolveModel = async () => "test";
  const calls = [];
  client.request = async (method, params) => { calls.push({ method, params }); if (method === "thread/start") return { thread: { id: "planner" } }; if (method === "turn/start") return { turn: { id: "turn" } }; return {}; };
  await client.createThread({ cwd: "/tmp", allowMutations: false });
  client.loadedThreads.clear();
  await client.sendTurn({ threadId: "planner", cwd: "/tmp", prompt: "Inspect" });
  assert.equal(calls.find(c => c.method === "thread/start").params.sandbox, "read-only");
  assert.equal(calls.find(c => c.method === "thread/resume").params.sandbox, "read-only");
  assert.equal(calls.find(c => c.method === "turn/start").params.sandboxPolicy.type, "readOnly");
  assert.equal(calls.find(c => c.method === "turn/start").params.approvalPolicy, "never");
});

test("restart before workspace thread attachment preserves the plan with an actionable blocker", async t => {
  const f = fixture(t);
  const mission = f.store.createMission({ title: "Legacy", outcome: "Keep task", cwd: f.source });
  f.store.savePlan(mission.id, plan(decision("managed")));
  const previous = f.store.getMission(mission.id);
  f.store.updateMission(mission.id, { status: "planning", spec: { ...previous.spec, workspacePending: true }, mainThreadId: null });
  await f.orchestrator.recover();
  assert.equal(f.store.getMission(mission.id).status, "blocked");
  assert.equal(f.store.getMission(mission.id).tasks[0].id, previous.tasks[0].id);
  assert.equal(f.calls.length, 0);
  await f.orchestrator.assessWorkspace(mission.id);
  assert.equal(f.store.getMission(mission.id).status, "planning");
});
