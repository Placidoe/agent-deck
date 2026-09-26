import assert from "node:assert/strict";
import test from "node:test";
import { collectWork, outcomeGroups, productSection } from "../src/work-navigation.js";

test("technical views remain under work while outcome detail retains its parent", () => {
  for (const view of ["requirements", "sessions", "mission", "timeline", "usage"]) assert.equal(productSection(view), "work");
  assert.equal(productSection("artifacts"), "results");
  assert.equal(productSection("attention"), "attention");
  assert.equal(productSection("settings"), "settings");
});
test("linked requirement and mission appear once, with authoritative execution state", () => {
  const requirements = [{ id: "r1", missionId: "m1", status: "planning", title: "User goal" }];
  const missions = [{ id: "m1", cwd: "/repo", status: "blocked", title: "Plan title", counts: { tasks: 3 } }];
  const rows = collectWork(requirements, missions, "/repo");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "r1");
  assert.equal(rows[0].title, "User goal");
  assert.equal(rows[0].status, "blocked");
  assert.equal(requirements[0].status, "planning");
});
test("legacy unlinked work remains reachable and workspace-scoped", () => {
  const rows = collectWork([], [{ id: "m1", cwd: "/repo", status: "ready" }, { id: "m2", cwd: "/another", status: "completed" }], "/repo");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].missionId, "m1");
  assert.equal(rows[0].status, "awaiting_approval");
  assert.equal(rows[0].workSource, "mission");
});
test("an unlinked requirement remains a requirement, not an invented execution", () => {
  const rows = collectWork([{ id: "r1", status: "ready_to_plan" }]);
  assert.equal(rows[0].missionId, undefined);
  assert.equal(rows[0].status, "ready_to_plan");
});
test("moved execution remains linked and displays its actual workspace", () => {
  const rows = collectWork([{ id: "r1", missionId: "m1" }], [{ id: "m1", cwd: "/new", status: "ready" }], "/old");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].executionWorkspace, "/new");
});
test("outcomes use registered artifacts, not task completion as fabricated evidence", () => {
  const rows = outcomeGroups([{ id: "empty", status: "completed", counts: { artifacts: 0 } }, { id: "real", title: "Report", counts: { artifacts: 2 }, updatedAt: "2026-09-20" }]);
  assert.deepEqual(rows.map(row => row.id), ["real"]);
  assert.equal(outcomeGroups(rows, "report").length, 1);
  assert.equal(outcomeGroups(rows, "missing").length, 0);
});
