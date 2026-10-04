// One tiny real-model request, no workspace tools or real Mission writes.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const client = new CodexAppServer();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-model-smoke-"));
let threadId;
let response = "";
let timer;
const completed = new Promise((resolve, reject) => {
  timer = setTimeout(() => reject(new Error("Codex model smoke timed out after 60 seconds")), 60000);
  client.on("event", event => {
    if (!threadId || event.params?.threadId !== threadId) return;
    if (event.method === "item/agentMessage/delta") response += event.params.delta || "";
    if (event.method === "turn/completed") {
      if (event.params.turn?.status === "completed") resolve(event.params.turn);
      else reject(new Error(event.params.turn?.error?.message || "Model turn did not complete"));
    }
  });
});
completed.catch(() => {});
(async () => {
  try {
    const created = await client.createThread({ cwd: workspace, ephemeral: true });
    threadId = created.thread.id;
    console.log(JSON.stringify({ phase: "starting", selectedModel: created.model }));
    await client.sendTurn({ threadId, cwd: workspace, prompt: "Reply with exactly AGENT_DECK_MODEL_OK. Do not use tools or read files.", effort: "low" });
    await completed;
    if (!response.includes("AGENT_DECK_MODEL_OK")) throw new Error("Expected marker was missing");
    console.log(JSON.stringify({ ok: true, model: created.model, response: response.trim(), scope: "ephemeral smoke only, not full Mission evaluation" }));
  } finally {
    clearTimeout(timer); client.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
