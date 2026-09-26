import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveDebugCwd, runDebugCommand } = require("../desktop/terminal-service.cjs");

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-terminal-"));
  try { return callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function withTempDirAsync(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-terminal-"));
  try { return await callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test("debug console runs a user command in a permitted local workspace and preserves stderr", async () => withTempDirAsync(async (directory) => {
  const cwd = resolveDebugCwd(directory, [directory]);
  const result = await runDebugCommand({ cwd, command: 'printf "hello"; printf "warning" >&2; exit 3' });
  assert.equal(result.stdout, "hello");
  assert.equal(result.stderr, "warning");
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
}));

test("debug console rejects directories outside its workspace roots", () => withTempDir((directory) => {
  assert.throws(() => resolveDebugCwd(os.tmpdir(), [directory]), /only in the selected workspace/);
}));
