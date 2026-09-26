const fs = require("node:fs");
const path = require("node:path");

const REPORT_CONTENT_TYPES = new Set(["report", "research", "analysis", "dashboard", "plan", "review"]);
const REPORT_QUALITY_MINIMUM = 78;

const HTML_REPORT_CONTRACT = `AGENT DECK HTML REPORT CONTRACT
Route the deliverable before writing it:
- Evidence collection tasks publish reusable JSON, CSV, TSV, images, or source notes in their native formats. Add HTML only when a human must read that task directly.
- Synthesis, research, analysis, plan, review, comparison, and dashboard tasks publish one self-contained .html file as the primary human-facing artifact. Markdown is secondary only when explicitly required.
- When calling agentdeck.publish_artifact for a human-facing result, set contentType to report, research, analysis, dashboard, plan, or review, and set dataRich truthfully.

Write like an editor, not a template engine:
- Match the reader's language. For Chinese reports, use natural Chinese headings and prose; do not mix in generic English UI labels.
- Lead with the decision or finding, then evidence, implication, and limitation. Use claim-led section titles instead of generic headings such as “Overview” or “Details”.
- The executive summary must contain 3–5 complete findings with implications, not repeated slogans or a wall of metric cards.
- Do not repeat the same sentence in the hero, summary cards, body, and conclusion. Use connective prose between visual sections so the report reads as one argument.
- Clearly separate sourced fact, interpretation, recommendation, and uncertainty. Cite or anchor every consequential claim.

Plan visuals from the evidence before styling:
- If the evidence contains comparable numeric values, dates, distributions, or categories, include at least two complementary analytical views when they materially improve understanding.
- Choose the form by question: trend→line or slope chart; ranking→horizontal bars; composition→stacked bars; distribution→histogram/box plot; two dimensions→scatter; categorical comparison→heatmap; chronology→timeline; dependencies→flow; non-numeric evidence→evidence matrix.
- Every chart needs a descriptive title, direct labels or legend, units, scale, source note, and a one-sentence takeaway. Keep the chart's values in the agent-deck-data JSON block.
- Never invent numbers to satisfy a chart requirement. When comparable numbers are unavailable, say so and use a qualitative matrix, annotated timeline, or relationship map.
- Tables support lookup and exact values; they must not replace the narrative or duplicate every chart.

Use a restrained editorial visual system:
- Build a clear reading column for prose and a wider analytical column for tables/figures. Use whitespace and typographic contrast before borders, gradients, pills, or card grids.
- Avoid “dashboard soup”: no wall of equal-weight cards, excessive badges, decorative gradients, giant title blocks, or repeated containers around every paragraph.
- Use CSS custom properties, system fonts, responsive grid, visible keyboard focus, accessible contrast, and print styles. Prefer clamp() for type and spacing.
- Use semantic header/main/nav/section/article/figure/table/footer elements. Inline SVG charts require title/desc and readable labels. Core content must remain readable without JavaScript.
- Do not load remote scripts, fonts, styles, or images. Embed a valid <script type="application/json" id="agent-deck-data"> block containing the report schema, key facts, chart datasets, sources, and limitations.

Before publishing, inspect the final page at desktop and narrow widths. Verify no clipping, overlapping, tiny chart labels, empty panels, raw JSON in the visible document, unsupported claims, or duplicated prose.

Verification fallback — do not turn an unavailable UI automation surface into a delivery blocker:
- Browser screenshots and pixel-level desktop checks are optional evidence, never the only acceptance path.
- If a browser, CUA surface, or local headless Chrome is unavailable, continue with the static HTML quality gate, DOM/semantic checks, responsive CSS inspection, and source-backed data checks.
- In the final result, state that visual verification was degraded, name the unavailable environment, and list the static checks that passed. Do not claim a screenshot was captured when it was not.

The Agent Deck quality gate rejects verified reports that miss essential structure, narrative, accessibility, or evidence requirements.`;

function count(source, pattern) {
  return [...String(source || "").matchAll(pattern)].length;
}

function visibleText(html) {
  return String(html || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractStructuredData(html) {
  const match = String(html || "").match(/<script\b[^>]*id=["']agent-deck-data["'][^>]*type=["']application\/json["'][^>]*>([\s\S]*?)<\/script\s*>/i)
    || String(html || "").match(/<script\b[^>]*type=["']application\/json["'][^>]*id=["']agent-deck-data["'][^>]*>([\s\S]*?)<\/script\s*>/i);
  if (!match) return { exists: false, valid: false };
  try { return { exists: true, valid: Boolean(JSON.parse(match[1].trim())) }; }
  catch { return { exists: true, valid: false }; }
}

function assessHtmlReport(html, { dataRich = false } = {}) {
  const source = String(html || "");
  const text = visibleText(source);
  const structured = extractStructuredData(source);
  const figures = count(source, /<figure\b/gi);
  const svgs = count(source, /<svg\b/gi);
  const tables = count(source, /<table\b/gi);
  const checks = [];
  const add = (label, points, pass, issue) => checks.push({ label, points, pass: Boolean(pass), issue });

  add("Document foundation", 6, /<!doctype html>/i.test(source) && /<html\b[^>]*lang=/i.test(source) && /<meta\b[^>]*name=["']viewport["']/i.test(source), "Add doctype, document language, and responsive viewport metadata.");
  add("Semantic hierarchy", 8, /<header\b/i.test(source) && /<main\b/i.test(source) && count(source, /<section\b/gi) >= 3 && /<footer\b/i.test(source), "Use header, main, at least three meaningful sections, and footer.");
  add("Navigable structure", 5, /<nav\b/i.test(source) && /href=["']#/i.test(source), "Add a concise in-page navigation for long reports.");
  add("Substantive narrative", 8, text.length >= 1400 && count(source, /<p\b/gi) >= 8, "Develop the evidence into connected prose; the visible report is too thin or fragmented.");
  add("Executive synthesis", 7, /(执行摘要|核心结论|关键发现|executive summary|key findings)/i.test(text), "Add a conclusion-first executive synthesis with implications.");
  add("Method and sources", 7, /(方法|口径|来源|证据|method|source|evidence)/i.test(text) && (/<a\b[^>]*href=/i.test(source) || tables > 0), "Explain method/evidence and make sources traceable.");
  add("Decision and limitations", 7, /(结论|建议|决策|下一步|conclusion|recommendation|next step)/i.test(text) && /(局限|限制|不确定|风险|limitation|uncertaint|risk)/i.test(text), "State the decision/implication and its limitations or uncertainty.");
  add("Editorial visual system", 8, /:root\s*\{[^}]*--/i.test(source) && /max-width\s*:/i.test(source) && /line-height\s*:/i.test(source) && /clamp\s*\(/i.test(source), "Use reusable tokens, a bounded reading column, readable line height, and fluid type/spacing.");
  add("Responsive and print", 6, /@media\s*\([^)]*max-width/i.test(source) && /@media\s+print/i.test(source), "Add narrow-screen and print layouts.");
  add("Accessible figures", 7, figures === 0 || (/<figure\b[\s\S]*?<figcaption\b/i.test(source) && (!svgs || /<svg\b[^>]*(role=["']img["']|aria-labelledby=)/i.test(source))), "Give every visual a figure caption; inline SVG charts need an accessible title/description.");
  add("Structured reusable data", 8, structured.exists && structured.valid, structured.exists ? "Fix invalid JSON in agent-deck-data." : "Embed valid machine-readable facts, chart data, sources, and limitations in agent-deck-data.");
  add("Evidence visualization", dataRich ? 12 : 5, dataRich ? (figures >= 2 || (figures >= 1 && tables >= 1)) : (figures + tables >= 1), dataRich ? "Add at least two complementary evidence-backed analytical views, or one view plus an exact-value table." : "Add a figure, comparison table, timeline, or evidence matrix when it improves comprehension.");
  add("Table semantics", 5, tables === 0 || (/<caption\b/i.test(source) && /<th\b[^>]*(scope=|>)/i.test(source)), "Tables need a caption and semantic headers.");
  add("Offline and script safe", 8, !/<script\b(?![^>]*type=["']application\/json["'])/i.test(source) && !/<(?:script|link|img)\b[^>]*(?:src|href)=["']https?:/i.test(source), "Remove executable scripts and remote runtime/style/image dependencies.");

  const total = checks.reduce((sum, item) => sum + item.points, 0);
  const earned = checks.filter((item) => item.pass).reduce((sum, item) => sum + item.points, 0);
  const score = Math.round(earned / total * 100);
  return {
    score,
    passing: score >= REPORT_QUALITY_MINIMUM && (!dataRich || figures >= 2),
    dataRich: Boolean(dataRich),
    figures,
    tables,
    visibleCharacters: text.length,
    issues: checks.filter((item) => !item.pass).map((item) => item.issue),
    checks: checks.map(({ label, points, pass }) => ({ label, points, pass })),
  };
}

function assessPublishedReport({ root, file, dataRich = false }) {
  const resolvedRoot = path.resolve(root);
  const candidate = path.isAbsolute(file) ? path.resolve(file) : path.resolve(resolvedRoot, file);
  const relative = path.relative(resolvedRoot, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error(`Report is outside the Worker worktree: ${file}`);
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) throw new Error(`Published HTML report does not exist: ${file}`);
  if (fs.statSync(candidate).size > 5 * 1024 * 1024) throw new Error(`Published HTML report exceeds the 5 MB preview limit: ${file}`);
  return { file, ...assessHtmlReport(fs.readFileSync(candidate, "utf8"), { dataRich }) };
}

function isReportContentType(value) {
  return REPORT_CONTENT_TYPES.has(String(value || "").toLowerCase());
}

module.exports = { HTML_REPORT_CONTRACT, REPORT_QUALITY_MINIMUM, assessHtmlReport, assessPublishedReport, isReportContentType };
