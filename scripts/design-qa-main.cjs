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
// Permission UX fixture only: isolated settings, no runtime, no live writes.
const autonomyRegistry = process.env.AGENT_DECK_AUTONOMY_QA ? new (require("../desktop/provider-registry.cjs").ProviderRegistry)({ userDataPath: sandbox }) : null;
globalThis.autonomyConsentResponse = false;
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
// Exercise the actual approve controller against the disposable real ledger.
// Transport is deliberately a no-inference stub; no real worker is dispatched.
const approveQa = process.env.AGENT_DECK_APPROVE_QA ? new (require("../desktop/mission-orchestrator.cjs").MissionOrchestrator)({
  store, worktrees: new (require("../desktop/worktree-manager.cjs").WorktreeManager)(path.join(sandbox, "worktrees")),
  codex: { createThread: async input => {
    if (input.allowMutations !== false) throw new Error("QA prohibits workers");
    return { thread: { id: "qa-workspace-planner-no-inference" }, model: "qa-no-inference" };
  }, sendTurn: async input => {
    if (input.allowMutations !== false) throw new Error("QA prohibits execution");
    return { id: "qa-workspace-assessment-no-inference" };
  } },
}) : null;
const modelClient = process.env.AGENT_DECK_MODEL_QA ? new (require("../desktop/codex-app-server.cjs").CodexAppServer)() : null;
if (process.env.AGENT_DECK_WORKFLOW_QA) store.library.createFolder({ name: "产品文档 · 只读测试", rootPath: fs.realpathSync(path.join(__dirname, "../docs")) });
const workspace = JSON.parse(fs.readFileSync(path.join(profile, "workspace.json"), "utf8"));
let waitingQa;
if (process.env.AGENT_DECK_WAITING_QA) {
  const m = store.createMission({ title: "个人时间 · QA fixture（非真实执行）", outcome: "测试等待与回来简报", cwd: sandbox });
  store.savePlan(m.id, { title: m.title, outcome: m.outcome, tasks: [{ key: "T", title: "测试任务（未调用模型）", description: "只验证交互", agentRole: "QA fixture", dependencies: [], acceptanceCriteria: ["测试"] }] });
  const t = store.getMission(m.id).tasks[0]; store.updateTask(t.id, { status: "running", phase: "working" }); store.updateMission(m.id, { status: "running" });
  const r = store.createRequirement({ title: "准备下一件事 · QA fixture", outcome: "只保存笔记，不启动", body: "可继续编辑", workspacePath: workspace.path });
  waitingQa = globalThis.waitingQa = { store, missionId: m.id, taskId: t.id, noteId: r.id, notices: [] };
}
const waiting = new (require("../desktop/waiting-companion.cjs").WaitingCompanion)({ store, notify: input => { waitingQa?.notices.push(input); return false; } });
if (waitingQa) waitingQa.service = waiting;
let reviewQa;
if (process.env.AGENT_DECK_REVIEW_QA) {
  workspace.path = sandbox;
  const mission = store.createMission({ title: "逐项审阅 · 布局测试（非真实执行）", outcome: "审阅交付并逐项确认，不自动认领或发布", cwd: sandbox });
  store.savePlan(mission.id, { title: mission.title, outcome: mission.outcome, tasks: [
    { key: "UPSTREAM", title: "前置证据 · QA fixture", description: "这是一条明确标记的前置资料，仅测试布局。", agentRole: "前置研究员", dependencies: [], acceptanceCriteria: ["提供资料"] },
    { key: "REVIEW", title: "开源贡献候选审阅 · QA fixture", description: "寻找资源允许、可复现的开源贡献。不要重复认领；需要用户确认目标。", agentRole: "贡献研究员", dependencies: ["UPSTREAM"], acceptanceCriteria: ["链接可追溯", "已对照重复任务", "范围清晰", "资料完整"] },
  ] });
  const task = store.getMission(mission.id).tasks.find(item => item.key === "REVIEW");
  const upstream = store.getMission(mission.id).tasks.find(item => item.key === "UPSTREAM");
  for (const entry of [upstream, task]) store.updateTask(entry.id, { status: "review", phase: "review", agentThreadId: `qa-no-provider:${entry.key}`, worktreePath: sandbox, result: { summary: "布局场景：候选资料已整理，但没有实际认领或发布。不是模型输出。", acceptance: entry.acceptanceCriteria.map(criterion => ({ criterion, passed: true, evidence: "QA fixture：测试记录，不是模型验证。" })), blockers: ["未打开新的 PR；需要后续实现任务接手新目标。", "Transformers #43979 实现前需要先评论认领具体模型，避免子任务重复。"] } });
  fs.copyFileSync(path.join(__dirname, "../tests/fixtures/review-reference.html"), path.join(sandbox, "reference.html"));
  for (const entry of [upstream, task]) store.addArtifact({ missionId: mission.id, taskId: entry.id, title: `${entry.key} 的参考 · QA fixture`, summary: "布局测试参考，不是模型输出。", files: ["reference.html"], verificationStatus: "unverified" });
  store.updateMission(mission.id, { status: "review", mainThreadId: "qa-no-provider:main" });
  const requirement = store.createRequirement({ title: mission.title, outcome: mission.outcome, workspacePath: sandbox });
  store.updateRequirement(requirement.id, { missionId: mission.id, status: "review" });
  reviewQa = globalThis.reviewQa = { missionId: mission.id, taskId: task.id, upstreamId: upstream.id, store, sent: [], failDelivery: true };
  reviewQa.orchestrator = new (require("../desktop/mission-orchestrator.cjs").MissionOrchestrator)({ store, worktrees: {}, codex: { sendTurn: async input => {
    if (!input.threadId.startsWith("qa-no-provider:")) throw new Error("QA refuses real provider threads");
    reviewQa.sent.push(input);
    if (reviewQa.failDelivery) throw new Error("QA fixture：模拟发送失败，未调用模型");
    return { id: "qa-followup-no-inference" };
  } } });
  reviewQa.orchestrator.on("update", payload => BrowserWindow.getAllWindows().forEach(window => window.webContents.send("mission:update", payload)));
}
const cancelledPolishes = new Set();
if (workspaceQaCandidate) workspace.path = workspaceQaCandidate.cwd;
workspace.name = path.basename(workspace.path);
const reads = {
  "waiting:read": () => waiting.read(),
  "waiting:start": input => waiting.start(input),
  "waiting:finish": id => waiting.finish(id),
  ...(reviewQa ? {
    "missions:send-message": input => { if (input.missionId !== reviewQa.missionId) throw new Error("QA refuses live mutations"); return reviewQa.orchestrator.sendMessage(input); },
    "artifacts:preview": input => artifacts.preview(input),
  } : {}),
  ...(autonomyRegistry ? {
    "runtime:get": () => autonomyRegistry.runtimeSettings(),
    "runtime:set": input => require("../desktop/runtime-consent.cjs").saveRuntimeWithConsent(autonomyRegistry, input, async () => Boolean(globalThis.autonomyConsentResponse)),
  } : {}),
  ...(approveQa ? { "missions:approve": id => approveQa.approve(id) } : {}),
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
  ...(process.env.AGENT_DECK_POLISH_QA ? {
    // Labelled UI fixture only. Does not connect any provider or claim model quality.
    "requirements:polish": async input => {
      await new Promise(resolve => setTimeout(resolve, input.draft.body.includes("慢模式") ? 600 : 40));
      if (cancelledPolishes.has(input.requestId)) throw new Error("已取消润色，原文未改动。");
      if (input.draft.body.includes("失败模式")) throw new Error("布局测试：模拟模型不可用，原文未改动。");
      return { draft: { title: "润色候选 · " + input.draft.title, outcome: input.draft.outcome, body: "布局测试候选（不是模型输出）：保留原有目标、背景与限制。\n" + input.draft.body }, questions: ["这是一条布局测试问题，尚未成为验收标准。"], model: "QA fixture · 非模型输出", usage: null };
    },
    "requirements:cancel-polish": id => { cancelledPolishes.add(id); return true; },
  } : {}),
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
