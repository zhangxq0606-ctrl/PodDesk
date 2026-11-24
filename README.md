<div align="center">

<img src="desktop/icons/icon.png" width="76" alt="PodDesk" />

# PodDesk

**让 AI 陪你，一起听完每期播客。**

面向中英文播客与 YouTube 视频的本地优先 AI 工作台：多源取稿、本机离线转写、双语精译与在场感问答。

[![Release](https://img.shields.io/github/v/release/zhangxq0606-ctrl/PodDesk?include_prereleases&label=release&color=D4622A)](https://github.com/zhangxq0606-ctrl/PodDesk/releases)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows%20x64%20%7C%20macOS%20Apple%20Silicon-555)

**[官网与交互演示](https://poddesk.captainxq.me/) · [下载安装](#下载与安装) · [Releases](https://github.com/zhangxq0606-ctrl/PodDesk/releases) · [反馈问题](https://github.com/zhangxq0606-ctrl/PodDesk/issues)**

</div>

---

## 核心特性

- **多源接入，单集直开**：支持 YouTube（频道订阅自动过滤 Shorts、播单与单集）、Apple Podcasts / 任意 RSS、小宇宙、本地音视频（最高 512 MB），以及 `.srt` / `.vtt` / 纯文本导入。
- **三层字幕，音频不出本机**：优先拉取官方字幕；无字幕时可调用本机离线模型（`SenseVoice-Small` / `Qwen3-ASR 0.6B` / `1.7B`，基于 `CrispASR` + `Silero VAD`，自动适配 Vulkan / CUDA / Metal / CPU），也支持豆包、硅基流动、Groq、OpenAI 等云端转写。
- **术语感知双语精译**：支持免费谷歌直连粗翻（零 Key 起步）与大模型术语表分批精译；频道保留原名，单集标题支持中/英三档切换。
- **把常用 AI Agent 请到收听现场**：自动探测并复用本机已登录的 6 款 CLI Agent（Claude Code、Codex、Antigravity CLI、Qwen Code、Kimi Code、OpenCode）直接使用现有订阅额度，亦内置 DeepSeek、OpenAI、Claude、Gemini、Ollama 等接口。导读与问答实时感知播放进度，`[mm:ss]` 点击即回跳原声，支持划词追问与 Markdown 导出。
- **本地优先，轻巧克制**：内置 8 套浅/深编辑部主题，Tauri v2 安装包仅约 6–8 MB（支持托盘后台与单实例）；所有数据存本地 SQLite，API Key 仅存系统钥匙串，无账号体系、无私有中转。

## 下载与安装

前往 **[PodDesk 官网](https://poddesk.captainxq.me/#beta)** 或 **[GitHub Releases](https://github.com/zhangxq0606-ctrl/PodDesk/releases)**（含 `SHA256SUMS.txt`）获取最新版本：

| 平台 | 安装包 | 说明 |
|---|---|---|
| **Windows 10 / 11（x64）** | `PodDesk_*_x64-setup.exe` | 约 6.1 MB，内置 VC++ 运行库，免管理员安装 |
| **macOS（Apple Silicon）** | `PodDesk_*_aarch64.dmg` | 约 8.3 MB，原生 arm64，支持 Metal 离线转写 |
| **macOS（Intel）/ 浏览器模式** | 从源码运行 | 见下方 [从源码构建](#从源码构建) |

> **首次打开系统放行**（开源免费内测，暂未购买商业签名与 Apple 公证，仅首次需要）：
> - **macOS**：拖入「应用程序」后若提示“已损坏”，在终端运行一次：
>   ```bash
>   xattr -dr com.apple.quarantine /Applications/PodDesk.app
>   ```
> - **Windows**：SmartScreen 提示时点击 **更多信息 → 仍要运行**。

<details>
<summary><b>网络代理、YouTube 登录、本地数据路径与更新机制</b></summary>

- **零 Key 起步**：官方字幕、本机离线转写、谷歌粗翻与本机已登录 CLI Agent 均无需填写 API Key；按需接入云端模型即可。
- **代理与镜像**：访问 YouTube 自动读取系统代理（可手动覆写）；离线模型与外部工具下载内置 GitHub 镜像回退。
- **YouTube 风控兜底**：桌面端「设置 › 网络与风控」提供应用内 YouTube 登录（临时 Cookie 用完即删），亦支持上传 Netscape `cookies.txt`。
- **数据与凭据**：数据存本机 SQLite（Windows `%LOCALAPPDATA%\podcast-desk`；macOS `~/Library/Application Support/podcast-desk`），Key 仅存系统钥匙串，不主动上传任何音频或文稿。
- **版本更新**：内置 GitHub Releases 新版检测与更新说明弹窗，不静默热更新。

</details>

## 从源码构建

采用 `React 19 / TypeScript` 前端工作台 + `Rust / Axum / SQLite` 本地后端 + `Tauri v2` 桌面壳，**不引入内置 `whisper-rs`，编译无需 `CMake` 或 `LLVM`**。前置要求：**Node.js 24**（`.nvmrc`）与 **Rust stable ≥ 1.85**（Windows 打包另需 VS BuildTools VC++ 组件）。

```bash
npm install
npm run tauri:dev      # 桌面端开发
npm run tauri:build    # 打包当前平台安装包

# 或跳过桌面壳，启动纯本地服务 + 浏览器工作台（默认 http://127.0.0.1:14327）
npm run build && cargo run --manifest-path server/Cargo.toml
```

测试与校验：`npm run test` · `npm run typecheck` · `npm run version:check` · `cargo test --manifest-path server/Cargo.toml`。

深入文档：[架构设计](ARCHITECTURE.md) · [视觉与主题契约](docs/DESIGN_SYSTEM.md) · [开发与发版手册](docs/OPERATIONS.md)

## 致谢与开源协议

核心思路及抓源、解码与本机 Agent 底座深度参考并基于 **[SubCast（声渡）](https://github.com/joeseesun/subcast)** 演进重构；离线转写与视频直链依托 **[CrispASR](https://github.com/CrispStrobe/CrispASR)**（MIT）、**[Qwen3-ASR](https://huggingface.co/cstr/qwen3-asr-0.6b-GGUF)**（Apache-2.0）、**[SenseVoice](https://github.com/FunAudioLLM/SenseVoice)**（按需下载，FunASR v1.1）、**[Silero VAD](https://github.com/snakers4/silero-vad)** 与 **[yt-dlp](https://github.com/yt-dlp/yt-dlp)**。

本项目基于 **[AGPL-3.0-only](LICENSE)** 开源；PodDesk 仅作本地播放与学习工具，各平台音视频与字幕版权归原作者所有。
