// Bounded live text edit only. Synthetic note, no real ledger, Mission or tools.
const { PromptPolishService } = require("../desktop/prompt-polish.cjs");
const original = { title: "把我已有的会议笔记整理清楚，不联网，也不要替我编造信息", outcome: "", body: "我之后会补充笔记。现在只帮我整理这段请求的表述，不要执行任务。" };
const service = new PromptPolishService({ providerRegistry: { selectRuntime: () => ({ runtimeMode: "external", provider: "codex" }) }, store: {} });
service.polish({ requestId: "live-text-polish", draft: original }).then(result => {
  if (result.draft.outcome !== "") throw new Error("Invented criterion");
  console.log(JSON.stringify({ source: "Live Codex text-only rewrite of synthetic note; no execution", model: result.model, usage: result.usage, draft: result.draft, questions: result.questions }, null, 2));
}).catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => service.stop());
