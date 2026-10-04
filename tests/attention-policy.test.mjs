import assert from "node:assert/strict";
import test from "node:test";
import { attentionAdjustment, rankAttention } from "../src/attentionPolicy.js";

const blocked = { id: "blocked", type: "worker_blocked", priority: 80, updatedAt: "2026-09-18T00:00:00.000Z" };
const review = { id: "review", type: "worker_review", priority: 76, updatedAt: "2026-09-18T00:01:00.000Z" };

test("attention profiles change ranking deterministically without changing mission state", () => {
  assert.equal(rankAttention([blocked, review], "flow")[0].id, "blocked");
  assert.equal(rankAttention([blocked, review], "delivery")[0].id, "review");
  assert.equal(rankAttention([blocked, review], "risk")[0].id, "blocked");
  const adjustment = attentionAdjustment(blocked, "value");
  assert.ok(adjustment.boost > 0);
  assert.deepEqual(adjustment, attentionAdjustment(blocked, "flow"), "retired preferences fall back to flow");
  assert.equal(blocked.priority, 80, "ranking must not mutate durable operational priority");
});
