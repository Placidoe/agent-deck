import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { cases } = require("../benchmarks/simple-cases.cjs");

function run(command, args, options = {}) {
  const env = { ...process.env, ...(options.env || {}) };
  delete env.NODE_TEST_CONTEXT;
  return spawnSync(command, args, { encoding: "utf8", ...options, env });
}

for (const item of Object.values(cases)) {
  test(`${item.id} seed exposes public checks and is rejected by hidden checks`, () => {
    const publicResult = run(process.execPath, ["--test"], { cwd: item.seedDirectory });
    assert.match(`${publicResult.stdout}\n${publicResult.stderr}`, /(?:tests|pass|fail)\s+\d+/i, "public checks did not execute");
    const hiddenResult = run(process.execPath, ["--test", item.hiddenGrader], { cwd: item.seedDirectory, env: { BENCH_TARGET: item.seedDirectory } });
    assert.notEqual(hiddenResult.status, 0, `${item.id} seed unexpectedly passed the hidden grader`);
    assert.match(`${hiddenResult.stdout}\n${hiddenResult.stderr}`, /fail|AssertionError|not ok|✖/i);
  });
}

test("simple benchmark registry points only to self-contained versioned fixtures", () => {
  assert.deepEqual(Object.keys(cases), ["S1", "S2", "S3"]);
  for (const item of Object.values(cases)) {
    assert.ok(fs.existsSync(path.join(item.seedDirectory, "package.json")));
    assert.ok(fs.existsSync(item.hiddenGrader));
    assert.ok(item.taskBrief.length > 40);
  }
});

test("S2 hidden grader accepts a safe cycle-preserving implementation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-s2-reference-"));
  try {
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "package.json"), '{"type":"module"}\n');
    fs.writeFileSync(path.join(root, "src", "redact-secrets.js"), `
const SECRET = new Set(["token", "password", "apikey", "authorization"]);
export function redactSecrets(value) {
  const seen = new WeakMap();
  function copy(input) {
    if (input === null || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    const output = Array.isArray(input) ? [] : {};
    seen.set(input, output);
    for (const key of Object.keys(input)) {
      output[key] = SECRET.has(key.toLowerCase()) ? "[REDACTED]" : copy(input[key]);
    }
    return output;
  }
  return copy(value);
}
`);
    const result = run(process.execPath, ["--test", cases.S2.hiddenGrader], { cwd: root, env: { BENCH_TARGET: root } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("S3 hidden grader accepts a compatible JSON implementation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-s3-reference-"));
  try {
    fs.cpSync(cases.S3.seedDirectory, root, { recursive: true });
    fs.writeFileSync(path.join(root, "bin", "task-summary.js"), `#!/usr/bin/env node
import fs from "node:fs";
import { summarizeTasks, toText } from "../src/task-summary.js";
const args = process.argv.slice(2);
const unknown = args.find(value => value.startsWith("-") && value !== "--json");
if (unknown) { console.error(\`Unknown flag: \${unknown}\`); process.exit(2); }
const json = args.includes("--json");
const file = args.find(value => !value.startsWith("-"));
if (!file) { console.error("Usage: task-summary [--json] <tasks.json>"); process.exit(2); }
const tasks = JSON.parse(fs.readFileSync(file, "utf8"));
const summary = summarizeTasks(tasks);
if (json) process.stdout.write(JSON.stringify({ version: 1, ...summary, tasks: tasks.map(({ id, status }) => ({ id, status })) }) + "\\n");
else process.stdout.write(toText(summary));
`);
    const result = run(process.execPath, ["--test", cases.S3.hiddenGrader], { cwd: root, env: { BENCH_TARGET: root } });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
