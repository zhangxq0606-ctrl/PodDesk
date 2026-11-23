/**
 * PodDesk OKLCH Theme Derivation Engine (zero-dependency, inspired by T3 Code's dual-seed model).
 * Given a pair of canvas + accent hex seeds, derives a complete 26-token palette with
 * low-chroma surface discipline and binary-solved WCAG 2.1 contrast guarantees.
 */

export interface OklchColor {
  L: number;
  C: number;
  h: number;
}

export interface ThemeSeed {
  mode: "light" | "dark";
  canvas: string;
  accent: string;
  sidebar?: string;
  overrides?: Partial<PodDeskThemeTokens>;
}

export interface PodDeskThemeTokens {
  sidebar: string;
  bg: string;
  panel: string;
  surfaceCard: string;
  elevated: string;
  overlay: string;
  surfaceBubble: string;
  track: string;
  hoverFill: string;
  activeFill: string;
  soft: string;
  softHover: string;
  line: string;
  lineStrong: string;
  rimTop: string;
  contactShadow: string;
  text: string;
  text2: string;
  muted: string;
  iconMuted: string;
  ink: string;
  onInk: string;
  accent: string;
  accentSoft: string;
  accentText: string;
  activeLine: string;
  mark: string;
  ok: string;
  okSoft: string;
  danger: string;
  dangerSoft: string;
}

const CSS_VAR_MAP: Readonly<Record<keyof PodDeskThemeTokens, string>> = {
  sidebar: "--sidebar",
  bg: "--bg",
  panel: "--panel",
  surfaceCard: "--surface-card",
  elevated: "--elevated",
  overlay: "--overlay",
  surfaceBubble: "--surface-bubble",
  track: "--track",
  hoverFill: "--hover-fill",
  activeFill: "--active-fill",
  soft: "--soft",
  softHover: "--soft-hover",
  line: "--line",
  lineStrong: "--line-strong",
  rimTop: "--rim-top",
  contactShadow: "--contact-shadow",
  text: "--text",
  text2: "--text-2",
  muted: "--muted",
  iconMuted: "--icon-muted",
  ink: "--ink",
  onInk: "--on-ink",
  accent: "--accent",
  accentSoft: "--accent-soft",
  accentText: "--accent-text",
  activeLine: "--active-line",
  mark: "--mark",
  ok: "--ok",
  okSoft: "--ok-soft",
  danger: "--danger",
  dangerSoft: "--danger-soft",
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  const x = clamp01(c);
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

export function parseHex(hex: string): [number, number, number] {
  const clean = hex.trim().replace(/^#/, "");
  const full =
    clean.length === 3
      ? `${clean[0]}${clean[0]}${clean[1]}${clean[1]}${clean[2]}${clean[2]}`
      : clean.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const toByte = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${toByte(r)}${toByte(g)}${toByte(b)}`;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * srgbToLinear(r / 255) + 0.7152 * srgbToLinear(g / 255) + 0.0722 * srgbToLinear(b / 255);
}

export function contrastRatio(hexA: string, hexB: string): number {
  const lumA = relativeLuminance(hexA);
  const lumB = relativeLuminance(hexB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

export function hexToOklch(hex: string): OklchColor {
  const [r8, g8, b8] = parseHex(hex);
  const r = srgbToLinear(r8 / 255);
  const g = srgbToLinear(g8 / 255);
  const b = srgbToLinear(b8 / 255);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bLab = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;

  const C = Math.hypot(a, bLab);
  const rawHue = C < 1e-6 ? 0 : (Math.atan2(bLab, a) * 180) / Math.PI;
  const h = rawHue < 0 ? rawHue + 360 : rawHue;
  return { L, C, h };
}

function oklchToLinearRgb(L: number, C: number, h: number): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = C * Math.cos(rad);
  const bLab = C * Math.sin(rad);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * bLab;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * bLab;
  const s_ = L - 0.0894841775 * a - 1.291485548 * bLab;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return [
    +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function inGamut([r, g, b]: [number, number, number]): boolean {
  const eps = 1e-4;
  return r >= -eps && r <= 1 + eps && g >= -eps && g <= 1 + eps && b >= -eps && b <= 1 + eps;
}

export function oklchToHex(L: number, C: number, h: number): string {
  const safeL = clamp01(L);
  if (safeL <= 0) return "#000000";
  if (safeL >= 1) return "#ffffff";

  let low = 0;
  let high = Math.max(0, C);
  let rgb = oklchToLinearRgb(safeL, high, h);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 16; i += 1) {
      const mid = (low + high) / 2;
      const probe = oklchToLinearRgb(safeL, mid, h);
      if (inGamut(probe)) {
        low = mid;
        rgb = probe;
      } else {
        high = mid;
      }
    }
  }
  return rgbToHex(
    linearToSrgb(rgb[0]) * 255,
    linearToSrgb(rgb[1]) * 255,
    linearToSrgb(rgb[2]) * 255,
  );
}

/**
 * Binary-search perceptual lightness L in OKLCH until `minContrast` is achieved against every bg in `backgrounds`.
 */
export function solveOklchLightness(
  backgrounds: string | readonly string[],
  hue: number,
  chroma: number,
  minContrast: number,
  dir: "lighter" | "darker",
  initialL?: number,
): string {
  const bgList = typeof backgrounds === "string" ? [backgrounds] : backgrounds;
  const minContrastAgainst = (hex: string) =>
    Math.min(...bgList.map((bg) => contrastRatio(hex, bg)));

  if (initialL !== undefined) {
    const candidate = oklchToHex(initialL, chroma, hue);
    if (minContrastAgainst(candidate) >= minContrast) {
      return candidate;
    }
  }

  let lo = dir === "lighter" ? 0.42 : 0.04;
  let hi = dir === "lighter" ? 0.99 : 0.72;
  let best = dir === "lighter" ? "#f5f5f5" : "#141414";

  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    const hex = oklchToHex(mid, chroma, hue);
    if (minContrastAgainst(hex) >= minContrast) {
      best = hex;
      if (dir === "lighter") hi = mid;
      else lo = mid;
    } else {
      if (dir === "lighter") lo = mid;
      else hi = mid;
    }
  }
  return best;
}

function hexToRgba(hex: string, alpha: number): string {
  const [r, g, b] = parseHex(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function mixHex(hexA: string, hexB: string, weightB: number): string {
  const [r1, g1, b1] = parseHex(hexA);
  const [r2, g2, b2] = parseHex(hexB);
  const t = clamp01(weightB);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

/**
 * Derive a full 26-token PodDesk palette from `{ mode, canvas, accent }` seeds.
 */
export function derivePodDeskTheme(seed: ThemeSeed): PodDeskThemeTokens {
  const canvasOklch = hexToOklch(seed.canvas);
  const accentOklch = hexToOklch(seed.accent);
  const isDark = seed.mode === "dark";

  const surfaceHue = accentOklch.C < 0.02 ? canvasOklch.h : accentOklch.h;
  const tintC = Math.min(0.028, Math.max(0.004, accentOklch.C * 0.22));
  const surfaceAt = (L: number, cScale = 1) => oklchToHex(L, tintC * cScale, surfaceHue);

  // Surface elevation ladder: sidebar < bg < panel < surfaceCard < elevated <= overlay
  const bg = seed.canvas;
  const sidebar =
    seed.sidebar ??
    surfaceAt(isDark ? Math.max(0.11, canvasOklch.L - 0.032) : Math.max(0.88, canvasOklch.L - 0.02), 1.05);
  const panel = isDark
    ? surfaceAt(Math.min(0.28, canvasOklch.L + 0.028))
    : surfaceAt(Math.min(0.976, canvasOklch.L + 0.022), 0.72);
  const surfaceCard = isDark
    ? surfaceAt(Math.min(0.32, canvasOklch.L + 0.058))
    : surfaceAt(Math.min(0.99, canvasOklch.L + 0.038), 0.48);
  const elevated = isDark ? surfaceAt(Math.min(0.37, canvasOklch.L + 0.095)) : "#ffffff";
  const overlay = isDark ? hexToRgba(surfaceAt(Math.min(0.36, canvasOklch.L + 0.088)), 0.94) : "#ffffff";
  const overlayOpaque = isDark ? surfaceAt(Math.min(0.36, canvasOklch.L + 0.088)) : "#ffffff";
  const surfaceBubble = isDark
    ? surfaceAt(Math.min(0.37, canvasOklch.L + 0.09), 0.95)
    : mixHex(sidebar, bg, 0.25);
  const track = isDark
    ? surfaceAt(Math.min(0.29, canvasOklch.L + 0.036))
    : mixHex(sidebar, bg, 0.15);

  const dir: "lighter" | "darker" = isDark ? "lighter" : "darker";
  const textSurfaces = [bg, panel, surfaceCard, surfaceBubble, overlayOpaque];
  const text = solveOklchLightness(textSurfaces, surfaceHue, tintC * 0.55, 12.5, dir, isDark ? 0.94 : 0.2);
  const text2 = solveOklchLightness([bg, panel, surfaceCard], surfaceHue, tintC * 0.85, 6.8, dir, isDark ? 0.78 : 0.41);
  // T3 Code insight: dark muted floor (~5.15:1) sits higher than light (~4.65:1) to prevent dark halation
  const mutedTarget = isDark ? 5.15 : 4.65;
  const muted = solveOklchLightness([bg, panel, surfaceCard], surfaceHue, tintC * 0.9, mutedTarget, dir);
  const iconMuted = muted;

  const ink = isDark ? solveOklchLightness([bg, panel], surfaceHue, tintC * 0.5, 12.0, "lighter", 0.93) : text;
  const onInk = isDark ? bg : surfaceCard;

  const activeLine = mixHex(panel, seed.accent, isDark ? 0.12 : 0.09);
  const accentText = solveOklchLightness(
    [panel, surfaceCard, activeLine],
    accentOklch.h,
    Math.min(0.18, Math.max(0.06, accentOklch.C)),
    4.65,
    dir,
    accentOklch.L,
  );

  const hoverFill = isDark ? "rgba(255, 255, 255, 0.055)" : hexToRgba(text, 0.045);
  const activeFill = isDark ? "rgba(255, 255, 255, 0.095)" : hexToRgba(text, 0.085);
  const soft = isDark ? surfaceAt(Math.min(0.32, canvasOklch.L + 0.062)) : mixHex(bg, text, 0.065);
  const softHover = isDark ? surfaceAt(Math.min(0.36, canvasOklch.L + 0.096)) : mixHex(bg, text, 0.115);

  const line = isDark ? "rgba(240, 244, 250, 0.085)" : hexToRgba(text, 0.08);
  const lineStrong = isDark ? "rgba(240, 244, 250, 0.17)" : hexToRgba(text, 0.15);
  const rimTop = isDark ? "inset 0 1px 0 rgba(255, 255, 255, 0.065)" : "inset 0 1px 0 rgba(255, 255, 255, 0.85)";
  const contactShadow = isDark
    ? "none"
    : "0 1px 2px rgba(18, 22, 28, 0.055), 0 0 0 1px rgba(18, 22, 28, 0.03)";

  const okBase = isDark ? "#4ec499" : "#1d7a58";
  const dangerBase = isDark ? "#f2746b" : "#c0392b";

  const derived: PodDeskThemeTokens = {
    sidebar,
    bg,
    panel,
    surfaceCard,
    elevated,
    overlay,
    surfaceBubble,
    track,
    hoverFill,
    activeFill,
    soft,
    softHover,
    line,
    lineStrong,
    rimTop,
    contactShadow,
    text,
    text2,
    muted,
    iconMuted,
    ink,
    onInk,
    accent: seed.accent,
    accentSoft: hexToRgba(seed.accent, isDark ? 0.16 : 0.11),
    accentText,
    activeLine,
    mark: hexToRgba(seed.accent, isDark ? 0.28 : 0.2),
    ok: okBase,
    okSoft: hexToRgba(okBase, isDark ? 0.16 : 0.12),
    danger: dangerBase,
    dangerSoft: hexToRgba(dangerBase, isDark ? 0.16 : 0.11),
  };

  return seed.overrides ? { ...derived, ...seed.overrides } : derived;
}

export function applyDerivedTheme(root: HTMLElement, tokens: PodDeskThemeTokens): void {
  for (const [key, cssVar] of Object.entries(CSS_VAR_MAP) as Array<[keyof PodDeskThemeTokens, string]>) {
    root.style.setProperty(cssVar, tokens[key]);
  }
  root.style.setProperty("--inset-hi", tokens.rimTop);
}

export function clearDerivedTheme(root: HTMLElement): void {
  for (const cssVar of Object.values(CSS_VAR_MAP)) {
    root.style.removeProperty(cssVar);
  }
  root.style.removeProperty("--inset-hi");
}
