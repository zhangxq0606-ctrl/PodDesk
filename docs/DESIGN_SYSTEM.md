# PodDesk 视觉规范与设计系统契约

## 1. 核心理念与视觉红线

- **产品气质**：**精密声音控制台 × 独立刊物精读桌**。
- **中性骨架 + 稀缺强调原则**：侧栏、工具栏、表单、按钮等交互骨架统一退回中性黑白灰（`--ink` / `--on-ink` / `--surface-*`）；主题强调色（`--accent` / `--accent-text`）**仅用于**内容进度条、播放时间戳、`[mm:ss]` 锚点胶囊、当前朗读句、活动字幕与导读节点，不作大面积装饰铺色。
- **防 AI 味与排版纪律**：
  - 浅色禁止纯白 `#fff` 面板直出眩光（正文面板与画布保持哑光暖/冷纸阶梯，仅浮动交互卡与顶层弹窗用浅透/高阶白）。
  - 深色统一纯中性底色（石墨 / 黑曜 / 控台灰 / 净炭），依靠表层亮度阶梯与顶部微高光（`--rim-top`）建立层次，杜绝偏色泥棕/浊绿画布。
  - 禁用高频率全屏装饰光斑、霓虹常驻发光边框、无功能隐喻卡片套娃、弹簧过冲回弹（Bouncy Spring）以及列表中高频滚动/切页延迟入场动画。

---

## 2. 三轴解耦主题架构与 26 语义 Token 契约

- **三轴模型**（源码：[src/themes.css](../src/themes.css)、[src/lib/themes.ts](../src/lib/themes.ts)、[index.html](../index.html)）：
  - `data-theme="light" | "dark"`：当前解析后的明暗模态（支持 `system` 跟随系统、固定 `light`/`dark`）。
  - `data-palette`：`LightThemeId | DarkThemeId`（浅色与深色风格各自独立记忆，互不覆盖）。
  - 防白闪启动：`index.html` 首屏内联同步脚本必须在首帧渲染前完成 `theme`/`lightTheme`/`darkTheme` 读取与历史 ID 迁移，并立即设置 `data-theme` 与 `data-palette`。
- **表面阶梯与 26 个语义 Token**：
  - 表面阶梯（从深/沉向浮出依次递进）：
    - 浅色：`--sidebar` < `--bg` < `--panel`（哑光正文区） < `--surface-card` < `--elevated` = `--overlay`（`#ffffff`）
    - 深色：`--sidebar` < `--bg` < `--panel` < `--surface-card` < `--elevated` < `--overlay`（毛玻璃半透）
  - 完整 Token 分组（26 个核心语义位）：
    - **表面与交互填充**：`--sidebar`、`--bg`、`--panel`、`--surface-card`、`--elevated`、`--overlay`、`--surface-bubble`、`--track`、`--hover-fill`、`--active-fill`、`--soft`、`--soft-hover`
    - **边界与光影**：`--line`、`--line-strong`、`--rim-top`（`--inset-hi`）、`--contact-shadow`、`--thumb-ring`、`--shadow-sm`、`--shadow`、`--shadow-lg`、`--backdrop`
    - **文字与内容强调**：`--text`、`--text-2`、`--muted`、`--icon-muted`、`--ink`、`--on-ink`、`--accent`、`--accent-soft`、`--accent-text`、`--active-line`、`--mark`、`--ok`、`--ok-soft`、`--danger`、`--danger-soft`、`--float-bg`、`--float-fg`、`--float-hover`、`--float-border`
- **OKLCH 派生引擎与 WCAG 2.1 自动化对比度门禁**（[src/lib/themeEngine.ts](../src/lib/themeEngine.ts)、[src/lib/__tests__/themes.test.ts](../src/lib/__tests__/themes.test.ts)）：
  - `derivePodDeskTheme` 支持由一对 `canvas` + `accent` Hex 种子在 OKLCH 空间内二分求解明度，保证浅色与深色语义色阶自适应达标。
  - **自动化门禁底线（Vitest 每次必跑，禁止放宽）**：
    - 浅色：`--panel !== #ffffff`；`text` 在 `panel`/`bg` ≥ `12:1`；`text-2` 在 `panel` ≥ `6.5:1`；`muted` 在 `panel`/`card` ≥ `4.6:1` 且在 `bg` ≥ `4.5:1`；`text` 在 `surface-bubble` ≥ `10:1`；`accent-text` 在 `panel`/`accent-soft` ≥ `4.5:1`。
    - 深色：`text` 在 `panel`/`bg` ≥ `12:1`；`text-2` 在 `panel` ≥ `6.5:1`；`muted`（抗晕影地板）在 `panel` ≥ `5.1:1` 且在 `card` ≥ `5.0:1`；`text` 在 `surface-bubble` ≥ `10:1`；`accent-text` 在 `panel`/`accent-soft` ≥ `4.5:1`。

---

## 3. 内置 8 套主题目录与旧 ID 迁移

默认配对为：**`stone-proof`（浅） × `graphite-desk`（深）**。

| 模式 | ID | 名称 | 调性与强调色定位 |
|---|---|---|---|
| 浅色 | `stone-proof`（默认） | 素石校对 | 中性素石柔纸（`#eef0f4`）· 普鲁士青点缀（`#0f6270`） |
| 浅色 | `linen-folio` | 亚麻书页 | 低眩光亚麻底（`#f0eee8`）· 深松青点缀（`#1f6b56`） |
| 浅色 | `silver-console` | 阳极银台 | 精密冷银灰（`#eceff5`）· 深钴蓝点缀（`#3d4fd1`） |
| 浅色 | `warm-paper` | 暖宣纸 | 精修纸韵暖白（`#f3efe7`）· 陶土点缀（`#c95220`） |
| 深色 | `graphite-desk`（默认） | 石墨仪器 | 中性石墨深炭（`#12151a`）· 冰青点缀（`#4fb3c2`） |
| 深色 | `darkroom-carbon` | 暗室黑曜 | 深邃纯中性近黑（`#0c0d0f`）· 哑光黄铜（`#d6a856`） |
| 深色 | `studio-slate` | 冷灰控台 | 通透中深中性灰（`#181a1e`）· 柔长春花蓝（`#7b9cff`） |
| 深色 | `warm-charcoal` | 净炭书房 | 克制中性暖炭（`#131312`）· 柔陶点缀（`#ea8a5c`） |

- **历史 ID 平滑迁移**（同时存在于 `index.html` 与 `src/lib/themes.ts`）：
  - 浅色：`pure-morning -> silver-console`、`bamboo-mist -> linen-folio`、`apricot-study -> warm-paper`
  - 深色：`deep-slate -> studio-slate`、`obsidian-cinema -> graphite-desk`、`pine-ink -> darkroom-carbon`

---

## 4. 排版、字体栈与深色光学权重

- **字体栈契约**（[src/styles/base.css](../src/styles/base.css)）：
  - `--font`：`PingFang SC` / `Noto Sans SC` / `Hiragino Sans GB` / `Segoe UI` / `Microsoft YaHei UI` / `system-ui` / `sans-serif`。
  - `--font-serif`：`Newsreader` / `Source Serif 4` / `Georgia` / `Sitka Display` / `Noto Serif SC` / `Source Han Serif SC` / `Songti SC` / `STSong` / `PingFang SC` / `Microsoft YaHei UI` / `sans-serif`。**严禁以裸 `serif` 关键字结尾**，防止未装思源宋体的 Windows 机器退化为锯齿点阵宋体（`SimSun`）。
  - `--mono`：`Cascadia Mono` / `ui-monospace` / `SFMono-Regular` / `Menlo` / `Consolas` / `monospace`。
- **外科手术式衬线锚点（仅限 4 处，其余 UI 控件、字幕流与元信息严守无衬线）**：
  1. 标题层：`.ep-title h1`、`.home-title`、`.show-title-h`、`.hero-title`（含 `.welcome-card h1`）
  2. 音频舞台实时朗读句：`.asub-line.now .sub-zh`
  3. 导读章节节点标题：`.gt-item-title`
  4. AI 长回答与导读摘要排版锚点：`.markdown h1/h2/h3` 与 `.markdown blockquote`
- **深色光学减重与数字对齐**：
  - 深色模式下标题字重压回 `550–560`（`.ep-title h1` 等 `560`，`.ep-title2`/`.gt-item-title` `550`，`.line.active .zh` `500`），`.zh` 与 `.markdown` 加微字距 `letter-spacing: 0.01em` 消除亮字发虚感。
  - 全部时间进度、时长、计数与时间戳强制 `font-variant-numeric: tabular-nums`。

---

## 5. 微工艺与微动效契约

- **纸感底噪与统一图标描边**：`body::before` 叠加极微弱 SVG 分形噪点（浅色 `0.022` / 深色 `0.026`）；全站 Lucide 图标锁定 `stroke-width: 1.75`。
- **三态连续时间轴轨道**：字幕行（`.line::after` + `.line-time::before`，兼容虚拟滚动首尾边界 `data-edge="first|last|only"`）与导读时间轴统一采用 `past` / `active` / `future` 三态细线圆点；激活点只播一次 `dot-ping`（`440ms` 消散，不循环闪烁）。
- **滚屏边缘缓动渐隐与自定义选区**：`.lines`、`.gt-scroll`、`.chat-scroll` 使用 `--scroll-fade-mask` 多段遮罩并保持右侧 `7px` 滚动条轨道不透明；`::selection` 随主题采用柔和 `--accent` 半透明底描。
- **进度条实时时间与章节预览**：`Controls.tsx` 对接导读章节目录，悬停或拖拽进度条时展示 `--hover-pct` 自适应贴边气泡（`.seek-tip`），同时不增加高频 `s.time` 订阅范围。
- **浮层入场与防变换冲突规则**：
  - 弹窗、菜单、下拉、音量条、划词栏、Toast 使用 `140–200ms` `--ease-drawer` / `--ease-out` 原位轻浮入场，**必须使用 CSS 独立 `translate` / `scale` 属性编写 keyframes**，严禁覆写居中和锚定元素原有的 `transform: translateX(-50%)` 或 `translate(-50%, -100%)`。
- **交互反馈与折叠细节**：
  - 按钮、图标键、圆形按钮、芯片、`[mm:ss]` 与发送键统一 `:active` 轻压阻尼；快进/退键点击触发 `±18°` 一次性棘轮微摆；封面播放切换使用 `320ms` 微浮起，提词切句 `220ms` 柔切；「内容精炼」使用纯 CSS `grid-template-rows: 0fr -> 1fr` 展开。
  - AI 等待状态采用步进文字流光 `.thinking-shine`，流式生成结尾呈现呼吸竖线光标（结束后自动消失），复制成功触发 `check-draw-icon` 笔触对勾。
  - **无障碍退避**：所有新增动效自动受 [src/styles/responsive.css](../src/styles/responsive.css) 顶部 `@media (prefers-reduced-motion: reduce)` 全局关闭。

---

## 6. 开发态对比实验室边界

- 热切对比工具 [src/dev/ThemeLabBar.tsx](../src/dev/ThemeLabBar.tsx) 仅在 `import.meta.env.DEV && ?lab=1` 条件下通过 `React.lazy` 延迟加载，**严禁在静态模块顶层引入**。
- 每次修改构建后，生产产物 `dist/` 扫描 `ThemeLabBar|data-lab|theme-lab-bar` **必须保持 `0` 命中（`LAB_HITS=0`）**。
