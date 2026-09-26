# S1 pilot result: direct Codex vs. Agent Deck

## Outcome

The evaluation harness is working and has already found a product-significant discrepancy. Direct Codex completed S1 correctly. Agent Deck completed its internal workflow and passed its visible tests, but failed one hidden edge case after integration.

| Metric | Direct Codex | Agent Deck |
|---|---:|---:|
| Model | `gpt-5.6-terra` | `gpt-5.6-terra` |
| Final quality score | **100/100** | **83/100** |
| Public tests | 5/5 | 5/5 |
| Hidden tests | **7/7** | **6/7** |
| Completion / claim time | **69.19 s** | **1,315.6 s** |
| Verified green time | **~69.3 s** | **Not reached** |
| Human touches after submit | 0 | 9 |
| Rework turns | 0 | 1 |
| Effective workers | 1 | 4 |
| Observed tool operations | 6 | 35 |
| Provider-reported tokens | 147,975 | unavailable in current Mission telemetry |

## Hidden failure

Agent Deck's implementation validates integer delta-seconds with `^\\d+$`, then sends every remaining string to `Date.parse`. JavaScript accepts some decimal or partially numeric strings as dates, so an input such as `"1.5"` returns `0` after clamping instead of `null`.

This violates the requested contract: only integer delta-seconds and valid HTTP-date values are supported; malformed inputs must return `null`.

## Orchestration diagnosis

The simple change was split into four workers:

1. repository discovery;
2. parser implementation;
3. focused tests;
4. verification and HTML report.

The implementation and test workers ran in parallel after discovery. The test worker could not see the implementation worker's branch, reported failing tests, and blocked acceptance. Recovery required a user message, approval to cherry-pick the implementation commit, another test run, two more result reviews, and manual integration.

The pilot therefore reveals three separate product issues:

- **Over-decomposition:** planning and review overhead dominates a one-file bug fix.
- **Incorrect dependency semantics:** tasks that must validate together were modeled as independent siblings.
- **Insufficient independent verification:** the final verifier repeated the visible test suite and declared success without testing the input grammar boundary.

## Evidence

- Direct run log: `../evals/results/s1-control.jsonl`
- Direct timing: `../evals/results/s1-control.time`
- Agent Deck integration: `~/Library/Application Support/agent-deck-demo/worktrees/1fc2d31b-842/integration`
- Hidden grader: `../evals/graders/s1-hidden.test.mjs`
- Mission: `1fc2d31b-842b-45e8-b791-9359de518d46`

## Calibration decision

The remaining benchmark should continue, but S2 and S3 should keep this behavior as part of the treatment rather than manually bypassing it. Medium and complex cases will show whether coordination gains eventually outweigh the measured planning, approval, merge, and verification costs.
