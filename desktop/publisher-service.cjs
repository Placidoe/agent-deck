const { EventEmitter } = require("node:events");

// Keep selectors in one small adapter manifest. A platform UI change should only
// require changing this file, not the Mission or artifact data model.
const PUBLISHER_ADAPTERS = {
  juejin: {
    label: "掘金",
    editorUrl: "https://juejin.cn/editor/drafts/new",
    titleSelectors: ["input[placeholder*='标题']", "input.title-input", "input"],
    bodySelectors: ["textarea.bytemd-editor", ".bytemd-editor textarea", ".CodeMirror", ".CodeMirror textarea", ".editor-content", "[contenteditable='true']", "textarea"],
    publishLabels: ["发布文章", "立即发布", "确认发布", "发布"],
  },
  csdn: {
    label: "CSDN",
    editorUrl: "https://mp.csdn.net/mp_blog/creation/editor",
    titleSelectors: ["input[placeholder*='标题']", "input.title-input", "input"],
    bodySelectors: [".CodeMirror", ".CodeMirror textarea", ".editor__inner textarea", ".editor-content", "[contenteditable='true']", "textarea"],
    publishLabels: ["发布文章", "确认发布", "立即发布", "发布"],
  },
};

function assertPlatform(platform) {
  const adapter = PUBLISHER_ADAPTERS[platform];
  if (!adapter) throw new Error("Unsupported publisher platform");
  return adapter;
}

function editorScript(adapter, payload, autoPublish) {
  const encoded = JSON.stringify({ adapter, payload, autoPublish });
  return `(() => { try {
    const input = ${encoded};
    const visible = (node) => {
      if (!node) return false;
      const style = window.getComputedStyle(node);
      const box = node.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && box.width > 0 && box.height > 0;
    };
    const pick = (selectors) => selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector))).find(visible);
    const write = (element, value) => {
      const codeMirror = element.CodeMirror || element.closest?.(".CodeMirror")?.CodeMirror;
      if (codeMirror?.setValue) { codeMirror.setValue(value); codeMirror.focus?.(); return; }
      if ("value" in element) {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), "value")?.set;
        setter ? setter.call(element, value) : element.value = value;
      } else { element.textContent = value; }
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value.slice(-1) }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    };
    const title = pick(input.adapter.titleSelectors);
    const body = pick(input.adapter.bodySelectors);
    if (!title || !body) return JSON.stringify({ ok: false, state: "needs_login_or_editor", url: location.href, detail: "Editor fields were not found. Sign in in this window, finish any verification, then retry." });
    write(title, input.payload.title);
    write(body, input.payload.content);
    const result = { ok: true, state: "staged", url: location.href, titleFound: title.tagName, bodyFound: body.tagName };
    if (!input.autoPublish) return JSON.stringify(result);
    const buttons = [...document.querySelectorAll("button,[role='button']")];
    const publish = buttons.find((button) => input.adapter.publishLabels.includes((button.innerText || button.textContent || "").trim()));
    if (!publish) return JSON.stringify({ ...result, state: "staged_publish_control_missing", detail: "Content was filled, but the publish control changed. Review and publish manually in this window." });
    publish.click();
    return JSON.stringify({ ...result, state: "publish_requested", detail: "A publish action was requested. The visible publisher window remains open for platform validation or any category/tag requirement." });
  } catch (error) {
    return JSON.stringify({ ok: false, state: "adapter_execution_error", url: String(location.href), detail: "Publisher page script failed: " + String(error?.message || error) });
  } })()`;
}

function normalizeEditorResult(raw) {
  if (typeof raw !== "string") return raw && typeof raw === "object" ? JSON.parse(JSON.stringify(raw)) : raw;
  try { return JSON.parse(raw); }
  catch { return { ok: false, state: "adapter_protocol_error", detail: "The publisher returned an unreadable status. The editor window remains open; copy the draft and publish manually." }; }
}

async function runEditorScript(window, adapter, article, autoPublish) {
  try {
    return normalizeEditorResult(await window.webContents.executeJavaScript(editorScript(adapter, article, autoPublish), true));
  } catch (error) {
    return {
      ok: false,
      state: "adapter_execution_error",
      detail: `Publisher browser automation could not run: ${String(error?.message || error)}`,
    };
  }
}

class PublisherService extends EventEmitter {
  constructor({ BrowserWindow, parentWindow }) {
    super();
    this.BrowserWindow = BrowserWindow;
    this.parentWindow = parentWindow;
    this.windows = new Map();
    this.pending = new Map();
    this.pendingTimers = new Map();
  }

  async connect(platform) {
    const adapter = assertPlatform(platform);
    const window = await this.#window(platform, adapter);
    window.show();
    window.focus();
    return { platform, label: adapter.label, editorUrl: adapter.editorUrl, state: "login_window_open" };
  }

  async publish({ platform, title, content, autoPublish = false }) {
    const adapter = assertPlatform(platform);
    const article = { title: String(title || "").trim(), content: String(content || "") };
    if (!article.title || !article.content.trim()) throw new Error("A title and publish-ready Markdown are required");
    if (article.content.length > 500_000) throw new Error("Publish draft exceeds the 500,000 character browser automation limit; export the Markdown and paste it manually");
    const window = await this.#window(platform, adapter);
    window.show();
    window.focus();
    const result = await runEditorScript(window, adapter, article, Boolean(autoPublish));
    if (result.state === "needs_login_or_editor") {
      this.pending.set(platform, { adapter, article, autoPublish: Boolean(autoPublish) });
      this.#schedulePendingRetry(platform);
    }
    else this.pending.delete(platform);
    this.emit("event", { platform, action: autoPublish ? "publish" : "stage", result, at: new Date().toISOString() });
    return { platform, label: adapter.label, ...result };
  }

  async #window(platform, adapter) {
    const existing = this.windows.get(platform);
    if (existing && !existing.isDestroyed()) return existing;
    const window = new this.BrowserWindow({
      width: 1180, height: 820, minWidth: 880, minHeight: 620,
      title: `Agent Deck · ${adapter.label} Publisher`, parent: this.parentWindow?.(),
      webPreferences: {
        partition: `persist:agent-deck-publisher-${platform}`,
        contextIsolation: true, sandbox: true, nodeIntegration: false,
      },
    });
    window.on("closed", () => {
      this.windows.delete(platform);
      this.pending.delete(platform);
      this.#clearPendingTimer(platform);
    });
    window.webContents.on("did-finish-load", () => this.#flushPending(platform)
      .then((result) => { if (!result?.ok) this.#schedulePendingRetry(platform); })
      .catch((error) => this.emit("event", { platform, action: "pending-fill-failed", error: error.message, at: new Date().toISOString() })));
    this.windows.set(platform, window);
    await window.loadURL(adapter.editorUrl);
    return window;
  }

  async #flushPending(platform) {
    const pending = this.pending.get(platform);
    if (!pending) return null;
    const window = this.windows.get(platform);
    if (!window || window.isDestroyed()) return null;
    const result = await runEditorScript(window, pending.adapter, pending.article, pending.autoPublish);
    if (result.ok) {
      this.pending.delete(platform);
      this.#clearPendingTimer(platform);
    }
    this.emit("event", { platform, action: "pending-fill", result, at: new Date().toISOString() });
    return result;
  }

  #clearPendingTimer(platform) {
    const timer = this.pendingTimers.get(platform);
    if (timer) clearTimeout(timer);
    this.pendingTimers.delete(platform);
  }

  #schedulePendingRetry(platform, attempt = 0) {
    if (!this.pending.has(platform) || attempt >= 20) return;
    this.#clearPendingTimer(platform);
    const timer = setTimeout(async () => {
      this.pendingTimers.delete(platform);
      try {
        const result = await this.#flushPending(platform);
        if (!result?.ok) this.#schedulePendingRetry(platform, attempt + 1);
      } catch (error) {
        this.emit("event", { platform, action: "pending-fill-failed", error: error.message, at: new Date().toISOString() });
        this.#schedulePendingRetry(platform, attempt + 1);
      }
    }, 500);
    timer.unref?.();
    this.pendingTimers.set(platform, timer);
  }
}

module.exports = { PublisherService, PUBLISHER_ADAPTERS, editorScript, normalizeEditorResult, runEditorScript };
