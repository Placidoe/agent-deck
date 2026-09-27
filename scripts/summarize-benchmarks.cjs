const fs = require("node:fs");
const path = require("node:path");
const { buildSummary, loadResults, renderHtml } = require("./benchmark-report.cjs");

const projectRoot = path.resolve(__dirname, "..");
const resultsDirectory = path.resolve(process.env.AGENT_DECK_EVAL_RESULTS || path.join(projectRoot, "../evals/results"));
const summary = buildSummary(loadResults(resultsDirectory));
fs.mkdirSync(resultsDirectory, { recursive: true });
const jsonPath = path.join(resultsDirectory, "benchmark-summary.json");
const htmlPath = path.join(resultsDirectory, "benchmark-summary.html");
fs.writeFileSync(jsonPath, `${JSON.stringify(summary, null, 2)}\n`);
fs.writeFileSync(htmlPath, renderHtml(summary));
process.stdout.write(`${JSON.stringify({ gate: summary.gate.status, aggregate: summary.aggregate, jsonPath, htmlPath }, null, 2)}\n`);
if (summary.gate.status === "fail") process.exitCode = 1;
