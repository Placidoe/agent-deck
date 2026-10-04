import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-personal-tools-qa-"));
const screenshots = path.join(root, "qa/personal-tools"); fs.mkdirSync(screenshots, { recursive: true });
let app;
try {
  app = await electron.launch({ executablePath: path.resolve(root, "../research/labs/grokbot-desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"), args: [path.join(root, "scripts/personal-tools-qa-main.cjs"), "--disable-gpu"], env: { ...process.env, AGENT_DECK_PERSONAL_QA_ROOT: profile } });
  const page = await app.firstWindow(); const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.getByRole("button", { name: /QA · 受控资料与网页/ }).click();
  await page.getByRole("button", { name: "查看执行详情", exact: true }).click();
  await page.locator(".task-row").first().click();
  await page.getByRole("button", { name: "批准本轮读取", exact: true }).waitFor();
  const stats = () => app.evaluate(({ ipcMain }) => ipcMain._invokeHandlers.get("qa:stats")(null));
  assert.equal((await stats()).webRequests, 0);
  const shot = async (state) => {
    for (const [width, height] of [[1540,960],[1120,720]]) {
      await app.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size.width, size.height), { width, height });
      // Refit for screenshot inspection; runtime preserves a user's viewport on resize.
      await page.locator(".react-flow__controls-fitview").click();
      await page.waitForFunction(() => !document.querySelector('.react-flow__viewport')?.getAnimations({ subtree: true }).some(animation => animation.playState === "running"));
      if (state === "web-approval") {
        const bounds = await page.getByRole("button", { name: "批准本轮读取", exact: true }).boundingBox();
        const scroll = await page.locator(".mission-inspector-scroll").boundingBox();
        assert.ok(bounds.y >= scroll.y && bounds.y + bounds.height <= scroll.y + scroll.height, "Web approval buttons must be visible without scrolling");
      }
      await page.screenshot({ path: path.join(screenshots, `${state}-${width}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
      assert.equal(await page.locator(".mission-inspector").evaluate(el => el.scrollWidth <= el.clientWidth), true);
    }
  };
  assert.match(await page.locator(".approval-action-panel").innerText(), /https:\/\/example.com\/report/);
  await shot("web-approval");
  await page.getByRole("button", { name: "批准本轮读取", exact: true }).click();
  await page.getByRole("button", { name: "Approve action", exact: true }).waitFor();
  assert.equal((await stats()).webRequests, 1);
  await page.getByRole("button", { name: "Approve action", exact: true }).click();
  await page.getByRole("button", { name: "Evidence", exact: true }).click();
  await page.getByRole("heading", { name: /读取过的来源/ }).waitFor();
  await page.waitForFunction(() => document.querySelector(".mission-inspector .review-status-button"));
  assert.equal(await page.locator(".source-receipts details").count(), 2);
  await page.locator(".source-receipts details summary").first().click();
  assert.match(await page.locator(".source-receipts").innerText(), /SHA-256/);
  await shot("source-receipts");
  const result = await stats(); assert.equal(result.calls, 7); assert.equal(result.webRequests, 1);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, fixture: true, humanWebAndWriteApproval: true, sourceReceipts: 2, viewports: [1540,1120], screenshots }, null, 2));
} finally { if (app) await app.close(); fs.rmSync(profile, { recursive: true, force: true }); }
