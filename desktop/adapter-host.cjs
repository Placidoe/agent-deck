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
  constructor({ codex, apiRuntime } = {}) {
    this.runtimes = new Map([["codex", codex], ["deepseek", apiRuntime], ["openai_compatible", apiRuntime]]);
  }

  manifest(providerId) { return manifestFor(providerId); }

  runtimeFor(mission) {
    const providerId = mission?.provider || "codex";
    const manifest = manifestFor(providerId);
    const runtime = this.runtimes.get(providerId);
    if (manifest.stage !== "mission_ready" || !runtime) {
      throw new Error(`${providerId} is ${manifest.stage.replaceAll("_", " ")}: ${manifest.blockedBy || "its local runtime is unavailable"}`);
    }
    return runtime;
  }
}

module.exports = { ADAPTER_MANIFESTS, ProviderAdapterHost, manifestFor };
