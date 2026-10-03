import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-mode-qa-"));
const screenshotRoot = path.join(root, "qa/runtime-mode");
fs.mkdirSync(screenshotRoot, { recursive: true });
fs.writeFileSync(path.join(userData, "provider-profiles.json"), JSON.stringify({ api: {}, runtime: { mode: "agent_deck", externalProvider: "codex", modelProvider: "deepseek" } }));
fs.writeFileSync(path.join(userData, "workspace.json"), JSON.stringify({ path: root }));
let app;
try {
  const packagedApp = process.env.AGENT_DECK_QA_APP_PATH;
  app = await electron.launch({
    executablePath: packagedApp ? path.join(packagedApp, "Contents/MacOS/Agent Deck") : path.resolve(root, "../research/labs/grokbot-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"),
    args: [...(packagedApp ? [] : [root]), `--user-data-dir=${userData}`, "--disable-gpu"],
    env: { ...process.env, CODEX_BINARY: "/no-codex-in-native-mode-qa" },
  });
  const page = await app.firstWindow();
  const errors = []; page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("heading", { name: "谁来掌握执行过程" }).waitFor();
  const native = page.getByRole("button", { name: /自有引擎 · Beta/ });
  await page.waitForFunction(() => document.querySelector('.runtime-mode-options button[aria-pressed="true"]')?.textContent.includes("Agent Deck Harness"));
  assert.equal(await native.getAttribute("aria-pressed"), "true");
  const status = await page.evaluate(() => window.agentDeckDesktop.codex.status());
  assert.equal(status.inactive, true);
  assert.equal(status.error, undefined);
  assert.equal(await app.evaluate(async ({ app }) => {
    const load = process.mainModule.require.bind(process.mainModule);
    const { join } = load("node:path");
    // Import through the real CommonJS runtime module, not Playwright's VM:
    // that VM does not install a dynamic-import callback.
    const { NativeHarnessRuntime } = load(join(app.getAppPath(), "desktop/native-harness-runtime.cjs"));
    const runtime = new NativeHarnessRuntime({ rootDirectory: join(app.getPath("userData"), "sdk-load-qa"), providerRegistry: {} });
    const sdk = await runtime.sdk;
    return typeof sdk.AgentHarness === "function" && typeof sdk.createModelAdapters === "function";
  }), true);
  assert.equal(await page.getByRole("button", { name: "外部会话", exact: true }).count(), 0);
  for (const [width, height] of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.screenshot({ path: path.join(screenshotRoot, `settings-${width}.png`) });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  }
  await page.getByRole("button", { name: /热插拔 \+ 轻量编排/ }).click();
  await page.waitForFunction(() => document.querySelector('.runtime-mode-options button[aria-pressed="true"]')?.textContent.includes("外部 Coding Agent"));
  assert.equal((await page.evaluate(() => window.agentDeckDesktop.runtime.get())).mode, "external");
  await native.click();
  await page.waitForFunction(() => document.querySelector('.runtime-mode-options button[aria-pressed="true"]')?.textContent.includes("Agent Deck Harness"));
  assert.equal((await page.evaluate(() => window.agentDeckDesktop.runtime.get())).mode, "agent_deck");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, nativeCodexInactive: true, switchPersisted: true, viewports: [1540, 1120], screenshotRoot }, null, 2));
} finally {
  if (app) await app.close();
  fs.rmSync(userData, { recursive: true, force: true });
}
