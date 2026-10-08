import {
  Code, MagnifyingGlass, ShieldCheck, TreeStructure, User,
} from "@phosphor-icons/react";
import { BrandMark } from "./BrandMark.jsx";
import { avatarTone } from "./agent-identity.js";
const glyphs = { you: User, reviewer: ShieldCheck, architect: TreeStructure, researcher: MagnifyingGlass, builder: Code };

export function AgentAvatar({ name, role, main = false, user = false, size = "md", status, className = "" }) {
  const tone = avatarTone({ role, main, user });
  const Icon = glyphs[tone];
  return <span className={`agent-identity-avatar ${tone} ${size} ${className}`.trim()} title={name || role || "Agent"} aria-label={`${name || role || "Agent"} avatar`}>
    {tone === "main" ? <BrandMark /> : <Icon weight="duotone" />}
    {status ? <i className={`avatar-presence ${status}`} /> : null}
  </span>;
}
