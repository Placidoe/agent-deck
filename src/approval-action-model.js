const STATES = new Set(["requested", "approved", "declined", "executing", "executed", "failed"]);

export const actionStateLabels = {
  requested: "Awaiting your approval",
  approved: "Approved — waiting to start",
  declined: "Declined — not run",
  executing: "Executing approved action",
  executed: "Executed",
  failed: "Execution failed",
};

function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeState(value, fallback = "requested") {
  const state = String(value || "").toLowerCase().replace(/[ /-]/g, "_");
  if (STATES.has(state)) return state;
  if (["pending", "waiting_approval", "requires_approval"].includes(state)) return "requested";
  if (["accept", "accepted", "allow", "allowed"].includes(state)) return "approved";
  if (["deny", "denied", "reject", "rejected"].includes(state)) return "declined";
  if (["running", "in_progress", "started"].includes(state)) return "executing";
  if (["completed", "complete", "success", "succeeded"].includes(state)) return "executed";
  if (["error", "errored", "failure"].includes(state)) return "failed";
  return fallback;
}

function object(value) {
  return value && typeof value === "object" ? value : {};
}

/**
 * Accepts the API worker's action record and the older Codex approval event
 * shape. Unknown fields are preserved by the caller; this UI only displays
 * evidence actually supplied by the runtime.
 */
export function normalizeApprovalAction(input = {}) {
  const source = object(input.action || input.lifecycle || input.approval || input);
  const proposed = object(source.proposedAction || source.proposed || source.item || input.item);
  const metadata = object(source.metadata || source.context || input.context);
  const decision = object(source.decision);
  const result = object(source.result);
  // Event handlers retain the original requested action under `action` and put
  // the newer lifecycle evidence on the wrapper. Prefer that newer evidence.
  const state = normalizeState(first(input.state, input.lifecycleState, input.status, source.state, source.lifecycleState, source.status));
  const command = first(source.command, proposed.command, input.command);
  const path = first(source.path, proposed.path, input.path);
  const operation = first(source.operation, proposed.operation, input.operation);
  const tool = first(source.tool, proposed.tool, input.tool, command ? "workspace_bash" : path ? "workspace_write" : "controlled action");
  const summary = first(source.summary, source.reason, input.summary, input.reason, command ? `Run: ${command}` : path ? `Write: ${path}` : "The worker proposed a controlled action.");
  const detail = first(source.detail, source.description, metadata.detail, metadata.rationale);
  const risk = first(source.risk, metadata.risk, input.risk);
  const resultText = typeof input.result === "string" ? input.result : typeof source.result === "string" ? source.result : first(result.summary, result.text, result.output, source.output, input.result);

  return {
    id: first(source.id, source.requestId, input.id, input.requestId),
    state,
    summary: String(summary),
    detail: detail ? String(detail) : "",
    risk: risk ? String(risk) : "",
    command: command ? String(command) : "",
    path: path ? String(path) : "",
    operation: operation ? String(operation) : "",
    tool: String(tool),
    decision: first(input.decision, decision.value, decision.decision, source.decisionValue, source.decision),
    result: resultText ? String(resultText) : "",
    requestedAt: first(source.requestedAt, source.createdAt, input.requestedAt, input.createdAt),
    decidedAt: first(source.decidedAt, source.decisionAt, input.decidedAt, input.decisionAt),
    startedAt: first(source.startedAt, source.executingAt, input.startedAt, input.executingAt),
    completedAt: first(source.completedAt, source.executedAt, source.failedAt, input.completedAt, input.executedAt, input.failedAt),
  };
}

export function actionTimeline(action) {
  const current = normalizeApprovalAction(action);
  const milestones = [
    ["requested", "Requested", current.requestedAt],
    ["approved", "Approved", current.decidedAt],
    ["executing", "Executing", current.startedAt],
    ["executed", current.state === "failed" ? "Failed" : "Executed", current.completedAt],
  ];
  const order = { requested: 0, approved: 1, declined: 1, executing: 2, executed: 3, failed: 3 };
  return milestones.map(([state, label, at], index) => ({
    state,
    label: current.state === "declined" && state === "approved" ? "Declined" : label,
    at,
    active: index <= order[current.state],
    current: (current.state === "declined" && state === "approved") || (current.state === "failed" && state === "executed") || state === current.state,
  }));
}

export function actionCanBeDecided(action) {
  return normalizeApprovalAction(action).state === "requested";
}
