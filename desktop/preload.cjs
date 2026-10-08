const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentDeckDesktop", {
  isDesktop: true,
  waiting: {
    read: () => ipcRenderer.invoke("waiting:read"),
    start: input => ipcRenderer.invoke("waiting:start", input),
    finish: id => ipcRenderer.invoke("waiting:finish", id),
  },
  personal: {
    projects: () => ipcRenderer.invoke("personal:projects"),
    saveProject: input => ipcRenderer.invoke("personal:save-project", input),
    memories: input => ipcRenderer.invoke("personal:memories", input),
    saveMemory: input => ipcRenderer.invoke("personal:save-memory", input),
    deleteMemory: input => ipcRenderer.invoke("personal:delete-memory", input),
    linkWork: input => ipcRenderer.invoke("personal:link-work", input),
    recovery: projectId => ipcRenderer.invoke("personal:recovery", projectId),
    context: input => ipcRenderer.invoke("personal:context", input),
    onChange: handler => {
      const listener = () => handler();
      ipcRenderer.on("personal:changed", listener);
      return () => ipcRenderer.removeListener("personal:changed", listener);
    },
  },
  selectWorkspace: () => ipcRenderer.invoke("workspace:select"),
  currentWorkspace: () => ipcRenderer.invoke("workspace:current"),
  openWorkspaceFile: (file) => ipcRenderer.invoke("workspace:open-file", file),
  revealWorkspaceFile: (file) => ipcRenderer.invoke("workspace:reveal-file", file),
  terminal: {
    run: (input) => ipcRenderer.invoke("terminal:run", input),
  },
  requirements: {
    list: (input) => ipcRenderer.invoke("requirements:list", input),
    create: (input) => ipcRenderer.invoke("requirements:create", input),
    update: (input) => ipcRenderer.invoke("requirements:update", input),
    polish: (input) => ipcRenderer.invoke("requirements:polish", input),
    cancelPolish: (requestId) => ipcRenderer.invoke("requirements:cancel-polish", requestId),
    claimNext: (input) => ipcRenderer.invoke("requirements:claim-next", input),
  },
  library: {
    overview: () => ipcRenderer.invoke("library:overview"),
    files: input => ipcRenderer.invoke("library:files", input),
    history: input => ipcRenderer.invoke("library:history", input),
    sessions: input => ipcRenderer.invoke("library:sessions", input),
    createFolder: input => ipcRenderer.invoke("library:create-folder", input),
    assign: input => ipcRenderer.invoke("library:assign", input),
    connect: () => ipcRenderer.invoke("library:connect"),
    browse: input => ipcRenderer.invoke("library:browse", input),
    preview: input => ipcRenderer.invoke("library:preview", input),
    action: input => ipcRenderer.invoke("library:action", input),
  },
  codex: {
    status: () => ipcRenderer.invoke("codex:status"),
    threads: (cwd) => ipcRenderer.invoke("codex:threads", cwd),
    readThread: (input) => ipcRenderer.invoke("codex:read-thread", input),
    archiveThread: (threadId) => ipcRenderer.invoke("codex:archive-thread", threadId),
    createThread: (input) => ipcRenderer.invoke("codex:create-thread", input),
    startSession: (input) => ipcRenderer.invoke("codex:start-session", input),
    sendTurn: (input) => ipcRenderer.invoke("codex:send-turn", input),
    steer: (input) => ipcRenderer.invoke("codex:steer", input),
    interrupt: (input) => ipcRenderer.invoke("codex:interrupt", input),
    approval: (input) => ipcRenderer.invoke("codex:approval", input),
    startRealtime: (input) => ipcRenderer.invoke("codex:realtime-start", input),
    stopRealtime: (input) => ipcRenderer.invoke("codex:realtime-stop", input),
    onEvent: (handler) => {
      const listener = (_event, update) => handler(update);
      ipcRenderer.on("codex:event", listener);
      return () => ipcRenderer.removeListener("codex:event", listener);
    },
  },
  runtime: {
    get: () => ipcRenderer.invoke("runtime:get"),
    set: (input) => ipcRenderer.invoke("runtime:set", input),
    onChange: (callback) => {
      const listener = (_event, settings) => callback(settings);
      ipcRenderer.on("runtime:changed", listener);
      return () => ipcRenderer.removeListener("runtime:changed", listener);
    },
  },
  providers: {
    list: () => ipcRenderer.invoke("providers:list"),
    saveApiProfile: (input) => ipcRenderer.invoke("providers:save-api-profile", input),
    verifyApiProfile: (providerId) => ipcRenderer.invoke("providers:verify-api-profile", providerId),
    bridgeConfig: (providerId) => ipcRenderer.invoke("providers:bridge-config", providerId),
  },
  missions: {
    list: () => ipcRenderer.invoke("missions:list"),
    attention: () => ipcRenderer.invoke("missions:attention"),
    attentionBriefing: () => ipcRenderer.invoke("missions:attention-briefing"),
    usageSummary: (missionId) => ipcRenderer.invoke("missions:usage-summary", missionId),
    deferAttention: (input) => ipcRenderer.invoke("missions:defer-attention", input),
    sessions: (cwd) => ipcRenderer.invoke("missions:sessions", cwd),
    get: (missionId) => ipcRenderer.invoke("missions:get", missionId),
    events: (input) => ipcRenderer.invoke("missions:events", input),
    contextSearch: (input) => ipcRenderer.invoke("missions:context-search", input),
    contextBrief: (input) => ipcRenderer.invoke("missions:context-brief", input),
    saveUiState: (input) => ipcRenderer.invoke("missions:save-ui-state", input),
    updatePlan: (input) => ipcRenderer.invoke("missions:update-plan", input),
    create: (input) => ipcRenderer.invoke("missions:create", input),
    approve: (missionId) => ipcRenderer.invoke("missions:approve", missionId),
    selectWorkspace: (missionId) => ipcRenderer.invoke("missions:select-workspace", missionId),
    setExecutionMode: (input) => ipcRenderer.invoke("missions:set-execution-mode", input),
    assessWorkspace: (missionId) => ipcRenderer.invoke("missions:assess-workspace", missionId),
    resolveApproval: (input) => ipcRenderer.invoke("missions:resolve-approval", input),
    acceptTask: (input) => ipcRenderer.invoke("missions:accept-task", input),
    retryTask: (input) => ipcRenderer.invoke("missions:retry-task", input),
    plannerModels: (missionId) => ipcRenderer.invoke("missions:planner-models", missionId),
    retryPlan: (input) => ipcRenderer.invoke("missions:retry-plan", input),
    integrate: (missionId) => ipcRenderer.invoke("missions:integrate", missionId),
    sendMessage: (input) => ipcRenderer.invoke("missions:send-message", input),
    cancel: (missionId) => ipcRenderer.invoke("missions:cancel", missionId),
    exportReport: (missionId) => ipcRenderer.invoke("missions:export-report", missionId),
    onUpdate: (handler) => {
      const listener = (_event, update) => handler(update);
      ipcRenderer.on("mission:update", listener);
      return () => ipcRenderer.removeListener("mission:update", listener);
    },
    onError: (handler) => {
      const listener = (_event, update) => handler(update);
      ipcRenderer.on("mission:error", listener);
      return () => ipcRenderer.removeListener("mission:error", listener);
    },
  },
  artifacts: {
    inspect: (input) => ipcRenderer.invoke("artifacts:inspect", input),
    preview: (input) => ipcRenderer.invoke("artifacts:preview", input),
    open: (input) => ipcRenderer.invoke("artifacts:open", input),
    reveal: (input) => ipcRenderer.invoke("artifacts:reveal", input),
    export: (input) => ipcRenderer.invoke("artifacts:export", input),
    publication: (input) => ipcRenderer.invoke("artifacts:publication", input),
    copyPublication: (input) => ipcRenderer.invoke("artifacts:copy-publication", input),
    exportPublication: (input) => ipcRenderer.invoke("artifacts:export-publication", input),
    openPublisher: (input) => ipcRenderer.invoke("artifacts:open-publisher", input),
  },
  publisher: {
    connect: (platform) => ipcRenderer.invoke("publisher:connect", platform),
    publish: (input) => ipcRenderer.invoke("publisher:publish", input),
  },
  media: {
    requestMicrophone: () => ipcRenderer.invoke("media:microphone-permission"),
  },
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    close: () => ipcRenderer.invoke("window:close"),
  },
});

window.addEventListener("DOMContentLoaded", () => {
  document.documentElement.classList.add("desktop-app");
});
