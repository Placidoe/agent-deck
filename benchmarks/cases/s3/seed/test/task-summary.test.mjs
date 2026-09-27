import assert from "node:assert/strict";
import test from "node:test";
import { summarizeTasks, toText } from "../src/task-summary.js";

test("keeps the default text format stable", () => {
  const summary = summarizeTasks([{ status: "completed" }, { status: "queued" }]);
  assert.equal(toText(summary), "Tasks: 2\nCompleted: 1\nPending: 1\n");
});
