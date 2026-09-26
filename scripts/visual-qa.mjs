import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});

const page = await browser.newPage({
  viewport: { width: 1440, height: 1024 },
  deviceScaleFactor: 1,
});

const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push({ text: message.text(), location: message.location() });
});
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("response", (response) => {
  if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`);
});

await page.goto("http://localhost:4173/", { waitUntil: "networkidle" });
await page.locator("[data-session-id='review']").click();
await page.locator(".inspector-title h2").filter({ hasText: "Review auth changes" }).waitFor();

await page.locator(".workspace-tabs").getByRole("button", { name: "Timeline" }).click();
await page.getByRole("heading", { name: "Live timeline" }).waitFor();
await page.locator(".workspace-tabs").getByRole("button", { name: "Usage" }).click();
await page.getByRole("heading", { name: "Capacity & usage" }).waitFor();
await page.locator(".workspace-tabs").getByRole("button", { name: "Sessions" }).click();

const steer = page.getByRole("textbox", { name: "Steer Review auth changes" });
await steer.fill("Preserve the old 401 response for compatibility.");
await page.getByRole("button", { name: "Send to Review auth changes" }).click();
await page.getByText("Applying your latest direction.").first().waitFor();

await page.getByRole("button", { name: "Pause selected" }).click();
await page.getByText("Paused", { exact: true }).first().waitFor();
await page.getByRole("button", { name: "Resume selected" }).click();

await page.getByRole("button", { name: "New session", exact: true }).first().click();
await page.getByRole("heading", { name: "Start a Codex session" }).waitFor();
await page.getByPlaceholder("e.g. Investigate memory leak").fill("Investigate memory leak");
await page.getByPlaceholder("Describe the outcome. You can steer it later.").fill("Find the allocation hot path and propose a safe fix.");
await page.getByRole("button", { name: "Start session" }).click();
await page.getByRole("heading", { name: "Investigate memory leak" }).first().waitFor();

await page.reload({ waitUntil: "networkidle" });
const pageMetrics = await page.evaluate(() => ({
  scrollWidth: document.documentElement.scrollWidth,
  clientWidth: document.documentElement.clientWidth,
  scrollHeight: document.documentElement.scrollHeight,
  clientHeight: document.documentElement.clientHeight,
  cards: document.querySelectorAll(".session-card").length,
}));
await page.screenshot({
  path: "implementation-multi-session.png",
  fullPage: false,
});

console.log(JSON.stringify({
  viewport: "1440x1024",
  interactions: ["session selection", "timeline tab", "usage tab", "per-session steer", "pause/resume", "create session"],
  pageMetrics,
  consoleErrors,
  failedResponses,
  screenshot: "implementation-multi-session.png",
}, null, 2));

await browser.close();
