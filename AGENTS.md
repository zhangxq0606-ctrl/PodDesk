# podcast-desk 项目规则

## 项目定位

- 目标：基于 SubCast（声渡）思路与 Rust 稳态底座，打造面向中英文音频播客与视频的「本地轻量后端 + 浏览器工作台」，聚焦多源取稿、双语对照、高效嵌入 AI Agent 进行在场感问答及后续知识沉淀导出。
- 项目根目录：`D:\project\podcast-desk`（上游 SubCast 只读研究仓位于 `D:\project\subcast`）。

## 事实源导航

| 事实 | 权威位置 |
|---|---|
| 产品定位、范围与业务规则 | `PROJECT.md` |
| 技术架构、模块与公共契约 | `ARCHITECTURE.md` |
| 视觉规范、主题 Token 与微动效契约 | `docs/DESIGN_SYSTEM.md` |
| 生命周期、已验证能力与阻塞 | `PROGRESS.md` |
| 运行与排障 | 按需建立（当前尚未创建 `docs/OPERATIONS.md`） |
| 活跃 Goal | `PROGRESS.md` 的 `active_goal` 指针；为空时不读取 `goals/` |

## 工作路径

- 读取 `PROGRESS.md` 判断生命周期；`work_status` 暂停或阻塞时保留原生命周期与活跃 Goal。
- `bootstrap` / `foundation-planning` / `foundation-goal`：按项目生命周期资产执行。
- `normal-development`：直接处理普通开发任务，不创建 Goal。
- `evolution-goal`：只执行已确认 Goal 的边界，闭环后返回正常开发。

## 验证入口

- 安装：Node 版本以根目录 `.nvmrc` 为准、Rust 版本以根目录 `rust-toolchain.toml` 为准；`npm install`（项目根目录，当前会话经 `--registry=https://registry.npmmirror.com` 直连实测通过并生成 `package-lock.json`）；Rust 依赖由 `cargo build` / `cargo test` 在 `server/` 目录与 `desktop/` 目录自动拉取通过
- 构建：`npm run build`（项目根目录 `tsc --noEmit && vite build`）、`cargo build`（`server/` 目录）与 `npm run tauri:build`（项目根目录，Windows 构建 `podcast-desk-desktop.exe` 及 NSIS 安装包，macOS 构建 `.app` 与 `.dmg`）
- 测试：`cargo test`（`server/` 目录）、`npm run test`（项目根目录，Vitest）、`npm run typecheck`（项目根目录）与 `npm run version:check`（校验 `package.json`、Tauri 配置与两个 `Cargo.toml` 版本一致）
- 持续集成：`.github/workflows/ci.yml` 在 GitHub Actions 对 `web`、`windows-latest` 与 `macos-26`（arm64）三路执行测试与原生编译检查
- 运行：`.\desktop\target\release\podcast-desk-desktop.exe`（桌面端，数据存 `%LOCALAPPDATA%\podcast-desk`）或 `.\server\target\debug\podcast-desk.exe`（CLI 服务模式，默认绑定 `127.0.0.1:14327`，静默启动加 `--no-open`）

每项验证入口只能是：真实且已验证的命令、`待建立`，或`不适用（原因）`。Foundation 退出前，所有适用命令必须实测；不适用项必须保留原因。

生命周期结构检查使用共享技能中的 `python C:\Users\qqmin06\.agents\skills\project-lifecycle\scripts\validate_project_scaffold.py D:\project\podcast-desk`；不复制脚本到项目中。

## 项目特有约束

- **上游参考隔离**：`D:\project\subcast` 为上游 SubCast 源码只读研究仓（当前工作区 `v0.2.8`，远端已抓取至 `v0.3.2+`）；搬运或对照代码时只读引用，禁止修改或污染上游目录。
- **分层纪律**：Rust 后端只承担稳态执行层职责（抓源、系统代理透传、音频解码与外调转写、SQLite 持久化、LLM/CLI Agent 代理）；所有 AI 提示词、翻译分批策略、在场感问答编排与后续知识沉淀交互留在 TypeScript 前端层。
- **首版裁剪红线**：不引入内置 `whisper-rs`（避免 `CMake`/`LLVM` 编译链）、不硬编码原作者私有服务（`*.qiaomu.ai`、`rss.qiaomu.ai`、`elon.qiaomu.ai` 中转）、不引入 OTA 热更新与上游 `v0.3.2` 视频切片/中文配音跟读/Anki 模块。
- **隐私与合规边界**：严格遵循 `AGPL-3.0-only` 开源要求（复用上游源码时保留协议声明）；永不在用户未明确选择时把音频上传至云端；API Key 与可选 `cookies.txt` 严禁写入仓库、日志或外发响应。
- **前端工程防坑**：React 状态订阅使用精细切片（避免整棵 Store 重渲染），禁止在组件内部定义子组件，交互确认禁用原生 `window.confirm/alert/prompt`。

全局行为、安全、授权、Git 与终端规则由自动加载的全局 `AGENTS.md` 提供，本文件不重复，也不得降低其约束。
