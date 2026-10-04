const taskPriority = ["waiting_approval", "blocked", "review"];

export function canRetryCodexPlan(mission) {
  return Boolean(mission?.provider === "codex" && mission.runtimeMode !== "agent_deck" && mission.status === "failed" && !mission.spec && !mission.tasks?.length && !mission.activeTurnId);
}

export function isCodexModelFailure(error) {
  return /CODEX_MODEL_(?:NOT_LISTED|CATALOG_UNAVAILABLE)|model.*not supported when using Codex|model_not_found/i.test(String(error || ""));
}

export function isWorkspaceBlocker(task) {
  return task?.status === "blocked" && !task.agentThreadId && /Worktree isolation unavailable|\[(?:not_git_repository|missing_git_head|workspace_missing)\]/i.test(task.error || "");
}

export function canChangeMissionWorkspace(mission) {
  return Boolean(mission?.spec && ["ready", "blocked"].includes(mission.status) && !mission.activeTurnId && !mission.integrationPath && mission.tasks?.every(task => !task.agentThreadId && !task.worktreePath && !task.branch && ["queued", "blocked"].includes(task.status)));
}

function firstTask(mission, status) {
  return (mission?.tasks || []).find((task) => task.status === status) || null;
}

/**
 * Project one real, persisted Mission state into the next human decision.
 * This is deliberately a view model: it never infers execution, creates a
 * fallback task, or chooses an approval on the user's behalf.
 */
export function nextMissionAction(mission) {
  if (!mission) return null;
  if (canRetryCodexPlan(mission) && isCodexModelFailure(mission.error)) return {
    kind: "recovery", task: null, tone: "attention", icon: "blocked",
    title: "Codex 模型配置不兼容，执行计划尚未开始",
    detail: "选择本地 Codex 模型列表中的型号后重试。原需求与失败记录会保留，计划仍需你确认。",
    primaryLabel: "选择模型并重试", secondaryLabel: "查看活动", panel: "spec",
  };
  if (mission.spec?.workspacePending && mission.status === "blocked") return {
    kind: "recovery", task: null, tone: "attention", icon: "blocked",
    title: "工作区评估未完成，原任务已保留", detail: mission.error || "可以重新让 Agent 评估环境；尚未初始化目录或启动 Worker。",
    primaryLabel: "查看准备方案", secondaryLabel: "查看活动", panel: "spec",
  };
  for (const status of taskPriority) {
    const task = firstTask(mission, status);
    if (!task) continue;
    if (status === "waiting_approval") return {
      kind: "approval", task, tone: "attention", icon: "approval",
      title: "Worker 正在等待你的许可",
      detail: `检查 ${task.key} 的受控操作；批准或拒绝后，Worker 才能继续。`,
      primaryLabel: "查看请求", secondaryLabel: "查看任务", panel: "conversation",
    };
    if (status === "blocked" && isWorkspaceBlocker(task)) return {
      kind: "blocked", task, tone: "attention", icon: "blocked",
      title: "执行工作区尚未就绪，子 Agent 未启动",
      detail: `工作区：${mission.cwd}。可以让 Agent 重新评估环境，选择复用 Git、独立成果目录或提出初始化方案；不需要你先区分文档和代码。已有拆解保留，初始化你的目录仍需明确确认。`,
      primaryLabel: "查看工作区问题", secondaryLabel: "查看证据", panel: "evidence",
    };
    if (status === "blocked") return {
      kind: "blocked", task, tone: "attention", icon: "blocked",
      title: "一个 Worker 需要你解除阻塞",
      detail: task.error || task.result?.blockers?.filter(Boolean).join("；") || `${task.key} 已停止，查看保留的证据和恢复建议。`,
      primaryLabel: "处理阻塞", secondaryLabel: "查看证据", panel: "evidence",
    };
    return {
      kind: "review", task, tone: "review", icon: "review",
      title: mission.spec?.runtime?.mode === "direct" ? "直通任务已完成，等待一次验收" : "一份 Worker 结果等待验收",
      detail: mission.spec?.runtime?.mode === "direct" ? `${task.key} 已返回实现与边界验证证据。接受后会自动集成，无需再经过汇总确认。` : `${task.key} 已返回结果。先审阅证据与产物，再选择接受或要求修改。`,
      primaryLabel: "审阅结果", secondaryLabel: "查看任务", panel: "result",
    };
  }
  if (mission.status === "ready") return {
    kind: "plan", task: null, tone: "attention", icon: "plan",
    title: "执行计划已准备好，尚未启动 Worker",
    detail: `${mission.tasks?.length || 0} 个任务仍停留在计划阶段。${mission.spec?.workspace?.reason || "请检查计划和工作区准备方式；也可以让 Agent 重新评估环境。"}确认后才会创建真实 Thread 并启动执行。`,
    primaryLabel: "审阅计划", secondaryLabel: "编辑 DAG", panel: "spec",
  };
  if (mission.status === "ready_to_integrate") return {
    kind: "integration", task: null, tone: "review", icon: "integration",
    title: (mission.executionMode === "research" || mission.spec?.workspace?.strategy === "managed") ? "所有任务已验收，可以汇总成果" : "所有任务已验收，可以审阅集成",
    detail: (mission.executionMode === "research" || mission.spec?.workspace?.strategy === "managed") ? "检查各任务的成果与证据，确认后汇总到独立成果工作区，不写回原目录。" : "检查最终结果、已验证证据和 Worktree 变更，再决定是否创建集成分支。",
    primaryLabel: (mission.executionMode === "research" || mission.spec?.workspace?.strategy === "managed") ? "审阅成果汇总" : "审阅集成", secondaryLabel: "查看产物", panel: "result",
  };
  if (["integration_conflict", "failed"].includes(mission.status)) return {
    kind: "recovery", task: null, tone: "attention", icon: "blocked",
    title: mission.status === "integration_conflict" ? "集成遇到真实冲突" : "Mission 需要恢复决策",
    detail: mission.error || "查看真实错误与保留证据，选择安全的下一步。",
    primaryLabel: "检查恢复方案", secondaryLabel: "查看活动", panel: "result",
  };
  return null;
}
