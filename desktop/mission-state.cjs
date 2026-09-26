const MISSION_STATES = Object.freeze([
  "planning", "ready", "running", "review", "blocked", "ready_to_integrate",
  "integrating", "integration_conflict", "completed", "failed", "canceled",
]);

const TASK_STATES = Object.freeze([
  "queued", "claiming", "running", "waiting_approval", "review", "blocked", "completed", "canceled",
]);

function assertMissionState(status) {
  if (!MISSION_STATES.includes(status)) throw new Error(`Unknown Mission state: ${status}`);
  return status;
}

function assertTaskState(status) {
  if (!TASK_STATES.includes(status)) throw new Error(`Unknown Task state: ${status}`);
  return status;
}

function runStatusForProvider(status) {
  if (status === "completed") return "completed";
  if (status === "interrupted") return "interrupted";
  if (status === "canceled") return "canceled";
  return status || "failed";
}

module.exports = { MISSION_STATES, TASK_STATES, assertMissionState, assertTaskState, runStatusForProvider };
