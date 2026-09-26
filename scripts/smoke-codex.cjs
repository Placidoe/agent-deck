const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");

const client = new CodexAppServer();
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-smoke-"));
let output = "";

async function main() {
  await client.start();
  const realtime = await client.request("thread/realtime/listVoices", {});
  if (!realtime.voices?.v2?.length) throw new Error("Codex realtime voices are unavailable");
  const started = await client.request("thread/start", {
    cwd: workspace,
    ephemeral: true,
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "agent_deck_smoke",
  });
  const threadId = started.thread.id;

  const completed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Smoke turn timed out")), 90000);
    client.on("event", (event) => {
      if (event.params?.threadId !== threadId) return;
      if (event.method === "item/agentMessage/delta") output += event.params.delta || "";
      if (event.method === "error") reject(new Error(event.params?.error?.message || "Codex turn failed"));
      if (event.method === "turn/completed") {
        clearTimeout(timeout);
        if (event.params.turn?.status === "completed") resolve(event.params.turn);
        else reject(new Error(event.params.turn?.error?.message || `Turn ${event.params.turn?.status}`));
      }
    });
  });

  await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "Reply with exactly AGENT_DECK_READY and do not use tools.", text_elements: [] }],
  });
  await completed;
  if (!output.includes("AGENT_DECK_READY")) throw new Error(`Unexpected response: ${output}`);
  console.log(JSON.stringify({ ok: true, threadId, response: output.trim(), realtimeVoice: realtime.voices.defaultV2 }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    client.stop();
    fs.rmSync(workspace, { recursive: true, force: true });
  });
