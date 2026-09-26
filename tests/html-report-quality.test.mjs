import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import quality from "../desktop/html-report-quality.cjs";

const { REPORT_QUALITY_MINIMUM, assessHtmlReport, assessPublishedReport } = quality;

const polished = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>证据报告</title><style>:root{--ink:#17202a;--paper:#f7f5f0}body{max-width:1180px;margin:auto;line-height:1.7;font-size:clamp(15px,2vw,18px)}main{display:grid;gap:clamp(20px,4vw,48px)}figure{max-width:900px}@media(max-width:720px){main{display:block}}@media print{nav{display:none}}</style><script type="application/json" id="agent-deck-data">{"facts":[1,2,3],"charts":[{"values":[1,2,3]}],"sources":["S1"]}</script></head><body><header><h1>证据告诉我们应该先解决可靠性</h1></header><nav><a href="#summary">摘要</a></nav><main><section id="summary"><h2>核心结论与执行摘要</h2>${"<p>这是基于真实证据形成的完整判断，说明事实、影响与下一步行动，并避免把推断当作测量结果。</p>".repeat(5)}</section><section><h2>方法、来源与证据</h2>${"<p>比较口径保持一致，来源可以追溯，关键数字均附带单位、范围与数据限制。</p>".repeat(4)}<a href="#sources">来源 S1</a></section><section><h2>数据表明差距集中在两个阶段</h2><figure><svg role="img" aria-labelledby="c1"><title id="c1">阶段差距</title><desc>三个阶段的比较</desc></svg><figcaption>图 1：阶段差距。来源：S1。</figcaption></figure><figure><svg role="img" aria-labelledby="c2"><title id="c2">变化趋势</title><desc>三个时期的趋势</desc></svg><figcaption>图 2：变化趋势。来源：S1。</figcaption></figure><table><caption>精确值</caption><thead><tr><th scope="col">阶段</th><th scope="col">数值</th></tr></thead><tbody><tr><td>A</td><td>1</td></tr></tbody></table></section><section><h2>建议、风险与下一步</h2>${"<p>建议先验证高影响假设，同时保留不确定性与局限，避免超出证据边界。</p>".repeat(4)}</section></main><footer id="sources">结论与局限均已记录。</footer></body></html>`;

test("data-rich editorial reports pass the reusable HTML quality contract", () => {
  const result = assessHtmlReport(polished, { dataRich: true });
  assert.ok(result.score >= REPORT_QUALITY_MINIMUM, JSON.stringify(result.issues));
  assert.equal(result.figures, 2);
  assert.equal(result.tables, 1);
});

test("thin card-like HTML cannot be marked as a verified report", () => {
  const result = assessHtmlReport("<html><body><div class='card'><h1>Report</h1><p>Done.</p></div></body></html>", { dataRich: true });
  assert.ok(result.score < REPORT_QUALITY_MINIMUM);
  assert.ok(result.issues.some((item) => /analytical views/i.test(item)));
  assert.ok(result.issues.some((item) => /connected prose/i.test(item)));
});

test("data-rich reports require two real figure surfaces even when a table exists", () => {
  const oneFigure = polished.replace(/<figure><svg role="img" aria-labelledby="c2">[\s\S]*?<\/figure>/, "");
  const result = assessHtmlReport(oneFigure, { dataRich: true });
  assert.equal(result.figures, 1);
  assert.equal(result.passing, false);
});

test("published report assessment stays inside the worker worktree", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-html-"));
  fs.writeFileSync(path.join(root, "report.html"), polished);
  assert.ok(assessPublishedReport({ root, file: "report.html", dataRich: true }).passing);
  assert.throws(() => assessPublishedReport({ root, file: "../outside.html" }), /outside/);
});
