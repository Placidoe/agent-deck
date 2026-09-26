# Agent Deck vs. direct Codex quick evaluation

## Decision this eval answers

Does Agent Deck improve verified outcome quality, completion time, human attention, and token efficiency compared with starting one ordinary Codex conversation?

This is a product-level A/B test, not a pure model benchmark. The control uses one normal Codex task. The treatment uses one Agent Deck Mission, including its planner, Worker routing, shared context, review gates, and artifact workflow.

## Fair-run contract

1. Start every run from the same immutable seed commit in a fresh Git worktree.
2. Give both groups the exact same task text, source files, network access, and permission mode.
3. Use `gpt-5.6-terra` in both groups. For the quick product test, keep each product's normal reasoning defaults and record the observed effort. If a result is within 10%, rerun that case with equal effort.
4. Do not reuse conversations or Mission context between cases.
5. Do not reveal hidden checks before completion. Run them only after the agent says the work is complete.
6. Start the timer when the request is submitted. Stop the quality timer only when all acceptance checks pass, not when the agent first claims completion.
7. Record failed attempts, retries, approvals, user messages, planner time, worker time, and integration/review time separately.
8. Run A then B for half the cases and B then A for the other half to reduce warm-cache and service-load bias.

The current local Codex default is `gpt-5.6-terra` with high reasoning. Agent Deck may route individual Mission phases at a lower effort for performance; that routing is part of the treatment and must be recorded rather than hidden.

## Metrics

### Quality: 100 points

| Dimension | Weight | How to score |
|---|---:|---|
| Hidden acceptance checks | 45 | Percentage of deterministic hidden checks passed |
| Stated requirements | 20 | Five case-specific criteria, 4 points each |
| No regressions | 15 | Existing test/build/lint results |
| Implementation quality | 10 | Scope discipline, maintainability, error handling |
| Evidence and handoff | 10 | Accurate summary, changed files, commands and limitations |

A run that does not build or fails a critical safety requirement is capped at 59, regardless of prose quality.

### Speed, attention, and cost

| Metric | Definition |
|---|---|
| `T_ack` | Submit → first visible acknowledgement or status |
| `T_effect` | Submit → first meaningful tool action or repository change |
| `T_claim` | Submit → agent claims completion |
| `T_green` | Submit → independent grader passes |
| Human touches | Number of messages, approvals, retries, or unblock actions |
| Human active minutes | Time spent reading, steering, approving, or repairing |
| Tokens | Provider-reported total when available; otherwise label the local estimate |
| Tool calls | Commands, file operations, searches, and browser/tool actions |
| Rework | Additional turns after the first claimed completion |

Never mix provider-reported tokens and local estimates in the same aggregate without labeling them.

## Nine cases

### Simple — expected to favor direct Codex

| ID | Case | Exact task brief | Deterministic acceptance |
|---|---|---|---|
| S1 | Retry-After parser bug | Fix `parseRetryAfter(value, nowMs)` so it supports integer seconds and HTTP-date values, clamps past dates to zero, and returns `null` for malformed or negative values. Preserve the public API and add focused tests. | Public and hidden edge-case tests pass; no unrelated files change. |
| S2 | Safe deep redaction | Implement `redactSecrets(value)` as a non-mutating deep redactor for objects and arrays. Match secret keys case-insensitively (`token`, `password`, `apiKey`, `authorization`), preserve non-secret values, and handle circular references without crashing. | Input remains unchanged; nested/array/cycle tests pass; output contains no seeded secret. |
| S3 | Small CLI feature | Add `--json` to the existing `task-summary` CLI. Default text output must remain byte-for-byte compatible. JSON output must use the documented stable schema and invalid flags must exit with code 2. | Snapshot, schema, compatibility and exit-code tests pass. |

### Medium — one coherent implementation with several edge cases

| ID | Case | Exact task brief | Deterministic acceptance |
|---|---|---|---|
| M1 | Concurrent job runner | Implement the provided async job runner with a configurable concurrency limit, input-order results, per-job timeout, and `AbortSignal` support. An abort must stop starting new jobs while allowing already-running jobs to settle. | Concurrency never exceeds the limit; ordering, timeout, partial completion and abort tests pass. |
| M2 | Persistent queue recovery | Complete the file-backed queue. Enqueue must support idempotency keys; writes must be atomic; after restart, `running` items return to `queued`; corrupt state must produce a clear recoverable error without deleting the original file. | Restart, duplicate, crash-during-write, corruption and recovery tests pass. |
| M3 | Evidence-backed architecture decision | Read the supplied local source corpus and produce a self-contained HTML recommendation comparing three queue architectures. Every material claim must cite a source ID, the recommendation must state trade-offs, and an embedded `application/json` block must contain the decision matrix. Do not use external facts. | Citation coverage, factual consistency, required sections, HTML semantics and embedded-data schema checks pass. |

### Complex — deliberately decomposable and integration-heavy

| ID | Case | Exact task brief | Deterministic acceptance |
|---|---|---|---|
| C1 | Event-sourced workflow engine | Finish a dependency-aware workflow engine spanning storage, scheduler and API modules. It must reject cycles, make command handling idempotent, recover after process restart, emit an auditable event sequence, and never run a task before all dependencies succeed. Preserve existing API compatibility. | State-machine, cycle, idempotency, restart, concurrency and compatibility suites pass. |
| C2 | Incident inbox vertical slice | Deliver the provided incident-inbox vertical slice: persisted incidents, filter/search API, acknowledge/resolve transitions, live update stream, keyboard-accessible UI, and audit history. Include migration and rollback handling and keep existing routes compatible. | Backend contract, migration, stream, accessibility, UI behavior and regression tests pass. |
| C3 | Research-to-decision package | From the supplied mixed local corpus, produce an evidence ledger, normalized CSV, and a polished self-contained HTML decision report. Reconcile contradictions, distinguish facts from inference, include at least three useful inline charts, expose machine-readable data, and document limitations. | Extraction accuracy, provenance, contradiction handling, CSV schema, HTML quality, chart/data consistency and offline-open tests pass. |

## Why these cases are balanced

- S1–S3 are intentionally too small to justify planning and delegation overhead. If Agent Deck wins only on complex cases, that is a healthy product result.
- M1–M3 test coordination without requiring a large codebase.
- C1–C3 test the product's claimed advantages: decomposition, parallel execution, durable context, evidence, review and artifact synthesis.
- Six cases are software delivery and three include research/document work, matching Agent Deck's current product scope.

## Quick execution sequence

1. Run one pilot pair on S1 to verify logging and grading.
2. Run all 18 sessions once, alternating order: S1 A→B, S2 B→A, and so on.
3. Grade from repository state and artifacts, not from the agents' self-reports.
4. Rerun only failed, interrupted, or within-10% cases twice more.
5. Report medians by difficulty. Do not average simple and complex cases into one headline score.

`A` is direct Codex and `B` is Agent Deck.

## Product win criteria

| Difficulty | Minimum useful outcome |
|---|---|
| Simple | Quality within 5 points of Codex and `T_green` no worse than 1.35× |
| Medium | At least 5 quality points better, 15% faster, or 25% fewer human-active minutes |
| Complex | At least 10 quality points better, 25% faster, or 40% fewer human-active minutes, without materially higher failure rate |

The primary product claim should be accepted only if Agent Deck wins at least two of the three complex cases and does not catastrophically regress the simple tier.

## Result interpretation

- Higher `T_ack` but lower `T_green` means the UI feels slow even if execution is efficient; optimize optimistic status rendering.
- Lower `T_claim` but high rework means the system is declaring success too early; strengthen review gates.
- Higher tokens with higher complex-task quality may be acceptable; report quality per 10k tokens and confirmed value per 10k tokens.
- More Workers with no wall-clock improvement indicates over-decomposition or merge/review overhead.
- Better quality but more human touches indicates orchestration is helping the model but not yet helping the user.

## Evidence note

Official OpenAI guidance frames evaluations as: define the task and criteria, run representative inputs, then analyze results and iterate. It also reports token usage separately from testing-criteria results. For long-running Codex work, repository state, tool feedback, tests, and durable project memory are core parts of the agent loop. This protocol keeps those signals visible instead of grading final prose alone.
