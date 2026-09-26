/**
 * A review can only become user-verifiable when the Worker supplied at least
 * one recorded acceptance check, every check passed, and it left no blocker.
 * This is deliberately derived from persisted structured output: it never
 * treats an empty result as evidence of success.
 */
export function reviewGate(result = {}) {
  const acceptance = Array.isArray(result?.acceptance) ? result.acceptance : [];
  const blockers = Array.isArray(result?.blockers) ? result.blockers.filter(Boolean) : [];
  const passed = acceptance.filter((item) => item?.passed === true).length;
  return {
    total: acceptance.length,
    passed,
    blockers: blockers.length,
    ready: acceptance.length > 0 && passed === acceptance.length && blockers.length === 0,
  };
}

/**
 * Turn the persisted review gate into user-facing recovery guidance. Keeping
 * this derivation next to reviewGate prevents the inspector and sticky review
 * bar from explaining the same state differently.
 */
export function reviewGateGuidance(result = {}) {
  const acceptance = Array.isArray(result?.acceptance) ? result.acceptance : [];
  const failedChecks = acceptance.filter((item) => item?.passed !== true);
  const blockers = Array.isArray(result?.blockers) ? result.blockers.map(String).map((item) => item.trim()).filter(Boolean) : [];
  const issues = [
    ...failedChecks.map((item) => item?.criterion ? `验收项未通过：${item.criterion}` : "存在未通过的验收项"),
    ...blockers,
  ];
  if (!acceptance.length) issues.unshift("Worker 尚未返回可核验的验收记录");
  const feedback = issues.length
    ? `请处理以下验收阻塞项，并在完成后重新提交可核验结果：\n${issues.map((item) => `- ${item}`).join("\n")}`
    : "";
  return {
    blockers,
    failedChecks,
    issues,
    feedback,
  };
}
