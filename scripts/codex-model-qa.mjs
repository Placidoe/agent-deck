// Real failing Mission snapshot + actual catalog reads only. No inference/retry.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/codex-model"); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_MODEL_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Isolated real-ledger snapshot, actual catalog; no inference or retry", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", error => report.errors.push(error.message));
  await page.getByLabel("记录一件事").waitFor();
  const target = await page.evaluate(async () => (await window.agentDeckDesktop.missions.list()).find(m => m.status === "failed" && /not supported when using Codex/.test(m.error || "")));
  if (!target) throw new Error("No actual model-failure record available for visual QA");
  await page.locator(".requirement-list>button").filter({ hasText: target.title }).click();
  await page.locator(".primary-next").click();
  const recovery = page.getByRole("region", { name: "Codex 模型恢复" });
  await recovery.getByRole("button", { name: "使用此模型重新生成计划" }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.codex-plan-recovery button.primary-button')?.disabled);
  for (const [width, height] of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await recovery.getByRole("combobox").click(); await page.getByRole("listbox").waitFor();
    await page.keyboard.press("Escape");
    if (await page.getByRole("listbox").count()) throw new Error("Catalog picker did not close on Escape");
    await recovery.locator("summary").click();
    await page.screenshot({ path: path.join(output, `recovery-${width}.png`) });
    report.checks.push(await page.evaluate(() => {
      const failures = []; if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("Root overflow");
      for (const selector of [".codex-plan-recovery", ".mission-inspector", ".codex-plan-recovery-controls .primary-button"]) {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        if (!r || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) failures.push(selector + " clipped");
      }
      return { width: innerWidth, height: innerHeight, failures };
    }));
    await recovery.locator("summary").click();
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length || report.checks.some(c => c.failures.length)) process.exitCode = 1;
} finally { await app.close(); }
