const MAX_CONVERSATION_TURNS = 24;
const MAX_CONVERSATION_ENTRIES = 48;
const MAX_STRUCTURED_RESPONSE_CHARS = 512_000;

export function codexMessageText(item) {
  if (typeof item?.text === "string") return item.text;
  if (typeof item?.content === "string") return item.content;
  if (Array.isArray(item?.content)) return item.content.map((part) => part?.text || part?.input_text || part?.output_text || "").join("");
  return "";
}

export function agentConversationContent(item) {
  const raw = codexMessageText(item);
  // Plain text is preferable to a renderer-blocking JSON parse for huge replies.
  if (raw.length > MAX_STRUCTURED_RESPONSE_CHARS) return { text: raw, registeredTasks: [] };
  try {
    const parsed = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (typeof parsed?.message === "string" && Array.isArray(parsed.tasksToCreate)) {
      return { text: parsed.message, registeredTasks: parsed.tasksToCreate.map((task) => task.key).filter(Boolean) };
    }
    if (typeof parsed?.summary === "string" && Array.isArray(parsed.acceptance) && Array.isArray(parsed.blockers)) {
      return {
        text: parsed.summary,
        structuredResult: {
          acceptance: parsed.acceptance.filter((entry) => entry?.criterion),
          blockers: parsed.blockers.filter(Boolean),
          changedFiles: Array.isArray(parsed.changedFiles) ? parsed.changedFiles.filter(Boolean) : [],
        },
      };
    }
    if (typeof parsed?.outcome === "string" && Array.isArray(parsed.tasks)) {
      return {
        text: parsed.outcome,
        structuredPlan: {
          title: parsed.title || "Mission plan",
          tasks: parsed.tasks.filter((task) => task?.key || task?.title).map((task) => ({ key: task.key, title: task.title, agentRole: task.agentRole })),
        },
      };
    }
  } catch { /* A normal conversational reply is intentionally rendered as-is. */ }
  return { text: raw, registeredTasks: [] };
}

export function conversationFromThread(thread) {
  const entries = [];
  const recentTurns = (thread?.turns || []).slice(-MAX_CONVERSATION_TURNS);
  for (const turn of recentTurns) {
    for (const item of turn.items || []) {
      if (["userMessage", "user_message"].includes(item.type)) {
        const text = codexMessageText(item);
        if (text) entries.push({ id: item.id || `${turn.id}-user-${entries.length}`, role: "user", text, turnId: turn.id });
      } else if (item.type === "agentMessage") {
        const content = agentConversationContent(item);
        if (content.text) entries.push({ id: item.id || `${turn.id}-agent-${entries.length}`, role: "agent", ...content, turnId: turn.id });
      }
    }
  }
  return entries.slice(-MAX_CONVERSATION_ENTRIES);
}
