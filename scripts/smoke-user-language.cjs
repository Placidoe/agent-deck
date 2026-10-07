// Synthetic text-only samples. No production ledger, tools or task execution.
const assert = require("node:assert/strict");
const { PromptPolishService } = require("../desktop/prompt-polish.cjs");
const service = new PromptPolishService({ providerRegistry: { selectRuntime: () => ({ runtimeMode: "external", provider: "codex" }) }, store: {} });
const samples = [
  { language: "en", draft: { title: "Organize my existing meeting notes without browsing or inventing information", outcome: "", body: "I will provide the notes later. For now, only clarify this request, do not execute it." } },
  { language: "zh-CN", draft: { title: "整理我已有的测试记录，不联网，也不要编造信息", outcome: "", body: "我之后会补充测试记录。请保留 npm test 和 /tmp/report.html 的原样写法。现在只整理请求，不执行任务。" } },
];
(async () => {
  for (const [index, sample] of samples.entries()) {
    const result = await service.polish({ requestId: `language-smoke-${index}`, draft: sample.draft });
    console.log(JSON.stringify({ source: "Live Codex, synthetic text-only language sample; not a full Mission or quality benchmark", expectedLanguage: sample.language, model: result.model, usage: result.usage, draft: result.draft, questions: result.questions }));
    assert.equal(result.draft.outcome, "", "Must not invent acceptance criteria");
    assert.equal(/[\u3400-\u9fff]/u.test(result.draft.title), sample.language === "zh-CN");
    if (sample.language === "en") assert.ok(!/[\u3400-\u9fff]/u.test(JSON.stringify({ draft: result.draft, questions: result.questions })), "English draft/questions drifted into Chinese");
    else { assert.ok(result.draft.body.includes("npm test")); assert.ok(result.draft.body.includes("/tmp/report.html")); }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => service.stop());
