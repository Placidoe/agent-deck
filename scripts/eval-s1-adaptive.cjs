const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { cases } = require("../benchmarks/simple-cases.cjs");

const projectRoot = path.resolve(__dirname, "..");
const evalRoot = path.resolve(projectRoot, "../evals");
const caseId = String(process.argv[2] || "S1").toUpperCase();
const benchmarkCase = cases[caseId];
if (!benchmarkCase) throw new Error(`Unknown benchmark case ${caseId}. Choose one of: ${Object.keys(cases).join(", ")}`);
const seedDirectory = benchmarkCase.seedDirectory;
const hiddenGrader = benchmarkCase.hiddenGrader;
const resultDirectory = path.join(evalRoot, "results");
const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), `agent-deck-${caseId.toLowerCase()}-adaptive-`));
const repository = path.join(scratchRoot, "repo");
const client = new CodexAppServer();

const taskBrief = benchmarkCase.taskBrief;

function run(command, args, options = {}) {
  const startedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd: options.cwd || repository,
    encoding: "utf8",
    env: { ...process.env, ...(options.env || {}) },
    timeout: options.timeoutMs || 120000,
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status,
    signal: result.signal,
    durationMs: Math.round(performance.now() - startedAt),
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
  };
}

function waitFor(read, predicate, timeoutMs = 600000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setInterval(() => {
      try {
        const value = read();
        if (predicate(value)) {
          clearInterval(timer);
          resolve(value);
        } else if (Date.now() - startedAt > timeoutMs) {
          clearInterval(timer);
          reject(new Error(`${caseId} timed out in Mission status ${value?.status || "unknown"}`));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 250);
  });
}

function countPassingTests(output) {
  const match = String(output || "").match(/(?:#|ℹ)\s*pass\s+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function countTotalTests(output) {
  const match = String(output || "").match(/(?:#|ℹ)\s*tests\s+(\d+)/i);
  return match ? Number(match[1]) : 0;
}

function safeTimestamp() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function eventTime(events, type, predicate = () => true) {
  const event = events.find((item) => item.type === type && predicate(item));
  return event ? Date.parse(event.createdAt) : null;
}

function durationSeconds(from, to) {
  return Number.isFinite(from) && Number.isFinite(to) && to >= from ? Number(((to - from) / 1000).toFixed(3)) : null;
}

async function main() {
  assert.ok(fs.existsSync(path.join(seedDirectory, "package.json")), `Missing ${caseId} seed directory: ${seedDirectory}`);
  assert.ok(fs.existsSync(hiddenGrader), `Missing ${caseId} hidden grader: ${hiddenGrader}`);
  fs.cpSync(seedDirectory, repository, { recursive: true });
  execFileSync("/usr/bin/git", ["init", "--quiet"], { cwd: repository });
  execFileSync("/usr/bin/git", ["add", "."], { cwd: repository });
  execFileSync("/usr/bin/git", ["-c", "user.name=Agent Deck Eval", "-c", "user.email=eval@agent-deck.local", "commit", "--quiet", "-m", `${caseId} seed`], { cwd: repository });
  const seedCommit = execFileSync("/usr/bin/git", ["rev-parse", "HEAD"], { cwd: repository, encoding: "utf8" }).trim();

  const store = new MissionStore(path.join(scratchRoot, "agent-deck.sqlite3"));
  const worktrees = new WorktreeManager(path.join(scratchRoot, "worktrees"));
  const orchestrator = new MissionOrchestrator({ codex: client, store, worktrees });
  const eventErrors = [];
  client.on("event", (event) => {
    orchestrator.handleCodexEvent(event).catch((error) => eventErrors.push(error));
  });

  await client.start();
  const startedAt = new Date();
  const clockStart = performance.now();
  const mission = await orchestrator.create({
    title: `${caseId} ${benchmarkCase.title} benchmark`,
    outcome: taskBrief,
    sourcePrompt: taskBrief,
    cwd: repository,
    orchestrationMode: "adaptive",
    executionMode: "code",
    valueContract: {
      scenario: "研发交付基准评测",
      valueType: "time_saved",
      targetMetric: "Public and hidden S1 checks pass",
      tokenBudget: 20000,
    },
  });

  assert.equal(mission.spec?.runtime?.mode, "direct", `${caseId} must route to Direct mode`);
  assert.equal(mission.mainThreadId, null, "Direct mode must skip the Planner thread");
  assert.equal(mission.tasks.length, 1, "Direct mode must create one Worker");

  const terminal = await waitFor(
    () => store.getMission(mission.id),
    (snapshot) => ["review", "blocked", "failed", "canceled"].includes(snapshot.status),
  );
  const claimMs = Math.round(performance.now() - clockStart);
  if (eventErrors.length) throw new Error(eventErrors.map((error) => error.message).join("; "));
  assert.equal(terminal.status, "review", terminal.error || terminal.tasks[0]?.error || `${caseId} did not reach review`);

  const task = terminal.tasks[0];
  await orchestrator.acceptTask(mission.id, task.id);
  const completed = store.getMission(mission.id, { eventLimit: 500, messageLimit: 100, artifactLimit: 100 });
  const gradePath = completed.integrationPath || task.worktreePath;
  const publicChecks = run(process.execPath, ["--test"], { cwd: gradePath });
  const hiddenChecks = run(process.execPath, ["--test", hiddenGrader], {
    cwd: gradePath,
    env: { BENCH_TARGET: gradePath },
  });
  const publicPassed = countPassingTests(`${publicChecks.stdout}\n${publicChecks.stderr}`);
  const hiddenPassed = countPassingTests(`${hiddenChecks.stdout}\n${hiddenChecks.stderr}`);
  const publicTotal = countTotalTests(`${publicChecks.stdout}\n${publicChecks.stderr}`) || 3;
  const hiddenTotal = countTotalTests(`${hiddenChecks.stdout}\n${hiddenChecks.stderr}`) || 7;
  const greenMs = Math.round(performance.now() - clockStart);
  const ledger = store.valueLedger(mission.id);
  const deterministicScore = Number((((hiddenPassed / hiddenTotal) * 45) + ((publicPassed / publicTotal) * 20) + (publicChecks.status === 0 ? 15 : 0)).toFixed(1));
  const diff = run("/usr/bin/git", ["diff", `${seedCommit}..HEAD`, "--", "src", "test"], { cwd: gradePath });
  const missionCreatedAt = eventTime(completed.events, "mission.created");
  const workerStartedAt = eventTime(completed.events, "provider.turn/started", (event) => event.taskId === task.id)
    || eventTime(completed.events, "worker.turn.started", (event) => event.taskId === task.id);
  const workerCompletedAt = eventTime(completed.events, "provider.turn/completed", (event) => event.taskId === task.id);
  const missionCompletedAt = eventTime(completed.events, "mission.completed");
  const workerRouteEvent = completed.events.find((event) => event.type === "worker.turn.started" && event.taskId === task.id);
  const result = {
    schemaVersion: "agent-deck-eval/v1",
    caseId,
    group: "agent_deck_adaptive",
    model: completed.model || null,
    reasoningEffort: workerRouteEvent?.payload?.reasoningEffort || null,
    startedAt: startedAt.toISOString(),
    seedCommit,
    missionId: mission.id,
    route: mission.spec.runtime,
    metrics: {
      tClaimSec: Number((claimMs / 1000).toFixed(3)),
      tGreenSec: Number((greenMs / 1000).toFixed(3)),
      deterministicScore,
      deterministicScoreMax: 80,
      fullQualityScore: null,
      qualityNote: "The remaining 20 points require scoped implementation-quality and evidence review.",
      publicChecksPassed: publicPassed,
      publicChecksTotal: publicTotal,
      hiddenChecksPassed: hiddenPassed,
      hiddenChecksTotal: hiddenTotal,
      humanTouches: 1,
      workerCount: completed.tasks.filter((item) => item.agentThreadId).length,
      plannerTurns: completed.events.filter((event) => event.type === "planner.turn.started").length,
      providerTokens: ledger.costs.tokenSource === "provider_reported" ? ledger.costs.billedTokens : null,
      estimatedTokens: ledger.costs.tokenSource === "local_estimate" ? ledger.costs.estimatedTokens : null,
      tokenSource: ledger.costs.tokenSource,
      recordedEvents: completed.events.length,
      phases: {
        controlPlaneSec: durationSeconds(missionCreatedAt, workerStartedAt),
        workerTurnSec: durationSeconds(workerStartedAt, workerCompletedAt),
        integrationSec: durationSeconds(workerCompletedAt, missionCompletedAt),
        graderSec: Number(((publicChecks.durationMs + hiddenChecks.durationMs) / 1000).toFixed(3)),
      },
    },
    status: publicChecks.status === 0 && hiddenChecks.status === 0 && completed.status === "completed" ? "passed" : "failed",
    checks: { public: publicChecks, hidden: hiddenChecks },
    evidence: {
      changedFiles: task.result?.observedChanges?.files || task.result?.changedFiles || [],
      taskCommit: completed.tasks[0]?.commitHash || null,
      integrationCommit: completed.integrationCommit || null,
      workerThreadId: task.agentThreadId || null,
      diff: diff.stdout,
    },
  };

  fs.mkdirSync(resultDirectory, { recursive: true });
  const outputPath = process.env.AGENT_DECK_EVAL_OUTPUT || path.join(resultDirectory, `${caseId.toLowerCase()}-adaptive-${safeTimestamp()}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ ...result, checks: undefined, outputPath }, null, 2)}\n`);
  if (result.status !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  client.stop();
  fs.rmSync(scratchRoot, { recursive: true, force: true });
});
