const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const MAX_COMMAND_LENGTH = 8_000;
const MAX_OUTPUT_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

function canonicalDirectory(input) {
  if (!input || !fs.existsSync(input)) throw new Error("Debug workspace no longer exists");
  const resolved = fs.realpathSync(input);
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Debug workspace must be a directory");
  return resolved;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolveDebugCwd(requestedCwd, allowedRoots) {
  const roots = [...new Set((allowedRoots || []).filter(Boolean).map(canonicalDirectory))];
  if (!roots.length) throw new Error("Choose a local workspace before using the debug console");
  const candidate = canonicalDirectory(requestedCwd || roots[0]);
  if (!roots.some((root) => isInside(root, candidate))) throw new Error("Debug commands may run only in the selected workspace or its Mission worktrees");
  return candidate;
}

function appendOutput(current, chunk) {
  if (current.length >= MAX_OUTPUT_BYTES) return current;
  return `${current}${String(chunk || "").slice(0, MAX_OUTPUT_BYTES - current.length)}`;
}

function runDebugCommand({ command, cwd, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const normalizedCommand = String(command || "").trim();
  if (!normalizedCommand) throw new Error("Enter a Bash command to run");
  if (normalizedCommand.length > MAX_COMMAND_LENGTH) throw new Error(`Debug commands are limited to ${MAX_COMMAND_LENGTH} characters`);
  const startedAt = Date.now();
  const shellPath = fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash";
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(shellPath, ["-lc", normalizedCommand], {
      cwd,
      env: { ...process.env, TERM: "xterm-256color", AGENT_DECK_DEBUG: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: normalizedCommand, cwd, stdout, stderr, durationMs: Date.now() - startedAt, truncated: stdout.length >= MAX_OUTPUT_BYTES || stderr.length >= MAX_OUTPUT_BYTES, ...result });
    };
    child.stdout.on("data", (chunk) => { stdout = appendOutput(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = appendOutput(stderr, chunk); });
    child.on("error", (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
    child.on("close", (code, signal) => finish({ exitCode: code == null ? 1 : code, signal: signal || null, timedOut }));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, Math.max(1_000, Math.min(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)));
  });
}

module.exports = { MAX_OUTPUT_BYTES, resolveDebugCwd, runDebugCommand };
