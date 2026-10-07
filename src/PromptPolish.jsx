import { useEffect, useRef, useState } from "react";
import { Sparkle } from "@phosphor-icons/react";
import "./prompt-polish.css";

const fingerprint = draft => JSON.stringify([draft.title, draft.outcome, draft.body]);

export function PromptPolish({ desktop, draft, requirementId, onApply, onBusyChange, disabled = false }) {
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState(null);
  const [error, setError] = useState("");
  const [undo, setUndo] = useState(null);
  const request = useRef(null);
  const latest = useRef(draft); latest.current = draft;
  useEffect(() => () => {
    const id = request.current; request.current = null;
    if (id) desktop?.requirements?.cancelPolish?.(id).catch(() => {});
  }, [desktop, requirementId]);
  const cancel = () => {
    const id = request.current; request.current = null;
    setBusy(false); onBusyChange?.(false);
    if (id) desktop?.requirements?.cancelPolish?.(id).catch(() => {});
  };
  const polish = async () => {
    if (busy || disabled || !draft.title.trim()) return;
    const original = { ...draft }, id = crypto.randomUUID();
    request.current = id; setBusy(true); onBusyChange?.(true); setError(""); setCandidate(null);
    try {
      const result = await desktop.requirements.polish({ requestId: id, requirementId, draft: original });
      if (request.current === id) setCandidate({ ...result, original });
    } catch (err) { if (request.current === id) setError(err.message || "润色失败，原文未改动。"); }
    finally { if (request.current === id) { request.current = null; setBusy(false); onBusyChange?.(false); } }
  };
  const stale = candidate && fingerprint(candidate.original) !== fingerprint(draft);
  return <section className="prompt-polish" aria-label="润色工作笔记">
    <div className="polish-toolbar"><div><strong>让表达更清楚</strong><small>只整理表达，不会执行任务。润色会使用当前模型并消耗 Token。</small></div>
      {busy ? <button type="button" onClick={cancel}>取消润色</button> : <button type="button" disabled={disabled || !desktop?.requirements?.polish || !draft.title.trim()} onClick={polish}><Sparkle size={14} />{candidate || undo ? "重新润色" : "帮我润色"}</button>}
    </div>
    {busy && <p role="status">正在整理表达… 你可以继续编辑原文。</p>}
    {error && <p className="polish-error" role="alert">{error}</p>}
    {candidate && <div className="polish-candidate"><div className="polish-caption"><strong>润色建议 · 尚未应用</strong><small>{candidate.model}{Number.isFinite(candidate.usage?.totalTokens) ? ` · ${candidate.usage.totalTokens} Token` : ""}</small></div>
      <div className="polish-preview"><h3>{candidate.draft.title}</h3>{candidate.draft.outcome && <p><b>完成标准</b>{candidate.draft.outcome}</p>}{candidate.draft.body && <p>{candidate.draft.body}</p>}
        {candidate.questions?.length > 0 && <div className="polish-questions"><b>这些信息还需你补充</b><ul>{candidate.questions.map((q, i) => <li key={i}>{q}</li>)}</ul></div>}
      </div>
      <details><summary>查看润色前的原文</summary><p>{[candidate.original.title, candidate.original.outcome, candidate.original.body].filter(Boolean).join("\n\n")}</p></details>
      {stale && <p role="status">原文已修改，请重新润色。旧建议不会覆盖你的编辑。</p>}
      <div className="polish-actions"><button type="button" onClick={() => setCandidate(null)}>保留原文</button><button type="button" className="polish-apply" disabled={stale || disabled} onClick={() => { if (fingerprint(latest.current) !== fingerprint(candidate.original)) return; setUndo({ original: { ...latest.current }, applied: candidate.draft }); onApply(candidate.draft); setCandidate(null); }}>采用这版</button></div>
    </div>}
    {undo && !candidate && !busy && <div className="polish-applied"><small>已采用润色，保存后才会更新笔记。</small><button type="button" disabled={disabled || fingerprint(draft) !== fingerprint(undo.applied)} title="仅在没有后续编辑时可撤销，避免丢失新内容" onClick={() => { onApply(undo.original); setUndo(null); }}>撤销润色</button></div>}
  </section>;
}
