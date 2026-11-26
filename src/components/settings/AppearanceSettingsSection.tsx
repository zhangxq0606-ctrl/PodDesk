import { Check, Moon, Sun } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import {
  DARK_THEMES,
  getDarkThemeMeta,
  getLightThemeMeta,
  LIGHT_THEMES,
  resolveEffectiveMode,
  type PaletteId,
  type ThemeMeta,
} from "../../lib/themes";
import { useStore, type ThemeMode } from "../../store";

function ThemeGrid<T extends PaletteId>({
  themes,
  selectedId,
  isModeActive,
  onSelect,
}: {
  themes: ThemeMeta<T>[];
  selectedId: T;
  isModeActive: boolean;
  onSelect: (id: T) => void;
}) {
  return (
    <div className="theme-grid" role="radiogroup">
      {themes.map((item) => {
        const picked = item.id === selectedId;
        const p = item.preview;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={picked}
            className={`theme-card ${picked ? "on" : ""} ${picked && isModeActive ? "live" : ""}`}
            onClick={() => onSelect(item.id)}
          >
            <div className="tc-mock" style={{ background: p.bg, borderColor: p.line }} aria-hidden>
              <div className="tc-side" style={{ background: p.sidebar, borderColor: p.line }}>
                <span className="tc-dot" style={{ background: p.accent }} />
                <span className="tc-bar" style={{ background: p.text, opacity: 0.3 }} />
                <span className="tc-bar short" style={{ background: p.muted, opacity: 0.45 }} />
              </div>
              <div className="tc-main" style={{ background: p.panel }}>
                <div className="tc-panel" style={{ background: p.card, borderColor: p.line }}>
                  <span className="tc-line strong" style={{ background: p.text, opacity: 0.78 }} />
                  <span className="tc-line" style={{ background: p.muted, opacity: 0.55 }} />
                  <span className="tc-progress" style={{ background: p.line }}>
                    <span style={{ background: p.accent }} />
                  </span>
                </div>
                <div className="tc-rows">
                  <span className="tc-line" style={{ background: p.text, opacity: 0.42 }} />
                  <span className="tc-line short" style={{ background: p.muted, opacity: 0.42 }} />
                </div>
              </div>
              {picked && (
                <span
                  className={`tc-check ${isModeActive ? "" : "inactive"}`}
                  style={{ background: p.accent, color: item.mode === "dark" ? p.sidebar : "#ffffff" }}
                >
                  <Check size={10} strokeWidth={3} />
                </span>
              )}
            </div>
            <div className="tc-info">
              <span className="tc-name">{item.name}</span>
              <span className="tc-desc">{item.desc}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function AppearanceSettingsSection() {
  const { prefs, savePrefs } = useStore(
    useShallow((s) => ({
      prefs: s.prefs,
      savePrefs: s.savePrefs,
    })),
  );

  const effectiveMode = resolveEffectiveMode(prefs.theme);
  const activeThemeName =
    effectiveMode === "dark" ? getDarkThemeMeta(prefs.darkTheme).name : getLightThemeMeta(prefs.lightTheme).name;

  return (
    <div className="settings-pane">
      <div className="settings-head">
        <div>
          <h4>外观与排版</h4>
          <p>浅色与深色各自独立记忆风格，顶栏开关可一键互切 · 当前生效：{activeThemeName}</p>
        </div>
        <div className="seg-control" role="radiogroup" aria-label="明暗模式">
          {(
            [
              ["system", "跟随系统"],
              ["light", "浅色"],
              ["dark", "深色"],
            ] as [ThemeMode, string][]
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={prefs.theme === k}
              className={prefs.theme === k ? "on" : ""}
              onClick={() => savePrefs({ theme: k })}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <section className="s-group">
        <div className="theme-section-head">
          <Sun size={14} />
          <span className="s-group-title">浅色主题</span>
          <span className="muted small">白天浏览与纸感长文阅读</span>
        </div>
        <ThemeGrid
          themes={LIGHT_THEMES}
          selectedId={prefs.lightTheme}
          isModeActive={effectiveMode === "light"}
          onSelect={(id) =>
            savePrefs(effectiveMode === "light" ? { lightTheme: id } : { lightTheme: id, theme: "light" })
          }
        />
      </section>

      <section className="s-group">
        <div className="theme-section-head">
          <Moon size={14} />
          <span className="s-group-title">深色主题</span>
          <span className="muted small">低光专注、视频沉浸与护眼夜间精读</span>
        </div>
        <ThemeGrid
          themes={DARK_THEMES}
          selectedId={prefs.darkTheme}
          isModeActive={effectiveMode === "dark"}
          onSelect={(id) =>
            savePrefs(effectiveMode === "dark" ? { darkTheme: id } : { darkTheme: id, theme: "dark" })
          }
        />
      </section>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">阅读字号与实时预览</span>
        </div>
        <div className="s-card">
          <div className="reading-preview">
            <div className="reading-preview-lane">
              <span className="reading-preview-tag">字幕预览</span>
              <p className="zh">最重要的是，学习的速度要比世界变化的速度更快。</p>
              <p className="orig">The most important thing is to keep learning faster than the world changes.</p>
            </div>
            <div className="reading-preview-lane">
              <span className="reading-preview-tag">问答与导读预览</span>
              <div className="markdown reading-preview-md">
                <p>这里实时反映右侧提问回答与章节导读正文的排版字号与行距。</p>
              </div>
            </div>
          </div>

          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label">字幕字号</span>
              <span className="s-row-desc">作用于左侧字幕逐句列表与音频舞台提词</span>
            </div>
            <div className="seg-control">
              {(
                [
                  ["s", "小"],
                  ["m", "标准"],
                  ["l", "大"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={prefs.subtitleSize === k ? "on" : ""}
                  onClick={() => savePrefs({ subtitleSize: k })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label">问答与导读字号</span>
              <span className="s-row-desc">作用于右侧 AI 问答内容与节目导读正文</span>
            </div>
            <div className="seg-control">
              {(
                [
                  ["m", "标准"],
                  ["l", "大"],
                ] as const
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  className={prefs.chatSize === k ? "on" : ""}
                  onClick={() => savePrefs({ chatSize: k })}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
