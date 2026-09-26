import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ArrowsClockwise, FileCode, MagnifyingGlass } from "@phosphor-icons/react";
import { outcomeGroups } from "./work-navigation.js";

export function ResultsHub({ desktop, onOpen }) {
  const [missions, setMissions] = useState([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const load = useCallback(async () => {
    if (!desktop?.missions?.list) return;
    const request = ++revision.current;
    setLoading(true);
    try { const result = await desktop.missions.list(); if (request === revision.current) { setMissions(result); setError(""); } }
    catch (error) { if (request === revision.current) setError(error.message); }
    finally { if (request === revision.current) setLoading(false); }
  }, [desktop]);
  useEffect(() => {
    load();
    let timer;
    const unsubscribe = desktop?.missions?.onUpdate?.(() => { clearTimeout(timer); timer = setTimeout(load, 600); });
    return () => { revision.current++; clearTimeout(timer); unsubscribe?.(); };
  }, [desktop, load]);
  const groups = useMemo(() => outcomeGroups(missions, query), [missions, query]);
  return <section className="results-hub">
    <header><div><h1>成果</h1><p>按工作归集所有工作区的已登记产出。产出不代表已验收。</p></div><button onClick={load} disabled={loading} aria-label="刷新成果"><ArrowsClockwise size={16} /></button></header>
    <label className="results-search"><MagnifyingGlass size={16} /><input placeholder="搜索工作名称或目标" aria-label="搜索成果" value={query} onChange={event => setQuery(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
    <div className="outcome-collections">{groups.map(mission => <button key={mission.id} className="outcome-collection" onClick={() => onOpen(mission)}><span className="outcome-file"><FileCode size={24} /></span><div><h2>{mission.title}</h2><p>{mission.outcome}</p><small>{mission.counts.artifacts} 份登记产出<span>·</span>{mission.status === "completed" ? "工作已完成" : "查看验收状态"}<span>·</span>{mission.cwd?.split("/").pop()}</small></div><ArrowUpRight size={18} /></button>)}</div>
    {!groups.length && <div className="product-empty"><FileCode size={30} /><h2>{loading ? "正在读取成果…" : query ? "没有匹配的成果" : "成果会出现在这里"}</h2><p>{!desktop ? "浏览器仅供预览。请在桌面 App 中查看真实产物。" : "Agent 发布产物后，可在这里进入预览、导出与来源记录。"}</p></div>}
  </section>;
}
