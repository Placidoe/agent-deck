// Two tiny real-model planning probes. No user profile/mission writes or Git init.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { CodexAppServer } = require("../desktop/codex-app-server.cjs");
const { WorktreeManager } = require("../desktop/worktree-manager.cjs");
const { workspaceSchema, workspacePrompt, normalizeWorkspace } = require("../desktop/workspace-policy.cjs");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-deck-workspace-smoke-"));
const client = new CodexAppServer();
const manager = new WorktreeManager(path.join(root, "managed"));

async function probe(name, goal, expected) {
  const cwd = path.join(root, name); fs.mkdirSync(cwd);
  if (name === "output") fs.writeFileSync(path.join(cwd, "facts.txt"), "Project launch: October. Target: personal agent.\n");
  const before = fs.readdirSync(cwd).map(file => [file, fs.readFileSync(path.join(cwd, file), "utf8")]);
  const created = await client.createThread({ cwd, ephemeral: true, allowMutations: false });
  let response = ""; let timer;
  const finished = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Workspace planning probe exceeded 90 seconds")), 90000);
    const listener = event => {
      if (event.params?.threadId !== created.thread.id) return;
      if (event.method === "item/completed" && event.params.item?.type === "agentMessage") response = event.params.item.text || response;
      if (event.method === "turn/completed") {
        client.off("event", listener);
        if (event.params.turn?.status === "completed") resolve(event.params.turn);
        else reject(new Error(event.params.turn?.error?.message || "Planning did not complete"));
      }
    };
    client.on("event", listener);
  });
  finished.catch(() => {});
  try {
    await client.sendTurn({ threadId: created.thread.id, cwd, effort: "low", allowMutations: false, outputSchema: workspaceSchema,
      prompt: workspacePrompt({ cwd }, manager.inspect(cwd)) + `USER GOAL\n${goal}\nReturn only a proposed workspace strategy, reason and trackedFiles. Do not execute or initialize anything.` });
    await finished;
    const result = normalizeWorkspace(JSON.parse(response));
    if (result.strategy !== expected) throw new Error(`${name}: expected ${expected}, got ${result.strategy}`);
    if (JSON.stringify(before) !== JSON.stringify(fs.readdirSync(cwd).map(file => [file, fs.readFileSync(path.join(cwd, file), "utf8")]))) throw new Error("Planning modified source files");
    console.log(JSON.stringify({ ok: true, case: name, model: created.model, decision: result, sourceUnchanged: true, scope: "real planning only; not worker quality/performance evaluation" }));
  } finally { clearTimeout(timer); }
}

(async () => {
  try {
    await probe("output", "只读取 facts.txt，后续生成一份简短 HTML 摘要。原目录只用作参考，不修改它，不需要命令执行。", "managed");
    await probe("new-project", "这是新项目的专用空目录。希望后续在该项目里开发 Node.js 小工具，并实际运行 Node 命令和回归测试。不要修改父目录；现在只规划环境，必须等我批准后再初始化或执行。", "initialize_git");
  } finally { client.stop(); fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
