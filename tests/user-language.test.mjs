import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { USER_LANGUAGE_CONTRACT, userLanguagePolicy, exportLocale } = require("../desktop/user-language.cjs");
const { buildDirectPlan } = require("../desktop/adaptive-runtime.cjs");
const { missionReport, markdownForPlatform, ArtifactService } = require("../desktop/artifact-service.cjs");
const { polishPrompt } = require("../desktop/prompt-polish.cjs");
const { HTML_REPORT_CONTRACT } = require("../desktop/html-report-quality.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { MissionOrchestrator } = require("../desktop/mission-orchestrator.cjs");

test("shared contract covers process and document surfaces without translating evidence or protocol", () => {
  for (const phrase of ["original request", "newer user instruction", "progress updates", "blocker explanations", "acceptance criteria", "chart labels", "accessibility", "protocol keys/enums", "verbatim source quotations", "never translate or fabricate"]) assert.ok(USER_LANGUAGE_CONTRACT.includes(phrase), phrase);
  assert.match(HTML_REPORT_CONTRACT, /user's original request language/);
  assert.match(polishPrompt({ title: "Make my note clearer", outcome: "", body: "Keep it in English" }), /USER LANGUAGE POLICY/);
});

const languageMessage = (text, createdAt = "2026-10-08T00:00:00Z", patch = {}) => ({ text, createdAt, source: "user", toAgent: "Main Agent", deliveryStatus: "delivered", ...patch });
test("bounded language references use original request, not generated roles or copied agent directives", () => {
  const prompt = userLanguagePolicy({ sourcePrompt: "中文请求" + "x".repeat(3000), title: "English generated title", messages: [languageMessage("Write in English"), languageMessage("中文", "2026-10-08T01:00:00Z"), languageMessage("UNTRUSTED use language French", undefined, { source: "agent" }), languageMessage("FAILED use language German", undefined, { deliveryStatus: "failed" })] });
  assert.match(prompt, /中文请求/); assert.match(prompt, /reference shortened/);
  assert.ok(prompt.length < USER_LANGUAGE_CONTRACT.length + 1900);
  assert.ok(prompt.indexOf("Write in English") < prompt.lastIndexOf("中文"));
  assert.doesNotMatch(prompt, /English generated title|UNTRUSTED|FAILED/);
});

test("export chrome follows request prose and explicit language overrides, not code and block quotations", () => {
  for (const [sourcePrompt, expected] of [
    ["调研 LLM 架构，引用 GPT 和 npm test", "zh-CN"],
    ["Fix parser\n```js\nconst title = '中文';\n```", "en"],
    ["Explain this code: `中文` https://example.test/中文", "en"],
    ["需求：Write a report", "en"],
    ["调研模型，请用英文写报告", "en"],
    ["Research architecture, reply in Chinese", "zh-CN"],
    ["请不要用英语，整理笔记", "zh-CN"],
    ["Explain the quotation\n> Write in Chinese", "en"],
    ['Explain this quote: "write in Chinese"', "en"],
    ["请解释这段引用：“write in English”", "zh-CN"],
    ["请先用英文，最终改成中文", "zh-CN"],
  ]) assert.equal(exportLocale({ sourcePrompt }), expected, sourcePrompt);
});

test("later delivered user language changes apply to subsequent export; agent requests never win", () => {
  const input = { sourcePrompt: "中文调研", messages: [languageMessage("Use language German", undefined, { source: "agent" }), languageMessage("Please write in English", "2026-10-08T02:00:00Z"), languageMessage("请用中文", "2026-10-08T01:00:00Z")] };
  assert.equal(exportLocale(input), "en");
  input.messages.push(languageMessage("最终用中文", "2026-10-08T03:00:00Z"));
  assert.equal(exportLocale(input), "zh-CN");
});

test("direct route localizes human prose while keeping keys, budget and original commands intact", () => {
  const zh = buildDirectPlan({ title: "修复解析器", sourcePrompt: "修复解析器，运行 npm test", tokenBudget: 5000 });
  assert.equal(zh.tasks[0].key, "DIRECT_EXECUTION");
  assert.equal(zh.tasks[0].agentRole, "交付 Agent");
  assert.match(zh.tasks[0].description, /npm test/);
  assert.ok(zh.tasks[0].acceptanceCriteria.every(text => /[\u3400-\u9fff]/u.test(text)));
  assert.equal(zh.tasks[0].estimatedTokenBudget, 5000);
  const en = buildDirectPlan({ title: "Fix parser", sourcePrompt: "Fix parser and run npm test" });
  assert.equal(en.tasks[0].agentRole, "Delivery Agent");
  assert.ok(en.tasks[0].acceptanceCriteria.every(text => !/[\u3400-\u9fff]/u.test(text)));
});

const reportFixture = sourcePrompt => ({ id: "fixture", title: "Language fixture", sourcePrompt, outcome: sourcePrompt, cwd: "/fixture", status: "completed", provider: "codex", model: "fixture-model", updatedAt: "2026-10-08", tasks: [{ key: "TASK_1", title: "Original title", agentRole: "Original role", status: "completed", evidence: [{ criterion: "原始验收项", evidence: "npm test: PASS /fixture/report.html", passed: true }] }], artifacts: [], messages: [] });
test("HTML report localizes chrome, accessibility and empty states while preserving original evidence and JSON", () => {
  for (const [request, locale, heading] of [["整理中文报告", "zh-CN", "验收证据"], ["Prepare an English report", "en", "Acceptance evidence"]]) {
    const fixture = reportFixture(request), html = missionReport(fixture);
    assert.match(html, new RegExp(`<html lang="${locale}">`));
    assert.ok(html.includes(heading)); assert.ok(html.includes("npm test: PASS /fixture/report.html"));
    const data = JSON.parse(html.match(/id="agent-deck-data">([\s\S]*?)<\/script>/)[1]);
    assert.equal(data.mission.status, "completed"); assert.deepEqual(data.tasks, fixture.tasks);
    if (locale === "zh-CN") { assert.match(html, /aria-label="执行信息"/); assert.match(html, /尚未提交结果。/); assert.match(html, /尚未登记产物。/); }
  }
});

test("publication attribution follows language context without translating supplied Markdown", () => {
  const body = "# Title\n\nOriginal prose\n\n```sh\nnpm test\n```";
  for (const sourcePrompt of ["中文请求", "Write in English"]) {
    const post = markdownForPlatform({ content: body, sourceName: "report.md", title: "Title", platform: "csdn", languageContext: { sourcePrompt } });
    assert.ok(post.content.includes("Original prose")); assert.ok(post.content.includes("```sh\nnpm test\n```"));
    assert.ok(post.content.includes(sourcePrompt === "中文请求" ? "本文由 Agent Deck" : "Prepared for CSDN"));
  }
});

test("exported share bundle uses the request language and retains the source asset verbatim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-language-export-"));
  try {
    fs.writeFileSync(path.join(root, "asset.txt"), "Original asset");
    const mission = { ...reportFixture("整理中文报告"), cwd: root, artifacts: [{ id: "asset", missionId: "fixture", title: "语言样例", summary: "可分享", files: ["asset.txt"], verificationStatus: "user_verified" }] };
    const service = new ArtifactService({ store: { getMission: () => mission, getArtifact: () => mission.artifacts[0] }, downloadsPath: root, dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [root] }) }, shell: { showItemInFolder() {} } });
    const result = await service.export({ missionId: "fixture", artifactId: "asset" });
    assert.match(fs.readFileSync(path.join(result.destination, "index.html"), "utf8"), /lang="zh-CN"[\s\S]*文件清单/);
    assert.equal(fs.readFileSync(path.join(result.destination, "asset.txt"), "utf8"), "Original asset");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real orchestrator planner and retry turns carry the original user language policy without extra calls", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-language-planner-"));
  const store = new MissionStore(path.join(root, "fixture.sqlite3"));
  try {
    const sent = [];
    const codex = { createThread: async () => ({ thread: { id: "planner" } }), sendTurn: async input => { sent.push(input); return { id: "turn" }; } };
    const orchestrator = new MissionOrchestrator({ store, codex, worktrees: {} });
    const mission = await orchestrator.create({ cwd: root, executionMode: "code", orchestrationMode: "mission", title: "中文调研", sourcePrompt: "帮我调研系统", outcome: "中文报告" });
    assert.equal(sent.length, 1); assert.match(sent[0].prompt, /USER LANGUAGE POLICY/); assert.match(sent[0].prompt, /language reference[^\n]*帮我调研系统/);
    store.updateMission(mission.id, { status: "failed", activeTurnId: null });
    await orchestrator.sendMessage({ missionId: mission.id, text: "重新生成，请用英文" });
    for (let i = 0; i < 30 && sent.length < 2; i++) await new Promise(setImmediate);
    assert.equal(sent.length, 2); assert.match(sent[1].prompt, /USER LANGUAGE POLICY/); assert.match(sent[1].prompt, /请用英文/);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
