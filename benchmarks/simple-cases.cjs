const path = require("node:path");

const root = __dirname;

const cases = {
  S1: {
    id: "S1",
    title: "Retry-After parser bug",
    taskBrief: "Fix parseRetryAfter(value, nowMs) so it supports integer seconds and HTTP-date values, clamps past dates to zero, and returns null for malformed or negative values. Preserve the public API and add focused tests.",
  },
  S2: {
    id: "S2",
    title: "Safe deep redaction",
    taskBrief: "Implement redactSecrets(value) as a non-mutating deep redactor for objects and arrays. Match secret keys case-insensitively (token, password, apiKey, authorization), preserve non-secret values, and handle circular references without crashing.",
  },
  S3: {
    id: "S3",
    title: "Small CLI feature",
    taskBrief: "Add --json to the existing task-summary CLI. Default text output must remain byte-for-byte compatible. JSON output must use the documented stable schema and invalid flags must exit with code 2.",
  },
};

for (const item of Object.values(cases)) {
  item.seedDirectory = path.join(root, "cases", item.id.toLowerCase(), "seed");
  item.hiddenGrader = path.join(root, "cases", item.id.toLowerCase(), "hidden.test.mjs");
}

module.exports = { cases };

