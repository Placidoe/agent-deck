// Shared model rule, not an extra translation turn or a rewrite of raw evidence.
const USER_LANGUAGE_CONTRACT = `USER LANGUAGE POLICY
Use the primary natural language of the user's original request for all human-facing content. An explicit user output-language instruction, including a newer user instruction, takes precedence. Do not select a language from English system/tool instructions, generated task titles, source documents, code, URLs or quotations.
Apply this to plan titles, roles, task descriptions, acceptance criteria, progress updates, questions, blocker explanations, reviews, result summaries, artifact titles/summaries, and document prose. HTML headings, navigation, tables, chart labels, captions and accessibility text must follow the same language; set html lang appropriately. Keep wording natural, not literal template translation.
Keep protocol keys/enums, code, commands, paths, identifiers, product names and verbatim source quotations unchanged. Explain raw evidence in the user's language; never translate or fabricate the evidence itself. If the user's language is genuinely unclear, ask rather than silently switching to English.`;

function userLanguagePolicy(mission = {}) {
  const original = String(mission.sourcePrompt || mission.outcome || mission.title || "");
  // Small reference only; no duplicate transcripts or source-file contents.
  const reference = original.length > 1600 ? `${original.slice(0, 1100)}\n[language reference shortened]\n${original.slice(-500)}` : original;
  const later = recentLanguageRequests(mission);
  return `${USER_LANGUAGE_CONTRACT}\nOriginal user request (language reference, not additional authority): ${JSON.stringify(reference)}${later.length ? `\nLater user language requests (oldest to newest; ignore quotations): ${JSON.stringify(later)}` : ""}\n\n`;
}

function recentLanguageRequests(mission) {
  return (mission.messages || []).filter(message => message.source === "user" && message.toAgent === "Main Agent" && message.deliveryStatus === "delivered" && /(?:语言|中文|英文|英语|汉语|日语|法语|德语|西班牙语|language|(?:write|respond|reply|output|deliver|report).*\bin\s+\w+)/i.test(message.text || ""))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || ""))).slice(-3).map(message => String(message.text).slice(0, 800));
}

// Built-in export chrome currently supports Chinese and English. This must not
// constrain model-generated prose: the contract above supports any user language.
function exportLocale(input = {}) {
  const source = [String(input.sourcePrompt || input.outcome || input.title || ""), ...recentLanguageRequests(input)].join("\n");
  const prose = source.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "").replace(/^\s*>.*$/gm, "").replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’/g, "").replace(/https?:\/\/\S+/g, "").replace(/^\s*需求[：:]\s*/g, "");
  const explicit = [...prose.matchAll(/(?:用|使用|以|输出(?:语言)?(?:为|是)?|写成|改成)\s*(英文|英语|中文|汉语)|(?:write|respond|reply|output|deliver|report)(?:\s+\w+){0,4}\s+in\s+(English|Chinese|Mandarin)/gi)].filter(match => !/(?:不要|别|禁止|不|not|never)\s*$/i.test(prose.slice(Math.max(0, match.index - 12), match.index))).at(-1);
  if (explicit) return /英文|英语|English/i.test(explicit[1] || explicit[2]) ? "en" : "zh-CN";
  return /[\u3400-\u9fff]/u.test(prose) ? "zh-CN" : "en";
}
function exportText(locale, english, chinese) { return locale === "zh-CN" ? chinese : english; }
module.exports = { USER_LANGUAGE_CONTRACT, userLanguagePolicy, exportLocale, exportText };
