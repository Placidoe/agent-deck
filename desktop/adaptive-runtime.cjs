const COMPLEX_PATTERN = /(research|survey|benchmark|compare|comparison|migration|architecture|architect|audit|security|full[- ]?stack|multi[- ]?agent|parallel|dashboard|report|proposal|strategy|roadmap|调研|研究|基准|对比|迁移|架构|审计|安全|全栈|多智能体|并行|报告|方案|战略|路线图)/i;
const EXPLICIT_DECOMPOSITION_PATTERN = /(split|decompose|delegate|multiple workers|subagents?|task dag|分解|拆解|委派|多个.{0,4}(agent|智能体)|子\s*agent|任务\s*dag)/i;
const SIMPLE_DELIVERY_PATTERN = /(fix|bug|implement|add|remove|rename|update|refactor|test|parser|endpoint|component|function|修复|实现|新增|删除|重命名|更新|重构|测试|解析器|接口|组件|函数)/i;
const IMPLEMENTATION_PATTERN = /(implement|build|develop|code|fix|refactor|feature|实现|开发|编码|修复|重构|功能)/i;
const TEST_PATTERN = /(^|[^a-z])(test|tests|testing|verify|verification|validate|validation|qa)([^a-z]|$)|测试|验证|验收|质检/i;
const FINALIZATION_PATTERN = /(review|audit|report|synthesi|integration|integrate|release|summary|评审|审计|报告|综合|集成|发布|总结)/i;

const { exportLocale, exportText } = require("./user-language.cjs");

function requestText(input = {}) {
  return [input.title, input.outcome, input.sourcePrompt].filter(Boolean).join("\n").trim();
}

function classifyMissionRequest(input = {}) {
  const requested = ["direct", "mission"].includes(input.orchestrationMode) ? input.orchestrationMode : "adaptive";
  const text = requestText(input);
  const reasons = [];
  let complexityScore = 0;
  if (input.executionMode === "research") { complexityScore += 4; reasons.push("research/document workflow"); }
  if (COMPLEX_PATTERN.test(text)) { complexityScore += 3; reasons.push("multi-stage or synthesis intent"); }
  if (EXPLICIT_DECOMPOSITION_PATTERN.test(text)) { complexityScore += 4; reasons.push("explicit delegation or DAG intent"); }
  if (text.length > 1800) { complexityScore += 2; reasons.push("long multi-constraint request"); }
  if ((text.match(/\n\s*(?:[-*]|\d+[.)])/g) || []).length >= 5) { complexityScore += 2; reasons.push("many independently stated deliverables"); }
  if (SIMPLE_DELIVERY_PATTERN.test(text)) { complexityScore -= 2; reasons.push("single coherent implementation intent"); }
  const automaticWorkspace = input.executionMode === "auto";
  // A new/ordinary folder needs a model-owned setup decision before execution.
  // Keep bounded requests at one task, not a speculative multi-agent DAG.
  const mode = automaticWorkspace ? "mission" : requested === "adaptive" ? (complexityScore >= 3 ? "mission" : "direct") : requested;
  if (automaticWorkspace) reasons.unshift("Agent selects workspace preparation before approval");
  if (requested !== "adaptive") reasons.unshift(`user selected ${requested} strategy`);
  if (!reasons.length) reasons.push(mode === "direct" ? "bounded request with no proven coordination benefit" : "coordination benefit exceeds setup cost");
  const tier = mode === "direct" ? "direct" : complexityScore >= 7 ? "orchestrated" : "coordinated";
  const tokenBudget = Math.max(1000, Number(input.tokenBudget || 80000));
  const routeTaskCap = mode === "direct" || (automaticWorkspace && (requested === "direct" || (requested === "adaptive" && complexityScore < 3))) ? 1 : tier === "coordinated" ? 4 : 8;
  const maxTasks = Math.max(1, Math.min(routeTaskCap, Math.floor(tokenBudget / 500)));
  const routeWorkerCap = mode === "direct" ? 1 : tier === "coordinated" ? 3 : Math.max(2, Math.min(6, Number(input.maxWorkers || 4)));
  return {
    requested,
    mode,
    tier,
    score: complexityScore,
    reasons,
    plannerRequired: mode === "mission",
    autoDispatch: mode === "direct",
    maxWorkers: Math.min(routeWorkerCap, maxTasks),
    maxTasks,
  };
}

function acceptanceFromRequest(input = {}) {
  const t = (en, zh) => exportText(exportLocale(input), en, zh);
  const text = String(input.outcome || input.sourcePrompt || "").trim();
  const candidates = text.split(/\n+/).map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim()).filter(line => line.length >= 8 && line.length <= 220);
  const criteria = [...new Set(candidates)].slice(0, 4);
  if (!criteria.length && text) criteria.push(text.slice(0, 220));
  criteria.push(t("Run focused existing tests plus boundary or invalid-input probes derived from the request, and report the exact evidence.", "运行相关已有测试，并根据需求验证边界与无效输入，报告可核查的证据。"));
  criteria.push(t("Keep unrelated behavior and public interfaces unchanged unless the request explicitly requires otherwise.", "除非需求明确要求，保持无关行为和公开接口不变。"));
  return [...new Set(criteria)].slice(0, 6);
}

function buildDirectPlan(input = {}, route = classifyMissionRequest({ ...input, orchestrationMode: "direct" })) {
  const t = (en, zh) => exportText(exportLocale(input), en, zh);
  const totalBudget = Math.max(1000, Number(input.tokenBudget || 80000));
  const directBudget = Math.min(totalBudget, 20000);
  return {
    title: String(input.title || t("Direct delivery", "直接交付")).trim(),
    outcome: String(input.outcome || input.sourcePrompt || t("Deliver the requested verified change.", "交付经过验证的需求变更。")).trim(),
    scope: [t("Execute the requested change in one coherent worktree", "在一个独立工作区完成需求变更"), t("Verify observable behavior and boundary cases", "验证可观察行为与边界情况")],
    nonGoals: [t("No speculative decomposition or unrelated refactor", "不做无依据的任务拆分或无关重构")],
    constraints: [t("One worker owns implementation and focused verification", "同一个 Agent 负责实现与相关验证"), t("Human review remains required before integration", "集成前仍须由用户验收")],
    acceptanceCriteria: acceptanceFromRequest(input),
    runtime: { strategy: "adaptive", mode: "direct", tier: route.tier, score: route.score, reasons: route.reasons, plannerSkipped: true, autoIntegrateAfterReview: true, maxWorkers: 1, maxTasks: 1, tokenBudget: totalBudget, plannedTaskTokens: directBudget },
    tasks: [{
      key: "DIRECT_EXECUTION",
      title: String(input.title || t("Implement and verify the requested change", "实现并验证需求变更")).trim(),
      description: `${String(input.sourcePrompt || input.outcome || "").trim()}\n\n${t("Own the complete change in this worktree: inspect, implement, run focused tests, derive adversarial boundary checks from the request, and return concrete evidence.", "在此工作区负责完整变更：检查、实现、运行相关测试，根据需求验证边界情况，返回具体证据。")}`,
      agentRole: t("Delivery Agent", "交付 Agent"),
      dependencies: [],
      acceptanceCriteria: acceptanceFromRequest(input),
      estimatedTokenBudget: directBudget,
    }],
  };
}

function hasDependencyPath(byKey, from, to, seen = new Set()) {
  if (from === to) return true;
  if (seen.has(from)) return false;
  seen.add(from);
  return (byKey.get(from)?.dependencies || []).some(dependency => hasDependencyPath(byKey, dependency, to, seen));
}

function fitTaskBudgets(tasks, totalBudget) {
  const budget = Math.max(1000, Number(totalBudget || 80000));
  const current = tasks.reduce((sum, task) => sum + Number(task.estimatedTokenBudget || 6000), 0);
  if (current <= budget) return tasks;
  const floor = 500;
  const distributable = Math.max(0, budget - floor * tasks.length);
  const weights = tasks.map(task => Math.max(1, Number(task.estimatedTokenBudget || 6000) - floor));
  const totalWeight = weights.reduce((sum, value) => sum + value, 0) || 1;
  return tasks.map((task, index) => ({
    ...task,
    estimatedTokenBudget: floor + Math.floor(distributable * weights[index] / totalWeight),
  }));
}

function optimizeMissionPlan(plan, route, totalBudget) {
  if (!plan?.tasks?.length) return plan;
  if (plan.tasks.length > route.maxTasks) throw new Error(`The generated plan has ${plan.tasks.length} tasks; this ${route.tier} route allows at most ${route.maxTasks}. Ask the planner to combine tightly coupled implementation and test work.`);
  const tasks = plan.tasks.map(task => ({ ...task, dependencies: [...task.dependencies] }));
  const byKey = new Map(tasks.map(task => [task.key, task]));
  const text = task => [task.key, task.title, task.description, task.agentRole].filter(Boolean).join(" ");
  const implementations = tasks.filter(task => IMPLEMENTATION_PATTERN.test(text(task)) && !TEST_PATTERN.test(text(task)));
  const tests = tasks.filter(task => TEST_PATTERN.test(text(task)));
  const finalizers = tasks.filter(task => FINALIZATION_PATTERN.test(text(task)));
  const producers = tasks.filter(task => !FINALIZATION_PATTERN.test(text(task)));
  let repairedEdges = 0;
  for (const target of tests) {
    for (const source of implementations) {
      if (source.key === target.key || target.dependencies.includes(source.key)) continue;
      if (hasDependencyPath(byKey, source.key, target.key)) continue;
      target.dependencies.push(source.key);
      repairedEdges += 1;
    }
  }
  for (const target of finalizers) {
    for (const source of producers) {
      if (source.key === target.key || target.dependencies.includes(source.key)) continue;
      if (hasDependencyPath(byKey, source.key, target.key)) continue;
      target.dependencies.push(source.key);
      repairedEdges += 1;
    }
  }
  const budgetedTasks = fitTaskBudgets(tasks, totalBudget);
  const plannedTokens = budgetedTasks.reduce((sum, task) => sum + Number(task.estimatedTokenBudget || 0), 0);
  return {
    ...plan,
    tasks: budgetedTasks,
    runtime: {
      strategy: "adaptive",
      mode: route.mode,
      tier: route.tier,
      score: route.score,
      reasons: route.reasons,
      plannerSkipped: false,
      autoIntegrateAfterReview: false,
      maxWorkers: route.maxWorkers,
      maxTasks: route.maxTasks,
      tokenBudget: Math.max(1000, Number(totalBudget || 80000)),
      plannedTaskTokens: plannedTokens,
      repairedDependencyEdges: repairedEdges,
    },
  };
}

module.exports = { buildDirectPlan, classifyMissionRequest, fitTaskBudgets, optimizeMissionPlan };
