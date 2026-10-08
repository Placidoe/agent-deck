import { useEffect, useRef, useState } from "react";
import { ArrowRight, Coffee, Leaf, PersonSimpleWalk, PencilSimple, X } from "@phosphor-icons/react";
import { SelectControl } from "./SelectControl.jsx";
import "./waiting-companion.css";

const options = [
  { id: "quiet", label: "静一静", Icon: Leaf, detail: "闭目养神、静坐，按自己习惯自然呼吸。没有课程，也不要求打卡。" },
  { id: "move", label: "动一动", Icon: PersonSimpleWalk, detail: "离开椅子走一走、喝水，或做自己熟悉的运动。按身体状态选择，不必赶时间。" },
  { id: "work", label: "继续工作", Icon: PencilSimple, detail: "准备下一件事、审阅另一份交付，或阅读已有成果。不会自动启动新任务。" },
  { id: "away", label: "不用管我", Icon: Coffee, detail: "自由安排这段时间。没有任务安排，也不会把休息算成绩效。" },
];
const statusLabels = { planning: "正在准备计划", running: "正在执行", integrating: "正在集成", review: "等待验收", ready_to_integrate: "等待集成审阅", completed: "已完成", canceled: "已停止", blocked: "出现阻塞", failed: "执行失败", integration_conflict: "集成有冲突", ready: "等待确认计划" };
export function clockText(deadline, now = Date.now()) {
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

// Mounted outside destinations: switching views does not reset the personal timer.
export function WaitingCompanion({ desktop, onNavigate, onOpenWork }) {
  const [state, setState] = useState({ active: [], session: null });
  const [open, setOpen] = useState(false), [recap, setRecap] = useState(null);
  const [activity, setActivity] = useState("quiet"), [minutes, setMinutes] = useState(5);
  const [reminders, setReminders] = useState("return"), [critical, setCritical] = useState(true);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [now, setNow] = useState(Date.now());
  const panel = useRef(null), trigger = useRef(null), revision = useRef(0);
  const session = state.session, selected = options.find(item => item.id === (session?.activity || activity));
  useEffect(() => {
    if (!desktop?.waiting) return;
    let disposed = false, timer;
    const refresh = async () => {
      const request = ++revision.current;
      try { const next = await desktop.waiting.read(); if (!disposed && request === revision.current) setState(next); }
      catch (err) { if (!disposed && request === revision.current) setError(err.message); }
    };
    refresh();
    const off = desktop.missions?.onUpdate?.(() => { if (!timer) timer = setTimeout(() => { timer = null; refresh(); }, 1000); });
    const visible = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; revision.current++; clearTimeout(timer); off?.(); document.removeEventListener("visibilitychange", visible); };
  }, [desktop]);
  useEffect(() => {
    if (!session?.deadline) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [session?.deadline]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    const focusable = () => [...(panel.current?.querySelectorAll('button:not(:disabled),[tabindex="0"]') || [])].filter(node => node.getClientRects().length);
    focusable()[0]?.focus();
    const key = event => {
      if (document.querySelector(".select-menu")) return;
      if (event.key === "Escape") { event.preventDefault(); setOpen(false); }
      if (event.key === "Tab") {
        const list = focusable(), first = list[0], last = list.at(-1);
        if (event.shiftKey && (document.activeElement === first || !panel.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !panel.current?.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous?.isConnected) previous.focus(); else trigger.current?.focus(); };
  }, [open]);
  if (!desktop?.waiting || (!state.active.length && !session && !recap && !error && !open)) return null;
  const expired = session?.deadline && now >= session.deadline;
  const act = async action => {
    setBusy(true); setError(""); revision.current++;
    try { const next = await action(); revision.current++; setState(next); return next; }
    catch (err) { setError(err.message || String(err)); return null; }
    finally { setBusy(false); }
  };
  const start = async () => { setRecap(null); await act(() => desktop.waiting.start({ activity, minutes, reminders, criticalReminders: critical })); };
  const finish = async () => { const next = await act(() => desktop.waiting.finish(session.id)); if (next) { setRecap(next.session); setState({ ...next, session: null }); } };
  const navigate = destination => { setOpen(false); onNavigate(destination); };
  const rows = recap?.changes || session?.changes || [];
  return <>
    <aside className="waiting-strip" aria-label="个人时间">
      <button ref={trigger} onClick={() => { setOpen(true); setNow(Date.now()); }}><selected.Icon size={16} /><span>{session ? `${selected.label} · ${session.deadline ? expired ? "时间到了，按自己的节奏结束" : clockText(session.deadline, now) : "不计时"}` : recap ? "回来看看，这段时间发生了什么" : "Agent 在工作，你可以做自己的事"}</span><ArrowRight size={14} /></button>
      <small>{session ? "不改变任务或权限" : "静一静 · 动一动 · 继续工作"}</small>
    </aside>
    {open && <div className="waiting-backdrop"><section ref={panel} className="waiting-panel" role="dialog" aria-modal="true" aria-label="等待时做自己的事">
      <header><div><small>留一点时间给自己</small><h2>{recap ? "欢迎回来" : session ? selected.label : "不用一直盯着 Agent"}</h2></div><button aria-label="收起个人时间" onClick={() => setOpen(false)}><X size={18} /></button></header>
      <div className="waiting-panel-scroll">
        {error && <p className="waiting-error" role="alert">{error}</p>}
        {!session && !recap ? <>
          <p className="waiting-copy">{state.active.length ? "工作继续由 Agent 推进。休息也是一个好选择，不需要填满每一分钟。" : "当前已没有正在执行的工作。可以收起面板继续自己的安排；不会自动开始新任务。"}</p>
          <div className="waiting-options" role="group" aria-label="选择活动">{options.map(({ id, label, Icon }) => <button key={id} aria-pressed={activity === id} onClick={() => { setActivity(id); if (id === "away") { setReminders("return"); setMinutes(0); } }}><Icon size={20} /><span>{label}</span></button>)}</div>
          <p className="waiting-activity-detail">{selected.detail}</p>
          <div className="waiting-settings"><label>自己的时长<SelectControl aria-label="个人时间时长" value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{[0, 3, 5, 10, 20].map(value => <option key={value} value={value}>{value ? `${value} 分钟` : "不计时"}</option>)}</SelectControl></label><label>普通状态更新<SelectControl aria-label="工作更新提醒" value={reminders} onChange={e => setReminders(e.target.value)}><option value="return">等我回来再看</option><option value="notify">就绪时提醒我</option></SelectControl></label></div>
          <button className="waiting-check" role="checkbox" aria-checked={critical} onClick={() => setCritical(value => !value)}><span>{critical ? "✓" : ""}</span>阻塞或授权请求仍提醒我</button>
          <p className="waiting-footnote">只跟踪此刻正在执行的最多 20 项 Agent Deck 工作；不包含独立外部会话。计时不是任务预计耗时。应用需保持运行；系统通知受通知权限、专注模式与休眠影响。</p>
          <button className="waiting-primary" disabled={busy || !state.active.length} onClick={start}>{busy ? "正在准备…" : "开始这段个人时间"}<ArrowRight size={15} /></button>
        </> : <>
          {session && <><div className="waiting-timer"><selected.Icon size={28} /><strong>{session.deadline ? clockText(session.deadline, now) : "不计时"}</strong><span>{expired ? "时间到了。愿意的话可以继续，不会催促你。" : selected.detail}</span></div><p className="waiting-footnote">{session.reminders === "return" ? "普通更新等你回来查看。" : "就绪时请求系统提醒；不保证系统送达。"}{session.criticalReminders ? "阻塞与授权请求仍会请求提醒。" : "阻塞与授权也不提醒；任务仍保留原来的审批边界。"}退出应用会结束这段个人时间。</p></>}
          {session?.activity === "work" && <div className="waiting-work-links"><button onClick={() => navigate("requirements")}>准备下一件事</button><button onClick={() => navigate("attention")}>审阅已有工作</button><button onClick={() => navigate("results")}>阅读已有成果</button></div>}
          <section className="waiting-brief"><h3>{recap ? "离开期间的变化" : "随时回来接住结果"}</h3><p>与这段时间开始时比较，来自本机任务账本。新产物不等于已验收。</p>{rows.map(row => <button key={row.id} onClick={() => { setOpen(false); onOpenWork(row.id); }}><span><strong>{row.title}</strong><small>{row.missing ? "记录暂不可用" : statusLabels[row.status] || row.status}{row.critical?.length > 0 ? " · 有阻塞或授权待处理" : ""}</small></span><span className="waiting-deltas">完成节点 +{row.newCompleted}<br />登记产物 +{row.newArtifacts}</span><ArrowRight size={14} /></button>)}</section>
          <p className="waiting-footnote">{state.notifications === "unavailable" ? "系统通知不可用，请回来查看待我处理。" : "提醒不会授权、验收、停止或启动任务。"}</p>
          {session ? <button className="waiting-primary" disabled={busy} onClick={finish}>{busy ? "正在读取…" : "我回来了 · 看变化"}</button> : <button className="waiting-primary" onClick={() => { setRecap(null); setOpen(false); }}>继续我的工作</button>}
        </>}
      </div>
    </section></div>}
  </>;
}
