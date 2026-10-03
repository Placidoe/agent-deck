import { useEffect, useState } from "react";
import "./runtime-mode.css";

export function RuntimeModeSettings({ desktop, providers = [], onChanged }) {
  const [settings, setSettings] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!desktop?.runtime) return;
    desktop.runtime.get().then(setSettings).catch((error) => setError(error.message));
    return desktop.runtime.onChange(setSettings);
  }, [desktop]);
  async function change(patch) {
    setBusy(true); setError("");
    try { setSettings(await desktop.runtime.set(patch)); await onChanged?.(); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  const native = settings?.mode === "agent_deck";
  const selectedId = native ? settings?.modelProvider : settings?.externalProvider;
  const selected = providers.find((provider) => provider.id === selectedId);
  return <section className="runtime-mode-settings" aria-labelledby="runtime-mode-title">
    <header><span className="eyebrow">执行引擎</span><h2 id="runtime-mode-title">谁来掌握执行过程</h2><p>一个总开关，决定新工作的执行方式。已有任务保持原来的引擎和模型。</p></header>
    <div className="runtime-mode-options" role="group" aria-label="执行模式">
      {[["external", "外部 Coding Agent", "热插拔 + 轻量编排", "Coding Agent 负责推理与工具执行；Agent Deck 负责任务、审批与成果管理。"], ["agent_deck", "Agent Deck Harness", "自有引擎 · Beta", "我们的 SDK 负责受控执行、独立验证和持久化；模型 API 只提供推理，不需要安装 Codex。"]].map(([mode, title, label, detail]) =>
        <button type="button" key={mode} disabled={!settings || busy} aria-pressed={settings?.mode === mode} onClick={() => change({ mode })}><span>{label}</span><strong>{title}</strong><p>{detail}</p></button>
      )}
    </div>
    {settings && <div className="runtime-mode-backend"><label htmlFor="runtime-backend">{native ? "模型 API" : "Coding Agent"}</label><select id="runtime-backend" disabled={busy} value={selectedId} onChange={(event) => change({ [native ? "modelProvider" : "externalProvider"]: event.target.value })}>
      {providers.filter((provider) => native ? provider.kind === "api" : ["codex", "claude_code", "trae"].includes(provider.id)).map((provider) => <option key={provider.id} value={provider.id} disabled={provider.stage !== "mission_ready"}>{provider.label}{provider.stage !== "mission_ready" ? " · 适配中，尚不可执行" : ""}</option>)}
    </select><p role="status">{busy ? "正在保存…" : selected?.missionEnabled ? "已就绪，新工作会使用这个引擎。" : native ? "请在下方配置并测试 API 连接，再从「工作」创建任务。不会回退到 Codex。" : "请连接所选 Coding Agent；未经验证的适配器不会启动任务。"}</p></div>}
    {!desktop?.runtime && <p>执行模式设置需要桌面 App，浏览器预览不会启动 Agent。</p>}
    {error && <p className="runtime-mode-error" role="alert">{error}</p>}
  </section>;
}
