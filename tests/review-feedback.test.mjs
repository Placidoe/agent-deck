import assert from "node:assert/strict";
import test from "node:test";
import { buildReviewFeedback, feedbackStarter, reviewContext, reviewItems, reviewRound, validateReviewFeedback } from "../shared/review-feedback.mjs";

const result = { summary: "实际交付", acceptance: [{ criterion: "结构完整", passed: true, evidence: "test" }, { criterion: "PR 已打开", passed: false, evidence: "未找到 PR 链接" }], blockers: ["先认领具体模型", "需要用户选定贡献目标"] };
const task = { id: "t", missionId: "m", key: "T", status: "review", updatedAt: "round-1", result, description: "寻找可复现的贡献机会", dependencies: ["PRE"] };
const mission = { id: "m", status: "review", outcome: "做开源贡献", tasks: [{ id: "pre", key: "PRE", status: "completed", result: { summary: "前置结论" } }, { id: "unrelated", key: "OTHER", result: { summary: "不相关的私人记录" } }], artifacts: [{ id: "a", taskId: "pre", title: "前置资料", files: ["evidence.html"] }, { id: "b", taskId: "unrelated", title: "无关产物" }] };
const input = { round: reviewRound(task), entries: [{ id: "blocker-0", feedback: "先比较候选模型，暂不要发评论。" }] };

test("review items retain separate identity, evidence and exact source locations", () => {
  const items = reviewItems(result);
  assert.deepEqual(items.map(item => item.id), ["check-1", "blocker-0", "blocker-1"]);
  assert.equal(items[0].evidence, "未找到 PR 链接");
  assert.equal(items[1].evidence, "");
  assert.match(items[0].location, /第 2 项/);
  assert.equal(reviewItems({}).at(0).kind, "missing");
  assert.deepEqual(reviewItems({ acceptance: [{ passed: true }], blockers: [null, ""] }), []);
});

test("host binds opinions to the exact result round, rejects forged IDs and limits input", () => {
  assert.equal(validateReviewFeedback(mission, task, input)[0].title, "先认领具体模型");
  for (const patch of [{ status: "running" }, { activeTurnId: "turn" }, { missionId: "other" }, { updatedAt: "round-2" }, { result: { ...result, blockers: ["新问题"] } }]) assert.throws(() => validateReviewFeedback(mission, { ...task, ...patch }, input));
  assert.throws(() => validateReviewFeedback({ ...mission, status: "canceled" }, task, input));
  assert.throws(() => validateReviewFeedback({ ...mission, interactionMode: "autonomous" }, task, input));
  for (const entries of [[], [{ id: "invented", feedback: "yes" }], [input.entries[0], input.entries[0]], [{ id: "blocker-0", feedback: " " }], [{ id: "blocker-0", feedback: "x".repeat(4001) }]]) assert.throws(() => validateReviewFeedback(mission, task, { ...input, entries }));
  const ready = { ...task, result: { acceptance: [{ passed: true }], blockers: [] } };
  assert.equal(validateReviewFeedback(mission, ready, { round: reviewRound(ready), entries: [{ id: "general", feedback: "补充图表" }] })[0].id, "general");
});

test("one message carries shared context once and distinguishes unanswered items", () => {
  const entries = validateReviewFeedback(mission, task, input);
  const text = buildReviewFeedback(mission, task, entries);
  assert.match(text, /先比较候选模型/);
  assert.match(text, /UNANSWERED ITEMS/);
  assert.match(text, /check-1/);
  assert.match(text, /blocker-1/);
  assert.equal(text.split("前置结论").length - 1, 1);
  assert.equal(text.includes("不相关的私人记录"), false);
  assert.equal(text.includes("无关产物"), false);
  assert.match(text, /不代表同意、放弃或解决/);
  assert.match(text, /不是授权/);
  assert.equal(reviewContext(mission, task).artifacts.length, 1);
  assert.match(feedbackStarter(reviewItems(result)[1]), /我的决定或补充：/);
});

test("large context uses bounded excerpts, never a full transcript or event ledger", () => {
  const huge = "x".repeat(100000);
  const context = reviewContext({ ...mission, outcome: huge, messages: [huge], events: [huge], tasks: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, key: `P${i}`, status: "completed", result: { summary: huge } })), artifacts: Array.from({ length: 20 }, (_, i) => ({ id: `a${i}`, taskId: "t", title: huge, files: Array(20).fill(huge) })) }, { ...task, description: huge, result: { summary: huge }, acceptanceCriteria: Array(30).fill(huge), dependencies: Array.from({ length: 20 }, (_, i) => `P${i}`) });
  assert.ok(JSON.stringify(context).length < 12000);
  assert.equal(context.messages, undefined);
  assert.equal(context.events, undefined);
});
