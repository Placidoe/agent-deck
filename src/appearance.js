// Local presentation preferences only. Never part of a Mission/runtime contract.
export const THEME_KEY = "agent-deck:accent-theme";
export const APPEARANCE_KEY = "agent-deck:appearance";
export const APPEARANCES = Object.freeze([
  { id: "light", name: "浅色", description: "明亮、清晰的纸面感" },
  { id: "dark", name: "深色", description: "柔和、安静的深色空间" },
  { id: "system", name: "跟随系统", description: "随设备外观自动切换" },
]);
export const THEMES = Object.freeze([
  { id: "blue", name: "雾蓝", accent: "#9bbcff", light: "#365ba3", solid: "#365ba3", hover: "#406bb9" },
  { id: "iris", name: "鸢尾", accent: "#c1b1ff", light: "#65529f", solid: "#65529f", hover: "#7763b5" },
  { id: "teal", name: "青玉", accent: "#8bd2c5", light: "#276b60", solid: "#276b60", hover: "#307d70" },
  { id: "rose", name: "玫瑰", accent: "#e8a9bd", light: "#934661", solid: "#934661", hover: "#a85270" },
  { id: "sand", name: "暖沙", accent: "#dfc498", light: "#795d36", solid: "#795d36", hover: "#8e6d40" },
]);
export function resolveTheme(id) { return THEMES.find(theme => theme.id === id) || THEMES[0]; }
export function readTheme(storage) {
  try { return resolveTheme(storage?.getItem(THEME_KEY)).id; } catch { return THEMES[0].id; }
}
export function applyTheme(id, root) {
  const theme = resolveTheme(id);
  root.dataset.accentTheme = theme.id;
  root.style.setProperty("--accent", root.dataset.appearance === "light" ? theme.light : theme.accent);
  root.style.setProperty("--accent-solid", theme.solid);
  root.style.setProperty("--accent-hover", theme.hover);
  return theme.id;
}
export function saveTheme(id, storage) {
  if (!storage) return false;
  try { storage?.setItem(THEME_KEY, resolveTheme(id).id); return true; } catch { return false; }
}
export function resolveAppearance(id) { return APPEARANCES.some(item => item.id === id) ? id : "system"; }
export function readAppearance(storage) {
  try { return resolveAppearance(storage?.getItem(APPEARANCE_KEY)); } catch { return "system"; }
}
export function saveAppearance(id, storage) {
  if (!storage) return false;
  try { storage.setItem(APPEARANCE_KEY, resolveAppearance(id)); return true; } catch { return false; }
}
export function applyAppearance(id, root, systemDark = false) {
  const preference = resolveAppearance(id);
  root.dataset.appearancePreference = preference;
  root.dataset.appearance = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  applyTheme(root.dataset.accentTheme, root);
  return preference;
}
// One lifetime subscription, independent of whether Settings is mounted.
export function initializeAppearance({ root, storage, media, events }) {
  const refresh = () => {
    applyAppearance(readAppearance(storage), root, media?.matches);
    applyTheme(readTheme(storage), root);
  };
  const onSystem = () => {
    if (root.dataset.appearancePreference === "system") applyAppearance("system", root, media?.matches);
    events?.dispatchEvent(new Event("appearance-change"));
  };
  const onStorage = event => {
    if (event.key === null || [THEME_KEY, APPEARANCE_KEY].includes(event.key)) {
      refresh(); events?.dispatchEvent(new Event("appearance-change"));
    }
  };
  refresh();
  media?.addEventListener("change", onSystem);
  events?.addEventListener("storage", onStorage);
  return () => { media?.removeEventListener("change", onSystem); events?.removeEventListener("storage", onStorage); };
}
