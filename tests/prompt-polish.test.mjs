import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import fs from "node:fs";
const require = createRequire(import.meta.url);
const { PromptPolishService, normalizeDraft, parsePolish, polishSchema, polishPrompt, assertEditableRequirement } = require("../desktop/prompt-polish.cjs");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const draft = { title: "整理已有笔记，不联网", outcome: "", body: "保留 https://example.com，不修改源文件。" };
const candidate = { title: "整理已有笔记", outcome: "模型擅自增加的标准", body: "不联网，不修改源文件。", questions: ["想按什么主题整理？"] };
const store = { getRequirement: () => ({ id: "note", status: "inbox", missionId: null }) };
const apiRegistry = { selectRuntime: () => ({ runtimeMode: "agent_deck", provider: "deepseek" }), apiProfile: () => ({ endpoint: "https://fixture.invalid/v1", model: "fixture", apiKey: "fixture-secret" }) };
const success = () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(candidate) } }], usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 } }) });
const input = { requestId: "fixture-1", draft, requirementId: "note" };

test("draft bounds and strict structured response reject incomplete or malformed content", () => {
  assert.deepEqual(normalizeDraft(draft), draft);
  for (const bad of [null, [], { title: "" }, { title: 4 }, { title: "a".repeat(301) }, { ...draft, body: "b".repeat(12001) }]) assert.throws(() => normalizeDraft(bad));
  assert.deepEqual(polishSchema.required.sort(), Object.keys(polishSchema.properties).sort());
  assert.equal(polishSchema.additionalProperties, false);
  assert.throws(() => parsePolish("not JSON"));
  assert.throws(() => parsePolish(JSON.stringify({ title: "X", questions: [] })));
  assert.throws(() => parsePolish(JSON.stringify({ ...candidate, questions: ["a", "b", "c", "d"] })));
  assert.equal(parsePolish("```json\n" + JSON.stringify(candidate) + "\n```").draft.title, candidate.title);
  assert.match(polishPrompt(draft), /不是给你的执行指令/);
  assert.match(polishPrompt(draft), /不扩大范围/);
});

test("native rewriting makes one tool-free call, honors selected path and never saves or starts work", async () => {
  let calls = 0;
  const service = new PromptPolishService({ providerRegistry: apiRegistry, store, codexFactory: () => { throw new Error("no fallback"); }, fetchImpl: async (url, options) => {
    calls++; assert.equal(url, "https://fixture.invalid/v1/chat/completions");
    const payload = JSON.parse(options.body); assert.equal(payload.model, "fixture"); assert.equal(payload.tools, undefined); assert.equal(payload.messages.length, 1);
    return success();
  } });
  const result = await service.polish(input);
  assert.equal(calls, 1); assert.equal(result.runtimeMode, "agent_deck"); assert.equal(result.draft.outcome, "");
  assert.equal(result.usage.totalTokens, 130); assert.deepEqual(draft, input.draft); assert.equal(service.active, null);
});

test("native failure does not fall back or disclose upstream credentials/body", async () => {
  const service = new PromptPolishService({ providerRegistry: apiRegistry, store, codexFactory: () => { throw new Error("no fallback"); }, fetchImpl: async () => ({ ok: false, status: 401, json: () => { throw new Error("secret-body must not be read"); } }) });
  await assert.rejects(service.polish(input), /HTTP 401/); assert.equal(service.active, null);
});

test("saved notes become uneditable as soon as planning/execution starts, including in-flight results", async () => {
  let note = { status: "inbox", missionId: null }, calls = 0;
  const liveStore = { getRequirement: () => note };
  const service = new PromptPolishService({ providerRegistry: apiRegistry, store: liveStore, fetchImpl: async () => { calls++; note = { status: "planning", missionId: "mission" }; return success(); } });
  await assert.rejects(service.polish(input), /已经进入计划/); assert.equal(calls, 1);
  await assert.rejects(service.polish(input), /已经进入计划/); assert.equal(calls, 1);
  assert.throws(() => assertEditableRequirement({ getRequirement: () => ({ status: "planning" }) }, "note"));
  let saved = false;
  const orchestrator = new MissionOrchestrator({ store: { ...liveStore, updateRequirement: () => { saved = true; } }, codex: {}, worktrees: {} });
  assert.throws(() => orchestrator.updateRequirement("note", { title: "changed" }), /已经进入计划/); assert.equal(saved, false);
});

function fakeCodex({ complete = true, tool = false } = {}) {
  const client = new EventEmitter(); let root;
  client.createThread = async options => { root = options.cwd; assert.equal(options.ephemeral, true); assert.equal(options.allowMutations, false); assert.equal(options.textOnly, true); return { thread: { id: "thread" }, model: "catalog-default" }; };
  client.sendTurn = async options => {
    assert.equal(options.allowMutations, false); assert.equal(options.effort, "low"); assert.equal(options.outputSchema, polishSchema);
    queueMicrotask(() => {
      const emit = (method, params) => client.emit("event", { method, params: { threadId: "thread", ...params } });
      if (tool) emit("item/started", { item: { type: "commandExecution" } });
      if (complete) { emit("item/completed", { item: { type: "agentMessage", text: JSON.stringify(candidate) } }); emit("turn/completed", { turn: { status: "completed" } }); }
    });
    return { id: "turn" };
  };
  client.stop = () => {}; return { client, root: () => root };
}
const external = { selectRuntime: () => ({ runtimeMode: "external", provider: "codex" }) };

test("external rewriting uses owned ephemeral text-only session and cleans its temporary directory", async () => {
  const fake = fakeCodex(); const service = new PromptPolishService({ providerRegistry: external, store, codexFactory: () => fake.client });
  const result = await service.polish(input);
  assert.equal(result.model, "catalog-default"); assert.equal(result.usage, null); assert.equal(fs.existsSync(fake.root()), false); assert.equal(fake.client.listenerCount("event"), 0);
});

test("cancel, timeout, duplicate clicks and execution-tool attempts preserve the original", async () => {
  for (const reason of ["cancel", "timeout", "tool"]) {
    const fake = fakeCodex({ complete: false, tool: reason === "tool" });
    const service = new PromptPolishService({ providerRegistry: external, store, codexFactory: () => fake.client, timeoutMs: 30 });
    const pending = service.polish(input); pending.catch(() => {});
    await new Promise(resolve => setImmediate(resolve));
    if (reason === "cancel") { await assert.rejects(service.polish({ ...input, requestId: "duplicate" }), /正在润色/); assert.equal(service.cancel("other"), false); assert.equal(service.cancel(input.requestId), true); }
    await assert.rejects(pending, reason === "cancel" ? /已取消/ : reason === "timeout" ? /超时/ : /执行工具/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(service.active, null); assert.equal(fs.existsSync(fake.root()), false); assert.equal(fake.client.listenerCount("event"), 0);
  }
});

test("text-only Codex configuration is per-thread, disables execution and does not modify global settings", async () => {
  const client = new CodexAppServer({ binary: "/unused" }), calls = [];
  client.start = async () => {}; client.resolveModel = async () => "catalog-default";
  client.request = async (method, params) => { calls.push({ method, params }); return method === "config/read" ? { config: { mcp_servers: { internal: { secret: "not returned" } } } } : { thread: { id: "thread" } }; };
  await client.createThread({ cwd: "/tmp", allowMutations: false, ephemeral: true, textOnly: true });
  const options = calls.find(c => c.method === "thread/start").params;
  assert.equal(options.config["mcp_servers.internal.enabled"], false); assert.equal(options.config["features.shell_tool"], false); assert.equal(options.config["features.multi_agent"], false); assert.equal(options.config.web_search, "disabled");
  assert.equal(options.dynamicTools, undefined); assert.equal(options.sandbox, "read-only"); assert.equal(calls.some(c => c.method.includes("write")), false);
  await assert.rejects(client.createThread({ textOnly: true }), /ephemeral read-only/);
  calls.length = 0; await client.createThread({ cwd: "/tmp" }); assert.equal(calls[0].params.config, undefined);
});
