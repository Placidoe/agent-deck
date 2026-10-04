import { sourceReceipts } from "./source-receipts.js";

export function SourceReceipts({ events, taskId }) {
  const sources = sourceReceipts(events, taskId);
  if (!sources.length) return null;
  return <section className="inspector-block source-receipts"><h3>读取过的来源 <small>{sources.length}</small></h3><p className="muted-copy">仅展示已加载的真实读取回执；读取不等于结论正确，也不代表整份资料都已看完。</p>{sources.map(source => <details key={source.id}><summary>{source.url || source.path}</summary><dl><div><dt>来源类型</dt><dd>{source.kind === "public_web" ? "公开网页 · 无登录信息" : "只读本地资料"}</dd></div><div><dt>读取时间</dt><dd>{new Date(source.readAt).toLocaleString()}</dd></div><div><dt>读取范围</dt><dd>{source.kind === "local_reference" ? `申请范围 ${source.startLine}–${source.endLine} 行` : `${source.bytes} 字节下载`}{source.truncated ? " · 摘录已截断" : " · 摘录未截断"}</dd></div><div><dt>SHA-256</dt><dd><code>{source.sha256}</code></dd></div></dl></details>)}</section>;
}
