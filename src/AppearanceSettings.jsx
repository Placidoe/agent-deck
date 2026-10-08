import { useEffect, useState } from "react";
import { Check, Palette } from "@phosphor-icons/react";
import { AgentAvatar } from "./AgentAvatar.jsx";
import { BrandMark } from "./BrandMark.jsx";
import { THEMES, THEME_KEY, applyTheme, readTheme, saveTheme } from "./appearance.js";
function storage() { try { return window.localStorage; } catch { return null; } }

export function AppearanceSettings() {
  const [theme, setTheme] = useState(() => document.documentElement.dataset.accentTheme || "blue");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const sync = event => {
      if (event.key === THEME_KEY || event.key === null) setTheme(applyTheme(readTheme(storage()), document.documentElement));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  function choose(id) {
    setTheme(applyTheme(id, document.documentElement));
    setNotice(saveTheme(id, storage()) ? "" : "已应用；当前环境无法保存外观设置，下次打开会恢复默认。" );
  }
  return <section className="appearance-settings" aria-labelledby="appearance-title">
    <header><span className="appearance-kicker"><Palette size={15} />外观</span><h1 id="appearance-title">让工作空间更像你</h1><p>选一种喜欢的颜色。即时生效，保存在这台设备上，不影响任务和模型。</p></header>
    <div className="appearance-layout">
      <fieldset className="theme-picker"><legend>主题色</legend><div className="theme-options">
        {THEMES.map(item => <label key={item.id} className={`theme-option ${theme === item.id ? "selected" : ""}`} style={{ "--swatch": item.accent }}>
          <input type="radio" name="accent-theme" value={item.id} checked={theme === item.id} onChange={() => choose(item.id)} />
          <span className="theme-swatch">{theme === item.id && <Check size={15} weight="bold" />}</span><span>{item.name}</span>
        </label>)}
      </div><p>仅改变强调色；成功、阻塞和失败仍保持独立的状态颜色。</p>{notice && <p role="status">{notice}</p>}</fieldset>
      <div className="appearance-preview" aria-label="外观预览，不会启动任务">
        <div className="preview-brand"><BrandMark /><span>Agent Deck<small>你的个人工作空间</small></span></div>
        <div className="preview-agent"><AgentAvatar name="Main Agent" main size="lg" /><span><strong>Main Agent</strong><small>清晰的身份，一致的视觉</small></span><span className="preview-action">开始工作</span></div>
        <div className="preview-roles">{[["研究员", "researcher"], ["工程师", "builder"], ["审核员", "reviewer"], ["你", "user"]].map(([name, role]) => <span key={role}><AgentAvatar name={name} role={role} user={role === "user"} size="sm" />{name}</span>)}</div>
        <small className="preview-caption">外观预览 · 不会执行任何操作</small>
      </div>
    </div>
  </section>;
}
