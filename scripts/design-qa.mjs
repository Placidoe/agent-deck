// Optional regression runner; only uses the isolated, real-ledger-copy harness.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/design");
fs.mkdirSync(output, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const errors = [];
const report = { source: "Real ledger copy; no executor", checks: [] };
try {
  const page = await app.firstWindow();
  page.on("pageerror", error => errors.push(error.message));
  const nav = page.getByRole("navigation", { name: "主导航" });
  for (const [width, height] of [[1540,960], [1120,720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await nav.getByRole("button", { name: "工作", exact: true }).click();
    await page.locator(".requirement-detail .primary-next").waitFor();
    await capture("work-" + width);
    const title = await page.locator(".detail-heading h1").innerText();
    await page.locator(".primary-next").click();
    await page.locator(".mission-body").waitFor();
    await capture("execution-" + width);
    await page.getByRole("button", { name: "返回工作", exact: true }).click();
    await page.locator(".detail-heading h1").waitFor();
    if (await page.locator(".detail-heading h1").innerText() !== title) throw new Error("Work selection lost");
    await nav.getByRole("button", { name: /待我处理/ }).click();
    await page.getByRole("button", { name: "逐项处理", exact: true }).click();
    await capture("attention-" + width);
    await nav.getByRole("button", { name: "成果", exact: true }).click();
    await page.locator(".library-file-row").first().waitFor();
    await capture("results-" + width);
    await page.locator('.library-file-actions button[title="查看来源工作"]').first().click();
    await page.locator(".artifact-view").waitFor();
    if (await page.locator(".mission-inspector").isVisible()) throw new Error("Outcome view still has execution inspector");
    await capture("outputs-" + width);
    await page.getByRole("button", { name: "查看执行过程", exact: true }).click();
    // Same-Mission view changes must not clear the detail without triggering a fetch.
    await page.locator(".graph-viewport").waitFor();
    await page.locator(".mission-inspector").waitFor();
    await capture("outputs-to-execution-" + width);
  }
  report.errors = errors;
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (errors.length || report.checks.some(check => check.failures.length)) process.exitCode = 1;
  async function capture(name) {
    await page.screenshot({ path: path.join(output, name + ".png") });
    report.checks.push(await page.evaluate(name => {
      const failures = [];
      if (document.documentElement.scrollWidth > innerWidth) failures.push("Root horizontal overflow");
      for (const selector of [".product-navigation", ".work-navigation", ".mission-inspector", ".mission-toolbar", ".agent-compose"]) {
        const element = document.querySelector(selector);
        if (!element || !element.getClientRects().length) continue;
        const { right, bottom } = element.getBoundingClientRect();
        if (right > innerWidth + 1 || bottom > innerHeight + 1) failures.push(selector + " outside window");
      }
      return { name, failures, width: innerWidth, height: innerHeight };
    }, name));
  }
} finally { await app.close(); }
