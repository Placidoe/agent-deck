const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { cases } = require("../benchmarks/simple-cases.cjs");

const projectRoot = path.resolve(__dirname, "..");
const evalRoot = path.resolve(projectRoot, "../evals");
const resultDirectory = path.join(evalRoot, "results");
const caseId = String(process.argv[2] || "S1").toUpperCase();
const reasoningEffort = String(process.env.CODEX_EVAL_EFFORT || "medium").toLowerCase();
const timeoutMs = Number(process.env.CODEX_EVAL_TIMEOUT_MS || 600000);
const benchmarkCase = cases[caseId];
if (!benchmarkCase) throw new Error(`Unknown benchmark case ${caseId}. Choose one of: ${Object.keys(cases).join(", ")}`);
if (!["low", "medium", "high", "xhigh"].includes(reasoningEffort)) throw new Error(`Unsupported CODEX_EVAL_EFFORT: ${reasoningEffort}`);
if (!Number.isFinite(timeoutMs) || timeoutMs < 1000) throw new Error(`Invalid CODEX_EVAL_TIMEOUT_MS: ${process.env.CODEX_EVAL_TIMEOUT_MS}`);

const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), `codex-${caseId.toLowerCase()}-control-`));
const repository = path.join(scratchRoot, "repo");
const client = new CodexAppServer();
const approvalMethods = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/gitOperation/requestApproval",
]);

function run(command, args, options = {}) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || repository,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs || 120000,
  });
  return {
    command: [command, ...args].join(" "), status: result.status, signal: result.signal,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: String(result.stdout || "").trim(), stderr: String(result.stderr || "").trim(),
  };
}

function count(output, label) {
  const match = String(output || "").match(new RegExp(`(?:#|ℹ)\\s*${label}\\s+(\\d+)`, "i"));
  return match ? Number(match[1]) : 0;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

async function main() {
  assert.ok(fs.existsSync(path.join(benchmarkCase.seedDirectory, "package.json")));
  fs.cpSync(benchmarkCase.seedDirectory, repository, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: repository });
  execFileSync("/usr/bin/git", ["add", "."], { cwd: repository });
  execFileSync("/usr/bin/git", ["-c", "user.name=Codex Eval", "-c", "user.email=eval@codex.local", "commit", "--quiet", "-m", `${caseId} seed`], { cwd: repository });
  const seedCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  await client.start();
  const startedAt = new Date();
  const clockStart = performance.now();
  const created = await client.createThread({ cwd: repository, title: `CONTROL · ${caseId} ${benchmarkCase.title}`, model: "gpt-5.6-terra" });
  const threadId = created.thread.id;
  const events = [];
  let approvalCount = 0;
  let finalText = "";
  let activeTurnId = null;
  let timer;
  const completed = new Promise((resolve, reject) => {
    timer = setTimeout(async () => {
      if (activeTurnId) await client.interrupt({ threadId, turnId: activeTurnId }).catch(() => {});
      reject(new Error(`${caseId} direct Codex control timed out`));
    }, timeoutMs);
    client.on("event", (event) => {
      if (event.params?.threadId !== threadId) return;
      events.push(event);
      if (approvalMethods.has(event.method) && event.id != null) {
        approvalCount += 1;
        client.respondToApproval({ requestId: event.id, decision: "accept" });
      }
      if (event.method === "item/agentMessage/delta") finalText += event.params?.delta || "";
      if (event.method === "item/completed" && event.params?.item?.type === "agentMessage" && event.params.item.text) finalText = event.params.item.text;
      if (event.method === "error") reject(new Error(event.params?.error?.message || "Codex control failed"));
      if (event.method === "turn/completed") {
        clearTimeout(timer);
        if (event.params?.turn?.status === "completed") resolve(event.params.turn);
        else reject(new Error(event.params?.turn?.error?.message || `Turn ${event.params?.turn?.status}`));
      }
    });
  });

  const turn = await client.sendTurn({ threadId, cwd: repository, prompt: benchmarkCase.taskBrief, model: "gpt-5.6-terra", effort: reasoningEffort });
  activeTurnId = turn.id;
  let completedTurn;
  let turnError = null;
  try {
    completedTurn = await completed;
  } catch (error) {
    turnError = error;
  }
  const claimMs = Math.round(performance.now() - clockStart);
  const publicChecks = run(process.execPath, ["--test"]);
  const hiddenChecks = run(process.execPath, ["--test", benchmarkCase.hiddenGrader], { env: { BENCH_TARGET: repository } });
  const publicOutput = `${publicChecks.stdout}\n${publicChecks.stderr}`;
  const hiddenOutput = `${hiddenChecks.stdout}\n${hiddenChecks.stderr}`;
  const publicPassed = count(publicOutput, "pass");
  const publicTotal = count(publicOutput, "tests") || 1;
  const hiddenPassed = count(hiddenOutput, "pass");
  const hiddenTotal = count(hiddenOutput, "tests") || 1;
  const greenMs = Math.round(performance.now() - clockStart);
  const committedDiff = run("/usr/bin/git", ["diff", `${seedCommit}..HEAD`, "--", "."]);
  const worktreeDiff = run("/usr/bin/git", ["diff", "HEAD", "--", "."]);
  const diff = [committedDiff.stdout, worktreeDiff.stdout].filter(Boolean).join("\n");
  const usageEvent = [...events].reverse().find((event) => event.method === "thread/tokenUsage/updated");
  const usage = usageEvent?.params?.tokenUsage?.last || completedTurn?.usage || completedTurn?.tokenUsage || null;
  const result = {
    schemaVersion: "agent-deck-eval/v1",
    caseId,
    group: "direct_codex",
    model: created.model || "gpt-5.6-terra",
    reasoningEffort,
    startedAt: startedAt.toISOString(),
    seedCommit,
    threadId,
    metrics: {
      tClaimSec: Number((claimMs / 1000).toFixed(3)),
      tGreenSec: Number((greenMs / 1000).toFixed(3)),
      deterministicScore: Number((((hiddenPassed / hiddenTotal) * 45) + ((publicPassed / publicTotal) * 20) + (publicChecks.status === 0 ? 15 : 0)).toFixed(1)),
      deterministicScoreMax: 80,
      publicChecksPassed: publicPassed, publicChecksTotal: publicTotal,
      hiddenChecksPassed: hiddenPassed, hiddenChecksTotal: hiddenTotal,
      humanTouches: approvalCount, workerCount: 1,
      providerTokens: usage?.total_tokens || usage?.totalTokens || null,
      providerUsage: usage ? {
        totalTokens: usage.total_tokens || usage.totalTokens || 0,
        inputTokens: usage.input_tokens || usage.inputTokens || usage.prompt_tokens || usage.promptTokens || 0,
        cachedInputTokens: usage.cached_input_tokens || usage.cachedInputTokens || 0,
        outputTokens: usage.output_tokens || usage.outputTokens || usage.completion_tokens || usage.completionTokens || 0,
        reasoningOutputTokens: usage.reasoning_output_tokens || usage.reasoningOutputTokens || 0,
      } : null,
      toolEvents: events.filter((event) => ["item/started", "item/completed"].includes(event.method) && ["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"].includes(event.params?.item?.type)).length,
      graderSec: Number(((publicChecks.durationMs + hiddenChecks.durationMs) / 1000).toFixed(3)),
    },
    status: !turnError && publicChecks.status === 0 && hiddenChecks.status === 0 ? "passed" : turnError ? "runtime_failed" : "failed",
    runtimeError: turnError?.message || null,
    checks: { public: publicChecks, hidden: hiddenChecks },
    evidence: {
      finalText: finalText.slice(0, 12000),
      diff,
      eventSummary: events.filter((event) => !event.method.endsWith("/delta") && event.method !== "thread/tokenUsage/updated").map((event) => ({
        method: event.method,
        itemType: event.params?.item?.type || null,
        itemStatus: event.params?.item?.status || null,
      })),
    },
  };
  fs.mkdirSync(resultDirectory, { recursive: true });
  const outputPath = process.env.AGENT_DECK_EVAL_OUTPUT || path.join(resultDirectory, `${caseId.toLowerCase()}-control-${reasoningEffort}-${safeTimestamp()}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, checks: undefined, evidence: { diffFiles: diff.match(/^diff --git/gm)?.length || 0 }, outputPath }, null, 2)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  client.stop();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});
