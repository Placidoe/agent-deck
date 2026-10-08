const prefix = "agent-deck:note-draft:v1:";
export function readNoteDraft(requirement, storage = sessionStorage) {
  try { const value = JSON.parse(storage.getItem(`${prefix}${requirement.id}:${requirement.updatedAt}`));
    if (value && typeof value.title === "string" && typeof value.outcome === "string" && typeof value.body === "string") return { title: value.title.slice(0, 300), outcome: value.outcome.slice(0, 2000), body: value.body.slice(0, 12000) };
  } catch { /* Draft storage is optional, never an execution source. */ }
  return { title: requirement.title || "", outcome: requirement.outcome || "", body: requirement.body || "" };
}
export function saveNoteDraft(requirement, draft, storage = sessionStorage) {
  try {
    const key = `${prefix}${requirement.id}:${requirement.updatedAt}`;
    if (["title", "outcome", "body"].every(field => draft[field] === (requirement[field] || ""))) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify({ title: draft.title.slice(0, 300), outcome: draft.outcome.slice(0, 2000), body: draft.body.slice(0, 12000) }));
    const keys = Object.keys(storage).filter(key => key.startsWith(prefix));
    for (const old of keys.slice(0, Math.max(0, keys.length - 32))) if (old !== key) storage.removeItem(old);
  } catch { /* Do not fail or run a model when browser storage is unavailable. */ }
}
