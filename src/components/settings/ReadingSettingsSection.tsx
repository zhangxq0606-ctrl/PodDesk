import { ArrowDownToLine, Loader2, RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore, type TitleDisplayMode } from "../../store";

const PLAY_SHORTCUTS: [string, string][] = [
  ["Space", "播放 / 暂停"],
  ["← / →", "后退 10 秒 / 前进 10 秒"],
  ["[ / ]", "减速 / 加速播放"],
  ["M", "静音 / 取消静音"],
  ["C", "切换双语 / 中文 / 原文 / 关闭"],
  ["F", "视频全屏 / 退出全屏"],
];

const NAV_SHORTCUTS: [string, string][] = [
  ["Ctrl + L", "聚焦顶部搜索 / 链接框"],
  ["Ctrl + F", "在当前文字稿内搜索"],
  ["Ctrl + B", "展开 / 收起左侧栏"],
  ["Ctrl + \\", "展开 / 收起右侧栏"],
];

const TITLE_MODES: [TitleDisplayMode, string][] = [
  ["zh-first", "中文为主"],
  ["orig-first", "英文为主"],
  ["orig-only", "仅原文"],
];

export function ReadingSettingsSection() {
  const {
    audioNextLine,
    titleDisplayMode,
    savePrefs,
    health,
    updateInfo,
    checkingUpdate,
    checkUpdate,
    setUpdateModalOpen,
    notify,
  } = useStore(
    useShallow((s) => ({
      audioNextLine: s.prefs.audioNextLine,
      titleDisplayMode: s.prefs.titleDisplayMode,
      savePrefs: s.savePrefs,
      health: s.health,
      updateInfo: s.updateInfo,
      checkingUpdate: s.checkingUpdate,
      checkUpdate: s.checkUpdate,
      setUpdateModalOpen: s.setUpdateModalOpen,
      notify: s.notify,
    })),
  );

  const handleManualCheck = async () => {
    const info = await checkUpdate(true);
    if (!info) {
      notify("检查更新失败，请检查本机网络或代理设置", false);
      return;
    }
    if (info.hasUpdate) {
      setUpdateModalOpen(true);
    } else {
      notify(`当前已是最新版本（v${info.currentVersion}）`);
    }
  };

  return (
    <div className="settings-pane">
      <div className="settings-head">
        <div>
          <h4>阅读与快捷键</h4>
          <p>播放提词习惯、全局键盘快捷键与版本更新</p>
        </div>
      </div>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">播放与标题显示</span>
        </div>
        <div className="s-card">
          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label">纯音频舞台提前预告下一句字幕</span>
              <span className="s-row-desc">在播放器当前句下方淡显下一句，方便盲听预读</span>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={audioNextLine}
                onChange={(e) => savePrefs({ audioNextLine: e.target.checked })}
              />
            </label>
          </div>

          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label">外文单集标题显示</span>
              <span className="s-row-desc">播客与频道名称始终保持原名，仅频道简介自动辅助译为中文</span>
            </div>
            <div className="seg-control" role="radiogroup" aria-label="外文单集标题显示">
              {TITLE_MODES.map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={titleDisplayMode === mode}
                  className={titleDisplayMode === mode ? "on" : ""}
                  onClick={() => savePrefs({ titleDisplayMode: mode })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">全局快捷键</span>
        </div>
        <div className="s-card">
          <div className="shortcut-groups">
            <div className="shortcut-col">
              <span className="shortcut-col-title">播放与字幕</span>
              {PLAY_SHORTCUTS.map(([keys, desc]) => (
                <div key={keys} className="shortcut-row">
                  <span>{desc}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
            <div className="shortcut-col">
              <span className="shortcut-col-title">搜索与工作区</span>
              {NAV_SHORTCUTS.map(([keys, desc]) => (
                <div key={keys} className="shortcut-row">
                  <span>{desc}</span>
                  <kbd>{keys}</kbd>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">关于与版本更新</span>
        </div>
        <div className="s-card">
          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label">PodDesk 桌面工作台</span>
              <span className="s-row-desc">
                当前版本 <code>v{health?.version ?? "0.2.3"}</code>
                {updateInfo && !updateInfo.hasUpdate ? `（已是最新，最近检查 v${updateInfo.latestVersion}）` : ""}
                {updateInfo?.hasUpdate ? ` · 发现新版本 v${updateInfo.latestVersion}` : ""}
              </span>
            </div>
            <div className="row-actions">
              {updateInfo?.hasUpdate && (
                <button type="button" className="btn sm primary" onClick={() => setUpdateModalOpen(true)}>
                  <ArrowDownToLine size={13} /> 查看新版 v{updateInfo.latestVersion}
                </button>
              )}
              <button type="button" className="btn sm" onClick={() => void handleManualCheck()} disabled={checkingUpdate}>
                {checkingUpdate ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                <span>{checkingUpdate ? "检查中..." : "检查更新"}</span>
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
