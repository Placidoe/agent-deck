import { useEffect, useRef, useState } from "react";
import { Clock, Copy, DownloadSimple, ShareNetwork, Warning, X } from "@phosphor-icons/react";
import { SelectControl } from "./SelectControl.jsx";
const isPublishableArtifact = file => /\.(html?|md|txt)$/i.test(file);
export function PublishModal({ desktop, missionId, artifact, initialFile, onClose, onNotice }) {
  const panel = useRef(null), close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const controls = () => [...(panel.current?.querySelectorAll('button:not(:disabled),textarea,input:not(:disabled)') || [])].filter(item => item.getClientRects().length);
    controls()[0]?.focus();
    const keydown = event => {
      if (event.defaultPrevented || document.querySelector(".select-menu")) return;
      if (event.key === "Escape") { event.preventDefault(); close.current(); }
      if (event.key === "Tab") {
        const items = controls(), first = items[0], last = items.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", keydown);
    return () => { document.removeEventListener("keydown", keydown); if (previous?.isConnected) previous.focus(); };
  }, []);
  const files = (artifact.files || []).filter(isPublishableArtifact);
  const [file, setFile] = useState(initialFile || files[0] || "");
  const [platform, setPlatform] = useState("juejin");
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const notify = message => { setNotice(message); onNotice?.(message); };
  const [autoPublish, setAutoPublish] = useState(false);
  const [conversionRevision, setConversionRevision] = useState(0);
  useEffect(() => {
    if (!file) return;
    let disposed = false;
    setBusy(true); setError(""); setDraft(null); setNotice("");
    desktop.artifacts.publication({ missionId, artifactId: artifact.id, file, platform }).then((next) => { if (!disposed) setDraft(next); }).catch((nextError) => { if (!disposed) setError(nextError.message || String(nextError)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [desktop, missionId, artifact.id, file, platform, conversionRevision]);
  useEffect(() => { setAutoPublish(false); }, [file, platform]);
  const input = { missionId, artifactId: artifact.id, file, platform };
  async function run(action) {
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await desktop.artifacts[action](input);
      if (action === "copyPublication") notify(`已复制 ${platform === "juejin" ? "掘金" : "CSDN"} 发布稿，可直接粘贴到编辑器。`);
      if (action === "exportPublication" && !result.canceled) notify(`发布稿已导出到 ${result.destination}`);
      if (action === "openPublisher") notify(`已打开 ${platform === "juejin" ? "掘金" : "CSDN"} 编辑器；请粘贴发布稿并手动确认发布。`);
    } catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setBusy(false); }
  }
  async function runBrowserPublisher(forceAutoPublish = autoPublish) {
    if (!draft || busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await desktop.publisher.publish({ platform, title: draft.title, content: draft.content, autoPublish: forceAutoPublish });
      if (result.state === "needs_login_or_editor") notify("请在发布窗口完成首次登录或验证码；回到编辑器后 Agent Deck 会自动继续填入。");
      else if (!result.ok) setError(result.detail || "发布适配器暂时无法操作该编辑器；你仍可复制稿件后手动发布。");
      else if (result.state === "publish_requested") notify("已请求自动发布；发布窗口会保留，用于处理分类、标签或平台验证。");
      else notify("已自动填入发布窗口，请检查排版后发布。");
    } catch (nextError) { setError(nextError.message || String(nextError)); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop publish-backdrop" onMouseDown={onClose}>
    <section ref={panel} className="modal publish-modal" role="dialog" aria-modal="true" aria-label="生成并发布社区文章" onMouseDown={event => event.stopPropagation()}>
      <header><div><span className="eyebrow">分享文章</span><h2>生成并发布社区文章</h2><p>首次在隔离窗口手动登录；账号密码不进入 Agent Deck，后续复用该平台会话。</p></div><button type="button" className="quiet-button" onClick={onClose} aria-label="关闭发布"><X size={19} /></button></header>
      <div className="publish-controls"><label>来源文件<SelectControl aria-label="来源文件" value={file} disabled={busy} onChange={event => setFile(event.target.value)}>{files.map(item => <option key={item} value={item}>{item}</option>)}</SelectControl></label>
        <label>发布平台<SelectControl aria-label="发布平台" value={platform} disabled={busy} onChange={event => setPlatform(event.target.value)}><option value="juejin">掘金</option><option value="csdn">CSDN</option></SelectControl></label></div>
      {error && <p className="publish-error" role="alert"><Warning size={14} />{error}</p>}
      {error && !draft && !busy && <button className="tool-button publish-retry" onClick={() => setConversionRevision(value => value + 1)}>重新转换</button>}
      {notice && <p className="workflow-notice" role="status">{notice}</p>}
      {busy && !draft ? <div className="publish-loading" role="status"><Clock size={16} />正在转换产物…</div> : draft ? <>
        <section className="publish-summary"><strong>{draft.sourceFormat.toUpperCase()} → Markdown</strong><span>{draft.content.length.toLocaleString()} 字符 · {platform === "juejin" ? "掘金" : "CSDN"} 发布稿</span></section>
        <textarea className="publish-content" readOnly value={draft.content} aria-label="发布稿（只读）" />
        <section className="publish-warnings"><strong>发布前检查</strong><ul>{draft.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul></section>
        <label className="auto-publish-toggle"><input type="checkbox" checked={autoPublish} disabled={busy} onChange={event => setAutoPublish(event.target.checked)} /><span><strong>自动点击发布（Beta）</strong><small>公开发布动作；分类、标签、验证码或二次确认仍需你在平台窗口处理。</small></span></label>
      </> : null}
      <footer><button type="button" className="tool-button" onClick={onClose}>关闭</button>
        <button type="button" className="tool-button" disabled={busy || !draft} onClick={() => run("exportPublication")}><DownloadSimple size={14} />导出 .md</button>
        <button type="button" className="tool-button" disabled={busy || !draft} onClick={() => run("copyPublication")}><Copy size={14} />复制稿件</button>
        <button type="button" className="primary-button" disabled={busy || !draft} onClick={() => runBrowserPublisher()} aria-busy={busy}><ShareNetwork size={14} />{busy ? "正在处理…" : autoPublish ? "自动填入并发布" : "登录并填入发布页"}</button>
      </footer>
    </section>
  </div>;
}
