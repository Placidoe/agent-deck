# Agent Deck Mission Workspace · Design QA

- Source visual truth: [`reference-agent-graph.png`](reference-agent-graph.png)
- Rendered implementation: [`implementation-mission-workspace.png`](implementation-mission-workspace.png)
- Source pixels: 1488 × 1058
- Implementation pixels: 1488 × 1058
- CSS viewport: 1488 × 1058
- Device scale factor: 1
- State: Mission running; Claude worker selected; latest human steering message visible
- Density normalization: none required; source and implementation are equal pixel dimensions

**Full-view comparison evidence**

- The implementation preserves the source's dark macOS control-room frame, compact utility rail, central graph canvas, right inspector, semantic green/blue/amber agent states, dotted graph background, and persistent bottom activity surface.
- The implementation intentionally replaces the source's terminal strip with a task board and observable message bus because those are the requested Mission-orchestration controls.
- All persistent controls remain visible. Browser measurements report `scrollWidth === clientWidth` and `scrollHeight === clientHeight`.

**Focused region comparison evidence**

- Left task board: task titles, phase, owner, progress, blocked state, and selection remain readable at the reference density.
- Center graph: Main Agent hierarchy, worker states, dependencies, published contract edge, and Reviewer downstream placement remain visually legible.
- Bottom message bus: sender, receiver, topic, payload, delivery state, and current selection form a clear scan path.
- Right inspector: selected worker, execution evidence, latest communication, shared Artifact, and steering composer preserve the source hierarchy.

**Findings**

- No remaining P0, P1, or P2 findings.
- [P3] At narrow desktop widths, edge labels in the graph may become visually dense around the center worker row.
  - Location: Agent Graph / React Flow edges.
  - Evidence: five Main Agent edges converge above the worker row.
  - Impact: minor scanning cost; task selection and graph interaction remain usable.
  - Follow-up: collapse labels below 1280px or show the label on hover.

**Required fidelity surfaces**

- Fonts and typography: SF/Inter system stack, optical weight, larger task titles, message copy, inspector metadata, truncation, and line height checked. The earlier undersized bus and inspector text was increased.
- Spacing and layout rhythm: rail, 282px task board, central canvas, 326px inspector, 230px bus, borders, padding, and radii checked against the reference composition.
- Colors and visual tokens: neutral graphite surfaces plus semantic green, blue, amber, purple, and muted states are consistent and sufficiently contrasted.
- Image quality and assets: the screen contains no raster imagery requiring recreation. UI symbols use the existing Phosphor icon library; topology uses React Flow rather than handcrafted drawing assets.
- Copy and content: Mission, task, Agent, evidence, Artifact, delivery state, and orchestration wording match the requested workflow and avoid presenting mock execution as a real backend.

**Comparison history**

1. First browser capture found a P2 readability issue: task metadata, message topics, message body, and inspector evidence were smaller than the intended product hierarchy.
2. Increased task titles and metadata, graph node labels, bus sender/topic/body text, and inspector evidence/message text.
3. Recaptured at the source's exact 1488 × 1058 dimensions. No actionable P0/P1/P2 difference remains.

**Interactions verified**

- Switch Agent Graph, Tasks, Message Bus, and Requirement tabs.
- Select a task and its owning Agent.
- Send a steering message and observe it on the bus and in the inspector.
- Switch between Mission orchestration and real Sessions surfaces.
- Create a new Mission, generate its requirement form, and approve/dispatch the plan.
- Pause/resume worker control is wired.
- Console errors: none.
- Failed HTTP responses: none.

**Implementation checklist**

- [x] Requirement form and approval state.
- [x] Task queue grouped by running, blocked, and ready.
- [x] Main/worker/reviewer topology.
- [x] Observable message bus and delivery states.
- [x] Agent progress and execution evidence inspector.
- [x] Existing Sessions/Codex/voice surface retained.
- [x] Same-size browser capture and interaction verification.

**Follow-up polish**

- Show graph edge labels on hover below 1280px.
- Add reduced-motion handling for animated dependency edges.

final result: passed
