export type LightThemeId = "warm-paper" | "pure-morning" | "bamboo-mist" | "apricot-study";
export type DarkThemeId = "warm-charcoal" | "deep-slate" | "obsidian-cinema" | "pine-ink";
export type PaletteId = LightThemeId | DarkThemeId;

export interface ThemeMeta<T extends PaletteId = PaletteId> {
  id: T;
  mode: "light" | "dark";
  name: string;
  desc: string;
  preview: {
    sidebar: string;
    bg: string;
    panel: string;
    line: string;
    text: string;
    muted: string;
    accent: string;
  };
}

export const DEFAULT_LIGHT_THEME: LightThemeId = "warm-paper";
export const DEFAULT_DARK_THEME: DarkThemeId = "warm-charcoal";

export const LIGHT_THEMES: ThemeMeta<LightThemeId>[] = [
  {
    id: "warm-paper",
    mode: "light",
    name: "暖宣纸",
    desc: "温和纸感暖白 · 陶土点缀",
    preview: {
      sidebar: "#efece5",
      bg: "#f7f5f0",
      panel: "#ffffff",
      line: "#e3dfd7",
      text: "#1c1a17",
      muted: "#9a9389",
      accent: "#d95b26",
    },
  },
  {
    id: "pure-morning",
    mode: "light",
    name: "晨光极简",
    desc: "清爽冷白画布 · 靛蓝点缀",
    preview: {
      sidebar: "#eff1f5",
      bg: "#f7f8fa",
      panel: "#ffffff",
      line: "#dfe4ec",
      text: "#141821",
      muted: "#8792a4",
      accent: "#3b6cf5",
    },
  },
  {
    id: "bamboo-mist",
    mode: "light",
    name: "柔雾青笺",
    desc: "护眼低饱和青灰 · 深松点缀",
    preview: {
      sidebar: "#e8eee8",
      bg: "#f2f5f2",
      panel: "#fafcfa",
      line: "#d7e1d8",
      text: "#19241e",
      muted: "#7c8e83",
      accent: "#2d7a62",
    },
  },
  {
    id: "apricot-study",
    mode: "light",
    name: "柔杏书房",
    desc: "柔和奶油杏纸 · 玫瑰陶点缀",
    preview: {
      sidebar: "#f2e9df",
      bg: "#faf4ed",
      panel: "#fffcf8",
      line: "#e5d9cc",
      text: "#2b211e",
      muted: "#99857d",
      accent: "#b85262",
    },
  },
];

export const DARK_THEMES: ThemeMeta<DarkThemeId>[] = [
  {
    id: "warm-charcoal",
    mode: "dark",
    name: "暖炭书房",
    desc: "温和暖炭黑灰 · 柔陶点缀",
    preview: {
      sidebar: "#100f0e",
      bg: "#151412",
      panel: "#1f1d1a",
      line: "#2f2c28",
      text: "#ece8e1",
      muted: "#888279",
      accent: "#ef8354",
    },
  },
  {
    id: "deep-slate",
    mode: "dark",
    name: "深夜石板",
    desc: "理性冷蓝石板 · 冰蓝点缀",
    preview: {
      sidebar: "#0e1218",
      bg: "#131820",
      panel: "#1c2430",
      line: "#2d3849",
      text: "#e7edf7",
      muted: "#7c8ca3",
      accent: "#6ea8fe",
    },
  },
  {
    id: "obsidian-cinema",
    mode: "dark",
    name: "黑曜影院",
    desc: "深邃近纯黑底 · 暖琥珀点缀",
    preview: {
      sidebar: "#08080a",
      bg: "#0d0d0f",
      panel: "#18181c",
      line: "#2a2a31",
      text: "#f0f0f3",
      muted: "#7f818e",
      accent: "#e8a246",
    },
  },
  {
    id: "pine-ink",
    mode: "dark",
    name: "松烟墨绿",
    desc: "沉静深松墨绿 · 黄铜点缀",
    preview: {
      sidebar: "#0d1411",
      bg: "#121b17",
      panel: "#1a2721",
      line: "#2a3c34",
      text: "#eaece6",
      muted: "#7f9185",
      accent: "#d4a857",
    },
  },
];

const LIGHT_ID_SET = new Set<string>(LIGHT_THEMES.map((t) => t.id));
const DARK_ID_SET = new Set<string>(DARK_THEMES.map((t) => t.id));

export function normalizeLightTheme(id: unknown): LightThemeId {
  return typeof id === "string" && LIGHT_ID_SET.has(id) ? (id as LightThemeId) : DEFAULT_LIGHT_THEME;
}

export function normalizeDarkTheme(id: unknown): DarkThemeId {
  return typeof id === "string" && DARK_ID_SET.has(id) ? (id as DarkThemeId) : DEFAULT_DARK_THEME;
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
