import { useMemo, useState } from "react";
import { ArrowRight, ArrowsClockwise, CheckCircle, Clock, GitMerge, ListChecks, ShieldWarning, Sparkle, Warning, WarningCircle } from "@phosphor-icons/react";
import { AgentAvatar } from "./AgentAvatar";
import { attentionProfiles, rankAttention } from "./attentionPolicy";
import "./attention.css";

const typeMeta = {
  plan_review: { label: "计划确认", icon: ListChecks, group: "review" }, worker_review: { label: "结果验收", icon: CheckCircle, group: "review" },
  worker_approval: { label: "操作许可", icon: ShieldWarning, group: "approval" }, worker_blocked: { label: "阻塞", icon: WarningCircle, group: "blocked" },
  integration_ready: { label: "交付集成", icon: GitMerge, group: "ready" }, integration_conflict: { label: "冲突", icon: Warning, group: "blocked" }, mission_failed: { label: "恢复", icon: WarningCircle, group: "blocked" },
};

function relativeTime(value) { if (!value) return "—"; const seconds = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 1000)); if (seconds < 60) return "刚刚"; if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`; if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`; return `${Math.floor(seconds / 86400)} 天前`; }
function actionLabel(item) { return ({ plan_review: "查看计划", worker_review: "验收结果", worker_approval: "查看许可", worker_blocked: "处理阻塞", integration_ready: "审阅集成", integration_conflict: "处理冲突", mission_failed: "查看恢复方案" })[item.type] || "查看详情"; }
function Priority({ item }) { const title = item.profileBoost ? `Operational P${item.basePriority}; personal ordering ${item.profileBoost > 0 ? "+" : ""}${item.profileBoost}` : "Derived from mission state and dependency impact"; return <span className={`attention-priority ${item.severity}`} title={title}>P{item.priority || 0}</span>; }
function WhyNow({ item }) { const factors = [...(item.whyNow?.filter(Boolean) || []), item.preferenceReason ? `偏好排序：${item.preferenceReason}` : null].filter(Boolean); return <div className="attention-why-now"><span>为什么需要你</span><div>{factors.slice(0, 3).map((factor) => <b key={factor}>{factor}</b>)}</div></div>; }

function AttentionCard({ item, onOpen, onDefer }) {
  const meta = typeMeta[item.type] || { label: "Attention", icon: Warning }; const Icon = meta.icon;
  return <article className={`attention-card ${item.severity}`} data-testid="attention-card"><header><span className="attention-kind"><Icon size={14} weight="duotone" />{meta.label}</span><div><Priority item={item} /><time>{relativeTime(item.updatedAt)}</time></div></header><div className="attention-owner"><AgentAvatar name={item.agentRole} role={item.agentRole} main={!item.taskId} size="md" status={item.severity === "critical" ? "attention" : "queued"} /><div><span>{item.missionTitle}</span><strong>{item.taskId ? item.taskTitle : item.title}</strong><small>{item.agentRole}</small></div></div><section><span>决策背景</span><p>{item.reason}</p></section><WhyNow item={item} /><footer><span className={`attention-severity ${item.severity}`}><i />{item.severity}{item.impact ? ` · ${item.impact} downstream` : ""}</span><div><button className="attention-defer" type="button" title="Remind me in one hour" onClick={() => onDefer(item, 60)}><Clock size={13} />1 小时</button><button type="button" onClick={() => onOpen(item)}>{actionLabel(item)}<ArrowRight size={13} /></button></div></footer></article>;
}

function Empty({ filtered = false }) { return <div className="attention-empty"><Sparkle size={30} weight="duotone" /><strong>{filtered ? "这个分类暂无待办" : "暂时没有需要处理的事"}</strong><span>{filtered ? "可以切换其他分类。" : "有需要确认的计划、许可或交付时，会出现在这里。"}</span></div>; }

function FocusLens({ items, onOpen, onDefer }) {
  const [cursor, setCursor] = useState(0); const item = items[Math.min(cursor, Math.max(0, items.length - 1))];
  if (!item) return <Empty />;
  const meta = typeMeta[item.type] || { label: "Attention", icon: Warning }; const Icon = meta.icon; const next = items.filter((entry) => entry.id !== item.id).slice(0, 3);
  const defer = async (minutes) => { await onDefer(item, minutes); setCursor(0); };
  return <div className="focus-lens" data-testid="attention-focus-lens"><section className={`focus-decision ${item.severity}`}><div className="focus-decision-top"><span className="focus-kicker"><Icon size={15} />先处理这一件</span><Priority item={item} /></div><div className="focus-owner"><AgentAvatar name={item.agentRole} role={item.agentRole} main={!item.taskId} size="lg" status={item.severity === "critical" ? "attention" : "queued"} /><div><span>{item.missionTitle}</span><h2>{item.taskId ? item.taskTitle : item.title}</h2><p>{item.agentRole} · {relativeTime(item.updatedAt)}</p></div></div><p className="focus-reason">{item.reason}</p><WhyNow item={item} /><div className="focus-actions"><button className="focus-open" type="button" onClick={() => onOpen(item)}>{actionLabel(item)}<ArrowRight size={15} /></button><div className="focus-defer"><span>稍后处理</span><button type="button" onClick={() => defer(15)}>15 分钟</button><button type="button" onClick={() => defer(60)}>1 小时</button><button type="button" onClick={() => defer(1440)}>明天</button></div></div></section><aside className="focus-next"><header><div><span className="eyebrow">接下来</span><strong>{items.length - 1} 项其他待办</strong></div>{items.length > 1 ? <button type="button" onClick={() => setCursor((value) => (value + 1) % items.length)}>换一项</button> : null}</header>{next.map((entry) => <button type="button" key={entry.id} onClick={() => setCursor(items.findIndex((candidate) => candidate.id === entry.id))}><Priority item={entry} /><div><strong>{entry.taskId ? entry.taskTitle : entry.title}</strong><span>{entry.missionTitle}</span></div><ArrowRight size={13} /></button>)}</aside></div>;
}

function ControlLens({ items, counts, onOpen, onDefer }) {
  const [filter, setFilter] = useState("all"); const filters = [["all", "全部"], ["review", "待验收"], ["blocked", "阻塞"], ["approval", "待授权"], ["ready", "待集成"]]; const visible = filter === "all" ? items : items.filter((item) => typeMeta[item.type]?.group === filter); const urgent = visible.filter((item) => item.severity === "critical"); const decisions = visible.filter((item) => item.severity !== "critical");
  return <><nav className="attention-filters" aria-label="Filter attention items">{filters.map(([id, label]) => <button type="button" key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}<b>{id === "all" ? items.length : counts[id] || 0}</b></button>)}</nav><div className="attention-scroll">{!visible.length ? <Empty filtered={Boolean(items.length)} /> : null}{urgent.length ? <section className="attention-group"><header><div><i /><strong>优先处理</strong></div><span>{urgent.length} blocking</span></header><div className="attention-grid">{urgent.map((item) => <AttentionCard key={item.id} item={item} onOpen={onOpen} onDefer={onDefer} />)}</div></section> : null}{decisions.length ? <section className="attention-group"><header><div><i className="decision" /><strong>等待你的决定</strong></div><span>{decisions.length} waiting</span></header><div className="attention-grid">{decisions.map((item) => <AttentionCard key={item.id} item={item} onOpen={onOpen} onDefer={onDefer} />)}</div></section> : null}</div></>;
}

function BriefingLens({ briefing, onOpen }) {
  if (!briefing) return <div className="attention-scroll"><Empty /></div>;
  const cards = [["Now", briefing.totals.openDecisions, "open decisions"], ["In flight", briefing.totals.activeWorkers, "active workers"], ["Verified", briefing.totals.verifiedLastDay, "last 24 hours"], ["Artifacts", briefing.totals.artifactsLastDay, "published last 24 hours"]];
  return <div className="briefing-lens" data-testid="attention-briefing-lens"><p className="briefing-source">A read-only briefing derived from the local Mission ledger. Updated {relativeTime(briefing.generatedAt)}.</p><section className="briefing-stats">{cards.map(([label, value, note]) => <article key={label}><span>{label}</span><strong>{value}</strong><small>{note}</small></article>)}</section><div className="briefing-columns"><section><header><span className="eyebrow">DECISIONS TO MAKE</span><h2>What needs you now</h2></header>{briefing.topItems.length ? briefing.topItems.map((item) => <button key={item.id} type="button" className="briefing-item" onClick={() => onOpen(item)}><Priority item={item} /><div><strong>{item.taskId ? item.taskTitle : item.title}</strong><span>{item.whyNow?.[0] || item.reason}</span></div><ArrowRight size={14} /></button>) : <p className="briefing-quiet">No decisions are waiting.</p>}</section><section><header><span className="eyebrow">CHANGED RECENTLY</span><h2>Mission pulse</h2></header>{briefing.recentMissions.length ? briefing.recentMissions.map((mission) => <article className="briefing-mission" key={mission.id}><div><strong>{mission.title}</strong><span>{mission.completedCount}/{mission.taskCount} tasks completed</span></div><small>{mission.status.replaceAll("_", " ")} · {relativeTime(mission.updatedAt)}</small></article>) : <p className="briefing-quiet">No Mission changes in the last 24 hours.</p>}</section></div></div>;
}

export function AttentionCenter({ items, briefing, loading, error, onRefresh, onOpen, onDefer }) {
  const [lens, setLens] = useState(() => { try { return localStorage.getItem("agent-deck:attention-lens") || "focus"; } catch { return "focus"; } });
  const [profile, setProfile] = useState(() => { try { return localStorage.getItem("agent-deck:attention-profile") || "flow"; } catch { return "flow"; } });
  const rankedItems = useMemo(() => rankAttention(items, profile), [items, profile]);
  const counts = useMemo(() => rankedItems.reduce((result, item) => { const group = typeMeta[item.type]?.group || "blocked"; result[group] = (result[group] || 0) + 1; return result; }, {}), [rankedItems]);
  const chooseLens = (nextLens) => { setLens(nextLens); try { localStorage.setItem("agent-deck:attention-lens", nextLens); } catch { /* local preference is optional */ } };
  const chooseProfile = (nextProfile) => { setProfile(nextProfile); try { localStorage.setItem("agent-deck:attention-profile", nextProfile); } catch { /* local preference is optional */ } };
  return <section className="attention-center focused-attention" data-testid="attention-center">
    <header className="attention-header"><div><h1>待我处理 <small>{rankedItems.length}</small></h1><p>只看需要你决定的事。其余工作继续由 Agent 推进。</p></div><button type="button" aria-label="刷新待办" onClick={onRefresh} disabled={loading}><ArrowsClockwise size={16} /></button></header>
    <div className="attention-view-options">
      <nav aria-label="注意力视图">{[["focus", "逐项处理"], ["control", "全部待办"], ["briefing", "工作简报"]].map(([id, label]) => <button key={id} aria-current={lens === id ? "page" : undefined} onClick={() => chooseLens(id)}>{label}</button>)}</nav>
      <label>优先考虑<select aria-label="待办排序偏好" value={profile} onChange={event => chooseProfile(event.target.value)}>{attentionProfiles.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
    </div>
    <div className="attention-projection">{error ? <div className="attention-error" role="alert"><Warning size={16} />{error}</div> : null}{loading && !items.length ? <div className="attention-empty"><ArrowsClockwise size={28} /><strong>正在读取待办…</strong></div> : lens === "focus" ? <FocusLens items={rankedItems} onOpen={onOpen} onDefer={onDefer} /> : lens === "control" ? <ControlLens items={rankedItems} counts={counts} onOpen={onOpen} onDefer={onDefer} /> : <BriefingLens briefing={briefing} onOpen={onOpen} />}</div>
  </section>;
}
