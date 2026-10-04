// Isolated UI fixture: real SDK, tools and ledger; deterministic model/page only.
// No production test hooks, user profile, credentials or network requests.
const { app, BrowserWindow, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { NativeHarnessRuntime } = require("../desktop/native-harness-runtime.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const { ProviderAdapterHost } = require("../desktop/adapter-host.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { readPublicPage } = require("../desktop/personal-tools.cjs");
const root = fs.realpathSync(process.env.AGENT_DECK_PERSONAL_QA_ROOT);
if (!path.basename(root).startsWith("agent-deck-personal-tools-qa-")) throw new Error("Explicit temporary QA root required");
app.setPath("userData", root);
const sources = path.join(root, "sources"); fs.mkdirSync(sources);
fs.writeFileSync(path.join(sources, "brief.txt"), "QA fixture: option A costs 7, option B costs 12; prices not verified.");
const store = new MissionStore(path.join(root, "ledger.sqlite3"));
const response = (content, name, args) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content, ...(name ? { tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : {}) } }], usage: { total_tokens: 15 } }), { status: 200 });
let calls = 0; let webRequests = 0;
const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(root, "native"), providerRegistry: { apiProfile: () => ({ endpoint: "https://model.test/v1", model: "isolated-fixture", apiKey: "not-real" }) }, publicPageReader: async url => {
  webRequests++;
  return readPublicPage(url, { lookup: async () => [{ address: "8.8.8.8", family: 4 }], transport: async () => ({ bytes: Buffer.from("<h1>QA public fixture</h1><p>Reading a source is not verification.</p>"), type: "text/html; charset=utf-8", status: 200 }) });
}, fetchImpl: async () => {
  calls++;
  if (calls === 1) return response(null, "reference_read", { path: "brief.txt" });
  if (calls === 2) return response(null, "public_web_read", { url: "https://example.com/report" });
  if (calls === 3) return response(null, "workspace_write", { path: "decision.html", content: '<!doctype html><html lang="zh"><title>QA fixture</title><h1>QA · 决策草稿</h1><p>A: 7; B: 12. 测试资料，价格未经核验。</p><p>来源：brief.txt; https://example.com/report</p></html>' });
  if (calls === 4) return response(JSON.stringify({ summary: "QA · 已生成带来源的 HTML 草稿；隔离测试，不是真实建议。", acceptance: [{ criterion: "HTML 和来源回执", passed: true, evidence: "decision.html; local and public receipts" }], changedFiles: ["decision.html"], blockers: [] }));
  if (calls === 5) return response(null, "reference_read", { path: "brief.txt" });
  if (calls === 6) return response(null, "workspace_read", { path: "decision.html" });
  return response('{"passed":true,"summary":"QA: independently re-read source and draft"}');
} });
const orchestrator = new MissionOrchestrator({ store, worktrees: new WorktreeManager(path.join(root, "worktrees")), adapterHost: new ProviderAdapterHost({ nativeHarness: runtime }), selectRuntime: () => ({ runtimeMode: "agent_deck", provider: "deepseek" }) });
let window;
runtime.on("event", event => orchestrator.handleCodexEvent(event).catch(error => console.error(error)));
orchestrator.on("update", update => window?.webContents.send("mission:update", update));
const reads = {
  "workspace:current": () => ({ path: sources, name: "QA · 来源资料" }),
  "runtime:get": () => ({ mode: "agent_deck", externalProvider: "codex", modelProvider: "deepseek" }),
  "codex:status": () => ({ available: false, authenticated: false, inactive: true, runtimeMode: "agent_deck", models: [] }),
  "providers:list": () => [], "codex:threads": () => [],
  "missions:list": () => store.listMissions(), "missions:get": id => store.getMission(id),
  "missions:attention": () => store.listAttentionItems(), "missions:attention-briefing": () => store.listAttentionBriefing(),
  "missions:sessions": cwd => store.listSessionRefs(cwd), "missions:events": input => store.listEvents(input.missionId, input),
  "missions:save-ui-state": input => store.saveUiState(input.missionId, input.patch),
  "missions:resolve-approval": input => orchestrator.resolveApproval(input),
  "requirements:list": input => store.listRequirements(input), "personal:projects": () => store.personal.listProjects(),
  "window:minimize": () => window.minimize(), "window:close": () => window.close(),
  "qa:stats": () => ({ calls, webRequests, mission: store.listMissions()[0] }),
};
for (const [channel, read] of Object.entries(reads)) ipcMain.handle(channel, (_, input) => read(input));
app.whenReady().then(async () => {
  await orchestrator.create({ title: "QA · 受控资料与网页", outcome: "HTML 和来源回执", cwd: sources, executionMode: "research", orchestrationMode: "direct" });
  window = new BrowserWindow({ width: 1540, height: 960, title: "Agent Deck · 隔离工具验收", titleBarStyle: "hiddenInset", backgroundColor: "#111417", webPreferences: { preload: path.resolve(__dirname, "../desktop/preload.cjs"), contextIsolation: true, nodeIntegration: false } });
  await window.loadFile(path.resolve(__dirname, "../dist/client/index.html"));
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => store.close());
