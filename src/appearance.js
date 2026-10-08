// Local presentation preferences only. Never part of a Mission/runtime contract.
export const THEME_KEY = "agent-deck:accent-theme";
export const THEMES = Object.freeze([
  { id: "blue", name: "雾蓝", accent: "#9bbcff", solid: "#365ba3", hover: "#406bb9" },
  { id: "iris", name: "鸢尾", accent: "#c1b1ff", solid: "#65529f", hover: "#7763b5" },
  { id: "teal", name: "青玉", accent: "#8bd2c5", solid: "#276b60", hover: "#307d70" },
  { id: "rose", name: "玫瑰", accent: "#e8a9bd", solid: "#934661", hover: "#a85270" },
  { id: "sand", name: "暖沙", accent: "#dfc498", solid: "#795d36", hover: "#8e6d40" },
]);
export function resolveTheme(id) { return THEMES.find(theme => theme.id === id) || THEMES[0]; }
export function readTheme(storage) {
  try { return resolveTheme(storage?.getItem(THEME_KEY)).id; } catch { return THEMES[0].id; }
}
export function applyTheme(id, root) {
  const theme = resolveTheme(id);
  root.dataset.accentTheme = theme.id;
  root.style.setProperty("--accent", theme.accent);
  root.style.setProperty("--accent-solid", theme.solid);
  root.style.setProperty("--accent-hover", theme.hover);
  return theme.id;
}
export function saveTheme(id, storage) {
  if (!storage) return false;
  try { storage?.setItem(THEME_KEY, resolveTheme(id).id); return true; } catch { return false; }
}
