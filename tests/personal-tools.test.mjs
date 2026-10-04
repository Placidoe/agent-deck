import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { sourceReceipts } from "../src/source-receipts.js";
const require = createRequire(import.meta.url);
const { readReference, listReferences, isPublicIPv4, validatePublicUrl, publicAddress, requestPage, readPublicPage, htmlText } = require("../desktop/personal-tools.cjs");
const { NativeHarnessRuntime } = require("../desktop/native-harness-runtime.cjs");
const { assertResearchOutputPath } = require("../desktop/personal-tools.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { ProviderAdapterHost } = require("../desktop/adapter-host.cjs");
async function fixture(callback) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "personal-tools-test-")));
  try { await callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
function wait(runtime, predicate) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { runtime.off("event", listener); reject(new Error("Expected native event did not arrive")); }, 10000);
    const listener = event => { if (predicate(event)) { clearTimeout(timeout); runtime.off("event", listener); resolve(event); } };
    runtime.on("event", listener);
  });
}
const profile = { endpoint: "https://model.test/v1", model: "fixture", apiKey: "not-a-real-key" };
const response = (content, name, args) => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content, ...(name ? { tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : {}) } }], usage: { total_tokens: 15 } }), { status: 200 });
const publicLookup = async () => [{ address: "8.8.8.8", family: 4 }];
const pageTransport = async () => ({ bytes: Buffer.from("<h1>Public fixture</h1><p>Evidence is not a conclusion.</p>"), type: "text/html; charset=utf-8", status: 200 });

test("local sources return bounded line-numbered receipts and never change original files", async () => fixture(root => {
  const file = path.join(root, "report.txt"); fs.writeFileSync(file, "一手证据\nvalue=7\n限制：测试资料");
  const before = fs.readFileSync(file);
  const output = JSON.parse(readReference(root, { path: "report.txt", startLine: 2, endLine: 3 }));
  assert.match(output.text, /^2: value=7/); assert.equal(output.source.totalLines, 3);
  assert.match(output.source.sha256, /^[a-f0-9]{64}$/); assert.equal(output.source.path, "report.txt");
  assert.deepEqual(fs.readFileSync(file), before);
  assert.throws(() => readReference(root, { path: "report.txt", startLine: 0 }), /integer line range/);
  assert.throws(() => readReference(root, { path: "report.txt", startLine: 9 }), /only 3 lines/);
}));

test("source tools reject escape, symlinks, sensitive files, binary, invalid UTF-8 and large documents", async () => fixture(root => {
  const sources = path.join(root, "sources"); fs.mkdirSync(sources);
  fs.writeFileSync(path.join(root, "outside.txt"), "private");
  fs.symlinkSync(path.join(root, "outside.txt"), path.join(sources, "link.txt"));
  fs.writeFileSync(path.join(sources, ".env"), "SECRET=value");
  fs.writeFileSync(path.join(sources, "keys.txt"), "-----BEGIN PRIVATE KEY-----");
  fs.writeFileSync(path.join(sources, "binary.txt"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(sources, "bad.txt"), Buffer.from([0xff, 0xfe]));
  fs.writeFileSync(path.join(sources, "large.txt"), "x".repeat(262145));
  for (const [file, expression] of [["../outside.txt", /relative/], ["link.txt", /symlinks/], [".env", /Sensitive/], ["keys.txt", /credentials/], ["binary.txt", /Binary/], ["bad.txt", /UTF-8/], ["large.txt", /exceeds/]]) assert.throws(() => readReference(sources, { path: file }), expression);
  assert.throws(() => readReference(sources, { path: path.join(root, "outside.txt") }), /relative/);
  const listing = JSON.parse(listReferences(sources));
  assert.ok(!listing.entries.some(entry => entry.path === ".env" || entry.path === "link.txt"));
  fs.renameSync(sources, path.join(root, "old")); fs.symlinkSync(root, sources);
  assert.throws(() => listReferences(sources), /folder changed/);
}));

test("source JSON and directory lists stay below model receipt budget even with escaping", async () => fixture(root => {
  fs.writeFileSync(path.join(root, "escaped.txt"), '\\"'.repeat(5000));
  const value = readReference(root, { path: "escaped.txt" }); assert.ok(value.length <= 5800); assert.equal(JSON.parse(value).source.truncated, true);
  for (let i = 0; i < 85; i++) fs.writeFileSync(path.join(root, `${i}-${"long".repeat(30)}.txt`), "source");
  const listing = listReferences(root); assert.ok(listing.length <= 5800); assert.equal(JSON.parse(listing).truncated, true);
}));

test("research writes cannot plant version hooks or use shell/Git to bypass source/network tools", async () => fixture(async root => {
  fs.mkdirSync(path.join(root, ".git")); fs.symlinkSync(path.join(root, ".git"), path.join(root, "alias"));
  assertResearchOutputPath(root, "decision.html");
  for (const candidate of [".git/config", "folder/../.git/hooks/pre-commit", "alias/pre-commit", "/tmp/file", ".env"]) assert.throws(() => assertResearchOutputPath(root, candidate));
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(root, "state") });
  for (const name of ["workspace_bash", "workspace_git", "workspace_write"]) {
    const result = await runtime.executeControlledTool({ thread: { cwd: root, referenceRoot: root }, name, args: { path: ".git/config", command: "npm test", operation: "commit" } });
    assert.equal(result.ok, false);
  }
}));

test("public URL policy rejects credentials, queries, local addresses, ports and non-HTTPS protocols", () => {
  assert.equal(validatePublicUrl("https://example.com/report"), "https://example.com/report");
  for (const url of ["http://example.com", "file:///etc/passwd", "https://localhost/a", "https://127.0.0.1", "https://[::1]", "https://user:pass@example.com", "https://example.com:8443", "https://example.com/?token=secret", "https://example.com/#secret", "https://app.internal/a", "https://0x7f000001"]) assert.throws(() => validatePublicUrl(url));
});

test("all DNS addresses are validated and the connection receives one pinned public IPv4", async () => {
  for (const address of ["127.0.0.1", "10.0.0.2", "172.16.0.1", "192.168.0.1", "169.254.169.254", "100.64.0.1", "198.18.0.1", "192.0.2.1", "203.0.113.3", "224.0.0.1", "::1", "::ffff:127.0.0.1"]) assert.equal(isPublicIPv4(address), false, address);
  assert.equal(isPublicIPv4("8.8.8.8"), true);
  await assert.rejects(publicAddress("https://example.com", async () => [{ address: "8.8.8.8" }, { address: "10.0.0.1" }]), /private/);
  await assert.rejects(publicAddress("https://example.com", async () => []), /private/);
  let resolutions = 0;
  const result = JSON.parse(await readPublicPage("https://example.com", { lookup: async () => { resolutions++; return [{ address: "8.8.8.8" }]; }, transport: async (url, address) => { assert.equal(address, "8.8.8.8"); return pageTransport(); } }));
  assert.equal(resolutions, 1); assert.equal(result.source.kind, "public_web"); assert.match(result.source.sha256, /^[a-f0-9]{64}$/);
});

test("public page text strips active content and discloses clipping; empty/binary pages fail", async () => {
  assert.equal(htmlText('<h1>Title &amp; data</h1><script>secret()</script><style>noise</style><p>OK</p>'), "Title & data\n OK".trim());
  const output = JSON.parse(await readPublicPage("https://example.com", { lookup: publicLookup, transport: async () => ({ bytes: Buffer.from("x".repeat(10000)), type: "text/plain", status: 200 }) }));
  assert.equal(output.source.truncated, true); assert.ok(output.text.length <= 4500);
  await assert.rejects(readPublicPage("https://example.com", { lookup: publicLookup, transport: async () => ({ bytes: Buffer.from("<script>onlyJS()</script>"), type: "text/html", status: 200 }) }), /no readable/);
  await assert.rejects(readPublicPage("https://example.com", { lookup: publicLookup, transport: async () => ({ bytes: Buffer.from([255]), type: "text/plain", status: 200 }) }), /UTF-8/);
});

test("HTTPS transport sends no credentials, pins DNS, and rejects redirects, compression, binary and oversize bodies", async () => {
  const https = require("node:https"); const original = https.get;
  let status = 200; let type = "text/html; charset=utf-8"; let encoding; let size = 12;
  try {
    https.get = (url, options, ready) => {
      assert.equal(url, "https://example.com/report");
      assert.equal(options.agent, false); assert.equal(options.family, 4);
      assert.equal(options.headers.authorization, undefined); assert.equal(options.headers.cookie, undefined);
      assert.equal(options.headers["accept-encoding"], "identity");
      options.lookup("example.com", {}, (error, address, family) => { assert.equal(address, "8.8.8.8"); assert.equal(family, 4); });
      options.lookup("example.com", { all: true }, (error, values) => assert.deepEqual(values, [{ address: "8.8.8.8", family: 4 }]));
      const request = new EventEmitter(); request.destroy = () => {};
      const response = new EventEmitter(); response.destroy = () => {}; response.statusCode = status; response.headers = { "content-type": type, ...(encoding ? { "content-encoding": encoding } : {}) };
      queueMicrotask(() => { ready(response); response.emit("data", Buffer.alloc(size, 65)); response.emit("end"); });
      return request;
    };
    const result = await requestPage("https://example.com/report", "8.8.8.8"); assert.equal(result.bytes.length, 12);
    status = 302; await assert.rejects(requestPage("https://example.com/report", "8.8.8.8"), /redirects/);
    status = 200; encoding = "gzip"; await assert.rejects(requestPage("https://example.com/report", "8.8.8.8"), /Compressed/);
    encoding = undefined; type = "application/pdf"; await assert.rejects(requestPage("https://example.com/report", "8.8.8.8"), /format/);
    type = "text/plain; charset=gbk"; await assert.rejects(requestPage("https://example.com/report", "8.8.8.8"), /format/);
    type = "text/plain"; size = 262145; await assert.rejects(requestPage("https://example.com/report", "8.8.8.8"), /download budget/);
  } finally { https.get = original; }
});

test("DNS resolution and transport can be aborted without continuing the network request", async () => {
  const controller = new AbortController(); let sent = false;
  const work = readPublicPage("https://example.com", { signal: controller.signal, lookup: () => new Promise(() => {}), transport: () => { sent = true; } });
  controller.abort(new Error("cancelled")); await assert.rejects(work, /cancelled/); assert.equal(sent, false);
});

test("web approval is scoped to one turn; decline/cancel perform no request, repeated reads reuse only exact URL", async () => fixture(async root => {
  let reads = 0;
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(root, "state"), providerRegistry: { apiProfile: () => profile }, publicPageReader: async url => { reads++; return readPublicPage(url, { lookup: publicLookup, transport: pageTransport }); } });
  const { thread: created } = await runtime.createThread({ cwd: root, referenceRoot: root, provider: "deepseek", allowMutations: true });
  const thread = runtime.threads.get(created.id);
  const turn = { id: "test-turn", items: [], approvalIds: new Set(), status: "inProgress", abort: new AbortController() }; thread.turns.push(turn);
  const invoke = (turn, url = "https://example.com/report") => runtime.executePersonalTool({ thread, turn, name: "public_web_read", args: { url }, signal: turn.abort.signal });
  const first = wait(runtime, e => e.method === "item/tool/requestApproval"); const declined = invoke(turn); const pending = await first;
  assert.equal(reads, 0); assert.equal(pending.params.item.url, "https://example.com/report");
  await runtime.resolveApproval({ requestId: pending.id, decision: "decline" }); assert.equal((await declined).ok, false); assert.equal(reads, 0);
  const second = wait(runtime, e => e.method === "item/tool/requestApproval"); const approved = invoke(turn); await runtime.resolveApproval({ requestId: (await second).id, decision: "accept" }); assert.equal((await approved).ok, true);
  assert.equal((await invoke(turn)).ok, true); assert.equal(reads, 2);
  const next = { ...turn, id: "next-turn", approvalIds: new Set(), items: [], abort: new AbortController() }; thread.turns.push(next);
  const another = wait(runtime, e => e.method === "item/tool/requestApproval"); const canceled = invoke(next); await another; next.abort.abort(); await assert.rejects(canceled); assert.equal(reads, 2); assert.equal(runtime.approvals.size, 0);
  const wrong = await runtime.executePersonalTool({ thread: { ...thread, referenceRoot: null }, turn, name: "reference_read", args: { path: "no.txt" } }); assert.equal(wrong.ok, false);
}));

test("native research workflow reads separate source, creates HTML under approval, re-reads evidence, and reaches human review", async () => fixture(async root => {
  const sources = path.join(root, "source"); fs.mkdirSync(sources); fs.writeFileSync(path.join(sources, "brief.txt"), "QA fixture: option A costs 7, option B costs 12; unverified prices.");
  const store = new MissionStore(path.join(root, "ledger.sqlite3"));
  const personal = store.personal.saveProject({ name: "QA decision", goal: "Compare options with traceable evidence" });
  let calls = 0; let webRequests = 0;
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(root, "native"), providerRegistry: { apiProfile: () => profile }, publicPageReader: async url => { webRequests++; return readPublicPage(url, { lookup: publicLookup, transport: pageTransport }); }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body); calls++;
    assert.equal(body.tools.some(t => ["workspace_bash", "workspace_git"].includes(t.function.name)), false);
    if (calls === 1) return response(null, "reference_read", { path: "brief.txt" });
    if (calls === 2) { assert.ok(body.messages.some(m => /local_reference/.test(m.content || ""))); return response(null, "public_web_read", { url: "https://example.com/report" }); }
    if (calls === 3) return response(null, "workspace_write", { path: "decision.html", content: '<!doctype html><html lang="zh"><title>QA comparison</title><h1>QA decision</h1><p>Option A: 7; option B: 12. Fixture, not real advice.</p><p>Source: brief.txt; https://example.com/report. Prices unverified.</p></html>' });
    if (calls === 4) return response(JSON.stringify({ summary: "QA HTML decision drafted from local and public fixtures", acceptance: [{ criterion: "Traceable HTML draft", passed: true, evidence: "decision.html and source receipts" }], changedFiles: ["decision.html"], blockers: [] }));
    assert.equal(body.tools.some(t => t.function.name === "workspace_write"), false);
    if (calls === 5) return response(null, "reference_read", { path: "brief.txt" });
    if (calls === 6) return response(null, "workspace_read", { path: "decision.html" });
    return response('{"passed":true,"summary":"Read source and draft independently"}');
  } });
  const orchestrator = new MissionOrchestrator({ store, worktrees: new WorktreeManager(path.join(root, "worktrees")), adapterHost: new ProviderAdapterHost({ nativeHarness: runtime }), selectRuntime: () => ({ runtimeMode: "agent_deck", provider: "deepseek" }) });
  const handling = []; runtime.on("event", event => handling.push(orchestrator.handleCodexEvent(event)));
  try {
    const webApproval = wait(runtime, e => e.method === "item/tool/requestApproval");
    const finished = wait(runtime, e => e.method === "turn/completed");
    const mission = await orchestrator.create({ title: "QA personal research", outcome: "Traceable HTML draft", cwd: sources, executionMode: "research", orchestrationMode: "direct", projectId: personal.id });
    const pending = await webApproval; await Promise.all(handling);
    const task = store.getMission(mission.id).tasks[0]; assert.equal(task.status, "waiting_approval"); assert.equal(webRequests, 0);
    const writing = wait(runtime, e => e.method === "item/fileChange/requestApproval"); await orchestrator.resolveApproval({ missionId: mission.id, requestId: pending.id, decision: "accept" });
    const write = await writing; assert.equal(fs.existsSync(path.join(task.worktreePath, "decision.html")), false);
    await orchestrator.resolveApproval({ missionId: mission.id, requestId: write.id, decision: "accept" });
    assert.equal((await finished).params.turn.status, "completed"); await Promise.all(handling);
    const done = store.getTask(task.id); assert.equal(done.status, "review"); assert.equal(done.result.changedFiles[0], "decision.html");
    assert.notEqual(done.worktreePath, sources); assert.equal(fs.existsSync(path.join(sources, "decision.html")), false); assert.equal(fs.existsSync(path.join(sources, ".git")), false);
    assert.equal(sourceReceipts(store.getMission(mission.id).events, task.id).length, 2);
    assert.equal(store.personal.context({ projectId: personal.id }).items.length, 0, "Unreviewed results must not flow to future work");
    await orchestrator.acceptTask(mission.id, task.id);
    assert.equal(store.personal.context({ projectId: personal.id }).items.filter(item => item.type === "accepted_result").length, 1);
    assert.equal(store.personal.recovery(personal.id).works[0].accepted, 1);
    assert.equal(webRequests, 1); assert.equal(calls, 7);
  } finally { store.close(); }
}));

test("source presentation ignores claims, duplicates and failed reads; stays scoped to selected worker", () => {
  const source = { kind: "public_web", url: "https://example.com/report", sha256: "a".repeat(64), readAt: new Date().toISOString() };
  const event = { seq: 1, taskId: "t", type: "provider.item/completed", payload: { item: { server: "agent-deck-personal", state: "executed", source } } };
  assert.equal(sourceReceipts([event, { ...event, seq: 2 }], "t").length, 1);
  assert.equal(sourceReceipts([event], "other").length, 0);
  assert.equal(sourceReceipts([{ ...event, payload: { item: { ...event.payload.item, state: "failed" } } }], "t").length, 0);
});
