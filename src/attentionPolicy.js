export const attentionProfiles = [
  { id: "flow", label: "护航推进", description: "优先清除阻塞，让在途工作继续流动。" },
  { id: "delivery", label: "交付验收", description: "优先审阅已完成成果，尽快形成可交付结果。" },
  { id: "risk", label: "风险控制", description: "优先处理失败、冲突和权限决策。" },
];

function bounded(value, maximum = 24) { return Math.max(-maximum, Math.min(maximum, Math.round(value))); }

export function attentionAdjustment(item, profileId = "flow") {
  const type = item?.type || "";
  if (profileId === "delivery") {
    if (["worker_review", "integration_ready"].includes(type)) return { boost: 18, reason: "交付已就绪，优先验收并释放成果" };
    if (type === "plan_review") return { boost: 10, reason: "确认计划后可启动执行" };
    return { boost: 0, reason: "保持运营优先级" };
  }
  if (profileId === "risk") {
    if (["worker_blocked", "integration_conflict", "mission_failed"].includes(type)) return { boost: 18, reason: "存在失败或冲突，优先恢复可控状态" };
    if (type === "worker_approval") return { boost: 12, reason: "权限决定会直接影响执行边界" };
    return { boost: -3, reason: "风险较低，稍后处理" };
  }
  if (["worker_blocked", "integration_conflict", "mission_failed"].includes(type)) return { boost: 16, reason: "清除阻塞可恢复后续工作流" };
  if (type === "worker_approval") return { boost: 10, reason: "一次决定即可让 Worker 继续" };
  if (type === "worker_review") return { boost: -8, reason: "成果稳定保留，避免打断在途工作" };
  return { boost: 0, reason: "保持运营优先级" };
}

export function rankAttention(items = [], profileId = "flow") {
  return [...items].map((item) => {
    const adjustment = attentionAdjustment(item, profileId);
    return { ...item, basePriority: Number(item.priority || 0), profileBoost: adjustment.boost, preferenceReason: adjustment.reason, priority: bounded(Number(item.priority || 0) + adjustment.boost, 100), prioritySource: adjustment.boost ? "operational + preference" : "operational" };
  }).sort((left, right) => right.priority - left.priority || right.basePriority - left.basePriority || String(right.updatedAt).localeCompare(String(left.updatedAt)));
}
