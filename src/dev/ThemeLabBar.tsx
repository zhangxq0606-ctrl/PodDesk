import { useCallback, useEffect, useState } from "react";
import { ArrowUpDown, Minimize2, Moon, Sparkles, Sun, Type, Zap } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { resolveEffectiveMode, type DarkThemeId, type LightThemeId } from "../lib/themes";
import { useStore } from "../store";
import "./themeLab.css";

interface LabSlot {
  key: "0" | "1" | "2" | "3" | "4";
  label: string;
  light?: LightThemeId;
  dark?: DarkThemeId;
}

const LAB_SLOTS: readonly LabSlot[] = [
  { key: "0", label: "原版" },
  { key: "1", label: "素石×石墨", light: "stone-proof", dark: "graphite-desk" },
  { key: "2", label: "亚麻×黑曜", light: "linen-folio", dark: "darkroom-carbon" },
  { key: "3", label: "银台×冷灰", light: "silver-console", dark: "studio-slate" },
  { key: "4", label: "暖宣×净炭", light: "warm-paper", dark: "warm-charcoal" },
];

export function ThemeLabBar() {
  const { theme, lightTheme, darkTheme, savePrefs } = useStore(
    useShallow((s) => ({
      theme: s.prefs.theme,
      lightTheme: s.prefs.lightTheme,
      darkTheme: s.prefs.darkTheme,
      savePrefs: s.savePrefs,
    })),
  );

  const [isBaseline, setIsBaseline] = useState(false);
  const [craftOn, setCraftOn] = useState(true);
  const [serifOn, setSerifOn] = useState(true);
  const [motionOn, setMotionOn] = useState(true);
  const [collapsed, setCollapsed] = useState(false);
  const [dockTop, setDockTop] = useState(false);

  const effectiveMode = resolveEffectiveMode(theme);

  const activeSlot: LabSlot["key"] = isBaseline
    ? "0"
    : (LAB_SLOTS.find(
        (s) => s.key !== "0" && (effectiveMode === "dark" ? s.dark === darkTheme : s.light === lightTheme),
      )?.key ?? "1");

  useEffect(() => {
    const root = document.documentElement;
    if (isBaseline) root.setAttribute("data-lab", "baseline");
    else root.removeAttribute("data-lab");

    if (craftOn) root.removeAttribute("data-lab-craft");
    else root.setAttribute("data-lab-craft", "off");

    if (serifOn) root.removeAttribute("data-lab-font");
    else root.setAttribute("data-lab-font", "sans");

    if (motionOn) root.removeAttribute("data-lab-motion");
    else root.setAttribute("data-lab-motion", "off");
  }, [isBaseline, craftOn, serifOn, motionOn]);

  useEffect(() => {
    return () => {
      const root = document.documentElement;
      root.removeAttribute("data-lab");
      root.removeAttribute("data-lab-craft");
      root.removeAttribute("data-lab-font");
      root.removeAttribute("data-lab-motion");
    };
  }, []);

  const selectSlot = useCallback(
    (slot: LabSlot) => {
      if (slot.key === "0") {
        setIsBaseline(true);
        return;
      }
      setIsBaseline(false);
      if (slot.light && slot.dark) {
        savePrefs({ lightTheme: slot.light, darkTheme: slot.dark });
      }
    },
    [savePrefs],
  );

  const toggleMode = useCallback(() => {
    savePrefs({ theme: effectiveMode === "dark" ? "light" : "dark" });
  }, [effectiveMode, savePrefs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable]")) return;

      const k = e.key.toLowerCase();
      const slot = LAB_SLOTS.find((s) => s.key === k);
      if (slot) {
        e.preventDefault();
        selectSlot(slot);
      } else if (k === "t") {
        e.preventDefault();
        toggleMode();
      } else if (k === "g") {
        e.preventDefault();
        setCraftOn((v) => !v);
      } else if (k === "s") {
        e.preventDefault();
        setSerifOn((v) => !v);
      } else if (k === "a") {
        e.preventDefault();
        setMotionOn((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectSlot, toggleMode]);

  const currentSlotLabel = LAB_SLOTS.find((s) => s.key === activeSlot)?.label ?? "Theme Lab";

  if (collapsed) {
    return (
      <button
        type="button"
        className="theme-lab-pill"
        onClick={() => setCollapsed(false)}
        title="展开真机热切实验室 (?lab=1)"
      >
        <Sparkles size={12} />
        <span>
          Lab · {activeSlot} {currentSlotLabel} · {effectiveMode === "dark" ? "深" : "浅"}
        </span>
      </button>
    );
  }

  return (
    <div className={`theme-lab-bar ${dockTop ? "is-top" : ""}`} role="region" aria-label="Theme Lab 热切工具">
      <span className="theme-lab-tag">LAB</span>
      <div className="theme-lab-group">
        {LAB_SLOTS.map((slot) => (
          <button
            key={slot.key}
            type="button"
            className={`theme-lab-btn ${activeSlot === slot.key ? "on" : ""}`}
            onClick={() => selectSlot(slot)}
            title={`快捷键 ${slot.key}`}
          >
            <span className="theme-lab-kbd">{slot.key}</span>
            <span>{slot.label}</span>
          </button>
        ))}
      </div>

      <span className="theme-lab-sep" />

      <button
        type="button"
        className="theme-lab-btn"
        onClick={toggleMode}
        title="切换浅/深模式 (快捷键 T)"
      >
        {effectiveMode === "dark" ? <Moon size={12} /> : <Sun size={12} />}
        <span>{effectiveMode === "dark" ? "深色" : "浅色"}</span>
        <span className="theme-lab-kbd">T</span>
      </button>

      <button
        type="button"
        className={`theme-lab-btn ${serifOn && !isBaseline ? "on" : ""}`}
        onClick={() => setSerifOn((v) => !v)}
        disabled={isBaseline}
        title="切换杂志衬线混搭 / 纯无衬线 (快捷键 S)"
      >
        <Type size={12} />
        <span>{isBaseline ? "原版" : serifOn ? "衬线混搭" : "纯无衬线"}</span>
        <span className="theme-lab-kbd">S</span>
      </button>

      <button
        type="button"
        className={`theme-lab-btn ${craftOn && !isBaseline ? "on" : ""}`}
        onClick={() => setCraftOn((v) => !v)}
        disabled={isBaseline}
        title="开关微工艺对比 (快捷键 G)"
      >
        <Sparkles size={12} />
        <span>微工艺 {isBaseline ? "原版" : craftOn ? "开" : "关"}</span>
        <span className="theme-lab-kbd">G</span>
      </button>

      <button
        type="button"
        className={`theme-lab-btn ${motionOn && !isBaseline ? "on" : ""}`}
        onClick={() => setMotionOn((v) => !v)}
        disabled={isBaseline}
        title="开关微动效对比 (快捷键 A)"
      >
        <Zap size={12} />
        <span>微动效 {isBaseline ? "原版" : motionOn ? "开" : "关"}</span>
        <span className="theme-lab-kbd">A</span>
      </button>

      <span className="theme-lab-sep" />

      <button
        type="button"
        className="theme-lab-btn"
        onClick={() => setDockTop((v) => !v)}
        title="切换工具条停靠位置（顶部 / 底部）"
        aria-label="切换停靠位置"
      >
        <ArrowUpDown size={12} />
      </button>
      <button
        type="button"
        className="theme-lab-btn"
        onClick={() => setCollapsed(true)}
        title="折叠工具条"
        aria-label="折叠工具条"
      >
        <Minimize2 size={12} />
      </button>
    </div>
  );
}
