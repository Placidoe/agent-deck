const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
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

  // Only bootstrap repositories under our own storage. Never git-init the
  // user's source folder or import its contents into the output repository.
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
}

module.exports = { WorktreeManager, isAncestor, mergeDependencies, runGitRaw, slug };
