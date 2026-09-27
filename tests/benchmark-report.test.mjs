import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { buildSummary, comparePair, latestPassing, renderHtml } = require("../scripts/benchmark-report.cjs");

function run(caseId, group, tGreenSec, score = 80, startedAt = "2026-09-27T00:00:00Z") {
  return { schemaVersion: "agent-deck-eval/v1", caseId, group, reasoningEffort: "medium", status: "passed", startedAt, metrics: { tGreenSec, tClaimSec: tGreenSec - 2, deterministicScore: score, deterministicScoreMax: 80, hiddenChecksPassed: 5, hiddenChecksTotal: 5, humanTouches: group === "direct_codex" ? 0 : 1 } };
}

test("selects the latest passing run at the requested effort", () => {
  const older = run("S1", "direct_codex", 100, 80, "2026-09-26T00:00:00Z");
  const newer = run("S1", "direct_codex", 90, 80, "2026-09-27T00:00:00Z");
  const failed = { ...run("S1", "direct_codex", 1, 80, "2026-09-28T00:00:00Z"), status: "failed" };
  assert.equal(latestPassing([older, failed, newer], "S1", "direct_codex"), newer);
});

test("marks target misses as warnings and hard regressions as failures", () => {
  assert.equal(comparePair({ tGreenSec: 100, deterministicScore: 80, humanTouches: 0 }, { tGreenSec: 111, deterministicScore: 80, humanTouches: 1 }).status, "warn");
  assert.equal(comparePair({ tGreenSec: 100, deterministicScore: 80, humanTouches: 0 }, { tGreenSec: 136, deterministicScore: 80, humanTouches: 1 }).status, "fail");
  assert.equal(comparePair({ tGreenSec: 100, deterministicScore: 80, humanTouches: 0 }, { tGreenSec: 90, deterministicScore: 74, humanTouches: 1 }).status, "fail");
});

test("builds a machine summary and a self-contained HTML report", () => {
  const results = [run("S1", "direct_codex", 100), run("S1", "agent_deck_adaptive", 95)];
  const summary = buildSummary(results, { caseIds: ["S1"] });
  assert.equal(summary.gate.status, "pass");
  assert.equal(summary.aggregate.geometricMeanSpeedRatio, 0.95);
  const html = renderHtml(summary);
  assert.match(html, /<!doctype html>/);
  assert.match(html, /application\/json/);
  assert.match(html, /0\.950x/);
});
