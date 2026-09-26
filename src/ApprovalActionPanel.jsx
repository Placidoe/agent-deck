import { CheckCircle, Clock, FileText, Play, ShieldWarning, TerminalWindow, WarningCircle, XCircle } from "@phosphor-icons/react";
import { actionCanBeDecided, actionStateLabels, actionTimeline, normalizeApprovalAction } from "./approval-action-model.js";
import "./approval-action.css";

function displayTime(value) {
  if (!value) return "Not recorded";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function StateIcon({ state }) {
  if (state === "failed" || state === "declined") return <XCircle weight="fill" />;
  if (state === "requested") return <ShieldWarning weight="fill" />;
  if (state === "executing") return <Play weight="fill" />;
  return <CheckCircle weight="fill" />;
}

export function ApprovalActionPanel({ action, onDecision, commandAvailable = false, busy = false }) {
  const current = normalizeApprovalAction(action);
  const awaitingDecision = actionCanBeDecided(current);
  const kind = current.command ? "command" : current.path ? "file change" : "controlled action";
  const canDecide = awaitingDecision && commandAvailable && typeof onDecision === "function";

  return <section className={`approval-action-panel state-${current.state}`} aria-label={`Action approval: ${actionStateLabels[current.state]}`}>
    <header className="approval-action-heading">
      <StateIcon state={current.state} />
      <div><span className="eyebrow">API WORKER · CONTROLLED ACTION</span><h3>{actionStateLabels[current.state]}</h3></div>
    </header>

    <p className="approval-action-summary">{current.summary}</p>
    <ol className="approval-action-timeline" aria-label="Action progress">
      {actionTimeline(current).map((step) => <li key={step.state} className={`${step.active ? "active" : ""} ${step.current ? "current" : ""}`}><i aria-hidden="true" /><span>{step.label}</span>{step.at ? <time dateTime={step.at}>{displayTime(step.at)}</time> : null}</li>)}
    </ol>

    <dl className="approval-action-details">
      <div><dt>Proposed {kind}</dt><dd>{current.tool}</dd></div>
      {current.command ? <div className="approval-action-code"><dt>Command</dt><dd><code>{current.command}</code></dd></div> : null}
      {current.path ? <div className="approval-action-code"><dt>Target file</dt><dd><code>{current.path}</code></dd></div> : null}
      {current.operation ? <div><dt>Git operation</dt><dd>{current.operation}</dd></div> : null}
      {current.detail ? <div><dt>Context</dt><dd>{current.detail}</dd></div> : null}
      {current.risk ? <div><dt>Risk</dt><dd>{current.risk}</dd></div> : null}
      {current.decision ? <div><dt>Decision</dt><dd>{String(current.decision)}</dd></div> : null}
    </dl>

    {(current.result || ["executed", "failed", "declined"].includes(current.state)) && <section className="approval-action-receipt" aria-label="Action receipt">
      {current.state === "failed" ? <WarningCircle weight="fill" /> : current.state === "declined" ? <ShieldWarning weight="fill" /> : <FileText weight="fill" />}
      <div><strong>{current.state === "declined" ? "No execution occurred" : current.state === "failed" ? "Execution reported a failure" : "Execution receipt"}</strong><span>{current.result || (current.state === "declined" ? "The request was declined before the worker ran it." : "The runtime did not provide additional output.")}</span></div>
    </section>}

    {awaitingDecision && <footer className="approval-action-controls">
      {canDecide ? <><button type="button" onClick={() => onDecision("decline")} disabled={busy}><XCircle size={15} />Decline</button><button type="button" className="approve-action" onClick={() => onDecision("accept")} disabled={busy}><CheckCircle size={15} />{busy ? "Sending decision…" : "Approve action"}</button></> : <p><Clock size={15} />{commandAvailable ? "A decision command is not available for this action." : "This preview has no connected approval command. The action remains unrun."}</p>}
    </footer>}
    {current.state === "executing" && <p className="approval-action-live"><TerminalWindow size={15} />The worker is running only the approved action.</p>}
  </section>;
}
