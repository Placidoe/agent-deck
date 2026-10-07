// Owned disposable fixture only. Never alters production preferences/ledger or
// interrupts another app-server. Full permissions are tested with one harmless file.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-autonomy-smoke-"));
const cwd = path.join(root, "source"); fs.mkdirSync(cwd);
const git = (...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
git("init", "-q"); git("config", "user.name", "QA"); git("config", "user.email", "qa@example.test");
fs.writeFileSync(path.join(cwd, "seed.txt"), "Disposable QA fixture.\n"); git("add", "seed.txt"); git("commit", "-qm", "fixture");
const store = new MissionStore(path.join(root, "test.sqlite3"));
const runtime = new CodexAppServer();
const orchestrator = new MissionOrchestrator({ codex: runtime, store, worktrees: new WorktreeManager(path.join(root, "worktrees")) });
runtime.on("event", event => orchestrator.handleCodexEvent(event).catch(error => { console.error(error.message); process.exitCode = 1; }));
let missionId; let timer;
async function main() {
  const mission = store.createMission({ title: "Autonomous smoke fixture", outcome: "Create proof.txt containing exactly AUTONOMOUS_OK in your assigned worktree. No network, delegation, installations, publication or changes outside this fixture.", cwd, executionMode: "code", interactionMode: "autonomous" });
  missionId = mission.id;
  store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, scope: ["proof.txt"], constraints: ["Only the assigned disposable worktree"], nonGoals: ["No network or unrelated changes"], acceptanceCriteria: ["proof.txt contains exactly AUTONOMOUS_OK"], tasks: [{ key: "PROOF", title: "Create a harmless proof file", description: mission.outcome, dependencies: [], agentRole: "Fixture writer", acceptanceCriteria: ["proof.txt contains exactly AUTONOMOUS_OK"], estimatedTokenBudget: 1500 }] });
  const finished = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Autonomous smoke exceeded its three-minute budget")), 180000);
    orchestrator.on("update", () => {
      const current = store.getMission(missionId);
      if (current.status === "completed") resolve(current);
      else if (["blocked", "failed", "integration_conflict"].includes(current.status)) reject(new Error(current.error || current.tasks.find(task => task.error)?.error || current.status));
    });
  });
  orchestrator.autonomous.schedule(missionId);
  const result = await finished;
  if (fs.readFileSync(path.join(result.integrationPath, "proof.txt"), "utf8") !== "AUTONOMOUS_OK") throw new Error("Integrated output does not satisfy fixture");
  const events = store.listEvents(missionId, { limit: 500 }).items;
  const checks = events.filter(event => event.type === "autonomous.check.completed");
  if (checks.length !== 2 || checks.some(event => !event.payload.passed || !event.payload.receipts)) throw new Error("Node and final checks must independently inspect output");
  console.log(JSON.stringify({ status: result.status, model: result.model, mode: result.interactionMode, selfChecks: checks.length, selfCheckEffort: "low", artifacts: result.artifacts.map(artifact => artifact.verificationStatus), humanMessages: result.messages.filter(message => message.source === "user").length, pendingApprovals: events.filter(event => /requestApproval/.test(event.type)).length, fixture: root }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timer);
  if (missionId && !["completed", "canceled"].includes(store.getMissionStatus(missionId))) await orchestrator.cancel(missionId).catch(() => {});
  orchestrator.autonomous.stop(); runtime.stop(); store.close();
});
