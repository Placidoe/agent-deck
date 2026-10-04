import { useEffect, useState } from "react";
import { ArrowSquareOut, Clock, Copy, DownloadSimple, ShareNetwork, Warning, X } from "@phosphor-icons/react";
import { SelectControl } from "./SelectControl.jsx";
const isPublishableArtifact = file => /\.(html?|md|txt)$/i.test(file);
export function PublishModal({ desktop, missionId, artifact, initialFile, onClose, onNotice }) {
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
