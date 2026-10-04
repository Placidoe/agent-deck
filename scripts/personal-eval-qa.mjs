import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { plan, saveReport, sandboxPreview } = require("./personal-eval-core.cjs");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-eval-qa-"));
const screenshots = path.join(root, "qa/personal-eval-layout"); fs.mkdirSync(screenshots, { recursive: true });
const generated = path.join(profile, "report"); const result = plan();
result.blocker = "模型 API 尚未配置并验证。没有真实耗时、得分或 Token，不展示模拟收益。";
saveReport(generated, result);
const hostile = path.join(profile, "hostile-preview.html");
fs.writeFileSync(hostile, sandboxPreview('<html><body><h1>隔离测试</h1><script>document.body.textContent="SCRIPT_EXECUTED";parent.document.body.textContent="ESCAPED"</script><img src="https://must-not-request.test/private"><form action="https://must-not-request.test/send"><button>Submit</button></form></body></html>'));
let app;
try {
  app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [path.join(root, "scripts/personal-eval-qa-main.cjs"), "--disable-gpu"], env: { ...process.env, AGENT_DECK_EVAL_QA_PROFILE: profile, AGENT_DECK_EVAL_QA_DOCUMENT: path.join(generated, "report.html") } });
  const page = await app.firstWindow(); const errors = []; const externalRequests = [];
  await page.getByRole("heading", { level: 1 }).waitFor();
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().startsWith("https://must-not-request.test")) externalRequests.push(request.url()); });
  for (const [label, document] of [["readiness", path.join(generated, "report.html")], ["protocol", path.join(root, "docs/personal-agent-evaluation.html")]]) {
    await app.evaluate(({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0].loadFile(file), document);
    await page.getByRole("heading", { level: 1 }).waitFor();
    for (const [width, height] of [[1540,960], [1120,720]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      await page.screenshot({ path: path.join(screenshots, `${label}-${width}.png`), fullPage: true });
    }
  }
  await app.evaluate(({ BrowserWindow }, file) => BrowserWindow.getAllWindows()[0].loadFile(file), hostile);
  await page.frameLocator("iframe").getByRole("heading", { name: "隔离测试" }).waitFor();
  assert.ok(!(await page.innerText("body")).includes("ESCAPED"));
  assert.equal(await page.locator("iframe").getAttribute("sandbox"), "");
  assert.deepEqual(externalRequests, []); assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, fixtureOnly: true, viewports: [1540,1120], sandboxScriptAndNetworkBlocked: true, screenshots }, null, 2));
} finally { if (app) await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
