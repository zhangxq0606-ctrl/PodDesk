---
lifecycle: bootstrap
foundation: pending
active_goal: null
work_status: active
last_verified: 2026-11-25
---

# 当前里程碑

`v0.2.0`（Windows x64 `.exe` + macOS Apple Silicon `.dmg`）已通过双端 CI/CD 发布为 GitHub Pre-release，官网 `https://poddesk.captainxq.me/` 已同步至最新版本。当前进入内测反馈收集与迭代收口期；对外变更见 [CHANGELOG.md](../CHANGELOG.md)。

# 已验证能力

- **`v0.2.0` 全栈校验与云端双端出包（`2026-11-24` 实测）**：
  - 本地校验：`npm run version:check -- --tag v0.2.0`、`npm run typecheck`、`npm run test`（Vitest 7 文件 29 用例）、`npm run build`（Vite 6）、`cargo test --manifest-path server/Cargo.toml`（58 passed, 1 ignored）、`cargo test --manifest-path desktop/Cargo.toml`（1 passed）与 Windows `npm run tauri:build`（`6.09 MiB`）均通过；
  - 云端流水线：GitHub Actions 三路 CI（`web` / `windows-latest` / `macos-26`）与 `release.yml` 双端打包、`SHA256SUMS.txt` 及 Release 直链 302 跳转均已验证。
- **macOS Apple Silicon 真机验证（`M1 / macOS 15.8`）**：`.dmg` 安装与 `xattr -dr com.apple.quarantine /Applications/PodDesk.app` 放行、Metal 离线转写（`Qwen3-ASR 0.6B` / `SenseVoice-Small`）、托盘、单实例、系统代理透传、`yt-dlp` 与 `Codex` SSE 问答均已实测通过。
- **离线 ASR 与本地后端核心链路**：Windows `RTX 5070 Ti`（Vulkan `-dev 1`）与强制 CPU 自动回退、YouTube/RSS/小宇宙/本地媒体 `Range 206` 导入、谷歌直连翻译、Cookie 存取安全边界与跨重启持久化均已完成接口与浏览器实机回归。

# 当前阻塞

- 无。

# 待验证事项

- Windows / macOS `v0.2.0` 真机实操：应用内 YouTube WebView 登录注入临时 Cookie 绕过 `yt-dlp` 风控、直链取消、超 12 集播单翻页（如 Dwarkesh）、3 档单集标题切换与更新弹窗检查；
- 窄屏（`720×560`）与无字幕单集 `NoTranscriptCard` 实景点击、macOS 托盘右键菜单点击（先前受自动化录屏权限限制）；
- `Qwen3-ASR 1.7B` 长音频（>30 分钟）切句密度，以及付费云端 ASR / 其他 CLI Agent（`Gemini CLI`、`Claude Code` 等）端到端实测。

# 已知技术债

- [package-lock.json](../package-lock.json) 内保留 `registry.npmmirror.com` 解析地址以适配国内无代理环境（GitHub Actions 海外三路实测直连通过；若未来遇限流或面向广泛海外协作时再以官方源重生成）。
- [db.rs](../server/src/db.rs) 中预留给二期统计/展示的 `show_notes`、`set_audio_url`、`log_listen`、`listens_since` 暂标 `#[allow(dead_code)]`。
- 长播客批量翻译仍绑定浏览器页签生命周期（关闭窗口会中断当前批量翻译），留作二期按需下沉 Rust 后台队列的演进边界。

# 下一步

收集双端内测反馈，修复实测问题并迭代体验；下一次发版前统一用 `npm run version:sync` 升版并同步更新 [CHANGELOG.md](../CHANGELOG.md)。

# 最近完成

- **2026-11-25（AI 链路调优、谷歌翻译剥离、SSE 闭环与本地 CLI 隔离）**：移除谷歌翻译与划词翻译入口，上线 Guide 页同意后一键联动字幕精译、`thinking` 思考计时与系统提示词前缀缓存；修复 `/api/llm/chat` 后台断连通道克隆导致 SSE 流无法结束的死锁（改用 `CancelOnDropStream`）；收口移除 `Qwen Code`（保留 `Qwen3-ASR`），为 `OpenCode` / `Codex` / `Antigravity` 注入进程级只读无工具隔离，补充 ACP `spare` 预建会话、`tool_call` 立即拦截、Windows 进程树回收、`90s` 排队上限与最近调用追踪日志（`/api/llm/metrics`），并增加前端词表提取 `28s` 超时跳过兜底与冷启动标题翻译修复。
- **2026-11-25（开源门面与文档结构收口）**：新增根目录 [README.md](../README.md)、[CHANGELOG.md](../CHANGELOG.md) 与 `.github/ISSUE_TEMPLATE/` 内测反馈模板；将 `PROJECT.md`、`PROGRESS.md`、`ARCHITECTURE.md` 收归 `docs/`，修复 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) 本地死链并更新 [AGENTS.md](../AGENTS.md) 导航与 [.gitignore](../.gitignore)。
- **2026-11-24（`v0.2.0` 发布与官网升级）**：落地应用内 YouTube WebView 登录兜底（[ytlogin.rs](../desktop/src/ytlogin.rs)、[ytdlp.rs](../server/src/asr/ytdlp.rs)）、完整播单翻页（[youtube.rs](../server/src/youtube.rs)）、导读骨架防闪烁（[GuidePanel.tsx](../src/components/chat/GuidePanel.tsx)）、3 档单集标题与 [UpdateModal.tsx](../src/components/UpdateModal.tsx)；发布双端 `v0.2.0` Pre-release 并完成官网第 5 屏与品牌 Logo 统一。
- **2026-11-24（跨平台治理与双端 CI/CD）**：落地 [ci.yml](../.github/workflows/ci.yml)、[release.yml](../.github/workflows/release.yml)、[OPERATIONS.md](OPERATIONS.md)、[sync-version.mjs](../scripts/sync-version.mjs) 与 [run-tauri.mjs](../scripts/run-tauri.mjs)，并完成 macOS Apple Silicon 真机适配与 Metal 转写验证。
- **2026-11-23（模块化、性能治理与 8 套主题体系）**：拆分前后端核心路由与组件，接入长字幕虚拟滚动、`git` 镜像回退、Vitest 单测与 OKLCH 对比度门禁，沉淀 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)。
- **2026-11-21–23（基线 MVP、三档离线 ASR 与 Tauri v2 桌面化）**：完成多源解析、`CrispASR v0.8.55` 硬件探测与回退、7 种本机 CLI Agent 问答及 Windows NSIS 独立打包。
