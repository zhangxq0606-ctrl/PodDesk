---
lifecycle: bootstrap
foundation: pending
active_goal: null
work_status: active
last_verified: 2026-11-22
---

# 当前里程碑

阶段 1（单集视频工作台）、阶段 2（单集音频/纯文稿工作台）与阶段 3（首页、订阅与频道详情页）已落地并通过编译与单元测试，**待船长重启本地服务后在浏览器统一试玩验收**；后续依次为阶段 4（无字幕 ASR 选型与闭环）、阶段 5（深色模式总检与首版验收/首次 commit）与阶段 6（二期知识沉淀导出）。

# 已验证能力

- **全量编译与静态检查**：
  - 前端：`npm run typecheck`（`tsc --noEmit`）与 `npm run build`（Vite 6 打包 `dist/index.html`、`dist/assets/index-D9nbITPe.css`、`dist/assets/index-XR5nO-Lv.js`）退出 0；
  - 后端（无 `CMake`/`LLVM`、无 `whisper-rs`、无 `tauri`）：`cargo test` 零警告通过（**39 passed, 0 failed, 1 ignored**，涵盖 `db` 含 `completed` 迁移回填、7 天新更计数、批量标已看与单集级联删除、`net`、`feeds`、`youtube` 含频道/片单 `ytInitialData` 与 Shorts 过滤、`transcript`、`translate`、`llm`、`agents`、`asr_context`、`asr`、`cloud`、`routes`），`cargo build` 退出 0 产出 `server/target/debug/podcast-desk.exe`。
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

- 图形浏览器（Chrome/Edge）真实打开 `http://127.0.0.1:14327` 后的三栏交互：YouTube IFrame 与 `yt-dlp` 禁嵌回退 `<video>` 播放、段落高亮、点击回答 `[mm:ss]` 自动跳转进度、导出下载文件（`.md`/`.txt`/`.srt`/`.vtt` 与问答笔记 `.md`）以及浏览器端大模型术语精译流程；
- 一键下载 ~960 MB `Qwen3-ASR 0.6B` 模型 + `CrispASR` 后的真机离线音视频语音转写实测；
- 豆包 / 硅基流动 / DeepSeek 等付费云端 ASR 与需配 Key 云端大模型（如 DeepSeek）/ 其他本机 CLI Agent（如 `Gemini CLI`、`Claude Code`）完整真机实测；
- 按需粘贴真实 YouTube `cookies.txt` 后绕过 `yt-dlp` 人机验证的真机效果。

# 已知技术债

- `package-lock.json` 因此前官方源经代理下载超时而在安装阶段通过直连 `https://registry.npmmirror.com` 生成，内含镜像地址记录；`~/.npmrc` 未修改。
- `db.rs` 中预留给后续二期统计/展示的 `show_notes`、`set_audio_url`、`log_listen`、`listens_since` 已标记 `#[allow(dead_code)]`，待二期启用时接上路由。

# 下一步

当前阶段 1–3 基线已本地提交（`0434c85`），**全站外观精修与 8 套浅/深色多主题系统**已完成并经实机浏览器截图双轮验收（待船长决定是否本地提交）；明日按 [ARCHITECTURE.md](ARCHITECTURE.md) 已定案的「三档本地 ASR + CrispASR v0.8.55 探测回退」实施阶段 4。

# 最近完成

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
