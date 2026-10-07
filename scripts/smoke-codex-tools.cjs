// Real app-server registration + three real model tool callbacks, confined to
// an ephemeral read-only thread and a disposable ledger. No production mission.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator, workerTools } = require("../desktop/mission-orchestrator.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-tools-smoke-"));
const cwd = path.join(root, "empty"); fs.mkdirSync(cwd);
const store = new MissionStore(path.join(root, "ledger.sqlite3"));
const client = new CodexAppServer();
const orchestrator = new MissionOrchestrator({ codex: client, store, worktrees: {} });
let listener, timer;
(async () => {
  try {
    const created = await client.createThread({ cwd, dynamicTools: workerTools, ephemeral: true, allowMutations: false });
    const mission = store.createMission({ title: "Protocol smoke fixture", outcome: "Three tool receipts", cwd });
    store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, tasks: [{ key: "T1", title: "Protocol only", description: "Synthetic fixture", agentRole: "Smoke worker", dependencies: [], acceptanceCriteria: ["Receipts"], estimatedTokenBudget: 1000 }] });
    store.updateTask(store.getMission(mission.id).tasks[0].id, { agentThreadId: created.thread.id, worktreePath: cwd });
    const calls = [], receipts = [];
    const finished = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Tool smoke exceeded 90 seconds")), 90000);
      listener = event => {
        if (event.params?.threadId !== created.thread.id) return;
        if (event.method === "item/tool/call") {
          calls.push(`${event.params.namespace}.${event.params.tool}`);
          orchestrator.handleCodexEvent(event).catch(reject);
        } else if (event.method === "item/completed" && event.params.item?.type === "dynamicToolCall") {
          receipts.push(event.params.item.success);
        } else if (event.method === "turn/completed") {
          event.params.turn?.status === "completed" ? resolve() : reject(new Error(event.params.turn?.error?.message || "Turn failed"));
        } else if (event.id != null) {
          client.respondToRequest(event.id, null, { code: -32601, message: "Only fixture dynamic tools are allowed" });
        }
      };
      client.on("event", listener);
    });
    finished.catch(() => {});
    await client.sendTurn({ threadId: created.thread.id, cwd, allowMutations: false, effort: "low", prompt: 'This is an isolated protocol test, not a real project. Do not use shell, web, filesystem, other tools, or other agents. Call these three registered agentdeck tools once each in order: 1) list_context with {}; 2) send_message with {"to":"unstarted-teammate","topic":"smoke","message":"Protocol receipt only"}; 3) publish_artifact with {"title":"Smoke receipt","summary":"Protocol only","files":[],"verified":false,"contentType":"reference","dataRich":false}. Read the three results, then say TOOLS_OK. Do not create files or claim substantive work.' });
    await finished;
    const expected = workerTools.map(tool => `agentdeck.${tool.name}`).sort();
    if (JSON.stringify(calls.slice().sort()) !== JSON.stringify(expected) || receipts.length !== 3 || receipts.some(success => success !== true)) throw new Error(`Missing successful receipts: ${JSON.stringify({ calls, receipts })}`);
    if (fs.readdirSync(cwd).length) throw new Error("Read-only fixture folder changed");
    const latest = store.getMission(mission.id);
    if (latest.artifacts.length !== 1 || latest.messages.length !== 1) throw new Error("Host ledger did not record the tool outputs");
    console.log(JSON.stringify({ ok: true, model: created.model, tools: calls, successfulReceipts: receipts.length, sourceUnchanged: true, scope: "real registration and tool routing only; not mission completion/quality/performance" }));
  } finally {
    clearTimeout(timer);
    if (listener) client.off("event", listener);
    client.stop(); store.close(); fs.rmSync(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
