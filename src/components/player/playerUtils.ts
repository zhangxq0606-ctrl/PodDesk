import { api, type Episode } from "../../lib/api";
import { useStore } from "../../store";

export const RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** Perceptual cubic gain curve so 50% slider sounds like ~half loudness. */
export function perceptualVolumeGain(level: number): number {
  const clamped = Math.min(1, Math.max(0, level));
  return clamped <= 0 ? 0 : clamped * clamped * clamped;
}

const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv)(?:$|\?)/i;
export function isVideoMediaUrl(url?: string | null): boolean {
  return !!url && VIDEO_EXT_RE.test(url);
}

const BLOCKED_KEY = "podcast-desk-yt-blocked";
export const YT_BLOCKED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const YT_IFRAME_TIMEOUT_MS = 14_000;
export const MEDIA_STALL_TIMEOUT_MS = 14_000;

export interface BlockedYtEntry {
  id: string;
  at: number;
}

export function parseBlockedEntries(raw: string | null | undefined, now = Date.now()): BlockedYtEntry[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const latest = new Map<string, number>();
    for (const item of parsed) {
      if (
        item &&
        typeof item === "object" &&
        typeof (item as BlockedYtEntry).id === "string" &&
        typeof (item as BlockedYtEntry).at === "number" &&
        Number.isFinite((item as BlockedYtEntry).at)
      ) {
        const { id, at } = item as BlockedYtEntry;
        if (id && now - at < YT_BLOCKED_TTL_MS) {
          const prev = latest.get(id);
          if (prev === undefined || at > prev) latest.set(id, at);
        }
      }
      // Legacy plain-string entries have no timestamp; let them expire so old blocked videos re-probe once.
    }
    return Array.from(latest.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([id, at]) => ({ id, at }))
      .slice(-500);
  } catch {
    return [];
  }
}

function readBlockedEntries(now = Date.now()): BlockedYtEntry[] {
  try {
    return parseBlockedEntries(localStorage.getItem(BLOCKED_KEY), now);
  } catch {
    return [];
  }
}

function writeBlockedEntries(entries: BlockedYtEntry[]): void {
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify(entries.slice(-500)));
  } catch {
    /* ignore */
  }
}

export function wasYtBlocked(videoId?: string, now = Date.now()): boolean {
  return !!videoId && readBlockedEntries(now).some((e) => e.id === videoId);
}

export function markYtBlocked(videoId?: string, now = Date.now()): void {
  if (!videoId) return;
  const next = readBlockedEntries(now).filter((e) => e.id !== videoId);
  next.push({ id: videoId, at: now });
  writeBlockedEntries(next);
}

export function unmarkYtBlocked(videoId?: string, now = Date.now()): void {
  if (!videoId) return;
  const current = readBlockedEntries(now);
  const next = current.filter((e) => e.id !== videoId);
  if (next.length !== current.length) {
    writeBlockedEntries(next);
  }
}

interface InflightStream {
  ctrl: AbortController;
  promise: Promise<string>;
  activeHolders: number;
}

const inflightStreams = new Map<string, InflightStream>();

function createAbortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function requestYtStreamUrl(
  episodeId: string,
  opts?: {
    fresh?: boolean;
    signal?: AbortSignal;
    passive?: boolean;
    fetcher?: (episodeId: string, fresh: boolean, signal?: AbortSignal) => Promise<string>;
  },
): Promise<string> {
  const fresh = opts?.fresh ?? false;
  const passive = opts?.passive ?? false;
  const signal = opts?.signal;
  const fetcher =
    opts?.fetcher ??
    ((id: string, isFresh: boolean, sig?: AbortSignal) =>
      api.getStreamUrl(id, isFresh, sig).then((res) => {
        if (res.duration && res.duration > 0) {
          useStore.getState().syncEpisodeDurationLocal(id, res.duration);
        }
        return res.url;
      }));

  if (signal?.aborted) {
    return Promise.reject(createAbortError());
  }

  if (fresh) {
    const stale = inflightStreams.get(episodeId);
    if (stale) {
      stale.ctrl.abort();
      inflightStreams.delete(episodeId);
    }
    return fetcher(episodeId, true, signal);
  }

  let entry = inflightStreams.get(episodeId);
  if (!entry) {
    const ctrl = new AbortController();
    const created: InflightStream = {
      ctrl,
      activeHolders: 0,
      promise: Promise.resolve(""),
    };
    created.promise = fetcher(episodeId, false, ctrl.signal).finally(() => {
      if (inflightStreams.get(episodeId) === created) {
        inflightStreams.delete(episodeId);
      }
    });
    entry = created;
    inflightStreams.set(episodeId, entry);
  }

  if (!passive) {
    entry.activeHolders += 1;
  }

  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const releaseHolder = () => {
      if (!passive && entry.activeHolders > 0) {
        entry.activeHolders -= 1;
      }
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      releaseHolder();
      if (entry.activeHolders === 0) {
        entry.ctrl.abort();
        if (inflightStreams.get(episodeId) === entry) {
          inflightStreams.delete(episodeId);
        }
      }
      reject(createAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (url) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        releaseHolder();
        resolve(url);
      },
      (err) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        releaseHolder();
        reject(err);
      },
    );
  });
}

export function warmYtStreamUrl(episodeId: string, signal?: AbortSignal): Promise<string> {
  return requestYtStreamUrl(episodeId, { fresh: false, signal, passive: true });
}

declare global {
  interface Window {
    YT?: {
      Player: new (
        el: HTMLElement | string,
        opts: {
          host?: string;
          videoId: string;
          width?: string;
          height?: string;
          playerVars?: Record<string, string | number>;
          events?: {
            onReady?: (ev: { target: YTPlayerInstance }) => void;
            onStateChange?: (ev: { data: number }) => void;
            onError?: (ev: { data: number }) => void;
          };
        },
      ) => YTPlayerInstance;
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}

export interface YTPlayerInstance {
  seekTo: (seconds: number, allowSeekAhead?: boolean) => void;
  getCurrentTime: () => number;
  getDuration?: () => number;
  getPlayerState: () => number;
  playVideo: () => void;
  pauseVideo: () => void;
  setPlaybackRate?: (r: number) => void;
  setVolume?: (v: number) => void;
  mute?: () => void;
  unMute?: () => void;
  setOption?: (mod: string, key: string, val: unknown) => void;
  unloadModule?: (mod: string) => void;
  destroy: () => void;
}

let ytApiPromise: Promise<NonNullable<Window["YT"]>> | null = null;

export function loadYouTubeApi(): Promise<NonNullable<Window["YT"]>> {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    const prev = window.onYouTubeIframeAPIReady;
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    const fail = () => {
      window.clearTimeout(timer);
      ytApiPromise = null;
      script.remove();
      reject(new Error("无法加载 YouTube 播放器，请检查本机网络或代理"));
    };
    const timer = window.setTimeout(() => {
      if (!window.YT?.Player) fail();
    }, 12000);
    script.onerror = fail;
    window.onYouTubeIframeAPIReady = () => {
      window.clearTimeout(timer);
      prev?.();
      if (window.YT) resolve(window.YT);
      else fail();
    };
    document.head.appendChild(script);
  });
  return ytApiPromise;
}

export function hideYouTubeCaptions(player: YTPlayerInstance): void {
  try {
    player.setOption?.("captions", "track", {});
  } catch {
    /* ignore */
  }
  try {
    player.unloadModule?.("captions");
    player.unloadModule?.("cc");
  } catch {
    /* ignore */
  }
}

let lastSavedProgress = 0;

export function resetSavedProgress(seconds: number): void {
  lastSavedProgress = seconds;
}

export function persistProgress(ep: Episode, seconds: number): void {
  lastSavedProgress = seconds;
  useStore.getState().syncProgressLocal(ep.id, seconds, undefined, ep);
  void api
    .setProgress(ep.id, seconds)
    .then((res) => {
      if (res.completed !== undefined) {
        useStore.getState().syncProgressLocal(ep.id, seconds, res.completed, ep);
      }
    })
    .catch(() => {});
}

export function trackTime(ep: Episode, time: number, length?: number): void {
  const s = useStore.getState();
  if (s.current?.id !== ep.id) return;
  s.set({ time, ...(length && length > 0 ? { length } : {}) });
  if (Math.abs(time - lastSavedProgress) >= 10 || (time > 5 && lastSavedProgress <= 5)) {
    persistProgress(ep, time);
  }
}

export function activeSegIndex(segments: { start: number; end: number }[], time: number): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].start <= time + 0.15) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function stepRate(dir: 1 | -1): void {
  const s = useStore.getState();
  const cur = s.prefs.playbackRate;
  const max = s.player?.maxRate ?? RATES[RATES.length - 1];
  const next = Math.min(
    max,
    dir > 0
      ? (RATES.find((x) => x > cur + 0.001) ?? cur)
      : ([...RATES].reverse().find((x) => x < cur - 0.001) ?? cur),
  );
  s.player?.setRate(next);
  s.savePrefs({ playbackRate: next });
  s.notify(`倍速 ${next}×`);
}

export function cycleSubtitleMode(): void {
  const s = useStore.getState();
  const order = ["bilingual", "translation", "original", "off"] as const;
  const idx = order.indexOf(s.prefs.subtitleMode);
  const next = order[(idx + 1) % order.length];
  s.savePrefs({ subtitleMode: next });
  s.notify(
    next === "bilingual"
      ? "字幕：双语"
      : next === "translation"
        ? "字幕：仅中文"
        : next === "original"
          ? "字幕：仅原文"
          : "字幕：已关闭",
  );
}

export function toggleMute(): void {
  const s = useStore.getState();
  const muted = !s.prefs.muted;
  s.savePrefs({ muted });
  s.notify(muted ? "已静音" : "已取消静音");
}

export function stepVolume(dir: 1 | -1): void {
  const s = useStore.getState();
  const next = Math.min(1, Math.max(0, Math.round((s.prefs.volume + dir * 0.1) * 100) / 100));
  s.savePrefs({ volume: next, muted: next === 0 });
  s.notify(`音量 ${Math.round(next * 100)}%`);
}
