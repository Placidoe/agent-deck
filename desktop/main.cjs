const { app, BrowserWindow, clipboard, dialog, ipcMain, Notification, safeStorage, session, shell, systemPreferences } = require("electron");
const { WaitingCompanion } = require("./waiting-companion.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { CodexAppServer } = require("./codex-app-server.cjs");
const { MissionStore } = require("./mission-store.cjs");
const { MissionOrchestrator } = require("./mission-orchestrator.cjs");
const { WorktreeManager } = require("./worktree-manager.cjs");
const { ArtifactService } = require("./artifact-service.cjs");
const { LibraryService } = require("./library-service.cjs");
const { PublisherService } = require("./publisher-service.cjs");
const { ProviderRegistry } = require("./provider-registry.cjs");
const { ApiAgentRuntime } = require("./api-agent-runtime.cjs");
const { NativeHarnessRuntime } = require("./native-harness-runtime.cjs");
const { ProviderAdapterHost } = require("./adapter-host.cjs");
const { PromptPolishService } = require("./prompt-polish.cjs");
const { resolveDebugCwd, runDebugCommand } = require("./terminal-service.cjs");

let mainWindow;
let activeWorkspace = null;
const codex = new CodexAppServer();
let missionOrchestrator = null;
let artifactService = null;
let libraryService = null;
let missionStore = null;
let publisherService = null;
let providerRegistry = null;
let apiRuntime = null;
let nativeHarness = null;
let adapterHost = null;
let promptPolish = null;
let missionReconcileTimer = null;
let waitingCompanion = null;
let waitingUpdateTimer = null;
const waitingNotifications = new Set();
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.quit();

app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function workspaceStatePath() {
  return path.join(app.getPath("userData"), "workspace.json");
}

function loadSavedWorkspace() {
  try {
    const saved = JSON.parse(fs.readFileSync(workspaceStatePath(), "utf8"));
    if (saved.path && fs.existsSync(saved.path)) activeWorkspace = inspectWorkspace(saved.path);
  } catch {
    activeWorkspace = null;
  }
}

function saveWorkspace(workspace) {
  fs.mkdirSync(path.dirname(workspaceStatePath()), { recursive: true });
  fs.writeFileSync(workspaceStatePath(), JSON.stringify({ path: workspace.path }), "utf8");
}

function readGitBranch(root) {
  try {
    const head = fs.readFileSync(path.join(root, ".git", "HEAD"), "utf8").trim();
    return head.startsWith("ref: refs/heads/") ? head.slice("ref: refs/heads/".length) : head.slice(0, 8);
  } catch {
    return null;
  }
}

function inspectWorkspace(root) {
  const entries = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => ![".git", "node_modules", ".DS_Store"].includes(entry.name));

  return {
    path: root,
    name: path.basename(root),
    branch: readGitBranch(root),
    itemCount: entries.length,
    items: entries.slice(0, 24).map((entry) => ({
      name: entry.name,
      kind: entry.isDirectory() ? "directory" : "file",
    })),
  };
}

function resolveActiveWorkspaceFile(file) {
  if (!activeWorkspace?.path) throw new Error("No active workspace");
  const root = fs.realpathSync(activeWorkspace.path);
  const candidate = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  if (!fs.existsSync(candidate)) throw new Error(`Workspace file no longer exists: ${file}`);
  const resolved = fs.realpathSync(candidate);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("File is outside the active workspace");
  return resolved;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1540,
    height: 960,
    minWidth: 1120,
    minHeight: 720,
    title: "Agent Deck",
    backgroundColor: process.platform === "darwin" ? "#00000000" : "#0b0d0f",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 17, y: 15 },
    hasShadow: true,
    ...(process.platform === "darwin" ? {
      vibrancy: "under-window",
      visualEffectState: "active",
    } : {}),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.AGENT_DECK_DEV_URL) {
    mainWindow.loadURL(process.env.AGENT_DECK_DEV_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "client", "index.html"));
  }
}

codex.on("event", (event) => {
  missionOrchestrator?.handleCodexEvent(event).catch((error) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mission:error", { message: error.message });
  });
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("codex:event", event);
});

ipcMain.handle("workspace:select", async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: "Choose a workspace for Agent Deck",
    defaultPath: activeWorkspace?.path,
    properties: ["openDirectory", "createDirectory"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  activeWorkspace = inspectWorkspace(result.filePaths[0]);
  saveWorkspace(activeWorkspace);
  return activeWorkspace;
});

ipcMain.handle("workspace:current", () => activeWorkspace);
ipcMain.handle("workspace:open-file", async (_event, file) => {
  const resolved = resolveActiveWorkspaceFile(file);
  const error = await shell.openPath(resolved);
  if (error) throw new Error(error);
  return { path: resolved };
});
ipcMain.handle("workspace:reveal-file", (_event, file) => {
  const resolved = resolveActiveWorkspaceFile(file);
  shell.showItemInFolder(resolved);
  return { path: resolved };
});

ipcMain.handle("terminal:run", async (_event, input) => {
  const allowedRoots = [activeWorkspace?.path, ...(missionStore?.listWorktreePaths() || [])];
  const cwd = resolveDebugCwd(input?.cwd, allowedRoots);
  return runDebugCommand({ command: input?.command, cwd });
});

ipcMain.handle("codex:status", async () => {
  if (providerRegistry?.runtimeSettings().mode === "agent_deck") return { available: false, authenticated: false, inactive: true, runtimeMode: "agent_deck", models: [] };
  try {
    return await codex.getStatus();
  } catch (error) {
    return { available: false, authenticated: false, error: error.message };
  }
});
ipcMain.handle("codex:threads", (_event, cwd) => codex.listThreads(cwd));
ipcMain.handle("codex:read-thread", (_event, input) => codex.readThread(input.threadId, Boolean(input.includeTurns)));
ipcMain.handle("codex:archive-thread", async (_event, threadId) => {
  const answer = await dialog.showMessageBox(mainWindow, {
    type: "question", title: "Archive Codex session", message: "Archive this Codex session?",
    detail: "Its history stays in Codex and can be restored outside Agent Deck.",
    buttons: ["Cancel", "Archive"], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1) return { canceled: true };
  await codex.archiveThread(threadId);
  return { canceled: false };
});
function assertExternalSessionMode() {
  if (providerRegistry?.runtimeSettings().mode === "agent_deck") throw new Error("当前使用 Agent Deck Harness，请从工作入口开始任务；独立 Codex 会话只在外部模式可创建。");
}
ipcMain.handle("codex:create-thread", (_event, input) => { assertExternalSessionMode(); return codex.createThread(input); });
ipcMain.handle("codex:start-session", (_event, input) => { assertExternalSessionMode(); return codex.startSession(input); });
ipcMain.handle("codex:send-turn", (_event, input) => codex.sendTurn(input));
ipcMain.handle("codex:steer", (_event, input) => codex.steer(input));
ipcMain.handle("codex:interrupt", (_event, input) => codex.interrupt(input));
ipcMain.handle("codex:approval", (_event, input) => codex.respondToApproval(input));
ipcMain.handle("codex:realtime-start", (_event, input) => codex.startRealtime(input));
ipcMain.handle("codex:realtime-stop", (_event, input) => codex.stopRealtime(input));

ipcMain.handle("providers:list", async () => providerRegistry?.status() || []);
ipcMain.handle("runtime:get", () => providerRegistry?.runtimeSettings());
ipcMain.handle("runtime:set", async (_event, input) => {
  const settings = await require("./runtime-consent.cjs").saveRuntimeWithConsent(providerRegistry, input, async () => {
    const result = await dialog.showMessageBox(mainWindow, { type: "warning", title: "开启自主执行？", message: "新工作将使用完整工具权限，不再逐步询问你", detail: "Agent 可以写文件、执行任意 Bash、联网和安装依赖。这不是安全沙箱，错误或不可信内容可能影响工作区以外的文件。计划审批、工具许可、结果验收和成果汇总将自动推进；主 Agent 用 low 思考强度只读自检，失败时最多自动修正两次。已有工作保持原模式，你随时可以停止任务。系统授权、组织限制、登录和验证码不会被绕过。仅在可信工作区使用。", buttons: ["保持人工确认", "开启自主执行"], defaultId: 0, cancelId: 0, noLink: true });
    return result.response === 1;
  });
  mainWindow?.webContents.send("runtime:changed", settings);
  return settings;
});
ipcMain.handle("providers:save-api-profile", async (_event, input) => {
  if (!providerRegistry) throw new Error("Provider runtime is not ready");
  const profile = providerRegistry.saveApiProfile(input || {});
  return { profile, providers: await providerRegistry.status() };
});
ipcMain.handle("providers:verify-api-profile", async (_event, providerId) => {
  if (!providerRegistry) throw new Error("Provider runtime is not ready");
  const result = await providerRegistry.verifyApiProfile(providerId);
  return { result, providers: await providerRegistry.status() };
});
ipcMain.handle("providers:bridge-config", (_event, providerId) => {
  if (!providerRegistry || !missionStore) throw new Error("Provider runtime is not ready");
  return providerRegistry.bridgeConfig({ providerId, databasePath: missionStore.databasePath });
});

ipcMain.handle("waiting:read", () => waitingCompanion?.read() || { active: [], session: null });
ipcMain.handle("waiting:start", (_, input) => { if (!waitingCompanion) throw new Error("桌面运行时未就绪"); return waitingCompanion.start(input); });
ipcMain.handle("waiting:finish", (_, id) => { if (!waitingCompanion) throw new Error("桌面运行时未就绪"); return waitingCompanion.finish(id); });
ipcMain.handle("missions:list", () => missionOrchestrator?.list() || []);
ipcMain.handle("missions:attention", () => missionOrchestrator?.attention() || []);
ipcMain.handle("missions:attention-briefing", () => missionOrchestrator?.attentionBriefing() || null);
ipcMain.handle("missions:usage-summary", (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.usageSummary(missionId);
});
ipcMain.handle("missions:defer-attention", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.deferAttention(input || {});
});
ipcMain.handle("missions:sessions", (_event, cwd) => missionOrchestrator?.sessions(cwd) || []);
ipcMain.handle("requirements:list", (_event, input) => missionOrchestrator?.requirements(input || {}) || []);
for (const [channel, method, mutation] of [
  ["personal:projects", "listProjects"], ["personal:save-project", "saveProject", true],
  ["personal:memories", "listMemories"], ["personal:save-memory", "saveMemory", true],
  ["personal:delete-memory", "deleteMemory", true], ["personal:link-work", "linkWork", true],
  ["personal:recovery", "recovery"], ["personal:context", "context"],
]) ipcMain.handle(channel, (_event, input) => {
  if (!missionStore?.personal) throw new Error("Personal workspace is not ready");
  const result = missionStore.personal[method](input);
  if (mutation) mainWindow?.webContents.send("personal:changed");
  return result;
});
ipcMain.handle("requirements:create", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.createRequirement(input || {});
});
for (const [channel, method] of [["library:overview", "overview"], ["library:files", "files"], ["library:history", "history"], ["library:sessions", "sessions"], ["library:create-folder", "createFolder"], ["library:assign", "assign"]]) {
  ipcMain.handle(channel, (_event, input) => {
    if (!missionStore?.library) throw new Error("文档库尚未就绪");
    // Only the native directory picker may grant a filesystem root.
    const payload = method === "createFolder" ? { name: input?.name, parentId: input?.parentId || null } : input || {};
    return missionStore.library[method](payload);
  });
}
for (const [channel, method] of [["library:connect", "connect"], ["library:browse", "browse"], ["library:preview", "preview"], ["library:action", "action"]]) {
  ipcMain.handle(channel, (_event, input) => {
    if (!libraryService) throw new Error("文档库尚未就绪");
    return libraryService[method](input || {}, mainWindow);
  });
}
ipcMain.handle("requirements:update", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.updateRequirement(input?.id, input?.patch || {});
});
ipcMain.handle("requirements:polish", (_event, input) => {
  if (!promptPolish) throw new Error("文字润色尚未就绪。");
  return promptPolish.polish(input);
});
ipcMain.handle("requirements:cancel-polish", (_event, requestId) => promptPolish?.cancel(requestId) || false);
ipcMain.handle("requirements:claim-next", async (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.claimNextRequirement(input || {});
});
ipcMain.handle("missions:get", (_event, missionId) => missionOrchestrator?.get(missionId) || null);
ipcMain.handle("missions:events", (_event, input) => missionOrchestrator?.events(input.missionId, input) || { items: [], nextBeforeSeq: null });
ipcMain.handle("missions:context-search", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.contextSearch(input || {});
});
ipcMain.handle("missions:context-brief", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.contextBrief(input || {});
});
ipcMain.handle("missions:save-ui-state", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.saveUiState(input.missionId, input.patch || {});
});
ipcMain.handle("missions:update-plan", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.updatePlan(input.missionId, input.spec);
});
ipcMain.handle("missions:create", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.create(input);
});
ipcMain.handle("missions:approve", (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.approve(missionId);
});
ipcMain.handle("missions:select-workspace", async (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  const mission = missionOrchestrator.get(missionId);
  if (!mission) throw new Error("Mission not found");
  const selection = await dialog.showOpenDialog(mainWindow, { title: "选择工作区（Agent 将判断环境准备方式）", defaultPath: mission.cwd, properties: ["openDirectory"] });
  if (selection.canceled || !selection.filePaths[0]) return null;
  const selectedPath = fs.realpathSync(selection.filePaths[0]);
  const confirmation = await dialog.showMessageBox(mainWindow, { type: "question", title: "更换 Mission 工作区", message: "保留现有拆解，让 Agent 评估新目录？", detail: `原目录：${mission.cwd}\n新目录：${selectedPath}\n\n将发起一次只读模型评估，不会复制、提交或修改项目文件。完成后请检查环境方案与现有任务范围，再批准执行。`, buttons: ["取消", "更换并评估"], defaultId: 0, cancelId: 0 });
  if (confirmation.response !== 1) return null;
  missionOrchestrator.changeWorkspace(missionId, selectedPath, "auto");
  return missionOrchestrator.assessWorkspace(missionId);
});
ipcMain.handle("missions:assess-workspace", (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.assessWorkspace(missionId);
});
ipcMain.handle("missions:set-execution-mode", async (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  const mission = missionOrchestrator.get(input.missionId);
  if (!mission || !["research", "code"].includes(input.executionMode)) throw new Error("Invalid mission or execution mode");
  const research = input.executionMode === "research";
  const confirmation = await dialog.showMessageBox(mainWindow, {
    type: "question", title: "更换执行方式", message: research ? "改为调研与文档模式？" : "改为代码开发模式？",
    detail: research ? `资料目录：${mission.cwd}\n成果将保存在应用独立工作区，不会初始化或提交你的资料目录。内部版本管理仍由应用维护。\n保留计划，但请重新检查任务不涉及修改原项目；确认计划后才会启动 Worker。` : "代码任务要求所选目录是有提交记录的 Git 仓库。保留计划并重新批准后才会开始。",
    buttons: ["取消", "切换并重新审阅"], defaultId: 0, cancelId: 0,
  });
  if (confirmation.response !== 1) return null;
  return missionOrchestrator.changeWorkspace(mission.id, mission.cwd, input.executionMode);
});
ipcMain.handle("missions:resolve-approval", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.resolveApproval(input || {});
});
ipcMain.handle("missions:accept-task", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.acceptTask(input.missionId, input.taskId);
});
ipcMain.handle("missions:retry-task", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.retryTask(input.missionId, input.taskId);
});
ipcMain.handle("missions:planner-models", (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.plannerModels(missionId);
});
ipcMain.handle("missions:retry-plan", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.retryPlan(input || {});
});
ipcMain.handle("missions:integrate", (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.integrate(missionId);
});
ipcMain.handle("missions:send-message", (_event, input) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  return missionOrchestrator.sendMessage(input);
});
ipcMain.handle("missions:cancel", async (_event, missionId) => {
  if (!missionOrchestrator) throw new Error("Mission runtime is not ready");
  const answer = await dialog.showMessageBox(mainWindow, {
    type: "warning", title: "Cancel mission", message: "Stop every active worker in this mission?",
    detail: "Threads will be interrupted. Existing Git worktrees, file changes, and evidence will be preserved.",
    buttons: ["Keep running", "Cancel mission"], defaultId: 0, cancelId: 0,
  });
  if (answer.response !== 1) return { canceled: true };
  return missionOrchestrator.cancel(missionId);
});
ipcMain.handle("missions:export-report", (_event, missionId) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.exportMissionReport(missionId, mainWindow);
});
ipcMain.handle("artifacts:inspect", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.inspect(input);
});
ipcMain.handle("artifacts:preview", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.preview(input);
});
ipcMain.handle("artifacts:open", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.open(input);
});
ipcMain.handle("artifacts:reveal", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.reveal(input);
});
ipcMain.handle("artifacts:export", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.export(input, mainWindow);
});
ipcMain.handle("artifacts:publication", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.publication(input);
});
ipcMain.handle("artifacts:copy-publication", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.copyPublication(input);
});
ipcMain.handle("artifacts:export-publication", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.exportPublication(input, mainWindow);
});
ipcMain.handle("artifacts:open-publisher", (_event, input) => {
  if (!artifactService) throw new Error("Artifact runtime is not ready");
  return artifactService.openPublisher(input);
});
ipcMain.handle("publisher:connect", (_event, platform) => {
  if (!publisherService) throw new Error("Publisher runtime is not ready");
  return publisherService.connect(platform);
});
ipcMain.handle("publisher:publish", (_event, input) => {
  if (!publisherService) throw new Error("Publisher runtime is not ready");
  return publisherService.publish(input);
});

ipcMain.handle("media:microphone-permission", async () => {
  if (process.platform !== "darwin") return true;
  const current = systemPreferences.getMediaAccessStatus("microphone");
  if (current === "granted") return true;
  if (current === "denied" || current === "restricted") return false;
  return systemPreferences.askForMediaAccess("microphone");
});

ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.handle("window:close", () => mainWindow?.close());

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  missionStore = new MissionStore(path.join(app.getPath("userData"), "agent-deck.sqlite3"));
  waitingCompanion = new WaitingCompanion({ store: missionStore, notify: ({ critical }) => {
    if (!Notification.isSupported()) return false;
    const notice = new Notification({ title: "Agent Deck", body: critical ? "工作出现阻塞或授权请求。回来后查看「待我处理」；不会自动放行。" : "工作状态有更新。你可以继续休息，回来再查看结果。", silent: true });
    waitingNotifications.add(notice);
    notice.on("close", () => waitingNotifications.delete(notice));
    notice.on("failed", () => { waitingCompanion.notificationStatus = "unavailable"; waitingNotifications.delete(notice); });
    notice.on("click", () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.restore(); mainWindow.show(); mainWindow.focus(); } });
    notice.show(); return true;
  } });
  providerRegistry = new ProviderRegistry({
    userDataPath: app.getPath("userData"),
    safeStorage,
    codexStatus: () => codex.getStatus(),
    manifestLookup: (id) => adapterHost ? adapterHost.manifest(id) : require("./adapter-host.cjs").manifestFor(id),
  });
  apiRuntime = new ApiAgentRuntime({ providerRegistry });
  promptPolish = new PromptPolishService({ providerRegistry, store: missionStore });
  nativeHarness = new NativeHarnessRuntime({ providerRegistry, rootDirectory: path.join(app.getPath("userData"), "native-harness") });
  const forwardProviderEvent = (event) => {
    missionOrchestrator?.handleCodexEvent(event).catch((error) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mission:error", { message: error.message });
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("provider:event", event);
  };
  adapterHost = new ProviderAdapterHost({ codex, apiRuntime, nativeHarness, onExternalEvent: forwardProviderEvent });
  const worktrees = new WorktreeManager(path.join(app.getPath("userData"), "worktrees"));
  missionOrchestrator = new MissionOrchestrator({ codex, apiRuntime, adapterHost, selectRuntime: (input) => providerRegistry.selectRuntime(input), store: missionStore, worktrees,
    confirmWorkspaceInitialization: async preview => {
      const result = await dialog.showMessageBox(mainWindow, {
        type: "question", title: "批准 Agent 的工作区准备方案", message: "在这个目录建立 Git 初始版本？",
        detail: `目录：${preview.root}\nAgent 的理由：${preview.reason}\n\n仅提交以下 ${preview.files.length} 个文件（${Math.ceil(preview.totalBytes / 1024)} KiB）：\n${preview.files.map(file => file.path).join("\n") || "无已有文件，只创建空初始提交"}\n\n其他文件不纳入版本管理；不会推送到远端，也不会改写已有文件。完成后才会启动已批准的任务。`,
        buttons: ["取消，保持未执行", "批准准备并执行"], defaultId: 0, cancelId: 0,
      });
      return result.response === 1;
    },
  });
  for (const runtime of [apiRuntime, nativeHarness]) runtime.on("event", (event) => {
    missionOrchestrator?.handleCodexEvent(event).catch((error) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mission:error", { message: error.message });
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("provider:event", { runtimeMode: runtime === nativeHarness ? "agent_deck" : "external", ...event });
  });
  artifactService = new ArtifactService({ store: missionStore, dialog, shell, clipboard, downloadsPath: app.getPath("downloads") });
  libraryService = new LibraryService({ store: missionStore, artifacts: artifactService, dialog, shell });
  publisherService = new PublisherService({ BrowserWindow, parentWindow: () => mainWindow });
  missionOrchestrator.on("update", (update) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mission:update", update);
    if (waitingCompanion?.session && !waitingUpdateTimer) waitingUpdateTimer = setTimeout(() => {
      waitingUpdateTimer = null;
      waitingCompanion?.update();
    }, 1000);
  });
  session.defaultSession.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    return permission === "media" && details?.mediaType === "audio";
  });
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(permission === "media" && (details?.mediaTypes || []).includes("audio"));
  });
  loadSavedWorkspace();
  createWindow();
  missionOrchestrator.recover().catch((error) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mission:error", { message: `Mission recovery failed: ${error.message}` });
  }).finally(() => {
    missionReconcileTimer = setInterval(() => {
      missionOrchestrator?.reconcileActive().catch((error) => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("mission:error", { message: `Mission state check failed: ${error.message}` });
      });
    }, 30_000);
    missionReconcileTimer.unref?.();
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  if (waitingUpdateTimer) clearTimeout(waitingUpdateTimer);
  for (const notice of waitingNotifications) notice.close();
  if (missionReconcileTimer) clearInterval(missionReconcileTimer);
  codex.stop();
  promptPolish?.stop();
  missionOrchestrator?.autonomous.stop();
  missionStore?.close();
});
