import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { autoLayoutMission, missionPath, planImpact, validateMissionDag } from "../src/mission-graph.js";

const require = createRequire(import.meta.url);
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator, compactLedgerValue, normalizePlan, parseStructuredText } = require("../desktop/mission-orchestrator.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { ArtifactService, htmlToMarkdown, isWithin, missionReport } = require("../desktop/artifact-service.cjs");
const { PublisherService } = require("../desktop/publisher-service.cjs");
const { decodeGitPath } = require("../desktop/path-utils.cjs");
const { assertStrictOutputSchema } = require("../desktop/structured-output-schema.cjs");
const { missionPlanSchema, mainAgentFollowupSchema, taskResultSchema } = require("../desktop/mission-orchestrator.cjs");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { plannerPerformanceRoute, taskNeedsHtml, workerPerformanceRoute } = require("../desktop/mission-performance.cjs");
const { buildDirectPlan, classifyMissionRequest, fitTaskBudgets, optimizeMissionPlan } = require("../desktop/adaptive-runtime.cjs");

test("all output contracts recursively satisfy strict object requirements", () => {
  for (const schema of [missionPlanSchema, mainAgentFollowupSchema, taskResultSchema]) {
    assert.doesNotThrow(() => assertStrictOutputSchema(schema));
  }
  for (const field of ["valueScore", "estimatedTokenBudget", "valueRationale"]) {
    const broken = structuredClone(missionPlanSchema);
    broken.properties.tasks.items.required = broken.properties.tasks.items.required.filter(key => key !== field);
    assert.throws(() => assertStrictOutputSchema(broken), new RegExp("tasks.items.*missing " + field));
  }
  const followup = structuredClone(mainAgentFollowupSchema);
  delete followup.properties.tasksToCreate.items.required;
  assert.throws(() => assertStrictOutputSchema(followup), /tasksToCreate.items/);
  const nested = structuredClone(taskResultSchema);
  delete nested.properties.acceptance.items.additionalProperties;
  assert.throws(() => assertStrictOutputSchema(nested), /acceptance.items.*additionalProperties/);
});

test("Codex rejects an invalid output contract before starting any provider request", async () => {
  const client = new CodexAppServer({ binary: "/unused-in-test" });
  const calls = [];
  client.resumeThread = async () => { calls.push("resume"); };
  client.request = async (method, params) => { calls.push({ method, params }); return { turn: { id: "validated-turn" } }; };
  const broken = structuredClone(missionPlanSchema);
  broken.properties.tasks.items.required = ["key"];
  await assert.rejects(client.sendTurn({ threadId: "test", prompt: "test", outputSchema: broken }), /valueScore/);
  assert.deepEqual(calls, []);
  const turn = await client.sendTurn({ threadId: "test", prompt: "test", effort: "low", outputSchema: missionPlanSchema });
  assert.equal(turn.id, "validated-turn");
  assert.equal(calls[1].params.outputSchema, missionPlanSchema);
  assert.equal(calls[1].params.effort, "low");
});

test("performance routing lowers routine evidence work without downgrading synthesis", () => {
  const evidence = { key: "SOURCE_RESEARCH", title: "收集官方资料", description: "提取可核验数据", agentRole: "资料研究员", acceptanceCriteria: ["CSV 已生成"] };
  const report = { key: "HTML_REPORT", title: "综合分析并形成报告", description: "交付决策报告", agentRole: "架构师", acceptanceCriteria: ["HTML 可离线阅读"] };
  assert.deepEqual(plannerPerformanceRoute().effort, "medium");
  assert.equal(workerPerformanceRoute(evidence).effort, "low");
  assert.equal(workerPerformanceRoute(evidence).contextTokenBudget, 1800);
  assert.equal(taskNeedsHtml(evidence), false);
  assert.equal(workerPerformanceRoute(report).effort, "medium");
  assert.equal(taskNeedsHtml(report), true);
  assert.equal(workerPerformanceRoute(evidence, { direct: true }).effort, "medium");
  assert.equal(workerPerformanceRoute(evidence, { direct: true }).id, "direct-balanced");
});

test("adaptive routing skips orchestration for coherent code work and escalates complex research", () => {
  const direct = classifyMissionRequest({ title: "Fix date parser", outcome: "Reject numeric strings such as 1.5 and keep existing tests green", executionMode: "code" });
  assert.equal(direct.mode, "direct");
  assert.equal(direct.maxWorkers, 1);
  const mission = classifyMissionRequest({ title: "Architecture benchmark", outcome: "Research and compare multiple runtimes, produce a report and migration roadmap", executionMode: "research" });
  assert.equal(mission.mode, "mission");
  assert.ok(mission.maxTasks >= 4);
  assert.equal(classifyMissionRequest({ title: "Tiny fix", outcome: "Rename one field", orchestrationMode: "mission" }).mode, "mission");
  const constrained = classifyMissionRequest({ title: "Architecture benchmark", outcome: "Research several runtimes", executionMode: "research", valueContract: { tokenBudget: 1000 } });
  assert.equal(constrained.maxTasks, 2);
  assert.equal(constrained.maxWorkers, 2);
});

test("direct plans preserve one context, quality checks, and the total token budget", () => {
  const input = { title: "Fix date parser", outcome: "Reject numeric strings and preserve valid dates", valueContract: { tokenBudget: 12000 } };
  const route = classifyMissionRequest(input);
  const plan = normalizePlan(buildDirectPlan(input, route));
  assert.equal(plan.runtime.mode, "direct");
  assert.equal(plan.tasks.length, 1);
  assert.equal(plan.tasks[0].value.estimatedTokenBudget, 12000);
  assert.match(plan.tasks[0].acceptanceCriteria.join(" "), /boundary|invalid-input/i);
});

test("mission plan optimizer serializes verification behind implementation and enforces budget", () => {
  const normalized = normalizePlan({ ...validPlan, tasks: [
    { key: "IMPLEMENT", title: "Implement parser fix", description: "Change parser code", agentRole: "Engineer", dependencies: [], acceptanceCriteria: ["Patch complete"], estimatedTokenBudget: 9000 },
    { key: "TEST", title: "Test parser", description: "Run validation tests", agentRole: "QA", dependencies: [], acceptanceCriteria: ["Tests pass"], estimatedTokenBudget: 9000 },
    { key: "REVIEW", title: "Review release", description: "Audit final patch", agentRole: "Reviewer", dependencies: [], acceptanceCriteria: ["Review complete"], estimatedTokenBudget: 9000 },
  ] });
  const route = { mode: "mission", tier: "coordinated", score: 3, reasons: ["test"], maxWorkers: 3, maxTasks: 4 };
  const optimized = optimizeMissionPlan(normalized, route, 12000);
  assert.deepEqual(optimized.tasks.find(task => task.key === "TEST").dependencies, ["IMPLEMENT"]);
  assert.deepEqual(optimized.tasks.find(task => task.key === "REVIEW").dependencies, ["IMPLEMENT", "TEST"]);
  assert.ok(optimized.tasks.reduce((sum, task) => sum + task.value.estimatedTokenBudget, 0) <= 12000);
  assert.equal(optimized.runtime.repairedDependencyEdges, 3);
  assert.equal(fitTaskBudgets(normalized.tasks, 12000).length, 3);
});

test("strict preflight handles nullable nested objects and definitions", () => {
  const schema = {
    type: "object", additionalProperties: false, required: ["optional"],
    properties: { optional: { anyOf: [{ type: "null" }, { $ref: "#/$defs/item" }] } },
    $defs: { item: { type: ["object", "null"], additionalProperties: false, required: ["value"], properties: { value: { type: "string" } } } },
  };
  assert.doesNotThrow(() => assertStrictOutputSchema(schema));
  schema.$defs.item.required = [];
  assert.throws(() => assertStrictOutputSchema(schema), /\$defs.item.*missing value/);
});

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-core-"));
  try { return callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function withTempDirAsync(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-core-"));
  try { return await callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const validPlan = {
  title: "Real mission", outcome: "Ship verified code", scope: ["Core"], nonGoals: ["Cloud"], constraints: ["Local"], acceptanceCriteria: ["Tests pass"],
  tasks: [
    { key: "TASK-01", title: "Build core", description: "Implement it", agentRole: "Core", dependencies: [], acceptanceCriteria: ["Unit tests pass"] },
    { key: "TASK-02", title: "Review core", description: "Review it", agentRole: "Reviewer", dependencies: ["TASK-01"], acceptanceCriteria: ["Review recorded"] },
  ],
};

test("research mode runs in managed storage from a non-Git source and preserves review/dependency gates", async () => withTempDirAsync(async directory => {
  const source = path.join(directory, "ordinary-source");
  fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, "reference.txt"), "Do not modify me");
  const db = path.join(directory, "research.sqlite3");
  const store = new MissionStore(db);
  const manager = new WorktreeManager(path.join(directory, "managed"));
  const calls = [];
  let sequence = 0;
  const codex = {
    async createThread(input) { calls.push(input); return { thread: { id: `research-thread-${++sequence}` } }; },
    async sendTurn(input) { calls.push(input); return { id: `research-turn-${++sequence}` }; },
  };
  const orchestrator = new MissionOrchestrator({ store, worktrees: manager, codex });
  const requirement = store.createRequirement({ title: "Research", outcome: "Report", workspacePath: source, executionMode: "research" });
  const { mission } = await orchestrator.claimNextRequirement({ requirementId: requirement.id });
  assert.equal(mission.executionMode, "research");
  assert.equal(mission.cwd, source);
  assert.notEqual(mission.executionCwd, source);
  assert.equal(store.listSessionRefs(source)[0].cwd, mission.executionCwd);
  assert.ok(calls.every(call => call.cwd !== source));
  assert.match(calls[1].prompt, /RESEARCH AND DOCUMENTS MODE/);
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: mission.mainThreadId, item: { id: "research-plan", type: "agentMessage", phase: "final_answer", text: JSON.stringify(validPlan) } } });
  assert.equal(store.getMission(mission.id).status, "ready");
  assert.ok(store.getMission(mission.id).tasks.every(task => !task.agentThreadId));
  await orchestrator.approve(mission.id);
  for (const key of ["TASK-01", "TASK-02"]) {
    const task = store.getMission(mission.id).tasks.find(task => task.key === key);
    assert.equal(task.status, "running");
    if (key === "TASK-02") assert.ok(fs.existsSync(path.join(task.worktreePath, "TASK-01.html")));
    fs.writeFileSync(path.join(task.worktreePath, `${key}.html`), `<!doctype html><title>${key}</title><main>Reviewed research output</main>`);
    const result = { summary: "Research done", acceptance: [{ criterion: "Reviewed", passed: true, evidence: `${key}.html` }], changedFiles: [`${key}.html`], blockers: [] };
    await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: task.agentThreadId, item: { id: `result-${key}`, type: "agentMessage", phase: "final_answer", text: JSON.stringify(result) } } });
    await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: task.agentThreadId, turn: { id: task.activeTurnId, status: "completed" } } });
    assert.equal(store.getTask(task.id).status, "review");
    if (key === "TASK-01") assert.equal(store.getMission(mission.id).tasks[1].status, "queued");
    const artifact = store.getMission(mission.id).artifacts.find(item => item.taskId === task.id && item.files.includes(`${key}.html`));
    assert.ok(artifact, "real file evidence is registered");
    const artifactService = new ArtifactService({ store, downloadsPath: directory, shell: {}, dialog: {} });
    assert.match(artifactService.preview({ missionId: mission.id, artifactId: artifact.id, file: `${key}.html` }).content, /Reviewed research output/);
    await orchestrator.acceptTask(mission.id, task.id);
  }
  assert.equal(store.getMission(mission.id).status, "ready_to_integrate");
  const completed = await orchestrator.integrate(mission.id);
  assert.equal(completed.status, "completed");
  assert.ok(fs.existsSync(path.join(completed.integrationPath, "TASK-01.html")));
  assert.ok(fs.existsSync(path.join(completed.integrationPath, "TASK-02.html")));
  assert.deepEqual(fs.readdirSync(source), ["reference.txt"]);
  assert.equal(fs.readFileSync(path.join(source, "reference.txt"), "utf8"), "Do not modify me");
  assert.throws(() => orchestrator.changeWorkspace(mission.id, source, "code"), /尚未创建任何 Worker/);
  store.close();
  const reopened = new MissionStore(db);
  assert.equal(reopened.getMission(mission.id).executionMode, "research");
  assert.equal(reopened.getMission(mission.id).executionCwd, mission.executionCwd);
  reopened.close();
}));

test("blocked legacy mission switches to research without starting workers or changing source", () => withTempDir(directory => {
  const store = new MissionStore(path.join(directory, "switch.sqlite3"));
  const manager = new WorktreeManager(path.join(directory, "managed"));
  const mission = store.createMission({ title: "Legacy", outcome: "Research", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  store.updateMission(mission.id, { status: "blocked", mainThreadId: "original-planner" });
  store.updateTask(store.getMission(mission.id).tasks[0].id, { status: "blocked", error: "not_git_repository" });
  const orchestrator = new MissionOrchestrator({ store, worktrees: manager, codex: {} });
  const changed = orchestrator.changeWorkspace(mission.id, directory, "research");
  assert.equal(changed.status, "ready");
  assert.equal(changed.mainThreadId, "original-planner");
  assert.equal(changed.executionMode, "research");
  assert.deepEqual(changed.spec.tasks, normalizePlan(validPlan).tasks);
  assert.ok(changed.tasks.every(task => task.status === "queued" && !task.error && !task.agentThreadId));
  assert.deepEqual(fs.readdirSync(manager.rootDirectory), []);
  assert.equal(fs.existsSync(path.join(directory, ".git")), false);
  assert.throws(() => orchestrator.changeWorkspace(mission.id, directory, "code"), /not_git_repository/);
  assert.throws(() => orchestrator.changeWorkspace(mission.id, directory, "unsafe"), /Invalid execution mode/);
  store.close();
}));

test("research bootstrap refuses path traversal, symlink and unowned content", () => withTempDir(directory => {
  const manager = new WorktreeManager(path.join(directory, "managed"));
  const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  assert.throws(() => manager.prepareResearch("../escape"), /identity/);
  fs.symlinkSync(directory, path.join(manager.rootDirectory, `research-${id}`));
  assert.throws(() => manager.prepareResearch(id), /symlink/);
  const other = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  fs.mkdirSync(path.join(manager.rootDirectory, `research-${other}`));
  fs.writeFileSync(path.join(manager.rootDirectory, `research-${other}`, "personal.txt"), "keep");
  assert.throws(() => manager.prepareResearch(other), /unowned/);
}));

test("workspace inspection separates non-repository, missing directory, and unborn HEAD without mutations", () => withTempDir(directory => {
  const manager = new WorktreeManager(path.join(directory, "worktrees"));
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  assert.equal(manager.inspect(repository).code, "not_git_repository");
  assert.equal(manager.inspect(path.join(directory, "missing")).code, "workspace_missing");
  assert.throws(() => manager.create({ cwd: repository, missionId: "preflight", taskKey: "one" }), /not_git_repository/);
  assert.equal(fs.existsSync(path.join(repository, ".git")), false);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  assert.equal(manager.inspect(repository).code, "missing_git_head");
  execFileSync("/usr/bin/git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "baseline"], { cwd: repository });
  assert.equal(manager.assertReady(repository).available, true);
}));

test("approval and retry reject an invalid workspace before changing state or creating workers", async () => withTempDirAsync(async directory => {
  const store = new MissionStore(path.join(directory, "preflight.sqlite3"));
  const worktrees = new WorktreeManager(path.join(directory, "worktrees"));
  let threads = 0;
  const orchestrator = new MissionOrchestrator({ store, worktrees, codex: { createThread() { threads++; throw new Error("must not dispatch"); } } });
  const mission = store.createMission({ title: "Preflight", outcome: "Keep the plan", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  await assert.rejects(orchestrator.approve(mission.id), /not_git_repository/);
  let current = store.getMission(mission.id);
  assert.equal(current.status, "ready");
  assert.ok(current.tasks.every(task => task.status === "queued" && !task.agentThreadId));
  assert.ok(!current.events.some(event => event.type === "mission.approved"));
  const task = current.tasks[0];
  store.updateTask(task.id, { status: "blocked", error: "original workspace failure" });
  store.updateMission(mission.id, { status: "blocked" });
  await assert.rejects(orchestrator.retryTask(mission.id, task.id), /not_git_repository/);
  current = store.getMission(mission.id);
  assert.equal(current.status, "blocked");
  assert.equal(current.tasks[0].error, "original workspace failure");
  assert.equal(threads, 0);
  assert.deepEqual(fs.readdirSync(worktrees.rootDirectory), []);
  store.close();
}));

test("unstarted workspace recovery preserves plan and thread but requires fresh approval", () => withTempDir(directory => {
  const store = new MissionStore(path.join(directory, "rebind.sqlite3"));
  const manager = new WorktreeManager(path.join(directory, "worktrees"));
  const repository = path.join(directory, "project");
  fs.mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  execFileSync("/usr/bin/git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-qm", "baseline"], { cwd: repository });
  const mission = store.createMission({ title: "Rebind", outcome: "Real plan", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  store.updateMission(mission.id, { mainThreadId: "preserved-planner", status: "blocked" });
  const task = store.getMission(mission.id).tasks[0];
  store.updateTask(task.id, { status: "blocked", error: "Worktree isolation unavailable" });
  const orchestrator = new MissionOrchestrator({ store, worktrees: manager, codex: {} });
  assert.throws(() => orchestrator.changeWorkspace(mission.id, directory), /not_git_repository/);
  const updated = orchestrator.changeWorkspace(mission.id, repository);
  assert.equal(updated.cwd, repository);
  assert.equal(updated.mainThreadId, "preserved-planner");
  assert.equal(updated.spec.title, validPlan.title);
  assert.equal(updated.status, "ready");
  assert.ok(updated.tasks.every(task => task.status === "queued" && !task.error && !task.agentThreadId && !task.worktreePath));
  assert.equal(updated.events[0].type, "mission.workspace.changed");
  assert.deepEqual(fs.readdirSync(manager.rootDirectory), []);
  store.updateTask(task.id, { agentThreadId: "existing-worker", status: "blocked" });
  assert.throws(() => orchestrator.changeWorkspace(mission.id, repository), /尚未创建任何 Worker/);
  store.close();
}));

test("mission store persists structured missions, tasks, events, and messages", () => withTempDir((directory) => {
  const databasePath = path.join(directory, "agent-deck.sqlite3");
  const store = new MissionStore(databasePath);
  const mission = store.createMission({ title: "Bob's mission", outcome: "Real result", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "thread-real" });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const snapshot = store.getMission(mission.id);
  assert.equal(snapshot.title, "Real mission");
  assert.equal(snapshot.status, "ready");
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.events[0].type, "mission.plan.ready");
  assert.equal(store.claimTask(snapshot.tasks[0].id), true);
  assert.equal(store.claimTask(snapshot.tasks[0].id), false);
  store.addMessage({ missionId: mission.id, fromAgent: "Main", toAgent: "Core", topic: "task.assigned", text: "Do real work" });
  assert.equal(store.getMission(mission.id).messages[0].text, "Do real work");
  assert.ok(fs.statSync(databasePath).size > 0);
}));

test("Value Ledger persists a value contract, local token-cost estimate, and user-confirmed value evidence", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "value-ledger.sqlite3"));
  const mission = store.createMission({
    title: "High value delivery", outcome: "Ship verified work", cwd: directory,
    valueContract: { scenario: "研发交付", valueType: "time_saved", baselineHours: 4, humanHourlyRateCny: 300, tokenBudget: 12000, tokenCostPer1kCny: 0.05, targetMetric: "PR merged" },
  });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const task = store.getMission(mission.id).tasks[0];
  store.updateTask(task.id, { result: { summary: "Implemented and tested", acceptance: [], changedFiles: ["src/app.ts"], blockers: [] } });
  store.addMessage({ missionId: mission.id, fromAgent: "Core", toAgent: "Main Agent", topic: "handoff", text: "Verified output is ready." });
  store.appendEvent(mission.id, "context.capsule.created", { estimatedTokens: 1400 });
  store.recordValue(mission.id, { eventType: "confirmed_value", amountCny: 1800, note: "PR merged and the owner confirmed the avoided implementation work." });
  const ledger = store.valueLedger(mission.id);
  assert.equal(ledger.contract.scenario, "研发交付");
  assert.equal(ledger.value.confirmedValueCny, 1800);
  assert.ok(ledger.costs.estimatedTokens >= 1400);
  assert.ok(ledger.costs.totalCostCny > 0);
  assert.ok(ledger.value.realizedRoi > 0);
  assert.equal(ledger.valueEvents.length, 1);
}));

test("Value Ledger uses the latest provider token update once per turn", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "provider-token-ledger.sqlite3"));
  const mission = store.createMission({ title: "Measured", outcome: "Use provider truth", cwd: directory, valueContract: { tokenBudget: 50000 } });
  store.appendEvent(mission.id, "provider.thread/tokenUsage/updated", { threadId: "worker-1", turnId: "turn-1", tokenUsage: { last: { totalTokens: 100, inputTokens: 80, cachedInputTokens: 20, outputTokens: 20, reasoningOutputTokens: 5 } } }, { threadId: "worker-1" });
  store.appendEvent(mission.id, "provider.thread/tokenUsage/updated", { threadId: "worker-1", turnId: "turn-1", tokenUsage: { last: { totalTokens: 140, inputTokens: 100, cachedInputTokens: 30, outputTokens: 40, reasoningOutputTokens: 10 } } }, { threadId: "worker-1" });
  store.appendEvent(mission.id, "provider.thread/tokenUsage/updated", { threadId: "worker-1", turnId: "turn-2", tokenUsage: { last: { totalTokens: 60, inputTokens: 50, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 2 } } }, { threadId: "worker-1" });
  const ledger = store.valueLedger(mission.id);
  assert.equal(ledger.costs.tokenSource, "provider_reported");
  assert.equal(ledger.costs.observedTokens, 200);
  assert.deepEqual(ledger.costs.providerUsage, { totalTokens: 200, inputTokens: 150, cachedInputTokens: 70, outputTokens: 50, reasoningOutputTokens: 12 });
  assert.equal(ledger.costs.tokenBudgetRemaining, 49800);
}));

test("requirement inbox persists a canonical requirement and follows linked Mission state", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "requirements.sqlite3"));
  const requirement = store.createRequirement({ title: "Improve planner", outcome: "A verified planner experience", body: "Add a real inbox and approval flow.", workspacePath: directory, priority: "high", status: "ready_to_plan", labels: ["product", "agent"], acceptanceCriteria: ["A requirement can create a Mission"], valueContract: { scenario: "研发交付", expectedValueCny: 1200, baselineHours: 4, tokenBudget: 16000 } });
  assert.equal(store.listRequirements()[0].id, requirement.id);
  assert.equal(requirement.valueContract.expectedValueCny, 1200);
  assert.equal(requirement.valueContract.tokenBudget, 16000);
  const claimed = store.claimNextRequirement(directory);
  assert.equal(claimed.status, "planning");
  const mission = store.createMission({ title: requirement.title, outcome: requirement.outcome, cwd: directory });
  store.updateRequirement(requirement.id, { missionId: mission.id });
  store.updateMission(mission.id, { status: "ready" });
  const synced = store.syncRequirementForMission(mission.id, "ready");
  assert.equal(synced.status, "awaiting_approval");
  assert.equal(synced.missionId, mission.id);
}));

test("requirement inbox accepts a lightweight request without separate background text", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "lightweight-requirement.sqlite3"));
  const requirement = store.createRequirement({ title: "Make planning clearer", outcome: "A newcomer can create a plan", workspacePath: directory, status: "ready_to_plan" });
  assert.equal(requirement.body, "需求：Make planning clearer");
  assert.equal(requirement.status, "ready_to_plan");
}));

test("Context Kernel builds a budgeted, traceable brief from real Mission ledger records", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "context-kernel.sqlite3"));
  const mission = store.createMission({ title: "Context quality", outcome: "Reuse only relevant verified evidence", sourcePrompt: "Ship a handler migration with an HTML report.", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const [build, review] = store.getMission(mission.id).tasks;
  store.updateTask(build.id, { result: { summary: "Handler migration verified", acceptance: [{ criterion: "Unit tests pass", passed: true, evidence: "npm test" }], blockers: [] }, evidence: ["src/handler.ts", "npm test"] });
  store.addArtifact({ missionId: mission.id, taskId: build.id, title: "Handler migration report", summary: "Verified handler migration and rollout evidence.", files: ["reports/handler-migration.html", "src/handler.ts"], verificationStatus: "user_verified" });
  store.addMessage({ missionId: mission.id, fromAgent: "Core", toAgent: "Reviewer", topic: "handoff", text: "The handler migration is ready for review with npm test evidence.", source: "agent-deck" });
  const search = store.trajectorySearch({ missionId: mission.id, query: "handler migration", limit: 12 });
  assert.ok(search.items.some((item) => item.kind === "artifact" && item.ref.startsWith("artifact:")));
  assert.ok(search.items.some((item) => item.filePath === "reports/handler-migration.html"));
  const brief = store.contextBrief({ missionId: mission.id, taskId: review.id, tokenBudget: 1800 });
  assert.equal(brief.task.key, "TASK-02");
  assert.ok(brief.dependencyCheckpoints.some((item) => item.ref === `task:${build.id}`));
  assert.ok(brief.evidence.some((item) => item.ref.startsWith("artifact:") || item.ref.startsWith("file:")));
  assert.ok(brief.stats.baselineEstimatedTokens >= brief.stats.estimatedTokens);
  assert.match(brief.runtimePrompt, /CONTEXT KERNEL/);
}));

test("V0.3 persists agents, run history, canvas layout, viewport, and panel sizes", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "v03.sqlite3"));
  const mission = store.createMission({ title: "V0.3", outcome: "Durable orchestration", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "planner-thread" });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const task = store.getMission(mission.id).tasks[0];
  const run = store.startRun({ missionId: mission.id, taskId: task.id, agentId: `${mission.id}:${task.key}`, threadId: "worker-thread", turnId: "turn-1", phase: "working", triggerType: "test" });
  assert.equal(run.attempt, 1);
  assert.equal(store.startRun({ missionId: mission.id, taskId: task.id, agentId: `${mission.id}:${task.key}`, threadId: "worker-thread", turnId: "turn-1" }).id, run.id);
  store.completeRun("worker-thread", "turn-1", { status: "completed" });
  store.saveUiState(mission.id, { layout: { mode: "vertical", positions: { main: { x: 41, y: 17 }, [task.key]: { x: 320, y: 210 } } }, viewport: { x: 12, y: 8, zoom: 1.25 }, panels: { sidebarWidth: 318, inspectorWidth: 472 } });
  const snapshot = store.getMission(mission.id);
  assert.equal(snapshot.agents.length, 3);
  assert.equal(snapshot.tasks[0].agentId, `${mission.id}:TASK-01`);
  assert.equal(snapshot.runs[0].status, "completed");
  assert.ok(snapshot.runs[0].endedAt);
  assert.deepEqual(snapshot.uiState.layout.positions["TASK-01"], { x: 320, y: 210 });
  assert.equal(snapshot.uiState.viewport.zoom, 1.25);
  assert.equal(snapshot.uiState.panels.inspectorWidth, 472);
  assert.throws(() => store.updateMission(mission.id, { status: "mystery" }), /Unknown Mission state/);
  assert.throws(() => store.updateTask(task.id, { status: "mystery" }), /Unknown Task state/);
}));

test("V0.3 plan editing preserves stable task identities and rejects rewrites after dispatch", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "plan-edit.sqlite3"));
  const mission = store.createMission({ title: "Edit", outcome: "Safe plan", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const before = store.getMission(mission.id);
  const edited = normalizePlan({ ...validPlan, tasks: [{ ...validPlan.tasks[0], title: "Build durable core" }, { key: "TASK-03", title: "Ship UI", description: "Implement UI", agentRole: "Frontend", dependencies: ["TASK-01"], acceptanceCriteria: ["UI passes"] }] });
  const after = store.updatePlan(mission.id, edited);
  assert.equal(after.tasks.find((task) => task.key === "TASK-01").id, before.tasks.find((task) => task.key === "TASK-01").id);
  assert.equal(after.tasks.some((task) => task.key === "TASK-02"), false);
  assert.equal(after.tasks.some((task) => task.key === "TASK-03"), true);
  store.updateMission(mission.id, { status: "running" });
  assert.throws(() => store.updatePlan(mission.id, edited), /only be edited before worker dispatch/);
}));

test("V0.3 graph algorithms lay out, trace, validate, and diff dependency plans", () => {
  const layout = autoLayoutMission(validPlan.tasks, "horizontal");
  assert.ok(layout["TASK-02"].x > layout["TASK-01"].x);
  assert.equal(validateMissionDag(validPlan.tasks).valid, true);
  const cyclic = structuredClone(validPlan.tasks);
  cyclic[0].dependencies = ["TASK-02"];
  assert.equal(validateMissionDag(cyclic).valid, false);
  const path = missionPath(validPlan.tasks, "TASK-01");
  assert.equal(path.nodes.has("TASK-02"), true);
  assert.equal(path.edges.has("TASK-01->TASK-02"), true);
  const impact = planImpact(validPlan.tasks, [...validPlan.tasks, { key: "TASK-03", title: "New", description: "New", agentRole: "New", dependencies: [], acceptanceCriteria: ["Done"] }]);
  assert.deepEqual(impact.added, ["TASK-03"]);
});

test("mission store reads event snapshots larger than the child-process default buffer", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "large-ledger.sqlite3"));
  const mission = store.createMission({ title: "Large ledger", outcome: "Preserve output", cwd: directory });
  const output = "x".repeat(1_250_000);
  store.appendEvent(mission.id, "provider.item/completed", { item: { type: "commandExecution", aggregatedOutput: output } });
  assert.equal(store.getMission(mission.id).events[0].payload.item.aggregatedOutput.length, output.length);
}));

test("mission summaries stay lightweight while detail and event paging remain available", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "summary.sqlite3"));
  const mission = store.createMission({ title: "Summary", outcome: "Fast list", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  for (let index = 0; index < 140; index += 1) store.appendEvent(mission.id, "provider.item/completed", { index, output: "x".repeat(2000) });
  const summaries = store.listMissions();
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].counts.tasks, 2);
  assert.equal("tasks" in summaries[0], false);
  assert.ok(JSON.stringify(summaries).length < 5000);
  const detail = store.getMission(mission.id, { eventLimit: 25 });
  assert.equal(detail.events.length, 25);
  assert.equal(detail.hasMoreEvents, true);
  const next = store.listEvents(mission.id, { limit: 20, beforeSeq: detail.events.at(-1).seq });
  assert.equal(next.items.length, 20);
  assert.ok(next.items[0].seq < detail.events.at(-1).seq);
}));

test("attention projection returns real cross-mission decisions without loading full ledgers", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "attention.sqlite3"));
  const planMission = store.createMission({ title: "Plan review", outcome: "Approve a plan", cwd: directory });
  store.savePlan(planMission.id, normalizePlan(validPlan));

  const reviewMission = store.createMission({ title: "Worker review", outcome: "Review evidence", cwd: directory });
  store.savePlan(reviewMission.id, normalizePlan(validPlan));
  const [reviewTask, blockedTask] = store.getMission(reviewMission.id).tasks;
  store.updateMission(reviewMission.id, { status: "review" });
  store.updateTask(reviewTask.id, { status: "review", phase: "review", result: { summary: "Implemented and verified", acceptance: [{ criterion: "Unit tests pass", passed: true, evidence: "npm test" }], changedFiles: [], blockers: [] } });
  store.updateTask(blockedTask.id, { status: "blocked", phase: "blocked", error: "Missing a required local toolchain" });

  const items = store.listAttentionItems();
  assert.deepEqual(new Set(items.map((item) => item.type)), new Set(["plan_review", "worker_review", "worker_blocked"]));
  assert.equal(items[0].type, "worker_blocked");
  assert.equal(items[0].prioritySource, "derived");
  assert.equal(items[0].priority, 92);
  assert.equal(items[0].impact, 0);
  assert.ok(items[0].whyNow.includes("Worker 已停止，无法自行推进"));
  assert.match(items.find((item) => item.type === "worker_review").reason, /Implemented and verified/);
  assert.match(items.find((item) => item.type === "worker_blocked").reason, /toolchain/);
  assert.equal("events" in items[0], false);
  assert.ok(JSON.stringify(items).length < 7000);
}));

test("attention deferral and briefing are persisted from the real local ledger", () => withTempDir((directory) => {
  const store = new MissionStore(path.join(directory, "attention-state.sqlite3"));
  const mission = store.createMission({ title: "Decision state", outcome: "Keep focus", cwd: directory });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const [first, second] = store.getMission(mission.id).tasks;
  store.updateTask(first.id, { status: "blocked", phase: "blocked", error: "Need a local decision" });
  store.updateTask(second.id, { status: "completed", phase: "verified", result: { summary: "Verified" } });
  const before = store.listAttentionItems();
  const blocker = before.find((item) => item.type === "worker_blocked");
  assert.equal(blocker.impact, 1);
  assert.equal(blocker.priority, 97);
  const deferred = store.deferAttention(blocker.id, 60);
  assert.ok(deferred.deferredUntil > new Date().toISOString());
  assert.equal(store.listAttentionItems().some((item) => item.id === blocker.id), false);
  assert.equal(store.listAttentionItems({ includeDeferred: true }).find((item) => item.id === blocker.id).deferredUntil, deferred.deferredUntil);
  const briefing = store.listAttentionBriefing();
  assert.equal(briefing.source, "local-ledger");
  assert.equal(briefing.totals.deferred, 1);
  assert.equal(briefing.totals.verifiedLastDay, 1);
  assert.ok(briefing.recentMissions.some((item) => item.id === mission.id));
}));

test("mission session projection includes real planner and worker threads across worktrees", () => withTempDir((directory) => {
  const otherWorkspace = path.join(directory, "other");
  fs.mkdirSync(otherWorkspace);
  const store = new MissionStore(path.join(directory, "sessions.sqlite3"));
  const mission = store.createMission({ title: "Session projection", outcome: "Show every agent", cwd: directory, model: "codex-model" });
  store.updateMission(mission.id, { mainThreadId: "planner-thread", activeTurnId: "planner-turn" });
  store.savePlan(mission.id, normalizePlan(validPlan));
  const [first, second] = store.getMission(mission.id).tasks;
  store.updateTask(first.id, { agentThreadId: "worker-thread", activeTurnId: "worker-turn", worktreePath: path.join(directory, ".worktrees", "one"), branch: "agentdeck/one", status: "running", phase: "working" });
  store.updateTask(second.id, { worktreePath: path.join(directory, ".worktrees", "two"), branch: "agentdeck/two" });
  const unrelated = store.createMission({ title: "Other", outcome: "Stay isolated", cwd: otherWorkspace });
  store.updateMission(unrelated.id, { mainThreadId: "other-planner" });

  const refs = store.listSessionRefs(directory);
  assert.deepEqual(refs.map((item) => item.threadId).sort(), ["planner-thread", "worker-thread"]);
  assert.equal(refs.find((item) => item.role === "planner").missionTitle, "Real mission");
  assert.equal(refs.find((item) => item.role === "worker").cwd, path.join(directory, ".worktrees", "one"));
  assert.equal(refs.find((item) => item.role === "worker").taskKey, "TASK-01");
  assert.equal(JSON.stringify(refs).includes("other-planner"), false);
}));

test("artifact service opens and exports only files inside the authorized mission roots", async () => withTempDirAsync(async (directory) => {
  const workspace = path.join(directory, "workspace");
  const destination = path.join(directory, "exported.txt");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "result.txt"), "real artifact\n");
  fs.writeFileSync(path.join(workspace, "report.html"), '<!doctype html><html><head><title>Report</title><meta http-equiv="refresh" content="0;url=https://example.com"></head><body><main>Rich report</main><script>alert("unsafe")</script></body></html>');
  const store = new MissionStore(path.join(directory, "artifacts.sqlite3"));
  const mission = store.createMission({ title: "Artifact mission", outcome: "Export evidence", cwd: workspace });
  const artifact = store.addArtifact({ missionId: mission.id, title: "Result", summary: "Verified output", files: ["result.txt", "report.html"], verificationStatus: "worker_verified", qualityScore: 91, reportQuality: [{ file: "report.html", score: 91, passing: true }] });
  assert.equal(store.getArtifact(artifact.id).qualityScore, 91);
  assert.equal(store.getArtifact(artifact.id).reportQuality[0].passing, true);
  const opened = [];
  const service = new ArtifactService({
    store,
    downloadsPath: directory,
    dialog: { async showSaveDialog() { return { canceled: false, filePath: destination }; } },
    shell: { async openPath(file) { opened.push(file); return ""; }, showItemInFolder(file) { opened.push(file); } },
  });
  const inspected = service.inspect({ missionId: mission.id, artifactId: artifact.id });
  assert.equal(inspected.resolvedFiles[0].exists, true);
  assert.equal(inspected.resolvedFiles[0].size, 14);
  assert.equal(inspected.resolvedFiles[0].previewable, false);
  assert.equal(inspected.resolvedFiles[1].previewable, true);
  const preview = service.preview({ missionId: mission.id, artifactId: artifact.id, file: "report.html" });
  assert.equal(preview.mimeType, "text/html");
  assert.match(preview.content, /Content-Security-Policy/);
  assert.match(preview.content, /Rich report/);
  assert.doesNotMatch(preview.content, /alert\("unsafe"\)|http-equiv="refresh"/i);
  await service.open({ missionId: mission.id, artifactId: artifact.id, file: "result.txt" });
  assert.equal(opened[0], fs.realpathSync(path.join(workspace, "result.txt")));
  const exported = await service.export({ missionId: mission.id, artifactId: artifact.id, file: "result.txt" });
  assert.equal(exported.destination, destination);
  assert.equal(fs.readFileSync(destination, "utf8"), "real artifact\n");
  const outside = path.join(directory, "outside.txt");
  fs.writeFileSync(outside, "private\n");
  const unsafe = store.addArtifact({ missionId: mission.id, title: "Unsafe", summary: "", files: [outside] });
  assert.throws(() => service.inspect({ missionId: mission.id, artifactId: unsafe.id }), /outside the authorized mission workspace/);
  assert.equal(isWithin(workspace, outside), false);
  const report = missionReport(store.getMission(mission.id));
  assert.match(report, /<!doctype html>/i);
  assert.match(report, /<h1>Artifact mission<\/h1>/);
  assert.match(report, /agent-deck-report\/v1/);
}));

test("publication adapter converts a self-contained HTML artifact into a paste-ready community draft", () => withTempDir((directory) => {
  const workspace = path.join(directory, "workspace");
  const copied = [];
  const opened = [];
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "report.html"), `<!doctype html><html><head><style>.card{color:red}</style></head><body><main><h1>Research report</h1><p>One <strong>verified</strong> finding.</p><table><tr><th>Model</th><th>Score</th></tr><tr><td>Alpha</td><td>91</td></tr></table><pre><code class="language-js">console.log('proof')</code></pre><script>alert('no')</script></main></body></html>`);
  const store = new MissionStore(path.join(directory, "publication.sqlite3"));
  const mission = store.createMission({ title: "Publish", outcome: "A readable post", cwd: workspace });
  const artifact = store.addArtifact({ missionId: mission.id, title: "Research report", summary: "", files: ["report.html"] });
  const service = new ArtifactService({ store, downloadsPath: directory, dialog: {}, shell: { async openExternal(url) { opened.push(url); } }, clipboard: { writeText(value) { copied.push(value); } } });
  const draft = service.publication({ missionId: mission.id, artifactId: artifact.id, file: "report.html", platform: "juejin" });
  assert.match(draft.content, /^# Research report/m);
  assert.match(draft.content, /\*\*verified\*\*/);
  assert.match(draft.content, /\| Model \| Score \|/);
  assert.match(draft.content, /```js/);
  assert.doesNotMatch(draft.content, /alert\(|color:red/);
  assert.equal(service.copyPublication({ missionId: mission.id, artifactId: artifact.id, file: "report.html", platform: "csdn" }).copied, true);
  assert.match(copied[0], /Research report/);
  service.openPublisher({ missionId: mission.id, artifactId: artifact.id, file: "report.html", platform: "juejin" });
  assert.equal(opened[0], "https://juejin.cn/editor/drafts/new");
  assert.match(htmlToMarkdown("<h2>Section</h2><p>Text</p>"), /## Section/);
}));

test("publisher service uses an isolated persistent platform session and only requests publishing on explicit opt-in", async () => {
  const windows = [];
  class FakeWindow {
    constructor(options) { this.options = options; this.webContents = { on() {}, executeJavaScript: async (script) => { this.script = script; return { ok: true, state: script.includes('"autoPublish":true') ? "publish_requested" : "staged" }; } }; windows.push(this); }
    on() {} isDestroyed() { return false; } async loadURL(url) { this.url = url; } show() {} focus() {}
  }
  const service = new PublisherService({ BrowserWindow: FakeWindow, parentWindow: () => null });
  await service.connect("juejin");
  assert.equal(windows[0].options.webPreferences.partition, "persist:agent-deck-publisher-juejin");
  assert.equal(windows[0].url, "https://juejin.cn/editor/drafts/new");
  const staged = await service.publish({ platform: "juejin", title: "A post", content: "# Body" });
  assert.equal(staged.state, "staged");
  const published = await service.publish({ platform: "juejin", title: "A post", content: "# Body", autoPublish: true });
  assert.equal(published.state, "publish_requested");
  assert.match(windows[0].script, /A post/);
});

test("provider ledger compaction preserves real output head and tail with an omission marker", () => {
  const output = `HEAD-${"x".repeat(90_000)}-TAIL`;
  const compacted = compactLedgerValue({ item: { aggregatedOutput: output } });
  assert.match(compacted.item.aggregatedOutput, /^HEAD-/);
  assert.match(compacted.item.aggregatedOutput, /Agent Deck omitted/);
  assert.match(compacted.item.aggregatedOutput, /-TAIL$/);
  assert.ok(compacted.item.aggregatedOutput.length < 33_000);
});

test("structured plan parser accepts fenced JSON and rejects dependency cycles", () => {
  assert.equal(parseStructuredText(`\`\`\`json\n${JSON.stringify(validPlan)}\n\`\`\``).title, "Real mission");
  const cyclic = structuredClone(validPlan);
  cyclic.tasks[0].dependencies = ["TASK-02"];
  assert.throws(() => normalizePlan(cyclic), /dependency cycle/);
});

test("Git-quoted UTF-8 artifact paths are decoded into clickable filesystem paths", () => {
  assert.equal(decodeGitPath('"docs/\\351\\234\\200\\346\\261\\202.md"'), "docs/需求.md");
  assert.equal(decodeGitPath("docs/plain.md"), "docs/plain.md");
});

test("worktree manager creates a real isolated Git worktree", () => withTempDir((directory) => {
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  execFileSync("/usr/bin/git", ["config", "user.email", "agent-deck@test.invalid"], { cwd: repository });
  execFileSync("/usr/bin/git", ["config", "user.name", "Agent Deck Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "README.md"), "real baseline\n");
  execFileSync("/usr/bin/git", ["add", "README.md"], { cwd: repository });
  execFileSync("/usr/bin/git", ["commit", "-q", "-m", "baseline"], { cwd: repository });
  const manager = new WorktreeManager(path.join(directory, "worktrees"));
  const result = manager.create({ cwd: repository, missionId: "mission-123456789", taskKey: "TASK-01" });
  assert.equal(fs.readFileSync(path.join(result.path, "README.md"), "utf8"), "real baseline\n");
  assert.match(result.branch, /^agentdeck\//);
  assert.equal(manager.inspect(result.path).available, true);
  fs.writeFileSync(path.join(result.path, "real.txt"), "real change\n");
  fs.writeFileSync(path.join(result.path, "需求说明.md"), "真实文件\n");
  assert.ok(manager.evidence(result.path).files.includes("需求说明.md"));
  const committed = manager.commit(result.path, "TASK-01: real change");
  assert.match(committed.commitHash, /^[a-f0-9]{40}$/);
  assert.equal(manager.evidence(result.path).clean, true);
}));

test("worktree manager preserves a real merge conflict and tracks every dependency still missing from HEAD", () => withTempDir((directory) => {
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  execFileSync("/usr/bin/git", ["config", "user.email", "agent-deck@test.invalid"], { cwd: repository });
  execFileSync("/usr/bin/git", ["config", "user.name", "Agent Deck Test"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "shared.tsv"), "header\nbase\n");
  execFileSync("/usr/bin/git", ["add", "."], { cwd: repository });
  execFileSync("/usr/bin/git", ["commit", "-q", "-m", "baseline"], { cwd: repository });
  const baseBranch = execFileSync("/usr/bin/git", ["branch", "--show-current"], { cwd: repository, encoding: "utf8" }).trim();
  for (const [branch, content, file = "shared.tsv"] of [["dep-a", "header\nbase\na\n"], ["dep-b", "header\nbase\nb\n"], ["dep-c", "independent\n", "other.txt"]]) {
    execFileSync("/usr/bin/git", ["checkout", "-q", baseBranch], { cwd: repository });
    execFileSync("/usr/bin/git", ["checkout", "-q", "-b", branch], { cwd: repository });
    fs.writeFileSync(path.join(repository, file), content);
    execFileSync("/usr/bin/git", ["add", "."], { cwd: repository });
    execFileSync("/usr/bin/git", ["commit", "-q", "-m", branch], { cwd: repository });
  }
  execFileSync("/usr/bin/git", ["checkout", "-q", baseBranch], { cwd: repository });
  const manager = new WorktreeManager(path.join(directory, "worktrees"));
  const result = manager.create({ cwd: repository, missionId: "mission-conflict", taskKey: "MERGE", baseRefs: ["dep-a", "dep-b", "dep-c"] });
  assert.match(result.conflict, /Dependency merge conflict for dep-b/);
  assert.deepEqual(result.pendingRefs, ["dep-b", "dep-c"]);
  assert.deepEqual(execFileSync("/usr/bin/git", ["diff", "--name-only", "--diff-filter=U"], { cwd: result.path, encoding: "utf8" }).trim(), "shared.tsv");
  fs.writeFileSync(path.join(result.path, "shared.tsv"), "header\nbase\na\nb\n");
  execFileSync("/usr/bin/git", ["add", "shared.tsv"], { cwd: result.path });
  execFileSync("/usr/bin/git", ["commit", "-q", "-m", "resolve dependency conflict"], { cwd: result.path });
  const reused = manager.reuse(result.path, result.branch, ["dep-a", "dep-b", "dep-c"]);
  assert.equal(reused.conflict, null);
  assert.deepEqual(reused.pendingRefs, []);
  assert.equal(fs.readFileSync(path.join(result.path, "other.txt"), "utf8"), "independent\n");
}));

test("orchestrator turns a real provider plan into claimed worker threads and review gates", async () => withTempDirAsync(async (directory) => {
  let nextThread = 0;
  let nextTurn = 0;
  const codex = {
    async createThread() { nextThread += 1; return { thread: { id: `thread-${nextThread}` }, model: "test-model" }; },
    async sendTurn() { nextTurn += 1; return { id: `turn-${nextTurn}` }; },
    async steer() {}, async injectItems() {}, respondToRequest() {},
  };
  const store = new MissionStore(path.join(directory, "agent-deck.sqlite3"));
  const worktrees = {
    assertReady() { return { available: true }; },
    create({ taskKey }) { const worktreePath = path.join(directory, taskKey); fs.mkdirSync(worktreePath); return { path: worktreePath, branch: `agentdeck/${taskKey.toLowerCase()}` }; },
    evidence() { return { files: ["src/real.js"], diffStat: "1 file changed", clean: false }; },
    commit() { return { commitHash: "a".repeat(40), files: [], diffStat: "", clean: true }; },
  };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees });
  const created = await orchestrator.create({ title: "Real", outcome: "Ship", cwd: directory, maxWorkers: 2, orchestrationMode: "mission" });
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: created.mainThreadId, item: { id: "plan-item", type: "agentMessage", phase: "final_answer", text: JSON.stringify(validPlan) } } });
  const planned = store.getMission(created.id);
  assert.equal(planned.status, "ready");
  await orchestrator.approve(created.id);
  let running = store.getMission(created.id);
  assert.equal(running.tasks[0].status, "running");
  assert.equal(running.tasks[1].status, "queued");
  const first = running.tasks[0];
  const result = { summary: "Implemented", acceptance: [{ criterion: "Unit tests pass", passed: true, evidence: "npm test exited 0" }], changedFiles: ["src/real.js"], blockers: [] };
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: first.agentThreadId, item: { id: "result-item", type: "agentMessage", phase: "final_answer", text: JSON.stringify(result) } } });
  await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: first.agentThreadId, turn: { id: first.activeTurnId, status: "completed" } } });
  assert.equal(store.getTask(first.id).status, "review");
  await orchestrator.acceptTask(created.id, first.id);
  running = store.getMission(created.id);
  assert.equal(running.tasks[0].status, "completed");
  assert.equal(running.tasks[1].status, "running");
  assert.equal(running.tasks[0].result.observedChanges.files[0], "src/real.js");
  const second = running.tasks[1];
  const secondResult = { summary: "Reviewed", acceptance: [{ criterion: "Review recorded", passed: true, evidence: "review log" }], changedFiles: [], blockers: [] };
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: second.agentThreadId, item: { id: "result-item-2", type: "agentMessage", phase: "final_answer", text: JSON.stringify(secondResult) } } });
  await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: second.agentThreadId, turn: { id: second.activeTurnId, status: "completed" } } });
  await orchestrator.acceptTask(created.id, second.id);
  assert.equal(store.getMission(created.id).status, "ready_to_integrate");
  await orchestrator.integrate(created.id);
  const integrated = store.getMission(created.id);
  assert.equal(integrated.status, "completed");
  assert.equal(integrated.integrationCommit, "a".repeat(40));
}));

test("adaptive direct mode skips the planner and auto-integrates after one human review", async () => withTempDirAsync(async (directory) => {
  const repository = path.join(directory, "repo");
  fs.mkdirSync(repository);
  execFileSync("/usr/bin/git", ["init", "-q"], { cwd: repository });
  fs.writeFileSync(path.join(repository, "parser.js"), "export const parse = value => value;\n");
  execFileSync("/usr/bin/git", ["add", "parser.js"], { cwd: repository });
  execFileSync("/usr/bin/git", ["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "-qm", "baseline"], { cwd: repository });
  const calls = [];
  const codex = {
    async createThread(input) { calls.push({ kind: "thread", input }); return { thread: { id: "direct-worker" }, model: "test-model" }; },
    async sendTurn(input) { calls.push({ kind: "turn", input }); return { id: "direct-turn" }; },
  };
  const store = new MissionStore(path.join(directory, "direct.sqlite3"));
  const worktrees = new WorktreeManager(path.join(directory, "worktrees"));
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees });
  const requirement = store.createRequirement({
    title: "Fix date parser",
    outcome: "Reject numeric strings such as 1.5 while preserving valid ISO dates",
    body: "Fix the parser and add focused regression tests.",
    workspacePath: repository,
    status: "ready_to_plan",
    valueContract: { tokenBudget: 14000 },
  });
  const claimed = await orchestrator.claimNextRequirement({ requirementId: requirement.id });
  const created = claimed.mission;
  assert.equal(claimed.requirement.status, "running");
  assert.equal(created.spec.runtime.mode, "direct");
  assert.equal(created.mainThreadId, null);
  assert.equal(created.tasks.length, 1);
  assert.equal(created.tasks[0].status, "running");
  assert.equal(created.model, "test-model");
  assert.equal(calls.filter(call => call.kind === "thread").length, 1);
  assert.equal(calls.filter(call => call.kind === "turn").length, 1);
  assert.equal(calls.find(call => call.kind === "turn").input.effort, "medium");
  assert.match(calls.find(call => call.kind === "turn").input.prompt, /Implement and verify this repository task directly/);
  assert.match(calls.find(call => call.kind === "turn").input.prompt, /invalid-input|boundary/i);
  assert.equal(calls.find(call => call.kind === "turn").input.outputSchema, undefined);
  assert.equal(calls.find(call => call.kind === "thread").input.dynamicTools, undefined);
  const task = created.tasks[0];
  fs.writeFileSync(path.join(task.worktreePath, "parser.js"), "export const parse = value => typeof value === 'string' && /^\\d+(?:\\.\\d+)?$/.test(value) ? null : value;\n");
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: task.agentThreadId, item: { id: "direct-result", type: "agentMessage", phase: "final_answer", text: "Parser fixed. Focused boundary tests passed. Changed parser.js." } } });
  await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: task.agentThreadId, turn: { id: task.activeTurnId, status: "completed" } } });
  assert.equal(store.getTask(task.id).status, "review");
  assert.match(store.getTask(task.id).result.summary, /Focused boundary tests passed/);
  assert.deepEqual(store.getTask(task.id).result.observedChanges.files, ["parser.js"]);
  const completed = await orchestrator.acceptTask(created.id, task.id);
  assert.equal(completed.status, "completed");
  assert.ok(completed.integrationCommit);
  assert.ok(completed.events.some(event => event.type === "mission.direct.auto_integrating"));
  assert.equal(completed.events.filter(event => event.type === "planner.turn.started").length, 0);
  const ledger = store.valueLedger(created.id);
  assert.equal(ledger.costs.plannerTokens, 0);
  assert.ok(ledger.costs.workerPromptTokens > 0);
  store.close();
}));

test("pre-thread dependency conflicts start a real conflict-resolution Worker instead of a dead-end Blocked task", async () => withTempDirAsync(async (directory) => {
  const sentTurns = [];
  const codex = {
    async createThread() { return { thread: { id: "merge-worker-thread" }, model: "test-model" }; },
    async sendTurn(input) { sentTurns.push(input); return { id: "merge-worker-turn" }; },
  };
  const store = new MissionStore(path.join(directory, "merge-worker.sqlite3"));
  const mission = store.createMission({ title: "Merge recovery", outcome: "Preserve every dependency", cwd: directory });
  store.savePlan(mission.id, normalizePlan({ ...validPlan, tasks: [
    { key: "DEP", title: "Dependency", description: "Produce input", agentRole: "Producer", dependencies: [], acceptanceCriteria: ["Input exists"] },
    { key: "MERGE", title: "Merge inputs", description: "Combine inputs", agentRole: "Integrator", dependencies: ["DEP"], acceptanceCriteria: ["All inputs preserved"] },
  ] }));
  const [dependency, target] = store.getMission(mission.id).tasks;
  store.updateTask(dependency.id, { status: "completed", phase: "verified", branch: "agentdeck/dependency", commitHash: "a".repeat(40) });
  store.updateMission(mission.id, { status: "running" });
  const worktrees = {
    create() { return { path: directory, branch: "agentdeck/merge", conflict: "Dependency merge conflict for agentdeck/dependency", pendingRefs: ["agentdeck/dependency"] }; },
  };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees });
  await orchestrator.dispatchReady(mission.id);
  const recovered = store.getTask(target.id);
  assert.equal(recovered.status, "running");
  assert.equal(recovered.agentThreadId, "merge-worker-thread");
  assert.equal(recovered.phase, "resolving_dependencies");
  assert.match(sentTurns[0].prompt, /PRE-EXECUTION DEPENDENCY MERGE RECOVERY/);
  assert.match(sentTurns[0].prompt, /agentdeck\/dependency/);
  assert.equal(store.getMission(mission.id).events.some((event) => event.type === "worker.merge_resolution.started"), true);
}));

test("users can intervene in persisted Main Agent and Worker conversations", async () => withTempDirAsync(async (directory) => {
  const sentTurns = [];
  const steeredTurns = [];
  const codex = {
    async sendTurn(input) { sentTurns.push(input); return { id: `follow-up-${sentTurns.length}` }; },
    async steer(input) { steeredTurns.push(input); },
  };
  const store = new MissionStore(path.join(directory, "intervention.sqlite3"));
  const mission = store.createMission({ title: "Intervene", outcome: "Keep humans in control", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "planner-thread", status: "ready" });
  store.savePlan(mission.id, normalizePlan({ ...validPlan, tasks: [validPlan.tasks[0]] }));
  const task = store.getMission(mission.id).tasks[0];
  store.updateTask(task.id, { agentThreadId: "worker-thread", worktreePath: directory, branch: "agentdeck/worker", status: "completed", phase: "verified" });
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees: {} });

  await orchestrator.sendMessage({ missionId: mission.id, text: "Explain the tradeoff" });
  await new Promise(setImmediate);
  assert.equal(sentTurns[0].threadId, "planner-thread");
  assert.equal(store.getMission(mission.id).activeTurnId, "follow-up-1");
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: "planner-thread", item: { id: "planner-reply", type: "agentMessage", text: "Here is the tradeoff." } } });
  await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: "planner-thread", turn: { id: "follow-up-1", status: "completed" } } });
  const afterPlanner = store.getMission(mission.id);
  assert.equal(afterPlanner.activeTurnId, null);
  assert.equal(afterPlanner.messages.some((item) => item.fromAgent === "Main Agent" && item.text === "Here is the tradeoff."), true);

  await orchestrator.sendMessage({ missionId: mission.id, taskId: task.id, text: "Recheck the edge case" });
  await new Promise(setImmediate);
  assert.equal(sentTurns[1].threadId, "worker-thread");
  assert.equal(store.getTask(task.id).status, "running");
  assert.equal(store.getMission(mission.id).status, "running");
  await orchestrator.sendMessage({ missionId: mission.id, taskId: task.id, text: "Also inspect the fallback" });
  await new Promise(setImmediate);
  assert.equal(steeredTurns[0].threadId, "worker-thread");
}));

test("message receipts appear before slow Codex delivery and retain a failure reason", async () => withTempDirAsync(async (directory) => {
  let release;
  const deliveryGate = new Promise((resolve) => { release = resolve; });
  const codex = {
    async sendTurn() { return { id: "unused" }; },
    async steer() { await deliveryGate; throw new Error("Codex transport unavailable"); },
  };
  const store = new MissionStore(path.join(directory, "message-receipt.sqlite3"));
  const mission = store.createMission({ title: "Receipt", outcome: "Keep the user informed", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "planner-thread", activeTurnId: "active-turn", status: "running" });
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees: {} });

  const result = await orchestrator.sendMessage({ missionId: mission.id, text: "Please prioritize the risk." });
  assert.equal(result.receipt.deliveryStatus, "sending");
  assert.equal(store.getMission(mission.id).messages[0].deliveryStatus, "sending");
  release();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const recorded = store.getMission(mission.id).messages[0];
  assert.equal(recorded.deliveryStatus, "failed");
  assert.match(recorded.error, /transport unavailable/);
}));

test("failed initial plan can retry on its original thread and still requires approval", async () => withTempDirAsync(async (directory) => {
  const store = new MissionStore(path.join(directory, "retry-plan.sqlite3"));
  const mission = store.createMission({ title: "Retry plan", outcome: "Original desired result", sourcePrompt: "Original request", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "original-planner", status: "failed", error: "invalid_json_schema" });
  const sent = [];
  const codex = { async sendTurn(input) { sent.push(input); return { id: "retry-turn" }; } };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees: {} });
  await orchestrator.sendMessage({ missionId: mission.id, text: "重新生成计划" });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].threadId, "original-planner");
  assert.equal(sent[0].outputSchema, missionPlanSchema);
  assert.match(sent[0].prompt, /Original request/);
  assert.match(sent[0].prompt, /Original desired result/);
  assert.equal(store.getMission(mission.id).status, "planning");
  assert.equal(store.getMission(mission.id).runs[0].triggerType, "mission.retry_plan");
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: "original-planner", turnId: "retry-turn", item: { id: "retry-plan-result", type: "agentMessage", text: JSON.stringify(validPlan) } } });
  await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: "original-planner", turn: { id: "retry-turn", status: "completed" } } });
  const updated = store.getMission(mission.id);
  assert.equal(updated.status, "ready");
  assert.equal(updated.error, null);
  assert.equal(updated.tasks.length, 2);
  assert.ok(updated.tasks.every(task => !task.agentThreadId && !task.worktreePath));
  assert.equal(store.listMissions().length, 1);
}));

test("failed plan retry preserves failure and message receipt if dispatch fails again", async () => withTempDirAsync(async (directory) => {
  const store = new MissionStore(path.join(directory, "retry-error.sqlite3"));
  const mission = store.createMission({ title: "Retry", outcome: "Keep evidence", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "original-planner", status: "failed", error: "invalid_json_schema" });
  const codex = { async sendTurn() { throw new Error("provider unavailable"); } };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees: {} });
  await orchestrator.sendMessage({ missionId: mission.id, text: "重新生成" });
  await new Promise(resolve => setTimeout(resolve, 5));
  const updated = store.getMission(mission.id);
  assert.equal(updated.status, "failed");
  assert.equal(updated.activeTurnId, null);
  assert.equal(updated.error, "provider unavailable");
  assert.equal(updated.messages[0].deliveryStatus, "failed");
  assert.equal(updated.tasks.length, 0);
}));

test("Main Agent follow-up can register and dispatch a real additional Worker", async () => withTempDirAsync(async (directory) => {
  let nextThread = 0;
  const sentTurns = [];
  const codex = {
    async createThread() { nextThread += 1; return { thread: { id: `dynamic-worker-${nextThread}` }, model: "test-model" }; },
    async sendTurn(input) { sentTurns.push(input); return { id: `dynamic-turn-${sentTurns.length}` }; },
    async steer() {}, async injectItems() {}, respondToRequest() {},
  };
  const store = new MissionStore(path.join(directory, "dynamic-worker.sqlite3"));
  const mission = store.createMission({ title: "Dynamic", outcome: "Add workers honestly", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "planner-thread", status: "ready" });
  store.savePlan(mission.id, normalizePlan({ ...validPlan, tasks: [validPlan.tasks[0]] }));
  const originalTask = store.getMission(mission.id).tasks[0];
  store.updateTask(originalTask.id, { status: "completed", phase: "verified", branch: "agentdeck/original", commitHash: "a".repeat(40) });
  store.updateMission(mission.id, { status: "ready_to_integrate" });
  const worktrees = {
    create({ taskKey }) { const target = path.join(directory, taskKey); fs.mkdirSync(target); return { path: target, branch: `agentdeck/${taskKey.toLowerCase()}` }; },
  };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees });

  await orchestrator.sendMessage({ missionId: mission.id, text: "Create a subagent to extract the discussion conclusions" });
  assert.equal(sentTurns[0].threadId, "planner-thread");
  assert.ok(sentTurns[0].outputSchema);
  assert.match(sentTurns[0].prompt, /never claim a Worker was created/i);

  const followup = {
    message: "I prepared a focused conclusion-extraction worker.",
    tasksToCreate: [{
      key: "DISCUSSION_CONCLUSIONS", title: "Extract discussion conclusions",
      description: "Review existing findings and produce a concise decision record.",
      agentRole: "Decision synthesis analyst", dependencies: [originalTask.key],
      acceptanceCriteria: ["Core conclusions and unresolved decisions are clearly separated."],
    }],
  };
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: "planner-thread", item: { id: "dynamic-plan", type: "agentMessage", text: JSON.stringify(followup) } } });

  const updated = store.getMission(mission.id);
  assert.equal(updated.tasks.length, 2);
  const added = updated.tasks.find((task) => task.key === "DISCUSSION_CONCLUSIONS");
  assert.equal(added.status, "running");
  assert.equal(added.agentThreadId, "dynamic-worker-1");
  assert.equal(sentTurns[1].threadId, "dynamic-worker-1");
  assert.equal(updated.events.some((event) => event.type === "mission.tasks.appended"), true);
  assert.equal(updated.messages.some((message) => message.topic === "mission.tasks.appended" && message.text.includes("DISCUSSION_CONCLUSIONS")), true);
}));

test("orchestrator recovery replays a completed Codex turn that finished while the app was closed", async () => withTempDirAsync(async (directory) => {
  const store = new MissionStore(path.join(directory, "agent-deck.sqlite3"));
  const mission = store.createMission({ title: "Recover", outcome: "Resume truth", cwd: directory });
  store.savePlan(mission.id, normalizePlan({ ...validPlan, tasks: [validPlan.tasks[0]] }));
  const task = store.getMission(mission.id).tasks[0];
  store.updateMission(mission.id, { status: "running" });
  store.updateTask(task.id, { status: "running", phase: "working", agentThreadId: "worker-recover", activeTurnId: "turn-recover", worktreePath: directory, branch: "agentdeck/recover" });
  const result = { summary: "Recovered result", acceptance: [{ criterion: "Unit tests pass", passed: true, evidence: "exit 0" }], changedFiles: ["src/recovered.js"], blockers: [] };
  const codex = {
    async resumeThread() {},
    async readThread() { return { status: { type: "idle" }, turns: [{ id: "turn-recover", status: "completed", items: [{ id: "recovered-item", type: "agentMessage", phase: "final_answer", text: JSON.stringify(result) }] }] }; },
  };
  const worktrees = { evidence() { return { files: ["src/recovered.js"], diffStat: "1 file changed", clean: false }; } };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees });
  await orchestrator.recover();
  const recovered = store.getTask(task.id);
  assert.equal(recovered.status, "review");
  assert.equal(recovered.result.summary, "Recovered result");
  assert.equal(recovered.result.observedChanges.files[0], "src/recovered.js");
}));

test("duplicate and out-of-order provider events converge without duplicate evidence", async () => withTempDirAsync(async (directory) => {
  const store = new MissionStore(path.join(directory, "provider-order.sqlite3"));
  const mission = store.createMission({ title: "Provider ordering", outcome: "Converge on truth", cwd: directory });
  store.savePlan(mission.id, normalizePlan({ ...validPlan, tasks: [validPlan.tasks[0]] }));
  const task = store.getMission(mission.id).tasks[0];
  store.updateMission(mission.id, { status: "running" });
  store.updateTask(task.id, { status: "running", phase: "working", agentThreadId: "worker-order", activeTurnId: "turn-order", worktreePath: directory, branch: "agentdeck/order" });
  const worktrees = { evidence() { return { files: ["src/order.js"], diffStat: "1 file changed", clean: false }; } };
  const orchestrator = new MissionOrchestrator({ codex: {}, store, worktrees });
  const completion = { method: "turn/completed", params: { threadId: "worker-order", turn: { id: "turn-order", status: "completed" } } };
  const result = { summary: "Late structured result", acceptance: [{ criterion: "Unit tests pass", passed: true, evidence: "exit 0" }], changedFiles: ["src/order.js"], blockers: [] };
  const message = { method: "item/completed", params: { threadId: "worker-order", turnId: "turn-order", item: { id: "late-result", type: "agentMessage", text: JSON.stringify(result) } } };

  await orchestrator.handleCodexEvent(completion);
  await orchestrator.handleCodexEvent(message);
  await orchestrator.handleCodexEvent(message);
  await orchestrator.handleCodexEvent(completion);

  const snapshot = store.getMission(mission.id);
  const converged = snapshot.tasks[0];
  assert.equal(converged.status, "review");
  assert.equal(converged.phase, "awaiting_review");
  assert.equal(converged.result.summary, "Late structured result");
  assert.equal(snapshot.artifacts.length, 1);
  assert.equal(snapshot.artifacts[0].summary, "Late structured result");
  assert.equal(snapshot.messages.filter((item) => item.providerItemId === "late-result").length, 1);
  assert.equal(snapshot.events.filter((event) => event.type === "provider.item/completed" || event.type === "provider.turn/completed").length, 2);
}));

test("a planner result arriving after turn completion repairs the transient failed state", async () => withTempDirAsync(async (directory) => {
  const store = new MissionStore(path.join(directory, "planner-order.sqlite3"));
  const mission = store.createMission({ title: "Late plan", outcome: "Recover the plan", cwd: directory });
  store.updateMission(mission.id, { mainThreadId: "planner-order", activeTurnId: "planner-turn" });
  const orchestrator = new MissionOrchestrator({ codex: {}, store, worktrees: {} });

  await orchestrator.handleCodexEvent({ method: "turn/completed", params: { threadId: "planner-order", turn: { id: "planner-turn", status: "completed" } } });
  assert.equal(store.getMission(mission.id).status, "failed");
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: "planner-order", turnId: "planner-turn", item: { id: "late-plan", type: "agentMessage", text: JSON.stringify(validPlan) } } });

  const repaired = store.getMission(mission.id);
  assert.equal(repaired.status, "ready");
  assert.equal(repaired.tasks.length, 2);
  assert.equal(repaired.messages.filter((item) => item.providerItemId === "late-plan").length, 1);
  assert.equal(repaired.messages[0].topic, "mission.plan");
}));

test("canceling a mission interrupts active turns and preserves completed evidence", async () => withTempDirAsync(async (directory) => {
  let nextThread = 0;
  const interrupted = [];
  const codex = {
    async createThread() { nextThread += 1; return { thread: { id: `cancel-thread-${nextThread}` }, model: "test-model" }; },
    async sendTurn() { return { id: `cancel-turn-${nextThread}` }; },
    async interrupt(input) { interrupted.push(input); },
  };
  const store = new MissionStore(path.join(directory, "cancel.sqlite3"));
  const worktrees = { assertReady() { return { available: true }; }, create({ taskKey }) { const target = path.join(directory, taskKey); fs.mkdirSync(target); return { path: target, branch: `agentdeck/${taskKey}` }; } };
  const orchestrator = new MissionOrchestrator({ codex, store, worktrees });
  const created = await orchestrator.create({ title: "Cancel", outcome: "Stop safely", cwd: directory, maxWorkers: 1, orchestrationMode: "mission" });
  await orchestrator.handleCodexEvent({ method: "item/completed", params: { threadId: created.mainThreadId, item: { id: "plan", type: "agentMessage", text: JSON.stringify({ ...validPlan, tasks: [validPlan.tasks[0]] }) } } });
  await orchestrator.approve(created.id);
  const canceled = await orchestrator.cancel(created.id);
  assert.equal(canceled.status, "canceled");
  assert.equal(canceled.tasks[0].status, "canceled");
  assert.equal(interrupted.length, 1);
  assert.equal(canceled.events[0].type, "mission.canceled");
}));
