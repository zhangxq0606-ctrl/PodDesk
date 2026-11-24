# PodDesk 开发与运维手册

本文件是 PodDesk 跨平台协作、CI/CD 自动化与双端发版的唯一运维事实源。任何 AI 代理或开发者在处理分支协作、工作流修改、版本号变更、双端打包发布、官网更新或平台排障前，应先遵循本手册。

---

## 一、四层架构全景

| 层次 | 职责 | 权威位置 | 触发与流向 |
|---|---|---|---|
| **1. 代码层** | 前端工作台、Rust 后端、Tauri 桌面壳、官网源码 | GitHub `main` 分支 | 日常开发以 `main` 为唯一中转站 |
| **2. 自动体检层（CI）** | 前端单测/构建、全仓版本校验、Win/Mac 原生编译与后端测试 | `.github/workflows/ci.yml` | 推送 `main` 或提 PR 时触发（自动跳过纯文档与 `website/` 改动） |
| **3. 双端发版层（CD）** | 云端双端打包（Windows NSIS `.exe` + macOS `.dmg`）与校验码发布 | `.github/workflows/release.yml` | 推送 `v*.*.*` 标签（或手动触发）→ 生成 **GitHub Release 草稿** |
| **4. 官网分发层** | 产品展示、安装放行指引与双端下载直链 | `website/` → Cloudflare Pages | `main` 更新后由 Cloudflare Pages 自动部署至 `https://poddesk.captainxq.me/` |

---

## 二、跨平台日常协作规范（Windows + macOS）

1. **单一主干，不留长期分支**：不设立长期 `win` 或 `mac` 分支。每次切换设备开工前，第一步执行 `git pull --ff-only origin main`。
2. **分支与合并策略**：
   - 文档、官网文案或单一平台明显小修：在确认范围内可直接提交并推至 `main`。
   - 功能开发、跨平台核心改动（桌面壳/构建脚本/ASR/公共接口）：从最新 `main` 拉出短期分支（如 `feat/xxx`、`fix/xxx`），推至 GitHub 提 PR → 等待 `CI`（`web` + `windows-latest` + `macos-26`）三路全绿 → 使用 **Squash and merge** 合入（仓库已启用合并后自动删分支）。
   - `main` 不强制必须他人评审（避免独立开发卡死自己），但合并跨平台改动以 CI 三绿为准。
3. **跨平台工程防呆护栏**：
   - **换行符**：[.gitattributes](../.gitattributes) 强制文本统一为 `LF`，仅 `.ps1`/`.cmd`/`.bat` 保留 `CRLF`。
   - **运行时与工具链**：Node 主版本由 [.nvmrc](../.nvmrc) 固定；Rust 由 [rust-toolchain.toml](../rust-toolchain.toml) 设为 `stable`（`Cargo.toml` 声明 `rust-version = "1.85"`），不锁定单一补丁号以免卡住本机环境。
   - **版本号统一**：禁止手工只改单处版本号，统一走 `npm run version:sync <X.Y.Z>`，由 `scripts/sync-version.mjs` 联动管理 `package.json`、`desktop/tauri.conf.json`、`server/Cargo.toml`、`desktop/Cargo.toml` 与 `website/index.html`。
   - **本机构建入口**：统一通过 `npm run tauri:dev` / `npm run tauri:build`（内部调用 `scripts/run-tauri.mjs` 兼容双平台），不另写平台分叉启动脚本。

---

## 三、标准双端发版流程（5 步 SOP）

1. **统一升版**：在本地最新 `main` 运行：
   ```bash
   npm run version:sync <X.Y.Z>
   cargo check --manifest-path server/Cargo.toml
   cargo check --manifest-path desktop/Cargo.toml
   ```
   确认前后端两份 `Cargo.lock` 同步刷新到 `<X.Y.Z>`。
2. **核对官网与本地全检**：若安装包体积或平台指引有变化，同步微调 [website/index.html](../website/index.html) 中 `RELEASE` 配置区的体积说明；执行本地全量校验：
   ```bash
   npm run version:check
   npm run test && npm run build
   cargo test --manifest-path server/Cargo.toml
   ```
3. **合入 `main` 等体检绿灯**：提交变更并推至 `main`（或经 PR 合并），确认 `CI` 全绿。
4. **打标签触发云端双端出包**：
   ```bash
   git tag -a v<X.Y.Z> -m "Release v<X.Y.Z>"
   git push origin v<X.Y.Z>
   ```
   `release.yml` 会先校验 `--tag v<X.Y.Z>` 与全仓 5 处版本一致，再在 `windows-latest` 与 `macos-26` 并行打包 `.exe` 与 `.dmg`，最终自动创建带 `SHA256SUMS.txt` 的 **GitHub Release 草稿（Pre-release）**。
5. **验收与正式上架**：在 GitHub Releases 页面从草稿下载 `.exe` 与 `.dmg` 抽检确认可正常启动后，点击 **Publish release** 公开直链；随后打开 `https://poddesk.captainxq.me/` 核验双端下载按钮均可正常触发下载。

---

## 四、现阶段「有意不做」的边界

- **商业代码签名与 Apple 公证（$99/年）**：内测与早期开源阶段暂不购买；依赖 Release 说明、应用内更新弹窗与官网折叠指引向用户提供 Windows SmartScreen（「更多信息 → 仍要运行」）与 macOS Gatekeeper（「终端」执行 `xattr -dr com.apple.quarantine /Applications/PodDesk.app` 解除“已损坏”拦截）放行步骤。
- **应用内自动热更新（Tauri Updater）**：暂不接入，版本更新通过 GitHub Releases 与官网手动下载完成。
- **macOS Intel（`x86_64`）官方安装包**：当前聚焦 Windows x64 与 macOS Apple Silicon（arm64）；Intel Mac 用户暂按源码自行构建。

---

## 五、常见排障索引

| 现象 | 原因与处理 |
|---|---|
| **海外 CI / 国内安装 `package-lock.json` 问题** | 当前 `package-lock.json` 内保留 `registry.npmmirror.com` 解析地址，兼顾国内开发者无代理直接 `npm ci` 拉包，且 GitHub Actions 三路实测可直连通过。若海外网络遇到镜像限流，可在临时环境切回 `npmjs` 重生锁文件；无论如何变更依赖，必须核查 `package-lock.json` 同时包含 `@tauri-apps/cli-win32-x64-msvc` 与 `@tauri-apps/cli-darwin-arm64`。 |
| **macOS CI 打 `.dmg` 报 AppleScript / Finder 错误** | `bundle_dmg.sh` 在无图形会话下需跳过 Finder 窗口编排。`release.yml` 已显式传入环境变量 `CI: "true"` 触发 `--skip-jenkins`；排查时优先确认该变量未丢失。 |
| **Windows 干净机器启动 CrispASR 报缺 DLL** | Windows 打包前依赖 `scripts/stage-vcrt.ps1` 从 MSVC Redist 拷贝 4 个运行库至 `desktop/vcrt/` 随包分发；在本地或 `windows-latest` 构建需确保已安装 VS BuildTools 的 VC++ Redist 组件。 |
| **macOS Apple Silicon 转写显示或运行异常** | Apple Silicon 走 `crispasr-macos-arm64` 内嵌 Metal，代码内复用 `RuntimeVariant::Cpu` 并在 `aarch64/macos` 下映射展示为 `Apple Silicon (Metal)`；修改平台判断时需保持 Windows/x86_64 分支不受影响。 |
| **推了 `website/` 后官网未更新** | Cloudflare Pages 部署配置托管在 Cloudflare 后台，若未自动刷新，前往 Cloudflare Pages 面板核查绑定分支是否为 `main` 且构建输出目录为 `website`。 |
