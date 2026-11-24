import { useEffect, useRef, useState } from "react";
import { ExternalLink, Loader2, Tv } from "lucide-react";
import { pieceAt } from "../../lib/ai";
import { api, type Episode } from "../../lib/api";
import { useJobs } from "../../lib/jobs";
import { useStore } from "../../store";
import {
  activeSegIndex,
  hideYouTubeCaptions,
  loadYouTubeApi,
  markYtBlocked,
  persistProgress,
  resetSavedProgress,
  trackTime,
  wasYtBlocked,
  type YTPlayerInstance,
} from "./playerUtils";

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

export function LocalVideoStage({ ep, src, onFail }: { ep: Episode; src: string; onFail?: () => void }) {
  const ref = useRef<HTMLVideoElement>(null);
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    resetSavedProgress(ep.progress ?? 0);
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
      if (el.currentTime > 0) persistProgress(ep, el.currentTime);
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

export function YouTubeStage({ ep }: { ep: Episode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const directAbortRef = useRef<AbortController | null>(null);
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);
  const health = useStore((s) => s.health);
  const openSettings = useStore((s) => s.openSettings);
  const notify = useStore((s) => s.notify);

  const [fallbackUrl, setFallbackUrl] = useState<string | null>(null);
  const [loadingStream, setLoadingStream] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const errRef = useRef<string | null>(null);
  errRef.current = errMsg;

  const fetchDirect = async (fresh = false) => {
    if (loadingStream) return;
    directAbortRef.current?.abort();
    const ctrl = new AbortController();
    directAbortRef.current = ctrl;
    setLoadingStream(true);
    setErrMsg(null);
    try {
      const res = await api.getStreamUrl(ep.id, fresh, ctrl.signal);
      if (ctrl.signal.aborted) return;
      playerRef.current?.destroy();
      playerRef.current = null;
      setFallbackUrl(res.url);
    } catch (err) {
      if ((err instanceof DOMException && err.name === "AbortError") || ctrl.signal.aborted) {
        setErrMsg("已取消获取直链，可重试或前往 YouTube 打开。");
      } else {
        setErrMsg(err instanceof Error ? err.message : "获取直链失败");
      }
    } finally {
      if (directAbortRef.current === ctrl) directAbortRef.current = null;
      setLoadingStream(false);
    }
  };

  const cancelDirect = () => {
    directAbortRef.current?.abort();
    setLoadingStream(false);
    setErrMsg("已取消获取直链，可重试或前往 YouTube 打开。");
  };

  useEffect(() => {
    const onLoginChanged = () => {
      if (errRef.current && /bot|人机|验证|sign in|cookies|登录 YouTube/i.test(errRef.current)) {
        void fetchDirect(true);
      }
    };
    window.addEventListener("poddesk:yt-login-changed", onLoginChanged);
    return () => window.removeEventListener("poddesk:yt-login-changed", onLoginChanged);
  });

  useEffect(() => {
    directAbortRef.current?.abort();
    setFallbackUrl(null);
    setErrMsg(null);
    if (wasYtBlocked(ep.videoId)) {
      void fetchDirect(false);
      return () => {
        directAbortRef.current?.abort();
      };
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

    resetSavedProgress(ep.progress ?? 0);

    void loadYouTubeApi()
      .then((YT) => {
        if (disposed || !hostRef.current) return;
        hostRef.current.innerHTML = "";
        const mount = document.createElement("div");
        hostRef.current.appendChild(mount);
        const startAt = Math.floor(ep.progress > 3 ? ep.progress : 0);
        const player = new YT.Player(mount, {
          host: "https://www.youtube.com",
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
      directAbortRef.current?.abort();
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
    const isBot = errMsg ? /bot|人机|验证|sign in|cookies|登录 YouTube/i.test(errMsg) : false;
    return (
      <div className="video-fallback-box">
        {loadingStream ? (
          <div className="row-between" style={{ gap: 12, flexWrap: "wrap" }}>
            <p className="muted row-tight">
              <Loader2 size={15} className="spin" /> 嵌入播放受限，正在通过 yt-dlp 解析可播放直链（需走本机代理）...
            </p>
            <button type="button" className="btn sm" onClick={cancelDirect}>
              取消
            </button>
          </div>
        ) : (
          <>
            <p className="error-text">{errMsg}</p>
            <div className="row-actions" style={{ marginTop: 10 }}>
              {isBot && health?.ytLoginSupported && (
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => {
                    void api.openYouTubeLogin().catch((err) => {
                      notify(err instanceof Error ? err.message : "打开登录窗口失败", false);
                    });
                  }}
                >
                  登录 YouTube
                </button>
              )}
              <button
                type="button"
                className={isBot && health?.ytLoginSupported ? "btn sm" : "btn sm primary"}
                onClick={() => void fetchDirect(true)}
              >
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
