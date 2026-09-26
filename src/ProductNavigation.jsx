import { ArrowLeft, BellRinging, Briefcase, FileCode, FolderOpen, SlidersHorizontal } from "@phosphor-icons/react";
import { productSection } from "./work-navigation.js";

export function ProductNavigation({ view, onNavigate, badge, health, connected }) {
  const section = productSection(view);
  return <aside className="product-navigation">
    <div className="product-wordmark"><span className="product-symbol">a</span><strong>Agent Deck</strong></div>
    <nav aria-label="主导航">{[["work", "工作", Briefcase, "requirements"], ["attention", "待我处理", BellRinging, "attention"], ["results", "成果", FileCode, "results"]].map(([id, title, Icon, target]) =>
      <button type="button" key={id} aria-current={section === id ? "page" : undefined} onClick={() => onNavigate(target)}><Icon size={18} /><span>{title}</span>{id === "attention" && badge > 0 ? <b>{badge > 99 ? "99+" : badge}</b> : null}</button>
    )}</nav>
    <footer><button type="button" aria-current={section === "settings" ? "page" : undefined} onClick={() => onNavigate("settings")}><SlidersHorizontal size={18} /><span>设置</span></button><div className="product-connection"><i className={connected ? "connected" : ""} /><span>{health}</span></div></footer>
  </aside>;
}

export function WorkNavigation({ view, onNavigate, workspace, onChooseWorkspace, onOpenExecution }) {
  const section = productSection(view);
  const detail = ["mission", "artifacts"].includes(view);
  return <header className="work-navigation">
    {detail ? <div className="work-breadcrumb"><button onClick={() => onNavigate(view === "artifacts" ? "results" : "requirements")}><ArrowLeft size={15} />{view === "artifacts" ? "返回成果" : "返回工作"}</button><span>/</span><strong>{view === "artifacts" ? "成果详情" : "执行详情"}</strong></div>
      : section === "work" ? <nav aria-label="工作视图"><button aria-current={view === "requirements" ? "page" : undefined} onClick={() => onNavigate("requirements")}>工作列表</button><button aria-current={["sessions", "timeline", "usage"].includes(view) ? "page" : undefined} onClick={() => onNavigate("sessions")}>多会话</button></nav>
      : <strong className="section-caption">{section === "attention" ? "需要你的决定" : section === "results" ? "交付与复用" : "应用设置"}</strong>}
    {view === "artifacts" ? <button onClick={onOpenExecution}>查看执行过程 <ArrowLeft size={13} style={{ transform: "rotate(180deg)" }} /></button> : <button className="product-workspace-picker" onClick={onChooseWorkspace} title={workspace?.path || "选择本地工作区"}><FolderOpen size={15} /><span>{workspace?.name || "选择工作区"}</span></button>}
  </header>;
}
