const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { normalizeWorkspace } = require("./workspace-policy.cjs");
const { decodeGitPath } = require("./path-utils.cjs");

function runGit(args, cwd) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git ${args[0]} failed`);
  return result.stdout.trim();
}

function runGitRaw(args, cwd) {
  const result = spawnSync("/usr/bin/git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.stdout?.trim() || `git ${args[0]} failed`);
  return result.stdout;
}

function isAncestor(ancestor, cwd) {
  const result = spawnSync("/usr/bin/git", ["merge-base", "--is-ancestor", ancestor, "HEAD"], { cwd, encoding: "utf8" });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(result.stderr?.trim() || result.stdout?.trim() || `Unable to inspect dependency ${ancestor}`);
}

function mergeDependencies(worktreePath, baseRefs) {
  const unresolved = runGit(["diff", "--name-only", "--diff-filter=U"], worktreePath).split("\n").filter(Boolean);
  const pendingRefs = baseRefs.filter((dependencyRef) => !isAncestor(dependencyRef, worktreePath));
  if (unresolved.length) return { conflict: `Resolve merge conflicts before continuing: ${unresolved.join(", ")}`, pendingRefs };
  for (let index = 0; index < pendingRefs.length; index += 1) {
    const dependencyRef = pendingRefs[index];
    try { runGit(["merge", "--no-edit", dependencyRef], worktreePath); }
    catch (error) { return { conflict: `Dependency merge conflict for ${dependencyRef}: ${error.message}`, pendingRefs: pendingRefs.slice(index) }; }
  }
  return { conflict: null, pendingRefs: [] };
}

function slug(value) {
  return String(value || "task").toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || "task";
}

class WorktreeManager {
  constructor(rootDirectory) {
    this.rootDirectory = rootDirectory;
    fs.mkdirSync(rootDirectory, { recursive: true });
  }

  inspect(cwd) {
    let repositoryRoot;
    try {
      if (!fs.statSync(cwd).isDirectory()) throw new Error("Not a directory");
    } catch (error) {
      return { available: false, code: "workspace_missing", error: `工作区不存在或不可访问：${cwd}` };
    }
    try {
      repositoryRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
    } catch (error) {
      return { available: false, code: "not_git_repository", error: `当前工作区不是可用的 Git 仓库：${cwd}。请选择包含 .git 的具体项目目录；不要选择包含多个项目的父目录。`, detail: error.message };
    }
    try {
      const head = runGit(["rev-parse", "--verify", "HEAD"], repositoryRoot);
      return { available: true, repositoryRoot, head };
    } catch (error) {
      return { available: false, code: "missing_git_head", repositoryRoot, error: `Git 仓库还没有可用的 HEAD 提交：${repositoryRoot}。请先确认需要纳入版本管理的文件并完成首次提交，再重新检查。`, detail: error.message };
    }
  }

  assertReady(cwd) {
    const repository = this.inspect(cwd);
    if (!repository.available) throw new Error(`[${repository.code}] ${repository.error}`);
    return repository;
  }

  assertSourceDirectory(cwd) {
    if (!fs.statSync(cwd).isDirectory()) throw new Error("请选择可读取的资料目录");
    return fs.realpathSync(cwd);
  }

  previewInitialization(cwd, trackedFiles) {
    trackedFiles = normalizeWorkspace({ strategy: "initialize_git", reason: "Validate scope", trackedFiles }).trackedFiles;
    const root = this.assertSourceDirectory(cwd);
    const homeRelative = path.relative(root, os.homedir());
    if ((!homeRelative || (!homeRelative.startsWith(`..${path.sep}`) && homeRelative !== ".." && !path.isAbsolute(homeRelative))) || [path.parse(root).root, "/System", "/Library", "/Applications", "/usr", "/var", "/private", ...["Desktop", "Documents", "Downloads", "Library"].map(name => path.join(os.homedir(), name))].includes(root)) throw new Error("请选择具体项目目录，不能初始化系统目录或个人父目录");
    const repository = this.inspect(root);
    if (repository.available) throw new Error("工作区已经有 Git 提交，请让 Agent 复用现有仓库");
    if (repository.repositoryRoot && fs.realpathSync(repository.repositoryRoot) !== root) throw new Error("不能初始化父仓库内的子目录");
    if (!["not_git_repository", "missing_git_head"].includes(repository.code)) throw new Error(repository.error);
    const entries = fs.readdirSync(root, { withFileTypes: true });
    if (entries.length > 2000 || entries.some(entry => entry.isDirectory() && entry.name !== ".git" && fs.existsSync(path.join(root, entry.name, ".git")))) throw new Error("目录中包含多个项目或文件过多，请选择具体项目，不会自动初始化父目录");
    const files = []; let totalBytes = 0;
    for (const file of trackedFiles) {
      if (file.split("/").some(part => /^(\.git|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|node_modules|credentials?(?:\..*)?|secrets?(?:\..*)?)$/i.test(part)) || /(?:\.(?:pem|key|p12|pfx)|id_rsa|id_ed25519)$/i.test(file)) throw new Error(`不能自动纳入敏感文件：${file}`);
      let cursor = root;
      for (const part of file.split("/")) {
        cursor = path.join(cursor, part);
        if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error(`不能纳入符号链接：${file}`);
        if (cursor !== path.join(root, file) && fs.existsSync(path.join(cursor, ".git"))) throw new Error("不能纳入嵌套 Git 项目");
      }
      const stat = fs.statSync(cursor);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error(`只能纳入不超过 2 MiB 的普通项目文件：${file}`);
      totalBytes += stat.size;
      if (totalBytes > 32 * 1024 * 1024) throw new Error("初始文件总量超过 32 MiB，请缩小项目范围");
      const data = fs.readFileSync(cursor);
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|AKIA[0-9A-Z]{16}/.test(data.toString("utf8"))) throw new Error(`文件疑似包含密钥，不能自动提交：${file}`);
      files.push({ path: file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
    }
    if (repository.code === "missing_git_head" && runGit(["diff", "--cached", "--name-only"], root)) throw new Error("首次提交前已有暂存内容，请先自行检查；不会替你提交暂存区");
    const gitPath = path.join(root, ".git");
    if (fs.existsSync(gitPath) && (fs.lstatSync(gitPath).isSymbolicLink() || !fs.statSync(gitPath).isDirectory())) throw new Error("不能初始化链接或外部 Git 元数据");
    const fingerprint = createHash("sha256").update(JSON.stringify({ root, code: repository.code, files })).digest("hex");
    return { root, code: repository.code, files, totalBytes, fingerprint };
  }

  initializeApproved(preview) {
    const current = this.previewInitialization(preview.root, preview.files.map(file => file.path));
    if (current.fingerprint !== preview.fingerprint) throw new Error("工作区文件在确认期间发生了变化，请重新检查并批准");
    const safe = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Agent Deck", "-c", "user.email=agent-deck@localhost"];
    if (current.code === "not_git_repository") runGit([...safe, "-c", "init.templateDir=", "init", "-q"], current.root);
    // Literal paths only. Never import unrelated files with add -A or add .
    if (current.files.length) runGit([...safe, "--literal-pathspecs", "add", "--", ...current.files.map(file => file.path)], current.root);
    const staged = runGitRaw(["diff", "--cached", "--name-only", "-z"], current.root).split("\0").filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify(current.files.map(file => file.path).sort())) throw new Error("暂存区在准备期间发生变化，未提交；请检查 Git 状态后重试");
    runGit([...safe, "commit", "--allow-empty", "-m", "Initialize approved Agent Deck project scope"], current.root);
    return this.assertReady(current.root);
  }

  // Managed outputs bootstrap only app-owned storage, never the source folder.
  prepareResearch(missionId) {
    if (!/^[a-f0-9-]{36}$/i.test(missionId)) throw new Error("Invalid mission identity");
    const root = fs.realpathSync(this.rootDirectory);
    const directory = path.join(root, `research-${missionId}`);
    fs.mkdirSync(directory, { recursive: true });
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory) throw new Error("Managed workspace must not be a symlink");
    const marker = path.join(directory, ".agent-deck-research");
    if (!fs.existsSync(marker)) {
      if (fs.readdirSync(directory).length) throw new Error("Refusing to initialize non-empty unowned workspace");
      fs.writeFileSync(marker, missionId, { flag: "wx" });
    }
    if (fs.lstatSync(marker).isSymbolicLink() || fs.readFileSync(marker, "utf8") !== missionId) throw new Error("Invalid managed workspace ownership");
    const gitPath = path.join(directory, ".git");
    if (!fs.existsSync(gitPath)) runGit(["init", "-q"], directory);
    if (fs.lstatSync(gitPath).isSymbolicLink() || !fs.statSync(gitPath).isDirectory()) throw new Error("Invalid managed repository");
    runGit(["config", "user.name", "Agent Deck"], directory);
    runGit(["config", "user.email", "agent-deck@localhost"], directory);
    runGit(["config", "core.hooksPath", "/dev/null"], directory);
    runGit(["config", "commit.gpgsign", "false"], directory);
    if (!this.inspect(directory).available) {
      runGit(["add", "--", ".agent-deck-research"], directory);
      runGit(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "commit", "-m", "Initialize isolated research outputs"], directory);
    }
    this.assertReady(directory);
    return directory;
  }

  create({ cwd, missionId, taskKey, baseRefs = [] }) {
    const repository = this.assertReady(cwd);
    const missionSlug = slug(missionId.slice(0, 12));
    const taskSlug = slug(taskKey);
    const directory = path.join(this.rootDirectory, missionSlug, taskSlug);
    const branch = `agentdeck/${missionSlug}/${taskSlug}`;
    fs.mkdirSync(path.dirname(directory), { recursive: true });
    const baseRef = baseRefs[0] || repository.head;
    runGit(["worktree", "add", "-b", branch, directory, baseRef], repository.repositoryRoot);
    const mergeState = mergeDependencies(directory, baseRefs.slice(1));
    return { path: directory, branch, repositoryRoot: repository.repositoryRoot, baseCommit: baseRef, ...mergeState };
  }

  commit(worktreePath, message) {
    const before = this.evidence(worktreePath);
    if (!before.clean) {
      runGit(["add", "-A"], worktreePath);
      runGit(["-c", "user.name=Agent Deck", "-c", "user.email=agent-deck@localhost", "commit", "-m", message], worktreePath);
    }
    const commitHash = runGit(["rev-parse", "HEAD"], worktreePath);
    return { commitHash, ...this.evidence(worktreePath) };
  }

  reuse(worktreePath, branch, baseRefs = []) {
    if (!fs.existsSync(worktreePath)) throw new Error(`Recorded worktree no longer exists: ${worktreePath}`);
    return { path: worktreePath, branch, ...mergeDependencies(worktreePath, baseRefs) };
  }

  evidence(worktreePath) {
    const records = runGitRaw(["-c", "core.quotepath=false", "status", "--porcelain=v1", "-z"], worktreePath).split("\0");
    const files = [];
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index];
      if (record.length < 4) continue;
      const status = record.slice(0, 2);
      files.push(decodeGitPath(record.slice(3)));
      if (/[RC]/.test(status) && records[index + 1]) index += 1;
    }
    let diffStat = "";
    try { diffStat = runGit(["diff", "--stat", "HEAD"], worktreePath); } catch { diffStat = ""; }
    return { files: [...new Set(files)], diffStat, clean: files.length === 0 };
  }

  fingerprint(worktreePath) {
    // HEAD covers committed file content; diff covers tracked edits. Hash
    // untracked outputs too: status/diff-stat alone cannot detect same-size edits.
    const hash = createHash("sha256");
    hash.update(runGit(["rev-parse", "HEAD"], worktreePath));
    hash.update(runGitRaw(["diff", "--no-ext-diff", "--binary", "HEAD"], worktreePath));
    hash.update(runGitRaw(["diff", "--cached", "--no-ext-diff", "--binary"], worktreePath));
    const files = runGitRaw(["ls-files", "--others", "--exclude-standard", "-z"], worktreePath).split("\0").filter(Boolean).sort();
    const buffer = Buffer.alloc(65536); let bytes = 0;
    for (const relative of files) {
      const file = path.join(worktreePath, relative); hash.update(relative + "\0");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) { hash.update(fs.readlinkSync(file)); continue; }
      if (!stat.isFile()) throw new Error("Self-check cannot fingerprint a special output file");
      if ((bytes += stat.size) > 256 * 1024 * 1024) throw new Error("Self-check untracked outputs exceed the 256 MiB inspection budget; commit large assets before review");
      const fd = fs.openSync(file, "r");
      try { let length; while ((length = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, length)); }
      finally { fs.closeSync(fd); }
    }
    return hash.digest("hex");
  }
}

module.exports = { WorktreeManager, isAncestor, mergeDependencies, runGitRaw, slug };
