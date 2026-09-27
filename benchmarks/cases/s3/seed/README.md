# task-summary CLI evaluation fixture

Usage: `node bin/task-summary.js fixtures/tasks.json`.

The existing text format is exactly:

```text
Tasks: 3
Completed: 1
Pending: 2
```

`--json` must emit one JSON object with this stable schema:

```json
{"version":1,"total":3,"completed":1,"pending":2,"tasks":[{"id":"T1","status":"completed"}]}
```

The `tasks` array preserves input order and contains only `id` and `status`. Unknown flags print a concise error to stderr and exit with code `2`.
