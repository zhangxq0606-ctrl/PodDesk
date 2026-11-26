import { FileText, Headphones, Loader2, Pause, Play } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { Episode } from "../../lib/api";
import { useJobs } from "../../lib/jobs";
import { useStore } from "../../store";
import { AudioSubtitles } from "./AudioStage";
import { isVideoMediaUrl } from "./playerUtils";
import { LocalVideoStage, YouTubeStage } from "./VideoStage";

export function MediaStage({
  ep,
  onFullscreen,
  isFullscreen,
}: {
  ep: Episode;
  onFullscreen?: () => void;
  isFullscreen?: boolean;
}) {
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
    return <YouTubeStage ep={ep} onFullscreen={onFullscreen} isFullscreen={isFullscreen} />;
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
    return <LocalVideoStage ep={ep} src={ep.audioUrl} onFullscreen={onFullscreen} isFullscreen={isFullscreen} />;
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
      <div className={`audio-stage ${showAudioSub ? "" : "compact"}`} data-playing={isCurrent && playing ? "true" : undefined}>
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
            <span className="cover-live-eq" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
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
