import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Plus, X } from "@phosphor-icons/react";
import "./personal.css";

const labels = { planning: "生成计划中", ready: "待确认计划", running: "执行中", review: "待验收", completed: "已完成", ready_to_integrate: "待集成", integrating: "集成中", blocked: "受阻", failed: "失败", integration_conflict: "集成冲突", canceled: "已取消", waiting_approval: "待批准操作" };

export function ProjectSelect({ projects, value, onChange, label = "个人项目", all = false }) {
  return <label className="personal-project-select"><span>{label}</span><select value={value || ""} onChange={event => onChange(event.target.value)}><option value="">{all ? "当前工作区 · 全部工作" : "不关联项目"}</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}{project.status === "archived" ? " · 已归档" : ""}</option>)}</select></label>;
}

function ProjectForm({ project, busy, onSave, onClose }) {
  const [name, setName] = useState(project?.name || "");
  const [goal, setGoal] = useState(project?.goal || "");
  return <form className="personal-form" onSubmit={event => { event.preventDefault(); onSave({ id: project?.id, revision: project?.revision, name, goal }); }}>
    <header><h3>{project ? "编辑个人项目" : "新建个人项目"}</h3><button type="button" onClick={onClose} aria-label="关闭项目表单"><X size={16} /></button></header>
    <label>项目名称<input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} placeholder="例如：我的产品发布" /></label>
    <label>长期目标<textarea required maxLength={1800} value={goal} onChange={event => setGoal(event.target.value)} placeholder="这个项目要达成什么？有哪些长期约束？" /></label>
    <p>名称、目标和本项目已验收的结果可用于后续 Agent 请求。保存项目不会启动执行。</p>
    <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button type="submit" className="personal-primary" disabled={busy || !name.trim() || !goal.trim()}>{busy ? "保存中…" : "保存项目"}</button></footer>
  </form>;
}

function MemoryForm({ memory, project, busy, onSave, onClose }) {
  const [key, setKey] = useState(memory?.key || "");
  const [content, setContent] = useState(memory?.content || "");
  const [kind, setKind] = useState(memory?.kind || "preference");
  const [status, setStatus] = useState(memory?.status || "confirmed");
  const [share, setShare] = useState(memory?.shareWithAgent || false);
  const [source, setSource] = useState(memory?.sourceLabel || "你手动保存");
  const [sourceRef, setSourceRef] = useState(memory?.sourceRef || "");
  const [expires, setExpires] = useState(memory?.expiresAt ? new Date(new Date(memory.expiresAt).getTime() - new Date(memory.expiresAt).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "");
  const scope = memory ? (memory.projectId ? project?.name : "全部项目") : project?.name || "全部项目";
  return <form className="personal-form" onSubmit={event => { event.preventDefault(); onSave({ id: memory?.id, revision: memory?.revision, projectId: memory ? memory.projectId : project?.id || null, key, content, kind, status, shareWithAgent: share, sourceLabel: source, sourceRef, expiresAt: expires ? new Date(expires).toISOString() : null }); }}>
    <header><h3>{memory ? "编辑记忆" : "保存一条记忆"}</h3><button type="button" onClick={onClose} aria-label="关闭记忆表单"><X size={16} /></button></header>
    <p>作用范围：{scope}。由你确认，不会从聊天里自动推断。</p>
    <label>记忆名称<input autoFocus required maxLength={100} value={key} onChange={event => setKey(event.target.value)} placeholder="例如：报告语言" /></label>
    <label>记住什么<textarea required maxLength={2400} value={content} onChange={event => setContent(event.target.value)} placeholder="例如：研究报告用中文；保留一手来源链接。" /></label>
    <details className="personal-memory-options"><summary>来源、有效期与确认状态（可选）</summary><div className="personal-form-row"><label>类型<select value={kind} onChange={event => setKind(event.target.value)}><option value="preference">个人偏好</option><option value="fact">事实</option><option value="decision">已作决定</option><option value="goal">长期目标</option></select></label><label>确认状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="confirmed">已确认</option><option value="candidate">待确认，不用于执行</option></select></label></div>
    <div className="personal-form-row"><label>来源说明<input maxLength={160} value={source} onChange={event => setSource(event.target.value)} /></label><label>有效期（可选）<input type="datetime-local" value={expires} onChange={event => setExpires(event.target.value)} /></label></div>
    <label>来源链接或路径（可选）<input maxLength={500} value={sourceRef} onChange={event => setSourceRef(event.target.value)} /></label></details>
    <label className="personal-checkbox"><input type="checkbox" checked={share} onChange={event => setShare(event.target.checked)} /><span>允许用于 Agent 请求<small>内容及来源可能发送给你配置的模型服务。取消后不再主动注入新请求；不会撤回或抹除已有会话内容。</small></span></label>
    <footer><button type="button" onClick={onClose} disabled={busy}>取消</button><button className="personal-primary" disabled={busy || !key.trim() || !content.trim()}>{busy ? "保存中…" : "保存记忆"}</button></footer>
  </form>;
}

export function PersonalPanel({ desktop, projects, projectId, onProjectChange, onChanged, onBack, onOpenMission, onNewWork }) {
  const project = projects.find(item => item.id === projectId);
  const [memories, setMemories] = useState([]); const [recovery, setRecovery] = useState(null);
  const [form, setForm] = useState(null); const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [deleting, setDeleting] = useState(null);
  const [context, setContext] = useState(null);
  const refresh = useCallback(async () => {
    if (!desktop?.personal) return;
    const values = await Promise.all([desktop.personal.memories({ projectId: projectId || null }), projectId ? desktop.personal.recovery(projectId) : null]);
    return values;
  }, [desktop, projectId]);
  useEffect(() => {
    let current = true;
    setMemories([]); setRecovery(null); setContext(null); setForm(null); setDeleting(null); setError("");
    refresh().then(values => { if (current && values) { setMemories(values[0]); setRecovery(values[1]); } }).catch(err => { if (current) setError(err.message); });
    let timer;
    const off = desktop?.missions?.onUpdate?.(() => { clearTimeout(timer); timer = setTimeout(() => refresh().then(values => { if (current && values) { setMemories(values[0]); setRecovery(values[1]); } }).catch(err => { if (current) setError(err.message); }), 600); });
    return () => { current = false; clearTimeout(timer); off?.(); };
  }, [refresh, desktop]);
  const mutate = async action => {
    setBusy(true); setError("");
    try { const result = await action(); const values = await refresh(); if (values) { setMemories(values[0]); setRecovery(values[1]); } setForm(null); setDeleting(null); setContext(await desktop.personal.context({ projectId: projectId || null })); await onChanged(); return result; }
    catch (err) { setError(err.message || String(err)); return null; }
    finally { setBusy(false); }
  };
  return <section className="personal-panel" aria-label="项目与记忆"><div className="personal-shell">
    <header className="personal-heading"><div><button className="personal-back" onClick={onBack}><ArrowLeft size={14} />返回工作</button><h1>项目与记忆</h1><p>把长期目标留下，下一次不用从头说明。</p></div><button onClick={() => setForm({ type: "project" })} disabled={busy}><Plus size={15} />新建项目</button></header>
    {!desktop?.personal ? <p>项目与记忆需要桌面运行环境；浏览器预览不会创建本地记录。</p> : <>
    <ProjectSelect projects={projects} value={projectId} onChange={id => { if (!busy) onProjectChange(id); }} label="项目 · 不选项目时管理个人偏好" />
    {error ? <div className="personal-error" role="alert">{error}</div> : null}
    {form?.type === "project" ? <ProjectForm key={form.project?.id || "new"} project={form.project} busy={busy} onClose={() => setForm(null)} onSave={input => mutate(() => desktop.personal.saveProject(input)).then(value => { if (value) onProjectChange(value.id); })} /> : null}
    {project && !form ? <section className="personal-goal"><div><h2>{project.name}{project.status === "archived" ? " · 已归档" : ""}</h2><p>{project.goal}</p></div><div className="personal-project-actions"><button onClick={() => setForm({ type: "project", project })}>编辑目标</button><button disabled={busy} onClick={() => mutate(() => desktop.personal.saveProject({ ...project, status: project.status === "active" ? "archived" : "active" }))}>{project.status === "active" ? "归档项目" : "恢复项目"}</button></div></section> : null}
    {recovery && !form ? <section className="personal-recovery"><header><h2>上次做到哪了</h2><small>本地真实记录 · 不消耗模型 Token</small></header><p>{recovery.next}</p>{recovery.works.length ? <ul>{recovery.works.map(work => <li key={work.id}><button onClick={() => onOpenMission({ missionId: work.id })}><span><strong>{work.title}</strong><small>{labels[work.status] || work.status} · {work.accepted}/{work.tasks} 已验收</small>{work.error ? <small className="personal-warning">{work.error}</small> : null}</span><ArrowRight size={15} /></button></li>)}</ul> : <p className="personal-muted">项目还没有执行记录。先创建一项工作。</p>}{recovery.inbox.length ? <p className="personal-muted">另有 {recovery.inbox.length} 项未开始的工作，在工作列表查看。</p> : null}{project.status === "active" ? <button className="personal-primary" onClick={onNewWork}><Plus size={14} />为这个项目新建工作</button> : null}</section> : null}
    {!form || form.type === "memory" ? <section className="personal-memory"><header><div><h2>{project ? "项目记忆与个人偏好" : "个人偏好"}</h2><p>只引用已确认、未过期且允许分享的内容。项目同名记忆优先。</p></div>{!form ? <button disabled={busy || project?.status === "archived"} onClick={() => setForm({ type: "memory" })}><Plus size={14} />记住一件事</button> : null}</header>
      {form?.type === "memory" ? <MemoryForm key={form.memory?.id || "new"} memory={form.memory} project={project} busy={busy} onClose={() => setForm(null)} onSave={input => mutate(() => desktop.personal.saveMemory(input))} /> : <ul>{memories.map(memory => {
        const expired = memory.expiresAt && Date.parse(memory.expiresAt) <= Date.now();
        return <li key={memory.id}><div><strong>{memory.key}</strong><small>{memory.projectId ? "本项目" : "个人"} · {expired ? "已过期" : memory.status === "candidate" ? "待确认" : memory.shareWithAgent ? "可用于请求" : "仅本机"}</small><p>{memory.content}</p><small>来源：{memory.sourceLabel}{memory.expiresAt ? ` · 有效至 ${new Date(memory.expiresAt).toLocaleString()}` : ""}</small>{memory.sourceRef ? <small className="personal-source">{memory.sourceRef}</small> : null}</div><div className="personal-memory-actions">{deleting === memory.id ? <><span>删除后不再引用，已有记录保留。</span><button disabled={busy} onClick={() => mutate(() => desktop.personal.deleteMemory({ id: memory.id, revision: memory.revision }))}>确认删除</button><button onClick={() => setDeleting(null)}>取消</button></> : <><button disabled={busy} onClick={() => setForm({ type: "memory", memory })}>编辑</button><button disabled={busy} onClick={() => setDeleting(memory.id)}>删除</button></>}</div></li>;
      })}{!memories.length ? <li className="personal-muted">还没有记忆。先留下一条真正有用的偏好。</li> : null}</ul>}
    </section> : null}
    {!form ? <details className="personal-preview" onToggle={event => { if (event.currentTarget.open) desktop.personal.context({ projectId: projectId || null }).then(setContext).catch(err => setError(err.message)); }}><summary>检查下一次请求的背景</summary>{context ? <><p>{context.stats.chars.toLocaleString()} 字符 / {context.stats.maxChars.toLocaleString()} 字符上限 · {context.stats.included} 条背景 · {context.stats.withheld} 条未纳入</p>{context.project ? <p>项目目标：{context.project.goal}</p> : null}{context.items.map(item => <article key={item.ref}><strong>{item.data.key || item.data.title}</strong><p>{item.data.content || item.data.summary}</p><small>{item.ref}</small></article>)}<small>这是基础背景预览；实际执行还会按任务词筛选并排除当前 Mission。原始聊天和未验收结果不会自动带入。</small></> : <p>读取中…</p>}</details> : null}
    </>}
  </div></section>;
}
