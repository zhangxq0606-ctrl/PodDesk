import { pieceIndex, pieces } from "../../lib/ai";
import type { Episode } from "../../lib/api";
import { useJobs } from "../../lib/jobs";
import { toSubtitleTime, useSubAlign } from "../../lib/subAlign";
import { useStore } from "../../store";
import { activeSegIndex } from "./playerUtils";

export function AudioSubtitles({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const items = useJobs((s) => s.translations[ep.id]?.items);
  const time = useStore((s) => (s.current?.id === ep.id ? s.time : 0));
  const offset = useSubAlign((s) => s.offsets[ep.id] ?? 0);
  const rawMode = useStore((s) => s.prefs.subtitleMode);
  const mode = rawMode === "off" ? "bilingual" : rawMode;
  const showNext = useStore((s) => s.prefs.audioNextLine);

  if (!transcript || !transcript.segments.length) return null;
  const subTime = toSubtitleTime(time, offset);
  const segs = transcript.segments;
  const i = Math.max(0, activeSegIndex(segs, subTime));
  const seg = segs[i];
  if (!seg) return null;

  const progress = Math.min(1, Math.max(0, (subTime - seg.start) / Math.max(0.5, seg.end - seg.start)));
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
      <div key={`${i}-${k}`} className="asub-line now">
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
