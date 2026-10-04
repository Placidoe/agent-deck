// Isolated visual QA: real ledger snapshot, no providers or orchestration runtime.
const { app, BrowserWindow, ipcMain } = require("electron");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { ArtifactService } = require("../desktop/artifact-service.cjs");
const { LibraryService } = require("../desktop/library-service.cjs");
const profile = path.join(os.homedir(), "Library/Application Support/agent-deck-demo");
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-design-qa-"));
app.setPath("userData", sandbox);
const db = path.join(sandbox, "snapshot.sqlite3");
execFileSync("/usr/bin/sqlite3", ["-readonly", path.join(profile, "agent-deck.sqlite3"), `.backup '${db}'`]);
const store = new MissionStore(db);
let workspaceQaCandidate;
// Explicitly labelled layout scenario in the disposable snapshot only.
if (process.env.AGENT_DECK_WORKSPACE_QA) {
  const candidate = store.listMissions().map(item => store.getMission(item.id)).find(item => item.spec && ["ready", "blocked"].includes(item.status) && item.tasks.every(task => !task.agentThreadId && !task.worktreePath));
  if (!candidate) throw new Error("No unstarted real-ledger plan available for workspace layout QA");
  workspaceQaCandidate = candidate;
  store.updateMission(candidate.id, { executionMode: "auto", status: "ready", activeTurnId: null, error: null, spec: { ...candidate.spec, workspace: { strategy: "initialize_git", reason: "布局测试场景（不是模型输出）：工作区准备说明与逐项文件清单应保持清晰可读；原计划和账本来自只读副本。", trackedFiles: Array.from({ length: 20 }, (_, index) => `src/long-folder-name/component-${index}/representative-file-for-layout.js`) } } });
}
const artifacts = new ArtifactService({ store });
const library = new LibraryService({ store, artifacts });
const modelClient = process.env.AGENT_DECK_MODEL_QA ? new (require("../desktop/codex-app-server.cjs").CodexAppServer)() : null;
if (process.env.AGENT_DECK_WORKFLOW_QA) store.library.createFolder({ name: "产品文档 · 只读测试", rootPath: fs.realpathSync(path.join(__dirname, "../docs")) });
const workspace = JSON.parse(fs.readFileSync(path.join(profile, "workspace.json"), "utf8"));
if (workspaceQaCandidate) workspace.path = workspaceQaCandidate.cwd;
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
  "missions:planner-models": () => {
    if (!modelClient) throw new Error("只读布局验收未连接模型目录。");
    return modelClient.listModels({ refresh: true });
  },
  "requirements:list": (input) => store.listRequirements(input),
  "requirements:create": input => store.createRequirement(input),
  "requirements:update": input => store.updateRequirement(input.id, input.patch),
  "personal:projects": () => store.personal.listProjects(),
  "library:overview": () => store.library.overview(),
  "library:files": input => store.library.files(input),
  "library:history": input => store.library.history(input),
  "library:sessions": input => store.library.sessions(input),
  "library:create-folder": input => store.library.createFolder({ name: input.name, parentId: input.parentId || null }),
  "library:assign": input => store.library.assign(input),
  "library:browse": input => library.browse(input),
  "library:preview": input => library.preview(input),
  "artifacts:inspect": input => artifacts.inspect(input),
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
app.on("will-quit", () => { modelClient?.stop(); store.close(); });
