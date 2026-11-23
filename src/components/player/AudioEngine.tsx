import { useEffect, useRef } from "react";
import { useStore } from "../../store";
import { isVideoMediaUrl, persistProgress, resetSavedProgress, trackTime } from "./playerUtils";

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
    resetSavedProgress(audio.progress ?? 0);
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
        useStore.getState().notify("音频加载失败，可能是网络或源地址失效", false, {
          label: "检查网络",
          run: () => useStore.getState().openSettings("network"),
        });
      }}
    />
  );
}
