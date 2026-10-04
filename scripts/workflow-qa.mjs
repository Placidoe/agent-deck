// Actual renderer + real ledger copy. No model calls, mock chat, or real-profile writes.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/workflow"); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_WORKFLOW_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Real local ledger snapshot, isolated writes; no executors", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", error => report.errors.push(error.message));
  const nav = page.getByRole("navigation", { name: "主导航" });
  await page.getByLabel("记录一件事").waitFor();
  const before = await page.evaluate(() => window.agentDeckDesktop.missions.list());
  await page.getByLabel("记录一件事").fill("体验任务单：先记笔记，再开始做");
  await page.getByRole("button", { name: "记下来", exact: true }).click();
  await page.getByRole("heading", { name: "把这件事准备好" }).waitFor();
  if (await page.getByRole("button", { name: "开始做 · 拆解计划" }).isEnabled()) throw new Error("Draft can start without completion criteria");
  await page.getByLabel("笔记与背景").fill("先保存，不调用模型。准备好后再填写完成标准。");
  await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  const after = await page.evaluate(() => window.agentDeckDesktop.missions.list());
  if (before.length !== after.length) throw new Error("Saving notes created execution");
  const mode = page.getByRole("combobox").last(); await mode.click();
  await page.getByRole("listbox").waitFor(); await page.keyboard.press("Escape");
  if (await page.getByRole("listbox").count()) throw new Error("Custom listbox did not close on Escape");
  for (const [width, height] of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await nav.getByRole("button", { name: "工作", exact: true }).click(); await page.locator(".quick-capture").waitFor(); await capture("notes-" + width);
    await nav.getByRole("button", { name: "成果", exact: true }).click(); await page.locator(".library-sidebar").waitFor();
    await capture("library-" + width);
    await page.getByRole("button", { name: /产品文档 · 只读测试/ }).click();
    await page.locator(".library-filename").first().waitFor(); await capture("folder-" + width);
    await page.locator(".library-filename").filter({ hasText: "personal-agent-architecture.html" }).click();
    await page.getByRole("dialog", { name: "文件预览" }).waitFor();
    if (await page.locator(".library-preview iframe").getAttribute("sandbox") !== "") throw new Error("Preview sandbox widened");
    await capture("preview-" + width); await page.getByRole("button", { name: "关闭预览" }).click();
    await page.getByRole("button", { name: /验收清单/ }).click(); await capture("reviews-" + width);
    await page.getByRole("button", { name: "文档与资产", exact: true }).click();
    await page.getByRole("button", { name: "全部登记产物", exact: true }).click();
    await page.getByRole("button", { name: "工作与会话记录", exact: true }).click();
    await page.locator(".library-history-row>button").first().waitFor(); await capture("history-" + width);
    await page.locator(".history-sessions").first().click(); await page.getByRole("dialog", { name: "来源会话列表" }).waitFor();
    await capture("sessions-" + width); await page.getByRole("button", { name: "关闭会话列表" }).click();
    await page.locator(".library-history-row>button").first().click(); await page.locator(".mission-inspector").waitFor();
    if (await page.locator(".agent-compose").count()) throw new Error("Node details opened a composer by default");
    await page.waitForFunction(() => { const viewport = document.querySelector(".graph-viewport")?.getBoundingClientRect(); const nodes = [...document.querySelectorAll(".react-flow__node")]; return viewport && nodes.length && nodes.every(node => { const r = node.getBoundingClientRect(); return r.left >= viewport.left && r.right <= viewport.right && r.top >= viewport.top && r.bottom <= viewport.bottom; }); }, { timeout: 5000 }).catch(async error => { await page.screenshot({ path: path.join(output, "fit-failure.png") }); console.log(await page.evaluate(() => { const box = selector => [...document.querySelectorAll(selector)].map(e => ({ rect: e.getBoundingClientRect().toJSON(), style: e.getAttribute("style") })); return { graph: box(".graph-viewport"), flow: box(".react-flow"), viewport: box(".react-flow__viewport"), nodes: box(".react-flow__node") }; })); throw error; });
    await capture("dag-" + width);
    await page.getByRole("button", { name: "进入对话", exact: true }).click(); await page.locator(".agent-compose").waitFor(); await capture("intervene-" + width);
  }
  console.log(JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  if (report.errors.length || report.checks.some(c => c.failures.length)) process.exitCode = 1;
  async function capture(name) {
    // Wait for layout/frame, not provider completion.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, name + ".png") });
    report.checks.push(await page.evaluate(name => {
      const failures = []; if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("Root overflow");
      for (const selector of [".product-navigation", ".quick-capture", ".library-layout", ".library-preview", ".mission-inspector", ".agent-compose"]) {
        const element = document.querySelector(selector); if (!element?.getClientRects().length) continue;
        const r = element.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1) failures.push(selector + " clipped");
      }
      return { name, width: innerWidth, height: innerHeight, failures };
    }, name));
  }
} finally { await app.close(); }
