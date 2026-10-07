import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowSquareOut, CheckCircle, FileText, PaperPlaneTilt, ShieldCheck } from "@phosphor-icons/react";
import { reviewGate } from "./review-gate.js";
import { feedbackStarter, reviewItems, reviewRound } from "../shared/review-feedback.mjs";
import { SourceReceipts } from "./SourceReceipts.jsx";
import "./review-decision.css";

const array = value => Array.isArray(value) ? value : [];
const draftKey = (mission, task) => `agent-deck:review:v1:${mission.id}:${task.id}:${reviewRound(task)}`;

function readDraft(key) {
  try { const record = JSON.parse(sessionStorage.getItem(key) || "{}"); return Object.fromEntries(Object.entries(record.drafts || record).filter(([, value]) => typeof value === "string").map(([id, value]) => [id, value.slice(0, 4000)])); } catch { return {}; }
}

function olderDrafts(key) {
  try {
    // Round contains colons; scope by the fixed Mission/task prefix instead.
    const scope = key.split(":").slice(0, 5).join(":") + ":";
    return Object.keys(sessionStorage).filter(item => item !== key && item.startsWith(scope)).map(item => JSON.parse(sessionStorage.getItem(item))).filter(record => record.drafts && Object.values(record.drafts).some(value => typeof value === "string" && value.trim())).sort((a, b) => b.savedAt - a.savedAt).slice(0, 3);
  } catch { return []; }
}

// Current-window storage survives tab/task changes and preview reloads. Each
// result round is isolated: old advice is never automatically applied to a new one.
function writeDraft(key, values, items) {
  try {
    sessionStorage.setItem(key, JSON.stringify({ drafts: values, titles: Object.fromEntries(items.map(item => [item.id, item.title])), savedAt: Date.now() }));
    const keys = Object.keys(sessionStorage).filter(item => item.startsWith("agent-deck:review:v1:"));
    for (const old of keys.slice(0, Math.max(0, keys.length - 32))) if (old !== key) sessionStorage.removeItem(old);
    return true;
  } catch { return false; }
}

export function ReviewDecisionPanel({ mission, task, busy, onRequestChanges, onAccept, onArtifactAction, setPanel, focused, onToggleFocus }) {
  const key = draftKey(mission, task);
  // Remount with this key at the caller, so a late receipt cannot erase another
  // task's drafts. State and drafts remain local; no keystroke crosses IPC.
  const [drafts, setDrafts] = useState(() => readDraft(key));
  const [selected, setSelected] = useState(null);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState(null);
  const [storageError, setStorageError] = useState(false);
  const references = useRef(null);
  const gate = reviewGate(task.result);
  const items = useMemo(() => reviewItems(task.result), [task.result]);
  const visibleItems = items.length ? items : [{ id: "general", title: "其他修改意见", kind: "general", evidence: "", location: "本次交付" }];
  const active = visibleItems.find(item => item.id === selected) || visibleItems[0];
  const entries = visibleItems.filter(item => String(drafts[item.id] || "").trim()).map(item => ({ id: item.id, feedback: drafts[item.id].trim() }));
  const dependencies = array(mission.tasks).filter(item => array(task.dependencies).includes(item.key));
  const artifacts = array(mission.artifacts).filter(item => item.taskId === task.id || dependencies.some(parent => parent.id === item.taskId));
  const delivery = (mission.messages || []).find(item => item.id === receipt?.id) || receipt;
  const disabled = busy || sending || (Boolean(receipt) && delivery?.deliveryStatus !== "failed");
  const history = useMemo(() => olderDrafts(key), [key]);
  useEffect(() => { setStorageError(!writeDraft(key, drafts, visibleItems)); }, [key, drafts]);
  const change = (id, value) => setDrafts(current => ({ ...current, [id]: value }));

  async function submit() {
    if (!entries.length || disabled) return;
    setSending(true);
    try {
      const result = await onRequestChanges(task.id, { round: reviewRound(task), entries });
      if (result?.receipt) setReceipt(result.receipt);
      // Keep all drafts even after queuing: provider delivery can still fail.
    } finally { setSending(false); }
  }

  return <section className="review-workbench" data-testid="review-center" aria-label="逐项审阅">
    <header className="review-overview"><ShieldCheck size={19} /><div><h3>{gate.ready ? "可以验收这次交付" : `${items.length} 项需要你处理`}</h3><p>{gate.passed}/{gate.total} 项检查通过 · {gate.blockers} 个阻塞项</p></div>{!focused && <button type="button" onClick={onToggleFocus}>展开审阅</button>}</header>
    <p className="review-intro">每项单独写意见，共用同一份任务背景。填写不会解除阻塞，Worker 重新提交后才会更新验收状态。</p>
    <div className="review-columns">
      <section className="review-item-list" aria-label="待处理项列表"><h4>{items.length ? "待处理项" : "反馈（可选）"}</h4>
        {visibleItems.map((item, index) => <article className={`review-item ${active.id === item.id ? "selected" : ""}`} key={item.id} data-review-item={item.id}>
          <header><span className="review-number">{String(index + 1).padStart(2, "0")}</span><span className="review-kind">{{ check: "验收未通过", blocker: "Worker 提出的阻塞", missing: "缺少验收记录", general: "结果修改" }[item.kind]}</span><span className="review-draft-status">{drafts[item.id]?.trim() ? "已写意见" : "待填写"}</span></header>
          <h5>{item.title}</h5>
          <button type="button" className="review-text-action" onClick={() => { setSelected(item.id); references.current?.scrollIntoView({ block: "nearest", behavior: "instant" }); }}><FileText size={13} />查看这项的依据</button>
          <label>给这一项的意见<textarea aria-label={`第 ${index + 1} 项处理意见`} maxLength={4000} rows={3} value={drafts[item.id] || ""} onFocus={() => setSelected(item.id)} onChange={event => change(item.id, event.target.value)} disabled={disabled} placeholder="你希望怎么处理？还需要哪些证据？" /></label>
          <button type="button" className="review-text-action" disabled={disabled || Boolean(drafts[item.id]?.trim())} onClick={() => { change(item.id, feedbackStarter(item)); setSelected(item.id); }}>填入反馈模板<span>无需模型调用</span></button>
        </article>)}
      </section>
      <aside ref={references} className="review-reference-region" aria-label="参考依据与共享上下文">
        <header><h4>参考依据与上下文</h4><span>仅展示真实记录</span></header>
        <section className="review-item-source"><h5>第 {visibleItems.indexOf(active) + 1} 项的依据</h5><p className="review-location">{active.location}</p>{active.evidence ? <p>{active.evidence}</p> : <p className="review-missing-evidence">{active.kind === "general" ? "可结合交付结果提出修改意见。" : "该项没有单独的证据说明。请先查看下方任务背景与产物；仍不清楚时，可要求 Worker 补充具体依据或待确认的问题。"}</p>}<button type="button" className="review-text-action" onClick={() => document.querySelector(`[data-review-item="${active.id}"] textarea`)?.focus()}>返回这项，填写意见</button></section>
        <section><h5>共享任务背景</h5><p>{task.description || task.title}</p>{mission.outcome && <details><summary>原始目标</summary><p>{mission.outcome}</p></details>}{array(task.acceptanceCriteria).length > 0 && <details><summary>完成标准 · {task.acceptanceCriteria.length} 项</summary><ul>{task.acceptanceCriteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ul></details>}{task.result?.summary && <details><summary>Worker 本次结论</summary><p>{task.result.summary}</p></details>}</section>
        {array(task.result?.acceptance).length > 0 && <section><details><summary>Worker 提供的检查依据 · {task.result.acceptance.length} 项</summary>{task.result.acceptance.map((check, index) => <div className="review-check-reference" key={index}><h5>{check.passed === true ? "通过" : "未通过"} · {check.criterion}</h5><p>{check.evidence || "未提供证据说明"}</p></div>)}</details><small>检查通过不代表其他阻塞项已解除。</small></section>}
        {dependencies.length > 0 && <section><h5>前置任务提供的背景</h5>{dependencies.map(parent => <details key={parent.id}><summary>{parent.key} · {parent.title}</summary><p>{parent.result?.summary || "尚未提供结果摘要"}</p><small>任务状态：{parent.status} · 不是当前项的独立证据</small></details>)}</section>}
        <section><h5>可打开的参考产物 · {artifacts.length}</h5><small>来自当前及前置任务，未自动判定为某一项的证据。</small>{artifacts.slice(0, 8).map(artifact => <details key={artifact.id} open={artifacts.length === 1}><summary>{artifact.title || "未命名产物"}{artifact.taskId !== task.id ? " · 前置任务" : ""}</summary>{array(artifact.files).slice(0, 8).map(file => <button type="button" className="review-file-link" key={file} title={file} onClick={() => onArtifactAction(/\.html?$/i.test(file) ? "preview" : "open", artifact, file)} disabled={busy}><FileText size={13} /><span>{file}</span><ArrowSquareOut size={13} /></button>)}{!array(artifact.files).length && <p>{artifact.summary || "没有附带文件"}</p>}{array(artifact.files).length > 8 && <small>其余文件请在产物页查看。</small>}</details>)}{!artifacts.length && <p className="review-missing-evidence">尚未登记可打开的产物。</p>}<button className="review-text-action" type="button" onClick={() => setPanel("artifacts")}>查看完整产物列表 <ArrowSquareOut size={13} /></button></section>
        <SourceReceipts events={mission.events || []} taskId={task.id} />
        <section><h5>去哪里继续查找</h5><dl><dt>本次工作目录</dt><dd>{task.worktreePath || mission.executionCwd || mission.cwd || "未登记"}</dd><dt>会话</dt><dd>{task.agentThreadId || "尚未创建"}</dd></dl><p>证据页可查看运行记录、读取回执与变更文件；确需询问 Agent 时再进入对话。</p><div className="review-source-actions"><button type="button" onClick={() => setPanel("evidence")}>查看证据</button><button type="button" onClick={() => setPanel("brief")}>查看完整任务</button></div></section>
      </aside>
    </div>
    {history.length > 0 && <details className="review-draft-history"><summary>查看之前轮次的意见 · 不会自动应用</summary>{history.map((record, index) => <section key={index}>{Object.entries(record.drafts).filter(([, value]) => typeof value === "string" && value.trim()).map(([id, value]) => <div key={id}><h5>{record.titles?.[id] || "旧轮次意见"}</h5><p>{value}</p></div>)}</section>)}</details>}
    <footer className="review-submit"><p>{entries.length ? `已填写 ${entries.length}/${visibleItems.length} 项；合并发送到同一 Worker，会携带共享背景和未填写项。` : "可先处理一项；未填写项会保留为待处理。"}</p>{storageError ? <p role="alert">当前窗口无法保存草稿，请先复制意见以免丢失。</p> : <small>草稿仅保存在本机当前窗口，关闭应用前请发送或复制。</small>}{receipt && <p role="status">{delivery?.deliveryStatus === "failed" ? `反馈未送达：${delivery.error || "请重试"}。草稿仍保留，可以修改后再发送。` : "反馈已入队，不代表已解决。草稿仍保留，发送情况请在对话中查看。"}</p>}<div><button type="button" className="review-send" disabled={disabled || !entries.length} onClick={submit}><PaperPlaneTilt size={14} />{sending ? "正在提交…" : disabled && receipt ? "反馈已入队" : `发送${entries.length ? ` ${entries.length} 项` : ""}反馈`}</button><button type="button" className="review-accept" disabled={disabled || !gate.ready} title={gate.ready ? "确认本次交付" : "Worker 需重新提交且所有检查通过、无阻塞后，才可验收。"} onClick={() => onAccept(task.id)}><CheckCircle size={14} />{gate.ready ? "验收结果" : "暂不可验收"}</button></div></footer>
  </section>;
}
