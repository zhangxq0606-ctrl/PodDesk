import { ArrowDownToLine, Loader2, RefreshCw } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore, type TitleDisplayMode } from "../../store";

const SHORTCUTS: [string, string][] = [
  ["Space", "播放 / 暂停"],
  ["← / →", "后退 10 秒 / 前进 10 秒"],
  ["[ / ]", "减速 / 加速播放"],
  ["M", "静音 / 取消静音"],
  ["C", "切换双语 / 中文 / 原文 / 关闭"],
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
    <>
      <section className="setup-block">
        <p className="setup-title">播放与字幕习惯</p>
        <label className="check">
          <input
            type="checkbox"
            checked={audioNextLine}
            onChange={(e) => savePrefs({ audioNextLine: e.target.checked })}
          />
          <span>纯音频舞台提前预告下一句字幕</span>
        </label>

        <div className="title-mode-row">
          <div className="title-mode-meta">
            <span className="title-mode-label">外文单集标题显示</span>
            <span className="muted small">播客与频道名称始终保持原名，仅频道简介自动辅助译为中文</span>
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

        <p className="muted small">
          主题风格与字幕/问答字号已移至左侧「外观」页签统一调整。
        </p>
      </section>

      <section className="setup-block">
        <p className="setup-title">全局快捷键</p>
        <div className="shortcut-grid">
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="shortcut-row">
              <kbd>{keys}</kbd>
              <span>{desc}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="setup-block">
        <div className="row-between">
          <div>
            <p className="setup-title">关于与版本更新</p>
            <p className="muted small">
              当前版本：<code>v{health?.version ?? "0.2.0"}</code>
              {updateInfo && !updateInfo.hasUpdate ? `（已是最新，最近检查 v${updateInfo.latestVersion}）` : ""}
              {updateInfo?.hasUpdate ? ` · 发现新版本 v${updateInfo.latestVersion}` : ""}
            </p>
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
      </section>
    </>
  );
}
