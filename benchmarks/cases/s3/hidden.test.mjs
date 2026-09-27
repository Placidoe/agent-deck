import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";

const target = process.env.BENCH_TARGET;
if (!target) throw new Error("BENCH_TARGET must point to a completed S3 workspace");
const cli = path.join(target, "bin", "task-summary.js");
const fixture = path.join(target, "fixtures", "tasks.json");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], { cwd: target, encoding: "utf8" });
}

test("default output remains byte-for-byte compatible", () => {
  const result = run([fixture]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Tasks: 3\nCompleted: 1\nPending: 2\n");
  assert.equal(result.stderr, "");
});

test("JSON output follows the documented stable schema", () => {
  const result = run(["--json", fixture]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    version: 1,
    total: 3,
    completed: 1,
    pending: 2,
    tasks: [
      { id: "T1", status: "completed" },
      { id: "T2", status: "running" },
      { id: "T3", status: "queued" },
    ],
  });
});

test("accepts --json after the input path", () => {
  const result = run([fixture, "--json"]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).version, 1);
});

test("unknown flags exit with code 2 without normal output", () => {
  const result = run(["--yaml", fixture]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /unknown|invalid|usage/i);
});

test("missing input exits with code 2", () => {
  const result = run(["--json"]);
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
});

