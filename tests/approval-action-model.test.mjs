import assert from "node:assert/strict";
import test from "node:test";
import { actionCanBeDecided, actionTimeline, normalizeApprovalAction } from "../src/approval-action-model.js";

test("normalizes a legacy API command approval without claiming it ran", () => {
  const action = normalizeApprovalAction({ requestId: "r-1", method: "item/commandExecution/requestApproval", reason: "API Worker wants to run: npm test", command: "npm test", item: { id: "call-1", tool: "workspace_bash" } });
  assert.equal(action.state, "requested");
  assert.equal(action.command, "npm test");
  assert.equal(action.tool, "workspace_bash");
  assert.equal(actionCanBeDecided(action), true);
});

test("keeps structured risk, context, decision, and receipt evidence", () => {
  const action = normalizeApprovalAction({ action: { id: "r-2", state: "executed", summary: "Run verification", proposedAction: { tool: "workspace_bash", command: "npm test" }, context: { risk: "May take several minutes", rationale: "Validate the change" }, decision: { value: "accept" }, result: { output: "42 tests passed" }, requestedAt: "2026-09-18T10:00:00Z", decidedAt: "2026-09-18T10:01:00Z", completedAt: "2026-09-18T10:02:00Z" } });
  assert.deepEqual({ state: action.state, risk: action.risk, detail: action.detail, decision: action.decision, result: action.result }, { state: "executed", risk: "May take several minutes", detail: "Validate the change", decision: "accept", result: "42 tests passed" });
  assert.equal(actionTimeline(action).filter((step) => step.active).length, 4);
});

test("declined and failed actions are terminal and cannot be decided again", () => {
  for (const state of ["declined", "failed"]) {
    const action = normalizeApprovalAction({ state, result: "Observed receipt" });
    assert.equal(actionCanBeDecided(action), false);
    assert.equal(actionTimeline(action).some((step) => step.current), true);
  }
});

test("uses newer wrapper lifecycle evidence while retaining the original proposal", () => {
  const action = normalizeApprovalAction({ state: "executed", result: "exit 0", action: { state: "requested", proposedAction: { command: "npm test" } } });
  assert.equal(action.state, "executed");
  assert.equal(action.command, "npm test");
  assert.equal(action.result, "exit 0");
});

test("normalizes a Git approval operation for the same action panel", () => {
  const action = normalizeApprovalAction({ requestId: "git-1", state: "requested", item: { id: "git-call", tool: "workspace_git", operation: "stage" } });
  assert.equal(action.tool, "workspace_git");
  assert.equal(action.operation, "stage");
  assert.equal(actionCanBeDecided(action), true);
});
