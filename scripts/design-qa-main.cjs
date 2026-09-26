// Isolated visual QA: real ledger snapshot, no providers or orchestration runtime.
const { app, BrowserWindow, ipcMain } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MissionStore } = require("../desktop/mission-store.cjs");
const profile = path.join(os.homedir(), "Library/Application Support/agent-deck-demo");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-design-qa-"));
app.setPath("userData", sandbox);
const db = path.join(sandbox, "snapshot.sqlite3");
execFileSync("/usr/bin/sqlite3", ["-readonly", path.join(profile, "agent-deck.sqlite3"), `.backup '${db}'`]);
const store = new MissionStore(db);
const workspace = JSON.parse(fs.readFileSync(path.join(profile, "workspace.json"), "utf8"));
workspace.name = path.basename(workspace.path);
const reads = {
  "workspace:current": () => workspace,
  "codex:status": () => ({ available: false, authenticated: false, error: "只读布局验收 · 未连接执行器", models: [] }),
  "providers:list": () => [],
  "missions:list": () => store.listMissions(),
  "missions:get": (id) => store.getMission(id),
  "missions:attention": () => store.listAttentionItems(),
  "missions:attention-briefing": () => store.listAttentionBriefing(),
  "missions:events": (input) => store.listEvents(input.missionId, input),
  "missions:sessions": (cwd) => store.listSessionRefs(cwd),
  "missions:save-ui-state": (input) => store.saveUiState(input.missionId, input.patch),
  "requirements:list": (input) => store.listRequirements(input),
  "codex:read-thread": () => { throw new Error("只读验收：不连接真实会话；请查看已持久化的结果与产物。"); },
};
for (const [channel, read] of Object.entries(reads)) ipcMain.handle(channel, (_, input) => read(input));
app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: Number(process.env.AGENT_DECK_QA_WIDTH) || 1540, height: Number(process.env.AGENT_DECK_QA_HEIGHT) || 960, title: "Agent Deck · 只读布局验收",
    titleBarStyle: "hiddenInset", backgroundColor: "#111417",
    webPreferences: { preload: path.resolve(__dirname, "../desktop/preload.cjs"), contextIsolation: true, nodeIntegration: false },
  });
  window.loadFile(path.resolve(__dirname, "../dist/client/index.html"));
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => store.close());
