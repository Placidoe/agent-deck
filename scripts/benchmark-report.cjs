const fs = require("node:fs");
const path = require("node:path");

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function loadResults(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory)
    .filter((name) => name.endsWith(".json") && !name.startsWith("benchmark-summary"))
    .flatMap((name) => {
      try {
        const result = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
        return result?.schemaVersion === "agent-deck-eval/v1" ? [{ ...result, sourceFile: name }] : [];
      } catch {
        return [];
      }
    });
}

function latestPassing(results, caseId, group, effort = "medium") {
  return results
    .filter((result) => result.caseId === caseId && result.group === group && result.reasoningEffort === effort && result.status === "passed")
    .sort((left, right) => Date.parse(right.startedAt || 0) - Date.parse(left.startedAt || 0))[0] || null;
}

function compactRun(result) {
  if (!result) return null;
  return {
    sourceFile: result.sourceFile,
    startedAt: result.startedAt,
    model: result.model,
    reasoningEffort: result.reasoningEffort,
    tGreenSec: finite(result.metrics?.tGreenSec),
    tClaimSec: finite(result.metrics?.tClaimSec),
    deterministicScore: finite(result.metrics?.deterministicScore),
    deterministicScoreMax: finite(result.metrics?.deterministicScoreMax),
    hiddenPassed: finite(result.metrics?.hiddenChecksPassed),
    hiddenTotal: finite(result.metrics?.hiddenChecksTotal),
    humanTouches: finite(result.metrics?.humanTouches),
    providerTokens: finite(result.metrics?.providerTokens),
    estimatedTokens: finite(result.metrics?.estimatedTokens),
  };
}

function comparePair(control, experiment) {
  if (!control || !experiment) return { status: "incomplete", reasons: ["Missing a passing medium control or Agent Deck run."] };
  const speedRatio = experiment.tGreenSec && control.tGreenSec ? experiment.tGreenSec / control.tGreenSec : null;
  const qualityDelta = experiment.deterministicScore != null && control.deterministicScore != null
    ? experiment.deterministicScore - control.deterministicScore : null;
  const tokenRatio = experiment.providerTokens && control.providerTokens ? experiment.providerTokens / control.providerTokens : null;
  const reasons = [];
  let status = "pass";
  if (qualityDelta != null && qualityDelta < -5) { status = "fail"; reasons.push(`Quality regressed by ${Math.abs(qualityDelta).toFixed(1)} points.`); }
  if (speedRatio != null && speedRatio > 1.35) { status = "fail"; reasons.push(`T_green is ${speedRatio.toFixed(3)}x control, above the 1.35x hard limit.`); }
  else if (speedRatio != null && speedRatio > 1.10 && status !== "fail") { status = "warn"; reasons.push(`T_green is ${speedRatio.toFixed(3)}x control, above the 1.10x target.`); }
  if (!reasons.length) reasons.push("Quality is preserved and T_green is within the 1.10x target.");
  return {
    status,
    reasons,
    speedRatio: speedRatio == null ? null : Number(speedRatio.toFixed(3)),
    speedDeltaPercent: speedRatio == null ? null : Number(((speedRatio - 1) * 100).toFixed(1)),
    qualityDelta,
    tokenRatio: tokenRatio == null ? null : Number(tokenRatio.toFixed(3)),
    humanTouchDelta: experiment.humanTouches != null && control.humanTouches != null ? experiment.humanTouches - control.humanTouches : null,
  };
}

function buildSummary(results, options = {}) {
  const caseIds = options.caseIds || ["S1", "S2", "S3"];
  const cases = caseIds.map((caseId) => {
    const control = compactRun(latestPassing(results, caseId, "direct_codex"));
    const experiment = compactRun(latestPassing(results, caseId, "agent_deck_adaptive"));
    return { caseId, difficulty: "simple", control, experiment, comparison: comparePair(control, experiment) };
  });
  const ratios = cases.map((entry) => entry.comparison.speedRatio).filter((value) => value > 0);
  const geometricMeanSpeedRatio = ratios.length ? Math.exp(ratios.reduce((sum, value) => sum + Math.log(value), 0) / ratios.length) : null;
  const gateStatus = cases.some((entry) => entry.comparison.status === "fail") ? "fail"
    : cases.some((entry) => entry.comparison.status === "incomplete") ? "incomplete"
      : cases.some((entry) => entry.comparison.status === "warn") ? "warn" : "pass";
  return {
    schemaVersion: "agent-deck-benchmark-summary/v1",
    generatedAt: new Date().toISOString(),
    gate: { status: gateStatus, hardSpeedLimit: 1.35, targetSpeedLimit: 1.10, maxQualityRegression: 5 },
    aggregate: {
      pairedCases: ratios.length,
      geometricMeanSpeedRatio: geometricMeanSpeedRatio == null ? null : Number(geometricMeanSpeedRatio.toFixed(3)),
    },
    cases,
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function formatSeconds(value) { return value == null ? "—" : `${value.toFixed(1)}s`; }
function formatRatio(value) { return value == null ? "—" : `${value.toFixed(3)}x`; }

function renderHtml(summary) {
  const rows = summary.cases.map((entry) => {
    const ratio = entry.comparison.speedRatio;
    const width = ratio == null ? 0 : Math.min(100, ratio / 1.35 * 100);
    return `<tr><td><strong>${escapeHtml(entry.caseId)}</strong><span>${escapeHtml(entry.difficulty)}</span></td><td>${formatSeconds(entry.control?.tGreenSec)}</td><td>${formatSeconds(entry.experiment?.tGreenSec)}</td><td><div class="ratio"><b>${formatRatio(ratio)}</b><i style="width:${width}%"></i></div></td><td>${entry.control?.hiddenPassed ?? "—"}/${entry.control?.hiddenTotal ?? "—"} → ${entry.experiment?.hiddenPassed ?? "—"}/${entry.experiment?.hiddenTotal ?? "—"}</td><td><em class="${entry.comparison.status}">${escapeHtml(entry.comparison.status)}</em></td></tr>`;
  }).join("");
  const data = JSON.stringify(summary).replaceAll("<", "\\u003c");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Agent Deck Benchmark</title><style>
:root{color-scheme:dark;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC",sans-serif;background:#0b0d10;color:#edf2f7}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% -20%,#17314c 0,transparent 38%),#0b0d10}main{max-width:1120px;margin:auto;padding:64px 28px 80px}header{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:34px}.eyebrow{color:#69b8ff;font-size:12px;font-weight:700;letter-spacing:.16em;text-transform:uppercase}h1{font-size:42px;letter-spacing:-.04em;margin:10px 0 8px}p{color:#8e9aa7;margin:0;line-height:1.6}.badge,em{border-radius:999px;padding:7px 11px;font-style:normal;font-weight:700;text-transform:uppercase;font-size:11px;letter-spacing:.08em}.badge.pass,em.pass{background:#143a2a;color:#6ee7a1}.badge.warn,em.warn{background:#432f12;color:#f5bd4f}.badge.fail,em.fail{background:#46201f;color:#ff8581}.badge.incomplete,em.incomplete{background:#2b3037;color:#a8b2bd}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin:28px 0}.card{background:rgba(20,25,31,.82);border:1px solid #29323b;border-radius:18px;padding:22px;backdrop-filter:blur(18px)}.card b{font-size:30px;display:block;margin-top:8px}.card span{font-size:12px;color:#87929e}section{background:rgba(15,19,24,.86);border:1px solid #252e37;border-radius:22px;overflow:hidden}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:18px;border-bottom:1px solid #222a32;font-size:14px}th{color:#7f8b97;font-size:11px;text-transform:uppercase;letter-spacing:.09em}td span{display:block;color:#6f7b87;font-size:11px;margin-top:4px}.ratio{min-width:130px}.ratio b{font-variant-numeric:tabular-nums}.ratio i{display:block;height:4px;background:#4da8ff;border-radius:4px;margin-top:8px;max-width:100%}footer{color:#697581;margin-top:22px;font-size:12px}@media(max-width:760px){header{display:block}.badge{display:inline-block;margin-top:18px}.stats{grid-template-columns:1fr}section{overflow-x:auto}h1{font-size:32px}}
</style></head><body><main><header><div><div class="eyebrow">Reproducible evaluation</div><h1>Agent Deck Benchmark</h1><p>同模型、同推理档、同 seed 与隐藏 grader。速度门槛与质量回归由本地脚本计算。</p></div><span class="badge ${summary.gate.status}">${escapeHtml(summary.gate.status)}</span></header><div class="stats"><div class="card"><span>配对用例</span><b>${summary.aggregate.pairedCases}</b></div><div class="card"><span>几何平均速度比</span><b>${formatRatio(summary.aggregate.geometricMeanSpeedRatio)}</b></div><div class="card"><span>硬门槛</span><b>≤ ${summary.gate.hardSpeedLimit.toFixed(2)}x</b></div></div><section><table><thead><tr><th>Case</th><th>Codex</th><th>Agent Deck</th><th>速度比</th><th>隐藏检查</th><th>Gate</th></tr></thead><tbody>${rows}</tbody></table></section><footer>Generated ${escapeHtml(summary.generatedAt)} · target ≤ ${summary.gate.targetSpeedLimit.toFixed(2)}x · quality regression ≤ ${summary.gate.maxQualityRegression} points</footer></main><script type="application/json" id="agent-deck-benchmark-data">${data}</script></body></html>`;
}

module.exports = { buildSummary, comparePair, latestPassing, loadResults, renderHtml };
