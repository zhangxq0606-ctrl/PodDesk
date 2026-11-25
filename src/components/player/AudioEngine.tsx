import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { isVideoMediaUrl, MEDIA_STALL_TIMEOUT_MS, persistProgress, resetSavedProgress, trackTime } from "./playerUtils";

/** Root-level audio element so podcasts keep playing when browsing other views. */
export function AudioEngine() {
  const current = useStore((s) => s.current);
  const rate = useStore((s) => s.prefs.playbackRate);
  const volume = useStore((s) => s.prefs.volume);
  const muted = useStore((s) => s.prefs.muted);
  const ref = useRef<HTMLAudioElement>(null);

  const audio = current && !current.videoId && !isVideoMediaUrl(current.audioUrl) ? current : null;
  const loadingSince = useStore((s) => (audio && s.current?.id === audio.id ? s.loadingSince : null));

  useEffect(() => {
    const el = ref.current;
    if (!el || !audio) return;
    const s0 = useStore.getState();
    resetSavedProgress(s0.current?.id === audio.id ? s0.time : (audio.progress ?? 0));
    const handle = {
      episodeId: audio.id,
      seek: (t: number) => {
        const s = useStore.getState();
        if (s.current?.id === audio.id) {
          s.set({ time: t, loadingSince: el.readyState < 3 ? Date.now() : null });
        }
        el.currentTime = t;
        void el.play().catch(() => {
          if (ref.current === el && useStore.getState().current?.id === audio.id) {
            useStore.getState().clearPlaybackPending(audio.id);
          }
        });
      },
      toggle: () => {
        if (el.paused) {
          if (el.readyState < 3 && useStore.getState().current?.id === audio.id) {
            useStore.getState().set({ loadingSince: Date.now() });
          }
          void el.play().catch(() => {
            if (ref.current === el && useStore.getState().current?.id === audio.id) {
              useStore.getState().clearPlaybackPending(audio.id);
            }
          });
        } else {
          el.pause();
        }
      },
      play: () => {
        if (el.readyState < 3 && useStore.getState().current?.id === audio.id) {
          useStore.getState().set({ loadingSince: Date.now() });
        }
        void el.play().catch(() => {
          if (ref.current === el && useStore.getState().current?.id === audio.id) {
            useStore.getState().clearPlaybackPending(audio.id);
          }
        });
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
    if (!audio || loadingSince == null) return;
    const remain = Math.max(0, MEDIA_STALL_TIMEOUT_MS - (Date.now() - loadingSince));
    const timer = window.setTimeout(() => {
      const s = useStore.getState();
      if (s.current?.id !== audio.id || s.loadingSince == null) return;
      const el = ref.current;
      if (el && !el.paused && el.readyState >= 3) {
        s.set({ loadingSince: null });
        return;
      }
      el?.pause();
      s.clearPlaybackPending(audio.id);
      s.notify("音频加载或缓冲超时，可能是网络或源地址异常", false, {
        label: "检查网络",
        run: () => useStore.getState().openSettings("network"),
      });
    }, remain);
    return () => window.clearTimeout(timer);
  }, [audio?.id, loadingSince]);

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
      onCanPlay={(e) => {
        const s = useStore.getState();
        if (!e.currentTarget.paused && s.current?.id === audio.id && s.loadingSince != null) {
          s.set({ loadingSince: null });
        }
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
        useStore.getState().clearPlaybackPending(audio.id);
        useStore.getState().notify("音频加载失败，可能是网络或源地址失效", false, {
          label: "检查网络",
          run: () => useStore.getState().openSettings("network"),
        });
      }}
    />
  );
}
