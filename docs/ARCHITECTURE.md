# podcast-desk 架构

## 路线选择与证据

- 当前首选及状态（待验证／已验证）：**脱壳复用上游 SubCast 的 Rust 本地 HTTP/SSE 后端（稳态执行层） + React/TypeScript 浏览器工作台（智能与高迭代层）**（状态：**船长已确认方向，待实施与实测验证**）。
- 主要备选及不采用原因：
  - **浏览器扩展（SidePanel）**：缺乏独立工作台产品感，难以自然承载纯音频 RSS 播客与本机离线音频转写。
  - **全 Node.js/TypeScript 重写后端**：早期迭代轻，但面向更广泛普通用户推广时受限于本机 Node/`ffmpeg` 环境配置，且需重造上游已踩完坑的 RSS/InnerTube/音频解码与代理底座。
  - **中心化云端 Web SaaS**：2核2G 国内机无法连 YouTube 且扛不住流媒体与转写并发，还会立即背上服务器运维与 AGPL 在线分发开源压力。
  - **直接沿用 Tauri 重打包桌面客户端**：首版即需面对 macOS `$99/年` 公证与 Windows SmartScreen 拦截；脱壳后保留同一套 Rust 底座，未来需要大众安装包时可低成本套回桌面壳。
- 关键依据与来源：
  - 核自上游 `D:\project\subcast` 源码：`src/lib/api.ts` 将全部前后端通信收口于单一 `api` 适配层；`src/lib/ai.ts` 已在 TypeScript 前端承载术语表抽取、分批翻译、润色与问答拼装；`src-tauri/src/` 中的 `net.rs`、`feeds.rs`、`youtube.rs`、`asr.rs`（`symphonia` + 外调 `CrispASR`）、`agents.rs`、`db.rs`、`translate.rs` 与桌面窗口弱耦合；
  - 核自上游 `v0.3.2` 增量筛查：`feeds.rs` 修复了小宇宙搜索订阅，`subexport.ts` 验证了整段导出与文件名清洗，`ytlogin.rs` 揭示了脱壳后无内置 WebView 存储 YouTube Cookie 的风控边界。
- 决定性未知与验证方式：
  1. **剥离 `tauri` 与 `whisper-rs` 后的 Windows 原生编译验证**：通过最小 Rust 后端工程执行 `cargo check` / `cargo build`，确认无 `CMake`/`LLVM` 时编译通过。
  2. **HTTP + SSE 替换 Tauri IPC 的流式稳定性**：通过第一条端到端切片验证 LLM/CLI Agent 流式回复、音频播放与 YouTube IFrame 在 `http://localhost:<port>` 下的 Origin 与长连接表现。
  3. **脱壳后的 YouTube 人机验证退路**：实测按需导入 Netscape `cookies.txt` 传给 `yt-dlp` 时的可用性。

## 当前技术基线

> 当前已完成首版 MVP（阶段 1–4）、Tauri v2 Windows 独立桌面客户端收口、**第一关架构及稳定性治理**与**第二关 UI 质感重塑与 8 套主题/微动效体系**：已完成前后端核心巨石文件按域模块化拆分（`server/src/routes/` 6 子模块、`src/styles/` 11 模块、`src/components/{chat,player,settings}/`）、SQLite/渲染虚拟化性能调优、GitHub 镜像回退与退出保护、前端 Vitest 单测护栏，以及三轴解耦的 4 浅 + 4 纯中性深主题系统、OKLCH 对比度引擎与声学编辑台微工艺/微动效（契约见 `docs/DESIGN_SYSTEM.md`）；**未纳入首版的共享飞轮、深度知识整理多模板与 Obsidian 直写仍未引入**。

- **本地后端（已实现并编译/单测通过）**：Rust（Edition 2024，`server/`），`axum 0.8`（REST + Multipart 512 MB 上传 + SSE；路由按业务域拆分为 `server/src/routes/{mod,settings,shows,episodes,ai,asr}.rs`）+ `tower-http` 静态资源与 Range 媒体流托管，内嵌 `rusqlite`（SQLite WAL 7 表 + 内存临时表/16 MB 页缓存/64 MB mmap PRAGMA 与 `(show_id, progress)` 索引）、`reqwest`（rustls + 系统/手动代理 + GitHub 官方源自动/自定义镜像回退）、`update`（GitHub Releases 版本检查 + 30 分钟缓存与国内镜像回退）、`symphonia 0.5`（纯 Rust 音频解码）、`llm` 快速模式（`quick` 关思考与不兼容参数自动降级重试）、外部子进程调度（GitHub 官方/镜像源 `yt-dlp` 含流地址失效刷新、`YtLoginBridge` 桌面会话临时 Cookie 注入与可选 `youtube-cookies.txt`、`CrispASR` / `Qwen3-ASR 0.6B` / `1.7B` / `SenseVoice`、5 种本机 CLI Agent）及活跃任务追踪与优雅退出控制。零 `tauri` 与 `whisper-rs` 依赖。
- **桌面薄壳（已实现并打包通过）**：`desktop/`（`Tauri v2`），无黑框单实例运行、最小窗口放宽至 `720×560`、支持多显示器可视范围校验的 `window-state.json` 位置/尺寸持久化、托盘运行期保护（有活跃后台转写/下载任务时退出触发应用内确认或二次点击强制退出）、VC++ 运行库随包分发与中文 NSIS 安装包。
- **前端工作台（已实现、模块化并加入单测与对比度护栏）**：React 19 + TypeScript + Vite 6 + Zustand（`src/`）；样式拆分为 `src/styles/` 下 11 个按域模块（`index.css` 统一引入）与 [src/themes.css](../src/themes.css)，核心交互组件拆分为 `src/components/{chat,player,settings}/`；消除高频 `s.time` 播放进度导致的整树重渲染，`TranscriptPanel` 对 ≥160 段长文稿启用零依赖动态行高虚拟滚动（`src/lib/virtualList.ts`），列表页接入滚动位置恢复（`src/lib/cache.ts`），网络错误 Toast 支持一键直达网络设置；内置 4 浅 + 4 纯中性深三轴解耦主题、`src/lib/themeEngine.ts` OKLCH 对比度引擎与纯 CSS 零依赖微动效（契约见 `docs/DESIGN_SYSTEM.md`，`src/dev/` 热切实验室仅 `import.meta.env.DEV && ?lab=1` 懒加载，不进入生产打包）；核心纯逻辑与主题对比度门禁由 Vitest 单元测试覆盖（`src/lib/__tests__/`）。
- **数据存储（已实现并验证跨重启持久化）**：`<data_dir>/podcast-desk.sqlite`（WAL 模式 7 张核心表：`shows`、`episodes`、`transcripts`、`blobs`、`settings`、`tr_cache`、`listens`），`<data_dir>/window-state.json`（桌面窗口状态），`<data_dir>/media/`（本地音视频导入文件），`<data_dir>/youtube-cookies.txt`（可选按需 Cookie），`<data_dir>/streams.json`（YouTube 直链过期缓存），`<data_dir>/bin/` 与 `<data_dir>/models/`（按需下载外部工具与 `Qwen3-ASR`）。

## 系统边界与数据流

```text
[用户本机浏览器 http://localhost:<port>]
  React 19 + TS 前端工作台
  (播放器 / 双语字幕 / 术语翻译与问答编排 / 基础导出)
        │  HTTP JSON + SSE 流式事件（替代 Tauri invoke/listen）
        ▼
[本机 Rust 轻量后端进程（podcast-desk-server）]
  ├── 静态资源托管（同源 localhost，避免 YouTube 拒播与 CORS）
  ├── 抓源与网络层（net 代理 / feeds / youtube / 可选 cookies.txt）
  ├── 转写与媒体层（symphonia 解码 / 外调 Qwen3-ASR / 云端 ASR）
  ├── AI 透传与 Agent 层（llm 流式代理 / agents 5 种本机 CLI）
  └── 存储层（本地 SQLite 7 表 + 本地媒体/模型缓存）
        │
        ├──► 外部音视频/字幕源（走用户本机代理）
        ├──► 国内直连 LLM / 云端 ASR API / 本机已登录 CLI Agent
        └──► [预留扩展口] 共享字幕飞轮 API（首版不启用、不部署）
```

**第一条端到端最小垂直切片（验证底座）**：
启动本地 Rust HTTP 服务 → 浏览器打开 `http://localhost:<port>` → 用户粘贴一条 YouTube/播客单集链接 → 后端抓取元数据与官方字幕入本地 SQLite → 前端展示字幕并调用本机 CLI Agent 或直连大模型流式返回带 `[mm:ss]` 的回答，点击时间戳可跳转播放进度。

## 模块职责

- **Rust 稳态执行层（低频改动）**
  - `server / routes`：托管编译后的前端静态文件，路由按域拆分为 `server/src/routes/{mod,settings,shows,episodes,ai,asr}.rs`，提供毒锁容错（`db_lock`）、活跃后台任务计数与优雅退出管控，并自动顺延探测可用 `localhost` 端口。
  - `net`：自动读取系统代理（Windows 注册表 / macOS `scutil` / 环境变量）及手动配置并透传 `HTTPS_PROXY`；提供 GitHub 下载链接镜像回退序列（支持 `githubMirror` 自定义镜像前缀，默认直连失败后自动切换 `ghfast.top` / `gh-proxy.com`）。
  - `feeds / youtube`：统一解析 YouTube 频道（`UULF` 过滤 Shorts）/单集、Apple Podcasts、小宇宙与通用 RSS，以及本地音视频与纯文本/`.srt`/`.vtt` 字幕导入；抓取 YouTube InnerTube 字幕与 `<podcast:transcript>`；支持按需读取本地配置的 `cookies.txt` 传给 `yt-dlp`。
  - `asr / cloud / transcript`：纯 Rust `symphonia` 解码、`asr_context` 热词清洗、外调 `CrispASR`（`Qwen3-ASR` / `SenseVoice`）离线转写（支持多候选镜像下载重试与失效直链清除重写）、云端 ASR 代理、碎句合并与幻觉过滤（不含 `whisper-rs`）。
  - `llm / agents / translate`：OpenAI/Anthropic 兼容流式代理（支持 `quick` 模式按厂商自动关闭多余思考与 400/422 降级重试）；本机 CLI Agent 探测、会话验证、子模型读取与长连接保活；直连谷歌免费翻译（已剔除 `elon.qiaomu.ai` 中转）。
  - `db`：本地 SQLite 7 表持久化（`shows`、`episodes`、`transcripts`、`tr_cache`、`listens`、`settings`、`blobs`），启用 WAL、16 MB 页缓存与 `(show_id, progress)` 查询索引。
- **TypeScript 前端与智能层（高频迭代）**
  - `api` 适配层：封装 HTTP/SSE 调用，向上层组件保持与上游 `src/lib/api.ts` 高度兼容的数据模型与调用语义。
  - `ai / virtualList / cache / themes / themeEngine` 编排与基础工具层：负责术语表与摘要抽取、固定 System Prompt 分批翻译与 `salvage` 补问、带 `[mm:ss]` 全文上下文问答拼装、≥160 段长文稿动态虚拟窗口计算、列表滚动记忆，以及 8 套内置主题注册表、历史主题 ID 迁移与 OKLCH/WCAG 2.1 自动求参派生（契约详载 `docs/DESIGN_SYSTEM.md`）；核心纯函数由 Vitest 单测覆盖。
  - 交互与消费视图（按域拆分为 `src/styles/` 与 `src/components/{chat,player,settings}/`）：订阅/单集直开、音视频播放器（含进度条章节气泡预览与禁嵌直链回退）、双语字幕三态时间轴同步、右侧 AI 导读/在场感问答面板、基础对话复制与整段 Markdown/文本导出。

## 公共契约

> 列出首版 MVP 已落地的本机 HTTP/SSE 契约；未纳入首版的共享飞轮、深度知识整理多模板与 Obsidian 目录直写不列为现行契约。

- **本地服务边界**：仅绑定本机回环地址 `127.0.0.1`（默认 `14327`，被占时顺延 20 个端口），CORS 仅放行 `127.0.0.1` / `localhost` 来源，不暴露到局域网。
- **REST JSON & 媒体接口**：
  - 基础、设置与应用控制：`GET /api/health`（含 `githubMirror`、`activeJobs`）、`GET/POST /api/settings`（含 `proxy`、`githubMirror` 等）、`GET /api/network/check`（检测代理/YouTube/流节点/`yt-dlp` 与桌面 WebView 代理通路）、`GET /api/jobs/active`、`POST /api/app/quit`、`GET/POST /api/keys/{provider}`（只返回 `{ hasKey }`）、`GET/POST /api/cookies`（只返回 `{ hasCookies }`）。
  - 检索与订阅：`GET /api/search`、`GET /api/shows`、`DELETE /api/shows/{id}`、`POST /api/shows/{id}/refresh`、`POST /api/subscriptions`。
  - 单集与媒体：`GET /api/episodes`、`GET /api/episodes/recent`、`GET /api/episodes/{id}`、`DELETE /api/episodes/{id}`、`POST /api/episodes/{id}/progress`、`GET /api/episodes/{id}/stream-url`、`POST /api/episodes/import-text`、`POST /api/episodes/import-media`（multipart 最高 512 MB）、`GET /api/media/{file}`（支持 HTTP `206` 拖动）。
  - 字幕/翻译/Agent：`GET /api/episodes/{id}/transcript`、`POST /api/episodes/{id}/transcript/official`、`GET/POST /api/episodes/{id}/blobs/{kind}`、`POST /api/translate/google`、`GET /api/asr/models`、`POST /api/asr/probe`、`GET /api/agents`、`POST /api/agents/warm`、`POST /api/agents/probe`、`POST /api/agents/models`。
  - 版本与 YouTube 登录：`GET /api/app/update`、`GET /api/youtube/auth`、`POST /api/youtube/auth/login`、`POST /api/youtube/auth/logout`（桌面壳通过 `desktop/src/ytlogin.rs` 实现 `YtLoginBridge` WebView 登录态，仅运行 `yt-dlp` 时生成并立即清理临时 Netscape Cookie 文件）。
- **SSE 流式接口与取消**：`POST /api/llm/chat`、`POST /api/asr/models/download`、`POST /api/episodes/{id}/transcribe` 均推送 JSON `data:` 事件（`delta`/`progress`/`done`/`error`），并统一配合 `POST /api/jobs/{id}/cancel` 取消后台任务。
- **本地凭据边界**：API Key 存入操作系统钥匙串（服务名 `podcast-desk`），可选 `cookies.txt` 仅写本机 `<data_dir>/youtube-cookies.txt`；接口层绝不回传明文凭证。

## 有效技术决策

| 决策 | 原因 | 影响 | 确认与验证状态 |
|---|---|---|---|
| 采用「本地 Rust HTTP 服务 + 浏览器 UI」脱壳形态 | 兼顾独立工作台产品感、零服务器成本、零前置环境稳定性及未来套回桌面壳的扩展性 | 前后端通过 `/api/*` REST 与 SSE 通信，同源托管前端产物 | **船长确认；HTTP/SSE 通信与跨重启持久化已实测，图形浏览器人工点击待试玩** |
| 首版剥离内置 `whisper-rs`，保留外调 `Qwen3-ASR` + 云端 ASR | 解除 Windows 本机 `CMake`/`LLVM` 编译门槛并减轻产物体积；聚焦中英文场景够用 | 首版不支持内置跑 `ggml-*.bin` Whisper 模型，可随时可逆加回 | **无 `CMake`/`LLVM` 下 Rust 编译及 `symphonia`/WAV 解码单测已实测通过；960 MB 真机转写待试玩** |
| 保留 `translate.rs` 谷歌直连翻译，删除 `elon.qiaomu.ai` 中转 | 不到百行代码即可为新用户提供零 Key 冷启动粗翻，同时彻底断绝原作者私有服务器依赖 | 需经用户可用代理或网络直连 Google；不可达时切换大模型精译 | **船长确认；已实测 `POST /api/translate/google` 走本机代理返回 HTTP 200 中文译文** |
| YouTube 人机验证双通道退路（桌面 WebView 登录 + 按需 `cookies.txt`） | 纯 Web 无独立 WebView，而桌面端具备原生 WebView 可存 YouTube 登录态且 Windows Chrome 127+ DPAPI 限制直接读浏览器 Cookie | 桌面壳通过 `YtLoginBridge` (`desktop/src/ytlogin.rs`) 弹出应用内 YouTube 登录窗口，运行时将 Cookie 写入临时文件传给 `yt-dlp` 用完即删；网页版与手动兜底保留 `cookies.txt` | **待构建与双端实测验证** |
| 共享字幕飞轮留接口暂不上线、零海外服务器 | 冷启动期单集重叠率低，首版专注单机闭环；未来推广期可用国内 2核2G 服务器托管纯文本共享库 | 首版跳过服务端部署与运维，不引入跨机状态复杂度 | **船长已确认方向，暂缓实施** |
| 首版聚焦高效嵌入 AI Agent，暂缓重度知识整理与 HackerTube 细节 | 防止首版范围膨胀，先把核心取稿、双语与在场感问答打牢 | 深度多视角 Markdown 沉淀、Obsidian 直写及快捷键增强留作核心工作台跑通后的迭代项 | **船长已确认方向，延后至二期** |
| 信源增补纯文本/`.srt`/`.vtt`与本地音视频导入；前端预设精简为核心厂商 | 零反爬成本覆盖 B 站/课程等平台外内容；避免维护近 30 家冷门厂商硬编码模型名 | 底层 OpenAI/Anthropic/CLI 协议保持 100% 兼容，界面与维护更清爽 | **已实测 `.srt` / 纯文本 / `.wav` 上传与 `Range 206` 播放持久化** |
| 阶段 4 离线 ASR 采用统一 CrispASR v0.8.55 + 按硬件分层的三档本地模型（砍掉 Whisper 档） | 面向大众分发（Mac Apple Silicon/Intel + Windows 核显/独显）兼顾速度、中英混说与术语上下文：纯 CPU 轻薄本/Intel Mac 默认 `SenseVoice-Small`（`Q8_0`, 240 MB, FunASR v1.1 仅运行时在线下载+署名）；M 芯片 Mac / GPU Windows 默认 `Qwen3-ASR 0.6B`（普通 `Q4_K`, 602 MB, Apache-2.0, 2026-07 重烤锁 Q8_0 编码器, 禁用 `imatrix`）；高配独显/16 GB+ Mac 可选 `Qwen3-ASR 1.7B`（`Q5_K`, 1.66 GB, Apache-2.0）。Qwen3 已覆 30 语种 + 22 方言，无需自带 Whisper | Rust 侧已将 `asr.rs` 拆分为 `asr/{catalog,hardware,engine,media,ytdlp,mod}.rs` 并抽 `AsrEngine` 边界隔离 `CrispASR v0.8.55`；Windows 经硬件探测 + 独显选卡（`-dev`）+ 短样音试跑 + 自动回退 `cpu`（9.3 MB）/ `cpu-legacy`（8.7 MB）（N 卡可选 CUDA 13）；统一启用 Silero VAD（864 KB）停顿切句，不强绑 500 MB ForcedAligner；Windows ARM64 首版走云端兜底 | **已实施并真机验证（2026-11-23）：`RTX 5070 Ti` 自动锁定 `-dev 1` Vulkan、双模型真机转写与强制 CPU 回退均实测通过** |
| 第二关 UI 采用「4 浅 + 4 纯中性深」三轴解耦主题、零依赖 OKLCH 引擎与纯 CSS 微动效 | 兼顾白天长文纸感精读与夜间零眩光/零偏色工作台体验；不引入重型 UI/动画库以保持桌面端轻量与渲染性能 | 26 语义 Token 收口全站表面层；`themeEngine.ts` + Vitest 锁死 WCAG 对比度门禁；`docs/DESIGN_SYSTEM.md` 作为视觉与动效契约权威源；`src/dev/` 实验室严格 `DEV` 门控隔离，不泄漏生产包 | **已实施、船长热切预览定版并通过自动化构建与对比度测试（2026-11-23）** |

## 待验证假设

- 图形浏览器原生打开 `http://127.0.0.1:14327` 后，YouTube IFrame 播放、禁嵌时 `yt-dlp` 直链 `<video>` 回退及 `[mm:ss]` 点击跳转播放的真机体验（待船长试玩实测）。
- 真实下载 ~960 MB `Qwen3-ASR 0.6B` 与 `CrispASR` 后在 Windows 离线转写长音视频的速度与准确率（待试玩实测）。
- 除已实测的 `Codex` 外，其余 CLI Agent（`Claude Code`/`Gemini CLI` 等）及需配 Key 云端大模型/云端 ASR 在真实使用中的端到端表现（待试玩实测）。

## 架构现状评估与演进边界

基于当前 `033a8f2` 代码基线（25,307 行，前端 69.8% / 后端 30.2%）的结构复盘结论：现有「本地 Rust 稳态后端 + 浏览器工作台 + 重型外部工具子进程隔离 + SQLite/系统钥匙串本地存储」底座足以支撑阶段 4（多档离线 ASR）与二期知识沉淀，**无需更换框架或推倒重构**，但存在以下 4 项已知结构边界与治理约束：

| 结构短板 / 边界 | 现状依据 | 影响与治理原则 |
|---|---|---|
| **核心单文件巨石化** | 原 `styles.css`、`server/src/routes.rs`、`ChatPanel.tsx`、`Players.tsx`、`SettingsModal.tsx` 已在第一关分别拆分为 `src/styles/`（11 模块）、`server/src/routes/`（6 模块）及 `src/components/{chat,player,settings}/` | **已治理收口（2026-11-23）**；后续新功能继续按职责域落位，避免单文件再次膨胀 |
| **长耗时 AI 任务绑定浏览器页签** | 术语抽取、分批字幕精译与流式问答状态完全由前端维护 | 刷新或关闭浏览器页签会中断长播客批量翻译；首版接受此边界，待长播客后台续跑成为刚需时再下沉至 Rust 任务队列 |
| **前后端测试覆盖失衡** | 后端 Rust 现有 53 项通过单元测试（含 1 项系统代理忽略测试）；前端已引入 Vitest 并为核心纯逻辑（`ai`/`subexport`/`format`/`virtualList`）与 8 套内置主题 WCAG 2.1 对比度/OKLCH 引擎建立 5 组共 22 条单测 | **已建立前端护栏（2026-11-23）**；后续新增纯逻辑模块同步补充 `src/lib/__tests__/*.test.ts` |
| **进程形态缺桌面级收口** | 已落地 `desktop/`（`Tauri v2` 薄桌面壳 + `podcast_desk_core` 共享后端库 + `rust-embed` 内嵌前端）：具备单实例防多开、系统托盘（含后台活跃任务退出二次保护）、窗口状态持久化（最小 `720×560`）、VC++ 运行库随包分发与 NSIS 安装包（暂未购买商业代码签名与启用 OTA 热更新），并已完成第二关 UI 质感与 8 套主题整合打包 | **已收口（2026-11-23）**；暂不引入商业签名费用 |
| **外部 AI 助手反向接入（MCP）** | 目前仅支持工作台单向调用本机 CLI Agent；`podcast_desk_core` 已独立成库且含完整 SQLite 与 AI 能力，具备零重复实现抽为无头 MCP Server 的基础 | **延后至二期**：待知识沉淀/Obsidian 联动展开时按需新增本地 MCP 入口，暂不引入独立 CLI 安装器 |
