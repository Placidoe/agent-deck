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
  const kind = current.url ? "public page read" : current.command ? "command" : current.path ? "file change" : "controlled action";
  const canDecide = awaitingDecision && commandAvailable && typeof onDecision === "function";

  if (current.url && awaitingDecision) return <section className="approval-action-panel state-requested public-read-approval" aria-label="公开网页读取批准">
    <header className="approval-action-heading"><ShieldWarning weight="fill" /><div><span className="eyebrow">需要你的许可</span><h3>读取这个公开网页？</h3></div></header>
    <code className="public-read-url">{current.url}</code>
    <p className="approval-action-summary">网站会收到网络请求，但不会携带登录信息。本轮执行和独立复核可读取此地址；不允许跳转、发布或上传资料。</p>
    <footer className="approval-action-controls">{canDecide ? <><button type="button" onClick={() => onDecision("decline")} disabled={busy}><XCircle size={15} />不访问</button><button type="button" className="approve-action" onClick={() => onDecision("accept")} disabled={busy}><CheckCircle size={15} />{busy ? "正在提交…" : "批准本轮读取"}</button></> : <p>当前没有可用的批准通道，尚未访问网页。</p>}</footer>
  </section>;

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
      {current.url ? <div className="approval-action-code"><dt>公开网页 URL</dt><dd><code>{current.url}</code></dd></div> : null}
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
      {canDecide ? <><button type="button" onClick={() => onDecision("decline")} disabled={busy}><XCircle size={15} />{current.url ? "不访问" : "Decline"}</button><button type="button" className="approve-action" onClick={() => onDecision("accept")} disabled={busy}><CheckCircle size={15} />{busy ? "Sending decision…" : current.url ? "批准本轮读取" : "Approve action"}</button></> : <p><Clock size={15} />{commandAvailable ? "A decision command is not available for this action." : "This preview has no connected approval command. The action remains unrun."}</p>}
    </footer>}
    {current.state === "executing" && <p className="approval-action-live"><TerminalWindow size={15} />The worker is running only the approved action.</p>}
  </section>;
}
