import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const require = createRequire(import.meta.url);
const { cases, usageOf, usageSummary, gradeReport, fixtureContext, plan, runSuite: actualSuite, compareRuns, summarize, reportHtml, sandboxPreview } = require("../scripts/personal-eval-core.cjs");
const runSuite = options => actualSuite({ ...options, measurementSource: "fixture" });
const { parseArgs, preflight, validateProfile } = require("../scripts/personal-eval.cjs");
const { promptFor } = require("../benchmarks/personal-cases.cjs");
const { personalContextBlock } = require("../desktop/personal-context.cjs");
const profile = { endpoint: "https://synthetic-model.test/v1", model: "fixture-not-a-live-model", apiKey: "fixture-secret-never-persist" };
async function fixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-personal-eval-"));
  try { await callback(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const freshRead = [{ tool: "reference_read", path: "brief.txt", phase: "executing", ok: true }];
function htmlFor(item) {
  const data = { caseId: item.id, ...item.expected, limitations: [`${item.uncertainty}需要继续核验`], sources: ["brief.txt", "prior-notes.txt"] };
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>合成测试文档</title></head><body><main><h1>${item.visible}</h1><p>本轮条件优先于旧结论。${item.uncertainty}需要继续核验，不能据此声称已完成真实验证。已知数值：${Object.values(item.expected.facts).filter(value => typeof value === "number").join(" / ")}。来源：brief.txt 与 prior-notes.txt。</p><script type="application/json" id="agent-deck-data">${JSON.stringify(data)}</script></main></body></html>`;
}
function modelFixture({ usage = true, extraWrite = false } = {}) {
  let count = 0; const requests = [];
  const fetchImpl = async (_url, input) => {
    const body = JSON.parse(input.body); requests.push(body); count++;
    const text = body.messages.map(message => message.content || "").join("\n");
    const item = cases.find(item => text.includes(`"caseId":"${item.id}"`)) || cases[0];
    const step = (count - 1) % 6;
    const tool = (name, args) => ({ role: "assistant", content: null, tool_calls: [{ id: `fixture-${count}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
    const message = step === 0 ? tool("reference_read", { path: "brief.txt" })
      : step === 1 ? tool("reference_read", { path: "prior-notes.txt" })
      : step === 2 ? tool("workspace_write", { path: extraWrite ? "not-authorized.html" : "report.html", content: htmlFor(item) })
      : step === 3 ? { role: "assistant", content: JSON.stringify({ summary: "合成响应：交付已生成，等待人工审阅。", acceptance: [], changedFiles: ["report.html"], blockers: [] }) }
      : step === 4 ? tool("workspace_read", { path: "report.html" })
      : { role: "assistant", content: '{"passed":true,"summary":"Synthetic auditor fixture; not a live quality finding"}' };
    return new Response(JSON.stringify({ choices: [{ message }], ...(usage ? { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } } : {}) }), { status: 200 });
  };
  return { fetchImpl, requests, count: () => count };
}
test("three versioned synthetic cases have stable fingerprints and default is no-call plan", () => {
  assert.equal(cases.length, 3); const result = plan();
  assert.equal(result.status, "prepared_not_measured"); assert.equal(result.protocol.apiCalls, 0);
  assert.deepEqual(result.cases, plan().cases);
  assert.equal(parseArgs([]).mode, "plan"); assert.deepEqual(parseArgs(["--live"]).caseIds, ["P1"]);
  assert.throws(() => parseArgs(["--live", "--plan"])); assert.throws(() => parseArgs(["--max-calls", "NaN"]));
  assert.throws(() => plan({ repeats: 0 })); assert.throws(() => plan({ caseIds: ["P1", "P1"] }));
  for (const item of cases) assert.ok(!promptFor(item).includes(JSON.stringify(item.expected.facts)), "No expected answer object enters the request");
  assert.ok(!cases[2].brief.includes("insufficient_evidence"));
});
test("authorized project context is bounded, matches source facts and excludes revoked memory", async () => fixture(root => {
  const context = fixtureContext(root, cases[2]); const text = personalContextBlock(context);
  assert.ok(context.stats.chars <= 6000); assert.match(text, /20ms/); assert.match(text, /使用中文/);
  assert.ok(!text.includes("只使用英文报告")); assert.match(text, /Quoted data/);
}));
test("unknown, partial, inconsistent and fractional usage never becomes zero-token success", () => {
  assert.equal(usageOf({ prompt_tokens: 1.5, completion_tokens: 2, total_tokens: 3.5 }).complete, false);
  assert.equal(usageOf({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 99 }).complete, false);
  assert.equal(usageSummary([]).totalTokens, null);
  const partial = usageSummary([{ usage: usageOf({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }) }, { usage: usageOf(null) }]);
  assert.equal(partial.source, "partial"); assert.equal(partial.totalTokens, null); assert.equal(partial.knownPartialTotalTokens, 15);
});
test("grade requires current facts, visible answer, uncertainty and fresh source receipt", () => {
  for (const item of cases) {
    const html = htmlFor(item); assert.equal(gradeReport(item, html, freshRead).score, 100);
    assert.equal(gradeReport(item, html, []).passed, false);
    assert.equal(gradeReport(item, html, [{ ...freshRead[0], phase: "auditing" }]).passed, false);
    assert.equal(gradeReport(item, html.replace(`"caseId":"${item.id}"`, '"caseId":"WRONG"'), freshRead).passed, false);
  }
});
test("active HTML fails the offline contract and preview always enforces a sandbox", () => {
  const html = htmlFor(cases[0]);
  for (const active of ['<script>alert(1)</script>', '<p onclick="alert(1)">x</p>', '<iframe src="https://evil.test"></iframe>', '<img src=//evil.test/x>', '<meta http-equiv="refresh" content="0;url=https://evil.test">', '<style>@import "https://evil.test";</style>']) {
    assert.equal(gradeReport(cases[0], html + active, freshRead).passed, false);
    const preview = sandboxPreview(html + active); assert.match(preview, /sandbox=""/); assert.match(preview, /default-src &#39;none&#39;|default-src 'none'/);
    assert.equal((preview.match(/<iframe\b/g) || []).length, 1); assert.ok(!preview.includes('<script>alert(1)</script>'));
  }
});
test("failed and unmatched attempts are retained without performance wins", () => {
  const base = { caseId: "P1", repeat: 1, model: "fixture", endpointFingerprint: "e", sdkRevision: "s", sourceSha256: "f", basePromptSha256: "p", elapsedMs: 10, status: "passed", grade: { score: 100 }, usage: { source: "provider_reported", totalTokens: 100 } };
  assert.equal(compareRuns(base, { ...base, elapsedMs: 5 }).timeRatio, 0.5);
  assert.equal(compareRuns(base, { ...base, sdkRevision: "changed" }).status, "mismatch");
  const failed = { ...base, status: "contract_failed" }; assert.equal(compareRuns(base, failed).tokenRatio, null);
  assert.equal(compareRuns(base, { ...base, usage: { source: "partial", totalTokens: null } }).tokenRatio, null);
  const result = plan({ caseIds: ["P1"] }); result.runs = [{ ...failed, group: "no_project_context" }, { ...base, group: "project_context" }];
  assert.equal(summarize(result).failed, 1); assert.equal(summarize(result).pairs[0].comparison.status, "failed_pair");
});
test("readiness and metadata-only preflight do not decrypt or alter user profile", async () => fixture(root => {
  assert.equal(preflight(root).ready, false);
  const file = path.join(root, "provider-profiles.json");
  const content = JSON.stringify({ runtime: { mode: "agent_deck", modelProvider: "deepseek" }, api: { deepseek: { endpoint: profile.endpoint, model: profile.model, hasSecret: true, secret: "encrypted-not-a-real-key", verifiedAt: "fixture" } } });
  fs.writeFileSync(file, content); assert.equal(preflight(root).ready, true); assert.equal(fs.readFileSync(file, "utf8"), content);
  assert.throws(() => validateProfile({ ...profile, endpoint: "https://user:key@model.test/v1" }));
  assert.throws(() => validateProfile({ ...profile, endpoint: "https://model.test/v1?key=secret" }));
  assert.throws(() => validateProfile({ ...profile, endpoint: "http://model.test/v1" }));
}));
test("no-key CLI writes an honest blocked report without a live request", async () => fixture(root => {
  const child = spawnSync(process.execPath, [path.resolve("scripts/personal-eval.cjs"), "--preflight", "--config-dir", root], { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  assert.equal(child.status, 2); const output = JSON.parse(child.stdout);
  try {
    const result = JSON.parse(fs.readFileSync(path.join(path.dirname(output.report), "results.json")));
    assert.equal(result.protocol.apiCalls, 0); assert.equal(result.runs.length, 0); assert.match(fs.readFileSync(output.report, "utf8"), /尚未进行真实模型评测/);
  } finally { fs.rmSync(path.dirname(output.report), { recursive: true, force: true }); }
}));
test("real SDK fixture executes both arms, gated report write and fresh audit with no secret persistence", async () => fixture(async root => {
  const mock = modelFixture(); const result = await runSuite({ root, profile, caseIds: ["P1"], fetchImpl: mock.fetchImpl });
  assert.equal(result.runs.length, 2); assert.equal(mock.count(), 12);
  assert.equal(result.status, "fixture_checked"); assert.ok(!reportHtml(result).includes("真实模型运行记录 · 小样本探索"));
  for (const run of result.runs) {
    assert.equal(run.status, "passed", JSON.stringify(run)); assert.equal(run.usage.totalTokens, 90);
    assert.equal(run.grade.humanReview, "not_performed"); assert.equal(run.approvalRequestsAutomatedByEval, 1);
    assert.equal(run.rejectedActions, 0); assert.equal(run.repeatedWithinPhase, 0); assert.equal(run.sourceUnchanged, true);
    assert.ok(run.phases.some(phase => phase.phase === "auditing")); assert.match(fs.readFileSync(path.join(root, run.report), "utf8"), /sandbox=""/);
  }
  assert.ok(!mock.requests[0].messages.some(message => /agent_deck_personal_context/.test(message.content || "")));
  assert.ok(mock.requests[6].messages.some(message => /agent_deck_personal_context/.test(message.content || "")));
  const results = fs.readFileSync(path.join(root, "results.json"), "utf8"); assert.ok(!results.includes(profile.apiKey));
  assert.equal(result.protocol.apiCalls, 12); assert.equal(result.protocol.knownReportedTokens, 180);
}));
test("unknown provider usage remains unknown even when SDK fixture reports completion", async () => fixture(async root => {
  const mock = modelFixture({ usage: false }); const result = await runSuite({ root, profile, caseIds: ["P1"], fetchImpl: mock.fetchImpl });
  assert.equal(result.runs[0].status, "passed"); assert.equal(result.runs[0].usage.totalTokens, null);
  assert.equal(summarize(result).pairs[0].comparison.tokenRatio, null);
}));
test("other writes are declined; incomplete artifact is not counted as success", async () => fixture(async root => {
  const mock = modelFixture({ extraWrite: true }); const result = await runSuite({ root, profile, caseIds: ["P1"], fetchImpl: mock.fetchImpl });
  assert.notEqual(result.runs[0].status, "passed"); assert.ok(result.runs[0].rejectedActions >= 1);
  assert.equal(fs.existsSync(path.join(root, "P1-no_project_context-1/workspace/not-authorized.html")), false);
  assert.equal(summarize(result).pairs[0].comparison.timeRatio, null);
}));
test("suite budget stops new model requests and preserves the failed partial attempt", async () => fixture(async root => {
  const mock = modelFixture(); const result = await runSuite({ root, profile, caseIds: ["P1"], maxCalls: 1, fetchImpl: mock.fetchImpl });
  assert.equal(mock.count(), 1); assert.equal(result.runs.length, 1); assert.equal(result.runs[0].status, "runtime_failed");
  assert.equal(result.budgetStopped, true); assert.equal(result.protocol.apiCalls, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "results.json"))).runs.length, 1);
}));
test("HTTP failures are kept and provider error payload is never copied into results", async () => fixture(async root => {
  const result = await runSuite({ root, profile, caseIds: ["P1"], fetchImpl: async () => new Response(JSON.stringify({ error: { message: profile.apiKey } }), { status: 429 }) });
  assert.equal(result.runs.length, 2); assert.equal(result.runs[0].status, "runtime_failed");
  assert.equal(result.runs[0].usage.totalTokens, null); assert.equal(result.runs[0].requests[0].httpStatus, 429);
  assert.ok(!fs.readFileSync(path.join(root, "results.json"), "utf8").includes(profile.apiKey));
}));
test("report escapes metadata and says clearly when no measurement exists", () => {
  const result = plan(); result.blocker = '<script>alert("not executed")</script>';
  const html = reportHtml(result); assert.ok(!html.includes(result.blocker)); assert.match(html, /尚未进行真实模型评测/);
  assert.match(html, /\\u003cscript/); assert.ok(!html.includes("0 Token"));
});
