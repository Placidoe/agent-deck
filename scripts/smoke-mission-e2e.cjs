const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-live-e2e-"));
const repository = path.join(root, "repo");
const client = new CodexAppServer();

function git(args, cwd = repository) {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8" }).trim();
}

function waitFor(read, predicate, timeoutMs = 180000) {
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
          reject(new Error(`Live mission timed out in status ${value?.status || "unknown"}`));
        }
      } catch (error) {
        clearInterval(timer);
        reject(error);
      }
    }, 250);
  });
}

async function main() {
  fs.mkdirSync(repository);
  git(["init", "-q"]);
  fs.writeFileSync(path.join(repository, "README.md"), "Agent Deck live integration fixture\n");
  git(["add", "README.md"]);
  git(["-c", "user.name=Agent Deck", "-c", "user.email=agent-deck@localhost", "commit", "-q", "-m", "baseline"]);

  const store = new MissionStore(path.join(root, "agent-deck.sqlite3"));
  const worktrees = new WorktreeManager(path.join(root, "worktrees"));
  const orchestrator = new MissionOrchestrator({ codex: client, store, worktrees });
  const eventErrors = [];
  client.on("event", (event) => {
    orchestrator.handleCodexEvent(event).catch((error) => eventErrors.push(error));
  });

  await client.start();
  const mission = await orchestrator.create({
    title: "Live Codex filesystem mission",
    outcome: "Create a verified file through a real Codex worker",
    sourcePrompt: "Create LIVE_CODEX_RESULT.txt containing exactly: codex worker completed",
    cwd: repository,
    orchestrationMode: "adaptive",
    tokenBudget: 20000,
  });
  assert.equal(mission.mainThreadId, null);
  assert.equal(mission.spec.runtime.mode, "direct");
  assert.equal(mission.tasks.length, 1);
  assert.equal(mission.events.filter((event) => event.type === "planner.turn.started").length, 0);
  const reviewMission = await waitFor(
    () => store.getMission(mission.id),
    (snapshot) => ["review", "blocked", "failed"].includes(snapshot.status),
  );
  assert.equal(eventErrors.length, 0, eventErrors.map((error) => error.message).join("; "));
  assert.equal(reviewMission.status, "review", reviewMission.error || reviewMission.tasks[0]?.error);
  const task = reviewMission.tasks[0];
  assert.equal(task.status, "review");
  assert.equal(fs.readFileSync(path.join(task.worktreePath, "LIVE_CODEX_RESULT.txt"), "utf8"), "codex worker completed\n");
  assert.deepEqual(task.result.observedChanges.files, ["LIVE_CODEX_RESULT.txt"]);

  await orchestrator.acceptTask(mission.id, task.id);
  const integrated = store.getMission(mission.id);
  assert.equal(integrated.status, "completed", integrated.error);
  assert.match(integrated.tasks[0].commitHash, /^[a-f0-9]{40}$/);
  assert.equal(fs.readFileSync(path.join(integrated.integrationPath, "LIVE_CODEX_RESULT.txt"), "utf8"), "codex worker completed\n");
  assert.match(integrated.integrationCommit, /^[a-f0-9]{40}$/);
  console.log(JSON.stringify({
    ok: true,
    missionId: integrated.id,
    workerThreadId: integrated.tasks[0].agentThreadId,
    taskCommit: integrated.tasks[0].commitHash,
    integrationBranch: integrated.integrationBranch,
    integrationCommit: integrated.integrationCommit,
    observedFiles: integrated.tasks[0].result.observedChanges.files,
    providerEvents: integrated.events.filter((event) => event.type.startsWith("provider.")).length,
  }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => {
  client.stop();
  fs.rmSync(root, { recursive: true, force: true });
});
