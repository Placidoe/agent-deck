const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { missionPlanSchema, normalizePlan, parseStructuredText } = require("../desktop/mission-orchestrator.cjs");

const client = new CodexAppServer();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-mission-smoke-"));

async function main() {
  await client.start();
  const started = await client.request("thread/start", {
    cwd: workspace, ephemeral: true, approvalPolicy: "never", sandbox: "read-only", serviceName: "agent_deck_mission_smoke",
  });
  const threadId = started.thread.id;
  let finalText = "";
  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Structured mission smoke timed out")), 90000);
    client.on("event", (event) => {
      if (event.params?.threadId !== threadId) return;
      if (event.method === "item/completed" && event.params?.item?.type === "agentMessage" && event.params.item.phase !== "commentary") finalText = event.params.item.text || finalText;
      if (event.method === "turn/completed") {
        clearTimeout(timeout);
        if (event.params.turn?.status === "completed") resolve();
        else reject(new Error(event.params.turn?.error?.message || `Turn ${event.params.turn?.status}`));
      }
    });
  });
  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Create a two-task engineering mission for adding a health endpoint and testing it. Do not use tools.", text_elements: [] }],
    outputSchema: missionPlanSchema,
  });
  await completed;
  const plan = normalizePlan(parseStructuredText(finalText));
  console.log(JSON.stringify({ ok: true, threadId, title: plan.title, taskKeys: plan.tasks.map((task) => task.key) }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => {
  client.stop();
  fs.rmSync(workspace, { recursive: true, force: true });
});
