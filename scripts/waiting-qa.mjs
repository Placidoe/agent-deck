// Actual renderer + IPC + companion; disposable ledger fixtures, no inference.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { qaAppearance } from "./ui-qa-appearance.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/waiting", process.env.AGENT_DECK_QA_APPEARANCE || "system"); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_WAITING_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Disposable real-ledger copy + labelled waiting fixture; real renderer/IPC, no inference or OS notifications", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", error => report.errors.push(error.message));
  await qaAppearance(page);
  const nav = page.getByRole("navigation", { name: "主导航" });
  await page.locator(".waiting-strip button").waitFor();
  for (const [w, h] of [[1540,960],[1120,720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [w,h]);
    await capture("strip-" + w);
    await page.locator(".waiting-strip button").click(); await page.getByRole("dialog", { name: "等待时做自己的事" }).waitFor();
    await capture("choose-" + w);
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".waiting-strip button").evaluate(node => node === document.activeElement), true);
  }
  await page.locator(".waiting-strip button").click();
  await page.getByRole("button", { name: "继续工作", exact: true }).click();
  await page.getByRole("button", { name: "开始这段个人时间" }).click();
  await page.getByRole("button", { name: "准备下一件事", exact: true }).waitFor();
  const id = await app.evaluate(() => globalThis.waitingQa.service.session.id);
  await capture("active-work-1120");
  await page.getByRole("button", { name: "准备下一件事", exact: true }).click();
  await page.locator(".requirement-list button").filter({ hasText: "准备下一件事 · QA fixture" }).click();
  await page.getByLabel("笔记与背景").fill("等候时补充的背景：不要丢掉这段草稿。");
  await page.getByLabel("记录一件事").fill("另一个还未保存的想法");
  await nav.getByRole("button", { name: "成果", exact: true }).click();
  await page.locator(".library-hub").waitFor();
  await nav.getByRole("button", { name: "工作", exact: true }).click();
  await page.getByLabel("笔记与背景").waitFor();
  assert.equal(await page.getByLabel("笔记与背景").inputValue(), "等候时补充的背景：不要丢掉这段草稿。");
  assert.equal(await page.getByLabel("记录一件事").inputValue(), "另一个还未保存的想法");
  assert.equal(await app.evaluate(() => globalThis.waitingQa.service.session.id), id);
  // Focus deadline expires, but does not stop work or gate execution.
  await app.evaluate(({ BrowserWindow }) => {
    const qa = globalThis.waitingQa; qa.service.session.deadline = Date.now() - 1000;
    qa.store.updateTask(qa.taskId, { status: "waiting_approval" }); qa.service.update(); qa.service.update();
    BrowserWindow.getAllWindows()[0].webContents.send("mission:update", { missionId: qa.missionId });
  });
  await page.locator(".waiting-strip").getByText(/时间到了/).waitFor();
  assert.equal(await app.evaluate(() => globalThis.waitingQa.notices.length), 1);
  assert.equal(await app.evaluate(() => globalThis.waitingQa.store.getTask(globalThis.waitingQa.taskId).status), "waiting_approval");
  await page.locator(".waiting-strip button").click(); await capture("expired-1120");
  await page.getByRole("button", { name: "我回来了 · 看变化" }).click();
  await page.getByRole("heading", { name: "欢迎回来", exact: true }).waitFor();
  assert.equal(await app.evaluate(() => globalThis.waitingQa.service.session), null);
  await capture("recap-1120");
  await page.getByRole("button", { name: "继续我的工作", exact: true }).click();
  await page.locator(".waiting-strip button").click();
  await page.getByRole("button", { name: "不用管我", exact: true }).click();
  await page.getByRole("button", { name: "开始这段个人时间" }).click();
  await page.locator(".waiting-timer strong").getByText("不计时", { exact: true }).waitFor();
  const away = await app.evaluate(() => globalThis.waitingQa.service.session);
  assert.equal(away.reminders, "return"); assert.equal(away.deadline, null);
  // Real persisted fixture results, not invented completion in the renderer.
  await app.evaluate(({ BrowserWindow }) => {
    const qa = globalThis.waitingQa;
    qa.store.addArtifact({ missionId: qa.missionId, taskId: qa.taskId, title: "QA fixture 报告（不是模型输出）", summary: "测试返回差异", files: ["fixture.html"] });
    qa.store.updateTask(qa.taskId, { status: "completed" }); qa.store.updateMission(qa.missionId, { status: "completed" }); qa.service.update();
    BrowserWindow.getAllWindows()[0].webContents.send("mission:update", { missionId: qa.missionId });
  });
  await page.getByRole("button", { name: "我回来了 · 看变化" }).click();
  await page.locator(".waiting-brief button").filter({ hasText: "个人时间 · QA fixture" }).getByText(/完成节点 \+1/).waitFor();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1540,960));
  await capture("recap-1540");
  await page.getByRole("button", { name: "继续我的工作", exact: true }).click();
  await page.reload(); await page.locator(".requirement-hub").waitFor();
  await page.locator(".requirement-list button").filter({ hasText: "准备下一件事 · QA fixture" }).click();
  assert.equal(await page.getByLabel("笔记与背景").inputValue(), "等候时补充的背景：不要丢掉这段草稿。");
  // A newer saved version must not be overwritten by an older window draft.
  await app.evaluate(({ BrowserWindow }) => { const qa = globalThis.waitingQa; qa.store.updateRequirement(qa.noteId, { body: "新保存的版本，不能被旧草稿覆盖" }); BrowserWindow.getAllWindows()[0].webContents.send("mission:update", { missionId: qa.missionId }); });
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="笔记与背景"]')?.value === "新保存的版本，不能被旧草稿覆盖");
  report.behavior = ["timer survives navigation", "current-window note + quick capture drafts survive view switch and reload", "deadline never stops or approves work", "deduplicated blocked reminder with honest unavailable state", "away defaults to no timer/no routine reminder", "real ledger before/after recap", "Escape restores focus"];
  async function capture(name) {
    await page.screenshot({ path: path.join(output, `${name}.png`) });
    report.checks.push(await page.evaluate(name => {
      const failures = [];
      if (document.documentElement.scrollWidth > innerWidth) failures.push("root overflow");
      for (const selector of [".waiting-panel", ".waiting-strip", ".product-navigation", ".product-content"]) {
        const el = document.querySelector(selector); if (!el?.getClientRects().length) continue;
        const r = el.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.bottom > innerHeight + 1 || r.left < -1) failures.push(selector + " clipped");
        if (el.scrollWidth > el.clientWidth + 1) failures.push(selector + " horizontal overflow");
      }
      return { name, width: innerWidth, height: innerHeight, failures };
    }, name));
  }
} finally { await app.close(); fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
if (report.errors.length || report.checks.some(item => item.failures.length)) process.exitCode = 1;
