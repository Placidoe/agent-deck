import assert from "node:assert/strict";
import test from "node:test";
import { canChangeMissionWorkspace, isWorkspaceBlocker, nextMissionAction } from "../src/mission-next-action.js";
import { criticalMissionPath, dependencyImpact } from "../src/mission-graph.js";
import { reviewGate, reviewGateGuidance } from "../src/review-gate.js";

const task = (key, status, extra = {}) => ({ id: key, key, title: `${key} title`, status, ...extra });

test("legacy and new workspace blockers have actionable non-chat guidance", () => {
  for (const error of ["Worktree isolation unavailable: fatal: not a git repository", "[not_git_repository] select a project", "[missing_git_head] commit first"]) {
    const blocked = task("T1", "blocked", { error });
    const mission = { status: "blocked", cwd: "/projects", spec: {}, tasks: [blocked] };
    assert.equal(isWorkspaceBlocker(blocked), true);
    assert.match(nextMissionAction(mission).title, /工作区/);
    assert.equal(canChangeMissionWorkspace(mission), true);
    assert.equal(canChangeMissionWorkspace({ ...mission, activeTurnId: "running" }), false);
    for (const extra of [{ agentThreadId: "thread" }, { worktreePath: "/worktree" }, { branch: "branch" }, { status: "claiming" }]) {
      assert.equal(canChangeMissionWorkspace({ ...mission, tasks: [{ ...blocked, ...extra }] }), false);
    }
  }
  assert.equal(isWorkspaceBlocker(task("T1", "blocked", { error: "Dependency merge conflict" })), false);
});

test("next mission action prioritizes explicit permission over review and launch state", () => {
  const action = nextMissionAction({ status: "ready", tasks: [task("T1", "review"), task("T2", "waiting_approval")] });
  assert.equal(action.kind, "approval");
  assert.equal(action.task.key, "T2");
  assert.equal(action.panel, "conversation");
});

test("next mission action gives a blocked worker its persisted error and recovery view", () => {
  const action = nextMissionAction({ status: "running", tasks: [task("T4", "blocked", { error: "Dependency merge conflict" })] });
  assert.equal(action.kind, "blocked");
  assert.match(action.detail, /Dependency merge conflict/);
  assert.equal(action.panel, "evidence");
});

test("next mission action keeps ready plans human-gated", () => {
  const action = nextMissionAction({ status: "ready", tasks: [task("T1", "queued"), task("T2", "queued")] });
  assert.equal(action.kind, "plan");
  assert.equal(action.primaryLabel, "审阅计划");
  assert.match(action.detail, /才会创建真实 Thread/);
});

test("DAG impact identifies the longest dependency chain and real downstream work", () => {
  const tasks = [
    task("T1", "completed", { dependencies: [] }),
    task("T2", "completed", { dependencies: ["T1"] }),
    task("T3", "running", { dependencies: ["T2"] }),
    task("T4", "queued", { dependencies: ["T1"] }),
  ];
  assert.deepEqual(criticalMissionPath(tasks).keys, ["T1", "T2", "T3"]);
  assert.deepEqual(dependencyImpact(tasks, "T1"), { upstream: [], downstream: ["T2", "T3", "T4"], pendingDownstream: ["T3", "T4"] });
});

test("review gate never accepts an empty or blocked result", () => {
  assert.deepEqual(reviewGate({ acceptance: [] }), { total: 0, passed: 0, blockers: 0, ready: false });
  assert.equal(reviewGate({ acceptance: [{ passed: true }, { passed: false }] }).ready, false);
  assert.equal(reviewGate({ acceptance: [{ passed: true }], blockers: ["merge conflict"] }).ready, false);
  assert.deepEqual(reviewGate({ acceptance: [{ passed: true }, { passed: true }], blockers: [] }), { total: 2, passed: 2, blockers: 0, ready: true });
});

test("review gate explains why accept is unavailable and prepares actionable feedback", () => {
  const guidance = reviewGateGuidance({
    acceptance: [{ criterion: "Evidence is traceable", passed: true }],
    blockers: ["Product owner must confirm Q01-Q07"],
  });
  assert.deepEqual(guidance.issues, ["Product owner must confirm Q01-Q07"]);
  assert.match(guidance.feedback, /请处理以下验收阻塞项/);
  assert.match(guidance.feedback, /Q01-Q07/);

  const failed = reviewGateGuidance({ acceptance: [{ criterion: "Tests pass", passed: false }], blockers: [] });
  assert.deepEqual(failed.issues, ["验收项未通过：Tests pass"]);
  assert.match(failed.feedback, /Tests pass/);
});
