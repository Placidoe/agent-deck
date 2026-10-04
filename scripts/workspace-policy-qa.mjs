// Real ledger snapshot + labelled workspace layout scenario, no model/execution.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/workspace-policy"); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_WORKSPACE_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Disposable real-ledger snapshot; explicitly labelled preparation scenario. No inference or worker dispatch.", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", error => report.errors.push(error.message));
  await page.getByLabel("记录一件事").waitFor();
  const target = await page.evaluate(async () => (await window.agentDeckDesktop.missions.list()).find(m => m.executionMode === "auto" && m.status === "ready"));
  if (!target) throw new Error("No workspace layout scenario");
  const requirementTitle = await page.evaluate(async id => (await window.agentDeckDesktop.requirements.list({})).find(r => r.missionId === id)?.title, target.id);
  await page.locator(".requirement-list>button").filter({ hasText: requirementTitle || target.title }).click();
  await page.locator(".primary-next").click();
  await page.getByRole("button", { name: "审阅计划", exact: true }).click();
  await page.locator(".workspace-preparation").waitFor();
  for (const size of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
    await page.screenshot({ path: path.join(output, `workspace-${size[0]}.png`) });
    report.checks.push(await page.evaluate(() => {
      const failures = [];
      if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("Root overflow");
      for (const selector of [".workspace-preparation", ".mission-toolbar", ".mission-decision-dock"]) {
        const r = document.querySelector(selector)?.getBoundingClientRect();
        if (r && (r.right > innerWidth + 1 || r.left < -1)) failures.push(selector + " clipped horizontally");
      }
      const list = document.querySelector(".workspace-preparation ul");
      if (list && list.clientHeight > 165) failures.push("Unbounded file manifest");
      return { width: innerWidth, height: innerHeight, failures };
    }));
  }
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (report.errors.length || report.checks.some(c => c.failures.length)) process.exitCode = 1;
} finally { await app.close(); }
