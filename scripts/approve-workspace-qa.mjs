// Actual approve IPC/controller + isolated ledger; transport is no-inference.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/approve-workspace"); fs.mkdirSync(output, { recursive: true });
const report = { source: "Isolated real-ledger snapshot and actual approval controller; no-inference transport. No original ledger mutations or workers.", checks: [], errors: [] };
for (const entry of ["graph", "spec"]) {
  const env = { ...process.env, AGENT_DECK_APPROVE_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
  try {
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on("pageerror", error => report.errors.push(error.message));
    await page.getByLabel("记录一件事").waitFor();
    const target = await page.evaluate(async () => {
      const workspace = await window.agentDeckDesktop.currentWorkspace();
      return (await window.agentDeckDesktop.missions.list()).find(m => m.cwd === workspace.path && m.status === "ready" && m.executionMode === "code");
    });
    if (!target) throw new Error("No actual unstarted legacy plan in the selected workspace");
    const title = await page.evaluate(async id => (await window.agentDeckDesktop.requirements.list({})).find(r => r.missionId === id)?.title, target.id);
    await page.locator(".requirement-list>button").filter({ hasText: title || target.title }).click();
    await page.locator(".primary-next").click();
    if (entry === "spec") await page.getByRole("button", { name: "审阅计划", exact: true }).click();
    const before = await page.evaluate(id => window.agentDeckDesktop.missions.get(id), target.id);
    await page.locator(entry === "spec" ? ".spec-view .approve-plan" : ".mission-decision-dock .decision-start").click();
    await page.getByRole("heading", { name: "Agent 正在评估工作区" }).waitFor();
    const after = await page.evaluate(id => window.agentDeckDesktop.missions.get(id), target.id);
    if (after.status !== "planning" || !after.spec.workspacePending || after.tasks.some(t => t.agentThreadId || t.worktreePath) || JSON.stringify(after.tasks.map(t => t.id)) !== JSON.stringify(before.tasks.map(t => t.id))) throw new Error("Approval did not preserve the gated legacy DAG");
    for (const size of [[1540, 960], [1120, 720]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), size);
      await page.screenshot({ path: path.join(output, `${entry}-${size[0]}.png`) });
      const checks = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth + 1, errors: document.querySelectorAll(".runtime-error").length }));
      report.checks.push({ entry, size, ...checks, preservedTaskIds: true, workerCount: 0 });
      if (checks.overflow || checks.errors) throw new Error("Preparation view overflow or runtime error");
    }
  } finally { await app.close(); }
}
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (report.errors.length) process.exitCode = 1;
