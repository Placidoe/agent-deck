import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ProviderRegistry, validateEndpoint } = require("../desktop/provider-registry.cjs");

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-provider-"));
  try { return callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

const secureStorage = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value}`),
  decryptString: (value) => value.toString("utf8").replace(/^encrypted:/, ""),
};

test("provider registry persists only encrypted API secrets and produces provider-native MCP config", () => withTempDir(async (directory) => {
  const spawn = (_command, args) => ({ stdout: args[0] === "claude" ? "/tmp/claude\n" : "" });
  const registry = new ProviderRegistry({ userDataPath: directory, safeStorage: secureStorage, spawn, codexStatus: async () => ({ available: true, authenticated: true, version: "Codex test" }) });
  const saved = registry.saveApiProfile({ providerId: "deepseek", endpoint: "https://api.deepseek.com/v1/", model: "deepseek-chat", apiKey: "ds-secret" });
  assert.equal(saved.endpoint, "https://api.deepseek.com/v1");
  assert.equal(registry.apiProfile("deepseek").apiKey, "ds-secret");
  const persisted = fs.readFileSync(path.join(directory, "provider-profiles.json"), "utf8");
  assert.equal(persisted.includes("ds-secret"), false);
  const claude = registry.bridgeConfig({ providerId: "claude_code", databasePath: "/tmp/agent-deck.sqlite3" });
  const trae = registry.bridgeConfig({ providerId: "trae", databasePath: "/tmp/agent-deck.sqlite3" });
  assert.equal(claude.mcpServers["agent-deck"].env.AGENT_DECK_DATABASE_PATH, "/tmp/agent-deck.sqlite3");
  assert.equal(trae.mcp_servers[0].type, "stdio");
  const statuses = await registry.status();
  assert.equal(statuses.find((entry) => entry.id === "codex").connected, true);
  assert.equal(statuses.find((entry) => entry.id === "deepseek").configured, true);
  assert.equal(statuses.find((entry) => entry.id === "deepseek").connected, false);
}));

test("API profiles require HTTPS except for explicit localhost development", () => {
  assert.equal(validateEndpoint("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(validateEndpoint("http://localhost:4000/v1"), "http://localhost:4000/v1");
  assert.throws(() => validateEndpoint("http://api.example.com/v1"), /HTTPS/);
});
