const { EventEmitter } = require("node:events");
const { HTML_REPORT_CONTRACT, REPORT_QUALITY_MINIMUM, assessPublishedReport, isReportContentType } = require("./html-report-quality.cjs");
const {
  FAST_EXECUTION_CONTRACT,
  NATIVE_ARTIFACT_CONTRACT,
  plannerPerformanceRoute,
  promptTokenEstimate,
  workerPerformanceRoute,
} = require("./mission-performance.cjs");
const { buildDirectPlan, classifyMissionRequest, optimizeMissionPlan } = require("./adaptive-runtime.cjs");

const LEDGER_STRING_LIMIT = 32768;
const HTML_FIRST_DELIVERABLE = HTML_REPORT_CONTRACT;

function executionPolicy(mission) {
  return mission.executionMode === "research"
    ? `RESEARCH AND DOCUMENTS MODE\nSource folder (read-only reference): ${mission.cwd}\nWrite deliverables only inside your assigned managed workspace. Never initialize, commit, or modify the source folder. Do not implement code changes in the source project. If the request requires such changes, report the scope mismatch and ask the user. Do not copy entire source trees or credentials. Agent Deck maintains output versions internally; the user does not need a Git repository. Use task-specific output filenames to avoid conflicts. Keep human review gates.\n\n`
    : "";
}

function compactLedgerValue(value, depth = 0) {
  if (typeof value === "string") {
    if (value.length <= LEDGER_STRING_LIMIT) return value;
    const headLength = 20480;
    const tailLength = LEDGER_STRING_LIMIT - headLength;
    return `${value.slice(0, headLength)}\n… [Agent Deck omitted ${value.length - LEDGER_STRING_LIMIT} characters from this persisted event] …\n${value.slice(-tailLength)}`;
  }
  if (value == null || typeof value !== "object") return value;
  if (depth >= 12) return "[Agent Deck omitted deeply nested event data]";
  if (Array.isArray(value)) {
    const items = value.slice(0, 100).map((item) => compactLedgerValue(item, depth + 1));
    if (value.length > 100) items.push({ omittedItems: value.length - 100 });
    return items;
  }
  return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [key, compactLedgerValue(item, depth + 1)]));
}

function providerEventKey(event, threadId) {
  const method = event?.method;
  if (!method || !threadId || method === "turn/plan/updated") return null;
  const itemId = event.params?.item?.id;
  const turnId = event.params?.turn?.id || event.params?.turnId;
  const requestId = event.id;
  const identity = itemId || requestId || turnId;
  return identity == null ? null : `${method}:${threadId}:${identity}`;
}

function missionPlanningPrompt(mission, runtimeRoute = mission.spec?.runtime || {}) {
  const valueContract = mission.valueContract || {};
  return `Act as the Main Agent and convert this product request into an executable engineering mission. Produce a dependency-safe task DAG for independent workers. This request was routed as ${runtimeRoute.tier || "coordinated"}; return no more than ${runtimeRoute.maxTasks || 8} tasks and keep their combined estimatedTokenBudget within ${valueContract.tokenBudget || 80000}. Keep tasks coarse enough to avoid same-file conflicts. Implementation and its focused tests belong in the same task unless they can truly run against an already merged implementation. A final verifier, reviewer, report, or integration task must depend on every change it evaluates. Include concrete acceptance criteria and do not invent progress or completed work. Mark only synthesis, report, review, comparison, analysis, plan, or dashboard tasks as human-facing HTML work; evidence collection should retain native formats. For every task, provide valueScore (1-5), estimatedTokenBudget, and valueRationale. Favor independently verifiable high marginal-value work; do not spend parallel work on low-value duplicate investigation. Verification must derive boundary and invalid-input checks from the request instead of merely rerunning visible happy-path tests.\n\nREQUEST\n${mission.sourcePrompt || mission.outcome}\n\nDESIRED OUTCOME\n${mission.outcome}\n\nVALUE CONTRACT\nScenario: ${valueContract.scenario || "研发交付"}\nValue type: ${valueContract.valueType || "time_saved"}\nTarget metric: ${valueContract.targetMetric || "not supplied"}\nExpected value: ¥${valueContract.expectedValueCny || 0}; baseline human time: ${valueContract.baselineHours || 0}h; total token budget: ${valueContract.tokenBudget || 80000}.\n\n${FAST_EXECUTION_CONTRACT}`;
}

const missionPlanSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "outcome", "scope", "nonGoals", "constraints", "acceptanceCriteria", "tasks"],
  properties: {
    title: { type: "string" },
    outcome: { type: "string" },
    scope: { type: "array", items: { type: "string" } },
    nonGoals: { type: "array", items: { type: "string" } },
    constraints: { type: "array", items: { type: "string" } },
    acceptanceCriteria: { type: "array", items: { type: "string" } },
    tasks: {
      type: "array", minItems: 1, maxItems: 12,
      items: {
        type: "object", additionalProperties: false,
        required: ["key", "title", "description", "agentRole", "dependencies", "acceptanceCriteria", "valueScore", "estimatedTokenBudget", "valueRationale"],
        properties: {
          key: { type: "string" }, title: { type: "string" }, description: { type: "string" }, agentRole: { type: "string" },
          dependencies: { type: "array", items: { type: "string" } },
          acceptanceCriteria: { type: "array", minItems: 1, items: { type: "string" } },
          valueScore: { type: "integer", minimum: 1, maximum: 5, description: "Expected marginal value if this task succeeds; 5 is highest." },
          estimatedTokenBudget: { type: "integer", minimum: 500, maximum: 100000, description: "Estimated total token budget for this worker task." },
          valueRationale: { type: "string", description: "Why this task is worth its estimated token cost." },
        },
      },
    },
  },
};

const taskResultSchema = {
  type: "object", additionalProperties: false,
  required: ["summary", "acceptance", "changedFiles", "blockers"],
  properties: {
    summary: { type: "string" },
    acceptance: {
      type: "array", items: {
        type: "object", additionalProperties: false, required: ["criterion", "passed", "evidence"],
        properties: { criterion: { type: "string" }, passed: { type: "boolean" }, evidence: { type: "string" } },
      },
    },
    changedFiles: { type: "array", items: { type: "string" } },
    blockers: { type: "array", items: { type: "string" } },
  },
};

const mainAgentFollowupSchema = {
  type: "object", additionalProperties: false,
  required: ["message", "tasksToCreate"],
  properties: {
    message: { type: "string" },
    tasksToCreate: {
      type: "array", maxItems: 4,
      items: missionPlanSchema.properties.tasks.items,
    },
  },
};

const workerTools = [{
  type: "namespace", name: "agentdeck",
  description: "Durable coordination tools owned by the local Agent Deck mission.",
  tools: [
    { type: "function", name: "send_message", description: "Send a durable message to another task agent or the main agent.", inputSchema: { type: "object", additionalProperties: false, required: ["to", "topic", "message"], properties: { to: { type: "string" }, topic: { type: "string" }, message: { type: "string" } } } },
    { type: "function", name: "publish_artifact", description: "Publish a useful result into the shared context pool. Human-facing reports use self-contained HTML and pass an editorial/data-visualization quality gate; raw evidence stays in native formats.", inputSchema: { type: "object", additionalProperties: false, required: ["title", "summary", "files", "verified"], properties: { title: { type: "string" }, summary: { type: "string" }, files: { type: "array", items: { type: "string" } }, verified: { type: "boolean" }, contentType: { type: "string", enum: ["report", "research", "analysis", "dashboard", "plan", "review", "dataset", "code", "reference", "other"] }, dataRich: { type: "boolean", description: "True only when the source evidence contains chartable numeric, chronological, categorical, or relationship data." } } } },
    { type: "function", name: "list_context", description: "Read the current mission specification and shared artifacts.", inputSchema: { type: "object", additionalProperties: false, properties: {} } },
  ],
}];

function parseStructuredText(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(source); } catch {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw new Error("Codex returned no structured JSON object");
  }
}

function normalizePlan(raw) {
  if (!raw || !Array.isArray(raw.tasks) || !raw.tasks.length) throw new Error("The generated plan contains no tasks");
  const normalizeKey = (value, fallback) => String(value || fallback).trim().toUpperCase().replace(/[^A-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || fallback;
  const tasks = raw.tasks.map((task, index) => ({
    key: normalizeKey(task.key, `TASK-${String(index + 1).padStart(2, "0")}`),
    title: String(task.title || "Untitled task").trim(), description: String(task.description || "").trim(),
    agentRole: String(task.agentRole || "Worker").trim(),
    dependencies: [...new Set((task.dependencies || []).map((item) => normalizeKey(item, "INVALID-DEPENDENCY")))],
    acceptanceCriteria: (task.acceptanceCriteria || []).map(String).map((item) => item.trim()).filter(Boolean),
    value: {
      score: Math.max(1, Math.min(5, Number(task.valueScore || task.value?.score || 3))),
      estimatedTokenBudget: Math.max(500, Math.min(100000, Number(task.estimatedTokenBudget || task.value?.estimatedTokenBudget || 6000))),
      rationale: String(task.valueRationale || task.value?.rationale || "Completes a required Mission checkpoint.").trim().slice(0, 600),
    },
  }));
  const keys = new Set(tasks.map((task) => task.key));
  if (keys.size !== tasks.length) throw new Error("The generated plan contains duplicate task keys");
  for (const task of tasks) {
    if (!task.acceptanceCriteria.length) throw new Error(`${task.key} has no acceptance criteria`);
    for (const dependency of task.dependencies) if (!keys.has(dependency)) throw new Error(`${task.key} depends on unknown task ${dependency}`);
    if (task.dependencies.includes(task.key)) throw new Error(`${task.key} depends on itself`);
  }
  const visiting = new Set();
  const visited = new Set();
  const byKey = new Map(tasks.map((task) => [task.key, task]));
  function visit(key) {
    if (visiting.has(key)) throw new Error("The generated task graph contains a dependency cycle");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key).dependencies) visit(dependency);
    visiting.delete(key); visited.add(key);
  }
  for (const task of tasks) visit(task.key);
  return {
    title: String(raw.title || "Mission").trim(), outcome: String(raw.outcome || "").trim(),
    scope: (raw.scope || []).map(String), nonGoals: (raw.nonGoals || []).map(String),
    constraints: (raw.constraints || []).map(String), acceptanceCriteria: (raw.acceptanceCriteria || []).map(String),
    ...(raw.runtime ? { runtime: { ...raw.runtime } } : {}), tasks,
  };
}

function normalizeAdditionalTasks(mission, rawTasks) {
  if (!Array.isArray(rawTasks) || !rawTasks.length) return [];
  if (mission.tasks.length + rawTasks.length > 24) throw new Error("A mission cannot contain more than 24 tasks");
  const existing = mission.tasks.map((task) => ({
    key: task.key, title: task.title, description: task.description, agentRole: task.agentRole,
    dependencies: task.dependencies, acceptanceCriteria: task.acceptanceCriteria,
    valueScore: task.value?.score, estimatedTokenBudget: task.value?.estimatedTokenBudget, valueRationale: task.value?.rationale,
  }));
  const combined = normalizePlan({
    title: mission.spec?.title || mission.title,
    outcome: mission.spec?.outcome || mission.outcome,
    scope: mission.spec?.scope || [], nonGoals: mission.spec?.nonGoals || [],
    constraints: mission.spec?.constraints || [], acceptanceCriteria: mission.spec?.acceptanceCriteria || [],
    tasks: [...existing, ...rawTasks],
  });
  return combined.tasks.slice(existing.length);
}

function mainAgentFollowupPrompt(message) {
  return `You are the Main Agent for an existing Agent Deck mission. Respond to the user's instruction and decide whether real additional Worker tasks are required.

USER INSTRUCTION
${message}

Return a concise user-facing message plus tasksToCreate. Use an empty tasksToCreate array when no new worker is needed. When the user asks to create, add, delegate to, or spawn a subagent, tasksToCreate must contain the concrete new Worker task definition. You are proposing tasks to Agent Deck; never claim a Worker was created or started yourself. Say that you requested or prepared it. Agent Deck will persist the task, create the isolated worktree and Codex thread, and expose the real status on the canvas. Every new task key must be unique within the mission. Dependencies may reference existing task keys.\n\n${FAST_EXECUTION_CONTRACT}`;
}

function taskPrompt(mission, task, mergeState = null, contextKernel = null, route = workerPerformanceRoute(task, { mergeConflict: Boolean(mergeState?.conflict) })) {
  const shared = (mission.artifacts || []).map((artifact) => `- ${artifact.title} [${artifact.verificationStatus}]: ${artifact.summary}`).join("\n") || "No shared artifacts yet.";
  const mergeRecovery = mergeState?.conflict ? `\n\nPRE-EXECUTION DEPENDENCY MERGE RECOVERY\nThis real worktree contains an unfinished dependency merge:\n${mergeState.conflict}\n\nDependency branches that are not yet ancestors of HEAD:\n${mergeState.pendingRefs.map((item) => `- ${item}`).join("\n") || "- Inspect MERGE_HEAD and git status"}\n\nBefore the main task, inspect git status and resolve the conflict semantically. Preserve the valid contributions from every dependency; do not abort the merge, reset the worktree, or discard either side. Stage the resolution and complete the merge commit. Then merge every remaining dependency branch above one at a time, resolving and committing any further conflicts. Verify each with git merge-base --is-ancestor <branch> HEAD. Only then continue the assigned task.` : "";
  const kernel = contextKernel?.runtimePrompt || `SHARED CONTEXT SNAPSHOT\n${shared}`;
  const coordination = ["deepseek", "openai_compatible"].includes(mission.provider)
    ? "Use the workspace tools only when necessary. Writes, selected verification commands, Git stage, and Git commit always stop for visible, one-time human approval. Use workspace_git to inspect the assigned worktree; Agent Deck creates and assigns worktrees, so never attempt to create or remove one yourself. Your final structured result is persisted automatically; do not claim cross-agent messages or published artifacts that you cannot create."
    : "Use agentdeck.send_message for coordination and agentdeck.publish_artifact for reusable findings.";
  const artifactContract = route.reportTask ? HTML_FIRST_DELIVERABLE : NATIVE_ARTIFACT_CONTRACT;
  const directQuality = mission.spec?.runtime?.mode === "direct" ? `\n\nDIRECT QUALITY CONTRACT\n- You own inspection, implementation, focused tests, and verification in this one worktree. Do not delegate or create planning artifacts.\n- Translate the request into explicit invariants, then derive at least one boundary, invalid-input, or regression probe that is not merely a copy of the visible happy-path test.\n- Prefer the smallest correct patch. Preserve public behavior outside the stated scope.\n- Before reporting success, inspect the final diff and run the narrowest relevant existing test suite plus the derived probe. If the request is ambiguous, make the safest reversible interpretation and state it.\n- Do not create an HTML report unless the user asked for a report; return concise structured evidence.` : "";
  return `You are the ${task.agentRole} worker for an Agent Deck mission.\n\nMISSION OUTCOME\n${mission.outcome}\n\nYOUR TASK ${task.key}: ${task.title}\n${task.description}\n\nVALUE INTENT\nExpected marginal value: ${task.value?.score || 3}/5. Estimated token budget: ${task.value?.estimatedTokenBudget || 6000}. Rationale: ${task.value?.rationale || "Complete a required Mission checkpoint."}\n\nACCEPTANCE CRITERIA\n${task.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}\n\nDEPENDENCIES\n${task.dependencies.length ? task.dependencies.join(", ") : "None"}\n\n${kernel}${mergeRecovery}${directQuality}\n\n${FAST_EXECUTION_CONTRACT}\nPerformance route: ${route.id}; reasoning effort: ${route.effort}; tool-batch target: at most ${route.maxToolBatches}.\n\n${artifactContract}\n\n${mission.executionMode === "research" ? "Create research and document deliverables only in the provided managed worktree. Inspect reference material read-only, verify sources, and report evidence." : "Work only inside the provided worktree. Inspect the code, implement the task, run relevant verification, and report evidence."} ${coordination} Do not claim success without command, test, diff, or file evidence.`;
}

class MissionOrchestrator extends EventEmitter {
  constructor({ codex, apiRuntime = null, adapterHost = null, store, worktrees }) {
    super();
    this.codex = codex;
    this.apiRuntime = apiRuntime;
    this.adapterHost = adapterHost;
    this.store = store;
    this.worktrees = worktrees;
    this.dispatching = new Set();
    this.updateTimers = new Map();
    this.updateRevisions = new Map();
    this.processingEvents = new Set();
    // A thread accepts one active turn at a time. Queue transport per thread so
    // rapid interventions stay ordered without freezing the renderer.
    this.messageQueues = new Map();
  }

  list() { return this.store.listMissions(); }

  #executionCwd(mission) {
    if (mission.executionMode !== "research") return mission.cwd;
    this.worktrees.assertSourceDirectory(mission.cwd);
    const cwd = this.worktrees.prepareResearch(mission.id);
    if (mission.executionCwd !== cwd) this.store.updateMission(mission.id, { executionCwd: cwd });
    return cwd;
  }

  #runtime(mission) {
    if (this.adapterHost) return this.adapterHost.runtimeFor(mission);
    if (["deepseek", "openai_compatible"].includes(mission?.provider)) {
      if (!this.apiRuntime) throw new Error("API Agent Runtime is unavailable");
      return this.apiRuntime;
    }
    return this.codex;
  }

  attention() { return this.store.listAttentionItems(); }

  requirements(options) { return this.store.listRequirements(options); }

  createRequirement(input) { return this.store.createRequirement(input); }

  updateRequirement(id, patch) { return this.store.updateRequirement(id, patch); }

  async claimNextRequirement(input = {}) {
    const requirement = input.requirementId ? this.store.claimRequirement(input.requirementId) : this.store.claimNextRequirement(input.workspacePath);
    if (!requirement) return null;
    try {
      const mission = await this.create({
        title: requirement.title,
        outcome: requirement.outcome,
        sourcePrompt: requirement.body,
        cwd: requirement.workspacePath,
        model: input.model || undefined,
        maxWorkers: input.maxWorkers || 4,
        valueContract: requirement.valueContract,
        executionMode: requirement.executionMode,
      });
      this.store.updateRequirement(requirement.id, { missionId: mission.id, status: "planning" });
      const linked = this.store.syncRequirementForMission(mission.id, mission.status) || this.store.getRequirement(requirement.id);
      this.#emit(mission.id);
      return { requirement: linked, mission };
    } catch (error) {
      this.store.updateRequirement(requirement.id, { status: "blocked" });
      throw error;
    }
  }

  attentionBriefing() { return this.store.listAttentionBriefing(); }

  deferAttention(input) {
    const result = this.store.deferAttention(input.attentionId, input.minutes);
    const item = this.store.listAttentionItems({ includeDeferred: true }).find((entry) => entry.id === input.attentionId);
    if (item?.missionId) this.#emit(item.missionId);
    return result;
  }

  sessions(cwd) { return this.store.listSessionRefs(cwd); }

  get(missionId) { return this.store.getMission(missionId); }

  events(missionId, options) { return this.store.listEvents(missionId, options); }

  contextSearch(input) { return this.store.trajectorySearch(input); }

  contextBrief(input) { return this.store.contextBrief(input); }

  valueLedger(missionId) { return this.store.valueLedger(missionId); }

  updateValueContract(missionId, contract) {
    const mission = this.store.updateValueContract(missionId, contract);
    this.#emit(missionId);
    return mission;
  }

  recordValue(missionId, input) {
    const event = this.store.recordValue(missionId, input);
    this.#emit(missionId);
    return { event, ledger: this.store.valueLedger(missionId) };
  }

  saveUiState(missionId, patch) {
    const result = this.store.saveUiState(missionId, patch);
    this.#emit(missionId);
    return result;
  }

  updatePlan(missionId, spec) {
    const normalized = normalizePlan(spec);
    const result = this.store.updatePlan(missionId, normalized);
    this.#emit(missionId);
    return result;
  }

  async recover() {
    const missions = this.store.listMissions({ detailed: true });
    for (const mission of missions) {
      if (mission.status === "planning" && mission.mainThreadId) {
        await this.#recoverThread(mission, null, mission.mainThreadId, mission.activeTurnId);
      }
      for (const task of mission.tasks) {
        if (task.status === "claiming" || (["running", "waiting_approval"].includes(task.status) && !task.agentThreadId)) {
          this.store.updateTask(task.id, { status: "blocked", phase: "recovery_required", error: "Agent Deck stopped before a durable worker thread was attached. Retry this task." });
          this.store.appendEvent(mission.id, "recovery.orphan.blocked", { taskKey: task.key }, { taskId: task.id });
          this.#emit(mission.id);
        } else if (["running", "waiting_approval"].includes(task.status) && task.agentThreadId) {
          await this.#recoverThread(mission, task, task.agentThreadId, task.activeTurnId);
        }
      }
    }
  }

  async create(input) {
    if (!input.cwd) throw new Error("Choose a local workspace before creating a mission");
    const adaptiveRoute = classifyMissionRequest(input);
    const mission = this.store.createMission({ ...input, maxWorkers: adaptiveRoute.maxWorkers });
    this.store.appendEvent(mission.id, "mission.route.selected", adaptiveRoute);
    this.#emit(mission.id);
    try {
      if (adaptiveRoute.mode === "direct") {
        this.worktrees.assertReady(this.#executionCwd(mission));
        const spec = normalizePlan(buildDirectPlan(input, adaptiveRoute));
        this.store.savePlan(mission.id, spec);
        this.store.updateMission(mission.id, { status: "running", spec, error: null });
        this.store.appendEvent(mission.id, "mission.direct.started", { taskCount: 1, plannerSkipped: true, tokenBudget: spec.runtime.tokenBudget });
        this.store.addMessage({ missionId: mission.id, fromAgent: "Agent Deck", toAgent: "Delivery Agent", topic: "mission.direct", messageType: "command", text: "Adaptive routing selected one coherent worker; planner and coordination turns were skipped.", deliveryStatus: "delivered", source: "scheduler" });
        this.#emit(mission.id);
        await this.dispatchReady(mission.id);
        return this.store.getMission(mission.id);
      }
      const runtime = this.#runtime(mission);
      const cwd = this.#executionCwd(mission);
      const route = plannerPerformanceRoute();
      const created = await runtime.createThread({ cwd, title: `Mission · ${input.title}`, model: input.model, provider: mission.provider, allowMutations: false });
      this.store.updateMission(mission.id, { mainThreadId: created.thread.id, model: created.model || input.model || null });
      this.store.appendEvent(mission.id, "planner.thread.created", { threadId: created.thread.id }, { threadId: created.thread.id });
      const prompt = executionPolicy(mission) + missionPlanningPrompt(mission, adaptiveRoute);
      const turn = await runtime.sendTurn({ threadId: created.thread.id, cwd, prompt, model: input.model, effort: route.effort, outputSchema: missionPlanSchema });
      this.store.updateMission(mission.id, { activeTurnId: turn.id });
      this.store.startRun({ missionId: mission.id, agentId: `${mission.id}:main`, threadId: created.thread.id, turnId: turn.id, phase: "planning", triggerType: "mission.create" });
      this.store.appendEvent(mission.id, "planner.turn.started", { turnId: turn.id, performanceRoute: route.id, reasoningEffort: route.effort, promptEstimatedTokens: promptTokenEstimate(prompt), maxToolBatches: route.maxToolBatches }, { threadId: created.thread.id });
      this.#emit(mission.id);
      return this.store.getMission(mission.id);
    } catch (error) {
      this.store.updateMission(mission.id, { status: "failed", error: error.message });
      this.store.appendEvent(mission.id, "mission.failed", { message: error.message });
      this.#emit(mission.id);
      throw error;
    }
  }

  async approve(missionId) {
    const mission = this.store.getMission(missionId);
    if (!mission?.spec || mission.status !== "ready") throw new Error("Mission plan is not ready for dispatch");
    this.worktrees.assertReady(this.#executionCwd(mission));
    this.store.updateMission(missionId, { status: "running", error: null });
    this.store.appendEvent(missionId, "mission.approved", { taskCount: mission.tasks.length });
    this.store.addMessage({ missionId, fromAgent: "You", toAgent: "Main Agent", topic: "mission.approved", messageType: "command", text: "Requirement and task plan approved for real dispatch.", deliveryStatus: "delivered", source: "user" });
    this.#emit(missionId);
    await this.dispatchReady(missionId);
    return this.store.getMission(missionId);
  }

  async dispatchReady(missionId) {
    if (this.dispatching.has(missionId)) return;
    this.dispatching.add(missionId);
    try {
      let mission = this.store.getMission(missionId);
      if (!mission || !["running", "review"].includes(mission.status)) return;
      const completedKeys = new Set(mission.tasks.filter((task) => task.status === "completed").map((task) => task.key));
      const activeCount = mission.tasks.filter((task) => ["claiming", "running", "waiting_approval"].includes(task.status)).length;
      const slots = Math.max(0, mission.maxWorkers - activeCount);
      const dispatchScore = (task) => Number(task.value?.score || 3) * 100000 / Math.max(500, Number(task.value?.estimatedTokenBudget || 6000));
      const ready = mission.tasks.filter((task) => task.status === "queued" && task.dependencies.every((key) => completedKeys.has(key))).sort((left, right) => dispatchScore(right) - dispatchScore(left) || left.createdAt.localeCompare(right.createdAt)).slice(0, slots);
      const runtime = this.#runtime(mission);
      for (const candidate of ready) {
        if (!this.store.claimTask(candidate.id)) continue;
        this.store.appendEvent(missionId, "task.claimed", { taskKey: candidate.key, leaseOwner: "agent-deck-local-core", valueScore: candidate.value?.score || 3, estimatedTokenBudget: candidate.value?.estimatedTokenBudget || 6000, dispatchScore: Number(dispatchScore(candidate).toFixed(3)) }, { taskId: candidate.id });
        this.#emit(missionId);
        try {
          const latestTask = this.store.getTask(candidate.id);
          const dependencyBranches = candidate.dependencies.map((key) => mission.tasks.find((item) => item.key === key)?.branch).filter(Boolean);
          const worktree = latestTask.worktreePath ? this.worktrees.reuse(latestTask.worktreePath, latestTask.branch, dependencyBranches) : this.worktrees.create({ cwd: this.#executionCwd(mission), missionId, taskKey: candidate.key, baseRefs: dependencyBranches });
          const direct = mission.spec?.runtime?.mode === "direct";
          const route = workerPerformanceRoute(candidate, { mergeConflict: Boolean(worktree.conflict), direct });
          this.store.updateTask(candidate.id, { worktreePath: worktree.path, branch: worktree.branch, phase: "starting" });
          const created = await runtime.createThread({ cwd: worktree.path, title: `${candidate.key} · ${candidate.title}`, model: mission.model, dynamicTools: mission.provider === "codex" ? workerTools : undefined, provider: mission.provider, allowMutations: true });
          this.store.updateTask(candidate.id, { agentThreadId: created.thread.id, status: "running", phase: worktree.conflict ? "resolving_dependencies" : "starting", error: null });
          this.store.addMessage({ missionId, fromAgent: "Main Agent", toAgent: candidate.agentRole, topic: "task.assigned", messageType: "command", text: `${candidate.key}: ${candidate.title}`, deliveryStatus: "delivered", source: "scheduler" });
          if (worktree.conflict) this.store.appendEvent(missionId, "worker.merge_resolution.started", { taskKey: candidate.key, message: worktree.conflict, pendingRefs: worktree.pendingRefs || [] }, { taskId: candidate.id, threadId: created.thread.id });
          const contextKernel = this.store.contextBrief({ missionId, taskId: candidate.id, query: `${candidate.title}\n${candidate.description}`, tokenBudget: route.contextTokenBudget });
          this.store.appendEvent(missionId, "context.capsule.created", {
            taskKey: candidate.key, estimatedTokens: contextKernel.stats.estimatedTokens,
            baselineEstimatedTokens: contextKernel.stats.baselineEstimatedTokens,
            reductionPercent: contextKernel.stats.reductionPercent,
            included: contextKernel.stats.included, withheld: contextKernel.stats.withheld,
          }, { taskId: candidate.id, threadId: created.thread.id });
          const prompt = executionPolicy(mission) + taskPrompt(mission, candidate, worktree, contextKernel, route);
          const turn = await runtime.sendTurn({ threadId: created.thread.id, cwd: worktree.path, prompt, model: mission.model, effort: route.effort, outputSchema: taskResultSchema });
          this.store.updateTask(candidate.id, { activeTurnId: turn.id, phase: worktree.conflict ? "resolving_dependencies" : "working" });
          this.store.startRun({ missionId, taskId: candidate.id, agentId: `${missionId}:${candidate.key}`, threadId: created.thread.id, turnId: turn.id, phase: worktree.conflict ? "resolving_dependencies" : "working", triggerType: "scheduler.dispatch" });
          this.store.appendEvent(missionId, "worker.turn.started", { taskKey: candidate.key, threadId: created.thread.id, turnId: turn.id, mergeRecovery: Boolean(worktree.conflict), pendingRefs: worktree.pendingRefs || [], performanceRoute: route.id, reasoningEffort: route.effort, promptEstimatedTokens: promptTokenEstimate(prompt), contextTokenBudget: route.contextTokenBudget, maxToolBatches: route.maxToolBatches, reportContract: route.reportTask ? "html_full" : "native_compact" }, { taskId: candidate.id, threadId: created.thread.id });
        } catch (error) {
          this.store.updateTask(candidate.id, { status: "blocked", phase: "blocked", error: error.message });
          this.store.appendEvent(missionId, "task.blocked", { taskKey: candidate.key, message: error.message }, { taskId: candidate.id });
        }
        this.#emit(missionId);
      }
      mission = this.store.getMission(missionId);
      const completedAfterDispatch = new Set(mission.tasks.filter((task) => task.status === "completed").map((task) => task.key));
      const hasActive = mission.tasks.some((task) => ["claiming", "running", "waiting_approval"].includes(task.status));
      const hasRunnable = mission.tasks.some((task) => task.status === "queued" && task.dependencies.every((key) => completedAfterDispatch.has(key)));
      if (!hasActive && !hasRunnable && mission.tasks.some((task) => task.status === "blocked")) {
        this.store.updateMission(missionId, { status: "blocked", error: "One or more tasks require user action before dispatch can continue." });
        this.#emit(missionId);
      }
    } finally {
      this.dispatching.delete(missionId);
    }
  }

  async acceptTask(missionId, taskId) {
    const task = this.store.getTask(taskId);
    if (!task || task.missionId !== missionId || task.status !== "review") throw new Error("Task is not awaiting review");
    const commit = this.worktrees.commit(task.worktreePath, `${task.key}: ${task.title}`);
    this.store.updateTask(taskId, { status: "completed", phase: "verified", activeTurnId: null, commitHash: commit.commitHash });
    this.store.verifyTaskArtifacts(missionId, taskId);
    this.store.appendEvent(missionId, "task.verified", { taskKey: task.key, commitHash: commit.commitHash }, { taskId, threadId: task.agentThreadId });
    this.store.addMessage({ missionId, fromAgent: "You", toAgent: task.agentRole, topic: "task.verified", messageType: "event", text: `${task.key} accepted after review.`, deliveryStatus: "delivered", source: "user" });
    let mission = this.store.getMission(missionId);
    if (mission.tasks.every((item) => item.status === "completed")) {
      if (mission.spec?.runtime?.mode === "direct" && mission.spec?.runtime?.autoIntegrateAfterReview) {
        this.store.appendEvent(missionId, "mission.direct.auto_integrating", { verifiedTasks: mission.tasks.length });
        this.#emit(missionId);
        return this.integrate(missionId);
      }
      this.store.updateMission(missionId, { status: "ready_to_integrate", error: null });
      this.store.appendEvent(missionId, "mission.ready_to_integrate", { verifiedTasks: mission.tasks.length });
    } else {
      this.store.updateMission(missionId, { status: "running", error: null });
      await this.dispatchReady(missionId);
    }
    this.#emit(missionId);
    return this.store.getMission(missionId);
  }

  async integrate(missionId) {
    const mission = this.store.getMission(missionId);
    if (!mission || !mission.tasks.length || !mission.tasks.every((task) => task.status === "completed" && task.branch && task.commitHash)) {
      throw new Error("Every task must be reviewed and committed before integration");
    }
    this.store.updateMission(missionId, { status: "integrating", error: null });
    this.store.appendEvent(missionId, "mission.integration.started", { branches: mission.tasks.map((task) => task.branch) });
    this.#emit(missionId);
    const worktree = mission.integrationPath ? this.worktrees.reuse(mission.integrationPath, mission.integrationBranch) : this.worktrees.create({ cwd: this.#executionCwd(mission), missionId, taskKey: "integration", baseRefs: mission.tasks.map((task) => task.branch) });
    this.store.updateMission(missionId, { integrationPath: worktree.path, integrationBranch: worktree.branch });
    if (worktree.conflict) {
      this.store.updateMission(missionId, { status: "integration_conflict", error: worktree.conflict });
      this.store.appendEvent(missionId, "mission.integration.conflict", { message: worktree.conflict, path: worktree.path, branch: worktree.branch });
      this.#emit(missionId);
      return this.store.getMission(missionId);
    }
    const commit = this.worktrees.commit(worktree.path, `Integrate mission: ${mission.title}`);
    this.store.updateMission(missionId, { status: "completed", integrationCommit: commit.commitHash, error: null });
    this.store.appendEvent(missionId, "mission.completed", { integrationBranch: worktree.branch, integrationCommit: commit.commitHash });
    this.#emit(missionId);
    return this.store.getMission(missionId);
  }

  async retryTask(missionId, taskId) {
    const task = this.store.getTask(taskId);
    if (!task || task.missionId !== missionId || task.status !== "blocked") throw new Error("Task is not blocked");
    this.worktrees.assertReady(task.worktreePath || this.#executionCwd(this.store.getMission(missionId)));
    this.store.updateTask(taskId, { status: "queued", phase: "ready", error: null, activeTurnId: null });
    this.store.updateMission(missionId, { status: "running", error: null });
    this.store.appendEvent(missionId, "task.retry.requested", { taskKey: task.key }, { taskId, threadId: task.agentThreadId });
    this.#emit(missionId);
    await this.dispatchReady(missionId);
    return this.store.getMission(missionId);
  }

  changeWorkspace(missionId, cwd, executionMode = null) {
    const mission = this.store.getMission(missionId);
    if (!mission || !["ready", "blocked"].includes(mission.status) || !mission.spec || mission.activeTurnId || this.dispatching.has(missionId) || mission.integrationPath || mission.tasks.some(task => task.agentThreadId || task.worktreePath || task.branch || !["queued", "blocked"].includes(task.status))) {
      throw new Error("只能为尚未创建任何 Worker 或 Worktree 的计划更换工作区。已有执行记录的 Mission 不会被迁移。");
    }
    const mode = executionMode || mission.executionMode || "code";
    if (!["code", "research"].includes(mode)) throw new Error("Invalid execution mode");
    if (mode === "research") this.worktrees.assertSourceDirectory(cwd);
    else this.worktrees.assertReady(cwd);
    this.store.rebindUnstartedWorkspace(missionId, cwd, mode);
    this.store.appendEvent(missionId, "mission.workspace.changed", { previousPath: mission.cwd, path: cwd, previousMode: mission.executionMode, executionMode: mode, requiresApproval: true });
    this.#emit(missionId);
    return this.store.getMission(missionId);
  }

  async resolveApproval({ missionId, requestId, decision }) {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    if (!["deepseek", "openai_compatible"].includes(mission.provider)) throw new Error("This approval belongs to the native provider, not the API Harness");
    const result = await this.apiRuntime.resolveApproval({ requestId, decision });
    this.store.appendEvent(missionId, "provider.approval.user_decision", { requestId, decision }, { threadId: result.threadId || null });
    this.#emit(missionId);
    return result;
  }

  async sendMessage({ missionId, taskId, text }) {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    const message = String(text || "").trim();
    if (!message) throw new Error("Message cannot be empty");
    const initialTask = taskId ? this.store.getTask(taskId) : null;
    if (taskId && (!initialTask || initialTask.missionId !== missionId || !initialTask.agentThreadId)) throw new Error("This worker has no real Codex thread yet");
    if (!taskId && !mission.mainThreadId) throw new Error("This mission has no real Main Agent thread yet");
    const targetName = initialTask?.agentRole || "Main Agent";
    const threadId = initialTask?.agentThreadId || mission.mainThreadId;
    // Persist and announce before crossing the Codex process boundary. This is
    // the receipt the UI can render immediately, even if Codex is slow or down.
    const receipt = this.store.addMessage({ missionId, fromAgent: "You", toAgent: targetName, topic: "agent.steer", messageType: "command", text: message, deliveryStatus: "sending", source: "user" });
    this.store.appendEvent(missionId, "user.message.queued", { messageId: receipt.id, toAgent: targetName }, { taskId: initialTask?.id || null, threadId });
    this.#emit(missionId);
    this.#queueMessageDelivery(threadId, async () => {
      try {
        const latestMission = this.store.getMission(missionId);
        const latestTask = taskId ? this.store.getTask(taskId) : null;
        if (!latestMission) throw new Error("Mission was removed before the message could be delivered");
        const runtime = this.#runtime(latestMission);
        if (!taskId) {
          if (latestMission.activeTurnId) await runtime.steer({ threadId, turnId: latestMission.activeTurnId, prompt: message });
          else {
            const retryPlanning = latestMission.status === "failed" && !latestMission.spec && !latestMission.tasks.length;
            if (retryPlanning) this.store.updateMission(missionId, { status: "planning", error: null });
            let turn;
            try {
              const route = plannerPerformanceRoute();
              turn = await runtime.sendTurn({
                threadId, cwd: this.#executionCwd(latestMission), model: latestMission.model,
                prompt: executionPolicy(latestMission) + (retryPlanning ? `${missionPlanningPrompt(latestMission, classifyMissionRequest({ ...latestMission, orchestrationMode: "mission" }))}\n\nUSER RETRY INSTRUCTION\n${message}` : mainAgentFollowupPrompt(message)),
                effort: route.effort,
                outputSchema: retryPlanning ? missionPlanSchema : mainAgentFollowupSchema,
              });
            } catch (error) {
              if (retryPlanning) this.store.updateMission(missionId, { status: "failed", activeTurnId: null, error: error.message || String(error) });
              throw error;
            }
            this.store.updateMission(missionId, { activeTurnId: turn.id, error: null });
            this.store.startRun({ missionId, agentId: `${missionId}:main`, threadId, turnId: turn.id, phase: retryPlanning ? "planning" : "followup", triggerType: retryPlanning ? "mission.retry_plan" : "user.message" });
          }
        } else {
          if (!latestTask?.agentThreadId) throw new Error("This worker no longer has a real Codex thread");
          if (latestTask.activeTurnId && latestTask.status === "running") await runtime.steer({ threadId, turnId: latestTask.activeTurnId, prompt: message });
          else {
            const route = workerPerformanceRoute(latestTask, { direct: latestMission.spec?.runtime?.mode === "direct" });
            const artifactContract = route.reportTask ? HTML_FIRST_DELIVERABLE : NATIVE_ARTIFACT_CONTRACT;
            const turn = await runtime.sendTurn({ threadId, cwd: latestTask.worktreePath, prompt: `${executionPolicy(latestMission)}${message}\n\n${FAST_EXECUTION_CONTRACT}\n\n${artifactContract}`, effort: route.effort, outputSchema: taskResultSchema });
            this.store.updateTask(latestTask.id, { status: "running", phase: "working", activeTurnId: turn.id, error: null });
            this.store.startRun({ missionId, taskId: latestTask.id, agentId: `${missionId}:${latestTask.key}`, threadId, turnId: turn.id, phase: "working", triggerType: "user.message" });
            this.store.updateMission(missionId, { status: "running", error: null });
          }
        }
        this.store.updateMessage(receipt.id, { deliveryStatus: "delivered", error: null });
        this.store.appendEvent(missionId, "user.message.delivered", { messageId: receipt.id, toAgent: targetName }, { taskId: initialTask?.id || null, threadId });
      } catch (error) {
        this.store.updateMessage(receipt.id, { deliveryStatus: "failed", error: error.message || String(error) });
        this.store.appendEvent(missionId, "user.message.failed", { messageId: receipt.id, toAgent: targetName, message: error.message || String(error) }, { taskId: initialTask?.id || null, threadId });
      }
      this.#emit(missionId);
    });
    return { missionId, receipt };
  }

  async cancel(missionId) {
    const mission = this.store.getMission(missionId);
    if (!mission) throw new Error("Mission not found");
    if (["completed", "canceled"].includes(mission.status)) return mission;
    const active = [
      ...(mission.mainThreadId && mission.activeTurnId ? [{ threadId: mission.mainThreadId, turnId: mission.activeTurnId }] : []),
      ...mission.tasks.filter((task) => task.agentThreadId && task.activeTurnId).map((task) => ({ threadId: task.agentThreadId, turnId: task.activeTurnId })),
    ];
    const runtime = this.#runtime(mission);
    await Promise.allSettled(active.map((turn) => runtime.interrupt(turn)));
    for (const task of mission.tasks) {
      if (task.status !== "completed") this.store.updateTask(task.id, { status: "canceled", phase: "canceled", activeTurnId: null, error: null });
    }
    this.store.updateMission(missionId, { status: "canceled", activeTurnId: null, error: null });
    this.store.appendEvent(missionId, "mission.canceled", { interruptedTurns: active.length, preservedCompletedTasks: mission.tasks.filter((task) => task.status === "completed").length });
    this.store.addMessage({ missionId, fromAgent: "You", toAgent: "All Agents", topic: "mission.canceled", messageType: "command", text: "Mission canceled. Existing workspace changes and evidence were preserved.", deliveryStatus: "delivered", source: "user" });
    this.#emit(missionId);
    return this.store.getMission(missionId);
  }

  async handleCodexEvent(event) {
    const trackedMethods = new Set(["turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed", "item/execution/started", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/gitOperation/requestApproval", "item/approval/resolved", "item/tool/call"]);
    if (!trackedMethods.has(event.method)) return;
    const threadId = event.params?.threadId || event.params?.thread?.id;
    if (event.method === "item/tool/call" && event.id != null) {
      await this.#handleToolCall(event);
      return;
    }
    if (!threadId) return;
    const mission = this.store.findMissionRecordByThread(threadId);
    if (!mission) return;
    const task = this.store.findTaskByThread(threadId);
    const dedupeKey = providerEventKey(event, threadId);
    if (dedupeKey && (this.processingEvents.has(dedupeKey) || this.store.hasEvent(mission.id, dedupeKey))) return;
    if (dedupeKey) this.processingEvents.add(dedupeKey);
    try {
    const meta = { taskId: task?.id, threadId, dedupeKey };
    const providerTurnId = event.params?.turn?.id || event.params?.turnId;
    if (event.method === "turn/started" && providerTurnId) {
      this.store.startRun({ missionId: mission.id, taskId: task?.id || null, agentId: task ? `${mission.id}:${task.key}` : `${mission.id}:main`, threadId, turnId: providerTurnId, phase: task?.phase || mission.status, triggerType: "provider.event" });
    }
    if (event.method === "turn/completed" && providerTurnId) {
      const providerStatus = event.params?.turn?.status;
      this.store.completeRun(threadId, providerTurnId, {
        status: providerStatus === "completed" ? "completed" : providerStatus || "failed",
        phase: providerStatus === "completed" ? "finished" : providerStatus || "failed",
        error: event.params?.turn?.error?.message || null,
      });
    }
    if (!task && event.method === "item/completed" && event.params?.item?.type === "agentMessage") {
      const item = event.params.item;
      let responseText = item.text || "Main Agent sent a response.";
      let appendedTasks = [];
      const acceptsLatePlan = !mission.spec && (mission.status === "planning" || (mission.status === "failed" && /Planner completed without a valid structured mission/i.test(mission.error || "")));
      if (acceptsLatePlan) {
        try {
          const route = classifyMissionRequest({ ...mission, orchestrationMode: "mission" });
          const spec = optimizeMissionPlan(normalizePlan(parseStructuredText(item.text)), route, mission.valueContract?.tokenBudget);
          this.store.savePlan(mission.id, spec);
          this.store.appendEvent(mission.id, "mission.plan.optimized", { route: route.tier, taskCount: spec.tasks.length, repairedDependencyEdges: spec.runtime.repairedDependencyEdges, plannedTaskTokens: spec.runtime.plannedTaskTokens, tokenBudget: spec.runtime.tokenBudget }, { threadId });
          this.store.addArtifact({ missionId: mission.id, title: "Generated requirement candidate", summary: spec.outcome, files: [], verificationStatus: "generated", sourceThreadId: threadId });
        } catch (error) {
          this.store.appendEvent(mission.id, "planner.output.rejected", { message: error.message, itemId: item.id }, { threadId });
        }
      } else {
        try {
          const response = parseStructuredText(item.text);
          if (typeof response.message === "string" && Array.isArray(response.tasksToCreate)) {
            responseText = response.message;
            appendedTasks = normalizeAdditionalTasks(this.store.getMission(mission.id), response.tasksToCreate);
            if (appendedTasks.length) {
              this.store.appendTasks(mission.id, appendedTasks);
              responseText = `${responseText}\n\nAgent Deck registered ${appendedTasks.length} new Worker task${appendedTasks.length === 1 ? "" : "s"}: ${appendedTasks.map((entry) => entry.key).join(", ")}.`;
            }
          }
        } catch (error) {
          this.store.appendEvent(mission.id, "planner.followup.action.rejected", { message: error.message, itemId: item.id }, { threadId });
        }
      }
      this.store.addMessage({ missionId: mission.id, fromAgent: "Main Agent", toAgent: "You", topic: appendedTasks.length ? "mission.tasks.appended" : acceptsLatePlan ? "mission.plan" : "agent.reply", messageType: "response", text: responseText, deliveryStatus: "delivered", source: "codex", providerItemId: item.id });
      if (appendedTasks.length) await this.dispatchReady(mission.id);
    } else if (task) {
      await this.#handleTaskEvent(mission, task, event);
    }

    if (!task && event.method === "turn/completed") {
      const latestMission = this.store.getMissionRecord(mission.id);
      const status = event.params?.turn?.status;
      if (latestMission?.status === "planning") {
        this.store.updateMission(mission.id, { status: "failed", activeTurnId: null, error: event.params?.turn?.error?.message || (status === "completed" ? "Planner completed without a valid structured mission." : `Planner turn ${status}`) });
      } else {
        this.store.updateMission(mission.id, { activeTurnId: null });
      }
    }
    if (["turn/started", "turn/completed", "turn/plan/updated", "item/started", "item/completed", "item/execution/started", "item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/gitOperation/requestApproval", "item/approval/resolved"].includes(event.method)) {
      const providerPayload = event.id == null ? event.params : { requestId: event.id, ...event.params };
      this.store.appendEvent(mission.id, `provider.${event.method}`, compactLedgerValue(providerPayload), meta);
    }
    this.#emit(mission.id);
    } finally {
      if (dedupeKey) this.processingEvents.delete(dedupeKey);
    }
  }

  async #handleTaskEvent(mission, task, event) {
    const item = event.params?.item || {};
    if (event.method === "turn/plan/updated") this.store.updateTask(task.id, { phase: "planning" });
    if (event.method === "item/started") {
      if (item.approvalRequired) this.store.updateTask(task.id, { status: "running", phase: "action_requested" });
      else if (item.type === "commandExecution") this.store.updateTask(task.id, { status: "running", phase: "executing" });
      else if (item.type === "fileChange") this.store.updateTask(task.id, { status: "running", phase: "editing" });
      else if (item.type === "gitOperation") this.store.updateTask(task.id, { status: "running", phase: "git_inspecting" });
      if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") this.store.updateTask(task.id, { status: "running", phase: "coordinating" });
    }
    if (event.method === "item/execution/started") {
      this.store.updateTask(task.id, { status: "running", phase: item.type === "fileChange" ? "editing_approved" : item.type === "gitOperation" ? "git_executing" : "executing_approved", error: null });
    }
    if (event.method === "item/completed" && item.type === "agentMessage") {
      try {
        const result = parseStructuredText(item.text);
        const evidence = (result.acceptance || []).map((entry) => ({ criterion: entry.criterion, passed: Boolean(entry.passed), evidence: entry.evidence }));
        const latest = this.store.getTask(task.id);
        this.store.updateTask(task.id, { result, evidence, ...(["review", "completed"].includes(latest?.status) ? {} : { phase: "finishing" }) });
        if (["review", "completed"].includes(latest?.status)) this.store.updateLatestTaskArtifact(mission.id, task.id, { summary: result.summary || task.title });
        this.store.addMessage({ missionId: mission.id, fromAgent: task.agentRole, toAgent: "Main Agent", topic: "task.result", messageType: "response", text: result.summary || "Worker result submitted.", deliveryStatus: "delivered", source: "codex", providerItemId: item.id });
      } catch {
        this.store.addMessage({ missionId: mission.id, fromAgent: task.agentRole, toAgent: "Main Agent", topic: "worker.message", messageType: "response", text: item.text || "Worker sent a response.", deliveryStatus: "delivered", source: "codex", providerItemId: item.id });
      }
    }
    if (event.method === "turn/completed") {
      const status = event.params?.turn?.status;
      if (status === "completed") {
        const latest = this.store.getTask(task.id);
        if (["review", "completed"].includes(latest?.status) && !latest?.activeTurnId) return;
        const observed = task.worktreePath ? this.worktrees.evidence(task.worktreePath) : { files: [], diffStat: "", clean: true };
        const result = latest?.result ? { ...latest.result, observedChanges: observed } : { summary: "Worker turn completed without structured result.", acceptance: [], changedFiles: [], blockers: [], observedChanges: observed };
        this.store.updateTask(task.id, { result });
        this.store.addArtifact({ missionId: mission.id, taskId: task.id, title: `${task.key} result`, summary: result.summary || task.title, files: observed.files, verificationStatus: "awaiting_user_review", sourceThreadId: task.agentThreadId, dedupeKey: `turn:${event.params?.turn?.id || event.params?.turnId || task.activeTurnId}:result` });
        this.store.updateTask(task.id, { status: "review", phase: "awaiting_review", activeTurnId: null, error: null });
        const anyActive = this.store.hasActiveTasks(mission.id);
        this.store.updateMission(mission.id, { status: anyActive ? "running" : "review" });
      } else if (status === "interrupted") {
        this.store.updateTask(task.id, { status: "blocked", phase: "interrupted", activeTurnId: null, error: "Worker turn was interrupted" });
      } else {
        this.store.updateTask(task.id, { status: "blocked", phase: "failed", activeTurnId: null, error: event.params?.turn?.error?.message || `Worker turn ${status}` });
      }
    }
    if (event.method === "item/commandExecution/requestApproval" || event.method === "item/fileChange/requestApproval" || event.method === "item/gitOperation/requestApproval") {
      this.store.updateTask(task.id, { status: "waiting_approval", phase: "approval_requested" });
    }
    if (event.method === "item/approval/resolved") {
      const latest = this.store.getTask(task.id);
      if (latest?.status === "waiting_approval") this.store.updateTask(task.id, { status: "running", phase: event.params?.decision === "accept" ? "approval_approved" : "approval_declined" });
    }
    if (event.method === "item/completed" && item.approvalRequired) {
      if (item.state === "failed") this.store.updateTask(task.id, { status: "running", phase: "action_failed", error: item.result || "Approved API action failed" });
      if (item.state === "declined") this.store.updateTask(task.id, { status: "running", phase: "approval_declined" });
      if (item.state === "executed") this.store.updateTask(task.id, { status: "running", phase: "action_executed", error: null });
    }
  }

  async #handleToolCall(event) {
    const { threadId, namespace, tool, arguments: args = {} } = event.params || {};
    const mission = this.store.findMissionByThread(threadId);
    const task = this.store.findTaskByThread(threadId);
    if (!mission || !task || namespace !== "agentdeck") {
      this.codex.respondToRequest(event.id, null, { code: -32601, message: "Unknown Agent Deck tool context" });
      return;
    }
    try {
      let output;
      if (tool === "send_message") {
        const target = mission.tasks.find((item) => item.key.toLowerCase() === String(args.to).toLowerCase() || item.agentRole.toLowerCase() === String(args.to).toLowerCase());
        const toAgent = target?.agentRole || (String(args.to).toLowerCase() === "main" ? "Main Agent" : String(args.to));
        this.store.addMessage({ missionId: mission.id, fromAgent: task.agentRole, toAgent, topic: String(args.topic), messageType: "request", text: String(args.message), deliveryStatus: target?.agentThreadId || toAgent === "Main Agent" ? "delivered" : "recorded", source: "codex" });
        if (target?.agentThreadId) {
          if (target.activeTurnId && target.status === "running") await this.codex.steer({ threadId: target.agentThreadId, turnId: target.activeTurnId, prompt: `[Message from ${task.agentRole} · ${args.topic}] ${args.message}` });
          else await this.codex.injectItems(target.agentThreadId, `[Message from ${task.agentRole} · ${args.topic}] ${args.message}`);
        } else if (toAgent === "Main Agent" && mission.mainThreadId) {
          await this.codex.injectItems(mission.mainThreadId, `[Message from ${task.agentRole} · ${args.topic}] ${args.message}`);
        }
        output = { recorded: true, deliveredToThread: Boolean(target?.agentThreadId || (toAgent === "Main Agent" && mission.mainThreadId)) };
      } else if (tool === "publish_artifact") {
        const files = Array.isArray(args.files) ? args.files : [];
        const reportIntent = isReportContentType(args.contentType);
        const htmlFiles = files.filter((file) => /\.html?$/i.test(String(file)));
        if (reportIntent && !htmlFiles.length) throw new Error("Human-facing report artifacts require a self-contained HTML file. Keep raw evidence as additional attachments.");
        const reportQuality = htmlFiles.map((file) => assessPublishedReport({ root: task.worktreePath, file, dataRich: Boolean(args.dataRich) }));
        if (args.verified && reportIntent) {
          const failed = reportQuality.find((item) => !item.passing);
          if (failed) throw new Error(`HTML report quality gate failed (${failed.score}/100; minimum ${REPORT_QUALITY_MINIMUM}). Fix before publishing: ${failed.issues.slice(0, 5).join(" ")}`);
        }
        const qualityScore = reportQuality.length ? Math.min(...reportQuality.map((item) => item.score)) : null;
        const artifact = this.store.addArtifact({ missionId: mission.id, taskId: task.id, title: String(args.title), summary: String(args.summary), files, verificationStatus: args.verified ? "worker_verified" : "unverified", sourceThreadId: threadId, qualityScore, reportQuality });
        output = { artifactId: artifact.id, recorded: true, reportQuality };
      } else if (tool === "list_context") {
        const latest = this.store.getMission(mission.id);
        output = { mission: latest.spec, artifacts: latest.artifacts };
      } else {
        throw new Error(`Unknown Agent Deck tool: ${tool}`);
      }
      this.codex.respondToRequest(event.id, { contentItems: [{ type: "inputText", text: JSON.stringify(output) }], success: true });
      this.store.appendEvent(mission.id, `bus.tool.${tool}`, { from: task.agentRole, arguments: args, output }, { taskId: task.id, threadId });
      this.#emit(mission.id);
    } catch (error) {
      this.codex.respondToRequest(event.id, { contentItems: [{ type: "inputText", text: error.message }], success: false });
    }
  }

  async #recoverThread(mission, task, threadId, turnId) {
    try {
      const runtime = this.#runtime(mission);
      await runtime.resumeThread(threadId, task?.worktreePath || this.#executionCwd(mission));
      const thread = await runtime.readThread(threadId, true);
      const turn = (thread.turns || []).find((item) => item.id === turnId) || thread.turns?.at(-1);
      if (!turn || turn.status === "inProgress") {
        this.store.appendEvent(mission.id, "recovery.thread.attached", { threadId, turnId: turn?.id || turnId, status: turn?.status || thread.status?.type }, { taskId: task?.id, threadId });
        this.#emit(mission.id);
        return;
      }
      if (turn.status === "completed") {
        for (const item of turn.items || []) {
          if (item.type === "agentMessage") await this.handleCodexEvent({ method: "item/completed", params: { threadId, turnId: turn.id, item } });
        }
      }
      await this.handleCodexEvent({ method: "turn/completed", params: { threadId, turn } });
      this.store.appendEvent(mission.id, "recovery.thread.replayed", { threadId, turnId: turn.id, status: turn.status }, { taskId: task?.id, threadId });
      this.#emit(mission.id);
    } catch (error) {
      if (["deepseek", "openai_compatible"].includes(mission.provider)) {
        const restartMessage = "This API worker was stopped by an Agent Deck restart. Its durable messages and evidence remain available; retry it to start a fresh controlled API turn.";
        if (task) this.store.updateTask(task.id, { status: "blocked", phase: "recovery_required", activeTurnId: null, error: restartMessage });
        else this.store.updateMission(mission.id, { status: "blocked", activeTurnId: null, error: restartMessage });
        this.store.appendEvent(mission.id, "recovery.api_session.blocked", { threadId, message: restartMessage }, { taskId: task?.id, threadId });
        this.#emit(mission.id);
        return;
      }
      this.store.appendEvent(mission.id, "recovery.thread.failed", { threadId, message: error.message }, { taskId: task?.id, threadId });
      this.#emit(mission.id);
    }
  }

  #emit(missionId) {
    const missionStatus = this.store.getMissionStatus(missionId);
    if (missionStatus) this.store.syncRequirementForMission(missionId, missionStatus);
    const revision = (this.updateRevisions.get(missionId) || 0) + 1;
    this.updateRevisions.set(missionId, revision);
    if (this.updateTimers.has(missionId)) return;
    const timer = setTimeout(() => {
      this.updateTimers.delete(missionId);
      this.emit("update", { missionId, revision: this.updateRevisions.get(missionId), updatedAt: new Date().toISOString() });
    }, 60);
    timer.unref?.();
    this.updateTimers.set(missionId, timer);
  }

  #queueMessageDelivery(threadId, work) {
    const previous = this.messageQueues.get(threadId);
    const queued = previous ? previous.catch(() => {}).then(work) : Promise.resolve(work());
    this.messageQueues.set(threadId, queued);
    queued.finally(() => {
      if (this.messageQueues.get(threadId) === queued) this.messageQueues.delete(threadId);
    }).catch(() => {});
  }
}

module.exports = { MissionOrchestrator, missionPlanSchema, mainAgentFollowupSchema, taskResultSchema, normalizePlan, normalizeAdditionalTasks, parseStructuredText, compactLedgerValue, workerTools, missionPlanningPrompt, taskPrompt };
