# Review performance hotfix

This change is shipped as a V0.3.0 hotfix and is intentionally outside the V0.3 feature scope.

## User-visible behavior

- Selecting a task in `Review` opens the structured **Result** panel immediately.
- Codex conversation history loads only after the user opens **Conversation**.
- Recent conversations are cached per thread and refreshed only when relevant provider output changes.
- Long results and messages are collapsed by default and can be expanded explicitly.

## Performance controls

- Project at most the latest 24 Codex turns and 48 visible conversation entries.
- Skip synchronous JSON parsing for responses larger than 512,000 characters.
- Use browser content virtualization for off-screen conversation cards.
- Coalesce live mission update bursts to at most one SQLite snapshot refresh per 250 ms.
- Memoize mission event projections and DAG nodes where possible.

## Regression gates

- `npm run test:performance` verifies bounded conversation projection.
- Desktop QA uses a long Review result and requires the Result panel to appear within 500 ms.
- Measured on the packaged Electron build: **48 ms** from task click to visible Result panel.
- Desktop QA also passes at 1540×960 and 1120×720 without horizontal overflow or panel overlap.
