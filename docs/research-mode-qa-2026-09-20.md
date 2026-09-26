# Research/document execution mode — acceptance record

## Implemented

- Explicit `code` / `research` choice at requirement and Mission creation; persisted in SQLite with legacy records defaulting to code.
- Research sources can be ordinary folders. Output version repositories are created only under application-managed storage; source folders are not initialized, imported, or committed.
- Existing Git worktree isolation, dependency integration, evidence, HTML artifact preview and human review gates remain in use internally.
- Unstarted blocked Missions can switch modes through native confirmation, preserving the plan and returning to approval. No automatic dispatch on switching.
- Planner execution paths and session references use the managed output root in research mode.

## Verification

- Mission core: 41 tests passed, including actual local Git/filesystem research lifecycle with a stub provider, dependency files, artifact preview, review gates, persistence, legacy recovery, unchanged source contents, and ownership/path checks.
- Navigation/next-action/Sites: 16 tests passed.
- Production build and unsigned macOS arm64 application packaging passed.
- Isolated desktop QA uses a backup of the real ledger and no connected provider. At 1540×960, confirmed new work mode selector and legacy blocker recovery entry. At 1120×720, selected research mode and checked form layout, helper text and footer visibility.
- Verified packaged backend sources and frontend index match the working build.

## Limits and handoff

- No live model task was started during verification. Real provider execution, source-read permissions and model adherence still require a user-approved smoke run.
- Research mode is not Git-free internally; the application manages Git for output isolation and versions. Concurrent edits can still produce an actual dependency merge conflict handled by the existing recovery flow.
- The user-selected source path is reference-only by execution policy; provider sandbox and explicit permission approvals remain applicable. Do not claim this is a new OS-level read-only filesystem mount.
- Existing user Missions were not modified or resumed; the currently running old app was not replaced.
- New app: `release-research/mac-arm64/Agent Deck.app` (unsigned local test build).

To recover an eligible blocked research task in the new app: open execution details → 改为调研与文档 → confirm → review plan → 批准并运行.
