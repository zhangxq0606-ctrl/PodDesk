---
lifecycle: bootstrap
foundation: pending
active_goal: null
work_status: active
last_verified: 2026-11-27
---

# 当前里程碑

`v0.3.0` 已公开为 GitHub Pre-release（`2026-11-26 15:08 UTC`），含 `PodDesk_0.3.0_x64-setup.exe`（6,590,844 B）、`PodDesk_0.3.0_aarch64.dmg`（8,912,499 B）与 `SHA256SUMS.txt`，待双端真机抽检；标签指向 `de8f7cf`，`main` 上两条后续小修（`f4fe7d4`、`21c056f`）将在下一次构建带入；对外变更见 [CHANGELOG.md](../CHANGELOG.md)。上一版 `v0.2.4` 已完成双端真机验收。

# 已验证能力

- **`v0.2.4` 发布与双端真机验收（`2026-11-26` 实测）**：
  - 本地校验：`npm run version:check -- --tag v0.2.4`、`npm run typecheck`、`npm run test`（Vitest 9 文件 41 用例）、`npm run build`（Vite 6，`LAB_HITS=0`）、`cargo test --manifest-path server/Cargo.toml`（68 passed, 1 ignored）与 `cargo test --manifest-path desktop/Cargo.toml`（2 passed）全部通过；
  - 线上与双端真机验收：GitHub Release `v0.2.4` 双端安装包（`.exe` / `.dmg`）抽检启动、官网直链、限流场景 `releases.atom` 更新回退与报错透传，以及 `v0.2.3` 合入的音量曲线、`0.5×–3×` 倍速、视频 `F` 键全屏与画内字幕、频道排序、音频字幕轻量对齐、`agy` 兼容、桌面统一代理/登录窗防死锁与设置页 5 分页重构均已通过船长真机验收。
- **`v0.2.0` 全栈校验与云端双端出包（`2026-11-24` 实测）**：
  - 本地校验：`npm run version:check -- --tag v0.2.0`、`npm run typecheck`、`npm run test`（Vitest 7 文件 29 用例）、`npm run build`（Vite 6）、`cargo test --manifest-path server/Cargo.toml`（58 passed, 1 ignored）、`cargo test --manifest-path desktop/Cargo.toml`（1 passed）与 Windows `npm run tauri:build`（`6.09 MiB`）均通过；
  - 云端流水线：GitHub Actions 三路 CI（`web` / `windows-latest` / `macos-26`）与 `release.yml` 双端打包、`SHA256SUMS.txt` 及 Release 直链 302 跳转均已验证。
- **macOS Apple Silicon 真机验证（`M1 / macOS 15.8`）**：`.dmg` 安装与 `xattr -dr com.apple.quarantine /Applications/PodDesk.app` 放行、Metal 离线转写（`Qwen3-ASR 0.6B` / `SenseVoice-Small`）、托盘、单实例、系统代理透传、`yt-dlp` 与 `Codex` SSE 问答均已实测通过。
- **离线 ASR 与本地后端核心链路**：Windows `RTX 5070 Ti`（Vulkan `-dev 1`）与强制 CPU 自动回退、YouTube/RSS/小宇宙/本地媒体 `Range 206` 导入、Cookie 存取安全边界与跨重启持久化均已完成接口与浏览器实机回归。

# 当前阻塞

- 无。

# 待验证事项

- B站桌面端内置小窗扫码登录后实拉官方/AI 字幕、高画质流切换，以及 Mac 端实机播放拖拽与代理规则联调；
- 在线音视频直链、`b23.tv` 手机分享短链及多P分集前端实机点击复核；
- 窄屏（`720×560`）与无字幕单集 `NoTranscriptCard` 实景点击、macOS 托盘右键菜单点击（先前受自动化录屏权限限制）；
- 超 12 集播单翻页（如 Dwarkesh）与直链中途取消的边界复核；
- `Qwen3-ASR 1.7B` 长音频（>30 分钟）切句密度，以及付费云端 ASR 与除 `Codex` / `agy` 外其他本机 CLI Agent（`Claude Code`、`Kimi Code`、`OpenCode`）端到端实测。

# 已知技术债

- [package-lock.json](../package-lock.json) 内保留 `registry.npmmirror.com` 解析地址以适配国内无代理环境（GitHub Actions 海外三路实测直连通过；若未来遇限流或面向广泛海外协作时再以官方源重生成）。
- [db.rs](../server/src/db.rs) 中预留给二期统计/展示的 `show_notes`、`set_audio_url`、`log_listen`、`listens_since` 暂标 `#[allow(dead_code)]`。
- 长播客批量翻译仍绑定浏览器页签生命周期（关闭窗口会中断当前批量翻译），留作二期按需下沉 Rust 后台队列的演进边界。

# 下一步

已收口二期非必要极客增强项，下一步在「AI 知识沉淀与 Markdown / Obsidian 导出」与「轻量本地 MCP Server」之间明确优先级并展开方案设计；下一次发版前继续统一用 `npm run version:sync` 升版并同步 [CHANGELOG.md](../CHANGELOG.md)。

# 最近完成

- **2026-11-26（`v0.3.0` 合入、统一升版与双端出包）**：`feat/bilibili` 经 PR #4 压缩合入 `main`（`b0ccfc3`）后统一升版至 `0.3.0`，补齐 [CHANGELOG.md](../CHANGELOG.md) 与设置页版本回退、官网静态下载链接及安装包体积说明；本地 `npm run version:check -- --tag v0.3.0`、`npm run typecheck`、`npm run test`（Vitest 10 文件 43 用例）、`npm run build`、`cargo test --manifest-path server/Cargo.toml`（76 passed, 1 ignored）与 `cargo test --manifest-path desktop/Cargo.toml`（2 passed）全部通过；`v0.3.0` 标签触发 `release.yml` 三端并行打包成功，已公开为 Pre-release（`.exe` 6.29 MB / `.dmg` 8.5 MB），待双端真机抽检。
- **2026-11-26（`feat/bilibili` 分支：B站单集与扫码取稿、音视频直链及 Spotify 查源）**：
  - 后端多源与流代理：新增 [bilibili.rs](../server/src/bilibili.rs) 支持长链/`b23.tv` 短链/`?p=N` 分集解析、直连优先代理兜底策略、WBI 签名拉取官方及 B站 AI 字幕、按 `upos-*` 官方节点优先排序 CDN、音频流下载走现有 ASR 与本地 Range 防盗链流代理（`/api/episodes/{id}/bili-stream`，[episodes.rs](../server/src/routes/episodes.rs)）；在 [transcript.rs](../server/src/transcript.rs) 为无标点中文长句补充按字数节奏切分；同步在 [feeds.rs](../server/src/feeds.rs) 与 [shows.rs](../server/src/routes/shows.rs) 接入在线音视频直链单集与 Spotify 播客反查公开 RSS。
  - 桌面扫码与播放器打磨：泛化 [ytlogin.rs](../desktop/src/ytlogin.rs) 与 [settings.rs](../server/src/routes/settings.rs) 增加 B站内置扫码登录窗及自动同步（[NetworkSettingsSection.tsx](../src/components/settings/NetworkSettingsSection.tsx)、[TranscriptPanel.tsx](../src/components/TranscriptPanel.tsx)）；新增 [videoSource.ts](../src/lib/videoSource.ts) 拆分 YouTube 与 B站播放器、封面无 Referer 防拦截、未登录简洁引导、全屏字幕缩放与单轨主字号，并将非全屏视频播控条与「内容精炼」融为一体卡片（[VideoStage.tsx](../src/components/player/VideoStage.tsx)、[MediaStage.tsx](../src/components/player/MediaStage.tsx)、[PlayerPanel.tsx](../src/components/PlayerPanel.tsx)、[Lists.tsx](../src/components/Lists.tsx)、[player.css](../src/styles/player.css)），同步更新 [PROJECT.md](PROJECT.md) 未来清单。
  - 校验与接口实测：`npm run typecheck`、`npm run test`（Vitest 10 文件 43 用例）、`npm run build`、`cargo test --manifest-path server/Cargo.toml`（76 passed, 1 ignored）、`cargo test --manifest-path desktop/Cargo.toml`（2 passed）与 `npm run version:check` 全部通过，本地真实 HTTP 冒烟实测 B站视频入库与 `/bili-stream` 返回 `206 Partial Content` 正常、Spotify 公开节目反查入库 300 集。
- **2026-11-26（`v0.2.4` 真机验收收口与文档事实同步）**：确认 `v0.2.4` GitHub Release 公开、官网直链及双端真机验收通过，并同步更新 [PROJECT.md](PROJECT.md)、[ARCHITECTURE.md](ARCHITECTURE.md) 与本文件，清理已剥离的谷歌翻译残留说明、对齐 HTTP 接口与单测基线、裁剪已否决的极客增强项。
- **2026-11-26（`v0.2.4` 检查更新限流回退热修）**：为 [update.rs](../server/src/update.rs) 增加 `releases.atom`（含镜像回退）备用通道以绕开 GitHub API 匿名 `403/429` 限流，并在 [store.ts](../src/store.ts)、[SettingsModal.tsx](../src/components/SettingsModal.tsx)、[ReadingSettingsSection.tsx](../src/components/settings/ReadingSettingsSection.tsx) 与 [UpdateModal.tsx](../src/components/UpdateModal.tsx) 透传真实失败原因。
- **2026-11-26（桌面代理与登录防死锁、网络诊断、`agy` 兼容及播放器/字幕交互打磨）**：
  - 稳定性与兼容性：为桌面端主窗口与 YouTube 登录窗注入统一 WebView 代理（`macos-proxy` / WebView2 `--proxy-server`），将 Windows 登录窗改为异步创建并去除菜单栏防死锁（[main.rs](../desktop/src/main.rs)、[ytlogin.rs](../desktop/src/ytlogin.rs)）；新增 `GET /api/network/check` 与「设置 › 网络与风控」一键网络诊断及脱敏报告复制，并在视频报错卡增加直达入口（[net.rs](../server/src/net.rs)、[NetworkSettingsSection.tsx](../src/components/settings/NetworkSettingsSection.tsx)）；升级 `agy` 动态 `--help` 探参、模型切换回读校验与末尾异常回复识别（[agents.rs](../server/src/agents.rs)）。
  - 体验打磨：落地三次方人耳感知音量曲线（[playerUtils.ts](../src/components/player/playerUtils.ts)）、`0.5×–3×` 倍速弹出列表（YouTube 嵌入限 `2×`，[Controls.tsx](../src/components/player/Controls.tsx)）、包裹 `.stage-video-wrap` 保留画内双语字幕与控制栏的视频真全屏（`F` 键，[PlayerPanel.tsx](../src/components/PlayerPanel.tsx)、[VideoStage.tsx](../src/components/player/VideoStage.tsx)）、`yt-dlp` 与 InnerTube 缺失视频时长自动回填（[ytdlp.rs](../server/src/asr/ytdlp.rs)、[episodes.rs](../server/src/routes/episodes.rs)）、频道单集「最新 / 最早」排序切换（[Lists.tsx](../src/components/Lists.tsx)）、音频字幕菜单轻量时间对齐（`±1s` 与点句对齐，[subAlign.ts](../src/lib/subAlign.ts)、[TranscriptPanel.tsx](../src/components/TranscriptPanel.tsx)），以及全设置页 5 分页统一视觉重构与 `tauri:dev` 监听修复。
  - 文档规划：在 [PROJECT.md](PROJECT.md) 与 [ARCHITECTURE.md](ARCHITECTURE.md) 二期边界补充轻量本地 MCP Server 规划。
  - 回归验证：`npm run typecheck`、`npm run test`（9 文件 41 用例）、`npm run build`（`LAB_HITS=0`）、`npm run version:check`、`cargo test --manifest-path server/Cargo.toml`（67 passed, 1 ignored）与 `cargo test --manifest-path desktop/Cargo.toml`（2 passed）全部通过。
- **2026-11-25（AI 链路调优、谷歌翻译剥离、SSE 闭环与本地 CLI 隔离）**：移除谷歌翻译与划词翻译入口，上线 Guide 页同意后一键联动字幕精译、`thinking` 思考计时与系统提示词前缀缓存；修复 `/api/llm/chat` 后台断连通道克隆导致 SSE 流无法结束的死锁（改用 `CancelOnDropStream`）；收口移除 `Qwen Code`（保留 `Qwen3-ASR`），为 `OpenCode` / `Codex` / `Antigravity` 注入进程级只读无工具隔离，补充 ACP `spare` 预建会话、`tool_call` 立即拦截、Windows 进程树回收、`90s` 排队上限与最近调用追踪日志（`/api/llm/metrics`），并增加前端词表提取 `28s` 超时跳过兜底与冷启动标题翻译修复。
- **2026-11-25（开源门面与文档结构收口）**：新增根目录 [README.md](../README.md)、[CHANGELOG.md](../CHANGELOG.md) 与 `.github/ISSUE_TEMPLATE/` 内测反馈模板；将 `PROJECT.md`、`PROGRESS.md`、`ARCHITECTURE.md` 收归 `docs/`，修复 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md) 本地死链并更新 [AGENTS.md](../AGENTS.md) 导航与 [.gitignore](../.gitignore)。
- **2026-11-24（`v0.2.0` 发布与官网升级）**：落地应用内 YouTube WebView 登录兜底（[ytlogin.rs](../desktop/src/ytlogin.rs)、[ytdlp.rs](../server/src/asr/ytdlp.rs)）、完整播单翻页（[youtube.rs](../server/src/youtube.rs)）、导读骨架防闪烁（[GuidePanel.tsx](../src/components/chat/GuidePanel.tsx)）、3 档单集标题与 [UpdateModal.tsx](../src/components/UpdateModal.tsx)；发布双端 `v0.2.0` Pre-release 并完成官网第 5 屏与品牌 Logo 统一。
- **2026-11-24（跨平台治理与双端 CI/CD）**：落地 [ci.yml](../.github/workflows/ci.yml)、[release.yml](../.github/workflows/release.yml)、[OPERATIONS.md](OPERATIONS.md)、[sync-version.mjs](../scripts/sync-version.mjs) 与 [run-tauri.mjs](../scripts/run-tauri.mjs)，并完成 macOS Apple Silicon 真机适配与 Metal 转写验证。
- **2026-11-23（模块化、性能治理与 8 套主题体系）**：拆分前后端核心路由与组件，接入长字幕虚拟滚动、`git` 镜像回退、Vitest 单测与 OKLCH 对比度门禁，沉淀 [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md)。
- **2026-11-21–23（基线 MVP、三档离线 ASR 与 Tauri v2 桌面化）**：完成多源解析、`CrispASR v0.8.55` 硬件探测与回退、7 种本机 CLI Agent 问答及 Windows NSIS 独立打包。
