// Minimal stdio MCP bridge for Claude Code and TraeCode. It intentionally only
// writes Agent Deck's local ledger; it never receives shell or filesystem access.
const readline = require("node:readline");
const { MissionStore } = require("./mission-store.cjs");

const databasePath = process.env.AGENT_DECK_DATABASE_PATH;
const store = databasePath ? new MissionStore(databasePath) : null;

function response(id, result) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`); }
function failure(id, message) { process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32000, message } })}\n`); }
function toolResult(text, isError = false) { return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) }; }

const tools = [
  { name: "agentdeck_report_progress", description: "Write a concise, durable progress update into an existing Agent Deck Mission.", inputSchema: { type: "object", additionalProperties: false, required: ["missionId", "agent", "message"], properties: { missionId: { type: "string" }, taskKey: { type: "string" }, agent: { type: "string" }, message: { type: "string" }, phase: { type: "string" } } } },
  { name: "agentdeck_publish_artifact", description: "Publish a reusable local artifact reference into an existing Agent Deck Mission.", inputSchema: { type: "object", additionalProperties: false, required: ["missionId", "agent", "title", "summary", "files"], properties: { missionId: { type: "string" }, taskKey: { type: "string" }, agent: { type: "string" }, title: { type: "string" }, summary: { type: "string" }, files: { type: "array", items: { type: "string" } }, verified: { type: "boolean" } } } },
];

function taskFor(mission, key) { return key ? mission.tasks.find((task) => task.key === key) : null; }
function assertMission(missionId) { if (!store) throw new Error("AGENT_DECK_DATABASE_PATH is not configured"); const mission = store.getMission(missionId); if (!mission) throw new Error("Mission was not found in the local Agent Deck ledger"); return mission; }

function callTool(name, args) {
  const mission = assertMission(args.missionId);
  const task = taskFor(mission, args.taskKey);
  if (name === "agentdeck_report_progress") {
    const message = String(args.message || "").trim();
    if (!message) throw new Error("message is required");
    store.addMessage({ missionId: mission.id, fromAgent: String(args.agent || "External agent"), toAgent: "Main Agent", topic: "external.progress", messageType: "event", text: message, deliveryStatus: "delivered", source: "external_mcp" });
    store.appendEvent(mission.id, "external.provider.progress", { provider: "mcp", agent: args.agent, phase: args.phase || "working", message }, { taskId: task?.id || null });
    return toolResult("Progress recorded in Agent Deck.");
  }
  if (name === "agentdeck_publish_artifact") {
    const files = Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : [];
    const artifact = store.addArtifact({ missionId: mission.id, taskId: task?.id || null, title: String(args.title || "External artifact"), summary: String(args.summary || ""), files, verificationStatus: args.verified ? "worker_verified" : "unverified" });
    store.appendEvent(mission.id, "external.provider.artifact", { provider: "mcp", agent: args.agent, artifactId: artifact.id, title: artifact.title }, { taskId: task?.id || null });
    return toolResult(`Artifact ${artifact.id} recorded in Agent Deck.`);
  }
  throw new Error(`Unknown tool: ${name}`);
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (request.method === "initialize") return response(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "agent-deck", version: "0.4.0" } });
  if (request.method === "tools/list") return response(request.id, { tools });
  if (request.method === "tools/call") {
    try { return response(request.id, callTool(request.params?.name, request.params?.arguments || {})); }
    catch (error) { return response(request.id, toolResult(error.message, true)); }
  }
  if (request.id != null) failure(request.id, `Unsupported method: ${request.method}`);
});
