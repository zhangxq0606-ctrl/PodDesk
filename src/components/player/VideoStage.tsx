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
  MEDIA_STALL_TIMEOUT_MS,
  persistProgress,
  requestYtStreamUrl,
  resetSavedProgress,
  trackTime,
  wasYtBlocked,
  YT_IFRAME_TIMEOUT_MS,
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

export function LocalVideoStage({
  ep,
  src,
  onFail,
}: {
  ep: Episode;
  src: string;
  onFail?: (reason?: "error" | "timeout") => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const onFailRef = useRef(onFail);
  onFailRef.current = onFail;
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);
  const loadingSince = useStore((s) => (s.current?.id === ep.id ? s.loadingSince : null));

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const s0 = useStore.getState();
    resetSavedProgress(s0.current?.id === ep.id ? s0.time : (ep.progress ?? 0));
    const handle = {
      episodeId: ep.id,
      seek: (t: number) => {
        const s = useStore.getState();
        if (s.current?.id === ep.id) {
          s.set({ time: t, loadingSince: el.readyState < 3 ? Date.now() : null });
        }
        el.currentTime = t;
        void el.play().catch(() => {
          if (ref.current === el && useStore.getState().current?.id === ep.id) {
            useStore.getState().clearPlaybackPending(ep.id);
          }
        });
      },
      toggle: () => {
        if (el.paused) {
          if (el.readyState < 3 && useStore.getState().current?.id === ep.id) {
            useStore.getState().set({ loadingSince: Date.now() });
          }
          void el.play().catch(() => {
            if (ref.current === el && useStore.getState().current?.id === ep.id) {
              useStore.getState().clearPlaybackPending(ep.id);
            }
          });
        } else {
          el.pause();
        }
      },
      play: () => {
        if (el.readyState < 3 && useStore.getState().current?.id === ep.id) {
          useStore.getState().set({ loadingSince: Date.now() });
        }
        void el.play().catch(() => {
          if (ref.current === el && useStore.getState().current?.id === ep.id) {
            useStore.getState().clearPlaybackPending(ep.id);
          }
        });
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
    if (loadingSince == null) return;
    const remain = Math.max(0, MEDIA_STALL_TIMEOUT_MS - (Date.now() - loadingSince));
    const timer = window.setTimeout(() => {
      const s = useStore.getState();
      if (s.current?.id !== ep.id || s.loadingSince == null) return;
      const el = ref.current;
      if (el && !el.paused && el.readyState >= 3) {
        s.set({ loadingSince: null });
        return;
      }
      el?.pause();
      if (onFailRef.current) {
        onFailRef.current("timeout");
      } else {
        s.clearPlaybackPending(ep.id);
        s.notify("视频加载或缓冲超时，请检查文件或网络后重试", false);
      }
    }, remain);
    return () => window.clearTimeout(timer);
  }, [ep.id, loadingSince]);

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
        onCanPlay={(e) => {
          const s = useStore.getState();
          if (!e.currentTarget.paused && s.current?.id === ep.id && s.loadingSince != null) {
            s.set({ loadingSince: null });
          }
        }}
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
        onError={() => {
          if (useStore.getState().current?.id !== ep.id) return;
          if (onFailRef.current) {
            onFailRef.current("error");
          } else {
            useStore.getState().clearPlaybackPending(ep.id);
            useStore.getState().notify("本地视频加载失败，请检查文件是否完整", false);
          }
        }}
      />
      <SubtitleOverlay ep={ep} />
    </div>
  );
}

export function YouTubeStage({ ep }: { ep: Episode }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayerInstance | null>(null);
  const directAbortRef = useRef<AbortController | null>(null);
  const autoHealedRef = useRef(false);
  const mountedRef = useRef(true);
  const hungIframeRef = useRef<((msg: string) => void) | null>(null);
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

  const iframeLoadingSince = useStore((s) =>
    !fallbackUrl && !loadingStream && !errMsg && s.current?.id === ep.id ? s.loadingSince : null,
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const preserveResumeIntent = () => {
    const s = useStore.getState();
    if (s.current?.id !== ep.id) return;
    const resumeAt = s.seekWhenReady?.id === ep.id ? s.seekWhenReady.at : s.time;
    const wantsPlay =
      s.playing || !!s.loadingSince || s.playWhenReady === ep.id || s.seekWhenReady?.id === ep.id;
    s.set({
      playing: false,
      loadingSince: null,
      ...(wantsPlay
        ? resumeAt > 3
          ? { seekWhenReady: { id: ep.id, at: resumeAt }, playWhenReady: null }
          : { playWhenReady: ep.id, seekWhenReady: null }
        : {}),
    });
  };

  const fetchDirect = async (fresh = false) => {
    if (!fresh && directAbortRef.current) return;
    directAbortRef.current?.abort();
    const ctrl = new AbortController();
    directAbortRef.current = ctrl;
    preserveResumeIntent();
    setLoadingStream(true);
    setErrMsg(null);
    try {
      const url = await requestYtStreamUrl(ep.id, { fresh, signal: ctrl.signal });
      if (ctrl.signal.aborted || !mountedRef.current) return;
      playerRef.current?.destroy();
      playerRef.current = null;
      setFallbackUrl(url);
    } catch (err) {
      if (!mountedRef.current) return;
      useStore.getState().clearPlaybackPending(ep.id);
      if ((err instanceof DOMException && err.name === "AbortError") || ctrl.signal.aborted) {
        setErrMsg("已取消获取直链，可重试或前往 YouTube 打开。");
      } else {
        setErrMsg(err instanceof Error ? err.message : "获取直链失败");
      }
    } finally {
      if (directAbortRef.current === ctrl) {
        directAbortRef.current = null;
        if (mountedRef.current) setLoadingStream(false);
      }
    }
  };

  const cancelDirect = () => {
    directAbortRef.current?.abort();
    directAbortRef.current = null;
    useStore.getState().clearPlaybackPending(ep.id);
    setLoadingStream(false);
    setErrMsg("已取消获取直链，可重试或前往 YouTube 打开。");
  };

  const handleDirectFail = (reason: "error" | "timeout" = "error") => {
    setFallbackUrl(null);
    if (!autoHealedRef.current) {
      autoHealedRef.current = true;
      preserveResumeIntent();
      notify(reason === "timeout" ? "直链缓冲超时，正在重新获取直链并续播…" : "直链已失效，正在重新获取直链并续播…");
      void fetchDirect(true);
      return;
    }
    useStore.getState().clearPlaybackPending(ep.id);
    setErrMsg(
      reason === "timeout"
        ? "直链视频加载或缓冲超时，可点击重新获取直链。"
        : "直链视频加载失败或已过期，可点击重新获取直链。",
    );
  };

  useEffect(() => {
    const onLoginChanged = () => {
      if (errRef.current && /bot|人机|验证|sign in|cookies|登录 YouTube/i.test(errRef.current)) {
        autoHealedRef.current = false;
        void fetchDirect(true);
      }
    };
    window.addEventListener("poddesk:yt-login-changed", onLoginChanged);
    return () => window.removeEventListener("poddesk:yt-login-changed", onLoginChanged);
  });

  useEffect(() => {
    directAbortRef.current?.abort();
    directAbortRef.current = null;
    autoHealedRef.current = false;
    hungIframeRef.current = null;
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
    let readyTimer: number | undefined;
    let handle: {
      episodeId: string;
      seek: (t: number) => void;
      toggle: () => void;
      play: () => void;
      setRate: (r: number) => void;
    } | null = null;

    const fallbackFromHungIframe = (msg: string) => {
      if (disposed) return;
      disposed = true;
      window.clearTimeout(readyTimer);
      window.clearInterval(pollTimer);
      preserveResumeIntent();
      try {
        const curT = playerRef.current?.getCurrentTime?.();
        if (typeof curT === "number" && curT > 0) persistProgress(ep, curT);
        playerRef.current?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      if (handle) useStore.getState().withdrawPlayer(handle);
      notify(msg);
      void fetchDirect(false);
    };
    hungIframeRef.current = fallbackFromHungIframe;

    resetSavedProgress(ep.progress ?? 0);
    readyTimer = window.setTimeout(() => {
      fallbackFromHungIframe("YouTube 嵌入加载超时，正在自动切换直链播放…");
    }, YT_IFRAME_TIMEOUT_MS);

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
              window.clearTimeout(readyTimer);
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
                  const s = useStore.getState();
                  if (s.current?.id === ep.id) {
                    s.set({ time: t, loadingSince: Date.now() });
                  }
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
              if (disposed || useStore.getState().current?.id !== ep.id) return;
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
              window.clearTimeout(readyTimer);
              if (ev.data === 101 || ev.data === 150) markYtBlocked(ep.videoId);
              if ([100, 101, 150, 152, 153].includes(ev.data)) {
                disposed = true;
                window.clearInterval(pollTimer);
                preserveResumeIntent();
                try {
                  playerRef.current?.destroy();
                } catch {
                  /* ignore */
                }
                playerRef.current = null;
                if (handle) useStore.getState().withdrawPlayer(handle);
                void fetchDirect(false);
              } else {
                useStore.getState().clearPlaybackPending(ep.id);
                setErrMsg(`YouTube 播放器报错（错误码 ${ev.data}），可尝试切换 yt-dlp 直链播放。`);
              }
            },
          },
        });
      })
      .catch((err) => {
        if (!disposed) {
          window.clearTimeout(readyTimer);
          useStore.getState().clearPlaybackPending(ep.id);
          setErrMsg(err instanceof Error ? err.message : "YouTube 播放器加载失败");
        }
      });

    return () => {
      disposed = true;
      hungIframeRef.current = null;
      window.clearTimeout(readyTimer);
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
    if (iframeLoadingSince == null) return;
    const remain = Math.max(0, YT_IFRAME_TIMEOUT_MS - (Date.now() - iframeLoadingSince));
    const timer = window.setTimeout(() => {
      const s = useStore.getState();
      if (s.current?.id !== ep.id || s.loadingSince == null) return;
      hungIframeRef.current?.("YouTube 嵌入缓冲超时，正在自动切换直链播放…");
    }, remain);
    return () => window.clearTimeout(timer);
  }, [ep.id, iframeLoadingSince]);

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
        onFail={(reason) => handleDirectFail(reason)}
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
                onClick={() => {
                  autoHealedRef.current = false;
                  const s = useStore.getState();
                  if (s.current?.id === ep.id) {
                    const resumeAt = s.time > 3 ? s.time : ep.progress;
                    if (resumeAt > 3) {
                      s.seekToEpisode(ep, resumeAt);
                    } else {
                      s.playSoon(ep.id);
                    }
                  }
                  void fetchDirect(true);
                }}
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
