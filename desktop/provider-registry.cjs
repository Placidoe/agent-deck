const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { manifestFor } = require("./adapter-host.cjs");

const PROVIDERS = {
  codex: {
    id: "codex", label: "Codex", kind: "native", icon: "codex",
    description: "OpenAI Codex app-server — managed threads, approvals, realtime voice, worktrees, and live tool events.",
    capabilities: ["managed_threads", "worktrees", "streaming_events", "approvals", "realtime_voice", "mcp_tools"],
  },
  claude_code: {
    id: "claude_code", label: "Claude Code", kind: "cli", icon: "claude",
    binary: "claude",
    description: "Local Claude Code CLI with Agent Deck MCP bridge. Mission execution stays disabled until its lifecycle and approval adapter is certified.",
    capabilities: ["cli_sessions", "json_stream", "resume", "workspace_agent", "mcp_tools"],
  },
  trae: {
    id: "trae", label: "TraeCode", kind: "cli", icon: "trae",
    binary: "traecli",
    description: "TraeCode CLI / ACP with Agent Deck MCP bridge. Mission execution stays disabled until the ACP lifecycle adapter is certified.",
    capabilities: ["cli_sessions", "json_stream", "resume", "workspace_agent", "mcp_tools", "acp"],
  },
  deepseek: {
    id: "deepseek", label: "DeepSeek API", kind: "api", icon: "api",
    description: "OpenAI-compatible cloud API through Agent Deck's approval-gated local execution harness.",
    defaultEndpoint: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    capabilities: ["chat", "structured_output", "usage_accounting"],
  },
  openai_compatible: {
    id: "openai_compatible", label: "OpenAI-compatible API", kind: "api", icon: "api",
    description: "Bring another compatible endpoint and model. Local workspace writes and Bash commands require one-time visible approval.",
    capabilities: ["chat", "structured_output", "usage_accounting"],
  },
};

function commandInfo(binary, spawn = spawnSync) {
  const found = spawn("/usr/bin/which", [binary], { encoding: "utf8" }).stdout?.trim();
  if (!found) return { installed: false, binary, version: null };
  const version = spawn(found, ["--version"], { encoding: "utf8", timeout: 5000 }).stdout?.trim()
    || spawn(found, ["-V"], { encoding: "utf8", timeout: 5000 }).stdout?.trim()
    || null;
  return { installed: true, binary: found, version };
}

function validateEndpoint(value) {
  const endpoint = String(value || "").trim().replace(/\/$/, "");
  if (!endpoint) throw new Error("API endpoint is required");
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error("API endpoint must be a valid URL"); }
  const local = ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (parsed.protocol !== "https:" && !(local && parsed.protocol === "http:")) {
    throw new Error("API endpoint must use HTTPS (HTTP is allowed only for localhost)");
  }
  return endpoint;
}

class ProviderRegistry {
  constructor({ userDataPath, safeStorage = null, spawn = spawnSync, codexStatus = null, manifestLookup = manifestFor } = {}) {
    this.userDataPath = userDataPath || process.cwd();
    this.safeStorage = safeStorage;
    this.spawn = spawn;
    this.codexStatus = codexStatus;
    this.manifestLookup = manifestLookup;
    this.configPath = path.join(this.userDataPath, "provider-profiles.json");
    this.config = this.#read();
  }

  #read() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.configPath, "utf8"));
      return parsed && typeof parsed === "object" ? parsed : { api: {} };
    } catch { return { api: {} }; }
  }

  #write() {
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), "utf8");
  }

  runtimeSettings() {
    return { mode: "external", externalProvider: "codex", modelProvider: "deepseek", ...this.config.runtime };
  }

  saveRuntimeSettings(input = {}) {
    const next = { ...this.runtimeSettings(), ...input };
    if (!["external", "agent_deck"].includes(next.mode)) throw new Error("Unknown execution mode");
    if (!["codex", "claude_code", "trae"].includes(next.externalProvider)) throw new Error("Select an external coding agent");
    if (!["deepseek", "openai_compatible"].includes(next.modelProvider)) throw new Error("Select a model API for Agent Deck Harness");
    // Do not persist arbitrary renderer fields alongside encrypted credentials.
    this.config.runtime = { mode: next.mode, externalProvider: next.externalProvider, modelProvider: next.modelProvider };
    this.#write();
    return this.runtimeSettings();
  }

  selectRuntime(input = {}) {
    const settings = this.runtimeSettings();
    const mode = input.runtimeMode || settings.mode;
    const provider = input.provider || (mode === "agent_deck" ? settings.modelProvider : settings.externalProvider);
    if (!["external", "agent_deck"].includes(mode)) throw new Error("Unknown execution mode");
    if (mode === "agent_deck" && PROVIDERS[provider]?.kind !== "api") throw new Error("Agent Deck Harness requires a model API, not a coding-agent session");
    if (mode === "external" && !["codex", "claude_code", "trae"].includes(provider)) throw new Error("Use Agent Deck Harness mode for new API missions");
    if (mode === "agent_deck" && !this.config.api?.[provider]?.verifiedAt) throw new Error("Save and verify the model API in Settings before starting Agent Deck Harness");
    return { runtimeMode: mode, provider };
  }

  list() {
    return Object.values(PROVIDERS).map((provider) => {
      const manifest = this.manifestLookup(provider.id);
      return { ...provider, protocol: manifest.protocol, stage: manifest.stage, blockedBy: manifest.blockedBy || null, capabilities: [...provider.capabilities], canonicalCapabilities: [...manifest.capabilities] };
    });
  }

  async status() {
    const profiles = this.config.api || {};
    const runtime = this.runtimeSettings();
    const codex = runtime.mode === "external" && runtime.externalProvider === "codex" && this.codexStatus ? await this.codexStatus().catch((error) => ({ available: false, error: error.message })) : { available: false, inactive: true };
    return this.list().map((provider) => {
      const selectedForMode = provider.id === (runtime.mode === "agent_deck" ? runtime.modelProvider : runtime.externalProvider);
      const runtimeEligible = runtime.mode === "agent_deck" ? provider.kind === "api" : ["codex", "claude_code", "trae"].includes(provider.id);
      const selection = { runtimeMode: runtime.mode, runtimeEligible, selectedForMode };
      if (provider.id === "codex") return { ...provider, ...selection, installed: Boolean(codex.available), connected: Boolean(codex.authenticated), version: codex.version || null, error: codex.error || null, mode: codex.inactive ? "inactive" : "native", missionEnabled: runtimeEligible && Boolean(codex.available && codex.authenticated) };
      if (provider.kind === "cli") {
        const cli = commandInfo(provider.binary, this.spawn);
        return { ...provider, ...selection, ...cli, connected: cli.installed, mode: cli.installed ? "local_cli" : "not_installed", missionEnabled: runtimeEligible && cli.installed && provider.stage === "mission_ready" };
      }
      const profile = profiles[provider.id] || {};
      return {
        ...provider,
        ...selection,
        installed: true,
        connected: Boolean(profile.hasSecret && profile.endpoint && profile.model && profile.verifiedAt),
        configured: Boolean(profile.endpoint || profile.model || profile.hasSecret),
        endpoint: profile.endpoint || provider.defaultEndpoint || "",
        model: profile.model || provider.defaultModel || "",
        verifiedAt: profile.verifiedAt || null,
        mode: profile.verifiedAt ? "verified" : profile.hasSecret ? "configured" : "needs_key",
        missionEnabled: runtimeEligible && Boolean(profile.hasSecret && profile.endpoint && profile.model && profile.verifiedAt),
      };
    });
  }

  saveApiProfile(input = {}) {
    const providerId = String(input.providerId || "");
    const provider = PROVIDERS[providerId];
    if (!provider || provider.kind !== "api") throw new Error("Unknown API provider");
    const endpoint = validateEndpoint(input.endpoint || provider.defaultEndpoint);
    const model = String(input.model || provider.defaultModel || "").trim();
    if (!model) throw new Error("Model name is required");
    const current = this.config.api?.[providerId] || {};
    const secret = typeof input.apiKey === "string" ? input.apiKey.trim() : "";
    if (secret && (!this.safeStorage?.isEncryptionAvailable?.() || !this.safeStorage?.encryptString)) {
      throw new Error("macOS secure storage is unavailable; Agent Deck will not save an API key in plain text.");
    }
    if (!this.config.api) this.config.api = {};
    this.config.api[providerId] = {
      endpoint, model,
      hasSecret: secret ? true : Boolean(current.hasSecret),
      secret: secret ? this.safeStorage.encryptString(secret).toString("base64") : current.secret || null,
      verifiedAt: secret || current.endpoint !== endpoint || current.model !== model ? null : current.verifiedAt || null,
      updatedAt: new Date().toISOString(),
    };
    this.#write();
    return { providerId, endpoint, model, hasSecret: this.config.api[providerId].hasSecret };
  }

  apiProfile(providerId) {
    const provider = PROVIDERS[providerId];
    const stored = this.config.api?.[providerId];
    if (!provider || provider.kind !== "api" || !stored?.secret) return null;
    if (!this.safeStorage?.isEncryptionAvailable?.() || !this.safeStorage?.decryptString) throw new Error("macOS secure storage is unavailable");
    return { endpoint: stored.endpoint, model: stored.model, apiKey: this.safeStorage.decryptString(Buffer.from(stored.secret, "base64")) };
  }

  async verifyApiProfile(providerId) {
    const profile = this.apiProfile(providerId);
    if (!profile) throw new Error("Save an encrypted API key before testing this connection");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const startedAt = Date.now();
    try {
      const response = await fetch(`${profile.endpoint}/chat/completions`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${profile.apiKey}` },
        body: JSON.stringify({ model: profile.model, messages: [{ role: "user", content: "Reply with OK." }], max_tokens: 2, stream: false }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body?.error?.message || `API responded with HTTP ${response.status}`);
      this.config.api[providerId] = { ...this.config.api[providerId], verifiedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      this.#write();
      return { ok: true, providerId, model: profile.model, latencyMs: Date.now() - startedAt, usage: body?.usage || null };
    } catch (error) {
      if (error.name === "AbortError") throw new Error("API connection timed out after 15 seconds");
      throw error;
    } finally { clearTimeout(timeout); }
  }

  bridgeConfig({ providerId, databasePath }) {
    const provider = PROVIDERS[providerId];
    if (!provider || !["claude_code", "trae"].includes(providerId)) throw new Error("MCP bridge is available for Claude Code and TraeCode");
    const command = process.execPath;
    const args = [path.join(__dirname, "agent-deck-mcp.cjs")];
    // Agent Deck ships its own Electron runtime. ELECTRON_RUN_AS_NODE makes the
    // exact packaged executable a stable stdio host too, so users do not need a
    // second global Node installation merely to load the bridge.
    const env = { AGENT_DECK_DATABASE_PATH: databasePath, ELECTRON_RUN_AS_NODE: "1" };
    if (providerId === "claude_code") return { mcpServers: { "agent-deck": { command, args, env } } };
    return { mcp_servers: [{ name: "agent-deck", type: "stdio", command, args, env }] };
  }
}

module.exports = { PROVIDERS, ProviderRegistry, commandInfo, validateEndpoint };
