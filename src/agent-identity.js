export function avatarTone({ role = "", main = false, user = false } = {}) {
  const normalized = String(role).toLowerCase();
  if (user) return "you";
  if (main || /planner|main agent|主.?agent|主智能体|规划|协调/.test(normalized)) return "main";
  if (/review|quality|security|审查|审核|审计|质量|安全|验收/.test(normalized)) return "reviewer";
  if (/architect|architecture|架构/.test(normalized)) return "architect";
  if (/research|analyst|product|研究|调研|分析|产品/.test(normalized)) return "researcher";
  return "builder";
}
