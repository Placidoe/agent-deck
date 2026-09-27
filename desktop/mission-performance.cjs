const SIMPLE_WORK_PATTERN = /(collect|gather|extract|inventory|catalog|lookup|search|source|evidence|dataset|data prep|format|convert|translate|lint|test|verify|benchmark|收集|检索|盘点|整理|提取|数据|格式|转换|翻译|测试|验证|基准)/i;
const DEEP_WORK_PATTERN = /(architect|design|synthesi|strategy|security|audit|review|migration|proposal|decision|root cause|架构|设计|综合|策略|安全|审计|评审|迁移|方案|决策|根因)/i;
const REPORT_WORK_PATTERN = /(html|report|dashboard|brief|proposal|review|comparison|synthesi|analysis|报告|看板|简报|方案|评审|对比|综合|分析)/i;

const FAST_EXECUTION_CONTRACT = `FAST EXECUTION POLICY
- Begin with the smallest evidence-gathering plan that can satisfy the acceptance criteria.
- Batch independent read-only searches and file reads instead of alternating one tool call with one reasoning step.
- Reuse the supplied context capsule; do not rediscover facts already present there.
- Aim for no more than 8 tool batches. Stop as soon as every acceptance criterion has concrete evidence.
- Publish once after verification. Do not repeatedly rewrite the same artifact or narrate routine tool use.`;

const NATIVE_ARTIFACT_CONTRACT = `ARTIFACT ROUTING
This is not a presentation/report task. Keep evidence in its useful native format (JSON, CSV, TSV, source notes, code, tests, or images). Do not build an HTML page unless the task explicitly requires a human-facing report. Publish only reusable, verified output.`;

function taskText(task = {}) {
  return [task.key, task.title, task.description, task.agentRole, ...(task.acceptanceCriteria || [])].filter(Boolean).join("\n");
}

function taskNeedsHtml(task = {}) {
  return REPORT_WORK_PATTERN.test(taskText(task));
}

function workerPerformanceRoute(task = {}, options = {}) {
  const text = taskText(task);
  const reportTask = taskNeedsHtml(task);
  if (options.direct) {
    return {
      id: "direct-balanced",
      effort: "medium",
      contextTokenBudget: 1800,
      maxToolBatches: 8,
      reportTask,
    };
  }
  const complex = Boolean(options.mergeConflict) || DEEP_WORK_PATTERN.test(text) || reportTask;
  const simple = SIMPLE_WORK_PATTERN.test(text) && !complex;
  const effort = complex ? "medium" : "low";
  return {
    id: complex ? "balanced-deep" : simple ? "fast-evidence" : "fast-default",
    effort,
    contextTokenBudget: complex ? 2800 : simple ? 1800 : 2200,
    maxToolBatches: complex ? 12 : 8,
    reportTask,
  };
}

function plannerPerformanceRoute() {
  return { id: "balanced-planner", effort: "medium", contextTokenBudget: 0, maxToolBatches: 6, reportTask: false };
}

function promptTokenEstimate(text) {
  let units = 0;
  for (const character of String(text || "")) units += /[\u3400-\u9fff\uf900-\ufaff]/u.test(character) ? 0.78 : 0.26;
  return Math.max(1, Math.ceil(units));
}

module.exports = {
  FAST_EXECUTION_CONTRACT,
  NATIVE_ARTIFACT_CONTRACT,
  plannerPerformanceRoute,
  promptTokenEstimate,
  taskNeedsHtml,
  workerPerformanceRoute,
};
