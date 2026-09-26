import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ProviderAdapterHost, manifestFor } = require("../desktop/adapter-host.cjs");

test("adapter host exposes one stable Mission runtime contract and fails closed for uncertified adapters", () => {
  const codex = { name: "codex" };
  const api = { name: "api-harness" };
  const host = new ProviderAdapterHost({ codex, apiRuntime: api });
  assert.equal(host.runtimeFor({ provider: "codex" }), codex);
  assert.equal(host.runtimeFor({ provider: "deepseek" }), api);
  assert.equal(host.runtimeFor({ provider: "openai_compatible" }), api);
  assert.throws(() => host.runtimeFor({ provider: "claude_code" }), /bridge only/);
  assert.throws(() => host.runtimeFor({ provider: "trae" }), /bridge only/);
  assert.equal(manifestFor("trae").protocol, "agent-client-protocol");
  assert.equal(manifestFor("deepseek").capabilities.includes("terminal_approval"), true);
});
