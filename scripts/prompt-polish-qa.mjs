// Real renderer/IPC with disposable ledger; polish candidates explicitly labelled fixtures.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/prompt-polish"); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_POLISH_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Real renderer/IPC, isolated real ledger snapshot; synthetic rewrite candidates, not model quality evidence", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", e => report.errors.push(e.message));
  await page.getByLabel("记录一件事").waitFor();
  const missions = await page.evaluate(() => window.agentDeckDesktop.missions.list());
  await page.getByLabel("记录一件事").fill("QA：整理已有笔记，不联网");
  await page.getByRole("button", { name: "记下来", exact: true }).click();
  await page.getByRole("heading", { name: "把这件事准备好" }).waitFor();
  const name = page.getByLabel("任务名称", { exact: true }), body = page.getByLabel("笔记与背景", { exact: true });
  await body.fill("保留来源，不修改原文件。"); await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  const savedNote = (await page.evaluate(() => window.agentDeckDesktop.requirements.list())).find(n => n.title.startsWith("QA：整理"));
  await page.getByRole("button", { name: "帮我润色", exact: true }).click();
  await page.getByText("润色建议 · 尚未应用", { exact: true }).waitFor();
  assert.equal(await name.inputValue(), savedNote.title);
  assert.equal((await page.evaluate(id => window.agentDeckDesktop.requirements.list().then(items => items.find(n => n.id === id)), savedNote.id)).title, savedNote.title);
  for (const [width, height] of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await page.locator(".prompt-polish").scrollIntoViewIfNeeded(); await capture("saved-preview-" + width);
  }
  await page.getByRole("button", { name: "保留原文", exact: true }).click(); assert.equal(await name.inputValue(), savedNote.title);
  await page.getByRole("button", { name: "帮我润色", exact: true }).click(); await page.getByText("润色建议 · 尚未应用", { exact: true }).waitFor();
  await page.getByRole("button", { name: "采用这版", exact: true }).click(); assert.match(await name.inputValue(), /^润色候选/);
  await page.getByRole("button", { name: "撤销润色", exact: true }).click(); assert.equal(await name.inputValue(), savedNote.title);
  await body.fill("慢模式：我会在请求中途改原文。");
  await page.getByRole("button", { name: "帮我润色", exact: true }).click(); await name.fill("请求中途的新编辑");
  await page.getByText("润色建议 · 尚未应用", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "采用这版", exact: true }).isEnabled(), false);
  await page.getByRole("button", { name: "重新润色", exact: true }).click(); await page.getByRole("button", { name: "取消润色", exact: true }).click();
  await page.waitForTimeout(700); assert.equal(await name.inputValue(), "请求中途的新编辑"); assert.equal(await page.locator(".polish-candidate").count(), 0);
  await body.fill("失败模式"); await page.getByRole("button", { name: "帮我润色", exact: true }).click(); await page.getByRole("alert").waitFor();
  assert.equal(await body.inputValue(), "失败模式");
  await body.fill("新的背景，不联网。"); await page.getByRole("button", { name: "帮我润色", exact: true }).click(); await page.getByText("润色建议 · 尚未应用", { exact: true }).waitFor();
  await page.getByRole("button", { name: "采用这版", exact: true }).click(); await page.getByRole("button", { name: "保存笔记", exact: true }).click();
  const latest = await page.evaluate(id => window.agentDeckDesktop.requirements.list().then(items => items.find(n => n.id === id)), savedNote.id);
  assert.match(latest.title, /^润色候选/); assert.equal(latest.outcome, ""); assert.equal(latest.missionId, null);
  await page.getByRole("button", { name: "重新润色", exact: true }).click(); await page.getByText("润色建议 · 尚未应用", { exact: true }).waitFor();
  // Switching notes must dispose the pending request/candidate, never leak it to another note.
  await page.getByLabel("记录一件事").fill("第二条笔记"); await page.getByRole("button", { name: "记下来", exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.draft-detail input')?.value === "第二条笔记");
  assert.equal(await page.locator(".polish-candidate").count(), 0);
  // Quick capture reuse opens editing, not execution, and saves the full adopted draft.
  await page.getByLabel("记录一件事").fill("先润色再保存"); await page.getByRole("button", { name: "润色一下", exact: true }).click();
  const composer = page.getByRole("form", { name: "新建工作" }); await composer.waitFor();
  await composer.getByRole("button", { name: "帮我润色", exact: true }).click(); await composer.getByText("润色建议 · 尚未应用", { exact: true }).waitFor();
  for (const [width, height] of [[1540, 960], [1120, 720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await composer.locator(".prompt-polish").scrollIntoViewIfNeeded(); await capture("composer-preview-" + width);
  }
  await composer.getByRole("button", { name: "采用这版", exact: true }).click(); await composer.getByRole("button", { name: "保存需求", exact: true }).click();
  await composer.waitFor({ state: "detached" });
  assert.equal(await page.getByLabel("记录一件事").inputValue(), "");
  assert.equal((await page.evaluate(() => window.agentDeckDesktop.missions.list())).length, missions.length);
  assert.equal(report.errors.length, 0); assert.ok(report.checks.every(c => !c.failures.length));
  report.behavior = "save without execution; preview/apply/undo; stale edit; cancel; failure preserves input; repolish; note selection; quick capture";
  console.log(JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  async function capture(name) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, name + ".png") });
    report.checks.push(await page.evaluate(name => {
      const failures = []; if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("Root overflow");
      for (const selector of [".quick-capture", ".requirement-composer", ".polish-actions", ".polish-toolbar", ".prompt-polish"]) {
        const e = document.querySelector(selector); if (!e?.getClientRects().length) continue;
        const r = e.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1) failures.push(selector + " horizontal clipping");
      }
      return { name, width: innerWidth, height: innerHeight, failures };
    }, name));
  }
} catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, "failure.png") }); throw error; }
finally { await app.close(); }
