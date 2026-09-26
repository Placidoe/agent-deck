const fs = require("node:fs");
const path = require("node:path");

function safeName(value, fallback = "artifact") {
  return String(value || fallback).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 100) || fallback;
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function htmlEscape(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function embeddedJson(value) {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function isHtmlFile(file) {
  return [".html", ".htm"].includes(path.extname(String(file || "")).toLowerCase());
}

function secureHtmlPreview(content) {
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'">`;
  const source = String(content || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi, "");
  if (/<head(?:\s[^>]*)?>/i.test(source)) return source.replace(/<head(\s[^>]*)?>/i, (match) => `${match}${policy}`);
  if (/<html(?:\s[^>]*)?>/i.test(source)) return source.replace(/<html(\s[^>]*)?>/i, (match) => `${match}<head>${policy}</head>`);
  return `<!doctype html><html><head>${policy}</head><body>${source}</body></html>`;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;|&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/&#x([\da-f]+);/gi, (_match, number) => String.fromCodePoint(parseInt(number, 16)));
}

function plainHtml(value) {
  return decodeHtml(String(value || "").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, " ").trim();
}

function htmlTableToMarkdown(table) {
  const rows = [...String(table || "").matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((row) => [...row[1].matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => plainHtml(cell[1]).replaceAll("|", "\\|")));
  if (!rows.length || !rows[0].length) return "";
  const width = rows[0].length;
  const normalized = rows.map((row) => [...row.slice(0, width), ...Array(Math.max(0, width - row.length)).fill("")]);
  return [`| ${normalized[0].join(" | ")} |`, `| ${normalized[0].map(() => "---").join(" | ")} |`, ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function htmlToMarkdown(content) {
  let source = String(content || "");
  const body = source.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i) || source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  if (body) source = body[1];
  source = source.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|iframe|object|embed|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg\s*>/gi, "")
    .replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, (table) => `\n\n${htmlTableToMarkdown(table)}\n\n`)
    .replace(/<pre\b[^>]*>\s*<code(?:\s+class=["']?([^"' >]+)[^>]*?)?>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_match, className, code) => `\n\n\`\`\`${String(className || "").match(/(?:language-|lang-)([\w+-]+)/i)?.[1] || ""}\n${decodeHtml(code).trim()}\n\`\`\`\n\n`)
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, text) => `\n\n${"#".repeat(Number(level))} ${plainHtml(text)}\n\n`)
    .replace(/<img\b[^>]*>/gi, (tag) => {
      const src = tag.match(/\bsrc=["']([^"']+)["']/i)?.[1];
      const alt = tag.match(/\balt=["']([^"']*)["']/i)?.[1] || "image";
      return src ? `![${decodeHtml(alt)}](${src})` : "";
    })
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, text) => `[${plainHtml(text)}](${href})`)
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) => `**${plainHtml(text)}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_match, _tag, text) => `*${plainHtml(text)}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_match, text) => `\`${plainHtml(text).replaceAll("`", "\\`")}\``)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, text) => `\n- ${plainHtml(text)}`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_match, text) => `\n> ${plainHtml(text)}\n`)
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:p|div|section|article|header|figure|figcaption|ul|ol)>/gi, "\n\n")
    .replace(/<[^>]+>/g, "");
  return decodeHtml(source)
    .replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function markdownForPlatform({ content, title, platform, sourceName }) {
  const source = String(content || "");
  const isHtml = isHtmlFile(sourceName);
  const body = isHtml ? htmlToMarkdown(source) : source
    .replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]+\sstyle=["'][^"']*["'][^>]*>/gi, "");
  const withoutLeadingTitle = body.replace(/^\s*#\s+[^\n]+\n+/, "").trim();
  const name = platform === "juejin" ? "掘金" : "CSDN";
  const warnings = [
    isHtml ? "已将 HTML 转为兼容 Markdown；页面布局、内联 CSS、脚本和交互不会随文章发布。" : "已保留 Markdown 主体，并移除不适合第三方编辑器的脚本和内联样式。",
    "请在发布页手动上传本地图片；外链或 data: 图片在平台端可能失效。",
    "请在发布前补充分类、标签、封面，并预览表格、公式与代码块。",
  ];
  return {
    platform, title: String(title || "Untitled artifact"),
    content: `# ${String(title || "Untitled artifact").trim()}\n\n${withoutLeadingTitle}\n\n---\n\n> 本文由 Agent Deck 从本地产物生成 ${name} 发布稿；原始 HTML/Markdown 与可验证证据保留在本地。\n`,
    warnings,
    sourceFormat: isHtml ? "html" : path.extname(String(sourceName || "")).replace(/^\./, "") || "text",
    editorUrl: platform === "juejin" ? "https://juejin.cn/editor/drafts/new" : "https://mp.csdn.net/mp_blog/creation/editor",
    fileName: `${safeName(title, "article")}-${platform}.md`,
  };
}

function uniqueDirectory(parent, name) {
  let candidate = path.join(parent, name);
  for (let index = 2; fs.existsSync(candidate); index += 1) candidate = path.join(parent, `${name} (${index})`);
  return candidate;
}

function missionReport(mission) {
  const tasks = mission.tasks || [];
  const artifacts = mission.artifacts || [];
  const messages = (mission.messages || []).slice().reverse();
  const verified = tasks.filter((task) => task.status === "completed").length;
  const taskRows = tasks.map((task) => `<tr><td><code>${htmlEscape(task.key)}</code></td><td><strong>${htmlEscape(task.title)}</strong></td><td>${htmlEscape(task.agentRole)}</td><td><span class="status ${htmlEscape(task.status)}">${htmlEscape(task.status)}</span></td><td><code>${htmlEscape(task.branch || "—")}</code></td><td><code>${htmlEscape(task.commitHash?.slice(0, 12) || "—")}</code></td></tr>`).join("");
  const evidenceCards = tasks.map((task) => {
    const evidence = (task.evidence || []).length ? task.evidence.map((item) => `<li class="${item.passed ? "pass" : "fail"}"><b>${item.passed ? "PASS" : "NOT PASSED"}</b><div><strong>${htmlEscape(item.criterion)}</strong><p>${htmlEscape(item.evidence)}</p></div></li>`).join("") : `<li class="empty">No acceptance evidence recorded.</li>`;
    return `<article class="card" data-task-key="${htmlEscape(task.key)}"><header><code>${htmlEscape(task.key)}</code><span class="status ${htmlEscape(task.status)}">${htmlEscape(task.status)}</span></header><h3>${htmlEscape(task.title)}</h3><p>${htmlEscape(task.result?.summary || task.error || "No submitted result.")}</p><ul class="evidence">${evidence}</ul></article>`;
  }).join("");
  const artifactCards = artifacts.map((artifact) => `<article class="card artifact"><header><strong>${htmlEscape(artifact.title)}</strong><span class="status">${htmlEscape(artifact.verificationStatus)}</span></header><p>${htmlEscape(artifact.summary || "")}</p><ul>${(artifact.files || []).map((file) => `<li><code>${htmlEscape(file)}</code>${isHtmlFile(file) ? '<span class="format">HTML</span>' : ""}</li>`).join("") || "<li>No file attached</li>"}</ul></article>`).join("") || '<p class="empty-state">No artifacts published yet.</p>';
  const busItems = messages.map((message) => `<li><time>${htmlEscape(message.createdAt)}</time><strong>${htmlEscape(message.fromAgent)} → ${htmlEscape(message.toAgent)}</strong><code>${htmlEscape(message.topic)}</code><p>${htmlEscape(message.text)}</p></li>`).join("") || '<li class="empty">No persisted messages.</li>';
  const data = { schema: "agent-deck-report/v1", generatedAt: new Date().toISOString(), mission: { id: mission.id, title: mission.title, status: mission.status, outcome: mission.outcome, provider: mission.provider, model: mission.model, workspace: mission.cwd, updatedAt: mission.updatedAt }, tasks, artifacts, messages };
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="generator" content="Agent Deck"><meta name="agent-deck-schema" content="agent-deck-report/v1"><title>${htmlEscape(mission.title)} · Agent Deck</title>
<style>:root{color-scheme:dark;--bg:#090d10;--panel:#11171b;--line:#29343d;--text:#e5e9ed;--muted:#84919b;--blue:#5aa9f7;--green:#69d17d;--amber:#efb33c}*{box-sizing:border-box}body{margin:0;color:var(--text);background:radial-gradient(circle at 75% 0,#142536 0,transparent 34%),var(--bg);font:14px/1.6 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(1180px,calc(100% - 40px));margin:auto;padding:48px 0 72px}header.hero{display:grid;grid-template-columns:1fr auto;gap:28px;padding:30px;border:1px solid #31506b;border-radius:18px;background:linear-gradient(145deg,#142230,#10161b);box-shadow:0 24px 80px #0007}.eyebrow{color:var(--blue);font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase}h1{max-width:850px;margin:8px 0 12px;font-size:clamp(28px,4vw,48px);line-height:1.12}h2{margin:42px 0 16px;font-size:22px}h3{margin:12px 0 6px;font-size:15px}.hero p,.card p{color:#aeb9c1}.score{display:grid;min-width:142px;place-items:center;border:1px solid #315d3a;border-radius:14px;background:#12251a}.score strong{color:var(--green);font-size:32px}.score span{color:#809188;font-size:11px}.meta{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:16px 0}.meta div,.card{padding:16px;border:1px solid var(--line);border-radius:12px;background:var(--panel)}.meta span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase}.meta strong,.meta code{display:block;margin-top:5px;overflow-wrap:anywhere}.outcome{padding:22px;border-left:3px solid var(--blue);border-radius:0 12px 12px 0;background:#101b24}.table-wrap{overflow:auto;border:1px solid var(--line);border-radius:12px}table{width:100%;border-collapse:collapse;background:#0f1519}th,td{padding:12px;text-align:left;border-bottom:1px solid #202a31}th{color:var(--muted);background:#151d22;font-size:10px;text-transform:uppercase}code{color:#8fc3f2;font:12px/1.5 "SFMono-Regular",Menlo,monospace}.status,.format{display:inline-flex;padding:2px 7px;border:1px solid #3a4650;border-radius:999px;color:#aeb8c0;font-size:10px}.status.completed{color:var(--green);border-color:#326a3e;background:#142b19}.status.blocked,.status.failed{color:var(--amber);border-color:#735620;background:#30230e}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.card header{display:flex;align-items:center;justify-content:space-between;gap:12px}.evidence{padding:0;list-style:none}.evidence li{display:flex;gap:10px;padding:10px 0;border-top:1px solid #222c33}.evidence b{min-width:78px;color:var(--green);font-size:10px}.evidence .fail b{color:var(--amber)}.evidence p{margin:2px 0 0;font-size:12px}.artifact ul{padding-left:18px}.artifact li{padding:4px}.format{margin-left:8px;color:var(--blue);border-color:#315b7e}.bus{padding:0;list-style:none;border:1px solid var(--line);border-radius:12px;overflow:hidden}.bus li{display:grid;grid-template-columns:155px 220px 130px 1fr;gap:12px;padding:12px 14px;border-bottom:1px solid #222c33;background:#0f1519}.bus li:last-child{border:0}.bus time{color:#71808b;font-size:11px}.bus p{margin:0;color:#a7b2ba}.empty,.empty-state{color:var(--muted)}footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--line);color:#6f7c86;font-size:11px}@media(max-width:760px){main{width:min(100% - 22px,1180px);padding-top:20px}header.hero{grid-template-columns:1fr}.score{min-height:100px}.meta,.grid{grid-template-columns:1fr}.bus li{grid-template-columns:1fr;gap:2px}}</style>
<script type="application/json" id="agent-deck-data">${embeddedJson(data)}</script></head><body><main><header class="hero"><div><span class="eyebrow">Agent Deck Mission Report</span><h1>${htmlEscape(mission.title)}</h1><p>${htmlEscape(mission.outcome)}</p></div><div class="score"><strong>${verified}/${tasks.length}</strong><span>verified tasks</span></div></header><section class="meta" aria-label="Mission metadata"><div><span>Status</span><strong>${htmlEscape(mission.status)}</strong></div><div><span>Provider</span><strong>${htmlEscape(mission.provider || "—")}</strong></div><div><span>Model</span><strong>${htmlEscape(mission.model || "default")}</strong></div><div><span>Updated</span><time>${htmlEscape(mission.updatedAt)}</time></div></section><section data-agent-deck-section="outcome"><h2>Outcome</h2><p class="outcome">${htmlEscape(mission.outcome)}</p></section><section data-agent-deck-section="tasks"><h2>Task ledger</h2><div class="table-wrap"><table><thead><tr><th>Key</th><th>Task</th><th>Owner</th><th>Status</th><th>Branch</th><th>Commit</th></tr></thead><tbody>${taskRows}</tbody></table></div></section><section data-agent-deck-section="evidence"><h2>Acceptance evidence</h2><div class="grid">${evidenceCards}</div></section><section data-agent-deck-section="artifacts"><h2>Artifacts</h2><div class="grid">${artifactCards}</div></section><section data-agent-deck-section="messages"><h2>Recent message bus</h2><ol class="bus">${busItems}</ol></section><footer>Generated from the local Agent Deck evidence ledger · Workspace: ${htmlEscape(mission.cwd)}</footer></main></body></html>`;
}

class ArtifactService {
  constructor({ store, dialog, shell, clipboard, downloadsPath }) {
    this.store = store;
    this.dialog = dialog;
    this.shell = shell;
    this.clipboard = clipboard;
    this.downloadsPath = downloadsPath;
  }

  inspect(input) {
    const { mission, artifact } = this.#context(input);
    return {
      ...artifact,
      resolvedFiles: (artifact.files || []).map((file) => this.#metadata(mission, artifact, file)),
    };
  }

  preview(input) {
    const { mission, artifact } = this.#context(input);
    const metadata = this.#metadata(mission, artifact, input.file);
    if (!metadata.exists || metadata.kind !== "file") throw new Error(`Only an existing file can be previewed: ${metadata.relativePath}`);
    if (!metadata.previewable) throw new Error("Only self-contained HTML artifacts support in-app preview");
    if (metadata.size > 5 * 1024 * 1024) throw new Error("HTML artifact is larger than the 5 MB preview limit");
    return { ...metadata, title: artifact.title, content: secureHtmlPreview(fs.readFileSync(metadata.path, "utf8")), mimeType: "text/html" };
  }

  async open(input) {
    const { mission, artifact } = this.#context(input);
    const metadata = this.#metadata(mission, artifact, input.file);
    if (!metadata.exists) throw new Error(`Artifact file no longer exists: ${metadata.relativePath}`);
    const error = await this.shell.openPath(metadata.path);
    if (error) throw new Error(error);
    return metadata;
  }

  reveal(input) {
    const { mission, artifact } = this.#context(input);
    const metadata = this.#metadata(mission, artifact, input.file);
    if (!metadata.exists) throw new Error(`Artifact file no longer exists: ${metadata.relativePath}`);
    this.shell.showItemInFolder(metadata.path);
    return metadata;
  }

  async export(input, parentWindow) {
    const { mission, artifact } = this.#context(input);
    if (input.file) {
      const metadata = this.#metadata(mission, artifact, input.file);
      if (!metadata.exists || metadata.kind !== "file") throw new Error(`Only an existing file can be exported: ${metadata.relativePath}`);
      const selected = await this.dialog.showSaveDialog(parentWindow, {
        title: "Export artifact file",
        defaultPath: path.join(this.downloadsPath, metadata.name),
      });
      if (selected.canceled || !selected.filePath) return { canceled: true };
      fs.copyFileSync(metadata.path, selected.filePath);
      return { canceled: false, destination: selected.filePath, exported: 1 };
    }

    const selected = await this.dialog.showOpenDialog(parentWindow, {
      title: "Choose a folder for this artifact",
      defaultPath: this.downloadsPath,
      properties: ["openDirectory", "createDirectory"],
    });
    if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
    const destination = uniqueDirectory(selected.filePaths[0], safeName(artifact.title));
    fs.mkdirSync(destination, { recursive: true });
    let exported = 0;
    for (const file of artifact.files || []) {
      const metadata = this.#metadata(mission, artifact, file);
      if (!metadata.exists) continue;
      const target = path.join(destination, metadata.name);
      metadata.kind === "directory" ? fs.cpSync(metadata.path, target, { recursive: true }) : fs.copyFileSync(metadata.path, target);
      exported += 1;
    }
    const summaryHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(artifact.title)}</title><style>body{max-width:900px;margin:48px auto;padding:0 24px;color:#18212a;background:#f7f9fb;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}article{padding:28px;border:1px solid #dbe3ea;border-radius:14px;background:white;box-shadow:0 12px 36px #14263812}h1{margin-top:0}code{color:#1769aa}li{margin:7px 0}.status{display:inline-block;padding:3px 8px;border-radius:999px;color:#176b2f;background:#e6f5ea;font-size:12px}</style></head><body><article><span class="status">${htmlEscape(artifact.verificationStatus)}</span><h1>${htmlEscape(artifact.title)}</h1><p>${htmlEscape(artifact.summary)}</p><h2>Files</h2><ul>${(artifact.files || []).map((file) => `<li><code>${htmlEscape(file)}</code></li>`).join("") || "<li>No file attached</li>"}</ul></article></body></html>`;
    fs.writeFileSync(path.join(destination, "index.html"), summaryHtml, "utf8");
    this.shell.showItemInFolder(destination);
    return { canceled: false, destination, exported };
  }

  publication(input) {
    const { mission, artifact } = this.#context(input);
    if (!["juejin", "csdn"].includes(input.platform)) throw new Error("Choose CSDN or 掘金 as the publication platform");
    const metadata = this.#metadata(mission, artifact, input.file);
    if (!metadata.exists || metadata.kind !== "file") throw new Error("Choose an existing HTML or Markdown artifact to prepare a publishable post");
    if (metadata.size > 5 * 1024 * 1024) throw new Error("This artifact is larger than the 5 MB publication conversion limit");
    const extension = path.extname(metadata.name).toLowerCase();
    if (![".html", ".htm", ".md", ".markdown", ".txt"].includes(extension)) throw new Error("Only HTML, Markdown, and text artifacts can be converted for publication");
    return {
      ...markdownForPlatform({ content: fs.readFileSync(metadata.path, "utf8"), title: artifact.title, platform: input.platform, sourceName: metadata.name }),
      artifactId: artifact.id, missionId: mission.id, sourceFile: metadata.relativePath,
    };
  }

  copyPublication(input) {
    const publication = this.publication(input);
    if (!this.clipboard) throw new Error("Clipboard is not available in this desktop runtime");
    this.clipboard.writeText(publication.content);
    return { ...publication, copied: true };
  }

  async exportPublication(input, parentWindow) {
    const publication = this.publication(input);
    const selected = await this.dialog.showSaveDialog(parentWindow, {
      title: `Export ${publication.platform === "juejin" ? "掘金" : "CSDN"} publish draft`,
      defaultPath: path.join(this.downloadsPath, publication.fileName),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    fs.writeFileSync(selected.filePath, publication.content, "utf8");
    this.shell.showItemInFolder(selected.filePath);
    return { ...publication, canceled: false, destination: selected.filePath };
  }

  async openPublisher(input) {
    const publication = this.publication(input);
    await this.shell.openExternal(publication.editorUrl);
    return publication;
  }

  async exportMissionReport(missionId, parentWindow) {
    const mission = this.store.getMission(missionId, { eventLimit: 200, messageLimit: 300, artifactLimit: 300 });
    if (!mission) throw new Error("Mission not found");
    const selected = await this.dialog.showSaveDialog(parentWindow, {
      title: "Export mission report",
      defaultPath: path.join(this.downloadsPath, `${safeName(mission.title, "mission-report")}.html`),
      filters: [{ name: "HTML", extensions: ["html"] }],
    });
    if (selected.canceled || !selected.filePath) return { canceled: true };
    fs.writeFileSync(selected.filePath, missionReport(mission), "utf8");
    this.shell.showItemInFolder(selected.filePath);
    return { canceled: false, destination: selected.filePath };
  }

  #context(input) {
    const mission = this.store.getMission(input.missionId);
    if (!mission) throw new Error("Mission not found");
    const artifact = this.store.getArtifact(input.artifactId);
    if (!artifact || artifact.missionId !== mission.id) throw new Error("Artifact not found in this mission");
    return { mission, artifact };
  }

  #metadata(mission, artifact, file) {
    if (!file || !(artifact.files || []).includes(file)) throw new Error("Artifact file was not published in the evidence ledger");
    const task = (mission.tasks || []).find((item) => item.id === artifact.taskId);
    const roots = [task?.worktreePath, mission.integrationPath, mission.executionCwd, mission.cwd].filter(Boolean).map((root) => {
      const resolved = path.resolve(root);
      return fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    });
    const candidate = path.isAbsolute(file) ? path.resolve(file) : path.resolve(task?.worktreePath || mission.integrationPath || mission.executionCwd || mission.cwd, file);
    const exists = fs.existsSync(candidate);
    const authorizedCandidate = exists ? fs.realpathSync(candidate) : candidate;
    if (!roots.some((root) => isWithin(root, authorizedCandidate))) throw new Error("Artifact path is outside the authorized mission workspace");
    const stat = exists ? fs.statSync(authorizedCandidate) : null;
    return {
      path: authorizedCandidate,
      relativePath: file,
      name: path.basename(candidate),
      exists,
      kind: stat?.isDirectory() ? "directory" : "file",
      size: stat?.isFile() ? stat.size : null,
      modifiedAt: stat?.mtime?.toISOString?.() || null,
      previewable: stat?.isFile() ? isHtmlFile(candidate) : false,
    };
  }
}

module.exports = { ArtifactService, isWithin, missionReport, safeName, secureHtmlPreview, htmlToMarkdown, markdownForPlatform };
