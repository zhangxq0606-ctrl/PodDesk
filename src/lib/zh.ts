import { useEffect } from "react";
import { create } from "zustand";
import { useStore, type TitleDisplayMode } from "../store";
import { api } from "./api";

const CJK_RE = /[\u4e00-\u9fff]/g;
const NON_ZH_SCRIPT_RE = /[A-Za-z\u00c0-\u024f\u3040-\u30ff\uac00-\ud7af]/;
const TRANSLITERATION_RE = /^[\u4e00-\u9fff]{1,8}(?:\s*[·•・]\s*[\u4e00-\u9fff]{1,8})+$/;
const FAILURE_COOLDOWN_MS = 60_000;

/** Returns true when text already has >= 25% Chinese characters. */
export function isMostlyChineseText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const cjk = (trimmed.match(CJK_RE) ?? []).length;
  const nonWs = trimmed.replace(/\s+/g, "").length;
  return cjk > 0 && cjk >= nonWs * 0.25;
}

/** Filters pure person-name transliterations like "阿里·阿布达尔" on show labels. */
export function isPureTransliteration(zh: string): boolean {
  return TRANSLITERATION_RE.test(zh.trim());
}

/** Returns true when a title/snippet is worth auto-translating to Chinese. */
export function shouldTranslateTitle(text: string | undefined | null): boolean {
  const clean = (text ?? "").trim();
  if (clean.length < 2) return false;
  if (isMostlyChineseText(clean)) return false;
  return NON_ZH_SCRIPT_RE.test(clean);
}

const useZhStore = create<{ map: Record<string, string> }>(() => ({ map: {} }));
const queued = new Set<string>();
const inFlight = new Set<string>();
const failedAt = new Map<string, number>();
let flushTimer: number | undefined;

async function flush(): Promise<void> {
  flushTimer = undefined;
  const batch = [...queued].slice(0, 40);
  if (!batch.length) return;
  for (const t of batch) {
    queued.delete(t);
    inFlight.add(t);
  }
  if (queued.size > 0) {
    flushTimer = window.setTimeout(() => void flush(), 60);
  }
  try {
    const res = await api.translateGoogle(batch, "zh-CN");
    const items = res.items ?? [];
    useZhStore.setState((s) => {
      const nextMap = { ...s.map };
      batch.forEach((src, i) => {
        const dst = items[i]?.trim();
        if (dst) {
          nextMap[src] = dst;
          failedAt.delete(src);
        } else {
          failedAt.set(src, Date.now());
        }
      });
      return { map: nextMap };
    });
  } catch {
    const now = Date.now();
    for (const src of batch) {
      failedAt.set(src, now);
    }
  } finally {
    for (const src of batch) {
      inFlight.delete(src);
    }
  }
}

function requestTitle(clean: string): void {
  if (!clean || !shouldTranslateTitle(clean)) return;
  if (useZhStore.getState().map[clean] || queued.has(clean) || inFlight.has(clean)) return;
  const prevErr = failedAt.get(clean);
  if (prevErr && Date.now() - prevErr < FAILURE_COOLDOWN_MS) return;
  queued.add(clean);
  if (!flushTimer) {
    flushTimer = window.setTimeout(() => void flush(), 50);
  }
}

/** Lazy-fetches a cached Chinese translation for any foreign title or short text. */
export function useTitleZh(text: string | undefined | null, enabledOverride?: boolean): string | undefined {
  const prefEnabled = useStore((s) => s.prefs.autoTranslateTitles);
  const enabled = enabledOverride ?? prefEnabled;
  const clean = (text ?? "").trim();
  const translatable = enabled && shouldTranslateTitle(clean);
  const raw = useZhStore((s) => (translatable ? s.map[clean] : undefined));

  useEffect(() => {
    if (translatable && !useZhStore.getState().map[clean]) {
      requestTitle(clean);
    }
  }, [translatable, clean]);

  if (!translatable || !raw) return undefined;
  const zh = raw.trim();
  return zh && zh !== clean ? zh : undefined;
}

/** Same as useTitleZh, but suppresses awkward pure person-name transliterations on show names. */
export function useShowTitleZh(title: string | undefined | null): string | undefined {
  const zh = useTitleZh(title);
  if (!zh || isPureTransliteration(zh)) return undefined;
  return zh;
}

/** Resolves primary/secondary display lines for an episode title according to user preference. */
export function resolveEpisodeTitleDisplay(
  title: string,
  zh: string | undefined,
  mode: TitleDisplayMode,
): { primary: string; secondary?: string } {
  if (!zh || mode === "orig-only") return { primary: title };
  if (mode === "orig-first") return { primary: title, secondary: zh };
  return { primary: zh, secondary: title };
}

/** Lazily translates foreign episode titles and orders primary/secondary text per titleDisplayMode. */
export function useEpisodeTitleDisplay(text: string | undefined | null): { primary: string; secondary?: string } {
  const mode = useStore((s) => s.prefs.titleDisplayMode);
  const raw = text ?? "";
  const zh = useTitleZh(raw, mode !== "orig-only");
  return resolveEpisodeTitleDisplay(raw, zh, mode);
}

/** Synchronous cache lookup for client-side search filtering. */
export function getCachedTitleZh(text: string | undefined | null): string | undefined {
  if (!useStore.getState().prefs.autoTranslateTitles) return undefined;
  const clean = (text ?? "").trim();
  if (!shouldTranslateTitle(clean)) return undefined;
  const zh = useZhStore.getState().map[clean]?.trim();
  return zh && zh !== clean ? zh : undefined;
}
