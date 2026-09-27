import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";

const target = process.env.BENCH_TARGET;
if (!target) throw new Error("BENCH_TARGET must point to a completed S2 workspace");
const { redactSecrets } = await import(`${pathToFileURL(`${target}/src/redact-secrets.js`).href}?grader=${Date.now()}`);

test("redacts nested objects and arrays case-insensitively", () => {
  const input = { account: { PassWord: "p", rows: [{ APIKEY: "k" }, { Authorization: "a" }] } };
  assert.deepEqual(redactSecrets(input), { account: { PassWord: "[REDACTED]", rows: [{ APIKEY: "[REDACTED]" }, { Authorization: "[REDACTED]" }] } });
});

test("does not mutate the input", () => {
  const input = { nested: { token: "secret", safe: 1 } };
  const result = redactSecrets(input);
  assert.notEqual(result, input);
  assert.notEqual(result.nested, input.nested);
  assert.equal(input.nested.token, "secret");
});

test("preserves circular and shared-reference topology", () => {
  const shared = { token: "secret", safe: true };
  const input = { first: shared, second: shared };
  input.self = input;
  const result = redactSecrets(input);
  assert.equal(result.self, result);
  assert.equal(result.first, result.second);
  assert.equal(result.first.token, "[REDACTED]");
  assert.equal(input.first.token, "secret");
});

test("does not invoke secret getters", () => {
  let invoked = 0;
  const input = {};
  Object.defineProperty(input, "password", { enumerable: true, get() { invoked += 1; return "secret"; } });
  const result = redactSecrets(input);
  assert.equal(invoked, 0);
  assert.equal(result.password, "[REDACTED]");
});

test("preserves safe primitives and null", () => {
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(7), 7);
  assert.equal(redactSecrets("safe"), "safe");
});

test("keeps the exported API stable", () => {
  assert.equal(typeof redactSecrets, "function");
  assert.equal(redactSecrets.length, 1);
});

