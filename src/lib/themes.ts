export type LightThemeId = "stone-proof" | "linen-folio" | "silver-console" | "warm-paper";
export type DarkThemeId = "graphite-desk" | "darkroom-carbon" | "studio-slate" | "warm-charcoal";
export type PaletteId = LightThemeId | DarkThemeId;

export interface ThemeSeedPreview {
  canvas: string;
  accent: string;
}

export interface ThemeMeta<T extends PaletteId = PaletteId> {
  id: T;
  mode: "light" | "dark";
  name: string;
  desc: string;
  seed: ThemeSeedPreview;
  preview: {
    sidebar: string;
    bg: string;
    panel: string;
    card: string;
    line: string;
    text: string;
    muted: string;
    accent: string;
  };
}

export const DEFAULT_LIGHT_THEME: LightThemeId = "stone-proof";
export const DEFAULT_DARK_THEME: DarkThemeId = "graphite-desk";

const LEGACY_LIGHT_MIGRATION: Readonly<Record<string, LightThemeId>> = {
  "pure-morning": "silver-console",
  "bamboo-mist": "linen-folio",
  "apricot-study": "warm-paper",
};

const LEGACY_DARK_MIGRATION: Readonly<Record<string, DarkThemeId>> = {
  "deep-slate": "studio-slate",
  "obsidian-cinema": "graphite-desk",
  "pine-ink": "darkroom-carbon",
};

export const LIGHT_THEMES: ThemeMeta<LightThemeId>[] = [
  {
    id: "stone-proof",
    mode: "light",
    name: "素石校对",
    desc: "中性素石柔纸 · 普鲁士青点缀",
    seed: { canvas: "#eef0f4", accent: "#0f6270" },
    preview: {
      sidebar: "#e7eaef",
      bg: "#eef0f4",
      panel: "#f5f6f8",
      card: "#fafbfd",
      line: "#dfe2e8",
      text: "#171a20",
      muted: "#626874",
      accent: "#0f6270",
    },
  },
  {
    id: "linen-folio",
    mode: "light",
    name: "亚麻书页",
    desc: "低眩光亚麻底 · 深松青点缀",
    seed: { canvas: "#f0eee8", accent: "#1f6b56" },
    preview: {
      sidebar: "#e9e7e0",
      bg: "#f0eee8",
      panel: "#f7f5f0",
      card: "#fbf9f5",
      line: "#e0ded6",
      text: "#1a1d1b",
      muted: "#636863",
      accent: "#1f6b56",
    },
  },
  {
    id: "silver-console",
    mode: "light",
    name: "阳极银台",
    desc: "精密冷银灰 · 深钴蓝点缀",
    seed: { canvas: "#eceff5", accent: "#3d4fd1" },
    preview: {
      sidebar: "#e4e7ef",
      bg: "#eceff5",
      panel: "#f4f6fa",
      card: "#fafbfe",
      line: "#dde1ec",
      text: "#141824",
      muted: "#61677a",
      accent: "#3d4fd1",
    },
  },
  {
    id: "warm-paper",
    mode: "light",
    name: "暖宣纸",
    desc: "精修纸韵暖白 · 陶土点缀",
    seed: { canvas: "#f3efe7", accent: "#c95220" },
    preview: {
      sidebar: "#ebe5da",
      bg: "#f3efe7",
      panel: "#f9f6f0",
      card: "#fcfbf8",
      line: "#e4ded3",
      text: "#1f1c18",
      muted: "#6d665d",
      accent: "#c95220",
    },
  },
];

export const DARK_THEMES: ThemeMeta<DarkThemeId>[] = [
  {
    id: "graphite-desk",
    mode: "dark",
    name: "石墨仪器",
    desc: "中性石墨深炭 · 冰青点缀",
    seed: { canvas: "#12151a", accent: "#4fb3c2" },
    preview: {
      sidebar: "#0d0f13",
      bg: "#12151a",
      panel: "#171a20",
      card: "#1e222a",
      line: "#2b303b",
      text: "#eceff4",
      muted: "#9099a8",
      accent: "#4fb3c2",
    },
  },
  {
    id: "darkroom-carbon",
    mode: "dark",
    name: "暗室黑曜",
    desc: "深邃纯中性近黑 · 哑光黄铜",
    seed: { canvas: "#0c0d0f", accent: "#d6a856" },
    preview: {
      sidebar: "#08090b",
      bg: "#0c0d0f",
      panel: "#121316",
      card: "#191b1f",
      line: "#282b31",
      text: "#eef0f4",
      muted: "#9095a0",
      accent: "#d6a856",
    },
  },
  {
    id: "studio-slate",
    mode: "dark",
    name: "冷灰控台",
    desc: "通透中深中性灰 · 柔长春花蓝",
    seed: { canvas: "#181a1e", accent: "#7b9cff" },
    preview: {
      sidebar: "#131518",
      bg: "#181a1e",
      panel: "#1f2227",
      card: "#272b31",
      line: "#363b44",
      text: "#f0f2f6",
      muted: "#9ea5b0",
      accent: "#7b9cff",
    },
  },
  {
    id: "warm-charcoal",
    mode: "dark",
    name: "净炭书房",
    desc: "克制中性暖炭 · 柔陶点缀",
    seed: { canvas: "#131312", accent: "#ea8a5c" },
    preview: {
      sidebar: "#0e0e0d",
      bg: "#131312",
      panel: "#191918",
      card: "#21211f",
      line: "#2f2f2c",
      text: "#efeee9",
      muted: "#96958e",
      accent: "#ea8a5c",
    },
  },
];

const LIGHT_ID_SET = new Set<string>(LIGHT_THEMES.map((t) => t.id));
const DARK_ID_SET = new Set<string>(DARK_THEMES.map((t) => t.id));

export function normalizeLightTheme(id: unknown): LightThemeId {
  if (typeof id !== "string") return DEFAULT_LIGHT_THEME;
  if (LIGHT_ID_SET.has(id)) return id as LightThemeId;
  return LEGACY_LIGHT_MIGRATION[id] ?? DEFAULT_LIGHT_THEME;
}

export function normalizeDarkTheme(id: unknown): DarkThemeId {
  if (typeof id !== "string") return DEFAULT_DARK_THEME;
  if (DARK_ID_SET.has(id)) return id as DarkThemeId;
  return LEGACY_DARK_MIGRATION[id] ?? DEFAULT_DARK_THEME;
}

export function getLightThemeMeta(id: LightThemeId): ThemeMeta<LightThemeId> {
  return LIGHT_THEMES.find((t) => t.id === id) ?? LIGHT_THEMES[0];
}

export function getDarkThemeMeta(id: DarkThemeId): ThemeMeta<DarkThemeId> {
  return DARK_THEMES.find((t) => t.id === id) ?? DARK_THEMES[0];
}

export function resolveEffectiveMode(mode: "system" | "light" | "dark"): "light" | "dark" {
  if (mode === "light" || mode === "dark") return mode;
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}
