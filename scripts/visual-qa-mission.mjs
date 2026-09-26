import { chromium } from "playwright";

const target = process.env.AGENT_DECK_QA_URL || "http://127.0.0.1:4175/";
const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const page = await browser.newPage({ viewport: { width: 1488, height: 1058 }, deviceScaleFactor: 1 });
const consoleErrors = [];
const failedResponses = [];
page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
page.on("pageerror", (error) => consoleErrors.push(error.message));
page.on("response", (response) => { if (response.status() >= 400) failedResponses.push(`${response.status()} ${response.url()}`); });

await page.goto(target, { waitUntil: "networkidle" });
await page.getByRole("heading", { name: "Open Agent Deck.app to run real missions" }).waitFor();
const metrics = await page.evaluate(() => ({
  width: document.documentElement.clientWidth,
  scrollWidth: document.documentElement.scrollWidth,
  height: document.documentElement.clientHeight,
  scrollHeight: document.documentElement.scrollHeight,
  taskRows: document.querySelectorAll(".task-row").length,
  agentNodes: document.querySelectorAll(".agent-node").length,
  busMessages: document.querySelectorAll(".bus-message").length,
}));
await page.screenshot({ path: "implementation-mission-workspace.png", fullPage: false });
if (metrics.taskRows || metrics.agentNodes || metrics.busMessages) throw new Error("Browser preview fabricated mission runtime records");
if (metrics.scrollWidth !== metrics.width || metrics.scrollHeight !== metrics.height) throw new Error("Mission preview overflows the viewport");
if (consoleErrors.length || failedResponses.length) throw new Error(JSON.stringify({ consoleErrors, failedResponses }));
console.log(JSON.stringify({ target, metrics, consoleErrors, failedResponses, screenshot: "implementation-mission-workspace.png" }, null, 2));
await browser.close();
