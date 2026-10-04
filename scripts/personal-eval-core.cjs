const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { isDeepStrictEqual } = require("node:util");
const { cases, promptFor } = require("../benchmarks/personal-cases.cjs");
const { MissionStore } = require("../desktop/mission-store.cjs");
const { NativeHarnessRuntime } = require("../desktop/native-harness-runtime.cjs");
const { personalContextBlock } = require("../desktop/personal-context.cjs");
const { assessHtmlReport } = require("../desktop/html-report-quality.cjs");
const digest = value => createHash("sha256").update(value).digest("hex");
const schemaVersion = "agent-deck-personal-eval/v1";
const groups = ["no_project_context", "project_context"];
const finite = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const jsonScript = value => JSON.stringify(value).replaceAll("<", "\\u003c");
// A text approximation for contract checks only, not a DOM renderer or prose judge.
const visibleText = html => String(html).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ").replace(/<[^>]*>/g, " ");
function sandboxPreview(html) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; frame-src about:; img-src data:; form-action 'none'; base-uri 'none'"><title>隔离草稿预览 · 未人工验收</title><style>body{margin:0;font:14px system-ui;background:#111419;color:#dce3ef}p{padding:12px 20px}iframe{width:100%;height:calc(100vh - 80px);border:0;background:white}</style></head><body><p>模型草稿 · 未人工验收 · 禁止脚本、联网、表单和父页面访问。评分不是事实正确性的保证。</p><iframe sandbox="" title="隔离 HTML 草稿" srcdoc="${esc(html)}"></iframe></body></html>`;
}

function usageOf(value) {
  const input = finite(value?.prompt_tokens); const output = finite(value?.completion_tokens); const total = finite(value?.total_tokens);
  return { input, output, total, complete: input !== null && output !== null && total !== null && total === input + output };
}
function usageSummary(requests) {
  const reported = requests.filter(request => request.usage?.complete);
  const complete = requests.length > 0 && reported.length === requests.length;
  const sum = name => reported.reduce((total, request) => total + request.usage[name], 0);
  return { source: complete ? "provider_reported" : reported.length ? "partial" : "unavailable", reportedCalls: reported.length, totalCalls: requests.length,
    inputTokens: complete ? sum("input") : null, outputTokens: complete ? sum("output") : null, totalTokens: complete ? sum("total") : null, knownPartialTotalTokens: reported.length ? sum("total") : null };
}
function parseAnswer(html) {
  const blocks = [...String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)].filter(match => /\bid=["']agent-deck-data["']/i.test(match[1]) && /\btype=["']application\/json["']/i.test(match[1]));
  if (blocks.length !== 1) return null;
  try { const data = JSON.parse(blocks[0][2]); return data && typeof data === "object" && !Array.isArray(data) ? data : null; } catch { return null; }
}
function gradeReport(item, html, sourceReads = []) {
  const data = parseAnswer(html); const text = visibleText(html);
  const checks = [
    { key: "answer_schema", points: 8, passed: data?.caseId === item.id },
    { key: "current_decision", points: 16, passed: data?.choice === item.expected.choice },
    { key: "current_facts", points: 24, passed: isDeepStrictEqual(data?.facts, item.expected.facts) },
    { key: "visible_decision", points: 8, passed: text.includes(item.visible) && Object.values(item.expected.facts).filter(value => typeof value === "number").every(value => new RegExp(`(?<![0-9])${value}(?![0-9])`).test(text)) },
    { key: "uncertainty", points: 10, passed: Array.isArray(data?.limitations) && data.limitations.every(value => typeof value === "string") && data.limitations.some(value => value.includes(item.uncertainty)) && text.includes(item.uncertainty) },
    { key: "source_links", points: 10, passed: Array.isArray(data?.sources) && ["brief.txt", "prior-notes.txt"].every(file => data.sources.includes(file)) && text.includes("brief.txt") },
    { key: "fresh_source_read", points: 10, passed: sourceReads.some(read => read.tool === "reference_read" && read.path === "brief.txt" && read.ok && read.phase === "executing") },
    { key: "readable_document", points: 7, passed: /<!doctype html>/i.test(html) && /<html\b[^>]*lang=["']zh(?:-CN)?["']/i.test(html) && /<main\b/i.test(html) && (text.match(/[\u4e00-\u9fff]/g)?.length || 0) >= 20 },
    { key: "offline_safe", points: 7, passed: !/<script\b(?![^>]*type=["']application\/json["'])/i.test(html) && !/\bon[a-z]+\s*=/i.test(html) && !/<(?:link|iframe|object|embed|audio|video|base|form)\b/i.test(html) && !/\b(?:src|srcset|href)\s*=\s*["']?\s*(?:https?:|\/\/|javascript:)/i.test(html) && !/@import|url\s*\(/i.test(html) && !/<meta\b[^>]*http-equiv/i.test(html) },
  ];
  return { score: checks.filter(check => check.passed).reduce((total, check) => total + check.points, 0), maximum: 100, passed: checks.every(check => check.passed), checks,
    editorial: assessHtmlReport(html), humanReview: "not_performed", notice: "Deterministic contract checks, not a human assessment of prose, aesthetics or full factual consistency." };
}
function fixtureContext(root, item) {
  const store = new MissionStore(path.join(root, "fixture-context.sqlite3"));
  try {
    const project = store.personal.saveProject({ name: `EVAL · ${item.id}`, goal: item.goal });
    for (const memory of item.memories) store.personal.saveMemory({ ...memory, projectId: project.id, sourceLabel: "Synthetic pre-confirmed benchmark preference" });
    const prior = store.createMission({ title: `EVAL · ${item.id} · prior`, outcome: item.goal, projectId: project.id, cwd: root });
    store.savePlan(prior.id, { title: prior.title, outcome: item.goal, tasks: [{ key: "SEED", title: "Synthetic pre-reviewed prior", agentRole: "Fixture", description: "Benchmark seed, not live execution", dependencies: [], acceptanceCriteria: ["Synthetic ground-truth setup"] }] });
    store.updateTask(store.getMission(prior.id).tasks[0].id, { status: "completed", result: { summary: item.priorSummary } });
    store.updateMission(prior.id, { status: "completed" });
    return store.personal.context({ projectId: project.id, query: item.goal });
  } finally { store.close(); }
}
function plan({ caseIds = cases.map(item => item.id), repeats = 1 } = {}) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) throw new Error("Choose 1–5 repeats");
  if (!caseIds.length || new Set(caseIds).size !== caseIds.length || caseIds.some(id => !cases.some(item => item.id === id))) throw new Error("Choose unique cases P1, P2, P3");
  return { schemaVersion, status: "prepared_not_measured", generatedAt: new Date().toISOString(), repeats,
    comparison: "Same native Harness, model, current request, tools and source access; only the authorized project-context block differs. NOT a Codex comparison.",
    cases: cases.filter(item => caseIds.includes(item.id)).map(item => ({ id: item.id, title: item.title, sourceSha256: digest(item.brief + "\n" + item.prior), promptSha256: digest(promptFor(item)) })), runs: [],
    protocol: { apiCalls: 0, autoApproval: "Only isolated report.html writes; no web, commands or Git", fullAppUiMeasured: false, fixtures: "Synthetic source data, real Harness execution only in --live", recommendedRepeats: 3 } };
}
async function runCase({ item, group, repeat, root, context, profile, fetchImpl = fetch, budget, onProgress = () => {} }) {
  if (!groups.includes(group)) throw new Error("Unknown comparison group");
  const output = path.join(root, `${item.id}-${group}-${repeat}`); fs.mkdirSync(output, { recursive: true });
  const sources = path.join(output, "sources"); const workspace = path.join(output, "workspace"); fs.mkdirSync(sources); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(sources, "brief.txt"), item.brief); fs.writeFileSync(path.join(sources, "prior-notes.txt"), item.prior);
  const original = digest(item.brief + "\n" + item.prior);
  const requests = []; const reads = []; const phases = []; const approvals = []; let phase = "starting";
  const startedAt = new Date().toISOString(); const clock = performance.now();
  const prompt = promptFor(item) + (group === "project_context" ? personalContextBlock(context) : "");
  const measuredFetch = async (url, input) => {
    if (budget.calls >= budget.maxCalls || budget.tokens >= budget.maxTokens) throw new Error("Evaluation suite budget exhausted");
    budget.calls++;
    const started = performance.now(); const body = JSON.parse(input.body); const request = { phase, promptChars: JSON.stringify(body.messages).length, usage: null, durationMs: null, status: "pending" }; requests.push(request);
    onProgress({ caseId: item.id, group, phase, call: requests.length, status: "request_started" });
    try {
      const response = await fetchImpl(url, input);
      const data = await response.clone().json().catch(() => ({})); request.usage = usageOf(data.usage); request.httpStatus = response.status;
      if (request.usage.total !== null) budget.tokens += request.usage.total;
      request.status = response.ok ? "completed" : "http_failed";
      return response;
    } catch (error) { request.status = "transport_failed"; throw error; }
    finally { request.durationMs = Math.round(performance.now() - started); onProgress({ caseId: item.id, group, phase, call: requests.length, status: request.status, durationMs: request.durationMs }); }
  };
  const runtime = new NativeHarnessRuntime({ rootDirectory: path.join(output, "native"), providerRegistry: { apiProfile: () => profile }, fetchImpl: measuredFetch, publicPageReader: async () => { throw new Error("Network source access is disabled by benchmark policy"); } });
  let completed; let timer;
  const done = new Promise(resolve => { completed = resolve; });
  const handling = [];
  runtime.on("event", event => {
    if (event.method === "harness/phase") { phase = event.params.phase; phases.push({ phase, atMs: Math.round(performance.now() - clock) }); }
    if (event.method.endsWith("/requestApproval")) {
      const accepted = event.method === "item/fileChange/requestApproval" && event.params.item?.tool === "workspace_write" && event.params.path === "report.html";
      approvals.push({ type: event.method, approved: accepted });
      handling.push(runtime.resolveApproval({ requestId: event.id, decision: accepted ? "accept" : "decline" }));
    }
    if (event.method === "item/completed" && ["reference_read", "reference_list", "workspace_read"].includes(event.params.item?.tool)) reads.push({ phase, tool: event.params.item.tool, path: event.params.item.path, ok: event.params.item.state === "executed", startLine: event.params.item.source?.startLine ?? null, endLine: event.params.item.source?.endLine ?? null, sourceSha256: event.params.item.source?.sha256 || null });
    if (event.method === "turn/completed") completed(event.params.turn);
  });
  let final;
  try {
    const created = await runtime.createThread({ cwd: workspace, referenceRoot: sources, provider: profile.provider || "deepseek", model: profile.model, allowMutations: true });
    const turn = await runtime.sendTurn({ threadId: created.thread.id, prompt });
    timer = setTimeout(() => runtime.interrupt({ turnId: turn.id }).catch(() => {}), 310000);
    final = await done; await Promise.all(handling);
  } catch { final = { status: "failed", error: { message: "Evaluation startup or event handling failed; no automatic retry" } }; }
  finally { clearTimeout(timer); }
  const elapsedMs = Math.round(performance.now() - clock);
  const target = path.join(workspace, "report.html");
  const html = fs.existsSync(target) && fs.statSync(target).isFile() && !fs.lstatSync(target).isSymbolicLink() && fs.statSync(target).size <= 256 * 1024 ? fs.readFileSync(target, "utf8") : "";
  const sourceUnchanged = digest(fs.readFileSync(path.join(sources, "brief.txt"), "utf8") + "\n" + fs.readFileSync(path.join(sources, "prior-notes.txt"), "utf8")) === original;
  const grade = gradeReport(item, html, reads); const seen = new Set(); let repeatedWithinPhase = 0;
  if (html) fs.writeFileSync(path.join(output, "preview.html"), sandboxPreview(html), { mode: 0o600 });
  for (const read of reads.filter(read => read.ok && read.tool === "reference_read")) { const key = `${read.phase}:${read.path}:${read.startLine}:${read.endLine}`; if (seen.has(key)) repeatedWithinPhase++; seen.add(key); }
  return { caseId: item.id, group, repeat, startedAt, status: final.status === "completed" && grade.passed && sourceUnchanged ? "passed" : final.status !== "completed" ? "runtime_failed" : "contract_failed", runtimeStatus: final.status,
    runtimeError: final.error ? final.error.message.includes("budget exhausted") ? "Evaluation suite budget exhausted" : "Native runtime did not complete; inspect isolated native run locally" : null, elapsedMs, usage: usageSummary(requests), model: profile.model, endpointFingerprint: digest(profile.endpoint), sdkRevision: require("../desktop/harness-core/package.json").sourceRevision, sourceSha256: original, basePromptSha256: digest(promptFor(item)),
    contextChars: group === "project_context" ? context.stats.chars : 0, contextItems: group === "project_context" ? context.stats.included : 0,
    sourceUnchanged, grade, requests, phases, reads, repeatedWithinPhase, approvalRequestsAutomatedByEval: approvals.length, rejectedActions: approvals.filter(item => !item.approved).length,
    report: html ? path.relative(root, path.join(output, "preview.html")) : null, reportSha256: html ? digest(html) : null, humanReview: "not_performed" };
}
function compareRuns(left, right) {
  if (!left || !right) return { status: "incomplete", timeRatio: null, tokenRatio: null, qualityDelta: null };
  const matched = left.caseId === right.caseId && left.repeat === right.repeat && left.model === right.model && left.endpointFingerprint === right.endpointFingerprint && left.sdkRevision === right.sdkRevision && left.sourceSha256 === right.sourceSha256 && left.basePromptSha256 === right.basePromptSha256;
  if (!matched) return { status: "mismatch", timeRatio: null, tokenRatio: null, qualityDelta: null };
  const successful = left.status === "passed" && right.status === "passed";
  return { status: successful ? "paired" : "failed_pair", timeRatio: successful && left.elapsedMs > 0 ? right.elapsedMs / left.elapsedMs : null,
    tokenRatio: successful && left.usage.source === "provider_reported" && right.usage.source === "provider_reported" && left.usage.totalTokens > 0 ? right.usage.totalTokens / left.usage.totalTokens : null,
    qualityDelta: right.grade.score - left.grade.score };
}
function summarize(result) {
  const pairs = result.cases.flatMap(item => Array.from({ length: result.repeats }, (_, index) => {
    const control = result.runs.find(run => run.caseId === item.id && run.repeat === index + 1 && run.group === groups[0]);
    const treatment = result.runs.find(run => run.caseId === item.id && run.repeat === index + 1 && run.group === groups[1]);
    return { caseId: item.id, repeat: index + 1, control, treatment, comparison: compareRuns(control, treatment) };
  }));
  return { pairs, completed: result.runs.length, passed: result.runs.filter(run => run.status === "passed").length, failed: result.runs.filter(run => run.status !== "passed").length };
}
function reportHtml(result) {
  const summary = summarize(result); const live = ["measured", "running"].includes(result.status) && result.measurementSource === "live_model";
  const names = { no_project_context: "普通任务", project_context: "项目背景" };
  const rows = summary.pairs.map(pair => `<tr><th scope="row">${esc(pair.caseId)} · ${pair.repeat}</th>${[pair.control,pair.treatment].map(run => `<td>${run ? `${esc(run.status)}<br>${(run.elapsedMs / 1000).toFixed(1)}s · ${run.usage.totalTokens === null ? "Token 未完整报告" : `${run.usage.totalTokens} Token`}<br>合同 ${run.grade.score}/100` : "尚未运行"}</td>`).join("")}<td>耗时 ${pair.comparison.timeRatio === null ? "—" : pair.comparison.timeRatio.toFixed(2) + "×"}<br>Token ${pair.comparison.tokenRatio === null ? "—" : pair.comparison.tokenRatio.toFixed(2) + "×"}<br>${esc(pair.comparison.status)}</td></tr>`).join("");
  const traces = result.runs.map(run => `<details><summary>${esc(run.caseId)} · ${names[run.group]} · 第 ${run.repeat} 次 · ${esc(run.status)}</summary><p>${esc(run.runtimeError || "没有运行错误")} · ${run.requests.length} 次模型请求 · ${run.reads.filter(read => read.tool === "reference_read").length} 次资料读取（含独立复核） · 同阶段同范围重复读取 ${run.repeatedWithinPhase} 次</p><p>${run.contextChars} 背景字符 · ${run.approvalRequestsAutomatedByEval} 次评测限定写入批准 · 原资料${run.sourceUnchanged ? "未改变" : "发生变化"} · 未做人工验收</p><ul>${run.grade.checks.map(check => `<li>${check.passed ? "✓" : "✕"} ${esc(check.key)} · ${check.points} 分</li>`).join("")}</ul>${/^[A-Z0-9]+-(?:no_project_context|project_context)-[1-5]\/preview\.html$/.test(run.report || "") ? `<p><a href="${esc(run.report)}">隔离预览实际 HTML 草稿</a></p>` : ""}<p>报告 SHA-256：<code>${esc(run.reportSha256 || "无产物")}</code></p></details>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Deck · Personal Agent 评测</title><style>:root{--bg:#111419;--ink:#e1e6ef;--muted:#a4afbf;color-scheme:dark}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.8 system-ui,-apple-system,sans-serif}main{max-width:1050px;margin:auto;padding:clamp(24px,5vw,56px)}h1{font-size:clamp(26px,4vw,36px);line-height:1.3}h2{font-size:22px;margin-top:34px}p,li{color:var(--muted)}small{color:var(--muted)}a{color:#a9c9f5}code{overflow-wrap:anywhere}.notice{border-left:3px solid #799ece;padding:14px 20px;background:#1c2531}.table-scroll{overflow:auto}table{border-collapse:collapse;width:100%}caption{text-align:left;color:var(--muted);padding:12px 0}th,td{padding:14px 10px;border-bottom:1px solid #323a47;vertical-align:top;text-align:left;font-size:14px}details{border-top:1px solid #323a47;padding:16px 0}summary{cursor:pointer}footer{margin-top:32px;border-top:1px solid #323a47;padding-top:20px}@media(max-width:650px){th,td{min-width:130px}}@media print{body{background:white;color:black}.notice{background:#eee}p,li{color:#333}details{break-inside:avoid}}</style></head><body><main><header><small>固定资料 · 同模型 · 同一自有 Harness</small><h1>项目背景到底有没有帮忙？</h1><p>只改变“是否注入获授权的项目背景”，不把额外的信息、不同模型或更多 Agent 混进比较。</p></header><main-content><section><aside class="notice"><strong>${live ? "真实模型运行记录 · 小样本探索" : "尚未进行真实模型评测"}</strong><p>${live ? `${summary.completed} 次尝试，${summary.passed} 次合同检查通过，${summary.failed} 次未通过。所有失败均保留；这不是 Codex 对照，也不是完整产品质量证明。` : esc(result.blocker || "用例和评分器已准备好，真实 API 尚未运行。空值表示未测，不是零耗时或零 Token。")}</p></aside></section><section><h2>固定对照</h2><div class="table-scroll"><table><caption>耗时含 SDK 执行、限定写入批准和独立复核；不含人工审阅时间。右/左比值小于 1 才表示该成功配对中项目背景更省。</caption><thead><tr><th scope="col">用例 / 重复</th><th scope="col">普通任务</th><th scope="col">项目背景</th><th scope="col">耗时比 / 配对状态</th></tr></thead><tbody>${rows}</tbody></table></div></section><section><h2>每一次尝试的证据</h2>${traces || "<p>没有真实运行数据，不展示模拟得分或性能图。</p>"}</section><section><h2>怎样读这份报告</h2><ol><li>两组都能读同一份新资料和历史材料。实验组只是把同源的已确认偏好与已验收摘要提前整理成有预算的背景。</li><li>测试材料和历史验收种子是明确标注的合成资料；只有 --live 才会发送真实模型请求。不会读取你的真实项目、记忆、聊天或源文件。</li><li>评测自动批准的操作仅为隔离目录 report.html 写入；不访问网页、不运行 Shell / Git，不自动验收模型结果。它不测实际人工注意力负担。</li><li>未知或部分报告的 Token 保留为空；预算是请求前拦截，最后一轮已发生的费用仍可能超过阈值。只对双方成功且同口径的尝试计算速度 / Token 比。</li><li>合同分数不代表人类评价：正文事实一致性、表达和排版仍需盲审。${result.repeats < 3 ? "当前少于 3 次重复，缓存、执行顺序和 API 波动都可能影响结果。" : "即使有重复，缓存、顺序和 API 波动仍可能影响结果。"}</li></ol></section></main-content><footer>${esc(result.generatedAt)} · schema ${schemaVersion} · 结果状态 ${esc(result.status)}</footer><script type="application/json" id="agent-deck-data">${jsonScript(result)}</script></main></body></html>`;
}
async function runSuite({ root, profile, caseIds, repeats = 1, maxCalls = 48, maxTokens = 40000, fetchImpl, onProgress, measurementSource = "live_model" }) {
  if (!["live_model", "fixture"].includes(measurementSource)) throw new Error("Unknown measurement source");
  const result = plan({ caseIds, repeats }); result.status = "running"; result.model = profile.model; result.measurementSource = measurementSource;
  result.endpointFingerprint = digest(profile.endpoint); result.sdkRevision = require("../desktop/harness-core/package.json").sourceRevision;
  const budget = { calls: 0, tokens: 0, maxCalls, maxTokens };
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 256 || !Number.isInteger(maxTokens) || maxTokens < 1000 || maxTokens > 200000) throw new Error("Invalid evaluation suite budget");
  fs.mkdirSync(root, { recursive: true });
  if (fs.lstatSync(root).isSymbolicLink() || fs.readdirSync(root).length) throw new Error("Use a fresh empty evaluation directory");
  for (const [index, entry] of result.cases.entries()) {
    const item = cases.find(item => item.id === entry.id);
    const contextDir = path.join(root, `${item.id}-context`); fs.mkdirSync(contextDir);
    const context = fixtureContext(contextDir, item);
    for (let repeat = 1; repeat <= repeats; repeat++) for (const group of (index + repeat) % 2 ? groups : [...groups].reverse()) {
      if (budget.calls >= maxCalls || budget.tokens >= maxTokens) { result.budgetStopped = true; break; }
      result.runs.push(await runCase({ item, group, repeat, root, context, profile, fetchImpl, budget, onProgress }));
      // Preserve each failed or successful attempt before dispatching another.
      result.protocol.apiCalls = budget.calls; result.protocol.knownReportedTokens = budget.tokens;
      saveReport(root, result);
    }
  }
  result.protocol.apiCalls = budget.calls; result.protocol.knownReportedTokens = budget.tokens;
  result.protocol.maxCalls = maxCalls; result.protocol.maxTokens = maxTokens;
  result.status = budget.calls > 0 ? measurementSource === "fixture" ? "fixture_checked" : "measured" : "not_measured";
  result.generatedAt = new Date().toISOString(); saveReport(root, result);
  return result;
}
function saveReport(root, result) {
  fs.mkdirSync(root, { recursive: true });
  for (const [name, data] of [["results.json", JSON.stringify(result, null, 2)], ["report.html", reportHtml(result)]]) {
    fs.writeFileSync(path.join(root, `${name}.tmp`), data, { mode: 0o600 });
    fs.renameSync(path.join(root, `${name}.tmp`), path.join(root, name));
  }
}
module.exports = { cases, groups, schemaVersion, usageOf, usageSummary, gradeReport, fixtureContext, plan, runCase, runSuite, compareRuns, summarize, reportHtml, sandboxPreview, saveReport };
