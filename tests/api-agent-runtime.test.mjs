import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { ApiAgentRuntime } = require("../desktop/api-agent-runtime.cjs");

async function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-api-runtime-"));
  try { return await callback(directory); } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function waitForCompletion(runtime, threadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { runtime.off("event", listener); reject(new Error("API worker did not complete")); }, 2000);
    const listener = (event) => {
      if (event.method === "turn/completed" && event.params.threadId === threadId) {
        clearTimeout(timeout); runtime.off("event", listener); resolve(event);
      }
    };
    runtime.on("event", listener);
  });
}

function waitForApproval(runtime, threadId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { runtime.off("event", listener); reject(new Error("API worker did not request approval")); }, 2000);
    const listener = (event) => {
      if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(event.method) && event.params.threadId === threadId) {
        clearTimeout(timeout); runtime.off("event", listener); resolve(event);
      }
    };
    runtime.on("event", listener);
  });
}

function waitForEvent(runtime, predicate, label = "API runtime event") {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { runtime.off("event", listener); reject(new Error(`${label} was not emitted`)); }, 2000);
    const listener = (event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout); runtime.off("event", listener); resolve(event);
    };
    runtime.on("event", listener);
  });
}

test("API runtime preserves a session, executes read-only tool calls, and emits provider-shaped events", async () => withTempDir(async (directory) => {
  fs.writeFileSync(path.join(directory, "notes.txt"), "Agent Deck keeps evidence local.\n");
  let request = 0;
  const runtime = new ApiAgentRuntime({
    providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
    fetchImpl: async (_url, options) => {
      request += 1;
      const body = JSON.parse(options.body);
      if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "call-read", type: "function", function: { name: "workspace_read", arguments: '{"path":"notes.txt"}' } }] } }] }), { status: 200 });
      assert.equal(body.messages.some((message) => message.role === "tool" && /keeps evidence local/.test(message.content)), true);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"summary":"Evidence read","acceptance":[],"changedFiles":[],"blockers":[]}' } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }), { status: 200 });
    },
  });
  const events = [];
  runtime.on("event", (event) => events.push(event));
  const created = await runtime.createThread({ cwd: directory, title: "API mission", provider: "deepseek" });
  const completed = waitForCompletion(runtime, created.thread.id);
  await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "Read notes and summarize." });
  const final = await completed;
  assert.equal(final.params.turn.status, "completed");
  assert.equal(events.some((event) => event.method === "item/started" && event.params.item.tool === "workspace_read"), true);
  assert.equal(events.some((event) => event.method === "item/completed" && event.params.item.type === "agentMessage"), true);
  const thread = await runtime.readThread(created.thread.id);
  assert.equal(thread.messages.some((message) => message.role === "tool"), true);
}));

test("API runtime blocks tool paths outside the assigned workspace", async () => withTempDir(async (directory) => {
  let request = 0;
  const runtime = new ApiAgentRuntime({
    providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
    fetchImpl: async (_url, options) => {
      request += 1;
      const body = JSON.parse(options.body);
      if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "call-escape", type: "function", function: { name: "workspace_read", arguments: '{"path":"../secret.txt"}' } }] } }] }), { status: 200 });
      assert.equal(body.messages.some((message) => message.role === "tool" && /outside the assigned workspace/.test(message.content)), true);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Blocked unsafe path." } }] }), { status: 200 });
    },
  });
  const created = await runtime.createThread({ cwd: directory, provider: "deepseek" });
  const completed = waitForCompletion(runtime, created.thread.id);
  await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "Try to escape." });
  assert.equal((await completed).params.turn.status, "completed");
}));

test("API runtime rejects a workspace-list symlink that resolves outside its workspace", async (t) => withTempDir(async (directory) => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-api-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "do not disclose");
    try { fs.symlinkSync(outside, path.join(directory, "outside-link")); }
    catch (error) { t.skip(`Symlink fixture unavailable: ${error.message}`); return; }
    let request = 0;
    const runtime = new ApiAgentRuntime({
      providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
      fetchImpl: async (_url, options) => {
        request += 1;
        const body = JSON.parse(options.body);
        if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "list-link", type: "function", function: { name: "workspace_list", arguments: '{"path":"outside-link"}' } }] } }] }), { status: 200 });
        assert.equal(body.messages.some((message) => /resolves outside the assigned workspace/.test(message.content)), true);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Unsafe path rejected." } }] }), { status: 200 });
      },
    });
    const created = await runtime.createThread({ cwd: directory, provider: "deepseek" });
    const completed = waitForCompletion(runtime, created.thread.id);
    await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "List unsafe link." });
    assert.equal((await completed).params.turn.status, "completed");
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
}));

test("API runtime requires a visible approval before writing or running Bash", async () => withTempDir(async (directory) => {
  let request = 0;
  let commandRuns = 0;
  const runtime = new ApiAgentRuntime({
    providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
    commandRunner: async ({ command, cwd }) => { commandRuns += 1; assert.equal(command, "printf verified"); assert.equal(cwd, fs.realpathSync(directory)); return { exitCode: 0, stdout: "verified", stderr: "", timedOut: false }; },
    fetchImpl: async (_url, options) => {
      request += 1;
      const body = JSON.parse(options.body);
      if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "write", type: "function", function: { name: "workspace_write", arguments: '{"path":"output.txt","content":"durable evidence"}' } }] } }] }), { status: 200 });
      if (request === 2) {
        assert.equal(body.messages.some((message) => message.role === "tool" && /Wrote output.txt/.test(message.content)), true);
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "bash", type: "function", function: { name: "workspace_bash", arguments: '{"command":"printf verified"}' } }] } }] }), { status: 200 });
      }
      assert.equal(body.messages.some((message) => message.role === "tool" && /exit 0/.test(message.content)), true);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Completed after approved work." } }] }), { status: 200 });
    },
  });
  const created = await runtime.createThread({ cwd: directory, provider: "deepseek", allowMutations: true });
  const completed = waitForCompletion(runtime, created.thread.id);
  const firstApproval = waitForApproval(runtime, created.thread.id);
  await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "Create output, then test it." });
  const writeRequest = await firstApproval;
  assert.equal(fs.existsSync(path.join(directory, "output.txt")), false, "write must not happen before approval");
  const secondApproval = waitForApproval(runtime, created.thread.id);
  await runtime.resolveApproval({ requestId: writeRequest.id, decision: "accept" });
  const bashRequest = await secondApproval;
  assert.equal(commandRuns, 0, "Bash must not run before approval");
  await runtime.resolveApproval({ requestId: bashRequest.id, decision: "accept" });
  assert.equal((await completed).params.turn.status, "completed");
  assert.equal(fs.readFileSync(path.join(directory, "output.txt"), "utf8"), "durable evidence");
  assert.equal(commandRuns, 1);
}));

test("API runtime emits Git approval and executing evidence before a staged action runs", async () => withTempDir(async (directory) => {
  let request = 0;
  let commandRuns = 0;
  const runtime = new ApiAgentRuntime({
    providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
    commandRunner: async ({ command, cwd }) => { commandRuns += 1; assert.equal(command, "git add -- 'output.txt'"); assert.equal(cwd, fs.realpathSync(directory)); return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
    fetchImpl: async () => {
      request += 1;
      if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "git-stage", type: "function", function: { name: "workspace_git", arguments: '{"operation":"stage","paths":["output.txt"]}' } }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Git stage completed." } }] }), { status: 200 });
    },
  });
  const events = [];
  runtime.on("event", (event) => events.push(event));
  const created = await runtime.createThread({ cwd: directory, provider: "deepseek", allowMutations: true });
  const completed = waitForCompletion(runtime, created.thread.id);
  const requested = waitForEvent(runtime, (event) => event.method === "item/gitOperation/requestApproval" && event.params.threadId === created.thread.id, "Git approval request");
  await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "Stage output.txt." });
  const approval = await requested;
  assert.equal(approval.params.state, "requested");
  assert.equal(approval.params.item.operation, "stage");
  assert.equal(commandRuns, 0, "Git must not run before approval");
  const executing = waitForEvent(runtime, (event) => event.method === "item/execution/started" && event.params.item.id === "git-stage", "Git execution started");
  await runtime.resolveApproval({ requestId: approval.id, decision: "accept" });
  assert.equal((await executing).params.item.state, "executing");
  assert.equal((await completed).params.turn.status, "completed");
  assert.equal(commandRuns, 1);
  assert.equal(events.some((event) => event.method === "item/completed" && event.params.item.id === "git-stage" && event.params.item.state === "executed"), true);
}));

test("declining an API action preserves a declined receipt and never runs it", async () => withTempDir(async (directory) => {
  let request = 0;
  let commandRuns = 0;
  const runtime = new ApiAgentRuntime({
    providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
    commandRunner: async () => { commandRuns += 1; return { exitCode: 0, stdout: "", stderr: "", timedOut: false }; },
    fetchImpl: async () => {
      request += 1;
      if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "declined-command", type: "function", function: { name: "workspace_bash", arguments: '{"command":"printf not-run"}' } }] } }] }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Action was declined." } }] }), { status: 200 });
    },
  });
  const events = [];
  runtime.on("event", (event) => events.push(event));
  const created = await runtime.createThread({ cwd: directory, provider: "deepseek", allowMutations: true });
  const completed = waitForCompletion(runtime, created.thread.id);
  const requested = waitForApproval(runtime, created.thread.id);
  await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "Run the command." });
  const approval = await requested;
  await runtime.resolveApproval({ requestId: approval.id, decision: "decline" });
  assert.equal((await completed).params.turn.status, "completed");
  assert.equal(commandRuns, 0);
  assert.equal(events.some((event) => event.method === "item/completed" && event.params.item.id === "declined-command" && event.params.item.state === "declined"), true);
}));

test("API planner sessions reject mutation tools without creating an approval", async () => withTempDir(async (directory) => {
  let request = 0;
  const runtime = new ApiAgentRuntime({
    providerRegistry: { apiProfile: () => ({ endpoint: "https://example.test/v1", model: "test-model", apiKey: "secret" }) },
    fetchImpl: async (_url, options) => {
      request += 1;
      const body = JSON.parse(options.body);
      if (request === 1) return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", tool_calls: [{ id: "blocked-write", type: "function", function: { name: "workspace_write", arguments: '{"path":"output.txt","content":"must not exist"}' } }] } }] }), { status: 200 });
      assert.equal(body.messages.some((message) => /planning-only API session/.test(message.content)), true);
      return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "I proposed a worker task instead." } }] }), { status: 200 });
    },
  });
  const created = await runtime.createThread({ cwd: directory, provider: "deepseek" });
  const completed = waitForCompletion(runtime, created.thread.id);
  await runtime.sendTurn({ threadId: created.thread.id, cwd: directory, prompt: "Write a plan." });
  assert.equal((await completed).params.turn.status, "completed");
  assert.equal(fs.existsSync(path.join(directory, "output.txt")), false);
}));
