import { SelectControl } from "./SelectControl.jsx";
import { ExecutionModeField } from "./ExecutionModeField.jsx";
import { PromptPolish } from "./PromptPolish.jsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowsClockwise, ArrowRight, CaretDown, ClipboardText, Play, Plus, Sparkle, Warning, X } from "@phosphor-icons/react";
import "./requirement.css";
import { collectWork } from "./work-navigation.js";
import { PersonalPanel, ProjectSelect } from "./PersonalPanel.jsx";

const priorityRank = { urgent: 0, high: 1, medium: 2, low: 3 };
const statusMeta = {
  inbox: { label: "随手记", tone: "quiet" }, clarifying: { label: "需要补充", tone: "attention" },
  ready_to_plan: { label: "待生成计划", tone: "ready" }, planning: { label: "正在生成计划", tone: "working" },
  awaiting_approval: { label: "等你确认计划", tone: "attention" }, running: { label: "正在执行", tone: "working" },
  review: { label: "等你验收", tone: "attention" }, done: { label: "已完成", tone: "done" },
  blocked: { label: "需要你处理", tone: "blocked" }, archived: { label: "已归档", tone: "quiet" },
};

function relativeTime(value) {
  if (!value) return "刚刚";
  const minutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`;
  return `${Math.floor(minutes / 1440)} 天前`;
}
function statusFor(status) { return statusMeta[status] || { label: status, tone: "quiet" }; }
function nextStep(requirement) {
  if (!requirement?.missionId) return { title: "生成一份执行计划", detail: "主 Agent 会先拆解任务与验收标准；这一步不会修改你的代码。", action: "生成计划" };
  if (requirement.status === "awaiting_approval") return { title: "确认执行计划", detail: "计划已就绪。确认后才会创建子 Agent 并开始执行。", action: "查看并确认计划" };
  if (requirement.status === "review") return { title: "验收这次交付", detail: "查看结果、产物和验证记录，再决定是否继续。", action: "查看交付" };
  if (requirement.status === "done") return { title: "任务已完成", detail: "所有进展和产物都保存在对应的执行项目中。", action: "查看结果" };
  if (requirement.status === "blocked") return { title: "处理阻塞", detail: "先检查阻塞原因，再选择相应的恢复操作；环境问题不能仅靠发消息解决。", action: "查看原因" };
  return { title: "查看执行进度", detail: "主 Agent 正在持续同步任务状态与可复用产物。", action: "打开执行项目" };
}

function RequirementComposer({ desktop, initialDraft, workspace, projects = [], projectId, onChooseWorkspace, onCreate, onStartPlan, creating, onClose }) {
  const [chosenProject, setChosenProject] = useState(projects.some(item => item.id === projectId && item.status === "active") ? projectId : "");
  const [title, setTitle] = useState(initialDraft?.title || ""); const [outcome, setOutcome] = useState(initialDraft?.outcome || ""); const [body, setBody] = useState(initialDraft?.body || "");
  const [polishing, setPolishing] = useState(false);
  const executionMode = "auto";
  const [priority, setPriority] = useState("medium"); const [showMore, setShowMore] = useState(false); const [startNow, setStartNow] = useState(false);
  const [tokenBudget, setTokenBudget] = useState("80000");
  useEffect(() => {
    const onKeyDown = (event) => { if (event.key === "Escape" && !creating) onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [creating, onClose]);
  const submit = async (event) => {
    event.preventDefault(); if (creating || polishing || !title.trim() || (startNow && (!workspace || !outcome.trim()))) return;
    const created = await onCreate({ projectId: chosenProject || null, title: title.trim(), outcome: outcome.trim(), body: body.trim(), priority, status: startNow ? "ready_to_plan" : "inbox", workspacePath: workspace?.path || "", executionMode, sourceType: "manual", tokenBudget: Number(tokenBudget || 80000) });
    if (!created) return;
    onClose(); if (startNow) await onStartPlan(created);
  };
  return <div className="requirement-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !creating) onClose(); }}>
    <form className="requirement-composer" onSubmit={submit} aria-label="新建工作">
      <header><div><span className="eyebrow">新建工作</span><h2>你想完成什么？</h2><p>先写清目标。主 Agent 会把它变成一份你可以确认的计划。</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="关闭"><X size={18} /></button></header>
      {!workspace ? <div className="workspace-notice"><Warning size={17} /><div><strong>还没有选择工作区</strong><span>请先在顶部选择一个本地项目。</span></div></div> : <div className="composer-workspace"><span>当前工作区</span><strong title={workspace.path}>{workspace.path}</strong><button type="button" onClick={onChooseWorkspace}>更换</button></div>}
      <ExecutionModeField />
      <ProjectSelect projects={projects.filter(item => item.status === "active")} value={chosenProject} onChange={setChosenProject} label="所属个人项目（可选）" />
      <label>一句话描述要做的事 <b>必填</b><input aria-label="一句话描述要做的事" autoFocus maxLength={300} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：给产品加一个审批需求列表" /></label>
      <label>做到什么程度算完成？ <b>{startNow ? "必填" : "可以之后再补"}</b><input aria-label="做到什么程度算完成" maxLength={2000} value={outcome} onChange={(event) => setOutcome(event.target.value)} placeholder="例如：能创建、筛选、确认审批需求，并有测试" /></label>
      <button type="button" className="more-options" onClick={() => setShowMore((value) => !value)} aria-expanded={showMore}><CaretDown size={15} weight="bold" />{showMore ? "收起补充信息" : "补充背景、链接或优先级（可选）"}</button>
      {showMore ? <div className="more-fields"><label>补充说明<textarea aria-label="补充说明" maxLength={12000} value={body} onChange={(event) => setBody(event.target.value)} placeholder="已有背景、限制、参考链接、验收细节……" /></label><label>优先级<SelectControl value={priority} onChange={(event) => setPriority(event.target.value)}><option value="urgent">紧急</option><option value="high">高</option><option value="medium">普通</option><option value="low">低</option></SelectControl></label><label>Token 预算<input type="number" min="1000" max="5000000" value={tokenBudget} onChange={(event) => setTokenBudget(event.target.value)} /><small>规划执行规模，不代表实际消耗。</small></label></div> : null}
      <PromptPolish desktop={desktop} draft={{ title, outcome, body }} disabled={creating} onBusyChange={setPolishing} onApply={next => { setTitle(next.title); setOutcome(next.outcome); setBody(next.body); if (next.body) setShowMore(true); }} />
      <label className="start-planning"><input type="checkbox" checked={startNow} onChange={(event) => setStartNow(event.target.checked)} /><span><strong>保存后立即生成计划</strong><small>只会分析和拆解，不会直接执行或修改代码。</small></span></label>
      <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button disabled={creating || polishing || !title.trim() || (startNow && (!workspace || !outcome.trim()))}>{creating ? "正在保存…" : <><Sparkle size={16} weight="fill" />{startNow ? "保存并生成计划" : "保存需求"}</>}</button></footer>
    </form>
  </div>;
}

function RequirementQueue({ requirements, selectedId, onSelect, filter, setFilter, onCreate }) {
  const counts = { all: requirements.length, active: requirements.filter((item) => !["done", "archived"].includes(item.status)).length, done: requirements.filter((item) => item.status === "done").length };
  const visible = requirements.filter((item) => filter === "all" || (filter === "active" ? item.status !== "done" && item.status !== "archived" : item.status === "done"));
  return <aside className="requirement-queue"><header><h2>我的工作</h2><span className="queue-count">{requirements.length}</span></header>
    <div className="requirement-filter" role="tablist" aria-label="筛选需求">{[["all", "全部"], ["active", "未完成"], ["done", "已完成"]].map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}<span>{counts[value]}</span></button>)}</div>
    <div className="requirement-list">{visible.length ? visible.map((item) => { const state = statusFor(item.status); return <button type="button" key={item.id} className={selectedId === item.id ? "selected" : ""} onClick={() => onSelect(item.id)}><div className="requirement-list-state"><span className={`status-dot ${state.tone}`} /><span>{state.label}</span><time>{relativeTime(item.updatedAt)}</time></div><strong>{item.title}</strong><small>{item.outcome}</small></button>; }) : <div className="requirement-list-empty"><ClipboardText size={26} /><strong>{filter === "all" ? "还没有工作" : "这里暂时没有内容"}</strong><span>{filter === "all" ? "从一件你想推进的事开始。" : "切换筛选，或创建一条新需求。"}</span>{filter === "all" ? <button onClick={onCreate}><Plus size={15} />创建第一项工作</button> : null}</div>}</div>
  </aside>;
}

function DraftDetail({ desktop, requirement, workspace, onChooseWorkspace, onSave, onStartPlan, busy }) {
  const [title, setTitle] = useState(requirement.title);
  const [outcome, setOutcome] = useState(requirement.outcome || "");
  const [body, setBody] = useState(requirement.body || "");
  const mode = "auto";
  const [saving, setSaving] = useState(false);
  const [polishing, setPolishing] = useState(false);
  const locked = saving || busy || polishing || !["inbox", "clarifying", "ready_to_plan", "blocked"].includes(requirement.status);
  const save = async start => {
    if (locked) return;
    setSaving(true);
    try {
      const updated = await onSave(requirement, { title: title.trim(), outcome: outcome.trim(), body: body.trim() || title.trim(), workspacePath: workspace?.path || requirement.workspacePath || "", executionMode: mode, status: start ? "ready_to_plan" : "inbox" });
      if (start && updated) await onStartPlan(updated);
    } finally { setSaving(false); }
  };
  return <section className="requirement-detail"><div className="requirement-detail-shell draft-detail">
    <header><span className="eyebrow">随手记 · 还未执行</span><h1>把这件事准备好</h1><p>可以继续记笔记；准备好时，再让 Agent 拆解计划。</p></header>
    <label>任务名称<input aria-label="任务名称" value={title} onChange={e => setTitle(e.target.value)} maxLength={300} /></label>
    <label>完成标准<input aria-label="完成标准" maxLength={2000} value={outcome} onChange={e => setOutcome(e.target.value)} placeholder="例如：交付一份带来源的 HTML 方案，可离线阅读" /></label>
    <label>笔记与背景<textarea aria-label="笔记与背景" maxLength={12000} rows={6} value={body} onChange={e => setBody(e.target.value)} /></label>
    <PromptPolish desktop={desktop} requirementId={requirement.id} draft={{ title, outcome, body }} disabled={saving || busy || !["inbox", "clarifying", "ready_to_plan", "blocked"].includes(requirement.status)} onBusyChange={setPolishing} onApply={next => { setTitle(next.title); setOutcome(next.outcome); setBody(next.body); }} />
    <ExecutionModeField />
    <div className="draft-workspace"><span>工作区</span><strong title={workspace?.path || requirement.workspacePath}>{workspace?.name || requirement.workspacePath || "尚未选择"}</strong><button onClick={onChooseWorkspace}>选择文件夹</button></div>
    <footer><button disabled={locked || !title.trim()} onClick={() => save(false)}>保存笔记</button><button className="primary-button" disabled={locked || !title.trim() || !outcome.trim() || !(workspace?.path || requirement.workspacePath)} onClick={() => save(true)}><Play size={14} weight="fill" />{saving || busy ? "正在准备…" : "开始做 · 拆解计划"}</button></footer><small>先生成子任务和依赖，确认计划后才执行。保存笔记不消耗模型 Token。</small>
  </div></section>;
}

function RequirementDetail({ desktop, requirement, workspace, onChooseWorkspace, onSaveDraft, projects, onLinkProject, onStartPlan, onOpenMission, claiming, onCreate }) {
  if (!requirement) return <section className="requirement-detail empty"><div className="empty-icon"><ClipboardText size={27} /></div><h2>从一件想完成的事开始</h2><p>写下想达成的结果，主 Agent 会先准备计划，再由你决定是否执行。</p><button onClick={onCreate}><Plus size={16} />新建工作</button><div className="how-it-works"><span>1 写清目标</span><ArrowRight size={14} /><span>2 看执行计划</span><ArrowRight size={14} /><span>3 确认后执行</span></div></section>;
  if (!requirement.missionId) return <DraftDetail desktop={desktop} key={requirement.id} requirement={requirement} workspace={workspace} onChooseWorkspace={onChooseWorkspace} onSave={onSaveDraft} onStartPlan={onStartPlan} busy={claiming} />;
  const state = statusFor(requirement.status); const next = nextStep(requirement); const canStart = !requirement.missionId && ["inbox", "clarifying", "ready_to_plan", "blocked"].includes(requirement.status); const action = () => canStart ? onStartPlan(requirement) : onOpenMission(requirement);
  const hasRail = Boolean(requirement.missionId);
  return <section className="requirement-detail"><div className="requirement-detail-shell"><header className="detail-heading"><div><span className="eyebrow">工作目标</span><h1>{requirement.title}</h1><div className="detail-status"><span className={`status-dot ${state.tone}`} />{state.label}<span className="detail-updated">更新于 {relativeTime(requirement.updatedAt)}</span></div></div></header>
    <div className="detail-project-link"><ProjectSelect projects={projects.filter(item => item.status === "active" || item.id === requirement.projectId)} value={requirement.projectId} onChange={projectId => onLinkProject(requirement, projectId)} label="所属个人项目" /></div>
    <section className="next-step"><div><span className="eyebrow">下一步</span><h2>{next.title}</h2><p>{next.detail}</p></div><button className="primary-next" onClick={action} disabled={claiming}>{claiming ? "正在启动主 Agent…" : next.action}<ArrowRight size={15} /></button></section>
    <div className={`detail-grid${hasRail ? "" : " single"}`}><div className="detail-primary"><section className="detail-section"><span>完成标准</span><p>{requirement.outcome}</p></section>{requirement.body ? <section className="detail-section"><span>补充说明</span><p className="requirement-body">{requirement.body}</p></section> : null}</div>{hasRail ? <aside className="detail-rail">{requirement.missionId ? <section className="linked-mission"><span className="eyebrow">执行记录</span><strong>{requirement.counts ? `${requirement.counts.completed} / ${requirement.counts.tasks} 个任务已验收` : "已关联执行计划"}</strong><small>状态：{state.label}</small><button onClick={() => onOpenMission(requirement)}>查看执行详情 <ArrowRight size={14} /></button></section> : null}</aside> : null}</div>
    <footer className="detail-footer"><span>本地保存 · {requirement.priority === "medium" ? "普通优先级" : `${({ urgent: "紧急", high: "高", low: "低" })[requirement.priority]}优先级`}</span><span>{requirement.workSource === "mission" ? "来自已有执行项目" : "来自需求记录"}</span></footer>
  </div></section>;
}

export function RequirementHub({ desktop, workspace, codexStatus, onOpenMission, onChooseWorkspace, initialSelectedId = null, onSelectionChange }) {
  const [projects, setProjects] = useState([]); const [projectId, setProjectId] = useState(() => { try { return localStorage.getItem("agentdeck.personal.projectId") || ""; } catch { return ""; } }); const [personalOpen, setPersonalOpen] = useState(false);
  useEffect(() => { try { localStorage.setItem("agentdeck.personal.projectId", projectId); } catch {} }, [projectId]);
  const loadProjects = useCallback(async () => { if (desktop?.personal) { const items = await desktop.personal.projects(); setProjects(items); setProjectId(current => items.some(item => item.id === current) ? current : ""); } }, [desktop]);
  useEffect(() => { loadProjects().catch(err => setError(err.message)); const off = desktop?.personal?.onChange?.(() => loadProjects().catch(err => setError(err.message))); return () => off?.(); }, [desktop, loadProjects]);
  const [capture, setCapture] = useState("");
  const [composerDraft, setComposerDraft] = useState(null);
  const [requirements, setRequirements] = useState([]); const [selectedId, setSelectedId] = useState(initialSelectedId); const [creating, setCreating] = useState(false); const [claiming, setClaiming] = useState(false); const [error, setError] = useState(""); const [composerOpen, setComposerOpen] = useState(false); const [filter, setFilter] = useState("all");
  useEffect(() => { if (selectedId) onSelectionChange?.(selectedId); }, [selectedId, onSelectionChange]);
  const loadRevision = useRef(0);
  const load = useCallback(async () => {
    if (!desktop?.requirements?.list) return;
    const revision = ++loadRevision.current;
    try {
      const [requirements, missions] = await Promise.all([desktop.requirements.list({ workspacePath: projectId ? undefined : workspace?.path }), desktop.missions?.list?.() || []]);
      if (revision !== loadRevision.current) return;
      const items = collectWork(requirements, missions, projectId ? undefined : workspace?.path).filter(item => !projectId || item.projectId === projectId);
      setRequirements(items);
      setSelectedId(current => items.some(item => item.id === current) ? current : items[0]?.id || null);
      setError("");
    } catch (loadError) { if (revision === loadRevision.current) setError(loadError.message || String(loadError)); }
  }, [desktop, workspace?.path, projectId]);
  useEffect(() => { setRequirements([]); load(); return () => { loadRevision.current++; }; }, [load]);
  useEffect(() => { let timer; const off = desktop?.missions?.onUpdate?.(() => { clearTimeout(timer); timer = setTimeout(load, 600); }); return () => { clearTimeout(timer); off?.(); }; }, [desktop, load]);
  const selected = requirements.find((item) => item.id === selectedId) || null; const sorted = useMemo(() => [...requirements].sort((left, right) => priorityRank[left.priority] - priorityRank[right.priority] || String(right.updatedAt).localeCompare(String(left.updatedAt))), [requirements]); const readyCount = sorted.filter((item) => item.status === "ready_to_plan").length;
  const create = async (input) => { setCreating(true); try { const next = await desktop.requirements.create(input); await load(); setProjectId(next.projectId || ""); setPersonalOpen(false); setSelectedId(next.id); return next; } catch (createError) { setError(createError.message || String(createError)); return null; } finally { setCreating(false); } };
  const saveDraft = async (requirement, patch) => { try { const updated = await desktop.requirements.update({ id: requirement.id, patch }); await load(); return updated; } catch (err) { setError(err.message || String(err)); return null; } };
  const startPlan = async requirement => {
    if (!desktop?.requirements?.claimNext) { setError("开始工作需要桌面运行环境。"); return; }
    setClaiming(true);
    try {
      const result = await desktop.requirements.claimNext({ requirementId: requirement.id, workspacePath: requirement.workspacePath, orchestrationMode: "mission" });
      await load();
      if (result?.mission) onOpenMission(result.requirement); else setError("这条需求暂时无法开始，请刷新后重试。");
    } catch (claimError) { setError(claimError.message || String(claimError)); }
    finally { setClaiming(false); }
  };
  const startNext = async () => { const next = sorted.find(item => item.status === "ready_to_plan"); if (next) await startPlan(next); };
  const linkProject = async (work, nextProject) => { try { await desktop.personal.linkWork({ projectId: nextProject || null, ...(work.workSource === "mission" ? { missionId: work.missionId } : { requirementId: work.id }) }); await load(); await loadProjects(); } catch (err) { setError(err.message || String(err)); } };
  return <section className="requirement-hub" data-testid="requirement-hub"><header className="requirement-hub-header"><div><h1>工作</h1><p>先记下来，再开始做。拆解、执行、验收与归档在一条流程里。</p></div><div className="requirement-header-actions"><button className="quiet-action" onClick={() => setPersonalOpen(true)}>项目与记忆</button><button className="quiet-action" onClick={load}><ArrowsClockwise size={15} />刷新</button><button className="new-requirement" onClick={() => setComposerOpen(true)}><Plus size={16} />新建工作</button>{readyCount ? <button className="claim-next" onClick={startNext} disabled={claiming}><Play size={14} weight="fill" />{claiming ? "正在启动…" : `开始下一条 (${readyCount})`}</button> : null}</div></header>
    {!workspace ? <div className="workspace-callout"><Warning size={17} /><div><strong>先选择一个本地工作区</strong><span>工作记录保存在本机，Agent 在你选择的目录中执行。</span></div><button onClick={onChooseWorkspace}>选择工作区</button></div> : <div className="workspace-strip"><span>当前工作区</span><strong>{workspace.name}</strong><small title={workspace.path}>{workspace.path}</small></div>}{error ? <div className="requirement-error"><Warning size={15} />{error}<button onClick={() => setError("")} aria-label="关闭提示"><X size={14} /></button></div> : null}
    {desktop?.personal && !personalOpen ? <div className="work-project-bar"><ProjectSelect projects={projects} value={projectId} onChange={setProjectId} all /><small>{projectId ? "查看这个项目在所有工作区的工作" : "项目可跨多次工作持续保留目标"}</small></div> : null}
    <form className="quick-capture" aria-label="随手记录" onSubmit={async event => { event.preventDefault(); if (!capture.trim() || creating) return; const original = capture; const saved = await create({ title: capture.trim(), status: "inbox", workspacePath: workspace?.path || "", projectId: projectId || null }); if (saved) setCapture(current => current === original ? "" : current); }}><Plus size={17} /><input aria-label="记录一件事" placeholder="记一个想法、待办或笔记…  回车保存，不会开始执行" value={capture} onChange={event => setCapture(event.target.value)} maxLength={300} /><button type="button" disabled={creating || !capture.trim()} onClick={() => { setComposerDraft({ title: capture, outcome: "", body: "" }); setComposerOpen(true); }}><Sparkle size={14} />润色一下</button><button disabled={!desktop || creating || !capture.trim()}>{creating ? "保存中…" : "记下来"}</button></form>
    <div className="requirement-layout"><RequirementQueue requirements={sorted} selectedId={selectedId} onSelect={id => { setSelectedId(id); setPersonalOpen(false); }} filter={filter} setFilter={setFilter} onCreate={() => setComposerOpen(true)} />{personalOpen ? <PersonalPanel desktop={desktop} projects={projects} projectId={projectId} onProjectChange={setProjectId} onChanged={async () => { await loadProjects(); await load(); }} onBack={() => setPersonalOpen(false)} onOpenMission={onOpenMission} onNewWork={() => workspace ? setComposerOpen(true) : onChooseWorkspace?.()} /> : <RequirementDetail desktop={desktop} requirement={selected} workspace={workspace} onChooseWorkspace={onChooseWorkspace} onSaveDraft={saveDraft} projects={projects} onLinkProject={linkProject} onStartPlan={startPlan} onOpenMission={onOpenMission} claiming={claiming} onCreate={() => workspace ? setComposerOpen(true) : onChooseWorkspace?.()} />}</div>{composerOpen ? <RequirementComposer desktop={desktop} initialDraft={composerDraft} workspace={workspace} projects={projects} projectId={projectId} onChooseWorkspace={onChooseWorkspace} creating={creating} onCreate={async input => { const saved = await create(input); if (saved && composerDraft) setCapture(current => current === composerDraft.title ? "" : current); return saved; }} onStartPlan={startPlan} onClose={() => { setComposerOpen(false); setComposerDraft(null); }} /> : null}
  </section>;
}
