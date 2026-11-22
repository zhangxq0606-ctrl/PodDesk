import { useEffect, useMemo, useRef, useState } from "react";
import { Captions, CheckCircle2, ExternalLink, FileText, Headphones, Languages, Loader2, Pause, Play, Square, Tv, Volume1, Volume2, VolumeX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isMostlyChinese, pieceAt, pieceIndex, pieces } from "../lib/ai";
import { api, type Episode } from "../lib/api";
import { clock } from "../lib/format";
import { runTranslate, stopTranslate, useJobs } from "../lib/jobs";
import { useStore } from "../store";

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
function markYtBlocked(videoId?: string) {
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

interface YTPlayerInstance {
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

function loadYouTubeApi(): Promise<NonNullable<Window["YT"]>> {
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

function hideYouTubeCaptions(player: YTPlayerInstance) {
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

function persistProgress(ep: Episode, seconds: number) {
  void api
    .setProgress(ep.id, seconds)
    .then((res) => {
      useStore.getState().syncProgressLocal(ep.id, seconds, res.completed);
    })
    .catch(() => {});
}

function trackTime(ep: Episode, time: number, length?: number) {
  const s = useStore.getState();
  if (s.current?.id !== ep.id) return;
  s.set({ time, ...(length && length > 0 ? { length } : {}) });
  if (Math.abs(time - lastSavedProgress) >= 10) {
    lastSavedProgress = time;
    persistProgress(ep, time);
  }
}

function activeSegIndex(segments: { start: number; end: number }[], time: number): number {
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

export function stepRate(dir: 1 | -1) {
  const s = useStore.getState();
  const cur = s.prefs.playbackRate;
  const idx = RATES.indexOf(cur);
  const next = RATES[Math.min(RATES.length - 1, Math.max(0, (idx < 0 ? RATES.indexOf(1) : idx) + dir))];
  s.player?.setRate(next);
  s.savePrefs({ playbackRate: next });
  s.notify(`倍速 ${next}×`);
}

export function cycleRate() {
  const s = useStore.getState();
  const idx = RATES.indexOf(s.prefs.playbackRate);
  const next = RATES[(idx + 1) % RATES.length];
  s.player?.setRate(next);
  s.savePrefs({ playbackRate: next });
}

export function cycleSubtitleMode() {
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

export function toggleMute() {
  const s = useStore.getState();
  const muted = !s.prefs.muted;
  s.savePrefs({ muted });
  s.notify(muted ? "已静音" : "已取消静音");
}

export function stepVolume(dir: 1 | -1) {
  const s = useStore.getState();
  const next = Math.min(1, Math.max(0, Math.round((s.prefs.volume + dir * 0.1) * 100) / 100));
  s.savePrefs({ volume: next, muted: next === 0 });
  s.notify(`音量 ${Math.round(next * 100)}%`);
}

/** Root-level audio element so podcasts keep playing when browsing other views. */
export function AudioEngine() {
  const current = useStore((s) => s.current);
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);
  const ref = useRef<HTMLAudioElement>(null);

  const audio = current && !current.videoId && !isVideoMediaUrl(current.audioUrl) ? current : null;

  useEffect(() => {
    const el = ref.current;
    if (!el || !audio) return;
    lastSavedProgress = audio.progress ?? 0;
    const handle = {
      episodeId: audio.id,
      seek: (t: number) => {
        el.currentTime = t;
        void el.play().catch(() => {});
      },
      toggle: () => {
        if (el.paused) void el.play().catch(() => {});
        else el.pause();
      },
      play: () => {
        void el.play().catch(() => {});
      },
      setRate: (r: number) => {
        el.playbackRate = r;
      },
    };
    useStore.getState().offerPlayer(handle);
    return () => {
      useStore.getState().withdrawPlayer(handle);
    };
  }, [audio?.id]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate, audio?.id]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.volume = volume;
    ref.current.muted = muted;
  }, [volume, muted, audio?.id]);

  if (!audio || !audio.audioUrl) return null;

  return (
    <audio
      ref={ref}
      src={audio.audioUrl}
      preload="auto"
      onLoadedMetadata={(e) => {
        const el = e.currentTarget;
        el.playbackRate = useStore.getState().prefs.playbackRate;
        const s = useStore.getState();
        const startAt = s.current?.id === audio.id ? s.time : audio.progress;
        if (startAt > 3 && (!el.duration || startAt < el.duration - 5)) {
          el.currentTime = startAt;
        }
        trackTime(audio, el.currentTime, el.duration);
      }}
      onTimeUpdate={(e) => trackTime(audio, e.currentTarget.currentTime, e.currentTarget.duration)}
      onPlay={() => {
        const s = useStore.getState();
        s.set({ playing: true, loadingSince: ref.current && ref.current.readyState < 3 ? Date.now() : null });
      }}
      onWaiting={() => useStore.getState().set({ loadingSince: Date.now() })}
      onPlaying={() => useStore.getState().set({ loadingSince: null })}
      onPause={(e) => {
        useStore.getState().set({ playing: false, loadingSince: null });
        persistProgress(audio, e.currentTarget.currentTime);
      }}
      onEnded={(e) => {
        useStore.getState().set({ playing: false, loadingSince: null });
        persistProgress(audio, e.currentTarget.duration || e.currentTarget.currentTime);
      }}
      onError={() => {
        useStore.getState().set({ playing: false, loadingSince: null });
        useStore.getState().notify("音频加载失败，可能是网络或源地址失效", false);
      }}
    />
  );
}

function SubtitleOverlay({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const items = useJobs((s) => s.translations[ep.id]?.items);
  const time = useStore((s) => (s.current?.id === ep.id ? s.time : 0));
  const mode = useStore((s) => s.prefs.subtitleMode);
  if (mode === "off" || !transcript || !transcript.segments.length) return null;
  const idx = activeSegIndex(transcript.segments, time);
  const seg = transcript.segments[idx];
  if (!seg || time > seg.end + 1.5) return null;
  const zh = items?.[idx]?.trim();
  const progress = Math.min(1, Math.max(0, (time - seg.start) / Math.max(0.5, seg.end - seg.start)));
  const cjk = /[\u4e00-\u9fff]/.test(seg.text);
  return (
    <div className="subtitle-overlay notranslate" translate="no">
      <div className="sub-box">
        {zh && mode !== "original" && <p className="sub-zh">{pieceAt(zh, true, progress)}</p>}
        {(mode !== "translation" || !zh) && <p className="sub-orig">{pieceAt(seg.text, cjk, progress)}</p>}
      </div>
    </div>
  );
}

function AudioSubtitles({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const items = useJobs((s) => s.translations[ep.id]?.items);
  const time = useStore((s) => (s.current?.id === ep.id ? s.time : 0));
  const rawMode = useStore((s) => s.prefs.subtitleMode);
  const mode = rawMode === "off" ? "bilingual" : rawMode;
  const showNext = useStore((s) => s.prefs.audioNextLine);

  if (!transcript || !transcript.segments.length) return null;
  const segs = transcript.segments;
  const i = Math.max(0, activeSegIndex(segs, time));
  const seg = segs[i];
  if (!seg) return null;

  const progress = Math.min(1, Math.max(0, (time - seg.start) / Math.max(0.5, seg.end - seg.start)));
  const cjk = (x: string) => /[\u4e00-\u9fff]/.test(x);
  const origPs = pieces(seg.text, cjk(seg.text));
  const zh = items?.[i]?.trim();
  const zhPs = zh ? pieces(zh, true) : [];
  const k = pieceIndex(origPs, progress);
  const kz = zhPs.length ? Math.min(zhPs.length - 1, Math.floor((k / origPs.length) * zhPs.length + 1e-9)) : 0;

  const nextSeg = segs[i + 1];
  const nextZh = items?.[i + 1]?.trim();
  const nowLine = {
    orig: origPs[k],
    zh: zhPs.length ? (zhPs.length === origPs.length ? zhPs[k] : zhPs[kz]) : undefined,
  };
  const nextLine =
    k + 1 < origPs.length
      ? {
          orig: origPs[k + 1],
          zh: zhPs.length
            ? zhPs.length === origPs.length
              ? zhPs[k + 1]
              : kz + 1 < zhPs.length
                ? zhPs[kz + 1]
                : undefined
            : undefined,
        }
      : nextSeg
        ? { orig: pieces(nextSeg.text, cjk(nextSeg.text))[0], zh: nextZh ? pieces(nextZh, true)[0] : undefined }
        : null;

  return (
    <div className="asub notranslate" translate="no" aria-live="off">
      <div className="asub-line now">
        {nowLine.zh && mode !== "original" && <p className="sub-zh">{nowLine.zh}</p>}
        {(mode !== "translation" || !nowLine.zh) && <p className="sub-orig">{nowLine.orig}</p>}
      </div>
      {showNext && nextLine && (
        <div className="asub-line next" aria-hidden>
          {nextLine.zh && mode !== "original" && <p className="sub-zh">{nextLine.zh}</p>}
          {(mode !== "translation" || !nextLine.zh) && <p className="sub-orig">{nextLine.orig}</p>}
        </div>
      )}
    </div>
  );
}

function LocalVideoStage({ ep, src, onFail }: { ep: Episode; src: string; onFail?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    lastSavedProgress = ep.progress ?? 0;
    const handle = {
      episodeId: ep.id,
      seek: (t: number) => {
        el.currentTime = t;
        void el.play().catch(() => {});
      },
      toggle: () => {
        if (el.paused) void el.play().catch(() => {});
        else el.pause();
      },
      play: () => {
        void el.play().catch(() => {});
      },
      setRate: (r: number) => {
        el.playbackRate = r;
      },
    };
    useStore.getState().offerPlayer(handle);
    return () => {
      if (el.currentTime > 0) void api.setProgress(ep.id, el.currentTime);
      useStore.getState().withdrawPlayer(handle);
    };
  }, [ep.id, src]);

  useEffect(() => {
    if (ref.current) ref.current.playbackRate = rate;
  }, [rate]);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.volume = volume;
    ref.current.muted = muted;
  }, [volume, muted]);

  return (
    <div className="video">
      <video
        ref={ref}
        className="video-native"
        src={src}
        playsInline
        preload="auto"
        onClick={() => useStore.getState().player?.toggle()}
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          el.playbackRate = useStore.getState().prefs.playbackRate;
          const s = useStore.getState();
          const at = s.current?.id === ep.id ? s.time : ep.progress;
          if (at > 3 && (!el.duration || at < el.duration - 5)) el.currentTime = at;
          trackTime(ep, el.currentTime, el.duration);
        }}
        onTimeUpdate={(e) => trackTime(ep, e.currentTarget.currentTime, e.currentTarget.duration)}
        onPlay={() =>
          useStore.getState().set({
            playing: true,
            loadingSince: ref.current && ref.current.readyState < 3 ? Date.now() : null,
          })
        }
        onWaiting={() => useStore.getState().set({ loadingSince: Date.now() })}
        onPlaying={() => useStore.getState().set({ loadingSince: null })}
        onPause={(e) => {
          useStore.getState().set({ playing: false, loadingSince: null });
          persistProgress(ep, e.currentTarget.currentTime);
        }}
        onEnded={(e) => {
          useStore.getState().set({ playing: false, loadingSince: null });
          persistProgress(ep, e.currentTarget.duration || e.currentTarget.currentTime);
        }}
        onError={() => onFail?.()}
      />
      <SubtitleOverlay ep={ep} />
    </div>
  );
}

function YouTubeStage({ ep }: { ep: Episode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);
  const openSettings = useStore((s) => s.openSettings);

  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [loadingStream, setLoadingStream] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const fetchDirect = async (fresh = false) => {
    if (loadingStream) return;
    setLoadingStream(true);
    setErrMsg(null);
    try {
      const res = await api.getStreamUrl(ep.id, fresh);
      playerRef.current?.destroy();
      playerRef.current = null;
      setFallbackUrl(res.url);
    } catch (err) {
      setErrMsg(err instanceof Error ? err.message : "获取直链失败");
    } finally {
      setLoadingStream(false);
    }
  };

  useEffect(() => {
    setFallbackUrl(null);
    setErrMsg(null);
    if (wasYtBlocked(ep.videoId)) {
      void fetchDirect(false);
      return;
    }

    let disposed = false;
    let pollTimer: number | undefined;
    let handle: {
      episodeId: string;
      seek: (t: number) => void;
      toggle: () => void;
      play: () => void;
      setRate: (r: number) => void;
    } | null = null;

    lastSavedProgress = ep.progress ?? 0;

    void loadYouTubeApi()
      .then((YT) => {
        if (disposed || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        const mount = document.createElement("div");
        hostRef.current.appendChild(mount);
        const startAt = Math.floor(ep.progress > 3 ? ep.progress : 0);
        const player = new YT.Player(mount, {
          host: "https://www.youtube-nocookie.com",
          videoId: ep.videoId!,
          width: "100%",
          height: "100%",
          playerVars: {
            controls: 0,
            disablekb: 1,
            fs: 0,
            playsinline: 1,
            rel: 0,
            modestbranding: 1,
            cc_load_policy: 0,
            iv_load_policy: 3,
            ...(startAt > 0 ? { start: startAt } : {}),
            origin: window.location.origin,
          },
          events: {
            onReady: () => {
              if (disposed) return;
              playerRef.current = player;
              hideYouTubeCaptions(player);
              const prefs = useStore.getState().prefs;
              player.setPlaybackRate?.(prefs.playbackRate);
              player.setVolume?.(Math.round(prefs.volume * 100));
              if (prefs.muted) player.mute?.();
              else player.unMute?.();

              handle = {
                episodeId: ep.id,
                seek: (t: number) => {
                  player.seekTo(t, true);
                  player.playVideo();
                },
                toggle: () => {
                  if (player.getPlayerState() === 1) player.pauseVideo();
                  else {
                    useStore.getState().set({ loadingSince: Date.now() });
                    player.playVideo();
                  }
                },
                play: () => {
                  useStore.getState().set({ loadingSince: Date.now() });
                  player.playVideo();
                },
                setRate: (r: number) => player.setPlaybackRate?.(r),
              };
              useStore.getState().offerPlayer(handle, { length: player.getDuration?.() || ep.duration || 0 });

              pollTimer = window.setInterval(() => {
                const t = player.getCurrentTime?.();
                if (typeof t === "number" && Number.isFinite(t)) {
                  trackTime(ep, t, player.getDuration?.());
                }
              }, 250);
            },
            onStateChange: (ev) => {
              if (useStore.getState().current?.id !== ep.id) return;
              if (ev.data === 3) useStore.getState().set({ loadingSince: Date.now() });
              else if (ev.data === 1 || ev.data === 2 || ev.data === 0) {
                useStore.getState().set({ loadingSince: null });
              }
              useStore.getState().set({ playing: ev.data === 1 });
              if (ev.data === 1) hideYouTubeCaptions(player);
              if (ev.data === 2) persistProgress(ep, player.getCurrentTime());
              if (ev.data === 0) {
                persistProgress(ep, player.getDuration?.() ?? player.getCurrentTime());
              }
            },
            onError: (ev) => {
              if (disposed) return;
              if (ev.data === 101 || ev.data === 150) markYtBlocked(ep.videoId);
              if ([100, 101, 150, 152, 153].includes(ev.data)) {
                void fetchDirect(false);
              } else {
                useStore.getState().set({ loadingSince: null });
                setErrMsg(`YouTube 播放器报错（错误码 ${ev.data}），可尝试切换 yt-dlp 直链播放。`);
              }
            },
          },
        });
      })
      .catch((err) => {
        if (!disposed) setErrMsg(err instanceof Error ? err.message : "YouTube 播放器加载失败");
      });

    return () => {
      disposed = true;
      window.clearInterval(pollTimer);
      try {
        const curT = playerRef.current?.getCurrentTime?.();
        if (typeof curT === "number" && curT > 0) persistProgress(ep, curT);
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (handle) useStore.getState().withdrawPlayer(handle);
    };
  }, [ep.id, ep.videoId]);

  useEffect(() => {
    playerRef.current?.setPlaybackRate?.(rate);
  }, [rate]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    p.setVolume?.(Math.round(volume * 100));
    if (muted) p.mute?.();
    else p.unMute?.();
  }, [volume, muted]);

  if (fallbackUrl) {
    return (
      <LocalVideoStage
        ep={ep}
        src={fallbackUrl}
        onFail={() => {
          setFallbackUrl(null);
          setErrMsg("直链视频加载失败或已过期，可点击重新获取直链。");
        }}
      />
    );
  }

  if (loadingStream || errMsg) {
    const isBot = errMsg ? /bot|人机|验证|sign in|cookies/i.test(errMsg) : false;
    return (
      <div className="video-fallback-box">
        {loadingStream ? (
          <p className="muted row-tight">
            <Loader2 size={15} className="spin" /> 正在通过 yt-dlp 解析可播放视频直链...
          </p>
        ) : (
          <>
            <p className="error-text">{errMsg}</p>
            <div className="row-actions" style={{ marginTop: 10 }}>
              <button type="button" className="btn sm primary" onClick={() => void fetchDirect(true)}>
                <Tv size={14} /> 切换直链播放 (yt-dlp)
              </button>
              {isBot && (
                <button type="button" className="btn sm" onClick={() => openSettings("network")}>
                  配置 cookies.txt
                </button>
              )}
              <a
                className="btn sm"
                href={`https://www.youtube.com/watch?v=${ep.videoId}`}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} /> 在 YouTube 打开
              </a>
            </div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="video">
      <div className="video-host" ref={hostRef} />
      <div className="video-shield" onClick={() => useStore.getState().player?.toggle()} />
      <SubtitleOverlay ep={ep} />
    </div>
  );
}

export function MediaStage({ ep }: { ep: Episode }) {
  const { current, playing, loadingSince, load, playSoon } = useStore(
    useShallow((s) => ({
      current: s.current,
      playing: s.playing,
      loadingSince: s.loadingSince,
      load: s.load,
      playSoon: s.playSoon,
    })),
  );
  const hasTranscript = useJobs((s) => !!(s.transcripts[ep.id]?.segments.length));
  const audioStageSub = useStore((s) => s.prefs.audioStageSub);
  const isCurrent = current?.id === ep.id;

  if (ep.videoId) {
    if (!isCurrent) {
      return (
        <div className="video video-standby">
          <img
            src={`https://i.ytimg.com/vi/${ep.videoId}/mqdefault.jpg`}
            alt=""
            className="standby-img"
            onError={(e) => {
              const img = e.currentTarget;
              if (!img.dataset.f) {
                img.dataset.f = "1";
                img.src = `https://i.ytimg.com/vi/${ep.videoId}/hqdefault.jpg`;
              }
            }}
          />
          <button
            type="button"
            className="big-play"
            onClick={() => {
              load(ep);
              playSoon(ep.id);
            }}
            title="播放这一集"
          >
            <Play size={26} fill="currentColor" />
          </button>
        </div>
      );
    }
    return <YouTubeStage ep={ep} />;
  }

  if (ep.audioUrl && isVideoMediaUrl(ep.audioUrl)) {
    if (!isCurrent) {
      return (
        <div className="video video-standby">
          <button
            type="button"
            className="big-play"
            onClick={() => {
              load(ep);
              playSoon(ep.id);
            }}
            title="播放本地视频"
          >
            <Play size={26} fill="currentColor" />
          </button>
        </div>
      );
    }
    return <LocalVideoStage ep={ep} src={ep.audioUrl} />;
  }

  if (ep.audioUrl) {
    const showAudioSub = hasTranscript && audioStageSub;
    const toggle = () => {
      if (isCurrent) useStore.getState().player?.toggle();
      else {
        load(ep);
        playSoon(ep.id);
      }
    };
    return (
      <div className={`audio-stage ${showAudioSub ? "" : "compact"}`}>
        <div className="cover-wrap">
          {ep.cover && <img className="cover-glow" src={ep.cover} alt="" aria-hidden />}
          <button
            type="button"
            className="cover-play"
            onClick={toggle}
            title={isCurrent && playing ? "暂停 (Space)" : "播放 (Space)"}
          >
            {ep.cover ? (
              <img src={ep.cover} alt="" />
            ) : (
              <span className="cover-fallback">
                <Headphones size={30} />
              </span>
            )}
            <span className={`cover-play-btn ${isCurrent && playing ? "playing" : ""}`}>
              {isCurrent && loadingSince ? (
                <Loader2 size={24} className="spin" />
              ) : isCurrent && playing ? (
                <Pause size={24} fill="currentColor" />
              ) : (
                <Play size={24} fill="currentColor" />
              )}
            </span>
          </button>
        </div>
        {showAudioSub && (
          <div className="audio-sub">
            <AudioSubtitles ep={ep} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="text-mode-banner">
      <FileText size={16} />
      <span>纯文稿阅读模式：可在右侧划词提问、生成导读与导出文档。</span>
    </div>
  );
}

function SeekBack10Icon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 6.5L5.5 9.5L9 12.5" />
      <path d="M6 9.5H13.5C16.81 9.5 19.5 12.19 19.5 15.5C19.5 18.81 16.81 21.5 13.5 21.5H9" />
      <text x="12" y="18.2" textAnchor="middle" fill="currentColor" stroke="none" fontSize="6.6" fontWeight="700" fontFamily="var(--mono)">
        10
      </text>
    </svg>
  );
}

function SeekForward10Icon() {
  return (
    <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M15 6.5L18.5 9.5L15 12.5" />
      <path d="M18 9.5H10.5C7.19 9.5 4.5 12.19 4.5 15.5C4.5 18.81 7.19 21.5 10.5 21.5H15" />
      <text x="12" y="18.2" textAnchor="middle" fill="currentColor" stroke="none" fontSize="6.6" fontWeight="700" fontFamily="var(--mono)">
        10
      </text>
    </svg>
  );
}

function VolumePopover() {
  const { volume, muted, savePrefs } = useStore(
    useShallow((s) => ({
      volume: s.prefs.volume,
      muted: s.prefs.muted,
      savePrefs: s.savePrefs,
    })),
  );
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<number | undefined>(undefined);
  const volShown = muted ? 0 : volume;
  const VolIcon = volShown === 0 ? VolumeX : volShown < 0.5 ? Volume1 : Volume2;

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const show = () => {
    window.clearTimeout(closeTimer.current);
    setOpen(true);
  };
  const hideSoon = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 180);
  };

  return (
    <div
      className="vol-wrap"
      onMouseEnter={show}
      onMouseLeave={hideSoon}
      onWheel={(e) => {
        if (!e.deltaY) return;
        e.preventDefault();
        const next = Math.min(1, Math.max(0, Math.round((volShown - Math.sign(e.deltaY) * 0.05) * 100) / 100));
        savePrefs({ volume: next, muted: next === 0 });
      }}
    >
      <button
        type="button"
        className="icon-btn"
        onClick={toggleMute}
        title={muted ? "取消静音 (M)" : "静音 (M)"}
        aria-label={muted ? "取消静音" : "静音"}
      >
        <VolIcon size={16} />
      </button>
      {open && (
        <div className="vol-pop" onMouseEnter={show} onMouseLeave={hideSoon}>
          <span className="vol-pct">{Math.round(volShown * 100)}</span>
          <input
            className="vol-range"
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={volShown}
            onChange={(e) => {
              const val = Number(e.target.value);
              savePrefs({ volume: val, muted: val === 0 });
            }}
            style={{ "--fill": `${Math.round(volShown * 100)}%` } as React.CSSProperties}
            aria-label="音量"
          />
        </div>
      )}
    </div>
  );
}

function VideoSubtitleMenu({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const officialStatus = useJobs((s) => s.officialStatus[ep.id] ?? "idle");
  const trJob = useJobs((s) => s.translations[ep.id]);
  const {
    mode,
    trEngine,
    trProviderId,
    trModel,
    chatProviderId,
    agents,
    verifiedAgents,
    keyStatus,
    providerOverrides,
    savePrefs,
    getTranslateProvider,
    isProviderReady,
  } = useStore(
    useShallow((s) => ({
      mode: s.prefs.subtitleMode,
      trEngine: s.prefs.translateEngine,
      trProviderId: s.prefs.translateProviderId,
      trModel: s.prefs.translateModel,
      chatProviderId: s.chatProviderId,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      keyStatus: s.keyStatus,
      providerOverrides: s.providerOverrides,
      savePrefs: s.savePrefs,
      getTranslateProvider: s.getTranslateProvider,
      isProviderReady: s.isProviderReady,
    })),
  );

  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const trProvider = useMemo(
    () => getTranslateProvider(),
    [getTranslateProvider, trProviderId, trModel, chatProviderId, agents, verifiedAgents, providerOverrides],
  );
  const canLlm = isProviderReady(trProvider);
  void keyStatus;

  const segments = transcript?.segments ?? [];
  const total = segments.length;
  const items = trJob?.items ?? [];
  const done = Math.min(total, items.filter((x) => x != null && x !== "").length);
  const running = !!trJob?.running;
  const wantsZh = total > 0 && !isMostlyChinese(segments);
  const defaultEngine: "llm" | "google" =
    trEngine === "llm" ? "llm" : trEngine === "google" ? "google" : canLlm ? "llm" : "google";
  const hasDone = total > 0 && done >= total;
  const doneSourceLabel =
    trJob?.engine === "google" ? "谷歌快翻" : trJob?.engine === "llm" ? "大模型精译" : "中文字幕";
  const progressDone = trJob?.retranslating ? (trJob.pendingDone ?? 0) : done;
  const trEngineHint =
    defaultEngine === "google" || !canLlm || !trProvider
      ? "谷歌免费直连（需可访问 Google，走本机代理）"
      : `${trProvider.name}${trProvider.model ? ` · ${trProvider.model.split("/").pop()}` : ""} 术语精译`;

  return (
    <div className="sub-wrap" ref={boxRef}>
      <button
        type="button"
        className={`icon-btn sub-trigger ${mode !== "off" ? "on" : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="画内字幕与翻译"
        title="字幕显示与翻译 (C 切换)"
        onClick={() => setOpen((v) => !v)}
      >
        <Captions size={16} />
        {running && <span className="sub-busy-dot" />}
      </button>

      {open && (
        <div className="sub-pop" role="dialog" aria-label="画内字幕与翻译">
          <p className="sub-pop-label">画内字幕</p>
          <div className="seg-control sub-seg" role="radiogroup" aria-label="字幕显示模式">
            {(
              [
                ["bilingual", "双语"],
                ["translation", "中文"],
                ["original", "原文"],
                ["off", "关闭"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={mode === k}
                className={mode === k ? "on" : ""}
                onClick={() => savePrefs({ subtitleMode: k })}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="sub-pop-sep" />

          {transcript === undefined || officialStatus === "loading" || officialStatus === "searching" ? (
            <div className="sub-tr-status">
              <Loader2 size={13} className="spin" />
              <span>{officialStatus === "searching" ? "正在获取官方字幕…" : "正在读取字幕…"}</span>
            </div>
          ) : !transcript ? (
            <p className="muted small">暂无字幕。在右侧「导读」栏可转写或导入字幕。</p>
          ) : !wantsZh ? (
            <p className="muted small">当前为中文原文字幕（共 {total} 段）。</p>
          ) : (
            <div className="sub-tr-box">
              <div className="sub-tr-status">
                {running ? (
                  <>
                    <Loader2 size={13} className="spin" />
                    <span>{trJob?.progressText || `翻译中 ${progressDone}/${total}`}</span>
                  </>
                ) : hasDone ? (
                  <span className="sub-tr-done">
                    <CheckCircle2 size={13} />
                    <span>
                      已译完 · {doneSourceLabel}（{total} 段）
                    </span>
                  </span>
                ) : trJob?.error ? (
                  <span className="error-text small">{trJob.error}</span>
                ) : done > 0 ? (
                  <span className="muted small">
                    已译 {done}/{total} 段
                  </span>
                ) : (
                  <span className="muted small">共 {total} 段字幕，尚未翻译</span>
                )}
              </div>

              {!running && hasDone && trJob?.error && <p className="error-text small sub-tr-err">{trJob.error}</p>}

              {running && total > 0 && (
                <div className="bar">
                  <div style={{ width: `${Math.max(3, (progressDone / total) * 100)}%` }} />
                </div>
              )}

              <div className="sub-tr-actions">
                {running ? (
                  <button type="button" className="btn sm ghost" onClick={() => stopTranslate(ep.id)}>
                    <Square size={11} /> 停止
                  </button>
                ) : hasDone ? (
                  trJob?.engine === "google" && canLlm ? (
                    <>
                      <button
                        type="button"
                        className="btn sm primary"
                        title={trEngineHint}
                        onClick={() => void runTranslate(ep, { forceEngine: "llm", restart: true })}
                      >
                        <Languages size={13} />
                        <span>升级大模型精译</span>
                      </button>
                      <div className="sub-tr-alts">
                        <button
                          type="button"
                          className="link-btn"
                          title="用谷歌快翻重新翻译"
                          onClick={() => void runTranslate(ep, { forceEngine: "google", restart: true })}
                        >
                          重译
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="sub-tr-alts">
                      <button
                        type="button"
                        className="link-btn"
                        title={`使用当前默认引擎重新翻译（${trEngineHint}）`}
                        onClick={() => void runTranslate(ep, { forceEngine: defaultEngine, restart: true })}
                      >
                        重新翻译
                      </button>
                      {defaultEngine === "llm" ? (
                        trJob?.engine !== "llm" && (
                          <button
                            type="button"
                            className="link-btn"
                            title="需可访问 Google，自动走本机代理"
                            onClick={() => void runTranslate(ep, { forceEngine: "google", restart: true })}
                          >
                            改用谷歌快翻
                          </button>
                        )
                      ) : canLlm && trJob?.engine !== "llm" ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => void runTranslate(ep, { forceEngine: "llm", restart: true })}
                        >
                          改用大模型精译
                        </button>
                      ) : null}
                    </div>
                  )
                ) : (
                  <>
                    <button
                      type="button"
                      className="btn sm primary"
                      title={`当前引擎：${trEngineHint}`}
                      onClick={() => void runTranslate(ep, { forceEngine: defaultEngine })}
                    >
                      <Languages size={13} />
                      <span>
                        {defaultEngine === "llm"
                          ? done > 0
                            ? "继续大模型翻译"
                            : "大模型翻译"
                          : done > 0
                            ? "继续谷歌翻译"
                            : "谷歌翻译"}
                      </span>
                    </button>
                    <div className="sub-tr-alts">
                      {defaultEngine === "llm" ? (
                        <button
                          type="button"
                          className="link-btn"
                          title="需可访问 Google，自动走本机代理"
                          onClick={() =>
                            void runTranslate(ep, {
                              forceEngine: "google",
                              restart: done > 0 && trJob?.engine !== "google",
                            })
                          }
                        >
                          改用谷歌快翻
                        </button>
                      ) : canLlm ? (
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() =>
                            void runTranslate(ep, {
                              forceEngine: "llm",
                              restart: done > 0 && trJob?.engine !== "llm",
                            })
                          }
                        >
                          改用大模型精译
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function Controls({ ep }: { ep: Episode }) {
  const { current, time, length, playing, player, loadingSince, rate, audioStageSub, savePrefs, load, playSoon } = useStore(
    useShallow((s) => ({
      current: s.current,
      time: Math.floor(s.time),
      length: s.length,
      playing: s.playing,
      player: s.player,
      loadingSince: s.loadingSince,
      rate: s.prefs.playbackRate,
      audioStageSub: s.prefs.audioStageSub,
      savePrefs: s.savePrefs,
      load: s.load,
      playSoon: s.playSoon,
    })),
  );

  const [drag, setDrag] = useState<number | null>(null);
  const isCurrent = current?.id === ep.id;
  const isVideo = !!(ep.videoId || isVideoMediaUrl(ep.audioUrl));

  if (!ep.audioUrl && !ep.videoId) return null;

  if (!isCurrent) {
    return (
      <div className="controls">
        <button
          type="button"
          className="btn primary sm"
          onClick={() => {
            load(ep);
            playSoon(ep.id);
          }}
        >
          <Play size={14} fill="currentColor" />
          <span>播放这一集</span>
        </button>
        <span className="muted small">当前后台正在播放其他内容，点击将切换至此集</span>
      </div>
    );
  }

  const shown = drag ?? time;
  const totalLen = length || ep.duration || 0;

  return (
    <div className="controls">
      <button
        type="button"
        className="icon-btn"
        title="后退 10 秒 (←)"
        aria-label="后退 10 秒"
        disabled={!player}
        onClick={() => player?.seek(Math.max(0, time - 10))}
      >
        <SeekBack10Icon />
      </button>

      <button
        type="button"
        className="play-btn"
        title={loadingSince ? "缓冲中..." : playing ? "暂停 (Space)" : "播放 (Space)"}
        disabled={!player}
        onClick={() => player?.toggle()}
      >
        {loadingSince ? (
          <Loader2 size={18} className="spin" />
        ) : playing ? (
          <Pause size={18} fill="currentColor" />
        ) : (
          <Play size={18} fill="currentColor" />
        )}
      </button>

      <button
        type="button"
        className="icon-btn"
        title="前进 10 秒 (→)"
        aria-label="前进 10 秒"
        disabled={!player}
        onClick={() => player?.seek(time + 10)}
      >
        <SeekForward10Icon />
      </button>

      <span className="time">{clock(shown)}</span>

      <input
        className="seek"
        type="range"
        min={0}
        max={Math.max(totalLen, 1)}
        step={1}
        value={Math.min(shown, Math.max(totalLen, shown))}
        onChange={(e) => setDrag(Number(e.target.value))}
        onPointerUp={() => {
          if (drag != null) {
            player?.seek(drag);
            setDrag(null);
          }
        }}
        onKeyUp={() => {
          if (drag != null) {
            player?.seek(drag);
            setDrag(null);
          }
        }}
        style={{ "--fill": `${totalLen ? Math.min(100, (shown / totalLen) * 100) : 0}%` } as React.CSSProperties}
        aria-label="播放进度"
      />

      <span className="time">{totalLen ? clock(totalLen) : "--:--"}</span>

      {isVideo && <VideoSubtitleMenu ep={ep} />}
      {!isVideo && ep.audioUrl && (
        <button
          type="button"
          className={`icon-btn ${audioStageSub ? "on" : ""}`}
          aria-pressed={audioStageSub}
          aria-label={audioStageSub ? "隐藏封面下方提词" : "显示封面下方提词"}
          title={audioStageSub ? "隐藏封面下方提词" : "显示封面下方提词"}
          onClick={() => savePrefs({ audioStageSub: !audioStageSub })}
        >
          <Captions size={16} />
        </button>
      )}

      <VolumePopover />

      <button type="button" className="rate-btn" onClick={cycleRate} title="切换倍速 ([ / ])">
        {rate}×
      </button>
    </div>
  );
}
