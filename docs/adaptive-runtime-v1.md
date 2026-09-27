# Agent Deck Adaptive Runtime v1

## Why this change exists

The S1 pilot exposed a control-plane failure rather than a model-quality failure. A bounded parser fix was forced through a Planner and four Workers. Implementation and tests ran in sibling worktrees, the test Worker could not see the implementation, and the user had to recover the mission manually. The result was slower, used more coordination tokens, and still missed one hidden case.

Adaptive Runtime v1 makes orchestration pay rent: Agent Deck now chooses the least expensive execution topology that can preserve quality.

## Execution paths

| Path | Selected when | Provider turns before work | Human gates | Isolation |
| --- | --- | ---: | ---: | --- |
| Direct | Bounded coherent code change; no proven parallel benefit | 0 Planner + 1 Worker | One result review | One real Git worktree |
| Coordinated Mission | Several independent deliverables or explicit decomposition | 1 Planner + up to 4 Workers | Plan review, result reviews, integration | Dependency-aware worktrees |
| Orchestrated Mission | Research, benchmark, architecture, migration, audit, or broad synthesis | 1 Planner + up to 8 tasks / 6 concurrent Workers | Same evidence-backed gates | Dependency-aware worktrees |

The creation dialog defaults to `Adaptive`. Users can explicitly force `Direct` or `Mission` when they know more than the classifier.

## Direct quality contract

Direct mode is not a low-quality shortcut. Its single Worker uses a balanced reasoning route and owns inspection, implementation, focused tests, and final diff review in one context. A compact behavior matrix covers valid, boundary, near-miss, type, normalization, and compatibility partitions without adding another model turn. Reports are not generated unless requested.

After the Worker returns structured evidence, one human acceptance commits the worktree and automatically creates the integration branch. There is no empty Planner node and no second integration confirmation.

## Mission safeguards

- The Planner receives a route-specific maximum task count and total token budget.
- Generated task budgets are scaled to the Mission budget.
- Focused test tasks are placed after implementation tasks.
- Final review, report, release, and integration tasks depend on all non-finalizer producers they evaluate.
- Plans that exceed the route's task limit are rejected instead of silently spawning excessive Workers.
- The persisted spec records route, reasons, score, worker/task caps, budget, and repaired dependency edges.

## Token and ROI accounting

The Value Ledger now separates Planner prompt tokens and Worker prompt tokens. Direct mode records zero Planner tokens. Context is not double-counted when it is already present in the recorded Worker prompt estimate. Provider-reported usage still takes precedence when available.

## How to verify the effect

1. Create a Mission such as “Fix the date parser and add boundary tests” with `Adaptive` selected.
2. The canvas should show one `Delivery Agent`, not a Main Agent plus a DAG.
3. Activity should include `mission.route.selected` and `mission.direct.started`, with no `planner.turn.started`.
4. The Worker turn should show performance route `direct-balanced` and reasoning effort `medium`.
5. After result review, one acceptance should move the Mission directly to `Completed` and record `mission.direct.auto_integrating`.
6. In Value & Cost, Planner tokens should be `0`; Worker prompt and provider usage remain traceable.
7. Create a research/benchmark request: it should still enter the human-reviewed Planner/DAG path.

## Guardrails and current boundary

The classifier is deterministic and local; it does not spend a model turn to decide whether to spend model turns. It is intentionally conservative around research and explicit decomposition. This version does not rewrite Codex or replace its model/runtime. It owns the control plane around replaceable providers: routing, context, isolation, review, evidence, cost, and integration.

## Verified implementation evidence

- The deterministic and integration suites pass 46/46 Mission tests, including strict output schemas, direct routing, dependency repair, budget enforcement, Worktree isolation, review gates, recovery, and event convergence.
- A real local Codex end-to-end smoke run completed in 95.6 seconds with zero Planner turns, one Worker thread, one task commit, and automatic integration after one human acceptance. This smoke verifies the control path; it is not presented as a replacement for the nine-case quality benchmark.
- Desktop QA passes both a clean profile and a copy of the existing 13-Mission ledger at 1540×960 and 1120×720, including conversation rendering, HTML preview, artifacts, attention, canvas dragging, focus mode, and typography persistence.
