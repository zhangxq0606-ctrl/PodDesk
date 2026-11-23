import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrastRatio, derivePodDeskTheme, hexToOklch, oklchToHex, relativeLuminance } from "../themeEngine";
import {
  DARK_THEMES,
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  getDarkThemeMeta,
  getLightThemeMeta,
  LIGHT_THEMES,
  normalizeDarkTheme,
  normalizeLightTheme,
  resolveEffectiveMode,
} from "../themes";

function parseThemeCssBlocks(): Record<string, Record<string, string>> {
  const css = readFileSync(resolve(import.meta.dirname, "../../themes.css"), "utf8");
  const blocks: Record<string, Record<string, string>> = {};
  const ruleRe = /\[data-palette="([a-z-]+)"\][^{]*\{([^}]+)\}/g;
  for (const match of css.matchAll(ruleRe)) {
    const [, paletteId, body] = match;
    const vars: Record<string, string> = {};
    for (const line of body.split(";")) {
      const m = line.match(/^\s*(--[a-z0-9-]+)\s*:\s*(.+?)\s*$/);
      if (m) vars[m[1]] = m[2];
    }
    blocks[paletteId] = vars;
  }
  return blocks;
}

describe("themes catalog and normalization", () => {
  it("normalizes valid theme ids, migrates legacy ids, and falls back on unknown inputs", () => {
    for (const t of LIGHT_THEMES) {
      expect(normalizeLightTheme(t.id)).toBe(t.id);
    }
    for (const t of DARK_THEMES) {
      expect(normalizeDarkTheme(t.id)).toBe(t.id);
    }

    expect(normalizeLightTheme("pure-morning")).toBe("silver-console");
    expect(normalizeLightTheme("bamboo-mist")).toBe("linen-folio");
    expect(normalizeLightTheme("apricot-study")).toBe("warm-paper");

    expect(normalizeDarkTheme("deep-slate")).toBe("studio-slate");
    expect(normalizeDarkTheme("obsidian-cinema")).toBe("graphite-desk");
    expect(normalizeDarkTheme("pine-ink")).toBe("darkroom-carbon");

    expect(normalizeLightTheme("nonexistent")).toBe(DEFAULT_LIGHT_THEME);
    expect(normalizeLightTheme(123)).toBe(DEFAULT_LIGHT_THEME);
    expect(normalizeLightTheme(null)).toBe(DEFAULT_LIGHT_THEME);

    expect(normalizeDarkTheme("warm-paper")).toBe(DEFAULT_DARK_THEME);
    expect(normalizeDarkTheme(undefined)).toBe(DEFAULT_DARK_THEME);
  });

  it("resolves theme metadata and effective mode safely in Node", () => {
    expect(getLightThemeMeta("stone-proof").mode).toBe("light");
    expect(getDarkThemeMeta("graphite-desk").mode).toBe("dark");
    expect(resolveEffectiveMode("light")).toBe("light");
    expect(resolveEffectiveMode("dark")).toBe("dark");
    expect(resolveEffectiveMode("system")).toBe("light");
  });

  it("enforces WCAG contrast floors and matte non-white panels across all built-in CSS themes", () => {
    const cssBlocks = parseThemeCssBlocks();

    for (const meta of LIGHT_THEMES) {
      const v = cssBlocks[meta.id];
      expect(v, `missing CSS block for light theme ${meta.id}`).toBeDefined();
      expect(v["--panel"]).not.toBe("#ffffff");
      expect(contrastRatio(v["--text"], v["--panel"])).toBeGreaterThanOrEqual(12);
      expect(contrastRatio(v["--text-2"], v["--panel"])).toBeGreaterThanOrEqual(6.5);
      expect(contrastRatio(v["--muted"], v["--bg"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(v["--muted"], v["--panel"])).toBeGreaterThanOrEqual(4.6);
      expect(contrastRatio(v["--muted"], v["--surface-card"])).toBeGreaterThanOrEqual(4.6);
      expect(contrastRatio(v["--accent-text"], v["--panel"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(v["--accent-text"], v["--active-line"])).toBeGreaterThanOrEqual(4.5);
    }

    for (const meta of DARK_THEMES) {
      const v = cssBlocks[meta.id];
      expect(v, `missing CSS block for dark theme ${meta.id}`).toBeDefined();
      expect(contrastRatio(v["--text"], v["--panel"])).toBeGreaterThanOrEqual(12);
      expect(contrastRatio(v["--text-2"], v["--panel"])).toBeGreaterThanOrEqual(6.5);
      expect(contrastRatio(v["--muted"], v["--panel"])).toBeGreaterThanOrEqual(5.1);
      expect(contrastRatio(v["--muted"], v["--surface-card"])).toBeGreaterThanOrEqual(5.0);
      expect(contrastRatio(v["--text"], v["--surface-bubble"])).toBeGreaterThanOrEqual(10);
      expect(contrastRatio(v["--accent-text"], v["--panel"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(v["--accent-text"], v["--active-line"])).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("derives contrast-safe palettes from arbitrary canvas and accent seeds via OKLCH", () => {
    const sampleRoundtrip = oklchToHex(...Object.values(hexToOklch("#0f6270")) as [number, number, number]);
    expect(sampleRoundtrip).toMatch(/^#[0-9a-f]{6}$/);

    const lightSeeds = [
      { mode: "light" as const, canvas: "#eef0f4", accent: "#0f6270" },
      { mode: "light" as const, canvas: "#f5f1e8", accent: "#c73e1d" },
      { mode: "light" as const, canvas: "#edf2ef", accent: "#00c49a" },
    ];
    for (const seed of lightSeeds) {
      const t = derivePodDeskTheme(seed);
      expect(t.panel).not.toBe("#ffffff");
      expect(relativeLuminance(t.sidebar)).toBeLessThan(relativeLuminance(t.bg));
      expect(relativeLuminance(t.bg)).toBeLessThan(relativeLuminance(t.panel));
      expect(contrastRatio(t.text, t.panel)).toBeGreaterThanOrEqual(12);
      expect(contrastRatio(t.muted, t.bg)).toBeGreaterThanOrEqual(4.55);
      expect(contrastRatio(t.muted, t.surfaceCard)).toBeGreaterThanOrEqual(4.55);
      expect(contrastRatio(t.accentText, t.activeLine)).toBeGreaterThanOrEqual(4.5);
    }

    const darkSeeds = [
      { mode: "dark" as const, canvas: "#12151a", accent: "#4fb3c2" },
      { mode: "dark" as const, canvas: "#151218", accent: "#a86cf5" },
      { mode: "dark" as const, canvas: "#101614", accent: "#e8a246" },
    ];
    for (const seed of darkSeeds) {
      const t = derivePodDeskTheme(seed);
      expect(relativeLuminance(t.sidebar)).toBeLessThan(relativeLuminance(t.bg));
      expect(relativeLuminance(t.bg)).toBeLessThan(relativeLuminance(t.panel));
      expect(relativeLuminance(t.panel)).toBeLessThan(relativeLuminance(t.surfaceCard));
      expect(relativeLuminance(t.surfaceCard)).toBeLessThan(relativeLuminance(t.elevated));
      expect(contrastRatio(t.text, t.panel)).toBeGreaterThanOrEqual(12);
      expect(contrastRatio(t.muted, t.surfaceCard)).toBeGreaterThanOrEqual(5.05);
      expect(contrastRatio(t.text, t.surfaceBubble)).toBeGreaterThanOrEqual(10);
      expect(contrastRatio(t.accentText, t.activeLine)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
