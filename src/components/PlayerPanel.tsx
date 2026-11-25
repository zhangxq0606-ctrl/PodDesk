import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Captions,
  ExternalLink,
  FileText,
  MessageCircle,
  PanelRightClose,
  PanelRightOpen,
  ScrollText,
  Trash2,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { translateTextsWithAi } from "../lib/ai";
import { api, type Episode } from "../lib/api";
import { ask } from "../lib/confirm";
import { formatDuration, formatPublishDate, notesText, parseClock } from "../lib/format";
import { clearEpisodeJobs, loadEpisodeTranscript, useJobs } from "../lib/jobs";
import {
  defaultAudioPanelWidth,
  PANEL,
  sortAudioTabs,
  sortVideoTabs,
  SPLIT_DEFAULT_RATIO,
  useLayout,
  type AudioTab,
  type VideoTab,
} from "../lib/layout";
import { useEpisodeTitleDisplay } from "../lib/zh";
import { useStore } from "../store";
import { ChatPanel, EpisodeOverviewCard, GuideTimelinePanel } from "./ChatPanel";
import { SkeletonEpisode } from "./Illustrations";
import { Controls, isVideoMediaUrl, MediaStage } from "./Players";
import { TopBar } from "./Sidebar";
import { SplitRatioDivider, Splitter } from "./Splitter";
import { TranscriptPanel } from "./TranscriptPanel";

type RightTab = "guide" | "transcript" | "chat";

function withStamps(text: string, onSeek: (sec: number) => void): ReactNode[] {
  return text.split(/(https?:\/\/[^\s<>"'）)】]+|\b(?:\d{1,2}:)?\d{1,2}:\d{2}\b)/g).map((part, i) => {
    if (i % 2 === 0) return part;
    if (/^https?:/.test(part)) {
      return (
        <a key={i} href={part} className="notes-link" target="_blank" rel="noreferrer">
          {part.replace(/^https?:\/\/(www\.)?/, "").slice(0, 60)}
        </a>
      );
    }
    const sec = parseClock(part);
    if (sec == null) return part;
    return (
      <button key={i} type="button" className="stamp" title={`跳转到 ${part}`} onClick={() => onSeek(sec)}>
        {part}
      </button>
    );
  });
}

function ShowNotesModal({ ep, text, onClose }: { ep: Episode; text: string; onClose: () => void }) {
  const seekToEpisode = useStore((s) => s.seekToEpisode);
  const [zhParas, setZhParas] = useState<string[] | null>(null);
  const [showOrig, setShowOrig] = useState(false);
  const [translating, setTranslating] = useState(false);

  const paras = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  const isZhAlready = /[\u4e00-\u9fff]/.test(text.slice(0, 120));

  useEffect(() => {
    setZhParas(null);
    setShowOrig(false);
    setTranslating(false);
  }, [ep.id]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const handleTranslateNotes = async () => {
    if (zhParas) {
      setShowOrig((v) => !v);
      return;
    }
    if (translating) return;
    const store = useStore.getState();
    const provider = store.getTranslateProvider();
    if (!provider || !store.isProviderReady(provider)) {
      store.notify("请先在设置中配置或验证可用 AI 模型", false, {
        label: "去设置",
        run: () => store.openSettings("ai", provider?.id),
      });
      return;
    }
    setTranslating(true);
    try {
      const items = await translateTextsWithAi(provider, paras.slice(0, 30));
      setZhParas(items);
      setShowOrig(false);
    } catch (err) {
      store.notify(err instanceof Error ? err.message : "简介翻译失败", false);
    } finally {
      setTranslating(false);
    }
  };

  const shown = !isZhAlready && !showOrig && zhParas?.length ? zhParas : paras;

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal notes-modal" role="dialog" aria-modal="true" aria-label="本集简介">
        <div className="modal-head">
          <h3>本集简介（Show Notes）</h3>
          <div className="row-tight">
            {!isZhAlready && (
              <button type="button" className="btn sm ghost" onClick={() => void handleTranslateNotes()}>
                {translating ? "翻译中…" : zhParas ? (showOrig ? "看中文" : "看原文") : "翻译简介"}
              </button>
            )}
            <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
              <X size={16} />
            </button>
          </div>
        </div>
        <div className="modal-body">
          <div className="notes-body">
            {shown.map((p, i) => (
              <p key={i}>{withStamps(p, (sec) => seekToEpisode(ep, sec))}</p>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function extractSingleAuthor(ep: Episode): string | null {
  if (ep.showId !== "single" || !ep.videoId || !ep.notes) return null;
  const first = ep.notes.split("\n\n")[0]?.trim() ?? "";
  if (!first || first.length > 60 || first.includes("\n") || /^https?:\/\//i.test(first)) return null;
  return first;
}

function renderRightPane(kind: RightTab, ep: Episode) {
  if (kind === "guide") return <GuideTimelinePanel ep={ep} />;
  if (kind === "transcript") return <TranscriptPanel ep={ep} />;
  return <ChatPanel ep={ep} />;
}

export function EpisodeView({ id }: { id: string }) {
  const { cached, load, deleteEpisode } = useStore(
    useShallow((s) => ({
      cached: s.episodeCache[id],
      load: s.load,
      deleteEpisode: s.deleteEpisode,
    })),
  );
  const { panel, audioPanel, audioTabs, videoTabs, panelOpen, splitRatio, put } = useLayout(
    useShallow((l) => ({
      panel: l.panel,
      audioPanel: l.audioPanel,
      audioTabs: l.audioTabs,
      videoTabs: l.videoTabs,
      panelOpen: l.panelOpen,
      splitRatio: l.splitRatio,
      put: l.put,
    })),
  );
  const draftAsk = useJobs((s) => s.draftAsk);

  const [ep, setEp] = useState<Episode | null>(cached ?? null);
  const [preferAudio, setPreferAudio] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setNotesOpen(false);
    setPreferAudio(false);
  }, [id]);

  useEffect(() => {
    let alive = true;
    const hit = useStore.getState().episodeCache[id];
    if (hit) void loadEpisodeTranscript(hit);
    void api
      .getEpisode(id)
      .then((full) => {
        if (!alive) return;
        setEp(full);
        useStore.getState().touchEpisodeLocal(full);
        void loadEpisodeTranscript(full);
        const st = useStore.getState();
        if (st.current?.id !== full.id && !st.playing) {
          load(full);
        }
      })
      .catch(() => {
        /* fallback to cached if any */
      });
    return () => {
      alive = false;
    };
  }, [id, load]);

  useEffect(() => {
    if (!draftAsk || draftAsk.episodeId !== id) return;
    if (!panelOpen) put({ panelOpen: true });
    const hasVid = !!(ep?.videoId || isVideoMediaUrl(ep?.audioUrl));
    const both = !!(ep?.videoId && ep?.audioUrl && !isVideoMediaUrl(ep?.audioUrl));
    const isVidMode = hasVid && !(both && preferAudio);
    if (isVidMode) {
      const cur = sortVideoTabs(useLayout.getState().videoTabs);
      if (!cur.includes("chat")) {
        put({ videoTabs: sortVideoTabs([...cur, "chat"]) });
      }
    } else {
      const cur = sortAudioTabs(useLayout.getState().audioTabs);
      if (!cur.includes("chat")) {
        put({ audioTabs: cur.length >= 2 ? ["transcript", "chat"] : sortAudioTabs([...cur, "chat"]) });
      }
    }
  }, [draftAsk, id, ep?.videoId, ep?.audioUrl, preferAudio, panelOpen, put]);

  const epTitle = useEpisodeTitleDisplay(ep?.title);

  if (!ep) {
    return (
      <div className="episode">
        <TopBar />
        <SkeletonEpisode />
      </div>
    );
  }

  const notes = notesText(ep.notes);
  const hasVideo = !!(ep.videoId || isVideoMediaUrl(ep.audioUrl));
  const hasBothSources = !!(ep.videoId && ep.audioUrl && !isVideoMediaUrl(ep.audioUrl));
  const showVideo = hasVideo && !(hasBothSources && preferAudio);
  const hasMedia = !!(ep.audioUrl || ep.videoId);
  const stageEp: Episode = hasBothSources && preferAudio ? { ...ep, videoId: undefined } : ep;
  const orderedVideoTabs = sortVideoTabs(videoTabs);
  const orderedAudioTabs = sortAudioTabs(audioTabs);
  const activeTabs: RightTab[] = showVideo ? orderedVideoTabs : orderedAudioTabs;
  const isSplit = activeTabs.length === 2;
  const effectivePanelW = showVideo ? panel : audioPanel;
  const maxPanelW = showVideo
    ? 960
    : typeof window !== "undefined"
      ? Math.max(960, Math.round(window.innerWidth * 0.72))
      : 1080;

  const switchMediaMode = (toAudio: boolean) => {
    const st = useStore.getState();
    const t = st.current?.id === ep.id ? st.time : ep.progress;
    const wasPlaying = st.current?.id === ep.id && (st.playing || !!st.loadingSince);
    setPreferAudio(toAudio);
    if (st.current?.id !== ep.id) return;
    const nextCurrent = toAudio ? { ...ep, videoId: undefined, progress: t } : { ...ep, progress: t };
    useStore.setState({ current: nextCurrent, time: t, player: null, playing: false, loadingSince: null });
    if (wasPlaying) st.playSoon(ep.id);
  };

  const handleDelete = () => {
    void ask({
      title: `删除「${ep.title}」？`,
      message: "将移除该单集的本地字幕、翻译、问答记录与上传的本地媒体文件。",
      ok: "删除",
      danger: true,
    }).then((yes) => {
      if (yes) {
        clearEpisodeJobs(ep.id);
        void deleteEpisode(ep.id);
      }
    });
  };

  const origHref = ep.videoId ? `https://www.youtube.com/watch?v=${ep.videoId}` : ep.link;

  const toggleTab = (target: RightTab) => {
    if (showVideo) {
      const t = target as VideoTab;
      if (orderedVideoTabs.includes(t)) {
        if (orderedVideoTabs.length <= 1) return;
        put({ videoTabs: orderedVideoTabs.filter((x) => x !== t) });
        return;
      }
      put({ videoTabs: sortVideoTabs([...orderedVideoTabs, t]) });
      return;
    }
    const t = target as AudioTab;
    if (orderedAudioTabs.includes(t)) {
      if (orderedAudioTabs.length <= 1) return;
      put({ audioTabs: orderedAudioTabs.filter((x) => x !== t) });
      return;
    }
    if (orderedAudioTabs.length >= 2) {
      useStore.getState().notify("最多同时打开两栏，点已选标签可取消");
      return;
    }
    put({ audioTabs: sortAudioTabs([...orderedAudioTabs, t]) });
  };

  const tabMeta: { id: RightTab; label: string; icon: ReactNode }[] = showVideo
    ? [
        { id: "guide", label: "导读", icon: <ScrollText size={15} /> },
        { id: "chat", label: "问答", icon: <MessageCircle size={15} /> },
      ]
    : [
        { id: "transcript", label: hasMedia ? "字幕" : "文稿", icon: hasMedia ? <Captions size={15} /> : <FileText size={15} /> },
        { id: "guide", label: "导读", icon: <ScrollText size={15} /> },
        { id: "chat", label: "问答", icon: <MessageCircle size={15} /> },
      ];

  return (
    <div className="episode">
      <div
        className={`ep-body ${panelOpen ? "" : "panel-collapsed"} ${isSplit && panelOpen ? "split-mode" : ""}`}
        style={{ "--panel-w": `${panelOpen ? effectivePanelW : 0}px` } as React.CSSProperties}
      >
        <div className="ep-leftcol">
          <TopBar
            rightExtra={
              !panelOpen ? (
                <button
                  type="button"
                  className="icon-btn pane-toggle"
                  aria-label="展开工作栏 (Ctrl+\)"
                  onClick={() => put({ panelOpen: true })}
                >
                  <PanelRightOpen size={16} />
                </button>
              ) : undefined
            }
          />
          <section className="ep-left">
            <div className="ep-title-block">
              <div className="ep-title">
                <h1>{epTitle.primary}</h1>
                {epTitle.secondary && <p className="ep-title-orig">{epTitle.secondary}</p>}
                <p className="meta-line">
                  <span>
                    {ep.showTitle ||
                      extractSingleAuthor(ep) ||
                      (ep.videoId ? "YouTube 单集" : ep.audioUrl ? "本地/单集音频" : "导入文稿")}
                  </span>
                  {ep.published ? <span>· {formatPublishDate(ep.published)}</span> : null}
                  {ep.duration ? <span>· {formatDuration(ep.duration)}</span> : null}
                </p>
              </div>

              <div className="row-tight">
                {notes && (
                  <button
                    type="button"
                    className="round-btn"
                    title="查看本集简介 (Show Notes)"
                    aria-label="查看本集简介"
                    onClick={() => setNotesOpen(true)}
                  >
                    <FileText size={15} />
                  </button>
                )}
                {origHref && (
                  <a
                    className="round-btn"
                    href={origHref}
                    target="_blank"
                    rel="noreferrer"
                    title="在原网页打开"
                    onClick={(e) => {
                      if (!ep.videoId) return;
                      const st = useStore.getState();
                      const t = st.current?.id === ep.id ? st.time : ep.progress;
                      e.currentTarget.href =
                        t > 5
                          ? `https://www.youtube.com/watch?v=${ep.videoId}&t=${Math.floor(t)}s`
                          : `https://www.youtube.com/watch?v=${ep.videoId}`;
                    }}
                  >
                    <ExternalLink size={15} />
                  </a>
                )}
                <button type="button" className="round-btn" title="删除这一集" onClick={handleDelete}>
                  <Trash2 size={15} />
                </button>
              </div>
            </div>

            {hasBothSources && (
              <div className="media-switch-row">
                <div className="seg-control" role="radiogroup" aria-label="播放形态">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={!preferAudio}
                    className={!preferAudio ? "on" : ""}
                    onClick={() => preferAudio && switchMediaMode(false)}
                  >
                    视频
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={preferAudio}
                    className={preferAudio ? "on" : ""}
                    onClick={() => !preferAudio && switchMediaMode(true)}
                  >
                    仅音频
                  </button>
                </div>
              </div>
            )}

            <div className={`stage-body ${hasMedia ? "" : "is-text"}`}>
              {showVideo ? (
                <div className="stage-video-wrap">
                  <MediaStage ep={stageEp} />
                  <Controls ep={stageEp} />
                </div>
              ) : hasMedia ? (
                <div className="stage-audio-wrap">
                  <MediaStage ep={stageEp} />
                  <Controls ep={stageEp} />
                </div>
              ) : (
                <MediaStage ep={stageEp} />
              )}
            </div>

            <EpisodeOverviewCard ep={ep} showEmptyCta={!showVideo} />
          </section>
        </div>

        {notesOpen && notes && <ShowNotesModal ep={ep} text={notes} onClose={() => setNotesOpen(false)} />}

        {panelOpen && (
          <Splitter
            value={effectivePanelW}
            min={PANEL.min}
            max={maxPanelW}
            def={showVideo ? PANEL.def : defaultAudioPanelWidth()}
            snap={PANEL.snap}
            edge="left"
            label="右侧工作栏宽度"
            onChange={(w) => put(showVideo ? { panel: w } : { audioPanel: w })}
            onCollapse={() => put({ panelOpen: false })}
          />
        )}

        {panelOpen && (
          <section className="ep-right">
            <div className="tabs" role="tablist">
              {tabMeta.map((item) => {
                const selected = activeTabs.includes(item.id);
                const atLimit = !selected && activeTabs.length >= 2;
                const tip = selected
                  ? activeTabs.length >= 2
                    ? "点击取消该栏"
                    : "当前显示（再选一项可并排双栏）"
                  : atLimit
                    ? "最多同时打开两栏，点已选标签可取消"
                    : "点击并排打开";
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    className={selected ? "on" : atLimit ? "at-limit" : ""}
                    title={tip}
                    onClick={() => toggleTab(item.id)}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                );
              })}

              <span className="spacer" />

              <button
                type="button"
                className="icon-btn pane-toggle"
                aria-label="收起工作栏 (Ctrl+\)"
                onClick={() => put({ panelOpen: false })}
              >
                <PanelRightClose size={16} />
              </button>
            </div>

            <div className="tab-body">
              {activeTabs.length === 2 ? (
                <div
                  className="split-panels"
                  ref={splitRef}
                  style={{ "--split-left": `${splitRatio * 100}%` } as React.CSSProperties}
                >
                  <div className="split-col">{renderRightPane(activeTabs[0], ep)}</div>
                  <SplitRatioDivider
                    containerRef={splitRef}
                    ratio={splitRatio}
                    defaultRatio={SPLIT_DEFAULT_RATIO}
                    thresholdPx={180}
                    onChange={(r) => put({ splitRatio: r })}
                    onCollapseLeft={() =>
                      showVideo
                        ? put({ videoTabs: [activeTabs[1] as VideoTab] })
                        : put({ audioTabs: [activeTabs[1] as AudioTab] })
                    }
                    onCollapseRight={() =>
                      showVideo
                        ? put({ videoTabs: [activeTabs[0] as VideoTab] })
                        : put({ audioTabs: [activeTabs[0] as AudioTab] })
                    }
                  />
                  <div className="split-col">{renderRightPane(activeTabs[1], ep)}</div>
                </div>
              ) : (
                renderRightPane(activeTabs[0], ep)
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
