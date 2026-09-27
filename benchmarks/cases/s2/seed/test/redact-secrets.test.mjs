import assert from "node:assert/strict";
import test from "node:test";
import { redactSecrets } from "../src/redact-secrets.js";

test("redacts a top-level token", () => {
  assert.deepEqual(redactSecrets({ token: "secret", name: "Ada" }), { token: "[REDACTED]", name: "Ada" });
});

test("preserves primitive values", () => {
  assert.equal(redactSecrets("hello"), "hello");
  assert.equal(redactSecrets(null), null);
});
