import {
  Code, MagnifyingGlass, Robot, ShieldCheck, TreeStructure, User,
} from "@phosphor-icons/react";

function avatarProfile({ role = "", main = false, user = false }) {
  const normalized = role.toLowerCase();
  if (user) return { Icon: User, tone: "you" };
  if (main || normalized.includes("planner") || normalized.includes("main agent")) return { Icon: Robot, tone: "main" };
  if (normalized.includes("review") || normalized.includes("quality") || normalized.includes("security")) return { Icon: ShieldCheck, tone: "reviewer" };
  if (normalized.includes("architect") || normalized.includes("architecture")) return { Icon: TreeStructure, tone: "architect" };
  if (normalized.includes("research") || normalized.includes("analyst") || normalized.includes("product")) return { Icon: MagnifyingGlass, tone: "researcher" };
  return { Icon: Code, tone: "builder" };
}

export function AgentAvatar({ name, role, main = false, user = false, size = "md", status, className = "" }) {
  const { Icon, tone } = avatarProfile({ role, main, user });
  return <span className={`agent-identity-avatar ${tone} ${size} ${className}`.trim()} title={name || role || "Agent"} aria-label={`${name || role || "Agent"} avatar`}>
    <Icon weight="duotone" />
    {status ? <i className={`avatar-presence ${status}`} /> : null}
  </span>;
}
