# Deep redaction evaluation fixture

`redactSecrets(value)` must return a deep, non-mutating copy. Secret-key matching is case-insensitive for `token`, `password`, `apiKey`, and `authorization`. Circular and shared references must not crash or leak seeded secrets.
