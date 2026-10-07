// Isolated renderer/consent fixture. This does not start a model or a live task.
import assert from "node:assert/strict";
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/autonomous");
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_AUTONOMY_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Isolated ledger/settings/consent UI fixture; no execution", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", error => report.errors.push(error.message));
  await page.locator('.product-navigation').getByRole("button", { name: "设置", exact: true }).click();
  const manual = page.getByRole("button", { name: /你来确认关键步骤 人工确认/ });
  const automatic = page.getByRole("button", { name: /完整工具权限 · 主 Agent 自检 自主执行/ });
  await manual.waitFor();
  assert.equal(await manual.getAttribute("aria-pressed"), "true");
  // Rejecting the host warning leaves settings unchanged.
  await automatic.click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.runtime-supervision button')].some(button => button.disabled));
  assert.equal(await manual.getAttribute("aria-pressed"), "true");
  for (const [width, height] of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await manual.click();
    await capture(`manual-${width}`);
    await app.evaluate(() => { globalThis.autonomyConsentResponse = true; });
    await automatic.click();
    await page.locator('.runtime-autonomy-warning').waitFor();
    assert.equal(await automatic.getAttribute("aria-pressed"), "true");
    await capture(`autonomous-${width}`);
    await manual.click();
    await page.waitForFunction(() => !document.querySelector('.runtime-autonomy-warning'));
    assert.equal(await manual.getAttribute("aria-pressed"), "true");
  }
  assert.deepEqual(report.errors, []);
  assert.ok(report.checks.every(check => check.failures.length === 0));
  async function capture(name) {
    await page.locator('.runtime-supervision').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, name + ".png") });
    report.checks.push(await page.evaluate(name => {
      const failures = [];
      if (document.documentElement.scrollWidth > innerWidth) failures.push("Root horizontal overflow");
      for (const button of document.querySelectorAll('.runtime-supervision button')) {
        const rect = button.getBoundingClientRect();
        if (rect.right > innerWidth || button.scrollWidth > button.clientWidth + 1) failures.push("Mode card overflow");
      }
      return { name, width: innerWidth, height: innerHeight, failures };
    }, name));
  }
} finally {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2)); await app.close();
}
