import { useEffect, useMemo, useRef, useState } from "react";
import { Captions, Check, CheckCircle2, Languages, Loader2, Maximize2, Minimize2, Pause, Play, Square, Volume1, Volume2, VolumeX } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { countTranslated, isMostlyChinese, parseGuideMarkdown } from "../../lib/ai";
import type { Episode } from "../../lib/api";
import { clock } from "../../lib/format";
import { runTranslate, stopTranslate, useJobs } from "../../lib/jobs";
import { useStore } from "../../store";
import { isVideoMediaUrl, persistProgress, RATES, toggleMute } from "./playerUtils";

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
    trProviderId,
    trModel,
    chatProviderId,
    agents,
    verifiedAgents,
    keyStatus,
    providerOverrides,
    savePrefs,
    openSettings,
    getTranslateProvider,
    isProviderReady,
  } = useStore(
    useShallow((s) => ({
      mode: s.prefs.subtitleMode,
      trProviderId: s.prefs.translateProviderId,
      trModel: s.prefs.translateModel,
      chatProviderId: s.chatProviderId,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      keyStatus: s.keyStatus,
      providerOverrides: s.providerOverrides,
      savePrefs: s.savePrefs,
      openSettings: s.openSettings,
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
  const done = Math.min(total, countTranslated(items));
  const running = !!trJob?.running;
  const wantsZh = total > 0 && !isMostlyChinese(segments);
  const hasDone = total > 0 && done >= total;
  const doneSourceLabel =
    trJob?.engine === "google" ? "旧版快翻" : trJob?.engine === "llm" ? "大模型精译" : "中文字幕";
  const progressDone = trJob?.retranslating ? (trJob.pendingDone ?? 0) : done;
  const trEngineHint =
    !canLlm || !trProvider
      ? "请先在设置中配置或验证可用 AI 模型"
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
                    <button
                      type="button"
                      className="btn sm primary"
                      title={trEngineHint}
                      onClick={() => void runTranslate(ep, { restart: true })}
                    >
                      <Languages size={13} />
                      <span>升级大模型精译</span>
                    </button>
                  ) : (
                    <div className="sub-tr-alts">
                      <button
                        type="button"
                        className="link-btn"
                        title={`使用当前默认引擎重新翻译（${trEngineHint}）`}
                        onClick={() => {
                          if (!canLlm) {
                            setOpen(false);
                            openSettings("ai", trProvider?.id);
                            return;
                          }
                          void runTranslate(ep, { restart: true });
                        }}
                      >
                        {canLlm ? "重新翻译" : "配置模型后重译"}
                      </button>
                    </div>
                  )
                ) : (
                  <button
                    type="button"
                    className="btn sm primary"
                    title={trEngineHint}
                    onClick={() => {
                      if (!canLlm) {
                        setOpen(false);
                        openSettings("ai", trProvider?.id);
                        return;
                      }
                      void runTranslate(ep);
                    }}
                  >
                    <Languages size={13} />
                    <span>{!canLlm ? "去设置模型" : done > 0 ? "继续大模型翻译" : "大模型翻译"}</span>
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RateMenu({ rate, max }: { rate: number; max?: number }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const savePrefs = useStore((s) => s.savePrefs);
  const player = useStore((s) => s.player);

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

  const shown = max && rate > max ? max : rate;
  return (
    <div className="rate-wrap" ref={boxRef}>
      <button
        type="button"
        className={`rate-btn ${shown !== 1 ? "is-custom" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="切换倍速 ([ / ])"
        onClick={() => setOpen((v) => !v)}
      >
        {shown}×
      </button>
      {open && (
        <div className="rate-pop" role="menu" aria-label="播放倍速">
          {[...RATES].reverse().map((r) => {
            const disabled = !!max && r > max;
            return (
              <button
                key={r}
                type="button"
                role="menuitemradio"
                aria-checked={r === shown}
                disabled={disabled}
                title={disabled ? "YouTube 嵌入播放最高 2×，可切到「仅音频」或直链以使用更快倍速" : undefined}
                className={r === shown ? "on" : ""}
                onClick={() => {
                  player?.setRate(r);
                  savePrefs({ playbackRate: r });
                  setOpen(false);
                }}
              >
                <Check size={13} className="rate-check" />
                <span>{r === 1 ? "1× 正常" : `${r}×`}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Controls({
  ep,
  onFullscreen,
  isFullscreen,
}: {
  ep: Episode;
  onFullscreen?: () => void;
  isFullscreen?: boolean;
}) {
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

  const guideRaw = useJobs((s) => s.guides[ep.id]?.summary ?? s.guides[ep.id]?.streaming ?? "");
  const chapters = useMemo(() => (guideRaw ? parseGuideMarkdown(guideRaw).timeline : []), [guideRaw]);

  const [drag, setDrag] = useState<number | null>(null);
  const [hoverSeek, setHoverSeek] = useState<{ pct: number; sec: number } | null>(null);
  const [backTick, setBackTick] = useState(0);
  const [fwdTick, setFwdTick] = useState(0);

  useEffect(() => {
    setHoverSeek(null);
    setDrag(null);
  }, [ep.id]);

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
  const preview =
    totalLen > 0
      ? drag != null
        ? { pct: Math.min(100, Math.max(0, (drag / totalLen) * 100)), sec: drag }
        : hoverSeek
      : null;
  let previewChapter: (typeof chapters)[number] | null = null;
  if (preview && chapters.length > 0) {
    for (const ch of chapters) {
      if (ch.sec <= preview.sec + 0.5) previewChapter = ch;
      else break;
    }
  }

  return (
    <div className="controls">
      <button
        type="button"
        className={`icon-btn${backTick ? (backTick % 2 === 1 ? " nudge-ccw-a" : " nudge-ccw-b") : ""}`}
        title="后退 10 秒 (←)"
        aria-label="后退 10 秒"
        disabled={!player}
        onClick={() => {
          setBackTick((n) => n + 1);
          player?.seek(Math.max(0, time - 10));
        }}
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
        className={`icon-btn${fwdTick ? (fwdTick % 2 === 1 ? " nudge-cw-a" : " nudge-cw-b") : ""}`}
        title="前进 10 秒 (→)"
        aria-label="前进 10 秒"
        disabled={!player}
        onClick={() => {
          setFwdTick((n) => n + 1);
          player?.seek(time + 10);
        }}
      >
        <SeekForward10Icon />
      </button>

      <span className="time">{clock(shown)}</span>

      <div
        className="seek-wrap"
        onPointerMove={(e) => {
          if (!totalLen) return;
          const rect = e.currentTarget.getBoundingClientRect();
          if (rect.width <= 0) return;
          const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
          setHoverSeek({ pct: ratio * 100, sec: Math.round(ratio * totalLen) });
        }}
        onPointerLeave={() => setHoverSeek(null)}
      >
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
              persistProgress(ep, drag);
              setDrag(null);
            }
          }}
          onKeyUp={() => {
            if (drag != null) {
              player?.seek(drag);
              persistProgress(ep, drag);
              setDrag(null);
            }
          }}
          style={{ "--fill": `${totalLen ? Math.min(100, (shown / totalLen) * 100) : 0}%` } as React.CSSProperties}
          aria-label="播放进度"
        />
        {preview && (
          <div
            className="seek-tip"
            style={{ "--hover-pct": `${preview.pct}%` } as React.CSSProperties}
            aria-hidden="true"
          >
            <span className="seek-tip-time">{clock(preview.sec)}</span>
            {previewChapter && <span className="seek-tip-ch">{previewChapter.title}</span>}
          </div>
        )}
      </div>

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

      <RateMenu rate={rate} max={player?.maxRate} />

      {isVideo && onFullscreen && (
        <button
          type="button"
          className="icon-btn"
          title={isFullscreen ? "退出全屏 (Esc / F)" : "全屏观看 (F)"}
          aria-label={isFullscreen ? "退出全屏" : "全屏观看"}
          onClick={onFullscreen}
        >
          {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
      )}
    </div>
  );
}
