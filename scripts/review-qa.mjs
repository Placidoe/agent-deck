// Real renderer + real send-message controller; labelled fixtures, no inference.
import { _electron as electron } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { qaAppearance } from "./ui-qa-appearance.mjs";
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const output = path.join(root, "qa/review", process.env.AGENT_DECK_QA_APPEARANCE || "system"); fs.mkdirSync(output, { recursive: true });
const env = { ...process.env, AGENT_DECK_REVIEW_QA: "1" }; delete env.ELECTRON_RUN_AS_NODE;
const app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/.bin/electron"), args: [path.join(root, "scripts/design-qa-main.cjs")], env });
const report = { source: "Disposable ledger; labelled review fixtures; real renderer/IPC/controller; no model-quality claims", checks: [], errors: [] };
try {
  const page = await app.firstWindow(); page.on("pageerror", error => report.errors.push(error.message));
  await qaAppearance(page);
  await page.locator(".requirement-detail .primary-next").waitFor();
  await page.locator(".primary-next").click();
  await page.locator(".mission-body").waitFor();
  await page.locator(".task-row").filter({ hasText: "开源贡献候选审阅" }).click();
  await page.locator('.mission-inspector > nav button').nth(1).click();
  const review = page.getByTestId("review-center"); await review.waitFor();
  assert.equal(await review.locator("textarea").count(), 2);
  assert.equal(await review.getByRole("button", { name: "暂不可验收", exact: true }).isEnabled(), false);
  const one = review.getByLabel("第 1 项处理意见"), two = review.getByLabel("第 2 项处理意见");
  await one.fill("先提供候选，不要替我发布 PR。");
  await two.fill("先比较两个模型，暂不认领。");
  assert.equal(await one.inputValue(), "先提供候选，不要替我发布 PR。");
  assert.equal(await two.inputValue(), "先比较两个模型，暂不认领。");
  await page.locator('.mission-inspector > nav button').nth(2).click(); await page.locator('.mission-inspector > nav button').nth(1).click();
  assert.equal(await one.inputValue(), "先提供候选，不要替我发布 PR。");
  await page.locator(".task-row").filter({ hasText: "前置证据" }).click(); await page.locator('.mission-inspector > nav button').nth(1).click();
  assert.equal(await page.getByLabel("第 1 项处理意见").inputValue(), "");
  await page.locator(".task-row").filter({ hasText: "开源贡献候选审阅" }).click(); await page.locator('.mission-inspector > nav button').nth(1).click();
  assert.equal(await one.inputValue(), "先提供候选，不要替我发布 PR。");
  // Shared files open through the real sandboxed artifact preview bridge.
  const reference = review.getByRole("complementary", { name: "参考依据与共享上下文" });
  await reference.locator('summary').filter({ hasText: "REVIEW 的参考" }).click();
  await reference.getByRole("button", { name: /reference.html/ }).last().click();
  await page.locator(".artifact-preview-modal iframe").waitFor();
  await page.locator(".artifact-preview-modal button.close").click();
  assert.equal(await one.inputValue(), "先提供候选，不要替我发布 PR。");
  for (const [width, height] of [[1540,960], [1120,720]]) {
    await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(...size), [width, height]);
    await review.evaluate(element => element.scrollIntoView({ block: "start" })); await capture("items-" + width);
    await reference.scrollIntoViewIfNeeded(); await capture("references-" + width);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1540, 960));
  await review.getByRole("button", { name: "展开审阅", exact: true }).click();
  await review.evaluate(element => element.scrollIntoView({ block: "start" })); await capture("focused-review-1540");
  // A single item can be sent. The real queue reports failure and preserves drafts.
  await two.fill("");
  await review.getByRole("button", { name: "发送 1 项反馈", exact: true }).click();
  await review.getByRole("status").filter({ hasText: "反馈未送达" }).waitFor();
  assert.equal(await one.inputValue(), "先提供候选，不要替我发布 PR。");
  assert.equal(await review.getByRole("button", { name: "发送 1 项反馈", exact: true }).isEnabled(), true);
  const sent = await app.evaluate(() => globalThis.reviewQa.sent);
  assert.equal(sent.length, 1); assert.ok(sent[0].prompt.includes("UNANSWERED ITEMS"));
  assert.equal(sent[0].prompt.includes("暂不认领。"), false);
  await capture("delivery-failed");
  // Explicitly replace result in disposable store; never import old draft by index.
  await app.evaluate(({ BrowserWindow }) => {
    const qa = globalThis.reviewQa; const task = qa.store.getTask(qa.taskId);
    qa.store.updateTask(task.id, { result: { ...task.result, blockers: ["新一轮：需要确认实现范围"] } });
    BrowserWindow.getAllWindows()[0].webContents.send("mission:update", { missionId: qa.missionId, revision: 100 });
  });
  await review.getByText("新一轮：需要确认实现范围", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("第 1 项处理意见").inputValue(), "");
  await review.getByText("查看之前轮次的意见 · 不会自动应用", { exact: true }).click();
  await review.getByText("先提供候选，不要替我发布 PR。", { exact: true }).waitFor();
  await review.getByRole("button", { name: /填入反馈模板/ }).click();
  assert.ok((await page.getByLabel("第 1 项处理意见").inputValue()).includes("我的决定或补充："));
  await app.evaluate(() => { globalThis.reviewQa.failDelivery = false; });
  await review.getByRole("button", { name: "发送 1 项反馈", exact: true }).click();
  await review.waitFor({ state: "detached" });
  const state = await app.evaluate(() => ({ status: globalThis.reviewQa.store.getTask(globalThis.reviewQa.taskId).status, calls: globalThis.reviewQa.sent.length }));
  assert.equal(state.status, "running"); assert.equal(state.calls, 2);
  assert.equal(await page.locator(".agent-compose textarea").isVisible(), false);
  assert.equal(report.errors.length, 0); assert.ok(report.checks.every(check => !check.failures.length));
  report.behavior = "independent fields; task/tab isolation; secure artifact preview; desktop/narrow/focused layouts; one-message partial feedback; delivery failure retry; new-round isolation and draft history; template no inference; conversation stays closed";
  console.log(JSON.stringify(report, null, 2)); fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
  async function capture(name) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.screenshot({ path: path.join(output, name + ".png") });
    report.checks.push(await page.evaluate(name => {
      const failures = []; if (document.documentElement.scrollWidth > innerWidth + 1) failures.push("Root overflow");
      for (const selector of [".review-workbench", ".review-item", ".review-reference-region", ".review-submit", ".mission-inspector"]) {
        for (const element of document.querySelectorAll(selector)) {
          if (!element.getClientRects().length) continue;
          const r = element.getBoundingClientRect(); if (r.right > innerWidth + 1 || r.left < -1 || element.scrollWidth > element.clientWidth + 2) failures.push(selector + " horizontal clipping");
        }
      }
      return { name, width: innerWidth, height: innerHeight, failures };
    }, name));
  }
} catch (error) { const page = await app.firstWindow(); await page.screenshot({ path: path.join(output, "failure.png") }); throw error; }
finally { await app.close(); }
