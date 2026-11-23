---
lifecycle: bootstrap
foundation: pending
active_goal: null
work_status: active
last_verified: 2026-11-23
---

# 当前里程碑

阶段 1–4、全站 8 套浅深多主题精修，以及**Tauri v2 Windows 独立桌面客户端收口**（薄桌面壳 + 内嵌前端 + 托盘/防多开 + 含 VC++ 运行库的 NSIS 安装包）均已落地并完成基础实测；当前处于**桌面窗口试玩验收与 80→90 分细节打磨阶段**（含窄屏 `<900px` 适配与二期知识沉淀导出）。

# 已验证能力

- **全量编译与静态检查**：
  - 前端：`npm run typecheck`（`tsc --noEmit`）与 `npm run build`（Vite 6 打包 `dist/`）退出 0；
  - 后端（无 `CMake`/`LLVM`、无 `whisper-rs`）：`cargo test` 零警告通过（**49 passed, 0 failed, 1 ignored**），`cargo build`（`server/`）产出独立 CLI `server/target/debug/podcast-desk.exe`；
  - 桌面端：`npm run tauri:build` 退出 0，产出 `desktop/target/release/podcast-desk-desktop.exe`（23.4 MB，内嵌前端 `dist/`）与 NSIS 安装包 `desktop/target/release/bundle/nsis/PodDesk_0.1.0_x64-setup.exe`（6.00 MiB，随包携带 4 个 VS 2022 VC++ 运行库 DLL）。
- **Tauri v2 桌面端与数据迁移实测**：
  - 已将原 `D:\project\podcast-desk\data\` 订阅库、`CrispASR v0.8.55`（`vulkan` + `cpu`）、Silero VAD 与两档离线模型无损复制至 `%LOCALAPPDATA%\podcast-desk`；
  - 实机启动 `podcast-desk-desktop.exe` 验证无黑框、`GET /` 返回 HTTP `200`（内嵌前端）、`GET /api/health` 指向 `%LOCALAPPDATA%\podcast-desk` 且完整可见既有 2 个订阅、`GET /api/asr/models` 识别 RTX 5070 Ti（`-dev 1` Vulkan）与双模型就绪；二次启动实测触发单实例锁定并立即退出（仅保留 1 个进程）。
- **阶段 4 本地离线 ASR 与硬件探测回退实测（`http://127.0.0.1:14327` + 临时隔离 `--data-dir`）**：
  - `GET /api/asr/models` 正确识别本机 `NVIDIA GeForce RTX 5070 Ti Laptop GPU`（12,227 MiB）+ `Intel(R) Graphics` 核显并过滤 `GameViewer Virtual Display Adapter` 虚拟显示卡，推荐 `vulkan` + `qwen3-0.6b`；
  - 实测通过 `POST /api/asr/models/download`（含 HTTP `Range` 断点续传重试）安装 `CrispASR v0.8.55`（`vulkan` + `cpu` 双变体）、Silero VAD（`ggml-silero-v6.2.0.bin`，864 KB）、`SenseVoice-Small (Q8_0)`（240 MB）与 `Qwen3-ASR 0.6B (Q4_K)`（602 MB，非 `imatrix`）至 `D:\project\podcast-desk\data\`，短样音试跑自动解析并锁定独显 `-dev 1`（`verified: true`）；
  - 实测以真实英文演讲音频（`jfk.wav`）端到端调用 `POST /api/episodes/{id}/transcribe`：`sensevoice-small`（7.48 秒，已清洗控制标签）与 `qwen3-0.6b`（5.76 秒）均精准产出带时间戳字幕，测试临时单集测后已删除；
  - 实测 `POST /api/asr/probe` 在 `cpu` / `vulkan` 变体间切换通过，并在独立临时 `--data-dir`（端口 `14331`）模拟 Vulkan 启动失败后，验证后端自动拉取 `CPU (AVX2)` 兜底并回写 `activeVariant: "cpu"`、`verified: true` 与回退原因（临时目录与进程已清理）；
  - 图形浏览器（1440×900）实测 `http://127.0.0.1:14327`「设置 › 字幕与转写」浅色（暖宣纸）与深色（深夜石板）主题排版、状态标签、三档模型卡片与云端配置区，0 控制台报错、50/50 请求 HTTP 200。
- **多源解析、字幕、检索与翻译接口实测（阶段 2–3 临时起服，临时目录与进程已清理）**：
  - `POST /api/subscriptions`（YouTube 视频链接）+ `POST /api/episodes/{id}/transcript/official`（InnerTube 拉回 20 段字幕）；
  - `GET /api/search?term=Lex+Fridman` 返回 7 条播客/频道结果；
  - `POST /api/episodes/import-text` 实测通过 SRT（2 段）与纯文本中文自动判定（`lang=zh`，2 段）；
  - `POST /api/episodes/import-media` 上传合成 `.wav` 并实测 `GET /api/media/...` 返回 `HTTP 200` 与 `Range: bytes=0-15` `HTTP 206`；
  - `POST /api/translate/google`（直连 Google Endpoint + 本机代理）实测返回 `HTTP 200` 中文译文。
- **Agent 问答、ASR 防护、Cookie 与重启持久化回归（阶段 4–5 两轮起停同一 `--data-dir` 实测）**：
  - `GET /api/agents` 探测本机 5 款 CLI Agent；`POST /api/llm/chat` 实测 `Codex` SSE 真机流式输出直至 `done`；
  - `GET /api/asr/models` 返回就绪状态；`POST/GET /api/cookies` 实测存取与清除，确认 `GET` 绝不泄露明文；
  - `POST /api/episodes/{id}/transcribe` 缺 Key 云端 ASR 返回规范 SSE `error` 事件；
  - 第一轮写入导入文稿、`translation` / `chat` blob、`chatProvider=codex` 与本地 WAV 媒体文件后彻底停服，第二轮同 `--data-dir` 重启验证全部数据与 `Range 206` 媒体完整持久恢复。
- **工程结构**：`validate_project_scaffold.py` 校验 `PASS`；上游只读仓 `D:\project\subcast` 工作区未做任何改动。

# 当前阻塞

- 无。

# 待验证事项

- 窄屏（`<900px`）响应式布局检查与无字幕单集 `NoTranscriptCard`（`local:<modelId>` + 三档引擎分组下拉框）图形浏览器实景交互；
- 高配档 `Qwen3-ASR 1.7B (Q5_K)`（1.66 GB）及长音频播客（>30 分钟）的 Silero VAD 切句字幕密度与 `[mm:ss]` 跳转体验；
- 豆包 / 硅基流动 / DeepSeek 等付费云端 ASR 与需配 Key 云端大模型（如 DeepSeek）/ 其他本机 CLI Agent（如 `Gemini CLI`、`Claude Code`）完整真机实测；
- 按需粘贴真实 YouTube `cookies.txt` 后绕过 `yt-dlp` 人机验证的真机效果。

# 已知技术债

- `package-lock.json` 因此前官方源经代理下载超时而在安装阶段通过直连 `https://registry.npmmirror.com` 生成，内含镜像地址记录；`~/.npmrc` 未修改。
- `db.rs` 中预留给后续二期统计/展示的 `show_notes`、`set_audio_url`、`log_listen`、`listens_since` 已标记 `#[allow(dead_code)]`，待二期启用时接上路由。
- **架构结构债（详述与治理原则见 [ARCHITECTURE.md](ARCHITECTURE.md)「架构现状评估与演进边界」）**：`styles.css`（~5,190 行）、`routes.rs`（~1,960 行）、`ChatPanel.tsx`（1,672 行）、`SettingsModal.tsx`（已拆出 [AsrSettingsSection.tsx](src/components/settings/AsrSettingsSection.tsx) 与 [KeyStatusRow.tsx](src/components/settings/KeyStatusRow.tsx)，剩余约 1,320 行）与 `Players.tsx`（1,318 行）仍按「改到哪、拆到哪」渐进治理；前端暂无自动化单测；长播客批量翻译绑定浏览器页签不可关页续跑；面向大众分发前需补齐单实例与系统托盘包装。

# 下一步

阶段 4（三档本地离线 ASR + `CrispASR v0.8.55` 硬件探测与 CPU 回退）已完成实施与真机验证；下一步处理窄屏 `<900px` 响应排布、长音频转写体感验证与阶段 5 首版验收收尾（以及是否将本地改动 commit）。

# 最近完成

- **2026-11-23（Tauri v2 独立桌面客户端 + NSIS 安装包）**：
  - 后端库化与内嵌资产（[Cargo.toml](server/Cargo.toml)、[lib.rs](server/src/lib.rs)、[main.rs](server/src/main.rs)、[routes.rs](server/src/routes.rs)）：抽离 `podcast_desk_core` 共享库与 `start_server()`，增加 `rust-embed` 内嵌 `dist/` 回退（保留原 CLI 独立运行能力）。
  - 桌面薄壳与打包（`desktop/`、[generate-icons.py](scripts/generate-icons.py)、[stage-vcrt.ps1](scripts/stage-vcrt.ps1)、[run-tauri.ps1](scripts/run-tauri.ps1)、[package.json](package.json)）：接入 `Tauri v2`（`tray-icon`）与 `tauri-plugin-single-instance`，实现无黑框启动、窗口点 `×` 缩入右下角托盘继续播放/转写、托盘右键「打开工作台 / 打开数据目录 / 退出」、外链跳系统浏览器、启动自动把安装目录（4 个 VC++ 运行库 DLL）前置进 `PATH` 防干净电脑跑 `CrispASR` 闪退，并配置中文 NSIS 安装向导（`currentUser` 免管理员权限）。
  - 数据迁移与验证：无损迁移 `data/` 至 `%LOCALAPPDATA%\podcast-desk`；`npm run tauri:build` 成功产出 `PodDesk_0.1.0_x64-setup.exe`（6.00 MiB），实测独立 exe 启动、内嵌前端、`%LOCALAPPDATA%` 读写与单实例防多开均通过。
- **2026-11-23（阶段 4：三档本地离线 ASR + CrispASR v0.8.55 硬件探测回退 + 顺手模块拆分）**：
  - 后端重构与拆分（`server/src/asr/` 目录拆为 `catalog.rs` / `hardware.rs` / `engine.rs` / `media.rs` / `ytdlp.rs` / `mod.rs`，移除旧 `asr.rs`；[routes.rs](server/src/routes.rs)）：落地 `SenseVoice-Small (Q8_0)`（240 MB，FunASR v1.1 署名）、`Qwen3-ASR 0.6B (Q4_K)`（602 MB，非 `imatrix`）与 `Qwen3-ASR 1.7B (Q5_K)`（1.66 GB）三档目录及 Silero VAD（864 KB）；实现 Windows GPU 探测（过滤虚拟显示卡 + `nvidia-smi` 显存校准）、AVX2/ARM64 判定、短样音试跑锁定独显 `-dev`、GPU 失败自动安装回退 `cpu`/`cpu-legacy` 持久化（`asr-runtime.json`），以及下载 HTTP `Range` 断点续传重试，新增 `POST /api/asr/probe`。
  - 前端拆分与升级（拆出 [KeyStatusRow.tsx](src/components/settings/KeyStatusRow.tsx) 与 [AsrSettingsSection.tsx](src/components/settings/AsrSettingsSection.tsx)，精简 [SettingsModal.tsx](src/components/SettingsModal.tsx)；同步升级 [api.ts](src/lib/api.ts)、[store.ts](src/store.ts)、[jobs.ts](src/lib/jobs.ts)、[TranscriptPanel.tsx](src/components/TranscriptPanel.tsx) 与 [styles.css](src/styles.css)）：支持硬件/加速状态展示、手动切换 Vulkan/CUDA 13/CPU 并触发校验、三档模型卡片管理与单集页分组选择；旧 `qwen3` 偏好平滑迁移为 `local:<modelId>`。
  - 验证：`cargo test`（49 passed, 0 failed, 1 ignored）、`cargo build`、`npm run typecheck`、`npm run build` 零警告通过；实机下载 `CrispASR v0.8.55`（`vulkan` + `cpu`）、Silero VAD、`SenseVoice-Small` 与 `Qwen3-ASR 0.6B` 并跑通 `-dev 1` 独显转写、CPU 回退隔离测试及 1440×900 浅/深主题设置页浏览器核查。

- **2026-11-22（全站外观质感精修 + 4 浅 / 4 深多主题与「外观」设置页）**：
  - 主题体系与零白闪启动（[themes.ts](src/lib/themes.ts)、[themes.css](src/themes.css)、[index.html](index.html)、[main.tsx](src/main.tsx)、[store.ts](src/store.ts)、[App.tsx](src/App.tsx)）：实现三轴解耦偏好（`theme: system/light/dark` + `lightTheme` + `darkTheme`），内置 4 套浅色（暖宣纸 / 晨光极简 / 柔雾青笺 / 柔杏书房）与 4 套深色（暖炭书房 / 深夜石板 / 黑曜影院 / 松烟墨绿）；`index.html` 首屏同步脚本消除深色刷新白闪。
  - 设置页新增「外观」独立页签（[SettingsModal.tsx](src/components/SettingsModal.tsx)、[Sidebar.tsx](src/components/Sidebar.tsx)）：提供明暗三段切换、8 张迷你工作台缩略预览卡（点选即实时预览，顶栏日/月开关动态提示当前主题名），并将字幕/问答字号调节与实时预览收编至「外观」。
  - 单套质感精修（[styles.css](src/styles.css)）：新增 `--elevated` / `--track` / `--inset-hi` 等分层变量，根治深色模式下分段控件与主题滑块选中态反凹问题；清理划词浮条、封面描边、遮罩等非媒体区硬编码色值；重做频道页 `.search-inline` 为一体式搜索框，调校 `MonthFilter` 深色对比度与音频舞台/Markdown 排版层次。
  - 验证：`npm run typecheck` 与 `npm run build` 退出 0；在运行中的 `http://127.0.0.1:14327`（1440×900）完成两轮共 10 张多主题实机截图检视与微调（涵盖全部 8 套主题、首页/频道/音频工作台/零滚动外观设置窗及深色重载无白闪校验，0 控制台报错，末尾已还原至浅色「暖宣纸」）。

- **2026-11-22（阶段 3 体验优化 + 音频提词开关恢复）**：
  - 订阅更新去压力化（[db.rs](server/src/db.rs)、[routes.rs](server/src/routes.rs)、[Lists.tsx](src/components/Lists.tsx)、[Sidebar.tsx](src/components/Sidebar.tsx)）：侧栏未看数字角标改为仅在「近 7 天有未看新集」时亮起 6px 小圆点；首页「订阅更新」去掉总集数展示，改为 `近 7 天 / 近 30 天` 时间窗 + 单频道最多展示最新 5 集（无更新时兜底最新 10 集）；频道页新增 `POST /api/shows/{id}/mark-all-completed`「全部标为已看/已听」按钮。
  - 恢复音频封面提词显隐键（[store.ts](src/store.ts)、[Players.tsx](src/components/Players.tsx)）：在音量键左侧恢复字幕图标开关（`prefs.audioStageSub` 持久化），一键显示/隐藏封面下方提词。
  - 验证：`cargo test`（39 passed, 0 failed, 1 ignored）、`cargo build`、`npm run typecheck`、`npm run build` 均退出 0。
- **2026-11-22（阶段 3：首页、订阅与频道详情页）**：
  - 后端（[model.rs](server/src/model.rs)、[db.rs](server/src/db.rs)、[youtube.rs](server/src/youtube.rs)、[routes.rs](server/src/routes.rs)）：`episodes` 新增幂等 `completed` 列（回填 ≥97% 历史记录），统一 `list_shows` 未看计数与播放结束自动完成，新增 `POST /api/episodes/{id}/completed`；实现 YouTube 频道/片单首次入库抓前 50 集（融合 15 条 RSS 精确发布时间与页面真实时长、频道真头像、简介与 16:9 封面，过滤 Shorts）、`POST /api/shows/{id}/load-more` 按需翻页与 `POST /api/shows/refresh-all` 并发刷新（保护已有 YouTube 真头像不被 RSS 缩略图覆写）。
  - 前端（[api.ts](src/lib/api.ts)、[format.ts](src/lib/format.ts)、[store.ts](src/store.ts)、[Players.tsx](src/components/Players.tsx)、[MonthFilter.tsx](src/components/MonthFilter.tsx)、[Lists.tsx](src/components/Lists.tsx)、[Sidebar.tsx](src/components/Sidebar.tsx)、[styles.css](src/styles.css)）：首页新增「继续播放」卡、「全部刷新」及 `最近与单集 / 订阅更新`（含「仅看未看」）切换；频道页新增简介展开/收起、`全部 / 未看 / 已看 / 有字幕` 筛选、年月热力定位、行内一键标已看/未看与 YouTube 底部「加载更早单集」；顶部搜索下拉已订阅项支持直接点击进入。
  - 验证：`cargo test`（39 passed, 0 failed, 1 ignored）、`cargo build`、`npm run typecheck`、`npm run build` 均退出 0（真实 YouTube/RSS 网络抓取与图形浏览器交互待船长重启 exe 实测）。
- **2026-11-22**：完成双主题视觉质感精修（浅色「暖宣纸编辑部风」+ 深色「深夜暖炭书房风」）：
  - 重构色彩与表面层次：全站导航与交互控件退回中性黑白灰，稀缺赤陶暖橙仅保留于播放进度、时间戳、当前朗读句与时间轴；新增自定义极简品牌标识、双色线稿插画与骨架屏（[Illustrations.tsx](src/components/Illustrations.tsx)），统一 `16:9` 列表缩略图与毛玻璃衬底、音频封面柔光投影、毛玻璃吸底控制条、静止隐身/滚动渐现滚动条、顶栏一键深浅色切换及设置页双栏厂商配置；`npm run build`（`tsc --noEmit && vite build`）退出 0；浏览器实景视觉检查已交由船长亲自查看（临时预览服务 `http://127.0.0.1:14330` 保留运行中）。
- **2026-11-22**：完成全前端 4 波次 UX/UI 大改版及单集删除后端接口：
  - 后端新增 `DELETE /api/episodes/{id}`（`db::delete_episode` 级联清理字幕/blobs/收听记录并删除本地上传媒体文件），`cargo test` 零警告通过（**34 passed, 0 failed, 1 ignored**），`cargo build` 退出 0。
  - 前端重构为可折叠侧栏 + `Splitter` 拖拽调宽 + 浏览首页/频道页/单集沉浸工作台（含宽屏「字幕+问答同屏并排」切换）+ 悬浮迷你播放器 + 顶部「搜索/粘贴链接」合一框；新增统一播放控制条（倍速/静音/吸底）、音频分句大字幕舞台、Show Notes 时间戳跳转与翻译、渐进显露字幕状态条 + `Ctrl+F` 搜索 + 术语表弹窗、自由划词悬浮栏（问 AI / 带出处复制 / 即时翻译）、独立导读页与播放位置感知问答（3 种复制格式 + 对话归档历史）、4 分区设置弹窗与深浅色主题；`npm run typecheck && npm run build` 退出 0。
  - 临时起服实测新版前端静态资源托管（`GET /` HTTP 200）与 `POST /api/episodes/import-text` → `GET /api/episodes/{id}` → `DELETE /api/episodes/{id}` → `404` 闭环通过，临时目录与进程已清理；`validate_project_scaffold.py` 校验 `PASS`。
- **2026-11-22**：同步目录改名后的 5 份文档路径引用（`INDEX.md`、`AGENTS.md`、`PROJECT.md`、`ARCHITECTURE.md`、`PROGRESS.md`），并在 `D:\project\podcast-desk` 复验通过：`validate_project_scaffold.py`（`PASS`）、`cargo test`（`33 passed, 0 failed, 1 ignored`）、`cargo build`（退出 0，生成 `server/target/debug/podcast-desk.exe`）与 `npm run build`（`tsc --noEmit && vite build` 退出 0）。
- **2026-11-21**：完成阶段 3–5 全部开发与验收前回归验证：
  - 后端新增 `translate.rs`（仅谷歌直连，无作者私有中转）、`asr_context.rs`、`asr.rs`（`symphonia` 16k 解码 + `CrispASR`/`Qwen3-ASR 0.6B` + GitHub 官方源 `yt-dlp` + 可选 `cookies.txt`）、`cloud.rs` 及搜索/刷新/文本与媒体导入/`/api/media` Range 托管/ASR 下载与转写/流地址/Cookie 接口（`cargo test` 零警告 33 passed, 1 ignored；`cargo build` 退出 0）。
  - 前端新增 `subexport.ts`、完善 `ai.ts` 术语表提取与 `batches`/`salvage` 分批精译、`providers.ts` 云端 ASR 预设、`Sidebar.tsx`（播客与频道搜索弹窗、`.srt`/`.vtt`/纯文本与本地音视频导入弹窗、单订阅刷新）、`PlayerPanel.tsx`（视频支持、双语/原文/译文切换、大模型/谷歌翻译引擎、YouTube `yt-dlp` 直链 `<video>` 回退、语音转写 SSE 进度、文稿多格式导出）、`ChatPanel.tsx`（整段对话复制与 Markdown 下载）及 `SettingsModal.tsx`（语音转写与按需 Cookie 配置）；`npm run typecheck && npm run build` 退出 0。
  - 完成阶段 3 与阶段 4+5 两轮起停重启持久化 HTTP/SSE 冒烟回归（临时进程与数据目录均已清理）；更新 `ARCHITECTURE.md` 与 `PROGRESS.md`。
- **2026-11-21**：完成阶段 2 最小垂直切片并实测通过。
- **2026-11-21**：完成 `D:\project\podcast-desk` 项目初始化与基线文档建立。
