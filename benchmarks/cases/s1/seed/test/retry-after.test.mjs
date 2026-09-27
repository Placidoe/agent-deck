import assert from "node:assert/strict";
import test from "node:test";
import { parseRetryAfter } from "../src/retry-after.js";

test("parses integer delta-seconds", () => {
  assert.equal(parseRetryAfter("15", 1_700_000_000_000), 15_000);
});

test("parses an HTTP-date relative to now", () => {
  const now = Date.parse("Wed, 21 Oct 2015 07:27:00 GMT");
  assert.equal(parseRetryAfter("Wed, 21 Oct 2015 07:28:00 GMT", now), 60_000);
});

test("rejects an obviously malformed value", () => {
  assert.equal(parseRetryAfter("later", 1_700_000_000_000), null);
});
