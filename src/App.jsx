import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  AppWindow, Archive, ArrowsClockwise, BellRinging, CirclesFour, Check, Clock, Command, Cpu,
  ClipboardText, FileCode, FolderOpen, GitBranch, Graph, GridFour, MagnifyingGlass,
  Microphone, MicrophoneSlash, PaperPlaneTilt, Pause, Play, Plus, Pulse, Rows,
  SidebarSimple, SlidersHorizontal, SpeakerHigh, Stop, TerminalWindow, Warning, X,
} from "@phosphor-icons/react";
import { ProductNavigation, WorkNavigation } from "./ProductNavigation.jsx";
import { ResultsHub } from "./ResultsHub.jsx";
import { createBrowserVoiceController } from "./realtime-voice.js";
import { ApprovalActionPanel } from "./ApprovalActionPanel.jsx";
import { RuntimeModeSettings } from "./RuntimeModeSettings.jsx";
const MissionWorkspace = lazy(() => import("./MissionWorkspace.jsx").then((module) => ({ default: module.MissionWorkspace })));
const AttentionCenter = lazy(() => import("./AttentionCenter.jsx").then((module) => ({ default: module.AttentionCenter })));
const RequirementHub = lazy(() => import("./RequirementHub.jsx").then((module) => ({ default: module.RequirementHub })));

const statusMeta = {
  running: { label: "Running", icon: Pulse }, attention: { label: "Needs you", icon: Warning }, queued: { label: "Queued", icon: Clock },
  paused: { label: "Paused", icon: Pause }, done: { label: "Done", icon: Check }, idle: { label: "Idle", icon: Clock },
};

function threadStatus(thread) {
  if (thread.status?.type === "active") return "running";
  if (thread.status?.type === "systemError") return "attention";
  return "idle";
}

function toSession(thread, workspace, defaultModel = "Codex") {
  const preview = thread.preview?.trim();
  return {
    id: thread.id, threadId: thread.id, turnId: null,
    title: thread.name || preview?.slice(0, 54) || "Untitled Codex session",
    project: thread.cwd?.split("/").filter(Boolean).pop() || workspace?.name || "workspace",
    cwd: thread.cwd || workspace?.path,
    branch: thread.gitInfo?.branch || workspace?.branch || "—",
    status: threadStatus(thread), elapsed: "—",
    model: defaultModel, goal: preview || "Continue this Codex conversation.",
    summary: thread.status?.type === "active" ? "Codex is working…" : "Ready for your next instruction.",
    terminal: [["READY", `Thread ${thread.id.slice(0, 12)}`]], context: [],
    messages: preview ? [["You", "history", preview]] : [], timeline: ["Loaded from Codex history"], approval: null, live: true,
  };
}

function missionSessionStatus(reference) {
  if (reference.activeTurnId || (reference.role === "planner" && reference.status === "planning") || (reference.role === "worker" && ["claiming", "running"].includes(reference.status))) return "running";
  if (["failed", "blocked", "waiting_approval", "review", "integration_conflict", "ready"].includes(reference.status)) return "attention";
  if (reference.status === "completed") return "done";
  if (reference.status === "canceled") return "paused";
  if (reference.status === "queued") return "queued";
  return "idle";
}

function missionSessionSummary(reference) {
  if (reference.error) return reference.error;
  if (reference.role === "planner") {
    if (reference.status === "planning") return "Main Agent is generating the mission plan…";
    if (reference.status === "ready") return "Mission plan is ready for your approval.";
    if (reference.status === "completed") return "Mission completed; planner conversation is preserved.";
    return `Main Agent · Mission ${reference.status}`;
  }
  if (reference.status === "review") return `${reference.taskKey} finished and is waiting for your review.`;
  if (reference.status === "completed") return `${reference.taskKey} was verified and completed.`;
  if (reference.status === "queued") return `${reference.taskKey} is waiting for dependencies or a worker slot.`;
  return `${reference.agentRole} · ${reference.phase || reference.status}`;
}

function toMissionSession(reference, workspace, defaultModel = "Codex") {
  const lineage = reference.role === "planner" ? "Planner" : `${reference.taskKey} · ${reference.agentRole}`;
  return {
    id: reference.threadId, threadId: reference.threadId, turnId: reference.activeTurnId || null,
    title: reference.role === "planner" ? `${reference.missionTitle} · Main Agent` : `${reference.taskKey} · ${reference.title}`,
    project: workspace?.name || reference.cwd?.split("/").filter(Boolean).pop() || "workspace",
    cwd: reference.cwd || workspace?.path, branch: reference.branch || workspace?.branch || "—",
    status: missionSessionStatus(reference), elapsed: lineage, model: reference.model || defaultModel,
    goal: reference.goal || "Continue this mission conversation.", summary: missionSessionSummary(reference),
    terminal: [["MISSION", reference.missionTitle], ["READY", `Thread ${reference.threadId.slice(0, 12)}`]],
    context: [], messages: [], timeline: ["Linked from the local Mission ledger"], approval: null, live: true,
    missionId: reference.missionId, missionTitle: reference.missionTitle, missionRole: reference.role,
    taskId: reference.taskId || null, taskKey: reference.taskKey || null, agentRole: reference.agentRole,
  };
}

function mergeMissionReference(session, reference, workspace, defaultModel) {
  const linked = toMissionSession(reference, workspace, defaultModel);
  if (!session) return linked;
  return {
    ...session, ...linked,
    status: session.status === "running" ? "running" : linked.status,
    messages: session.messages, terminal: session.terminal, context: session.context,
    timeline: session.timeline, approval: session.approval,
    turnId: linked.turnId || session.turnId,
  };
}

function messageText(item) {
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) return item.content.map((part) => part?.text || part?.input_text || part?.output_text || "").join("");
  return "";
}

function sessionHistory(thread) {
  const messages = [];
  let terminal = [];
  const context = new Set();
  const timeline = [];
  for (const turn of thread?.turns || []) {
    for (const item of turn.items || []) {
      if (["userMessage", "user_message"].includes(item.type)) {
        const text = messageText(item); if (text) messages.push(["You", "history", text]);
      } else if (item.type === "agentMessage") {
        const text = messageText(item); if (text) messages.push(["Codex", "history", text]);
      } else if (item.type === "commandExecution") {
        terminal = appendLogs(terminal, item.status === "completed" ? "PASS" : "RUN", item.command || "Command execution");
        if (item.aggregatedOutput) terminal = appendLogs(terminal, "OUT", item.aggregatedOutput);
      } else if (item.type === "fileChange") {
        for (const change of item.changes || []) context.add(change.path || change.filePath);
      }
    }
    timeline.push(`Turn ${turn.status || "recorded"}`);
  }
  const latest = thread?.turns?.at(-1);
  return {
    ...(messages.length ? { messages: messages.slice(-80) } : {}),
    ...(terminal.length ? { terminal: terminal.slice(-36) } : {}),
    context: [...context].filter(Boolean).slice(-40), timeline: timeline.slice(-30),
    turnId: latest?.status === "inProgress" ? latest.id : null,
    status: latest?.status === "inProgress" ? "running" : latest?.status === "failed" ? "attention" : latest ? "done" : threadStatus(thread),
  };
}

function appendLogs(logs, kind, text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trimEnd()).filter(Boolean);
  return [...logs, ...lines.map((line) => [kind, line])].slice(-36);
}

function appendAssistant(messages, delta) {
  if (!delta) return messages;
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.[0] === "Codex" && last?.[1] === "streaming") next[next.length - 1] = ["Codex", "streaming", `${last[2]}${delta}`];
  else next.push(["Codex", "streaming", delta]);
  return next;
}

function completeAssistant(messages, text) {
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.[0] === "Codex" && last?.[1] === "streaming") next[next.length - 1] = ["Codex", "now", text || last[2]];
  else if (text) next.push(["Codex", "now", text]);
  return next;
}

function updateVoiceTranscript(messages, role, text, complete = false) {
  if (!text) return messages;
  const from = role === "user" ? "You" : "Codex";
  const next = [...messages];
  const last = next[next.length - 1];
  if (last?.[0] === from && last?.[1] === "voice-streaming") {
    next[next.length - 1] = [from, complete ? "voice" : "voice-streaming", complete ? text : `${last[2]}${text}`];
  } else {
    next.push([from, complete ? "voice" : "voice-streaming", text]);
  }
  return next;
}

function approvalItemId(approval) {
  return approval?.item?.id || approval?.action?.item?.id || approval?.action?.proposedAction?.id || approval?.proposedAction?.id || null;
}

function matchesApprovalItem(approval, item) {
  return Boolean(item?.id && approvalItemId(approval) === item.id);
}

function completedActionState(item) {
  if (item?.status === "completed") return "executed";
  if (item?.status === "declined") return "declined";
  return "failed";
}

function eventPatch(session, event) {
  const { method, params = {} } = event;
  if (method === "thread/realtime/started") return { timeline: [...session.timeline, "Voice session started"].slice(-30) };
  if (method === "thread/realtime/transcript/delta") return { messages: updateVoiceTranscript(session.messages, params.role, params.delta), summary: params.role === "assistant" ? "Codex is answering by voice…" : "Listening to your voice…" };
  if (method === "thread/realtime/transcript/done") return { messages: updateVoiceTranscript(session.messages, params.role, params.text, true), summary: params.role === "assistant" ? "Voice response received." : "Voice input received." };
  if (method === "thread/realtime/error") return { terminal: appendLogs(session.terminal, "ERROR", params.message), summary: params.message || "Realtime voice reported an error." };
  if (method === "thread/realtime/closed") return { timeline: [...session.timeline, "Voice session ended"].slice(-30), summary: "Voice chat ended. Ready for your next instruction." };
  if (method === "turn/started") return { status: "running", turnId: params.turn?.id, summary: "Codex is working…", timeline: [...session.timeline, "Turn started"].slice(-30) };
  if (method === "item/agentMessage/delta") return { messages: appendAssistant(session.messages, params.delta), summary: "Codex is composing a response…" };
  if (method === "item/reasoning/summaryTextDelta") return { summary: params.delta?.trim() || session.summary };
  if (method === "item/commandExecution/outputDelta" || method === "command/exec/outputDelta") return { terminal: appendLogs(session.terminal, "OUT", params.delta), summary: "Running a command…" };
  if (method === "turn/diff/updated") return { summary: "Reviewing workspace changes…" };
  if (method === "error") return { status: "attention", summary: params.error?.message || "Codex reported an error.", terminal: appendLogs(session.terminal, "ERROR", params.error?.message) };
  if (method === "warning" || method === "guardianWarning") return { terminal: appendLogs(session.terminal, "WARN", params.message || params.warning) };
  if (method === "item/execution/started") {
    const item = params.item || {};
    return { status: "running", approval: matchesApprovalItem(session.approval, item) ? { ...session.approval, state: "executing", startedAt: params.startedAt || event.timestamp || new Date().toISOString() } : session.approval, summary: "Running the approved action…" };
  }
  if (method === "item/started") {
    const item = params.item || {};
    if (item.type === "commandExecution") return { terminal: appendLogs(session.terminal, "RUN", item.command), approval: matchesApprovalItem(session.approval, item) ? { ...session.approval, state: "executing", startedAt: params.startedAt || event.timestamp || new Date().toISOString() } : session.approval, summary: "Running a command…" };
    if (item.type === "fileChange") return { terminal: appendLogs(session.terminal, "EDIT", "Preparing file changes"), summary: "Editing workspace files…" };
    if (item.type === "webSearch") return { terminal: appendLogs(session.terminal, "SEARCH", item.query), summary: "Searching the web…" };
    if (item.type === "mcpToolCall") return { terminal: appendLogs(session.terminal, "TOOL", `${item.server}/${item.tool}`), summary: `Calling ${item.tool}…` };
    if (item.type === "collabAgentToolCall") return { terminal: appendLogs(session.terminal, "AGENT", `${item.tool}${item.prompt ? ` · ${item.prompt}` : ""}`), summary: "Coordinating a subagent…" };
  }
  if (method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage") return { messages: completeAssistant(session.messages, item.text), summary: "Codex response received." };
    if (item.type === "commandExecution") return { terminal: appendLogs(session.terminal, item.status === "completed" ? "PASS" : item.status === "declined" ? "DECLINED" : "ERROR", `${item.command}${item.exitCode == null ? "" : ` · exit ${item.exitCode}`}`), approval: matchesApprovalItem(session.approval, item) ? { ...session.approval, state: completedActionState(item), result: item.result || item.aggregatedOutput || item.output || "", completedAt: params.completedAt || event.timestamp || new Date().toISOString() } : session.approval };
    if (item.type === "fileChange") {
      const files = (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean);
      return { context: [...new Set([...session.context, ...files])].slice(-20), terminal: appendLogs(session.terminal, "EDIT", files.join(", ") || "Workspace files changed"), approval: matchesApprovalItem(session.approval, item) ? { ...session.approval, state: completedActionState(item), result: item.result || files.join(", ") || "Workspace diff updated", completedAt: params.completedAt || event.timestamp || new Date().toISOString() } : session.approval };
    }
    if (item.type === "gitOperation") return { terminal: appendLogs(session.terminal, item.status === "completed" ? "GIT" : item.status === "declined" ? "DECLINED" : "ERROR", `${item.operation || "Git operation"}${item.result ? ` · ${item.result}` : ""}`), approval: matchesApprovalItem(session.approval, item) ? { ...session.approval, state: completedActionState(item), result: item.result || "", completedAt: params.completedAt || event.timestamp || new Date().toISOString() } : session.approval };
  }
  if (method === "turn/completed") {
    const turn = params.turn || {};
    const failed = turn.status === "failed";
    const interrupted = turn.status === "interrupted";
    return {
      status: failed ? "attention" : interrupted ? "paused" : "done", turnId: null,
      summary: failed ? (turn.error?.message || "Turn failed.") : interrupted ? "Paused by you. Send a new instruction to continue." : "Turn complete. Ready for the next instruction.",
      messages: completeAssistant(session.messages), timeline: [...session.timeline, failed ? "Turn failed" : interrupted ? "Turn interrupted" : "Turn completed"].slice(-30),
    };
  }
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval" || method === "item/gitOperation/requestApproval" || method === "item/tool/requestApproval" || method === "action/requested") {
    const action = params.action || params.lifecycle || params.approval || params;
    return { status: "attention", approval: { requestId: event.id || action.requestId || action.id, method, state: "requested", requestedAt: params.requestedAt || event.timestamp || new Date().toISOString(), ...params, action }, summary: params.reason || action.summary || (params.command ? `Approval required: ${params.command}` : "Codex needs your approval.") };
  }
  if (method === "item/approval/resolved" || method === "action/approved" || method === "action/declined") {
    const approved = (params.decision || params.action?.decision) === "accept" || method === "action/approved";
    const state = approved ? "approved" : "declined";
    return { status: approved ? "running" : "attention", approval: session.approval ? { ...session.approval, ...params, state, decision: params.decision || (approved ? "accept" : "decline"), decidedAt: params.decidedAt || event.timestamp || new Date().toISOString() } : session.approval, summary: approved ? "Approved; waiting for the worker to begin the action." : "Action declined; the worker did not run it." };
  }
  if (method === "action/executing" || method === "action/executed" || method === "action/failed") {
    const state = method.slice("action/".length);
    return { approval: session.approval ? { ...session.approval, ...params, state, result: params.result || session.approval.result, [state === "executing" ? "startedAt" : "completedAt"]: params.timestamp || event.timestamp || new Date().toISOString() } : session.approval };
  }
  return null;
}

function StatusPill({ status }) {
  const meta = statusMeta[status] || statusMeta.idle;
  const Icon = meta.icon;
  return <span className={`status-pill ${status}`}><Icon size={11} weight="fill" />{meta.label}</span>;
}

function RailButton({ icon: Icon, label, active, onClick, badge = 0 }) {
  return <button className={`rail-button ${active ? "active" : ""}`} onClick={onClick} title={label} aria-label={label}><Icon size={21} weight={active ? "duotone" : "regular"} />{badge > 0 ? <b>{badge > 99 ? "99+" : badge}</b> : null}</button>;
}

function SessionListItem({ session, selected, onSelect }) {
  return <button className={`session-list-item ${session.missionId ? "mission-owned" : ""} ${selected ? "selected" : ""}`} onClick={() => onSelect(session.id)}>{session.missionId && <span className="session-lineage"><Graph size={11} />{session.missionRole === "planner" ? "Planner" : `${session.taskKey} · ${session.agentRole}`}</span>}<div className="session-list-top"><StatusPill status={session.status} /><time>{session.elapsed}</time></div><strong>{session.title}</strong><div className="session-list-meta"><span><TerminalWindow size={12} />{session.project}</span><span><GitBranch size={12} />{session.branch}</span>{session.approval && <b>1</b>}</div></button>;
}

function SessionSidebarList({ sessions, selectedId, onSelect }) {
  const standalone = sessions.filter((session) => !session.missionId);
  const missionGroups = [...sessions.reduce((groups, session) => {
    if (!session.missionId) return groups;
    if (!groups.has(session.missionId)) groups.set(session.missionId, { id: session.missionId, title: session.missionTitle, sessions: [] });
    groups.get(session.missionId).sessions.push(session);
    return groups;
  }, new Map()).values()];
  return <>{standalone.length > 0 && <section className="session-group standalone"><header><span>INDEPENDENT</span><b>{standalone.length}</b></header>{standalone.map((session) => <SessionListItem key={session.id} session={session} selected={selectedId === session.id} onSelect={onSelect} />)}</section>}{missionGroups.map((group) => <section className="session-group mission-session-group" key={group.id}><header><span><Graph size={12} />{group.title}</span><b>{group.sessions.length} sessions</b></header>{group.sessions.map((session) => <SessionListItem key={session.id} session={session} selected={selectedId === session.id} onSelect={onSelect} />)}</section>)}</>;
}

function SessionCard({ session, selected, onSelect, steerValue, onSteerChange, onSteer }) {
  return <article className={`session-card ${selected ? "selected" : ""} ${session.status}`} data-session-id={session.id} onClick={() => onSelect(session.id)}>
    <header className="session-card-head"><div>{session.missionId && <span className="session-card-lineage"><Graph size={11} />{session.missionTitle} / {session.missionRole === "planner" ? "Planner" : session.taskKey}</span>}<h3>{session.title}</h3><div className="session-card-state"><StatusPill status={session.status} /><time>{session.elapsed}</time></div></div></header>
    <div className="repo-line"><span><TerminalWindow size={13} />{session.project}</span><span><GitBranch size={13} />{session.branch}</span><span className="agent-count">Codex</span></div>
    <div className="agent-summary"><Cpu size={20} weight="duotone" /><span>{session.summary}</span></div>
    <pre className="terminal-output" aria-label={`${session.title} terminal`}>{session.terminal.map(([kind, line], index) => <span key={`${kind}-${index}`}><b className={`log-${kind.toLowerCase()}`}>{kind}</b>{line}</span>)}</pre>
    <div className="progress-line"><span>{session.status}</span><div><i className={`observed-state ${session.status}`} /></div><em>{session.summary.split(".")[0]}</em></div>
    <form className="steer-box" onSubmit={(event) => onSteer(event, session.id)} onClick={(event) => event.stopPropagation()}><input value={steerValue || ""} onChange={(event) => onSteerChange(session.id, event.target.value)} placeholder={session.status === "running" ? "Steer this running turn…" : "Send next instruction…"} aria-label={`Steer ${session.title}`} />{session.approval && <button type="button" className="review-button" onClick={() => onSelect(session.id)}>Review</button>}<button type="submit" className="send-button" disabled={!steerValue?.trim()} aria-label={`Send to ${session.title}`}><PaperPlaneTilt size={16} /></button></form>
  </article>;
}

function AggregatedTimeline({ sessions, onSelect }) {
  const events = sessions.flatMap((session) => session.timeline.slice(-3).map((event) => ({ session, event }))).reverse();
  return <section className="secondary-view"><div className="secondary-heading"><div><span className="eyebrow">ACROSS ALL SESSIONS</span><h2>Recorded timeline</h2><p>Milestones emitted during this application run.</p></div></div><div className="global-timeline">{events.map(({ session, event }, index) => <button key={`${session.id}-${index}`} onClick={() => onSelect(session.id)}><time>Recorded</time><i className={session.status} /><div><strong>{session.title}</strong><span>{event}</span></div><StatusPill status={session.status} /></button>)}</div></section>;
}

function UsageView({ sessions }) {
  const active = sessions.filter((session) => session.status === "running").length;
  const attention = sessions.filter((session) => session.status === "attention").length;
  return <section className="secondary-view"><div className="secondary-heading"><div><span className="eyebrow">LIVE LOCAL RUNTIME</span><h2>Observed session state</h2><p>Counts are loaded from real Codex app-server threads.</p></div></div><div className="metric-grid"><article><span>Active sessions</span><strong>{active}</strong><small>Codex app-server threads</small></article><article><span>Total sessions</span><strong>{sessions.length}</strong><small>Loaded from the selected repository</small></article><article><span>Needs attention</span><strong>{attention}</strong><div className="attention-callout"><Warning size={16} />Approvals and failures</div></article></div><div className="usage-table"><header><span>Session</span><span>Status</span><span>Runtime</span><span>Last evidence</span></header>{sessions.map((s) => <div key={s.id}><strong>{s.title}</strong><StatusPill status={s.status} /><span>{s.elapsed}</span><span>{s.timeline.at(-1) || "Loaded"}</span></div>)}</div></section>;
}

function ProviderCard({ provider, onSaveApi, onVerifyApi, onBridge }) {
  const [endpoint, setEndpoint] = useState(provider.endpoint || provider.defaultEndpoint || "");
  const [model, setModel] = useState(provider.model || provider.defaultModel || "");
  const [apiKey, setApiKey] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setEndpoint(provider.endpoint || provider.defaultEndpoint || ""); setModel(provider.model || provider.defaultModel || ""); }, [provider.id, provider.endpoint, provider.model]);
  const status = provider.connected ? "running" : "attention";
  const action = async () => {
    setBusy(true); setNotice("");
    try {
      if (provider.kind === "api") {
        await onSaveApi({ providerId: provider.id, endpoint, model, apiKey });
        setApiKey(""); setNotice("Saved locally. The key is encrypted with macOS secure storage and never placed in a Mission prompt.");
      } else {
        const config = await onBridge(provider.id);
        await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
        setNotice("Agent Deck MCP configuration copied. Import it in the provider, then its agents can report progress and publish artifacts into this local Mission ledger.");
      }
    } catch (error) { setNotice(error.message || String(error)); }
    finally { setBusy(false); }
  };
  const verify = async () => {
    setBusy(true); setNotice("");
    try {
      const result = await onVerifyApi(provider.id);
      setNotice(`Verified in ${result.result?.latencyMs || 0}ms. Usage is now available for the Value Ledger.`);
    } catch (error) { setNotice(error.message || String(error)); }
    finally { setBusy(false); }
  };
  return <article className={`provider-card ${provider.connected ? "connected" : ""}`}><header><div><span className="provider-kind">{provider.kind === "api" ? "CLOUD API" : provider.kind === "cli" ? "LOCAL CLI" : "NATIVE"}</span><strong>{provider.label}</strong><span>{provider.description}</span></div><StatusPill status={status} /></header><div className="provider-capabilities">{provider.capabilities.map((capability) => <code key={capability}>{capability.replaceAll("_", " ")}</code>)}</div>{provider.kind === "cli" && <dl><div><dt>Runtime</dt><dd>{provider.installed ? provider.binary : "Not installed"}</dd></div><div><dt>Version</dt><dd>{provider.version || "—"}</dd></div></dl>}{provider.kind === "api" && <div className="provider-api-fields"><label>Endpoint<input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://api.example.com/v1" /></label><label>Model<input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model name" /></label><label>API key <small>{provider.connected ? "Leave empty to retain the encrypted key" : "Stored only with macOS encryption"}</small><input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={provider.connected ? "••••••••" : "Paste a key"} autoComplete="off" /></label></div>}<footer><button className="tool-button" onClick={action} disabled={busy || (provider.kind === "api" && (!endpoint.trim() || !model.trim()))}>{busy ? "Working…" : provider.kind === "api" ? "Save connection" : "Copy MCP bridge config"}</button>{provider.kind === "api" && <button className="tool-button" onClick={verify} disabled={busy || !provider.configured}>Test API</button>}{notice && <small className={notice.startsWith("Saved") || notice.startsWith("Agent Deck MCP") || notice.startsWith("Verified") ? "provider-notice success" : "provider-notice"}>{notice}</small>}</footer></article>;
}

function SettingsView(props) {
  return <><RuntimeModeSettings desktop={window.agentDeckDesktop} providers={props.providers} onChanged={props.onRefreshProviders} /><LegacySettingsView {...props} /></>;
}
function LegacySettingsView({ workspace, codexStatus, onChooseWorkspace, density, onDensity, providers, onRefreshProviders, onSaveApi, onVerifyApi, onBridge }) {
  return <section className="secondary-view settings-view"><div className="secondary-heading"><div><span className="eyebrow">Local preferences</span><h2>Agent Deck settings</h2><p>Provider capability is explicit: we only show an action as available after its local runtime or encrypted API profile has been verified.</p></div><button className="tool-button" onClick={onRefreshProviders}>Refresh providers</button></div><div className="settings-stack"><article><header><div><strong>Interface size</strong><span>Scale typography, controls, and reading space together. Comfortable is optimized for long desktop sessions.</span></div></header><div className="interface-size-control" role="group" aria-label="Interface size">{[["compact", "Compact", "More rows"], ["comfortable", "Comfortable", "Recommended"], ["large", "Large", "Easier reading"]].map(([id, label, description]) => <button type="button" key={id} className={density === id ? "active" : ""} onClick={() => onDensity(id)} aria-pressed={density === id}><span>Aa</span><strong>{label}</strong><small>{description}</small></button>)}</div></article><article><header><div><strong>Workspace</strong><span>The repository used for new sessions and missions.</span></div><button className="tool-button" onClick={onChooseWorkspace}><FolderOpen size={14} />Change workspace</button></header><dl><div><dt>Name</dt><dd>{workspace?.name || "Not selected"}</dd></div><div><dt>Path</dt><dd title={workspace?.path}>{workspace?.path || "—"}</dd></div><div><dt>Branch</dt><dd>{workspace?.branch || "—"}</dd></div></dl></article><article><header><div><strong>外部 Codex 连接</strong><span>{codexStatus.inactive ? "自有 Harness 模式未启动 Codex。旧任务仍保留原执行引擎。" : "外部模式通过本地 app-server 连接。"}</span></div><StatusPill status={codexStatus.authenticated ? "running" : "attention"} /></header><dl><div><dt>Version</dt><dd>{codexStatus.version || "Unavailable"}</dd></div><div><dt>Account</dt><dd>{codexStatus.account?.email || codexStatus.account?.planType || "Unavailable"}</dd></div><div><dt>Models</dt><dd>{codexStatus.models?.length || 0} available</dd></div></dl></article><article className="providers-settings"><header><div><strong>Provider adapters</strong><span>外部 Coding Agent 与模型 API 分开配置。自有 Harness 使用已测试的 API；Claude Code、Trae 当前仅支持 MCP 桥接，完整执行适配尚未开放。</span></div></header><div className="provider-grid">{providers.length ? providers.filter((provider) => provider.id !== "codex").map((provider) => <ProviderCard key={provider.id} provider={provider} onSaveApi={onSaveApi} onVerifyApi={onVerifyApi} onBridge={onBridge} />) : <p className="muted-copy">Loading local provider availability…</p>}</div></article><article><header><div><strong>Data & privacy</strong><span>Mission plans, events, messages, artifact references, provider configuration metadata, and encrypted API keys are persisted locally. Workspace access stays behind the Electron main-process bridge.</span></div></header></article></div></section>;
}

function VoicePanel({ voice, active, disabled, onToggle }) {
  const connected = active && !["idle", "error"].includes(voice.status);
  const label = voice.status === "connecting" ? "连接中" : voice.status === "stopping" ? "结束中" : voice.status === "speaking" ? "Codex 正在回答" : voice.status === "error" ? "语音连接失败" : connected ? "实时语音已开启" : "实时语音聊天";
  return <section className={`voice-panel ${connected ? "active" : ""} ${voice.status}`}>
    <button type="button" className="voice-toggle" onClick={onToggle} disabled={disabled || ["connecting", "stopping"].includes(voice.status)} aria-label={connected ? "结束实时语音" : "开始实时语音"}>
      {connected ? <MicrophoneSlash size={17} weight="fill" /> : <Microphone size={17} weight="fill" />}
    </button>
    <div><strong>{label}</strong><span>{active && voice.message ? voice.message : "点击后直接与当前 Codex 会话对话"}</span></div>
    <div className="voice-wave" aria-hidden="true">{[10, 17, 24, 15, 21].map((height, index) => <i key={index} style={{ height }} />)}</div>
    {connected && <SpeakerHigh className="voice-speaker" size={15} />}
  </section>;
}

function DebugConsole({ desktop, session }) {
  const [command, setCommand] = useState("");
  const [records, setRecords] = useState([]);
  const [running, setRunning] = useState(false);
  useEffect(() => { setCommand(""); setRecords([]); setRunning(false); }, [session.id]);
  const run = async (event) => {
    event.preventDefault();
    const nextCommand = command.trim();
    if (!nextCommand || running || !desktop?.terminal?.run) return;
    setRunning(true);
    try {
      const result = await desktop.terminal.run({ cwd: session.cwd, command: nextCommand });
      setRecords((items) => [{ ...result, id: `${Date.now()}-${items.length}` }, ...items].slice(0, 12));
      setCommand("");
    } catch (runError) {
      setRecords((items) => [{ id: `${Date.now()}-${items.length}`, command: nextCommand, cwd: session.cwd, stdout: "", stderr: runError.message || String(runError), exitCode: null, failedToStart: true, durationMs: 0 }, ...items].slice(0, 12));
    } finally { setRunning(false); }
  };
  return <section className="debug-console" data-testid="debug-console"><header><div><span className="eyebrow">LOCAL DEBUG CONSOLE</span><h4>Bash in this worktree</h4></div><span>{session.branch}</span></header><p>Commands run locally in <code title={session.cwd}>{session.cwd}</code>. They can change files; this is separate from Codex tool calls.</p><form onSubmit={run}><textarea value={command} onChange={(event) => setCommand(event.target.value)} placeholder="e.g. git status --short && npm test" aria-label="Bash debug command" spellCheck="false" /><button disabled={!command.trim() || running}>{running ? "Running…" : "Run Bash"}<PaperPlaneTilt size={14} /></button></form><div className="debug-history">{records.length ? records.map((record) => <article key={record.id} className={record.exitCode === 0 ? "passed" : "failed"}><header><code>$ {record.command}</code><span>{record.failedToStart ? "not started" : record.timedOut ? "timed out" : `exit ${record.exitCode}`} · {record.durationMs}ms</span></header>{record.stdout ? <pre>{record.stdout}</pre> : null}{record.stderr ? <pre className="stderr">{record.stderr}</pre> : null}{record.truncated ? <small>Output was truncated after 512 KB.</small> : null}</article>) : <div className="debug-empty">Your command history will stay visible for this session.</div>}</div></section>;
}

function Inspector({ desktop, session, onPause, onStop, onApproval, approvalBusy, note, setNote, onSend, voice, onVoice, onFile, onFocus, onArchive, onMission }) {
  const [tab, setTab] = useState("details");
  if (!session) return <aside className="inspector inspector-empty"><Cpu size={28} /><strong>No session selected</strong><span>Choose a local workspace and start a Codex session.</span></aside>;
  return <aside className="inspector"><header className="inspector-title"><div><span className="eyebrow">SELECTED SESSION</span><h2>{session.title}</h2></div><button className="quiet-button" onClick={onFocus} title="Focus this session"><AppWindow size={17} /></button></header><div className="inspector-tabs">{[["details", "Details"], ["files", `Files ${session.context.length}`], ["conversation", `Conversation ${session.messages.length}`], ["debug", "Bash"]].map(([id, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>{label}</button>)}</div><div className="inspector-scroll">
    <VoicePanel voice={voice} active={voice.threadId === session.threadId} disabled={!session.live} onToggle={onVoice} />
    {session.approval && <ApprovalActionPanel action={session.approval} onDecision={onApproval} commandAvailable={Boolean(desktop?.codex?.approval)} busy={approvalBusy} />}
    {tab === "details" && <><section className="inspector-section"><h4>Goal</h4><p>{session.goal}</p></section>{session.missionId && <section className="inspector-section session-mission-context"><h4><Graph size={14} />Mission context</h4><dl><div><dt>Mission</dt><dd title={session.missionTitle}>{session.missionTitle}</dd></div><div><dt>Agent</dt><dd>{session.missionRole === "planner" ? "Main Agent · Planner" : `${session.taskKey} · ${session.agentRole}`}</dd></div></dl></section>}<section className="inspector-section"><h4>Runtime</h4><div className="model-row"><span><Cpu size={15} />{session.model}</span><StatusPill status={session.status} /></div><dl><div><dt>Repository</dt><dd>{session.project}</dd></div><div><dt>Worktree</dt><dd title={session.cwd}>{session.branch}</dd></div><div><dt>Thread</dt><dd title={session.threadId}>{session.threadId?.slice(0, 13) || "Unavailable"}</dd></div></dl></section></>}
    {tab === "files" && <section className="inspector-section"><h4>Changed files <b>{session.context.length}</b></h4><div className="context-list">{session.context.length ? session.context.map((file) => <button key={file} onClick={() => onFile(file)} title={`Open ${file}`}><FileCode size={15} /><span>{file}</span></button>) : <p>No file changes were found in loaded thread history.</p>}</div></section>}
    {tab === "conversation" && <section className="inspector-section"><h4>Conversation</h4><div className="conversation-list">{session.messages.length ? session.messages.map(([from, time, body], index) => <article key={`${from}-${index}`}><header><span className={`avatar ${from === "You" ? "you" : ""}`}>{from[0]}</span><strong>{from}</strong><time>{time}</time></header><p>{body}</p></article>) : <p>No persisted messages were returned for this thread.</p>}</div></section>}
    {tab === "debug" && <DebugConsole desktop={desktop} session={session} />}
  </div><form className="inspector-reply" onSubmit={onSend}><input value={note} onChange={(event) => setNote(event.target.value)} placeholder={session.status === "running" ? "Steer this running turn…" : "Send next instruction…"} aria-label="Steer selected session" /><button disabled={!note.trim()}><PaperPlaneTilt size={16} weight="fill" /></button></form><footer className="inspector-actions"><button onClick={onPause} disabled={session.status !== "running"}><Pause size={15} />Pause turn</button>{session.status === "running" ? <button className="danger" onClick={onStop}><Stop size={15} />Stop</button> : session.missionId ? <button onClick={onMission}><Graph size={15} />Open mission</button> : <button onClick={onArchive}><Archive size={15} />Archive</button>}</footer></aside>;
}

function WorkspacePicker({ workspace, onChoose, busy = false }) {
  return <button type="button" className="workspace-picker-control" onClick={onChoose} disabled={busy} data-testid="workspace-picker">
    <FolderOpen size={19} weight="duotone" />
    <span><strong>{workspace?.name || "Choose a local workspace"}</strong><small title={workspace?.path}>{workspace?.path || "Select the repository Codex should read and edit"}</small></span>
    <b>{busy ? "Opening…" : workspace ? "Change…" : "Choose…"}</b>
  </button>;
}

function NewSessionModal({ onClose, onCreate, onChooseWorkspace, workspace, models }) {
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const defaultModel = models.find((model) => model.isDefault)?.id || models[0]?.id || "";
  const [model, setModel] = useState(defaultModel);
  const [submitting, setSubmitting] = useState(false);
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  const choose = async () => { setChoosingWorkspace(true); try { await onChooseWorkspace(); } finally { setChoosingWorkspace(false); } };
  const submit = async (event) => { event.preventDefault(); if (!title.trim() || !goal.trim()) return; setSubmitting(true); try { await onCreate(title.trim(), goal.trim(), model); } finally { setSubmitting(false); } };
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">NEW CODEX THREAD</span><h2>Start a real Codex session</h2></div><button type="button" className="quiet-button" onClick={onClose}><X size={19} /></button></header><label>Session name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="e.g. Investigate memory leak" /></label><label>Task<textarea value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="Describe the outcome Codex should deliver in this repository." /></label><label className="workspace-picker-label">Repository<WorkspacePicker workspace={workspace} onChoose={choose} busy={choosingWorkspace} /></label><label>Model<select value={model} onChange={(event) => setModel(event.target.value)}>{models.length ? models.map((item) => <option key={item.id} value={item.id}>{item.displayName || item.id}</option>) : <option value="">Codex default</option>}</select></label><footer><button type="button" className="tool-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={submitting || choosingWorkspace || !workspace || !title.trim() || !goal.trim()}><Play size={15} weight="fill" />{submitting ? "Starting…" : "Start session"}</button></footer></form></div>;
}

export function App() {
  const desktop = window.agentDeckDesktop;
  const live = Boolean(desktop?.codex);
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [view, setView] = useState("requirements");
  const [selectedWorkId, setSelectedWorkId] = useState(null);
  const [layout, setLayout] = useState("grid");
  const [steerValues, setSteerValues] = useState({});
  const [note, setNote] = useState("");
  const [showNewSession, setShowNewSession] = useState(false);
  const [workspace, setWorkspace] = useState(null);
  const [codexStatus, setCodexStatus] = useState({ loading: live, available: !live, authenticated: false, models: [] });
  const [providers, setProviders] = useState([]);
  const [error, setError] = useState("");
  const [voice, setVoice] = useState({ status: "idle", threadId: null, message: "" });
  const [missionAttention, setMissionAttention] = useState([]);
  const [attentionBriefing, setAttentionBriefing] = useState(null);
  const [attentionLoading, setAttentionLoading] = useState(false);
  const [attentionError, setAttentionError] = useState("");
  const [missionTarget, setMissionTarget] = useState(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [density, setDensity] = useState(() => {
    try { return localStorage.getItem("agent-deck:interface-size") || "comfortable"; }
    catch { return "comfortable"; }
  });
  const voiceController = useRef(null);
  const loadedHistories = useRef(new Set());
  const selected = sessions.find((session) => session.id === selectedId) || sessions[0] || null;
  const filteredSessions = useMemo(() => sessions.filter((session) => {
    const matchesSearch = `${session.title} ${session.project} ${session.branch}`.toLowerCase().includes(search.toLowerCase());
    const matchesFilter = filter === "all" || (filter === "active" ? ["running", "paused"].includes(session.status) : session.status === filter);
    return matchesSearch && matchesFilter;
  }), [sessions, search, filter]);
  const visibleSessions = layout === "focus" ? (selected ? [selected] : []) : filteredSessions.slice(0, 6);
  const runningCount = sessions.filter((session) => session.status === "running").length;
  const attentionCount = sessions.filter((session) => session.status === "attention").length;

  async function refreshProviders() {
    if (!desktop?.providers?.list) return;
    try { setProviders(await desktop.providers.list()); }
    catch (providerError) { setError(providerError.message || String(providerError)); }
  }

  async function saveApiProvider(input) {
    if (!desktop?.providers?.saveApiProfile) throw new Error("Provider settings require the desktop app");
    const result = await desktop.providers.saveApiProfile(input);
    setProviders(result.providers || await desktop.providers.list());
    return result;
  }

  async function verifyApiProvider(providerId) {
    if (!desktop?.providers?.verifyApiProfile) throw new Error("Provider settings require the desktop app");
    const result = await desktop.providers.verifyApiProfile(providerId);
    setProviders(result.providers || await desktop.providers.list());
    return result;
  }

  async function copyProviderBridge(providerId) {
    if (!desktop?.providers?.bridgeConfig) throw new Error("Provider settings require the desktop app");
    return desktop.providers.bridgeConfig(providerId);
  }

  async function refreshAttention() {
    if (!desktop?.missions?.attention) return;
    setAttentionLoading(true); setAttentionError("");
    try {
      const [items, briefing] = await Promise.all([
        desktop.missions.attention(),
        desktop.missions.attentionBriefing ? desktop.missions.attentionBriefing() : Promise.resolve(null),
      ]);
      setMissionAttention(items); setAttentionBriefing(briefing);
    }
    catch (loadError) { setAttentionError(loadError.message || String(loadError)); }
    finally { setAttentionLoading(false); }
  }

  function patchSession(id, patch) { setSessions((items) => items.map((session) => session.id === id ? { ...session, ...patch } : session)); }

  function receiveCodexEvent(event) {
    voiceController.current?.handleCodexEvent(event).catch((voiceError) => setError(voiceError.message || String(voiceError)));
    const threadId = event.params?.threadId || event.params?.thread?.id;
    if (event.method === "agentDeck/serverExit") {
      setError(event.params?.message || "Codex app-server stopped.");
      setSessions((items) => items.map((session) => session.status === "running" ? { ...session, status: "attention", summary: "Codex connection stopped." } : session));
      return;
    }
    if (!threadId) return;
    setSessions((items) => items.map((session) => {
      if (session.threadId !== threadId) return session;
      const patch = eventPatch(session, event);
      return patch ? { ...session, ...patch } : session;
    }));
  }

  async function loadThreads(currentWorkspace, status = codexStatus) {
    if (!live || !currentWorkspace || !status.available || !status.authenticated) return;
    try {
      const [threads, missionReferences] = await Promise.all([
        desktop.codex.threads(currentWorkspace.path),
        desktop.missions?.sessions ? desktop.missions.sessions(currentWorkspace.path) : Promise.resolve([]),
      ]);
      const defaultModel = status.models?.find((model) => model.isDefault)?.displayName || status.models?.[0]?.displayName || "Codex";
      const references = new Map(missionReferences.map((reference) => [reference.threadId, reference]));
      const loaded = threads.map((thread) => {
        const session = toSession(thread, currentWorkspace, defaultModel);
        const reference = references.get(thread.id);
        if (!reference) return session;
        references.delete(thread.id);
        return mergeMissionReference(session, reference, currentWorkspace, defaultModel);
      });
      for (const reference of references.values()) loaded.push(toMissionSession(reference, currentWorkspace, defaultModel));
      setSessions((currentSessions) => loaded.map((session) => {
        const current = currentSessions.find((item) => item.id === session.id);
        if (!current) return session;
        return {
          ...session,
          messages: current.messages, terminal: current.terminal, context: current.context,
          timeline: current.timeline, approval: current.approval,
          turnId: session.turnId || current.turnId,
        };
      }));
      setSelectedId((current) => loaded.some((item) => item.id === current) ? current : loaded[0]?.id || null);
    } catch (loadError) { setError(loadError.message || String(loadError)); }
  }

  useEffect(() => {
    if (!live) return undefined;
    voiceController.current = createBrowserVoiceController(desktop, setVoice);
    const unsubscribe = desktop.codex.onEvent(receiveCodexEvent);
    (async () => {
      const current = await desktop.currentWorkspace();
      if (current) setWorkspace(current);
      const [status] = await Promise.all([desktop.codex.status(), refreshProviders()]);
      setCodexStatus({ ...status, loading: false, models: status.models || [] });
      if (status.inactive) { if (["sessions", "timeline", "usage"].includes(view)) setView("requirements"); }
      else if (!status.available) setError(status.error || "Codex is unavailable.");
      else if (!status.authenticated) setError("Sign in with the local Codex CLI, then reopen Agent Deck.");
      else if (current) await loadThreads(current, status);
    })();
    return () => {
      unsubscribe();
      voiceController.current?.stop();
      voiceController.current = null;
    };
  }, []);

  useEffect(() => desktop?.runtime?.onChange?.(async (settings) => {
    try {
      const status = await desktop.codex.status();
      setCodexStatus({ ...status, loading: false, models: status.models || [] });
      setError("");
      await refreshProviders();
      if (settings.mode === "agent_deck") setSessions([]);
    } catch (error) { setError(error.message); }
  }), [desktop]);

  useEffect(() => {
    if (voice.threadId && selectedId && voice.threadId !== selectedId) voiceController.current?.stop();
  }, [selectedId]);

  useEffect(() => {
    document.documentElement.dataset.uiDensity = density;
    try { localStorage.setItem("agent-deck:interface-size", density); } catch { /* local preference is optional */ }
  }, [density]);

  useEffect(() => {
    if (!desktop?.missions || !workspace || !codexStatus.available || !codexStatus.authenticated) return undefined;
    let refreshTimer = null;
    const unsubscribe = desktop.missions.onUpdate(() => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => loadThreads(workspace), 180);
    });
    return () => { clearTimeout(refreshTimer); unsubscribe(); };
  }, [desktop, workspace?.path, codexStatus.available, codexStatus.authenticated]);

  useEffect(() => {
    if (!desktop?.missions?.attention) return undefined;
    let disposed = false;
    let refreshTimer = null;
    const refresh = async () => {
      try {
        const [items, briefing] = await Promise.all([
          desktop.missions.attention(),
          desktop.missions.attentionBriefing ? desktop.missions.attentionBriefing() : Promise.resolve(null),
        ]);
        if (!disposed) { setMissionAttention(items); setAttentionBriefing(briefing); setAttentionError(""); }
      } catch (loadError) { if (!disposed) setAttentionError(loadError.message || String(loadError)); }
      finally { if (!disposed) setAttentionLoading(false); }
    };
    setAttentionLoading(true); refresh();
    const unsubscribe = desktop.missions.onUpdate(() => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refresh, 220);
    });
    return () => { disposed = true; clearTimeout(refreshTimer); unsubscribe(); };
  }, [desktop]);

  useEffect(() => {
    if (!live || !selectedId || loadedHistories.current.has(selectedId)) return;
    let disposed = false;
    loadedHistories.current.add(selectedId);
    desktop.codex.readThread({ threadId: selectedId, includeTurns: true }).then((thread) => {
      if (!disposed) setSessions((items) => items.map((session) => {
        if (session.id !== selectedId) return session;
        const history = sessionHistory(thread);
        if (!session.missionId) return { ...session, ...history };
        return { ...session, ...history, status: history.status === "running" ? "running" : session.status, turnId: history.turnId || session.turnId };
      }));
    }).catch((historyError) => {
      loadedHistories.current.delete(selectedId);
      if (!disposed) setError(`Could not load full conversation: ${historyError.message || historyError}`);
    });
    return () => { disposed = true; };
  }, [selectedId, live]);

  async function toggleVoice() {
    if (!selected?.threadId || !voiceController.current) return;
    setError("");
    try {
      if (voice.threadId === selected.threadId && voice.status !== "idle") await voiceController.current.stop();
      else await voiceController.current.start({ threadId: selected.threadId, cwd: selected.cwd || workspace?.path });
    } catch (voiceError) {
      setError(voiceError.message || String(voiceError));
    }
  }

  async function chooseWorkspace() {
    try {
      const selectedWorkspace = await desktop?.selectWorkspace();
      if (!selectedWorkspace) return null;
      setWorkspace(selectedWorkspace); setError("");
      await loadThreads(selectedWorkspace);
      return selectedWorkspace;
    } catch (workspaceError) {
      setError(workspaceError.message || String(workspaceError));
      return null;
    }
  }

  async function dispatchMessage(target, message) {
    if (!live || !target?.threadId) return;
    patchSession(target.id, { status: "running", summary: target.turnId ? "Steering the active turn…" : "Starting the next turn…", messages: [...target.messages, ["You", "now", message]] });
    try {
      if (target.status === "running" && target.turnId) await desktop.codex.steer({ threadId: target.threadId, turnId: target.turnId, prompt: message });
      else {
        const turn = await desktop.codex.sendTurn({ threadId: target.threadId, cwd: target.cwd || workspace?.path, prompt: message });
        patchSession(target.id, { turnId: turn.id, status: "running" });
      }
    } catch (sendError) { patchSession(target.id, { status: "attention", summary: sendError.message, terminal: appendLogs(target.terminal, "ERROR", sendError.message) }); }
  }

  async function steerSession(event, id) {
    event.preventDefault();
    const message = steerValues[id]?.trim();
    const target = sessions.find((session) => session.id === id);
    if (!message || !target) return;
    setSteerValues((values) => ({ ...values, [id]: "" }));
    await dispatchMessage(target, message);
  }

  async function sendInspectorMessage(event) {
    event.preventDefault();
    const message = note.trim();
    if (!message || !selected) return;
    setNote(""); await dispatchMessage(selected, message);
  }

  async function interruptSelected(stopped = false) {
    if (!selected?.threadId || !selected.turnId) return;
    try {
      await desktop.codex.interrupt({ threadId: selected.threadId, turnId: selected.turnId });
      if (stopped) patchSession(selected.id, { status: "done", turnId: null, summary: "Stopped by you. Workspace changes are preserved." });
    } catch (interruptError) { patchSession(selected.id, { status: "attention", summary: interruptError.message }); }
  }

  async function decideApproval(decision) {
    if (!selected?.approval) return;
    if (!desktop?.codex?.approval) return;
    setApprovalBusy(true);
    try {
      await desktop.codex.approval({ requestId: selected.approval.requestId, decision });
      patchSession(selected.id, {
        approval: { ...selected.approval, state: decision === "accept" ? "approved" : "declined", decision, decidedAt: new Date().toISOString() },
        status: decision === "decline" ? "attention" : "running",
        summary: decision === "decline" ? "Action declined; it was not run." : "Approved; waiting for the worker to begin the action.",
      });
    } catch (approvalError) { setError(approvalError.message || String(approvalError)); }
    finally { setApprovalBusy(false); }
  }

  async function openSessionFile(file) {
    try { await desktop.openWorkspaceFile(file); }
    catch (fileError) { setError(fileError.message || String(fileError)); }
  }

  async function archiveSelected() {
    if (!selected?.threadId || selected.status === "running") return;
    try {
      const result = await desktop.codex.archiveThread(selected.threadId);
      if (result?.canceled) return;
      const remaining = sessions.filter((session) => session.id !== selected.id);
      setSessions(remaining); setSelectedId(remaining[0]?.id || null);
    } catch (archiveError) { setError(archiveError.message || String(archiveError)); }
  }

  async function createSession(title, goal, model) {
    if (!workspace || !live) return;
    setError("");
    try {
      const result = await desktop.codex.createThread({ cwd: workspace.path, title, model: model || undefined });
      const next = { ...toSession(result.thread, workspace, result.model || "Codex"), title, goal, status: "running", messages: [["You", "now", goal]], terminal: [["INFO", "Connected to local Codex app-server"], ["INFO", `Started ${result.thread.id}`]], timeline: ["Session created"] };
      setSessions((items) => [next, ...items.filter((item) => item.id !== next.id)]);
      setSelectedId(next.id); setFilter("all"); setLayout("focus"); setView("sessions"); setShowNewSession(false);
      const turn = await desktop.codex.sendTurn({ threadId: result.thread.id, cwd: workspace.path, prompt: goal, model: model || undefined });
      patchSession(result.thread.id, { turnId: turn.id, status: "running" });
    } catch (createError) { setError(createError.message || String(createError)); throw createError; }
  }

  const nativeMode = providers.some((provider) => provider.runtimeMode === "agent_deck");
  const nativeReady = providers.some((provider) => provider.selectedForMode && provider.missionEnabled);
  const healthLabel = nativeMode ? nativeReady ? "自有 Harness · 已就绪" : "自有 Harness · 待配置 API" : !live ? "桌面运行时未连接" : codexStatus.loading ? "正在连接" : codexStatus.authenticated ? "Codex 已连接" : codexStatus.available ? "需要登录" : "Codex 未连接";

  return <main className="app-shell product-shell">
    <header className="window-bar"><div className="traffic-lights"><i /><i /><i /></div><strong>Agent Deck</strong><div className="window-actions"><Command size={16} /><SidebarSimple size={17} /></div></header>
    <ProductNavigation view={view} onNavigate={setView} badge={missionAttention.length} health={healthLabel} connected={nativeMode ? nativeReady : codexStatus.authenticated} />
    <div className="product-main">
      <WorkNavigation nativeMode={nativeMode} view={view} onNavigate={setView} workspace={workspace} onChooseWorkspace={chooseWorkspace} onOpenExecution={() => { setMissionTarget(current => ({ ...current, taskId: null, tab: "graph", panel: "result", nonce: Date.now() })); setView("mission"); }} />
      <div className={`product-content view-${view}`}>
    {view === "results" ? <ResultsHub desktop={desktop} onOpen={(mission) => { setMissionTarget({ missionId: mission.id, tab: "artifacts", panel: "artifacts", nonce: Date.now() }); setView("artifacts"); }} /> : view === "settings" ? <div className="product-settings"><SettingsView workspace={workspace} codexStatus={codexStatus} onChooseWorkspace={chooseWorkspace} density={density} onDensity={setDensity} providers={providers} onRefreshProviders={refreshProviders} onSaveApi={saveApiProvider} onVerifyApi={verifyApiProvider} onBridge={copyProviderBridge} /></div> :
    view === "requirements" ? <Suspense fallback={<section className="requirement-hub"><div className="attention-empty"><ClipboardText size={30} /><strong>Loading requirement ledger…</strong></div></section>}><RequirementHub initialSelectedId={selectedWorkId} onSelectionChange={setSelectedWorkId} desktop={desktop} workspace={workspace} codexStatus={codexStatus} onChooseWorkspace={chooseWorkspace} onOpenMission={(requirement) => { if (!requirement.missionId) return; setMissionTarget({ missionId: requirement.missionId, panel: "result", tab: "graph", nonce: Date.now() }); setView("mission"); }} /></Suspense> : view === "attention" ? <Suspense fallback={<section className="attention-center"><div className="attention-empty"><BellRinging size={30} /><strong>Loading decision queue…</strong></div></section>}><AttentionCenter items={missionAttention} briefing={attentionBriefing} loading={attentionLoading} error={attentionError} onRefresh={refreshAttention} onOpen={(item) => { setMissionTarget({ missionId: item.missionId, taskId: item.taskId, panel: item.panel, tab: item.tab, nonce: Date.now() }); setView("mission"); }} onDefer={async (item, minutes) => { try { await desktop.missions.deferAttention({ attentionId: item.id, minutes }); await refreshAttention(); } catch (deferError) { setAttentionError(deferError.message || String(deferError)); } }} /></Suspense> : ["mission", "artifacts"].includes(view) ? <Suspense fallback={<section className="mission-workspace"><div className="mission-empty full"><FileCode size={32} /><h2>Loading mission workspace…</h2></div></section>}><MissionWorkspace desktop={desktop} workspace={workspace} codexStatus={codexStatus} onChooseWorkspace={chooseWorkspace} mode={view} target={missionTarget} /></Suspense> : <><aside className="sessions-sidebar"><header><div><span className="eyebrow">WORKSPACE</span><h1>会话 <b>{sessions.length}</b></h1></div><button className="new-icon" onClick={() => workspace ? setShowNewSession(true) : chooseWorkspace()} aria-label="New session"><Plus size={17} /></button></header><div className="session-search"><MagnifyingGlass size={14} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search sessions" aria-label="Search sessions" /></div><div className="filter-tabs">{[["all", "All"], ["active", "Running"], ["attention", "Needs you"]].map(([key, label]) => <button key={key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}</button>)}</div><div className="session-list"><SessionSidebarList sessions={filteredSessions} selectedId={selectedId} onSelect={setSelectedId} />{!filteredSessions.length && <div className="empty-list">{workspace ? "No Codex sessions in this workspace." : "Choose a workspace to begin."}</div>}</div><footer><button onClick={() => setFilter("done")} className={filter === "done" ? "active" : ""}><Rows size={14} />Completed <span>{sessions.filter((s) => s.status === "done").length}</span></button></footer></aside>
    <section className="workspace"><div className="toolbar"><button className="primary-button" onClick={() => workspace ? setShowNewSession(true) : chooseWorkspace()} disabled={live && (!codexStatus.authenticated || codexStatus.loading)}><Plus size={15} />新建会话</button><button className="tool-button" onClick={() => loadThreads(workspace)} disabled={!workspace || !live}><ArrowsClockwise size={14} />刷新</button><button className="tool-button" onClick={() => interruptSelected(false)} disabled={selected?.status !== "running"}><Pause size={14} />暂停当前</button><div className="workspace-tabs">{[["sessions", "会话"], ["timeline", "最近活动"], ["usage", "运行概况"]].map(([key, label]) => <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key)}>{label}</button>)}</div><span className="parallel-count"><i />{runningCount} running <b>·</b> {attentionCount} needs you</span><div className="layout-toggle"><button className={layout === "grid" ? "active" : ""} onClick={() => setLayout("grid")} aria-label="Grid view"><GridFour size={16} /></button><button className={layout === "focus" ? "active" : ""} onClick={() => setLayout("focus")} aria-label="Focus view"><AppWindow size={16} /></button></div></div>
      {error && <div className="runtime-error"><Warning size={15} />{error}<button onClick={() => setError("")}><X size={14} /></button></div>}
      <div className="workspace-body"><section className="primary-surface">{view === "sessions" && <div className={`session-grid ${layout}`}>{visibleSessions.map((session) => <SessionCard key={session.id} session={session} selected={selectedId === session.id} onSelect={setSelectedId} steerValue={steerValues[session.id]} onSteerChange={(id, value) => setSteerValues((values) => ({ ...values, [id]: value }))} onSteer={steerSession} />)}{!visibleSessions.length && <div className="empty-canvas"><TerminalWindow size={30} /><strong>{workspace ? "No sessions yet" : "Choose a local workspace"}</strong><span>{workspace ? "Start a Codex session; it will appear here with live output." : "Agent Deck runs Codex against the repository you select."}</span><button className="primary-button" onClick={workspace ? () => setShowNewSession(true) : chooseWorkspace}>{workspace ? "Start Codex session" : "Open workspace"}</button></div>}</div>}{view === "timeline" && <AggregatedTimeline sessions={sessions} onSelect={(id) => { setSelectedId(id); setView("sessions"); }} />}{view === "usage" && <UsageView sessions={sessions} />}{view === "settings" && <SettingsView workspace={workspace} codexStatus={codexStatus} onChooseWorkspace={chooseWorkspace} density={density} onDensity={setDensity} providers={providers} onRefreshProviders={refreshProviders} onSaveApi={saveApiProvider} onVerifyApi={verifyApiProvider} onBridge={copyProviderBridge} />}</section><Inspector desktop={desktop} session={selected} note={note} setNote={setNote} onSend={sendInspectorMessage} onPause={() => interruptSelected(false)} onStop={() => interruptSelected(true)} onApproval={decideApproval} approvalBusy={approvalBusy} voice={voice} onVoice={toggleVoice} onFile={openSessionFile} onFocus={() => { setView("sessions"); setLayout("focus"); }} onArchive={archiveSelected} onMission={() => { if (!selected?.missionId) return; setMissionTarget({ missionId: selected.missionId, taskId: selected.taskId || null, panel: "conversation", tab: "graph", nonce: Date.now() }); setView("mission"); }} /></div>
      <footer className="status-bar"><span className={codexStatus.authenticated ? "" : "offline"}><i />{healthLabel}</span><button onClick={chooseWorkspace} title={workspace?.path || "Choose a local workspace"}><FolderOpen size={13} />{workspace?.name || (live ? "Open workspace" : "Desktop required")}</button><span><GitBranch size={13} />{workspace?.branch || "—"}</span><button onClick={() => loadThreads(workspace)}><ArrowsClockwise size={13} />Sync sessions</button><span>{live ? `${codexStatus.version || "Codex"}${codexStatus.account?.planType ? ` · ${codexStatus.account.planType}` : ""}` : "Browser preview · local runtime unavailable"}</span></footer>
    </section></>}
      </div>
    </div>
    {showNewSession && <NewSessionModal workspace={workspace} models={codexStatus.models || []} onChooseWorkspace={chooseWorkspace} onClose={() => setShowNewSession(false)} onCreate={createSession} />}
  </main>;
}
