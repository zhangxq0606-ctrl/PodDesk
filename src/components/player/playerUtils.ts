import { api, type Episode } from "../../lib/api";
import { useStore } from "../../store";

export const RATES = [0.8, 1, 1.15, 1.25, 1.5, 1.75, 2];

const VIDEO_EXT_RE = /\.(mp4|webm|mov|mkv)(?:$|\?)/i;
export function isVideoMediaUrl(url?: string | null): boolean {
  return !!url && VIDEO_EXT_RE.test(url);
}

const BLOCKED_KEY = "podcast-desk-yt-blocked";
function readBlockedIds(): string[] {
  try {
    return JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
}

export function wasYtBlocked(videoId?: string): boolean {
  return !!videoId && readBlockedIds().includes(videoId);
}

export function markYtBlocked(videoId?: string): void {
  if (!videoId || wasYtBlocked(videoId)) return;
  try {
    localStorage.setItem(BLOCKED_KEY, JSON.stringify([...readBlockedIds(), videoId].slice(-500)));
  } catch {
    /* ignore */
  }
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
  void api
    .setProgress(ep.id, seconds)
    .then((res) => {
      useStore.getState().syncProgressLocal(ep.id, seconds, res.completed);
    })
    .catch(() => {});
}

export function trackTime(ep: Episode, time: number, length?: number): void {
  const s = useStore.getState();
  if (s.current?.id !== ep.id) return;
  s.set({ time, ...(length && length > 0 ? { length } : {}) });
  if (Math.abs(time - lastSavedProgress) >= 10) {
    lastSavedProgress = time;
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
  const idx = RATES.indexOf(cur);
  const next = RATES[Math.min(RATES.length - 1, Math.max(0, (idx < 0 ? RATES.indexOf(1) : idx) + dir))];
  s.player?.setRate(next);
  s.savePrefs({ playbackRate: next });
  s.notify(`倍速 ${next}×`);
}

export function cycleRate(): void {
  const s = useStore.getState();
  const idx = RATES.indexOf(s.prefs.playbackRate);
  const next = RATES[(idx + 1) % RATES.length];
  s.player?.setRate(next);
  s.savePrefs({ playbackRate: next });
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
