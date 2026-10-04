const fs = require("node:fs");
const path = require("node:path");
const { isWithin, secureHtmlPreview } = require("./artifact-service.cjs");
class LibraryService {
  constructor({ store, artifacts, dialog, shell }) { Object.assign(this, { store, artifacts, dialog, shell }); }
  async connect(_input, window) {
    const selection = await this.dialog.showOpenDialog(window, { title: "关联已有文件夹（只读，不移动文件）", properties: ["openDirectory"] });
    if (selection.canceled || !selection.filePaths[0]) return null;
    const rootPath = fs.realpathSync(selection.filePaths[0]);
    return this.store.library.createFolder({ name: path.basename(rootPath), rootPath });
  }
  resolve(input) {
    const folder = this.store.library.folder(input.folderId);
    if (!folder.rootPath) throw new Error("这个分类不是本地文件夹");
    const root = fs.realpathSync(folder.rootPath);
    if (root !== path.resolve(folder.rootPath)) throw new Error("关联文件夹的路径已改变，请重新关联");
    // Resolve both lexical and real paths, rejecting absolute paths and symlink escapes.
    const file = String(input.file || "."); if (path.isAbsolute(file)) throw new Error("只能读取文件夹内的相对路径");
    const candidate = path.resolve(root, file);
    if (!isWithin(root, candidate)) throw new Error("文件超出授权文件夹");
    const resolved = fs.realpathSync(candidate);
    if (!isWithin(root, resolved)) throw new Error("文件链接超出授权文件夹");
    return { path: resolved, name: path.basename(resolved), stat: fs.statSync(resolved) };
  }
  browse(input) {
    const target = this.resolve(input); if (!target.stat.isDirectory()) throw new Error("不是文件夹");
    const offset = Math.min(100000, Math.max(0, Number(input.offset) || 0));
    const items = []; let index = 0; let more = false;
    // No recursion, stat or content reads while listing. Bound visible batches to 100.
    const directory = fs.opendirSync(target.path);
    try { let entry; while ((entry = directory.readSync())) {
      if (entry.name.startsWith(".")) continue;
      if (index++ < offset) continue;
      if (items.length === 100) { more = true; break; }
      items.push({ name: entry.name, file: path.join(input.file || ".", entry.name), kind: entry.isDirectory() ? "folder" : entry.isSymbolicLink() ? "link" : "file" });
    } } finally { directory.closeSync(); }
    return { items, nextOffset: more ? offset + items.length : null };
  }
  preview(input) {
    let file;
    if (input.artifactId) {
      const metadata = this.artifacts.inspectFile(input);
      if (!metadata?.exists) throw new Error("文件不存在");
      file = { ...metadata, stat: fs.statSync(metadata.path) };
    } else file = this.resolve(input);
    if (!file.stat.isFile() || file.stat.size > 5 * 1024 * 1024) throw new Error("仅支持预览不超过 5 MB 的文件");
    const ext = path.extname(file.path).toLowerCase();
    if (![".html", ".htm", ".md", ".txt", ".json", ".csv", ".tsv"].includes(ext)) throw new Error("此格式请在系统应用中打开");
    const html = ext === ".html" || ext === ".htm";
    const content = fs.readFileSync(file.path, "utf8");
    return { title: file.name, mimeType: html ? "text/html" : "text/plain", content: html ? secureHtmlPreview(content) : content };
  }
  async action(input, window) {
    if (!["open", "reveal", "export"].includes(input.action)) throw new Error("未知文件操作");
    if (input.artifactId) return this.artifacts[input.action](input, window);
    const file = this.resolve(input);
    if (input.action === "reveal") { this.shell.showItemInFolder(file.path); return { name: file.name }; }
    if (input.action === "open") { const error = await this.shell.openPath(file.path); if (error) throw new Error(error); return { name: file.name }; }
    if (!file.stat.isFile()) throw new Error("请进入文件夹后下载具体文件");
    const selected = await this.dialog.showSaveDialog(window, { title: "下载文件", defaultPath: file.name });
    if (selected.canceled || !selected.filePath) return null;
    if (path.resolve(selected.filePath) === file.path) throw new Error("请选择不同的下载路径");
    fs.copyFileSync(file.path, selected.filePath); return { path: selected.filePath };
  }
}
module.exports = { LibraryService };
