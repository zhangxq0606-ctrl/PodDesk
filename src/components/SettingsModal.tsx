import { useEffect } from "react";
import { Captions, Globe, Keyboard, Palette, Sparkles, X, type LucideIcon } from "lucide-react";
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
  const { open, section, closeSettings, openSettings, refreshAsrStatus } = useStore(
    useShallow((s) => ({
      open: s.settingsOpen,
      section: s.settingsSection,
      closeSettings: s.closeSettings,
      openSettings: s.openSettings,
      refreshAsrStatus: s.refreshAsrStatus,
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
            <nav className="settings-nav">
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
