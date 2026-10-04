// No live requests without --live. Never save or print credentials.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { plan, runSuite, saveReport } = require("./personal-eval-core.cjs");
const { ProviderRegistry } = require("../desktop/provider-registry.cjs");

function parseArgs(args) {
  const options = { mode: "plan", repeats: 1, maxCalls: 48, maxTokens: 40000 };
  let modes = 0;
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (["--plan", "--preflight", "--live"].includes(flag)) { options.mode = flag.slice(2); modes++; continue; }
    const names = { "--cases": "caseIds", "--repeats": "repeats", "--max-calls": "maxCalls", "--max-tokens": "maxTokens", "--config-dir": "configDir" };
    const name = names[flag]; if (!name || !args[index + 1] || args[index + 1].startsWith("--")) throw new Error("Unknown or incomplete evaluation option");
    const value = args[++index]; options[name] = name === "caseIds" ? value.split(",") : ["repeats", "maxCalls", "maxTokens"].includes(name) ? Number(value) : path.resolve(value);
  }
  if (modes > 1) throw new Error("Choose one evaluation mode");
  options.caseIds ||= options.mode === "live" ? ["P1"] : ["P1", "P2", "P3"];
  plan(options);
  if (!Number.isInteger(options.maxCalls) || options.maxCalls < 1 || options.maxCalls > 256 || !Number.isInteger(options.maxTokens) || options.maxTokens < 1000 || options.maxTokens > 200000) throw new Error("Invalid evaluation budget");
  return options;
}
function configDirectory() {
  return process.platform === "darwin" ? path.join(os.homedir(), "Library/Application Support/agent-deck-demo") : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "agent-deck-demo");
}
function preflight(directory) {
  const registry = new ProviderRegistry({ userDataPath: directory });
  const provider = registry.runtimeSettings().modelProvider;
  const stored = registry.config.api?.[provider];
  return { ready: ["deepseek", "openai_compatible"].includes(provider) && Boolean(stored?.verifiedAt && stored?.hasSecret && stored?.secret && stored?.model && stored?.endpoint), provider, model: stored?.model || null };
}
function validateProfile(profile) {
  const url = new URL(profile.endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !profile.apiKey || !profile.model) throw new Error("Evaluation requires a complete credential-free HTTPS endpoint and model profile");
  return profile;
}
async function main(options) {
  const parent = path.resolve(__dirname, "../qa/personal-evals"); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, `${options.mode}-`));
  const result = plan(options);
  const directory = options.configDir || configDirectory();
  if (options.mode === "plan") {
    saveReport(root, result);
    console.log(JSON.stringify({ status: result.status, apiCalls: 0, report: path.join(root, "report.html") }, null, 2)); return 0;
  }
  const status = preflight(directory);
  if (!status.ready) {
    result.status = "blocked_requires_api";
    result.blocker = "请在 Agent Deck「设置 → 执行引擎」保存并验证模型 API。尚未发送模型请求；不要把密钥发到聊天里。";
    saveReport(root, result);
    console.log(JSON.stringify({ status: result.status, apiCalls: 0, report: path.join(root, "report.html") }, null, 2)); return 2;
  }
  if (options.mode === "preflight") {
    result.status = "ready_not_measured"; result.model = status.model;
    result.blocker = "API 配置已保存并验证，但本次只检查元数据，未解密密钥或发送请求。真实运行需要 --live。";
    saveReport(root, result);
    console.log(JSON.stringify({ status: result.status, apiCalls: 0, report: path.join(root, "report.html") }, null, 2)); return 0;
  }
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === "1") throw new Error("Use npm run eval:personal:live for macOS secure storage access");
  const { app, safeStorage } = require("electron");
  fs.mkdirSync(path.join(root, "electron-profile"));
  app.setName("agent-deck-demo"); app.setPath("userData", path.join(root, "electron-profile"));
  await app.whenReady();
  const registry = new ProviderRegistry({ userDataPath: directory, safeStorage });
  let profile;
  try {
    const selected = registry.selectRuntime({ runtimeMode: "agent_deck", provider: status.provider });
    profile = validateProfile({ ...registry.apiProfile(selected.provider), provider: selected.provider });
  } catch {
    result.status = "blocked_secure_profile"; result.blocker = "无法安全读取已验证的模型配置；请在设置检查凭据与 HTTPS 地址。未发送请求，未修改原配置。";
    saveReport(root, result);
    console.log(JSON.stringify({ status: result.status, apiCalls: 0, report: path.join(root, "report.html") }, null, 2)); return 2;
  }
  // Runtime files live in a separate empty directory from Electron's isolated profile.
  const runRoot = path.join(root, "runs");
  const measured = await runSuite({ ...options, root: runRoot, profile, onProgress: event => console.log(JSON.stringify(event)) });
  console.log(JSON.stringify({ status: measured.status, apiCalls: measured.protocol.apiCalls, report: path.join(runRoot, "report.html") }, null, 2));
  return measured.runs.every(run => run.status === "passed") && !measured.budgetStopped ? 0 : 1;
}
if (require.main === module) {
  Promise.resolve().then(() => main(parseArgs(process.argv.slice(2)))).then(code => {
    if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") require("electron").app.exit(code);
    else process.exitCode = code;
  }).catch(() => {
    // Do not print provider/profile errors which may include credential-bearing data.
    console.error("Evaluation stopped. Check CLI options and the verified model API in Settings; no automatic retry.");
    if (process.versions.electron && process.env.ELECTRON_RUN_AS_NODE !== "1") require("electron").app.exit(1);
    else process.exitCode = 1;
  });
}
module.exports = { parseArgs, configDirectory, preflight, validateProfile };
