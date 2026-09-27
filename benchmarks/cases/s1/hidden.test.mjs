import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const target = process.env.BENCH_TARGET;
if (!target) throw new Error("BENCH_TARGET must point to a completed S1 workspace");
const { parseRetryAfter } = await import(`${pathToFileURL(`${target}/src/retry-after.js`).href}?grader=${Date.now()}`);
const now = Date.parse("Wed, 21 Oct 2015 07:28:00 GMT");

test("accepts zero delta-seconds", () => assert.equal(parseRetryAfter("0", now), 0));
test("accepts surrounding optional whitespace", () => assert.equal(parseRetryAfter(" 12 ", now), 12_000));
test("rejects negative delta-seconds", () => assert.equal(parseRetryAfter("-1", now), null));
test("rejects decimal and partially numeric values", () => {
  assert.equal(parseRetryAfter("1.5", now), null);
  assert.equal(parseRetryAfter("12seconds", now), null);
});
test("clamps a past HTTP-date to zero", () => {
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:27:00 GMT", now), 0);
});
test("rejects invalid dates and unsupported inputs", () => {
  assert.equal(parseRetryAfter("not-a-date", now), null);
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter({}, now), null);
});
test("preserves the public module contract", () => {
  assert.equal(typeof parseRetryAfter, "function");
  assert.equal(parseRetryAfter.length, 1);
});

