import { useEffect } from "react";
import { ArrowDownToLine, Captions, Globe, Keyboard, Loader2, Palette, RefreshCw, Sparkles, X, type LucideIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useStore, type SettingsSection } from "../store";
import { AiSettingsSection } from "./settings/AiSettingsSection";
import { AppearanceSettingsSection } from "./settings/AppearanceSettingsSection";
import { AsrSettingsSection } from "./settings/AsrSettingsSection";
import { NetworkSettingsSection } from "./settings/NetworkSettingsSection";
import { ReadingSettingsSection } from "./settings/ReadingSettingsSection";

const NAV: [SettingsSection, string, LucideIcon][] = [
  ["appearance", "外观", Palette],
  ["asr", "字幕与转写", Captions],
  ["ai", "AI 模型与 Agent", Sparkles],
  ["network", "网络与风控", Globe],
  ["reading", "阅读与快捷键", Keyboard],
];

export function SettingsModal() {
  const {
    open,
    section,
    health,
    updateInfo,
    checkingUpdate,
    closeSettings,
    openSettings,
    refreshAsrStatus,
    checkUpdate,
    setUpdateModalOpen,
    notify,
  } = useStore(
    useShallow((s) => ({
      open: s.settingsOpen,
      section: s.settingsSection,
      health: s.health,
      updateInfo: s.updateInfo,
      checkingUpdate: s.checkingUpdate,
      closeSettings: s.closeSettings,
      openSettings: s.openSettings,
      refreshAsrStatus: s.refreshAsrStatus,
      checkUpdate: s.checkUpdate,
      setUpdateModalOpen: s.setUpdateModalOpen,
      notify: s.notify,
    })),
  );

  useEffect(() => {
    if (!open) return;
    void refreshAsrStatus().catch(() => {});
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeSettings, refreshAsrStatus]);

  if (!open) return null;

  const handleVersionClick = async () => {
    if (updateInfo?.hasUpdate) {
      setUpdateModalOpen(true);
      return;
    }
    if (checkingUpdate) return;
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
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-head">
          <h3>设置</h3>
          <button type="button" className="icon-btn" onClick={closeSettings} aria-label="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="settings">
            <nav className="settings-nav" aria-label="设置分类">
              <div className="settings-nav-list">
                {NAV.map(([k, label, Icon]) => (
                  <button
                    key={k}
                    type="button"
                    className={section === k ? "on" : ""}
                    onClick={() => openSettings(k)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>

              <button
                type="button"
                className={`settings-nav-foot ${updateInfo?.hasUpdate ? "has-update" : ""}`}
                onClick={() => void handleVersionClick()}
                disabled={checkingUpdate}
                title={updateInfo?.hasUpdate ? `查看新版本 v${updateInfo.latestVersion}` : "点击检查更新"}
              >
                <span className="settings-nav-ver">
                  <span>PodDesk v{health?.version ?? "0.2.3"}</span>
                  {updateInfo?.hasUpdate && <span className="settings-update-dot" aria-label="有新版本" />}
                </span>
                <span className="settings-nav-hint">
                  {checkingUpdate ? (
                    <Loader2 size={12} className="spin" />
                  ) : updateInfo?.hasUpdate ? (
                    <ArrowDownToLine size={12} />
                  ) : (
                    <RefreshCw size={12} />
                  )}
                  <span>
                    {checkingUpdate
                      ? "检查中..."
                      : updateInfo?.hasUpdate
                        ? `查看新版 v${updateInfo.latestVersion}`
                        : "检查更新"}
                  </span>
                </span>
              </button>
            </nav>

            <div className="settings-body">
              {section === "appearance" && <AppearanceSettingsSection />}
              {section === "asr" && <AsrSettingsSection />}
              {section === "ai" && <AiSettingsSection />}
              {section === "network" && <NetworkSettingsSection />}
              {section === "reading" && <ReadingSettingsSection />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
