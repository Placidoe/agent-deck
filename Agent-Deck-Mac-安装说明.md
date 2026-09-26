# Agent Deck 0.2.0（macOS Apple Silicon）

Agent Deck 是本地优先的多 Codex 会话与 Mission 编排桌面客户端。

## 安装

1. 双击 `Agent-Deck-0.2.0-arm64.dmg`。
2. 将 `Agent Deck` 拖入 `Applications`。
3. 首次打开时，因为当前测试版尚未经过 Apple 公证，请在 Finder 中按住 Control 点击应用并选择“打开”；如仍被拦截，请进入“系统设置 → 隐私与安全性”并点击“仍要打开”。

## 运行要求

- Apple Silicon Mac（M1/M2/M3/M4 或更新机型）。
- 本机已安装 `/Applications/ChatGPT.app` 并登录可用的 Codex 账号，或者已安装并登录 Codex CLI。
- Mission 的目标工作区必须是至少包含一次提交的 Git 仓库，才能创建隔离 Worktree。

## 当前版本说明

- Session、Mission、SQLite 账本、Codex Thread、Git Worktree、消息总线和任务恢复均在本机真实运行。
- 产物支持打开、Finder 定位、单文件/整包导出；Mission 可导出 Markdown 证据报告，并可分页查看原始活动账本。
- 应用不包含独立云服务；模型请求由本机 Codex 使用当前登录账号发起。
- 当前版本未使用 Apple Developer ID 签名或公证，仅适合受信任的小范围测试分享。
- 当前安装包仅支持 Apple Silicon，不支持 Intel Mac。

应用数据保存在 `~/Library/Application Support/agent-deck-demo/`。
