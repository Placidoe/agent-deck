const { randomUUID } = require("node:crypto");
const path = require("node:path");
const q = value => value == null ? "NULL" : `'${String(value).replaceAll("'", "''")}'`;
const parse = value => { try { return JSON.parse(value || "[]"); } catch { return []; } };
const documentExtensions = new Set([".html", ".htm", ".md", ".txt", ".pdf", ".docx", ".pptx"]);
const identity = (row, file) => JSON.stringify([row.mission_id, row.task_id || null, path.relative(row.worktree_path || row.cwd, path.resolve(row.worktree_path || row.cwd, file))]);

// A local metadata library, not a file mover. Published outputs remain in their
// original authorized workspaces; registration never accepts a task or runs AI.
class LibraryStore {
  constructor({ all, exec }) {
    this.all = all; this.exec = exec;
    exec(`CREATE TABLE IF NOT EXISTS library_folders (
      id TEXT PRIMARY KEY,name TEXT NOT NULL,parent_id TEXT REFERENCES library_folders(id),
      root_path TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS library_memberships (
      file_key TEXT PRIMARY KEY,folder_id TEXT NOT NULL REFERENCES library_folders(id));
      CREATE INDEX IF NOT EXISTS idx_library_memberships_folder ON library_memberships(folder_id);
      CREATE INDEX IF NOT EXISTS idx_library_memberships_work ON library_memberships(json_extract(file_key,'$[0]'));
      CREATE INDEX IF NOT EXISTS idx_library_runs_ended ON mission_runs(mission_id,ended_at DESC);`);
  }
  folders() { return this.all("SELECT * FROM library_folders ORDER BY name,id;").map(r => ({ id: r.id, name: r.name, parentId: r.parent_id, rootPath: r.root_path, createdAt: r.created_at })); }
  folder(id) { const folder = this.folders().find(f => f.id === id); if (!folder) throw new Error("文件夹不存在"); return folder; }
  createFolder({ name, parentId = null, rootPath = null }) {
    name = String(name || "").trim(); if (!name || name.length > 100) throw new Error("请输入 1–100 字的文件夹名称");
    if (parentId) this.folder(parentId);
    if (rootPath) { const existing = this.folders().find(f => f.rootPath === rootPath); if (existing) return existing; }
    const id = randomUUID(); this.exec(`INSERT INTO library_folders VALUES(${q(id)},${q(name)},${q(parentId)},${q(rootPath)},${q(new Date().toISOString())});`); return this.folder(id);
  }
  files({ before = null, limit = 100, folderId = null, workspacePath = null, query = "", kind = null } = {}) {
    const take = Math.min(200, Math.max(1, Math.trunc(Number(limit)) || 100));
    const folder = folderId ? this.folder(folderId) : null;
    // Pagination is by immutable artifact id/time, never a complete Mission or chat.
    const cursor = before ? this.all(`SELECT created_at,id FROM artifacts WHERE id=${q(before)};`)[0] : null;
    if (before && !cursor) throw new Error("列表游标已失效，请刷新");
    const root = folder?.rootPath || workspacePath;
    const where = (cursor ? `AND (a.created_at<${q(cursor.created_at)} OR (a.created_at=${q(cursor.created_at)} AND a.id<${q(cursor.id)}))` : "") +
      (root ? ` AND m.cwd=${q(root)}` : "") +
      (folder && !folder.rootPath ? ` AND EXISTS (SELECT 1 FROM library_memberships l WHERE json_extract(l.file_key,'$[0]')=a.mission_id AND IFNULL(json_extract(l.file_key,'$[1]'),'')=IFNULL(a.task_id,'') AND l.folder_id=${q(folder.id)})` : "") +
      (query ? ` AND instr(lower(a.title || ' ' || a.files_json || ' ' || m.title),${q(String(query).toLowerCase())})>0` : "");
    const rows = this.all(`SELECT a.id,a.title,a.files_json,a.verification_status,a.created_at,a.task_id,a.mission_id,
      m.title AS work_title,m.cwd,t.worktree_path,t.status AS task_status FROM artifacts a JOIN missions m ON m.id=a.mission_id
      LEFT JOIN tasks t ON t.id=a.task_id WHERE 1=1 ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT ${take + 1};`);
    const members = new Map((rows.length ? this.all(`SELECT * FROM library_memberships WHERE json_extract(file_key,'$[0]') IN (${rows.map(r => q(r.mission_id)).join(",")});`) : []).map(r => [r.file_key, r.folder_id]));
    const seen = new Set();
    const items = rows.slice(0, take).flatMap(r => parse(r.files_json).filter(file => typeof file === "string").slice(0, 200).map(file => {
      const key = identity(r, file); const ext = path.extname(file).toLowerCase();
      return { key, name: path.basename(file), file, artifactId: r.id, missionId: r.mission_id, taskId: r.task_id,
        title: r.title, workTitle: r.work_title, workspacePath: r.cwd, createdAt: r.created_at,
        verificationStatus: r.verification_status, taskStatus: r.task_status,
        kind: documentExtensions.has(ext) ? "document" : "asset", folderId: members.get(key) || null };
    })).filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true; }).filter(item => (!workspacePath || item.workspacePath === workspacePath) && (!folder || (folder.rootPath ? item.workspacePath === folder.rootPath : item.folderId === folderId)) &&
      (!kind || item.kind === kind) && (!query || `${item.name} ${item.title} ${item.workTitle}`.toLowerCase().includes(String(query).toLowerCase())));
    return { items, nextBefore: rows.length > take ? rows[take - 1].id : null };
  }
  assign({ fileKey, folderId }) {
    const key = parse(fileKey); if (key.length !== 3 || typeof key[0] !== "string" || key[1] != null && typeof key[1] !== "string" || typeof key[2] !== "string") throw new Error("文件记录无效");
    const artifact = this.all(`SELECT a.mission_id,a.task_id,a.files_json,m.cwd,t.worktree_path FROM artifacts a JOIN missions m ON m.id=a.mission_id LEFT JOIN tasks t ON t.id=a.task_id WHERE a.mission_id=${q(key[0])} AND IFNULL(a.task_id,'')=${q(key[1] || "")} ORDER BY a.created_at DESC LIMIT 2000;`).find(row => parse(row.files_json).filter(file => typeof file === "string").slice(0,200).some(file => identity(row, file) === fileKey));
    if (!artifact) throw new Error("文件记录不存在");
    if (folderId) { if (this.folder(folderId).rootPath) throw new Error("本地文件夹保持原样，请选择文档分类文件夹"); this.exec(`INSERT INTO library_memberships VALUES(${q(fileKey)},${q(folderId)}) ON CONFLICT(file_key) DO UPDATE SET folder_id=excluded.folder_id;`); }
    else this.exec(`DELETE FROM library_memberships WHERE file_key=${q(fileKey)};`);
    return { fileKey, folderId: folderId || null };
  }
  overview() {
    const workspaces = this.all("SELECT cwd,COUNT(*) AS count FROM missions GROUP BY cwd ORDER BY cwd;").map(r => ({ path: r.cwd, name: path.basename(r.cwd), count: r.count }));
    const reviews = this.all(`SELECT t.id AS task_id,t.mission_id,t.title,t.agent_role,t.updated_at,m.title AS work_title,
      (SELECT COUNT(*) FROM artifacts a WHERE a.task_id=t.id) AS artifact_count FROM tasks t JOIN missions m ON m.id=t.mission_id
      WHERE t.status='review' ORDER BY t.updated_at DESC LIMIT 200;`).map(r => ({ taskId: r.task_id, missionId: r.mission_id, title: r.title, workTitle: r.work_title, agentRole: r.agent_role, updatedAt: r.updated_at, artifactCount: r.artifact_count }));
    return { folders: this.folders(), workspaces, reviews };
  }
  history({ folderId = null, workspacePath = null } = {}) {
    const folder = folderId ? this.folder(folderId) : null;
    const root = folder?.rootPath || workspacePath;
    const where = root ? `m.cwd=${q(root)}` : folderId ? `EXISTS (SELECT 1 FROM library_memberships l WHERE json_extract(l.file_key,'$[0]')=m.id AND l.folder_id=${q(folderId)})` : "1=1";
    return this.all(`SELECT m.id,m.title,m.status,m.cwd,m.main_thread_id,
      CASE WHEN m.status='completed' THEN COALESCE((SELECT MAX(r.ended_at) FROM mission_runs r WHERE r.mission_id=m.id),m.updated_at) END AS completed_at
      FROM missions m WHERE ${where} ORDER BY completed_at IS NULL,completed_at DESC,m.updated_at DESC LIMIT 100;`).map(r => ({ id: r.id, title: r.title, status: r.status, workspacePath: r.cwd, threadId: r.main_thread_id, completedAt: r.completed_at }));
  }
  sessions({ missionId }) {
    if (!this.all(`SELECT id FROM missions WHERE id=${q(missionId)};`)[0]) throw new Error("工作记录不存在");
    return this.all(`SELECT s.task_id,s.title,s.thread_id,s.status,MAX(r.ended_at) AS ended_at FROM (
      SELECT NULL AS task_id,title,main_thread_id AS thread_id,status FROM missions WHERE id=${q(missionId)}
      UNION ALL SELECT id AS task_id,title,agent_thread_id AS thread_id,status FROM tasks WHERE mission_id=${q(missionId)}
      ) s LEFT JOIN mission_runs r ON r.mission_id=${q(missionId)} AND r.thread_id=s.thread_id
      WHERE s.thread_id IS NOT NULL GROUP BY s.thread_id ORDER BY ended_at IS NULL,ended_at DESC LIMIT 100;`).map(r => ({ taskId: r.task_id, title: r.title, threadId: r.thread_id, status: r.status, lastEndedAt: r.ended_at }));
  }
}
module.exports = { LibraryStore };
