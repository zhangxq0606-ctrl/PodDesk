# 更新日志

本文件记录 PodDesk 对外发布版本的用户可见变更；完整构建产物与校验码见 [GitHub Releases](https://github.com/zhangxq0606-ctrl/PodDesk/releases)。

## [Unreleased]

- 新增项目根目录 [README.md](README.md) 与内测 Issue 反馈模板（`.github/ISSUE_TEMPLATE/`）。
- 将立项、进度与架构文档收归 `docs/` 目录，统一使用相对路径链接。

## [0.2.0] - 2026-11-24（内测版）

### 新增
- **YouTube 登录与风控兜底**：桌面端「设置 › 网络与风控」新增应用内 YouTube WebView 登录（运行时注入临时 Netscape Cookie，用完即删），并完善 `cookies.txt` 上传与导出指引。
- **完整播单翻页与来源边界**：补齐 YouTube `lockupViewModel` / `continuationItemViewModel` 播单解析，支持超 12 集频道翻页加载；频道页明确标注小宇宙/RSS 拉取范围。
- **标题显示控制**：播客与频道名一律保留原名，单集标题新增「中文为主 / 原文为主 / 仅看原文」三档切换。
- **应用内更新检测**：新增 GitHub Releases 新版检测接口（30 分钟缓存 + 国内镜像地址）、侧边栏新版提示与更新弹窗。
- **双端发版流水线与官网升级**：新增 `v*.*.*` 标签触发 Windows `.exe` + macOS `.dmg` 并行打包与 `SHA256SUMS.txt` 生成；官网支持系统感知下载与 macOS 首次打开放行指令一键复制。

### 修复与改进
- 切换 YouTube 内嵌域名至 `youtube.com`，支持视频直链解析手动取消及风控报错直返。
- 流式导读在 `## 章节时间线` 到达前右侧保持三行骨架屏，避免排版闪烁。
- 统一全端方案 A 品牌图标，规范文档、弹窗、Release 与官网中的 macOS `xattr` 放行说明。

## [0.1.0] - 2026-11-23（内测版）

### 新增
- **多源内容接入**：支持 YouTube（频道订阅自动过滤 Shorts、播单与单集）、Apple Podcasts、任意 RSS/Atom、小宇宙、本地音视频（最大 512 MB），以及 `.srt` / `.vtt` / 纯文本导入。
- **本地离线转写**：集成 `CrispASR v0.8.55` 与 `Silero VAD`，提供 `SenseVoice-Small (Q8_0)`、`Qwen3-ASR 0.6B (Q4_K)`、`Qwen3-ASR 1.7B (Q5_K)` 三档本地模型及硬件探测 / GPU-CPU 自动回退，同时支持云端 ASR。
- **双语字幕与 AI 在场感问答**：支持直连谷歌免费粗翻与大模型术语表分批精译；自动探测复用本机已登录 CLI Agent 与主流大模型 API，支持 `[mm:ss]` 时间戳回跳、划词追问、导读与 Markdown 导出。
- **编辑部主题与 Tauri v2 桌面壳**：内置 4 浅 + 4 深三轴解耦主题与 OKLCH 对比度门禁；打包 Windows x64（NSIS + 内置 VC++ 运行库）与 macOS Apple Silicon（`.dmg` + Metal 加速）客户端，支持单实例运行、系统托盘后台与本地 SQLite 持久化。
