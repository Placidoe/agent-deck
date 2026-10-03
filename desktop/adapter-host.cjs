// Provider Adapter Host is the sole boundary between Mission orchestration and
// provider-specific transports. Mission code only asks for the common runtime
// contract (createThread, sendTurn, steer, interrupt, resumeThread,
// readThread). Adding a new provider must happen here, never by branching the
// scheduler or renderer around a vendor's wire format.

const ADAPTER_MANIFESTS = {
  codex: {
    id: "codex", protocol: "codex-app-server", stage: "mission_ready",
    capabilities: ["managed_threads", "worktrees", "streaming_events", "approvals", "realtime_voice", "mcp_tools"],
  },
  deepseek: {
    id: "deepseek", protocol: "openai-chat-completions", stage: "mission_ready",
    capabilities: ["managed_threads", "streaming_events", "structured_output", "usage_accounting", "workspace_read", "workspace_write_approval", "terminal_approval"],
  },
  openai_compatible: {
    id: "openai_compatible", protocol: "openai-chat-completions", stage: "mission_ready",
    capabilities: ["managed_threads", "streaming_events", "structured_output", "usage_accounting", "workspace_read", "workspace_write_approval", "terminal_approval"],
  },
  claude_code: {
    id: "claude_code", protocol: "claude-cli-stream-json", stage: "bridge_only",
    capabilities: ["cli_sessions", "json_stream", "resume", "workspace_agent", "mcp_tools"],
    blockedBy: "The CLI event and permission adapter has not passed lifecycle conformance tests yet.",
  },
  trae: {
    id: "trae", protocol: "agent-client-protocol", stage: "bridge_only",
    capabilities: ["cli_sessions", "json_stream", "resume", "workspace_agent", "mcp_tools", "acp"],
    blockedBy: "The ACP client adapter has not passed lifecycle conformance tests yet.",
  },
};

function manifestFor(providerId) {
  const manifest = ADAPTER_MANIFESTS[providerId];
  if (!manifest) throw new Error(`Unknown provider adapter: ${providerId}`);
  return { ...manifest, capabilities: [...manifest.capabilities] };
}

class ProviderAdapterHost {
  constructor({ codex, apiRuntime, nativeHarness, onExternalEvent } = {}) {
    this.runtimes = new Map([["codex", codex], ["deepseek", apiRuntime], ["openai_compatible", apiRuntime]]);
    this.nativeHarness = nativeHarness;
    this.customManifests = new Map();
    this.onExternalEvent = onExternalEvent;
  }

  manifest(providerId) { return this.customManifests.get(providerId) || manifestFor(providerId); }

  // Trusted host code only. No arbitrary npm/module execution from the renderer.
  registerExternal({ manifest, runtime }) {
    if (!manifest?.id || manifest.stage !== "mission_ready") throw new Error("A certified adapter manifest is required");
    for (const method of ["createThread", "sendTurn", "steer", "interrupt", "resumeThread", "readThread", "on", "resolveApproval", "pendingApproval"]) {
      if (typeof runtime?.[method] !== "function") throw new Error(`Adapter is missing ${method}`);
    }
    if (["deepseek", "openai_compatible"].includes(manifest.id)) throw new Error("Model providers are not external coding agents");
    if (this.runtimes.get(manifest.id)) throw new Error("Cannot replace an attached adapter; create a new host after its active runs have drained");
    this.customManifests.set(manifest.id, structuredClone(manifest));
    this.runtimes.set(manifest.id, runtime);
    if (this.onExternalEvent) runtime.on("event", this.onExternalEvent);
  }

  runtimeFor(mission) {
    const providerId = mission?.provider || "codex";
    if (mission?.runtimeMode === "agent_deck") {
      if (!["deepseek", "openai_compatible"].includes(providerId) || !this.nativeHarness) throw new Error("Agent Deck Harness/model adapter unavailable; no Codex fallback will be used");
      return this.nativeHarness;
    }
    const manifest = this.manifest(providerId);
    const runtime = this.runtimes.get(providerId);
    if (manifest.stage !== "mission_ready" || !runtime) {
      throw new Error(`${providerId} is ${manifest.stage.replaceAll("_", " ")}: ${manifest.blockedBy || "its local runtime is unavailable"}`);
    }
    return runtime;
  }
}

module.exports = { ADAPTER_MANIFESTS, ProviderAdapterHost, manifestFor };
