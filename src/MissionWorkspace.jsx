import { ExecutionModeField } from "./ExecutionModeField.jsx";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight, ArrowSquareOut, ArrowsClockwise, ArrowsInSimple, ArrowsOutSimple, Broadcast, ChatCircleText, Check, CheckCircle, Clock, Copy, Database,
  DownloadSimple, Eye, FileCode, FileText, FolderOpen, GitBranch, Graph, Kanban, ListChecks,
  LockKey, MagnifyingGlass, PaperPlaneTilt, Play, Plus, ShieldCheck, Sparkle,
  ShareNetwork, TerminalWindow, TreeStructure, Warning, X,
} from "@phosphor-icons/react";
import { applyNodeChanges, Background, Controls, Handle, MiniMap, Position, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { AgentAvatar } from "./AgentAvatar";
import { ApprovalActionPanel } from "./ApprovalActionPanel";
import { reviewGate, reviewGateGuidance } from "./review-gate.js";
import { autoLayoutMission, criticalMissionPath, dependencyImpact, missionPath, planImpact, validateMissionDag } from "./mission-graph";
import { conversationFromThread } from "./mission-conversation";
import { canChangeMissionWorkspace, isWorkspaceBlocker, nextMissionAction } from "./mission-next-action";
import "./mission.css";
import "./workspace-design.css";

const statusOrder = ["running", "claiming", "waiting_approval", "review", "blocked", "queued", "completed", "canceled"];

function taskStateLabel(task) {
  return ({ queued: "Queued", claiming: "Claiming", running: "Running", waiting_approval: "Needs approval", review: "Review", blocked: "Blocked", completed: "Verified", canceled: "Canceled" })[task?.status] || task?.status || "Unknown";
}

function missionStateLabel(status) {
  return ({ planning: "Planning", ready: "Awaiting approval", running: "Workers running", review: "Review required", blocked: "Blocked", ready_to_integrate: "Ready to integrate", integrating: "Integrating", integration_conflict: "Integration conflict", completed: "Completed", failed: "Failed", canceled: "Canceled" })[status] || status || "Unknown";
}

function statusTone(status) {
  if (["blocked", "waiting_approval", "failed", "integration_conflict"].includes(status)) return "attention";
  if (status === "completed") return "completed";
  if (["running", "claiming", "planning"].includes(status)) return "running";
  return "queued";
}

function blockerResolution(task) {
  if (!task || task.status !== "blocked") return null;
  const reason = task.error || task.result?.blockers?.filter(Boolean).join("；") || "Worker stopped before returning a verifiable result.";
  if (isWorkspaceBlocker(task)) return {
    reason: "工作区未满足隔离执行条件",
    detail: "这不是模型错误。请在画布上更换为有提交记录的具体 Git 项目；更换后需重新审阅并批准计划。若已在原目录修复 Git，可点击下方重新检查。重复发消息不能解决此问题。",
    suggestion: reason,
    primaryLabel: "重新检查工作区并启动",
    action: "retry",
  };
  const interrupted = task.phase === "interrupted" || /interrupt(ed|ion)/i.test(reason);
  if (interrupted && task.agentThreadId) return {
    reason: "Codex Turn 被中断",
    detail: "通常由 App 重启、重新打包或手动停止造成。已有会话、Worktree 与文件改动仍会保留。",
    suggestion: "请从刚才中断的位置继续完成原任务，先检查当前 Worktree 与已有产物，避免重复工作；完成后返回可验证结果。",
    primaryLabel: "从中断处继续",
    action: "resume",
  };
  if (!task.agentThreadId) return {
    reason: /merge conflict/i.test(reason) ? "依赖分支存在真实 Git 冲突" : "Worker 尚未成功创建",
    detail: /merge conflict/i.test(reason) ? "冲突发生在创建 Worker Thread 之前。系统会保留当前 Worktree，并创建真实 Worker 处理冲突后继续任务。" : "当前任务没有自己的 Codex Thread，不能向它发送消息；可以重新启动真实 Worker。",
    suggestion: reason,
    primaryLabel: /merge conflict/i.test(reason) ? "启动冲突处理 Worker" : "重新启动 Worker",
    action: "retry",
  };
  return {
    reason,
    detail: "Worker 不会自行越过这个错误。你可以把建议指令发回原会话，或重新派发一个 Worker。",
    suggestion: `请处理这个阻塞并继续原任务：${reason}。保留已有工作，完成后返回可验证结果；如果仍无法推进，请明确列出需要我提供的信息。`,
    primaryLabel: "发送建议并继续",
    action: "resume",
  };
}

function relativeTime(value) {
  if (!value) return "—";
  const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return undefined;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);
  return reduced;
}

function LongText({ text, limit = 6000, className = "" }) {
  const [expanded, setExpanded] = useState(false);
  const value = String(text || "");
  const clipped = !expanded && value.length > limit;
  return <div className={`long-text ${className}`}><pre>{clipped ? `${value.slice(0, limit)}\n\n… ${value.length - limit} more characters` : value}</pre>{value.length > limit && <button type="button" onClick={() => setExpanded((current) => !current)}>{expanded ? "Collapse" : "Show full output"}</button>}</div>;
}

function StructuredConversationDetails({ entry }) {
  if (entry.structuredResult) {
    const { acceptance, blockers, changedFiles } = entry.structuredResult;
    if (!acceptance.length && !blockers.length && !changedFiles.length) return null;
    return <div className="conversation-result-card">
      {acceptance.length ? <section><strong>Verification</strong>{acceptance.map((item, index) => <div className={item.passed ? "passed" : "failed"} key={`${item.criterion}-${index}`}><CheckCircle size={13} weight="fill" /><span><b>{item.criterion}</b>{item.evidence ? <small>{item.evidence}</small> : null}</span></div>)}</section> : null}
      {changedFiles.length ? <section><strong>Changed files</strong>{changedFiles.map((file) => <code key={file}>{file}</code>)}</section> : null}
      {blockers.length ? <section className="blockers"><strong>Blockers</strong>{blockers.map((blocker) => <p key={blocker}>{blocker}</p>)}</section> : null}
    </div>;
  }
  if (entry.structuredPlan) {
    return <div className="conversation-plan-card"><strong>{entry.structuredPlan.title}</strong><span>{entry.structuredPlan.tasks.length} Worker tasks planned</span><div>{entry.structuredPlan.tasks.map((task) => <p key={task.key || task.title}><code>{task.key}</code><b>{task.title}</b><small>{task.agentRole}</small></p>)}</div></div>;
  }
  return null;
}

const AgentNode = memo(function AgentNode({ data }) {
  const horizontal = data.layoutMode === "horizontal";
  return <div className={`agent-node ${data.tone} ${data.critical ? "critical" : ""} ${data.selected ? "selected" : ""} ${data.dimmed ? "dimmed" : ""}`}>
    <Handle type="target" position={horizontal ? Position.Left : Position.Top} isConnectable={data.editable} />
    <AgentAvatar name={data.name} role={data.role} main={data.main} size="lg" status={data.tone} />
    <div className="agent-node-copy"><strong>{data.name}</strong><span>{data.role}</span><small>{data.phase}{data.runCount ? ` · ${data.runCount} run${data.runCount > 1 ? "s" : ""}` : ""}</small></div>
    <div className="agent-node-state"><i />{data.state}</div>
    {data.artifactCount ? <span className="agent-node-artifacts"><FileCode size={10} />{data.artifactCount}</span> : null}
    {!data.main && <button type="button" className="agent-node-message nodrag" title="Open conversation" onClick={(event) => { event.stopPropagation(); data.onMessage?.(); }}><ChatCircleText size={12} /></button>}
    <Handle type="source" position={horizontal ? Position.Right : Position.Bottom} isConnectable={data.editable} />
  </div>;
});

const nodeTypes = { agent: AgentNode };

function providerActivity(event) {
  const item = event.payload?.item || {};
  const turn = event.payload?.turn || {};
  const providerName = turn.provider === "deepseek" ? "DeepSeek API" : turn.provider === "openai_compatible" ? "API Harness" : "Codex";
  if (event.type === "provider.turn/started") return { kind: "TURN", title: `${providerName} turn started`, detail: turn.id || event.threadId };
  if (event.type === "provider.turn/completed") return { kind: turn.status === "completed" ? "DONE" : "ERROR", title: `${providerName} turn ${turn.status || "completed"}`, detail: turn.error?.message || turn.id };
  if (event.type === "provider.turn/plan/updated") return { kind: "PLAN", title: "Execution plan updated", detail: event.payload?.plan?.map?.((step) => step.step).filter(Boolean).join(" · ") };
  if (event.type === "provider.item/started") {
    if (item.type === "commandExecution") return { kind: "RUN", title: "Command started", detail: item.command };
    if (item.type === "fileChange") return { kind: "EDIT", title: "Preparing file changes", detail: (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean).join(", ") };
    if (item.type === "gitOperation") return { kind: "GIT", title: "Git operation started", detail: item.operation || item.command || "Workspace Git operation" };
    if (item.type === "webSearch") return { kind: "SEARCH", title: "Web search", detail: item.query };
    if (["mcpToolCall", "dynamicToolCall"].includes(item.type)) return { kind: "TOOL", title: "Tool call started", detail: item.tool || item.name || item.server };
  }
  if (event.type === "provider.item/completed") {
    if (item.type === "commandExecution") return { kind: item.status === "completed" ? "PASS" : "ERROR", title: item.status === "completed" ? "Command completed" : "Command failed", detail: [item.command, item.aggregatedOutput || item.output].filter(Boolean).join("\n") };
    if (item.type === "fileChange") return { kind: "EDIT", title: "Files changed", detail: (item.changes || []).map((change) => change.path || change.filePath).filter(Boolean).join(", ") || "Workspace diff updated" };
    if (item.type === "gitOperation") return { kind: item.status === "completed" ? "PASS" : "ERROR", title: item.status === "completed" ? "Git operation completed" : "Git operation failed", detail: item.operation || item.command || "Workspace Git operation" };
    if (item.type === "agentMessage") return { kind: "REPLY", title: "Agent response recorded", detail: item.text || "The reply is available in Conversation." };
    if (["mcpToolCall", "dynamicToolCall"].includes(item.type)) return { kind: "TOOL", title: "Tool call completed", detail: item.tool || item.name || item.server };
  }
  if (event.type.startsWith("bus.tool.")) return { kind: "BUS", title: event.type.slice("bus.tool.".length).replaceAll("_", " "), detail: JSON.stringify(event.payload?.output || {}) };
  return null;
}

function MissionSidebar({ missions, mission, selectedTaskId, onSelectMission, onSelectTask, onNewMission, onResizeStart }) {
  const [search, setSearch] = useState("");
  const tasks = (mission?.tasks || []).filter((task) => `${task.key} ${task.title} ${task.agentRole}`.toLowerCase().includes(search.toLowerCase()));
  const groups = statusOrder.map((status) => [status.replaceAll("_", " ").toUpperCase(), tasks.filter((task) => task.status === status)]).filter(([, items]) => items.length);
  const completed = mission?.tasks?.filter((task) => task.status === "completed").length || 0;
  const total = mission?.tasks?.length || 0;
  return <aside className="mission-sidebar">
    <header><div><span className="eyebrow">REAL ORCHESTRATION</span><h1>Mission <b>{missions.length}</b></h1></div><button className="new-icon" onClick={onNewMission} aria-label="New mission"><Plus size={17} /></button></header>
    <div className="mission-sidebar-controls">
      {missions.length > 1 && <select className="mission-picker" value={mission?.id || ""} onChange={(event) => onSelectMission(event.target.value)}>{missions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select>}
      <div className="mission-search"><MagnifyingGlass size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search real tasks" /></div>
      {mission && <div className="mission-summary"><div><span>Status</span><strong>{missionStateLabel(mission.status)}</strong></div><small><CheckCircle size={13} weight="fill" /> {completed}/{total} tasks user-verified</small></div>}
    </div>
    <div className="task-groups">{groups.map(([label, items]) => <section key={label}><h3>{label}<b>{items.length}</b></h3>{items.map((task) => <button key={task.id} className={`task-row ${statusTone(task.status)} ${selectedTaskId === task.id ? "selected" : ""}`} onClick={() => onSelectTask(task.id)}><div className="task-row-top"><code>{task.key}</code><span>{taskStateLabel(task)}</span></div><div className="task-row-identity"><AgentAvatar name={task.agentRole} role={task.agentRole} size="sm" status={statusTone(task.status)} /><div><strong>{task.title}</strong><span>{task.agentRole}</span></div></div><div className="task-row-meta"><span>{task.phase}</span></div></button>)}</section>)}</div>
    <footer><LockKey size={14} /><span>Truth source</span><strong>SQLite + Codex</strong></footer>
    <div className="mission-sidebar-resizer" onPointerDown={onResizeStart} role="separator" aria-label="Resize mission sidebar" />
  </aside>;
}

function MessageBus({ messages, compact = false }) {
  const [filter, setFilter] = useState("all");
  const visible = messages.filter((item) => filter === "all" || item.messageType === filter);
  const deliveryLabel = { sending: "投递中", delivered: "已送达", failed: "未送达", recorded: "已记录", waiting: "等待中", ack: "已确认" };
  return <section className={`message-bus ${compact ? "compact" : ""}`}>
    <header><div><Broadcast size={16} weight="duotone" /><strong>Message bus</strong><span>{messages.length} persisted</span></div><nav>{["all", "command", "request", "response", "event"].map((item) => <button key={item} className={filter === item ? "active" : ""} onClick={() => setFilter(item)}>{item}</button>)}</nav><div className="bus-health"><i /> Ledger</div></header>
    <div className="bus-list">{visible.length ? visible.map((message) => <article className="bus-message" key={message.id}><div className={`message-kind ${message.messageType}`}>{message.messageType === "request" ? <ArrowRight /> : message.messageType === "response" ? <Check /> : <Broadcast />}</div><div className="bus-copy"><header><strong>{message.fromAgent}</strong><ArrowRight size={11} /><span>{message.toAgent}</span><code>{message.topic}</code><time>{relativeTime(message.createdAt)}</time></header><p>{message.text}</p>{message.error && <small className="message-delivery-error" title={message.error}>失败原因：{message.error}</small>}</div><span className={`delivery ${message.deliveryStatus}`}>{deliveryLabel[message.deliveryStatus] || message.deliveryStatus}</span></article>) : <div className="empty-list">No durable agent messages yet.</div>}</div>
  </section>;
}

function TaskTable({ tasks, onSelectTask }) {
  return <section className="mission-table-view"><header><div><span className="eyebrow">EXECUTION LEDGER</span><h2>真实任务状态与执行证据</h2></div></header><div className="task-table"><div className="task-table-head"><span>Task</span><span>Owner</span><span>State</span><span>Evidence</span><span>Isolation</span></div>{tasks.map((task) => <button key={task.id} onClick={() => onSelectTask(task.id)}><div><code>{task.key}</code><strong>{task.title}</strong></div><span>{task.agentRole}</span><span><i className={`status-dot ${statusTone(task.status)}`} />{taskStateLabel(task)}</span><p>{task.error || task.result?.summary || task.description}</p><div><b>{task.branch || "Not created"}</b></div></button>)}</div></section>;
}

function SpecList({ label, items = [], checks = false }) {
  return <article className="spec-card"><label>{label}</label><ul className={checks ? "checks" : ""}>{items.map((item) => <li key={item}>{checks && <Clock size={13} />}{item}</li>)}</ul></article>;
}

function SpecView({ mission, onApprove, onRetryPlan, busy }) {
  const spec = mission.spec;
  if (mission.status === "planning") return <section className="mission-empty"><Sparkle size={30} weight="duotone" /><h2>Main Agent 正在生成真实需求表单</h2><p>Planner Thread：{mission.mainThreadId || "正在创建"}</p><small>状态只由 Codex Turn 事件更新。</small></section>;
  if (!spec) return <section className="mission-empty"><Warning size={30} /><h2>需求表单生成失败</h2><p>{/invalid_json_schema|Invalid structured output schema/.test(mission.error || "") ? "生成计划的输出结构不符合模型要求。更新到修复版后，可以在原会话重新生成；确认计划前不会启动子任务。" : mission.error || "No structured plan was persisted."}</p>{mission.status === "failed" && mission.mainThreadId && !mission.tasks.length && <button className="primary-button" disabled={busy} onClick={onRetryPlan}><ArrowsClockwise size={16} />{busy ? "正在提交…" : "重新生成计划"}</button>}<details><summary>技术详情</summary><p>{mission.error}</p></details></section>;
  const runtime = spec.runtime || {};
  const routeLabel = runtime.mode === "direct" ? "直通执行 · 跳过 Planner" : runtime.tier === "orchestrated" ? "复杂编排" : "协同编排";
  return <section className="spec-view"><header><div><span className="eyebrow">REQUIREMENT FORM · {runtime.mode === "direct" ? "ADAPTIVE DIRECT" : "CODEX GENERATED"}</span><h2>{spec.title}</h2><p>{routeLabel}{mission.mainThreadId ? ` · 来源 Thread：${mission.mainThreadId}` : " · 一个 Worker 保持完整上下文"}</p></div>{mission.status === "ready" && <button className="approve-plan" onClick={onApprove} disabled={busy}><Play size={15} weight="fill" />{busy ? "Dispatching…" : "Approve & dispatch real workers"}</button>}</header><div className="spec-grid"><article className="spec-card wide"><label>OUTCOME</label><p>{spec.outcome}</p></article><SpecList label="SCOPE" items={spec.scope} /><SpecList label="NON-GOALS" items={spec.nonGoals} /><SpecList label="ACCEPTANCE" items={spec.acceptanceCriteria} checks /><SpecList label="CONSTRAINTS" items={spec.constraints} /></div></section>;
}

function cny(value) {
  return `¥${Number(value || 0).toLocaleString("zh-CN", { maximumFractionDigits: 2 })}`;
}

function ValueLedgerView({ desktop, mission, busy, onMissionChange, onNotice }) {
  const [ledger, setLedger] = useState(null);
  const [contract, setContract] = useState(mission.valueContract || {});
  const [entry, setEntry] = useState({ eventType: "confirmed_value", amountCny: "", note: "" });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const reload = async () => {
    setLoading(true);
    try { setLedger(await desktop.missions.valueLedger(mission.id)); }
    catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setLoading(false); }
  };
  useEffect(() => { setContract(mission.valueContract || {}); reload(); }, [mission.id, mission.updatedAt]);
  const update = (key, value) => setContract((current) => ({ ...current, [key]: value }));
  const saveContract = async (event) => {
    event.preventDefault(); setError(""); setLoading(true);
    try { const updated = await desktop.missions.updateValueContract({ missionId: mission.id, contract }); onMissionChange(updated); await reload(); onNotice("价值契约已保存；后续调度会优先选择更高边际价值的就绪任务。"); }
    catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setLoading(false); }
  };
  const record = async (event) => {
    event.preventDefault(); setError(""); setLoading(true);
    try { const result = await desktop.missions.recordValue({ missionId: mission.id, ...entry, amountCny: Number(entry.amountCny || 0) }); setLedger(result.ledger); setEntry({ eventType: "confirmed_value", amountCny: "", note: "" }); onNotice("价值证据已记入本地账本。"); }
    catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setLoading(false); }
  };
  const costs = ledger?.costs || {}; const value = ledger?.value || {};
  const roi = value.realizedRoi ?? value.projectedRoi;
  const tokenSource = costs.tokenSource === "provider_reported" ? "Provider reported" : "Local estimate";
  return <section className="value-ledger-view"><header><div><span className="eyebrow">VALUE LEDGER · {tokenSource.toUpperCase()}</span><h2>让每次 Mission 对齐成本与结果</h2><p>优先使用 API 实际返回的 Token；没有使用量时再回退为本地可复核估算。已确认价值只来自你记录的证据。</p></div><span className={`roi-pill ${roi == null ? "unknown" : roi >= 0 ? "positive" : "negative"}`}>{roi == null ? "ROI 待定义" : `${roi >= 0 ? "+" : ""}${roi}x ${value.realizedRoi != null ? "已确认" : "预估"}`}</span></header>{error && <p className="value-error"><Warning size={14} />{error}</p>}<div className="value-kpis"><article><span>{costs.tokenSource === "provider_reported" ? "实际 Token" : "预估 Token"}</span><strong>{Number(costs.billedTokens || costs.estimatedTokens || 0).toLocaleString()}</strong><small>{costs.tokenSource === "provider_reported" ? `本地估算 ${Number(costs.estimatedTokens || 0).toLocaleString()} · ` : ""}预算剩余 {Number(costs.tokenBudgetRemaining || 0).toLocaleString()}</small></article><article><span>成本估算</span><strong>{cny(costs.totalCostCny)}</strong><small>模型 {cny(costs.estimatedModelCostCny)} · 人工 {cny(costs.manualCostCny)}</small></article><article><span>价值</span><strong>{cny(value.confirmedValueCny || value.plannedValueCny)}</strong><small>{value.confirmedValueCny ? "已确认" : "目标/基线预估"}</small></article><article><span>可验证产物</span><strong>{value.verifiedArtifacts || 0}</strong><small>{value.completedTasks || 0}/{value.totalTasks || 0} tasks verified</small></article></div><div className="value-ledger-grid"><form className="value-contract-card" onSubmit={saveContract}><header><strong>价值契约</strong><small>决定 Mission 的预算与调度方向</small></header><label>高价值场景<input value={contract.scenario || ""} onChange={(event) => update("scenario", event.target.value)} placeholder="例如：研发交付 / 技术选型" /></label><label>价值类型<select value={contract.valueType || "time_saved"} onChange={(event) => update("valueType", event.target.value)}><option value="time_saved">节省人时</option><option value="revenue">增收机会</option><option value="risk_avoided">风险避免</option><option value="decision_speed">决策提速</option><option value="knowledge_reuse">知识复用</option></select></label><label>成功信号<input value={contract.targetMetric || ""} onChange={(event) => update("targetMetric", event.target.value)} placeholder="例如：PR 合并且测试通过" /></label><div className="value-field-pair"><label>目标价值 ¥<input type="number" min="0" value={contract.expectedValueCny ?? 0} onChange={(event) => update("expectedValueCny", event.target.value)} /></label><label>人工基线 h<input type="number" min="0" step="0.5" value={contract.baselineHours ?? 0} onChange={(event) => update("baselineHours", event.target.value)} /></label></div><div className="value-field-pair"><label>Token 预算<input type="number" min="1000" value={contract.tokenBudget ?? 80000} onChange={(event) => update("tokenBudget", event.target.value)} /></label><label>模型估价 ¥/1k<input type="number" min="0" step="0.001" value={contract.tokenCostPer1kCny ?? 0.02} onChange={(event) => update("tokenCostPer1kCny", event.target.value)} /></label></div><button className="primary-button" disabled={busy || loading}>保存价值契约</button></form><div className="value-evidence-column"><form className="value-evidence-card" onSubmit={record}><header><strong>记录价值证据</strong><small>只有人或可信系统确认后才计入已确认 ROI</small></header><select value={entry.eventType} onChange={(event) => setEntry((current) => ({ ...current, eventType: event.target.value }))}><option value="confirmed_value">已确认价值</option><option value="avoided_cost">避免成本</option><option value="learning_asset">知识资产</option><option value="manual_cost">新增人工成本</option></select><input type="number" value={entry.amountCny} onChange={(event) => setEntry((current) => ({ ...current, amountCny: event.target.value }))} placeholder="金额（¥；人工成本填负数）" /><textarea value={entry.note} onChange={(event) => setEntry((current) => ({ ...current, note: event.target.value }))} placeholder="写下证据：谁确认、链接或采用情况…" rows="3" /><button className="tool-button" disabled={busy || loading || !entry.note.trim()}>记入价值账本</button></form><section className="value-events"><header><strong>Evidence ledger</strong><small>{ledger?.disclaimer}</small></header>{ledger?.valueEvents?.length ? ledger.valueEvents.map((item) => <article key={item.id}><div><b>{item.eventType.replaceAll("_", " ")}</b><time>{relativeTime(item.createdAt)}</time></div><strong className={item.amountCny >= 0 ? "positive" : "negative"}>{item.amountCny >= 0 ? "+" : ""}{cny(item.amountCny)}</strong><p>{item.note}</p></article>) : <p className="value-empty">尚无已确认价值。先设定成功信号，完成后再以证据记账。</p>}</section></div></div></section>;
}

function isHtmlArtifact(file) {
  return /\.html?$/i.test(String(file || ""));
}

function isPublishableArtifact(file) {
  return /\.(html?|md|markdown|txt)$/i.test(String(file || ""));
}

function ArtifactCard({ missionId, artifact, onAction, onPublish, busy }) {
  const files = artifact.files || [];
  return <article className="artifact-card">
    <header><FileCode size={18} /><div><strong>{artifact.title}</strong><span>{artifact.verificationStatus} · {relativeTime(artifact.createdAt)}</span></div>{artifact.qualityScore != null && <span className={`artifact-quality ${artifact.qualityScore >= 90 ? "excellent" : "passing"}`} title="Agent Deck HTML report quality score">HTML {artifact.qualityScore}</span>}{onPublish && files.some(isPublishableArtifact) && <button onClick={() => onPublish(artifact, files.find(isPublishableArtifact))} disabled={busy} title="Prepare a CSDN / 掘金 publish draft" className="artifact-publish"><ShareNetwork size={15} /></button>}<button onClick={() => onAction("export", artifact)} disabled={busy} title="Export artifact"><DownloadSimple size={15} /></button></header>
    {artifact.summary && <p>{artifact.summary}</p>}
    {files.length > 0 ? <div className="artifact-files">{files.map((file) => {
      const html = isHtmlArtifact(file);
      return <div key={file}><button className={`artifact-file-open ${html ? "html" : ""}`} onClick={() => onAction(html ? "preview" : "open", artifact, file)} disabled={busy} title={html ? `Preview ${file}` : file}><FileText size={14} /><span>{file}</span>{html && <b>HTML</b>}{html ? <Eye size={13} /> : <ArrowSquareOut size={13} />}</button><button onClick={() => onAction("reveal", artifact, file)} disabled={busy} title="Reveal in Finder"><FolderOpen size={14} /></button><button onClick={() => onAction("export", artifact, file)} disabled={busy} title="Export a copy"><DownloadSimple size={14} /></button></div>;
    })}</div> : <small className="artifact-empty-file">Context record · no file attached</small>}
  </article>;
}

function ArtifactView({ mission, onAction, onPublish, onExportReport, busy }) {
  return <section className="artifact-view"><header><div><h2>工作产出</h2><p>来自真实执行记录。文件可以预览、导出或在访达中打开。</p></div><button className="approve-plan" onClick={onExportReport} disabled={busy}><DownloadSimple size={15} />导出工作报告</button></header>{mission.artifacts.length ? <div className="artifact-grid">{mission.artifacts.map((artifact) => <ArtifactCard key={artifact.id} missionId={mission.id} artifact={artifact} onAction={onAction} onPublish={onPublish} busy={busy} />)}</div> : <div className="mission-empty"><FileCode size={30} /><h2>No artifacts published yet</h2><p>Worker outputs and observed Git changes will appear here when they are recorded.</p></div>}</section>;
}

function PublishModal({ desktop, missionId, artifact, initialFile, onClose, onNotice }) {
  const files = (artifact.files || []).filter(isPublishableArtifact);
  const [file, setFile] = useState(initialFile || files[0] || "");
  const [platform, setPlatform] = useState("juejin");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [autoPublish, setAutoPublish] = useState(false);
  useEffect(() => {
    if (!file) return;
    let disposed = false;
    setBusy(true); setError("");
    desktop.artifacts.publication({ missionId, artifactId: artifact.id, file, platform }).then((next) => { if (!disposed) setDraft(next); }).catch((nextError) => { if (!disposed) setError(nextError.message || String(nextError)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [desktop, missionId, artifact.id, file, platform]);
  const input = { missionId, artifactId: artifact.id, file, platform };
  async function run(action) {
    setBusy(true); setError("");
    try {
      const result = await desktop.artifacts[action](input);
      if (action === "copyPublication") onNotice(`已复制 ${platform === "juejin" ? "掘金" : "CSDN"} 发布稿，可直接粘贴到编辑器。`);
      if (action === "exportPublication" && !result.canceled) onNotice(`发布稿已导出到 ${result.destination}`);
      if (action === "openPublisher") onNotice(`已打开 ${platform === "juejin" ? "掘金" : "CSDN"} 编辑器；请粘贴发布稿并手动确认发布。`);
    } catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setBusy(false); }
  }
  async function runBrowserPublisher(forceAutoPublish = autoPublish) {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      const result = await desktop.publisher.publish({ platform, title: draft.title, content: draft.content, autoPublish: forceAutoPublish });
      if (result.state === "needs_login_or_editor") onNotice("请在发布窗口完成首次登录或验证码；回到编辑器后 Agent Deck 会自动继续填入。");
      else if (!result.ok) setError(result.detail || "发布适配器暂时无法操作该编辑器；你仍可复制稿件后手动发布。");
      else if (result.state === "publish_requested") onNotice("已请求自动发布；发布窗口会保留，用于处理分类、标签或平台验证。");
      else onNotice("已自动填入发布窗口，请检查排版后发布。");
    } catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop publish-backdrop" onMouseDown={onClose}><section className="modal publish-modal" onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">PUBLISH ADAPTER</span><h2>生成并发布社区文章</h2><p>首次在隔离窗口手动登录；账号密码不进入 Agent Deck，后续自动复用该平台会话。</p></div><button type="button" className="quiet-button" onClick={onClose}><X size={19} /></button></header><div className="publish-controls"><label>Source<select value={file} onChange={(event) => setFile(event.target.value)}>{files.map((item) => <option key={item} value={item}>{item}</option>)}</select></label><label>Platform<select value={platform} onChange={(event) => setPlatform(event.target.value)}><option value="juejin">掘金</option><option value="csdn">CSDN</option></select></label></div>{error ? <p className="publish-error"><Warning size={14} />{error}</p> : null}{busy && !draft ? <div className="publish-loading"><Clock size={16} />正在转换产物…</div> : draft ? <><section className="publish-summary"><strong>{draft.sourceFormat.toUpperCase()} → Markdown</strong><span>{draft.content.length.toLocaleString()} characters · {platform === "juejin" ? "掘金" : "CSDN"} compatible</span></section><textarea className="publish-content" readOnly value={draft.content} aria-label="Publish-ready Markdown" /> <section className="publish-warnings"><strong>发布前检查</strong><ul>{draft.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul></section><label className="auto-publish-toggle"><input type="checkbox" checked={autoPublish} onChange={(event) => setAutoPublish(event.target.checked)} /><span><strong>自动点击发布（Beta）</strong><small>公开发布动作；平台若要求分类、标签、验证码或二次确认，窗口会保留供你处理。</small></span></label></> : null}<footer><button type="button" className="tool-button" onClick={onClose}>Close</button><button type="button" className="tool-button" disabled={busy || !draft} onClick={() => run("exportPublication")}><DownloadSimple size={14} />导出 .md</button><button type="button" className="tool-button" disabled={busy || !draft} onClick={() => runBrowserPublisher(false)}><ArrowSquareOut size={14} />登录并自动填入</button><button type="button" className="tool-button" disabled={busy || !draft} onClick={() => run("copyPublication")}><Copy size={14} />复制稿件</button><button type="button" className="primary-button" disabled={busy || !draft} onClick={() => runBrowserPublisher()}><ShareNetwork size={14} />{autoPublish ? "自动填入并发布" : "自动填入发布页"}</button></footer></section></div>;
}

function ContextKernelView({ desktop, mission, task }) {
  const [brief, setBrief] = useState(null);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const taskId = task?.id || null;
  useEffect(() => {
    if (!desktop?.missions?.contextBrief || !mission?.id) return undefined;
    let cancelled = false;
    setLoading(true); setError("");
    desktop.missions.contextBrief({ missionId: mission.id, taskId, tokenBudget: 4200 }).then((next) => {
      if (!cancelled) setBrief(next);
    }).catch((nextError) => { if (!cancelled) setError(nextError.message || String(nextError)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [desktop, mission?.id, taskId]);
  async function runSearch(event) {
    event.preventDefault();
    if (!query.trim() || !desktop?.missions?.contextSearch) return;
    setLoading(true); setError("");
    try { setSearch(await desktop.missions.contextSearch({ missionId: mission.id, taskId, query: query.trim(), limit: 16 })); }
    catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setLoading(false); }
  }
  const stats = brief?.stats;
  return <section className="context-kernel-view">
    <header><div><span className="eyebrow">CONTEXT KERNEL · LOCAL TRAJECTORY</span><h2>给 Agent 的上下文，不再靠全量聊天记录</h2><p>从本机 SQLite 的任务、检查点、产物、事件和文件引用中按相关性与预算组合。不会把私有对话全文广播给其他 Worker。</p></div><span className="context-local"><Database size={14} />本地索引</span></header>
    {error && <div className="context-error"><Warning size={16} weight="fill" />{error}</div>}
    {loading && !brief ? <div className="mission-empty"><Clock size={24} /><p>正在从本地 Mission 轨迹构建 Context Brief…</p></div> : <>
      <div className="context-metrics">
        <article><small>本轮估算上下文</small><strong>{stats?.estimatedTokens?.toLocaleString() || "—"}</strong><span>/ {stats?.tokenBudget?.toLocaleString() || "—"} tokens</span></article>
        <article className="saved"><small>相较全量轨迹</small><strong>{stats?.reductionPercent ?? 0}%</strong><span>少约 {stats?.estimatedSavedTokens?.toLocaleString() || 0} tokens</span></article>
        <article><small>本轮带入 / 暂不带入</small><strong>{stats?.included || 0} / {stats?.withheld || 0}</strong><span>{stats?.indexedNodes || 0} nodes · {stats?.indexedEdges || 0} links</span></article>
      </div>
      <section className="context-contract"><span className="eyebrow">STABLE CONTRACT</span><h3>{brief?.stableContract?.title || mission.title}</h3><p>{brief?.stableContract?.outcome || mission.outcome}</p>{brief?.task && <div><code>{brief.task.key}</code><strong>{brief.task.title}</strong></div>}</section>
      <section className="context-section"><header><div><h3>本轮被选中的上下文</h3><p>每一条都有可回溯引用；上游完成检查点优先于聊天摘要。</p></div><span>{stats?.included || 0} 条</span></header><div className="context-cards">{[...(brief?.dependencyCheckpoints || []), ...(brief?.evidence || [])].map((item) => <article key={item.ref}><div><span className={`context-kind ${item.type}`}>{item.type.replaceAll("_", " ")}</span><code>{item.ref}</code></div><strong>{item.title}</strong><p>{item.text}</p><small>{item.reason} · ~{item.estimatedTokens} tokens</small></article>)}{!(brief?.dependencyCheckpoints?.length || brief?.evidence?.length) && <div className="context-empty">此 Mission 暂无可复用检查点；系统只会带入稳定任务契约。</div>}</div></section>
      <section className="context-search"><header><div><h3>检索真实轨迹</h3><p>按文件名、任务、产物、事件或关键词定位；不会重新读取整个会话。</p></div></header><form onSubmit={runSearch}><MagnifyingGlass size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="例如：report.html、验收标准、TASK-02" /><button type="submit" disabled={loading || !query.trim()}>检索</button></form>{search && <div className="context-search-results">{search.items.length ? search.items.map((item) => <article key={item.ref}><div><span className={`context-kind ${item.kind}`}>{item.kind}</span><code>{item.ref}</code><b>{item.confidence}</b></div><strong>{item.title}</strong><p>{item.summary}</p>{item.filePath && <small>文件：{item.filePath}</small>}<footer>{item.reasons.join("、") || "相关轨迹"} · score {item.score}</footer></article>) : <div className="context-empty">没有匹配记录。换一个关键词，或等待 Worker 发布可复用产物。</div>}</div>}</section>
    </>}
  </section>;
}

function MissionDecisionDock({ mission, onOpen, onSecondary, onApprove, onWorkspace, onMode, busy }) {
  const action = nextMissionAction(mission);
  if (!action) return null;
  const Icon = action.icon === "plan" ? ListChecks : action.icon === "review" ? ShieldCheck : action.icon === "integration" ? GitBranch : Warning;
  return <section className={`mission-decision-dock ${action.tone} ${action.kind}`} data-testid="mission-decision-dock">
    <Icon size={17} weight="fill" />
    <div className="mission-decision-copy"><span className="eyebrow">下一步</span><strong>{action.title}</strong><p>{action.detail}</p></div>
    <div className="mission-decision-actions">
      {canChangeMissionWorkspace(mission) && <button type="button" className="tool-button" onClick={onMode} disabled={busy}>{mission.executionMode === "research" ? "改为代码开发" : "改为调研与文档"}</button>}
      {canChangeMissionWorkspace(mission) && <button type="button" className="tool-button" onClick={onWorkspace} disabled={busy} title={mission.cwd}><FolderOpen size={14} />更换工作区</button>}
      <button type="button" className="tool-button" onClick={() => onSecondary(action)}>{action.secondaryLabel}</button>
      <button type="button" className="primary-button" onClick={() => onOpen(action)} disabled={busy}>{action.primaryLabel}<ArrowRight size={14} /></button>
      {action.kind === "plan" ? <button type="button" className="decision-start" onClick={onApprove} disabled={busy}><Play size={14} weight="fill" />{busy ? "正在启动…" : "批准并运行"}</button> : null}
    </div>
  </section>;
}

function PlanEditor({ mission, draft, setDraft, selectedKey, setSelectedKey, onSave, onClose, busy }) {
  const tasks = draft.tasks || [];
  const selected = tasks.find((task) => task.key === selectedKey) || tasks[0] || null;
  const diagnostics = validateMissionDag(tasks);
  const impact = planImpact(mission.tasks, tasks);
  function patchTask(patch) {
    setDraft((current) => ({ ...current, tasks: current.tasks.map((task) => task.key === selected.key ? { ...task, ...patch } : task) }));
  }
  function addTask() {
    let index = tasks.length + 1;
    let key = `TASK_${index}`;
    while (tasks.some((task) => task.key === key)) key = `TASK_${++index}`;
    setDraft((current) => ({ ...current, tasks: [...current.tasks, { key, title: "New worker task", description: "Describe the verifiable outcome for this worker.", agentRole: "Implementation worker", dependencies: [], acceptanceCriteria: ["Produces verifiable evidence"] }] }));
    setSelectedKey(key);
  }
  function removeTask() {
    if (!selected || tasks.length <= 1) return;
    const next = tasks.filter((task) => task.key !== selected.key).map((task) => ({ ...task, dependencies: (task.dependencies || []).filter((key) => key !== selected.key) }));
    setDraft((current) => ({ ...current, tasks: next }));
    setSelectedKey(next[0]?.key || null);
  }
  return <aside className="plan-editor" data-testid="plan-editor">
    <header><div><span className="eyebrow">SAFE PLAN EDITOR</span><strong>Edit before dispatch</strong><small>No Thread or Worktree has started.</small></div><button type="button" onClick={onClose}><X size={16} /></button></header>
    <div className="plan-editor-tasks"><select value={selected?.key || ""} onChange={(event) => setSelectedKey(event.target.value)}>{tasks.map((task) => <option key={task.key} value={task.key}>{task.key} · {task.title}</option>)}</select><button type="button" onClick={addTask}><Plus size={13} />Task</button><button type="button" onClick={removeTask} disabled={tasks.length <= 1}><X size={13} />Remove</button></div>
    {selected && <div className="plan-editor-form">
      <label>Key<input value={selected.key} disabled title="Stable task keys cannot be renamed; create a new task instead." /></label>
      <label>Title<input value={selected.title} onChange={(event) => patchTask({ title: event.target.value })} /></label>
      <label>Agent role<input value={selected.agentRole} onChange={(event) => patchTask({ agentRole: event.target.value })} /></label>
      <label>Description<textarea value={selected.description} onChange={(event) => patchTask({ description: event.target.value })} /></label>
      <fieldset><legend>Dependencies</legend>{tasks.filter((task) => task.key !== selected.key).map((task) => <label key={task.key}><input type="checkbox" checked={(selected.dependencies || []).includes(task.key)} onChange={(event) => patchTask({ dependencies: event.target.checked ? [...(selected.dependencies || []), task.key] : (selected.dependencies || []).filter((key) => key !== task.key) })} /><span>{task.key}</span><small>{task.title}</small></label>)}</fieldset>
      <label>Acceptance criteria<textarea value={(selected.acceptanceCriteria || []).join("\n")} onChange={(event) => patchTask({ acceptanceCriteria: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label>
    </div>}
    <footer><div className={diagnostics.valid ? "valid" : "invalid"}>{diagnostics.valid ? <><CheckCircle size={13} />DAG valid</> : <><Warning size={13} />{diagnostics.cycles.length ? `Cycle: ${diagnostics.cycles[0].join(" → ")}` : diagnostics.missing.length ? "Missing dependency" : "Self dependency"}</>}<small>{impact.total ? `${impact.added.length} added · ${impact.removed.length} removed · ${impact.changed.length} changed` : "No unsaved changes"}</small></div><button type="button" className="primary-button" disabled={busy || !diagnostics.valid || !impact.total || tasks.some((task) => !task.title.trim() || !task.description.trim() || !task.agentRole.trim() || !task.acceptanceCriteria?.length)} onClick={onSave}><Check size={14} />{busy ? "Saving…" : "Apply plan"}</button></footer>
  </aside>;
}

function ActivityView({ events, onLoadMore, hasMore, busy }) {
  return <section className="activity-view"><header><div><span className="eyebrow">PROVIDER EVENT LEDGER</span><h2>Recorded activity</h2><p>Raw Codex lifecycle events and Agent Deck coordination records, newest first.</p></div><span>{events.length} loaded</span></header><div className="event-ledger">{events.map((event) => <details key={event.seq}><summary><code>#{event.seq}</code><strong>{event.type}</strong><span>{event.taskId ? `Task ${event.taskId.slice(0, 8)}` : "Mission"}</span><time>{relativeTime(event.createdAt)}</time></summary><pre>{JSON.stringify(event.payload, null, 2)}</pre></details>)}</div>{hasMore && <button className="load-more-events" onClick={onLoadMore} disabled={busy}>{busy ? "Loading…" : "Load 100 older events"}</button>}</section>;
}

function Inspector({ mission, task, conversation, draft, setDraft, onSend, onResume, onAccept, onRequestChanges, onRetry, onIntegrate, onApproval, onArtifactAction, busy, panel, setPanel, focused, onToggleFocus, messageReceipt }) {
  const [reviewNote, setReviewNote] = useState("");
  const reviewNoteRef = useRef(null);
  useEffect(() => { setReviewNote(""); }, [task?.id]);
  const threadId = task ? task.agentThreadId : mission?.mainThreadId;
  const agentName = task?.agentRole || "Main Agent";
  const runtimeLabel = mission?.runtimeMode === "agent_deck" ? `Agent Deck Harness · ${mission.model || mission.provider}` : mission?.provider === "deepseek" ? "Legacy API Harness" : mission?.provider === "openai_compatible" ? "Legacy API Harness" : "External Codex thread";
  if (!mission) return <aside className="mission-inspector"><div className="mission-empty"><Database size={28} /><h3>No persisted mission</h3></div></aside>;
  const approvalEvent = task && mission.events.find((event) => event.taskId === task.id && ["provider.item/commandExecution/requestApproval", "provider.item/fileChange/requestApproval", "provider.item/gitOperation/requestApproval"].includes(event.type));
  const approvalAction = approvalEvent ? { requestId: approvalEvent.payload?.requestId || approvalEvent.payload?.id, state: "requested", reason: approvalEvent.payload?.reason, command: approvalEvent.payload?.command, path: approvalEvent.payload?.path, operation: approvalEvent.payload?.operation, item: approvalEvent.payload?.item } : null;
  const activity = (task ? mission.events.filter((event) => event.taskId === task.id) : mission.events.filter((event) => !event.taskId)).map((event) => ({ event, activity: providerActivity(event) })).filter((entry) => entry.activity).slice(0, 24);
  const observed = task?.result?.observedChanges;
  const resolution = blockerResolution(task);
  const artifacts = task ? mission.artifacts.filter((artifact) => artifact.taskId === task.id) : mission.artifacts.filter((artifact) => !artifact.taskId);
  const runs = (mission.runs || []).filter((run) => task ? run.taskId === task.id : !run.taskId);
  const pendingOutgoing = (mission.messages || []).filter((item) => item.fromAgent === "You" && item.toAgent === agentName && ["sending", "failed"].includes(item.deliveryStatus));
  const review = reviewGate(task?.result);
  const reviewGuidance = reviewGateGuidance(task?.result);
  const acceptancePassed = review.passed;
  const acceptanceTotal = review.total;
  const reviewReady = review.ready;
  const reviewIssueCount = reviewGuidance.issues.length;
  const prepareReviewFeedback = () => {
    setPanel("result");
    setReviewNote((current) => current.trim() ? current : reviewGuidance.feedback);
    window.requestAnimationFrame(() => reviewNoteRef.current?.focus());
  };
  const tabs = [
    { id: "conversation", label: "Conversation", icon: ChatCircleText, count: conversation.entries.length },
    { id: "result", label: "Result", icon: CheckCircle },
    { id: "brief", label: "Brief", icon: FileText },
    { id: "artifacts", label: "Artifacts", icon: FileCode, count: artifacts.length },
    { id: "runs", label: "Runs", icon: Clock, count: runs.length },
    { id: "evidence", label: "Evidence", icon: ShieldCheck },
  ];
  const stateLabel = task ? taskStateLabel(task) : missionStateLabel(mission.status);
  const shortStateLabel = ({ Completed: "Done", "Workers running": "Running", "Review required": "Review", "Awaiting approval": "Waiting", "Ready to integrate": "Ready", "Integration conflict": "Conflict" })[stateLabel] || stateLabel;
  return <aside className={`mission-inspector ${task?.status === "review" ? "reviewable" : ""} ${resolution ? "blocked" : ""}`}><header><span className="eyebrow">{task ? "SELECTED WORKER SESSION" : "MAIN AGENT SESSION"}</span><div className="agent-heading"><AgentAvatar name={agentName} role={task?.agentRole || "Planner"} main={!task} size="xl" status={statusTone(task?.status || mission.status)} /><div className="agent-heading-copy"><h2>{agentName}</h2><p>{task ? `${task.key} · ${task.title}` : mission.title}</p></div><div className="agent-heading-actions">{task?.status === "review" ? <button type="button" className="online review-status-button" onClick={() => setPanel("result")}><i /><span>Review</span></button> : <span className={`online ${statusTone(task?.status || mission.status)}`} data-short={shortStateLabel} title={stateLabel}><i /><span>{stateLabel}</span></span>}<button type="button" className="inspector-focus-button" onClick={onToggleFocus} aria-label={focused ? "Restore inspector width" : "Focus inspector"} title={focused ? "Restore split view" : "Focus conversation"}>{focused ? <ArrowsInSimple size={15} /> : <ArrowsOutSimple size={15} />}</button></div></div></header><nav aria-label="Agent details">{tabs.map(({ id, label, icon: Icon, count }) => <button key={id} title={label} aria-label={count ? `${label} ${count}` : label} className={panel === id ? "active" : ""} onClick={() => setPanel(id)}><Icon size={14} /><span>{({ conversation: "对话", result: "结果", brief: "任务", artifacts: "产物", runs: "运行", evidence: "证据" })[id]}</span>{count ? <b>{count}</b> : null}</button>)}</nav>{resolution && <section className="agent-blocker-bar" data-testid="agent-blocker-resolution"><header><Warning size={16} weight="fill" /><div><strong>{resolution.reason}</strong><span>{resolution.detail}</span></div></header><small title={resolution.suggestion}>{resolution.action === "retry" ? "真实阻塞：" : "建议指令："}{resolution.suggestion}</small><div><button type="button" onClick={() => setPanel("evidence")}>查看证据</button>{threadId && <button type="button" onClick={() => setDraft(resolution.suggestion)}>放入输入框</button>}<button type="button" className="resume" onClick={() => resolution.action === "retry" ? onRetry(task.id) : onResume(task.id, resolution.suggestion)} disabled={busy}><Play size={13} weight="fill" />{busy ? "处理中…" : resolution.primaryLabel}</button>{resolution.action !== "retry" && <button type="button" onClick={() => onRetry(task.id)} disabled={busy}>重新派发</button>}</div></section>}<div className="mission-inspector-scroll">
    {approvalAction && task.status === "waiting_approval" && <ApprovalActionPanel action={approvalAction} commandAvailable onDecision={(decision) => onApproval(approvalAction.requestId, decision)} busy={busy} />}
    {panel === "conversation" && <section className="agent-conversation" aria-label={`${agentName} conversation`}><header><div><ChatCircleText size={17} /><span>{runtimeLabel}</span></div><code title={threadId}>{threadId?.slice(0, 15) || "Not started"}</code></header>{conversation.loading && !conversation.entries.length && !pendingOutgoing.length ? <div className="conversation-state"><Clock size={18} /><span>Loading recent conversation in the background…</span></div> : conversation.error ? <div className="conversation-state error"><Warning size={18} /><span>{conversation.error}</span></div> : conversation.entries.length || pendingOutgoing.length ? <div className="agent-message-list">{pendingOutgoing.map((entry) => <article key={entry.id} className={`user pending-${entry.deliveryStatus}`}><header><AgentAvatar name="You" role="User" user size="xs" /><strong>You</strong><span>{entry.deliveryStatus === "failed" ? "未送达" : "正在投递"}</span></header><LongText text={entry.text} />{entry.error && <small className="conversation-delivery-error">失败原因：{entry.error}</small>}</article>)}{conversation.entries.map((entry) => <article key={entry.id} className={entry.role}><header><AgentAvatar name={entry.role === "user" ? "You" : agentName} role={task?.agentRole || "Planner"} main={entry.role === "agent" && !task} user={entry.role === "user"} size="xs" /><strong>{entry.role === "user" ? "You" : agentName}</strong><span>{entry.role === "user" ? "instruction" : "response"}</span></header><LongText text={entry.text} /><StructuredConversationDetails entry={entry} />{entry.registeredTasks?.length ? <div className="agent-action-receipt"><Clock size={14} weight="fill" /><div><strong>Worker task requested</strong><span>{entry.registeredTasks.join(", ")} · the canvas is the source of truth for creation status</span></div></div> : null}</article>)}</div> : <div className="conversation-state"><ChatCircleText size={18} /><span>{threadId ? "No persisted messages were returned for this thread." : "This agent has not started a real provider thread yet."}</span></div>}</section>}
    {panel === "result" && (task ? <section className="agent-result-view"><header><span className="eyebrow">执行结果</span><LongText className="result-summary" text={task.result?.summary || "No result returned yet"} limit={2400} /></header>{task.result ? <>{task.result.acceptance?.length > 0 && <section><h4>Acceptance</h4>{task.result.acceptance.map((item, index) => <article className={`acceptance-row ${item.passed ? "passed" : "failed"}`} key={`${item.criterion}-${index}`}><CheckCircle size={16} weight="fill" /><div><strong>{item.criterion}</strong><LongText text={item.evidence} limit={1400} /></div></article>)}</section>}{task.result.blockers?.length > 0 && <section className="result-blockers"><h4>Blockers</h4>{task.result.blockers.map((blocker) => <LongText key={blocker} text={blocker} limit={1400} />)}</section>}{observed?.files?.length > 0 && <section><h4>Observed Git changes</h4><div className="output-files">{observed.files.slice(0, 200).map((file) => <code key={file}>{file}</code>)}{observed.files.length > 200 && <small>{observed.files.length - 200} additional files are available in the artifact record.</small>}{observed.diffStat && <LongText text={observed.diffStat} limit={3000} />}</div></section>}</> : <div className="conversation-state"><Clock size={18} /><span>Real structured output will appear after this worker completes a turn.</span></div>}{task.status === "review" && <section className={`review-decision-card ${reviewReady ? "ready" : "needs-evidence"}`} data-testid="review-center"><header><div><ShieldCheck size={17} weight="duotone" /><span><strong>{reviewReady ? "可以验收" : `暂不可验收 · ${reviewIssueCount} 项待处理`}</strong><small>{acceptancePassed}/{acceptanceTotal} 项检查通过 · {review.blockers} 个阻塞项 · {artifacts.length} 个产物 · {observed?.files?.length || 0} 个变更文件</small></span></div></header>{!reviewReady && <section className="review-gate-explanation" role="alert"><div><Warning size={15} weight="fill" /><strong>为什么还不能验收</strong></div><ul>{reviewGuidance.issues.slice(0, 4).map((issue, index) => <li key={`${issue}-${index}`}>{issue}</li>)}</ul>{reviewGuidance.issues.length > 4 && <small>另有 {reviewGuidance.issues.length - 4} 项，请在上方结果中查看。</small>}<button type="button" onClick={prepareReviewFeedback}><PaperPlaneTilt size={13} />生成修改反馈</button></section>}<label>给 Worker 的反馈<textarea ref={reviewNoteRef} rows="3" value={reviewNote} onChange={(event) => setReviewNote(event.target.value)} placeholder={reviewReady ? "如果结果符合预期，可以直接验收；也可以填写修改意见…" : "填写需要修改的内容，或点击上方“生成修改反馈”…"} /></label><div><button type="button" className="request-changes" disabled={busy || !reviewNote.trim()} onClick={async () => { const result = await onRequestChanges(task.id, reviewNote.trim()); if (result) { setReviewNote(""); setPanel("conversation"); } }}><PaperPlaneTilt size={14} />{busy ? "正在发送…" : "要求修改"}</button><button type="button" className="accept-result" title={reviewReady ? "所有验收检查均已通过且没有阻塞项。" : `仍有 ${reviewIssueCount} 项待处理，暂不可验收。`} onClick={() => onAccept(task.id)} disabled={busy || !reviewReady}><CheckCircle size={14} weight="fill" />{busy ? "正在验收…" : reviewReady ? "验收结果" : "暂不可验收"}</button></div><p>{reviewReady ? "验收后会提交当前 Worktree，并将证据标记为已由你确认。" : "处理完上面的阻塞项并让 Worker 重新提交后，验收按钮会自动开放。"}</p></section>}{task.status === "blocked" && <button className="approve-plan result-action" onClick={() => onRetry(task.id)} disabled={busy}><Play size={16} weight="fill" />Retry real dispatch</button>}</section> : <section className="agent-result-view"><header><span className="eyebrow">计划概览</span><h3>{mission.spec?.title || mission.title}</h3><p>{mission.spec?.outcome || mission.outcome}</p></header>{mission.spec?.tasks?.length > 0 && <section><h4>任务拆解</h4><div className="result-task-list">{mission.spec.tasks.map((item) => <article key={item.key}><AgentAvatar name={item.agentRole} role={item.agentRole} size="xs" /><code>{item.key}</code><div><strong>{item.title}</strong><span>{item.agentRole}</span></div></article>)}</div></section>}{["ready_to_integrate", "integration_conflict"].includes(mission.status) && <button className="approve-plan result-action" onClick={onIntegrate} disabled={busy}><GitBranch size={16} weight="fill" />{mission.status === "integration_conflict" ? "重新尝试汇总" : mission.executionMode === "research" ? "汇总已验收成果" : "创建集成分支"}</button>}</section>)}
    {panel === "brief" && (task ? <section className="agent-brief-view"><span className="eyebrow">ASSIGNED TASK</span><h3>{task.key} · {task.title}</h3><p>{task.description}</p><section><h4>Dependencies</h4><div className="detail-chips">{task.dependencies.length ? task.dependencies.map((dependency) => <code key={dependency}>{dependency}</code>) : <span>None</span>}</div></section><section><h4>Acceptance criteria</h4><ol>{task.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ol></section></section> : <section className="agent-brief-view"><span className="eyebrow">ORIGINAL MISSION</span><h3>{mission.title}</h3><p>{mission.sourcePrompt || mission.outcome}</p>{mission.spec?.scope?.length > 0 && <section><h4>Scope</h4><ul>{mission.spec.scope.map((item) => <li key={item}>{item}</li>)}</ul></section>}{mission.spec?.acceptanceCriteria?.length > 0 && <section><h4>Mission acceptance</h4><ol>{mission.spec.acceptanceCriteria.map((item) => <li key={item}>{item}</li>)}</ol></section>}</section>)}
    {panel === "artifacts" && <section className="agent-artifact-view"><header><div><FileCode size={17} /><span>Published artifacts</span></div><b>{artifacts.length} from this agent</b></header>{artifacts.length ? <div className="agent-artifact-list">{artifacts.map((artifact) => <ArtifactCard key={artifact.id} missionId={mission.id} artifact={artifact} onAction={onArtifactAction} busy={busy} />)}</div> : <div className="conversation-state"><FileCode size={19} /><span>This agent has not published an artifact yet. Conversation and provider evidence remain available.</span></div>}</section>}
    {panel === "runs" && <section className="agent-run-view"><header><div><Clock size={17} /><span>Run history</span></div><b>{runs.length} real Codex turn{runs.length === 1 ? "" : "s"}</b></header>{runs.length ? <div className="agent-run-list">{runs.map((run) => <article key={run.id} className={statusTone(run.status)}><div><i /><strong>Attempt {run.attempt}</strong><span>{run.triggerType}</span></div><code title={run.turnId}>{run.turnId?.slice(0, 18) || "Turn pending"}</code><p>{run.phase}{run.error ? ` · ${run.error}` : ""}</p><time>{relativeTime(run.startedAt)}{run.endedAt ? ` · ${Math.max(0, Math.round((new Date(run.endedAt) - new Date(run.startedAt)) / 1000))}s` : " · active"}</time></article>)}</div> : <div className="conversation-state"><Clock size={19} /><span>No Run exists yet. A Run is created only when a real Codex Turn starts.</span></div>}</section>}
    {panel === "evidence" && <section className="agent-evidence-view"><section className="inspector-block"><h3>Traceability</h3><dl><div><dt>执行方式</dt><dd>{mission.executionMode === "research" ? "调研与文档 · 独立成果工作区" : "代码开发 · Git Worktree"}</dd></div><div><dt>Thread</dt><dd title={threadId}>{threadId?.slice(0, 15) || "Not started"}</dd></div><div><dt>Branch</dt><dd>{task?.branch || mission.integrationBranch || "Workspace branch"}</dd></div><div><dt>Worktree</dt><dd title={task?.worktreePath || mission.executionCwd || mission.cwd}>{task?.worktreePath ? task.worktreePath.split("/").slice(-2).join("/") : (mission.executionCwd || mission.cwd).split("/").at(-1)}</dd></div><div><dt>Updated</dt><dd>{task?.updatedAt || mission.updatedAt}</dd></div></dl>{(task?.error || mission.error) && <p className="runtime-inline-error">{task?.error || mission.error}</p>}</section>{task?.evidence?.length > 0 && <section className="inspector-block"><h3>Acceptance evidence</h3>{task.evidence.map((item, index) => <article className="latest-message" key={index}><header><span>{item.passed ? "PASS" : "NOT PASSED"}</span></header><p>{item.criterion}</p><small>{item.evidence}</small></article>)}</section>}<section className="inspector-block activity-block"><h3>Provider activity <b>{activity.length}</b></h3>{activity.length ? <div className="activity-list">{activity.map(({ event, activity: entry }) => <article key={event.seq}><code>{entry.kind}</code><div><strong>{entry.title}</strong>{entry.detail && <pre>{entry.detail}</pre>}</div><time>{relativeTime(event.createdAt)}</time></article>)}</div> : <p className="muted-copy">No provider activity exists for this agent yet.</p>}</section></section>}
  </div>{task?.status === "review" && <section className={`agent-review-bar ${reviewReady ? "ready" : "needs-attention"}`}><div><ShieldCheck size={16} weight="duotone" /><span><strong>{reviewReady ? "结果等待你验收" : `还有 ${reviewIssueCount} 项阻塞`}</strong><small>{reviewReady ? "检查结果后即可确认验收。" : reviewGuidance.issues[0]}</small></span></div><button type="button" className={panel === "result" ? "active" : ""} onClick={reviewReady ? () => setPanel("result") : prepareReviewFeedback}>{reviewReady ? (panel === "result" ? "正在查看" : "查看结果") : "处理阻塞"}</button><button type="button" className="accept" title={reviewReady ? "所有验收检查均已通过且没有阻塞项。" : `仍有 ${reviewIssueCount} 项待处理，暂不可验收。`} onClick={() => onAccept(task.id)} disabled={busy || !reviewReady}><CheckCircle size={14} weight="fill" />{busy ? "正在验收…" : reviewReady ? "验收" : "暂不可验收"}</button></section>}<form className="agent-compose" onSubmit={onSend}><header><div><i /><strong>Message {agentName}</strong></div><span className={messageReceipt?.status ? `compose-receipt ${messageReceipt.status}` : ""}>{messageReceipt?.label || (threadId ? "⌘↵ to send" : "Thread not started")}</span></header><div><textarea rows="2" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && draft.trim() && threadId) event.currentTarget.form.requestSubmit(); }} placeholder={threadId ? `Give ${agentName} a new instruction or redirect the current work…` : "This agent does not have an execution thread yet."} disabled={!threadId} /><button disabled={!threadId || !draft.trim()} aria-label={`Send message to ${agentName}`}><PaperPlaneTilt size={16} weight="fill" /></button></div></form></aside>;
}

function NewMissionModal({ onClose, onCreate, onChooseWorkspace, workspace, busy, providers = [] }) {
  const [title, setTitle] = useState("");
  const [outcome, setOutcome] = useState("");
  const [executionMode, setExecutionMode] = useState("code");
  const [orchestrationMode, setOrchestrationMode] = useState("adaptive");
  const [scenario, setScenario] = useState("研发交付");
  const [valueType, setValueType] = useState("time_saved");
  const [expectedValueCny, setExpectedValueCny] = useState("");
  const [baselineHours, setBaselineHours] = useState("");
  const [tokenBudget, setTokenBudget] = useState("80000");
  const [provider, setProvider] = useState(() => providers.find((item) => item.selectedForMode)?.id || providers.find((item) => item.missionEnabled)?.id || "");
  const [choosingWorkspace, setChoosingWorkspace] = useState(false);
  useEffect(() => {
    if (providers.find((item) => item.id === provider && item.missionEnabled)) return;
    const fallback = providers.find((item) => item.selectedForMode && item.missionEnabled) || providers.find((item) => item.missionEnabled);
    if (fallback) setProvider(fallback.id);
  }, [providers, provider]);
  const choose = async () => { setChoosingWorkspace(true); try { await onChooseWorkspace(); } finally { setChoosingWorkspace(false); } };
  const activeProvider = providers.find((item) => item.id === provider);
  return <div className="modal-backdrop" onMouseDown={onClose}><form className="modal mission-modal" onSubmit={(event) => { event.preventDefault(); onCreate({ title: title.trim(), outcome: outcome.trim(), provider, executionMode, orchestrationMode, valueContract: { scenario, valueType, expectedValueCny: Number(expectedValueCny || 0), baselineHours: Number(baselineHours || 0), tokenBudget: Number(tokenBudget || 80000) } }); }} onMouseDown={(event) => event.stopPropagation()}><header><div><span className="eyebrow">NEW REAL MISSION</span><h2>用最短可靠路径完成工作</h2><p>简单任务直接执行；只有并行确有价值时才生成 DAG。证据与 ROI 都写入本地 SQLite。</p></div><button type="button" className="quiet-button" onClick={onClose}><X size={19} /></button></header><ExecutionModeField value={executionMode} onChange={setExecutionMode} /><label>Mission name<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：修复日期解析器并补充边界测试" /></label><label>Expected outcome<textarea value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="描述可验证的最终结果、约束和非目标。" /></label><label>执行策略<select value={orchestrationMode} onChange={(event) => setOrchestrationMode(event.target.value)}><option value="adaptive">自适应（推荐）</option><option value="direct">单 Worker 直通</option><option value="mission">强制 Mission 编排</option></select><small>{orchestrationMode === "adaptive" ? "先判断协调收益：简单任务跳过 Planner，复杂任务才拆成依赖安全的 DAG。" : orchestrationMode === "direct" ? "保持一个完整上下文；一次验收后自动集成。" : "总是先生成计划，并等待你批准后再启动多个 Worker。"}</small></label><label>Agent runtime<select value={provider} onChange={(event) => setProvider(event.target.value)}>{providers.filter((item) => item.runtimeEligible !== false && ["codex", "claude_code", "trae", "deepseek", "openai_compatible"].includes(item.id)).map((item) => <option key={item.id} value={item.id} disabled={!item.missionEnabled}>{item.label}{item.missionEnabled ? " · Mission ready" : " · Configure in Settings"}</option>)}</select><small>{activeProvider?.kind === "api" ? "Agent Deck Harness：受控工具、独立只读验证和运行记录。写入与 Bash 仍需你逐次批准。" : "Codex runtime：原生 Thread、Worktree、实时事件与审批。"}</small></label><section className="mission-value-intake"><header><span>VALUE CONTRACT</span><small>预算约束整个任务；自适应路由会避免不必要的 Planner 和协调消耗。</small></header><div><label>场景<input value={scenario} onChange={(event) => setScenario(event.target.value)} placeholder="研发交付" /></label><label>价值类型<select value={valueType} onChange={(event) => setValueType(event.target.value)}><option value="time_saved">节省人时</option><option value="revenue">增收机会</option><option value="risk_avoided">风险避免</option><option value="decision_speed">决策提速</option><option value="knowledge_reuse">知识复用</option></select></label></div><div><label>目标价值 ¥<input type="number" min="0" value={expectedValueCny} onChange={(event) => setExpectedValueCny(event.target.value)} placeholder="可稍后填写" /></label><label>人工基线 h<input type="number" min="0" step="0.5" value={baselineHours} onChange={(event) => setBaselineHours(event.target.value)} placeholder="可稍后填写" /></label><label>Token 预算<input type="number" min="1000" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} /></label></div></section><label className="workspace-picker-label">{executionMode === "research" ? "资料目录" : "代码项目"}<button type="button" className="workspace-picker-control" onClick={choose} disabled={choosingWorkspace} data-testid="mission-workspace-picker"><GitBranch size={19} weight="duotone" /><span><strong>{workspace?.name || "选择本地工作区"}</strong><small title={workspace?.path}>{workspace?.path || "选择 Runtime 使用的本地工作区"}</small></span><b>{choosingWorkspace ? "Opening…" : workspace ? "Change…" : "Choose…"}</b></button></label><div className="mission-form-options"><span><GitBranch size={14} />{executionMode === "research" ? "独立成果工作区" : "真实 Git Worktree"}</span><span><Database size={14} />SQLite 事件账本</span><span><ShieldCheck size={14} />人工验收门</span></div><footer><button type="button" className="tool-button" onClick={onClose}>Cancel</button><button className="primary-button" disabled={busy || choosingWorkspace || !workspace || !title.trim() || !outcome.trim() || !activeProvider?.missionEnabled}><Sparkle size={15} weight="fill" />{busy ? "正在选择执行路径…" : `开始 · ${activeProvider?.label || "runtime"}`}</button></footer></form></div>;
}

function ArtifactPreview({ preview, onClose, onAction, busy }) {
  return <div className="artifact-preview-backdrop" onMouseDown={onClose} data-testid="artifact-preview">
    <section className="artifact-preview-modal" onMouseDown={(event) => event.stopPropagation()}>
      <header><div><span className="eyebrow">SAFE HTML PREVIEW</span><h2>{preview.title}</h2><code title={preview.relativePath}>{preview.relativePath}</code></div><nav><button type="button" onClick={() => onAction("open", preview.artifact, preview.file)} disabled={busy}><ArrowSquareOut size={14} />外部打开</button><button type="button" onClick={() => onAction("reveal", preview.artifact, preview.file)} disabled={busy}><FolderOpen size={14} />访达</button><button type="button" className="close" onClick={onClose} aria-label="Close preview"><X size={18} /></button></nav></header>
      <div className="artifact-preview-security"><ShieldCheck size={15} weight="duotone" /><span>静态安全预览：脚本、网络请求、表单提交与外部嵌入均已禁用。</span></div>
      <iframe className="artifact-preview-frame" title={`Preview ${preview.title}`} sandbox="" referrerPolicy="no-referrer" srcDoc={preview.content} />
    </section>
  </div>;
}

export function MissionWorkspace({ desktop, workspace, codexStatus, onChooseWorkspace, mode = "mission", target = null }) {
  const [providers, setProviders] = useState([]);
  const [missions, setMissions] = useState([]);
  const [selectedMissionId, setSelectedMissionId] = useState(null);
  const [activeMission, setActiveMission] = useState(null);
  const [selectedTaskId, setSelectedTaskId] = useState(null);
  const [tab, setTab] = useState(mode === "artifacts" ? "artifacts" : "graph");
  const [showNewMission, setShowNewMission] = useState(false);
  const [draft, setDraft] = useState("");
  const [messageReceipt, setMessageReceipt] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [artifactPreview, setArtifactPreview] = useState(null);
  const [publicationTarget, setPublicationTarget] = useState(null);
  const [olderEvents, setOlderEvents] = useState([]);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const [conversation, setConversation] = useState({ threadId: null, entries: [], loading: false, error: "" });
  const [conversationVersion, setConversationVersion] = useState(0);
  const [inspectorPanel, setInspectorPanel] = useState("conversation");
  const [nodePositions, setNodePositions] = useState({});
  const [layoutMode, setLayoutMode] = useState("horizontal");
  const [edgeFilter, setEdgeFilter] = useState("all");
  const [showCriticalPath, setShowCriticalPath] = useState(false);
  const [planEditing, setPlanEditing] = useState(false);
  const [planDraft, setPlanDraft] = useState(null);
  const [selectedDraftKey, setSelectedDraftKey] = useState(null);
  const [flowInstance, setFlowInstance] = useState(null);
  const [sidebarWidth, setSidebarWidth] = useState(282);
  const [inspectorWidth, setInspectorWidth] = useState(400);
  const [inspectorFocused, setInspectorFocused] = useState(false);
  const [selectedNodeCount, setSelectedNodeCount] = useState(0);
  const [hoveredEdgeId, setHoveredEdgeId] = useState(null);
  const reducedMotion = useReducedMotion();
  const selectedMissionRef = useRef(null);
  const pendingFit = useRef(false);
  const refreshTimers = useRef(new Map());
  const conversationCache = useRef(new Map());
  const mission = activeMission?.id === selectedMissionId ? activeMission : null;
  const allEvents = useMemo(() => mission ? [...mission.events, ...olderEvents].filter((event, index, items) => items.findIndex((candidate) => candidate.seq === event.seq) === index).sort((a, b) => b.seq - a.seq) : [], [mission?.events, olderEvents]);
  const visibleMission = useMemo(() => mission ? { ...mission, events: allEvents } : null, [mission, allEvents]);
  const selectedTask = selectedTaskId ? visibleMission?.tasks.find((task) => task.id === selectedTaskId) || null : null;
  const selectedThreadId = selectedTask ? selectedTask.agentThreadId || null : visibleMission?.mainThreadId || null;
  const selectedConversationRevision = visibleMission?.events.find((event) => event.threadId === selectedThreadId && (event.type === "provider.turn/completed" || event.type === "provider.item/completed" && ["agentMessage", "userMessage", "user_message"].includes(event.payload?.item?.type)))?.seq || 0;
  const selectedTaskKey = selectedTask?.key || null;
  const missionTaskKeys = mission?.tasks.map((task) => task.key).join("|") || "";

  useEffect(() => { selectedMissionRef.current = selectedMissionId; }, [selectedMissionId]);
  useEffect(() => { desktop?.providers?.list?.().then(setProviders).catch(() => setProviders([])); }, [desktop]);
  useEffect(() => { if (mode === "artifacts") setTab("artifacts"); }, [mode]);
  useEffect(() => {
    if (!target?.missionId) return;
    setSelectedMissionId(target.missionId);
    // A panel change within the same mission does not trigger the ID-keyed fetch.
    // Keep its detail, or the view would stay in "Loading" indefinitely.
    setActiveMission(current => current?.id === target.missionId ? current : null);
    setSelectedTaskId(target.taskId || null);
    setInspectorPanel(target.panel || "conversation"); setTab(target.tab || "graph");
  }, [target?.nonce]);
  useEffect(() => { setOlderEvents([]); setHasMoreEvents(Boolean(mission?.hasMoreEvents)); }, [mission?.id]);
  useEffect(() => { if (mission) setHasMoreEvents((current) => current || Boolean(mission.hasMoreEvents)); }, [mission?.events?.[0]?.seq]);

  useEffect(() => {
    if (!mission) return;
    const saved = mission.uiState || {};
    const savedMode = saved.layout?.mode || "horizontal";
    const migrateToReadableCompact = mission.tasks.length > 4 && savedMode === "horizontal" && !saved.layout?.responsiveV1;
    const nextMode = migrateToReadableCompact ? "compact" : savedMode;
    const nextPositions = { ...autoLayoutMission(mission.tasks, nextMode), ...(migrateToReadableCompact ? {} : saved.layout?.positions || {}) };
    setLayoutMode(nextMode);
    setNodePositions(nextPositions);
    setSidebarWidth(Math.max(230, Math.min(420, Number(saved.panels?.sidebarWidth) || 282)));
    setInspectorWidth(Math.max(310, Math.min(620, Number(saved.panels?.inspectorWidth) || 400)));
    setInspectorFocused(false);
    setPlanEditing(false); setPlanDraft(null); setSelectedDraftKey(null);
    if (migrateToReadableCompact) {
      pendingFit.current = true;
      desktop.missions.saveUiState({ missionId: mission.id, patch: { layout: { mode: nextMode, positions: nextPositions, responsiveV1: true } } }).catch(() => {});
      setTimeout(() => flowInstance?.fitView({ padding: .16, duration: reducedMotion ? 0 : 320 }), 0);
    }
  }, [mission?.id, missionTaskKeys]);

  useEffect(() => {
    const shell = document.querySelector(".app-shell");
    if (shell) shell.style.setProperty("--mission-sidebar-width", `${sidebarWidth}px`);
    return () => shell?.style.removeProperty("--mission-sidebar-width");
  }, [sidebarWidth]);

  useEffect(() => {
    if (!flowInstance || !pendingFit.current) return;
    pendingFit.current = false;
    const timer = setTimeout(() => flowInstance.fitView({ padding: .16, duration: reducedMotion ? 0 : 320 }), 0);
    return () => clearTimeout(timer);
  }, [flowInstance, layoutMode, mission?.id, reducedMotion]);

  useEffect(() => {
    if (!desktop?.missions) return undefined;
    let disposed = false;
    desktop.missions.list().then((items) => { if (!disposed) { setMissions(items); setSelectedMissionId((current) => current || items[0]?.id || null); } }).catch((loadError) => setError(loadError.message));
    const unsubscribeUpdate = desktop.missions.onUpdate((update) => {
      const missionId = update.missionId || update.id;
      if (!missionId) return;
      // Coalesce bursty provider events without starving the live UI. One refresh
      // per mission every 250ms is enough for progress while workers are streaming.
      if (refreshTimers.current.has(missionId)) return;
      refreshTimers.current.set(missionId, setTimeout(async () => {
        refreshTimers.current.delete(missionId);
        try {
          const [summaries, detail] = await Promise.all([
            desktop.missions.list(),
            selectedMissionRef.current === missionId ? desktop.missions.get(missionId) : Promise.resolve(null),
          ]);
          if (disposed) return;
          setMissions(summaries);
          if (detail && selectedMissionRef.current === missionId) setActiveMission(detail);
        } catch (loadError) { if (!disposed) setError(loadError.message || String(loadError)); }
      }, 250));
    });
    const unsubscribeError = desktop.missions.onError((next) => setError(next.message));
    return () => { disposed = true; unsubscribeUpdate(); unsubscribeError(); for (const timer of refreshTimers.current.values()) clearTimeout(timer); refreshTimers.current.clear(); };
  }, [desktop]);

  useEffect(() => {
    if (!desktop?.missions || !selectedMissionId) { setActiveMission(null); return; }
    let disposed = false;
    setActiveMission((current) => current?.id === selectedMissionId ? current : null);
    desktop.missions.get(selectedMissionId).then((detail) => { if (!disposed) setActiveMission(detail); }).catch((loadError) => { if (!disposed) setError(loadError.message || String(loadError)); });
    return () => { disposed = true; };
  }, [desktop, selectedMissionId]);

  useEffect(() => {
    if (selectedTaskId && mission?.tasks.length && !mission.tasks.some((task) => task.id === selectedTaskId)) setSelectedTaskId(null);
  }, [mission?.id, mission?.tasks.length, selectedTaskId]);

  useEffect(() => {
    if (mission?.spec?.runtime?.mode === "direct" && mission.tasks.length === 1 && !selectedTaskId) {
      setSelectedTaskId(mission.tasks[0].id);
      setInspectorPanel(mission.tasks[0].status === "review" ? "result" : "conversation");
    }
  }, [mission?.id, mission?.spec?.runtime?.mode, mission?.tasks?.[0]?.status, selectedTaskId]);

  useEffect(() => {
    const cached = selectedThreadId ? conversationCache.current.get(selectedThreadId) : null;
    if (visibleMission?.provider && visibleMission.provider !== "codex") {
      const entries = (visibleMission.messages || []).slice().reverse().filter((entry) => entry.fromAgent === "You" || entry.toAgent === "You" || entry.toAgent === "Main Agent").map((entry) => ({ id: entry.id, role: entry.fromAgent === "You" ? "user" : "agent", text: entry.text }));
      setConversation({ threadId: selectedThreadId, entries, loading: false, error: "" });
      return undefined;
    }
    if (inspectorPanel !== "conversation") {
      setConversation({ threadId: selectedThreadId, entries: cached?.entries || [], loading: false, error: "" });
      return undefined;
    }
    if (!desktop?.codex || !selectedThreadId) { setConversation({ threadId: selectedThreadId, entries: [], loading: false, error: "" }); return undefined; }
    if (cached && cached.revision >= selectedConversationRevision && cached.version >= conversationVersion) {
      setConversation({ threadId: selectedThreadId, entries: cached.entries, loading: false, error: "" });
      return undefined;
    }
    let disposed = false;
    setConversation({ threadId: selectedThreadId, entries: cached?.entries || [], loading: true, error: "" });
    const timer = setTimeout(() => {
      desktop.codex.readThread({ threadId: selectedThreadId, includeTurns: true }).then((thread) => {
        if (disposed) return;
        const entries = conversationFromThread(thread);
        conversationCache.current.set(selectedThreadId, { entries, revision: selectedConversationRevision, version: conversationVersion });
        setConversation({ threadId: selectedThreadId, entries, loading: false, error: "" });
      }).catch((loadError) => {
        if (!disposed) setConversation((current) => ({ ...current, loading: false, error: loadError.message || String(loadError) }));
      });
    }, 0);
    return () => { disposed = true; clearTimeout(timer); };
  }, [desktop, selectedThreadId, inspectorPanel, conversationVersion, selectedConversationRevision]);

  const graph = useMemo(() => {
    if (!mission) return { nodes: [], edges: [] };
    const tasks = planEditing && planDraft ? planDraft.tasks.map((draftTask) => ({ ...(mission.tasks.find((task) => task.key === draftTask.key) || { id: `draft:${draftTask.key}`, status: "queued", phase: "draft" }), ...draftTask })) : mission.tasks;
    const path = missionPath(tasks, selectedTaskKey || selectedDraftKey);
    const critical = criticalMissionPath(tasks);
    const impact = dependencyImpact(tasks, selectedTaskKey || selectedDraftKey);
    const runsFor = (taskId) => mission.runs?.filter((run) => run.taskId === taskId).length || 0;
    const artifactsFor = (taskId) => mission.artifacts?.filter((artifact) => artifact.taskId === taskId).length || 0;
    const pathActive = Boolean(selectedTaskKey || selectedDraftKey);
    const direct = mission.spec?.runtime?.mode === "direct";
    const main = { id: "main", type: "agent", position: nodePositions.main || { x: 30, y: 260 }, data: { main: true, name: "Main Agent", role: "Planner", phase: mission.status, state: missionStateLabel(mission.status), tone: statusTone(mission.status), selected: !selectedTaskId && !selectedDraftKey, dimmed: false, editable: false, runCount: runsFor(null), layoutMode } };
    const workerNodes = tasks.map((task) => ({ id: task.key, type: "agent", position: nodePositions[task.key] || (direct ? { x: 320, y: 220 } : { x: 320, y: 260 }), data: { name: task.agentRole, role: task.key, phase: task.phase, state: taskStateLabel(task), status: task.status, tone: statusTone(task.status), critical: showCriticalPath && critical.nodes.has(task.key), selected: selectedTaskKey === task.key || selectedDraftKey === task.key, dimmed: pathActive && !path.nodes.has(task.key), editable: planEditing, runCount: runsFor(task.id), artifactCount: artifactsFor(task.id), layoutMode, onMessage: () => { const real = mission.tasks.find((item) => item.key === task.key); if (real) { selectTask(real.id, "conversation"); setTimeout(() => document.querySelector(".agent-compose textarea")?.focus(), 0); } } } }));
    const nodes = direct ? workerNodes : [main, ...workerNodes];
    const edges = tasks.flatMap((task) => task.dependencies.length ? edgeFilter === "assignments" ? [] : task.dependencies.map((dependency) => {
      const id = `${dependency}->${task.key}`;
      return { id, source: dependency, target: task.key, interactionWidth: 28, animated: !reducedMotion && task.status === "running", label: edgeFilter === "all" ? "depends" : undefined, className: `flow-edge dependency ${showCriticalPath && critical.edges.has(id) ? "critical" : ""} ${pathActive ? path.edges.has(id) ? "highlighted" : "muted" : "neutral"} ${hoveredEdgeId === id ? "label-visible" : ""}` };
    }) : direct || edgeFilter === "dependencies" ? [] : (() => {
      const id = `main->${task.key}`;
      return [{ id, source: "main", target: task.key, interactionWidth: 28, animated: !reducedMotion && task.status === "running", label: edgeFilter === "all" ? "assigned" : undefined, className: `flow-edge assigned ${pathActive ? path.nodes.has(task.key) ? "highlighted" : "muted" : "neutral"} ${hoveredEdgeId === id ? "label-visible" : ""}` }];
    })());
    return { nodes, edges, impact, critical };
  }, [mission, selectedTaskId, selectedTaskKey, selectedDraftKey, nodePositions, planEditing, planDraft, edgeFilter, layoutMode, reducedMotion, hoveredEdgeId, showCriticalPath]);

  async function perform(action) {
    setBusy(true); setError("");
    try { const result = await action(); if (result?.id) setActiveMission(result); return result; } catch (actionError) { setError(actionError.message || String(actionError)); }
    finally { setBusy(false); }
  }

  async function artifactAction(action, artifact, file) {
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await desktop.artifacts[action]({ missionId: mission.id, artifactId: artifact.id, file });
      if (action === "preview") setArtifactPreview({ ...result, artifact, file });
      if (action === "export" && !result?.canceled) setNotice(`Exported to ${result.destination}`);
    } catch (actionError) { setError(actionError.message || String(actionError)); }
    finally { setBusy(false); }
  }

  async function exportReport() {
    setBusy(true); setError(""); setNotice("");
    try { const result = await desktop.missions.exportReport(mission.id); if (!result.canceled) setNotice(`Mission report exported to ${result.destination}`); }
    catch (actionError) { setError(actionError.message || String(actionError)); }
    finally { setBusy(false); }
  }

  async function loadOlderEvents() {
    if (!mission || busy) return;
    const beforeSeq = allEvents.at(-1)?.seq;
    if (!beforeSeq) return;
    setBusy(true); setError("");
    try {
      const page = await desktop.missions.events({ missionId: mission.id, beforeSeq, limit: 100 });
      setOlderEvents((items) => [...items, ...page.items]);
      setHasMoreEvents(Boolean(page.nextBeforeSeq));
    } catch (actionError) { setError(actionError.message || String(actionError)); }
    finally { setBusy(false); }
  }

  function persistUi(patch) {
    if (!mission) return;
    desktop.missions.saveUiState({ missionId: mission.id, patch }).catch((saveError) => setError(saveError.message || String(saveError)));
  }

  function onGraphNodesChange(changes) {
    const nextNodes = applyNodeChanges(changes, graph.nodes);
    const changedPositions = {};
    for (const node of nextNodes) {
      if (node.position && changes.some((change) => change.id === node.id && change.type === "position")) changedPositions[node.id] = node.position;
    }
    if (Object.keys(changedPositions).length) setNodePositions((current) => ({ ...current, ...changedPositions }));
  }

  function saveNodePosition(_event, node) {
    const positions = { [node.id]: node.position };
    setNodePositions((current) => ({ ...current, ...positions }));
    persistUi({ layout: { mode: layoutMode, positions } });
  }

  function applyLayout(mode) {
    const tasks = planEditing && planDraft ? planDraft.tasks : mission.tasks;
    const positions = autoLayoutMission(tasks, mode);
    setLayoutMode(mode); setNodePositions(positions);
    persistUi({ layout: { mode, positions, responsiveV1: true } });
    setTimeout(() => flowInstance?.fitView({ padding: 0.16, duration: reducedMotion ? 0 : 320 }), 0);
  }

  function beginPlanEdit() {
    const spec = structuredClone(mission.spec);
    setPlanDraft(spec); setSelectedDraftKey(selectedTaskKey || spec.tasks?.[0]?.key || null); setPlanEditing(true);
  }

  function connectDependency(connection) {
    if (!planEditing || !planDraft || connection.source === "main" || connection.target === "main" || connection.source === connection.target) return;
    const tasks = planDraft.tasks.map((task) => task.key === connection.target && !(task.dependencies || []).includes(connection.source) ? { ...task, dependencies: [...(task.dependencies || []), connection.source] } : task);
    const validation = validateMissionDag(tasks);
    if (!validation.valid) { setError(`Cannot create dependency: ${validation.cycles[0]?.join(" → ") || "invalid DAG"}`); return; }
    setPlanDraft((current) => ({ ...current, tasks })); setSelectedDraftKey(connection.target);
  }

  function removeDependency(_event, edge) {
    if (!planEditing || !planDraft || edge.source === "main") return;
    setPlanDraft((current) => ({ ...current, tasks: current.tasks.map((task) => task.key === edge.target ? { ...task, dependencies: (task.dependencies || []).filter((key) => key !== edge.source) } : task) }));
  }

  function savePlan() {
    perform(async () => {
      const updated = await desktop.missions.updatePlan({ missionId: mission.id, spec: planDraft });
      setPlanEditing(false); setPlanDraft(null); setSelectedDraftKey(null); setNotice("Task graph updated. Stable task identities and audit history were preserved.");
      return updated;
    });
  }

  function resizeSidebar(event) {
    event.preventDefault();
    const startX = event.clientX; const startWidth = sidebarWidth;
    const move = (next) => setSidebarWidth(Math.max(230, Math.min(420, startWidth + next.clientX - startX)));
    const stop = (next) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); const width = Math.max(230, Math.min(420, startWidth + next.clientX - startX)); setSidebarWidth(width); persistUi({ panels: { sidebarWidth: width } }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  }

  function resizeInspector(event) {
    event.preventDefault();
    const startX = event.clientX; const startWidth = inspectorWidth;
    const move = (next) => setInspectorWidth(Math.max(310, Math.min(620, startWidth + startX - next.clientX)));
    const stop = (next) => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); const width = Math.max(310, Math.min(620, startWidth + startX - next.clientX)); setInspectorWidth(width); persistUi({ panels: { inspectorWidth: width } }); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop, { once: true });
  }

  function selectTask(taskId, preferredPanel) {
    const nextTask = visibleMission?.tasks.find((task) => task.id === taskId);
    setInspectorPanel(preferredPanel || (nextTask?.status === "review" ? "result" : "conversation"));
    setSelectedTaskId(taskId || null);
  }

  function createMission(input) {
    perform(async () => {
      const created = await desktop.missions.create({ ...input, sourcePrompt: input.outcome, cwd: workspace.path, provider: input.provider || undefined, maxWorkers: 4 });
      setSelectedMissionId(created.id); setActiveMission(created); setSelectedTaskId(null); setShowNewMission(false); setTab("spec");
    });
  }

  async function sendMessage(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !mission || !selectedThreadId) return;
    const optimisticId = `local-${Date.now()}`;
    const targetName = selectedTask?.agentRole || "Main Agent";
    const optimistic = { id: optimisticId, missionId: mission.id, fromAgent: "You", toAgent: targetName, topic: "agent.steer", messageType: "command", text, deliveryStatus: "sending", source: "user", createdAt: new Date().toISOString() };
    // Do not route this through perform(): an RPC to Codex may take seconds,
    // but typing and switching nodes must stay available during delivery.
    setDraft(""); setError("");
    setMessageReceipt({ status: "sending", label: "已保存，后台投递中…" });
    setActiveMission((current) => current?.id === mission.id ? { ...current, messages: [optimistic, ...(current.messages || [])] } : current);
    try {
      const result = await desktop.missions.sendMessage({ missionId: mission.id, taskId: selectedTask?.id || null, text });
      const receipt = result?.receipt;
      if (receipt) setActiveMission((current) => current?.id === mission.id ? { ...current, messages: (current.messages || []).map((item) => item.id === optimisticId ? receipt : item) } : current);
      setMessageReceipt({ status: "sending", label: "已入队，等待 Codex 接收…" });
      setConversationVersion((version) => version + 1);
    } catch (actionError) {
      const reason = actionError.message || String(actionError);
      setActiveMission((current) => current?.id === mission.id ? { ...current, messages: (current.messages || []).map((item) => item.id === optimisticId ? { ...item, deliveryStatus: "failed", error: reason } : item) } : current);
      setMessageReceipt({ status: "failed", label: "未能送达：查看红色提示" });
      setError(reason);
    }
  }

  if (!desktop?.missions) return <><aside className="mission-sidebar"><header><div><span className="eyebrow">DESKTOP ONLY</span><h1>Mission</h1></div></header><footer><LockKey size={14} /><span>No mock fallback</span></footer></aside><section className="mission-workspace"><div className="mission-empty full"><TerminalWindow size={38} /><h2>Open Agent Deck.app to run real missions</h2><p>The browser preview cannot access local Codex, SQLite, Git, or workspace files.</p></div></section></>;

  const connectedMissionRuntime = providers.some((item) => item.missionEnabled);
  const canCreate = Boolean(workspace && (codexStatus?.authenticated || connectedMissionRuntime));
  return <>
    <MissionSidebar missions={missions} mission={mission || missions.find((item) => item.id === selectedMissionId)} selectedTaskId={selectedTask?.id} onSelectMission={(id) => { if (id === selectedMissionId) return; setSelectedMissionId(id); setActiveMission(null); setSelectedTaskId(null); setInspectorPanel("conversation"); }} onSelectTask={(id) => { selectTask(id); setTab("graph"); }} onNewMission={() => canCreate ? setShowNewMission(true) : setError(workspace ? "Connect Codex or verify an API provider in Settings first." : "Choose a workspace first.")} onResizeStart={resizeSidebar} />
    <section className="mission-workspace">
      <header className="mission-toolbar"><div className="mission-title"><TreeStructure size={17} weight="duotone" /><div><span>MISSION</span><strong>{mission?.title || missions.find((item) => item.id === selectedMissionId)?.title || "No persisted mission"}</strong></div></div>{mission && <span className={`live-badge ${statusTone(mission.status)}`}><i />{missionStateLabel(mission.status)}</span>}{mission && !["completed", "canceled"].includes(mission.status) && <button className="mission-stop" onClick={() => perform(() => desktop.missions.cancel(mission.id))} disabled={busy}><X size={13} />停止</button>}<div className="mission-tabs">{[["graph", Graph, "画布"], ["tasks", Kanban, "任务"], ["artifacts", FileCode, "产物"]].map(([id, Icon, label]) => <button key={id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}><Icon size={14} />{label}</button>)}<select aria-label="更多 Mission 视图" value={["context", "bus", "activity", "value", "spec"].includes(tab) ? tab : ""} onChange={(event) => event.target.value && setTab(event.target.value)}><option value="">更多</option><option value="context">上下文</option><option value="bus">消息总线</option><option value="activity">活动记录</option><option value="value">价值与成本</option><option value="spec">需求</option></select></div></header>
      {error && <div className="runtime-error"><Warning size={15} />{error}<button onClick={() => setError("")}><X size={14} /></button></div>}
      {notice && <div className="runtime-notice"><CheckCircle size={15} />{notice}<button onClick={() => setNotice("")}><X size={14} /></button></div>}
      {!selectedMissionId ? <div className="mission-empty full"><Database size={38} weight="duotone" /><h2>No real mission exists yet</h2><p>Create one with Codex or a verified API Harness. Nothing will be simulated.</p><button className="primary-button" onClick={() => canCreate ? setShowNewMission(true) : setError(workspace ? "Connect Codex or verify an API provider in Settings first." : "Choose a workspace first.")}><Plus size={15} />New real mission</button></div> : !visibleMission ? <div className="mission-empty full"><Database size={32} weight="duotone" /><h2>Loading mission evidence…</h2><p>Reading the selected mission from the local SQLite ledger.</p></div> : <div className={`mission-body ${inspectorFocused ? "inspector-focused" : ""}`} style={{ "--inspector-width": `${inspectorWidth}px` }}>
        <main className="mission-center">{tab === "graph" && <section className={`graph-canvas ${nextMissionAction(visibleMission) && !planEditing ? "has-decision" : ""}`}>
          {!planEditing && <MissionDecisionDock mission={visibleMission} busy={busy} onMode={() => perform(async () => { const updated = await desktop.missions.setExecutionMode({ missionId: visibleMission.id, executionMode: visibleMission.executionMode === "research" ? "code" : "research" }); if (updated) { setSelectedTaskId(null); setInspectorPanel("brief"); setTab("spec"); setNotice("执行方式已更换，未启动 Worker。请重新审阅计划并批准。"); } return updated; })} onWorkspace={() => perform(async () => { const updated = await desktop.missions.selectWorkspace(visibleMission.id); if (updated) { setSelectedTaskId(null); setInspectorPanel("brief"); setNotice(`工作区已更换为 ${updated.cwd}。请重新审阅计划后批准运行。`); } return updated; })} onOpen={(action) => { if (action.task) selectTask(action.task.id); else setSelectedTaskId(null); setInspectorPanel(action.panel); if (action.kind === "plan") setTab("spec"); else setTab("graph"); }} onSecondary={(action) => { if (action.kind === "plan") beginPlanEdit(); else if (action.kind === "blocked") { selectTask(action.task.id); setInspectorPanel("evidence"); } else if (action.kind === "integration") setTab("artifacts"); else if (action.kind === "recovery") setTab("activity"); else if (action.task) { selectTask(action.task.id); setInspectorPanel("conversation"); } }} onApprove={() => perform(() => desktop.missions.approve(visibleMission.id))} />}
          <div className="graph-toolbar" data-testid="graph-toolbar"><label>布局<select value={layoutMode} onChange={(event) => applyLayout(event.target.value)}><option value="horizontal">从左到右</option><option value="vertical">从上到下</option><option value="compact">紧凑</option></select></label><label>连线<select value={edgeFilter} onChange={(event) => setEdgeFilter(event.target.value)}><option value="all">全部</option><option value="dependencies">仅依赖</option><option value="assignments">仅分配</option></select></label><button type="button" className={`critical-path-toggle ${showCriticalPath ? "active" : ""}`} title="Highlight the longest dependency chain; this is not a duration forecast." onClick={() => setShowCriticalPath((value) => !value)}>关键路径</button>{selectedNodeCount > 1 && <span>已选 {selectedNodeCount}</span>}{visibleMission.status === "ready" && <button type="button" className={`edit-toggle ${planEditing ? "active" : ""}`} onClick={planEditing ? () => { setPlanEditing(false); setPlanDraft(null); setSelectedDraftKey(null); } : beginPlanEdit}>{planEditing ? "完成编辑" : "编辑计划"}</button>}</div>
          <div className="graph-viewport">
          {(selectedTaskKey || selectedDraftKey) && <section className="graph-impact-card" data-testid="graph-impact-card"><span className="eyebrow">DEPENDENCY IMPACT</span><strong>{selectedTaskKey || selectedDraftKey}</strong><div><span>Upstream <b>{graph.impact.upstream.length}</b></span><span>Downstream <b>{graph.impact.downstream.length}</b></span><span className={graph.impact.pendingDownstream.length ? "pending" : ""}>Still waiting <b>{graph.impact.pendingDownstream.length}</b></span></div><small>选中路径已高亮；“Still waiting”只统计未完成的真实下游任务。</small></section>}
          <ReactFlow key={visibleMission.id} nodes={graph.nodes} edges={graph.edges} nodeTypes={nodeTypes} onInit={(instance) => { setFlowInstance(instance); if (pendingFit.current) { pendingFit.current = false; setTimeout(() => instance.fitView({ padding: .16, duration: reducedMotion ? 0 : 320 }), 0); } }} onNodesChange={onGraphNodesChange} onNodeDragStop={saveNodePosition} onConnect={connectDependency} onEdgeDoubleClick={removeDependency} onEdgeMouseEnter={(_, edge) => setHoveredEdgeId(edge.id)} onEdgeMouseLeave={() => setHoveredEdgeId(null)} onNodeClick={(_, node) => { if (node.id === "main") { setSelectedTaskId(null); setSelectedDraftKey(null); setInspectorPanel("conversation"); } else { const real = visibleMission.tasks.find((task) => task.key === node.id); selectTask(real?.id || null); setSelectedDraftKey(node.id); } }} onSelectionChange={({ nodes }) => setSelectedNodeCount(nodes.length)} defaultViewport={visibleMission.uiState?.viewport || { x: 0, y: 0, zoom: 1 }} onMoveEnd={(_, viewport) => persistUi({ viewport })} fitView={!visibleMission.uiState?.viewport} fitViewOptions={{ padding: .18, duration: reducedMotion ? 0 : 320 }} minZoom={.25} maxZoom={1.8} nodesDraggable nodesConnectable={planEditing} elementsSelectable selectionOnDrag panOnDrag={[1, 2]} multiSelectionKeyCode="Meta" deleteKeyCode={null} proOptions={{ hideAttribution: true }}>
            <Background color="#27313b" gap={22} size={1} /><MiniMap pannable zoomable position="bottom-right" nodeColor={(node) => ({ running: "#49b969", completed: "#3a8a4d", attention: "#c78a23", queued: "#56626d" })[node.data?.tone] || "#56626d"} maskColor="rgba(6,9,11,.72)" /><Controls showInteractive />
          </ReactFlow>
          {planEditing && <PlanEditor mission={visibleMission} draft={planDraft} setDraft={setPlanDraft} selectedKey={selectedDraftKey} setSelectedKey={setSelectedDraftKey} onSave={savePlan} onClose={() => { setPlanEditing(false); setPlanDraft(null); setSelectedDraftKey(null); }} busy={busy} />}
          </div>
        </section>}{tab === "tasks" && <TaskTable tasks={visibleMission.tasks} onSelectTask={(id) => { selectTask(id); setTab("graph"); }} />}{tab === "value" && <ValueLedgerView desktop={desktop} mission={visibleMission} busy={busy} onMissionChange={setActiveMission} onNotice={setNotice} />}{tab === "context" && <ContextKernelView desktop={desktop} mission={visibleMission} task={selectedTask} />}{tab === "bus" && <MessageBus messages={visibleMission.messages} />}{tab === "activity" && <ActivityView events={visibleMission.events} onLoadMore={loadOlderEvents} hasMore={hasMoreEvents} busy={busy} />}{tab === "artifacts" && <ArtifactView mission={visibleMission} onAction={artifactAction} onPublish={(artifact, file) => setPublicationTarget({ artifact, file })} onExportReport={exportReport} busy={busy} />}{tab === "spec" && <SpecView mission={visibleMission} busy={busy} onRetryPlan={() => perform(() => desktop.missions.sendMessage({ missionId: visibleMission.id, text: "请根据原始需求重新生成完整的执行计划；等待我确认后再执行。" }))} onApprove={() => perform(() => desktop.missions.approve(visibleMission.id))} />}</main>
        <div className="mission-inspector-resizer" onPointerDown={resizeInspector} role="separator" aria-label="Resize agent inspector" />
        <Inspector mission={visibleMission} task={selectedTask} conversation={conversation} draft={draft} setDraft={setDraft} onSend={sendMessage} busy={busy} panel={inspectorPanel} setPanel={setInspectorPanel} focused={inspectorFocused} onToggleFocus={() => setInspectorFocused((value) => !value)} messageReceipt={messageReceipt} onResume={(taskId, text) => perform(() => desktop.missions.sendMessage({ missionId: visibleMission.id, taskId, text }))} onRequestChanges={(taskId, text) => perform(() => desktop.missions.sendMessage({ missionId: visibleMission.id, taskId, text }))} onArtifactAction={artifactAction} onAccept={(taskId) => perform(() => desktop.missions.acceptTask({ missionId: visibleMission.id, taskId }))} onRetry={(taskId) => perform(() => desktop.missions.retryTask({ missionId: visibleMission.id, taskId }))} onIntegrate={() => perform(() => desktop.missions.integrate(visibleMission.id))} onApproval={(requestId, decision) => perform(() => visibleMission.provider === "codex" ? desktop.codex.approval({ requestId, decision }) : desktop.missions.resolveApproval({ missionId: visibleMission.id, requestId, decision }))} />
      </div>}
      <footer className="mission-status"><span><Database size={13} /> SQLite persisted</span><span><Broadcast size={13} /> {mission?.messages.length || 0} bus records</span><span><GitBranch size={13} /> {mission?.tasks.filter((task) => task.worktreePath).length || 0} real worktrees</span><span className="status-workspace">{workspace?.name || "No workspace"}</span><span>Verified <strong>{mission?.tasks.filter((task) => task.status === "completed").length || 0}/{mission?.tasks.length || 0}</strong></span></footer>
    </section>
    {showNewMission && <NewMissionModal busy={busy} providers={providers} workspace={workspace} onChooseWorkspace={onChooseWorkspace} onClose={() => setShowNewMission(false)} onCreate={createMission} />}
    {artifactPreview && <ArtifactPreview preview={artifactPreview} busy={busy} onClose={() => setArtifactPreview(null)} onAction={artifactAction} />}
    {publicationTarget && mission && <PublishModal desktop={desktop} missionId={mission.id} artifact={publicationTarget.artifact} initialFile={publicationTarget.file} onClose={() => setPublicationTarget(null)} onNotice={setNotice} />}
  </>;
}
