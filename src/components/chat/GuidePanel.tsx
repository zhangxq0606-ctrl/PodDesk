import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check, ChevronDown, Copy, Download, Loader2, Mic, RefreshCw, ScrollText, Sparkles, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { hasTimelineHeading, parseGuideMarkdown } from "../../lib/ai";
import type { Episode } from "../../lib/api";
import { fetchOfficialSub, loadEpisodeGuide, runEpisodeGuide, runTranscribe, stopEpisodeGuide, stopTranscribe, useJobs } from "../../lib/jobs";
import { useLayout } from "../../lib/layout";
import { CLOUD_ASR_PRESETS } from "../../lib/providers";
import { downloadTextFile, formatAnswerCopy, safeFileName } from "../../lib/subexport";
import { useStore } from "../../store";
import { CassetteArt, PageArt, WaveToTextArt } from "../Illustrations";
import { Markdown } from "../Markdown";
import { copyTextSafe } from "./CopyMenu";
import { shortModelName } from "./ModelPicker";

export function EpisodeOverviewCard({ ep, showEmptyCta = false }: { ep: Episode; showEmptyCta?: boolean }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const guide = useJobs((s) => s.guides[ep.id]);
  const {
    seekToEpisode,
    openSettings,
    getChatProvider,
    isProviderReady,
    chatProviderId,
    chatModel,
    agents,
    verifiedAgents,
    keyStatus,
    providerOverrides,
  } = useStore(
    useShallow((s) => ({
      seekToEpisode: s.seekToEpisode,
      openSettings: s.openSettings,
      getChatProvider: s.getChatProvider,
      isProviderReady: s.isProviderReady,
      chatProviderId: s.chatProviderId,
      chatModel: s.chatModel,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      keyStatus: s.keyStatus,
      providerOverrides: s.providerOverrides,
    })),
  );
  const { guideOpen, put } = useLayout(
    useShallow((l) => ({ guideOpen: l.guideOpen, put: l.put })),
  );

  useEffect(() => {
    void loadEpisodeGuide(ep.id);
  }, [ep.id]);

  const onSeek = useCallback(
    (t: number) => {
      seekToEpisode(ep, t);
    },
    [ep, seekToEpisode],
  );

  const provider = useMemo(
    () => getChatProvider(),
    [getChatProvider, chatProviderId, chatModel, agents, verifiedAgents, providerOverrides],
  );
  const providerReady = isProviderReady(provider);
  void keyStatus;

  const streaming = guide?.streaming ?? null;
  const summary = guide?.summary ?? null;
  const isStreaming = streaming !== null;
  const rawMd = streaming ?? summary ?? "";
  const parsed = useMemo(() => parseGuideMarkdown(rawMd), [rawMd]);

  if (!isStreaming && !summary) {
    if (!showEmptyCta || !transcript) return null;
    return (
      <section className="overview-card is-empty">
        <div className="overview-head is-static">
          <ScrollText size={14} className="muted" />
          <span className="overview-title">内容精炼</span>
          <span className="muted small clamp1">一句话总结与核心要点</span>
          <span className="spacer" />
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => {
              if (!providerReady) {
                openSettings("ai", provider?.id);
                return;
              }
              void runEpisodeGuide(ep);
            }}
          >
            <Sparkles size={13} />
            <span>{providerReady ? "生成导读与精炼" : "去设置模型"}</span>
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className={`overview-card ${guideOpen ? "open" : ""}`}>
      <div
        className="overview-head"
        role="button"
        tabIndex={0}
        aria-expanded={guideOpen}
        onClick={() => put({ guideOpen: !guideOpen })}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            put({ guideOpen: !guideOpen });
          }
        }}
      >
        <ScrollText size={14} className="muted" />
        <span className="overview-title">内容精炼</span>
        {isStreaming && <Loader2 size={12} className="spin muted" />}
        <span className="spacer" />
        <ChevronDown size={15} className={`muted guide-chev ${guideOpen ? "flip" : ""}`} />
      </div>

      <div className="overview-collapse" aria-hidden={!guideOpen}>
        <div className="overview-collapse-inner">
          <div className="overview-body summary">
            {parsed.overviewMd ? (
              <Markdown text={parsed.overviewMd} onSeek={onSeek} />
            ) : isStreaming ? (
              <p className="muted small row-tight">
                <span className="thinking-shine">正在提炼全片核心内容…</span>
              </p>
            ) : (
              <p className="muted small">暂无精炼摘要，可在右侧查看章节时间线。</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

export function GuideTimelinePanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const officialStatus = useJobs((s) => s.officialStatus[ep.id] ?? "idle");
  const officialError = useJobs((s) => s.officialError[ep.id]);
  const asrJob = useJobs((s) => s.asr[ep.id]);
  const guide = useJobs((s) => s.guides[ep.id]);

  const {
    seekToEpisode,
    openSettings,
    setImportOpen,
    getChatProvider,
    isProviderReady,
    asrChoice,
    asrLang,
    asrStatus,
    asrKeyStatus,
    keyStatus,
    savePrefs,
    chatProviderId,
    chatModel,
    agents,
    verifiedAgents,
    providerOverrides,
  } = useStore(
    useShallow((s) => ({
      seekToEpisode: s.seekToEpisode,
      openSettings: s.openSettings,
      setImportOpen: s.setImportOpen,
      getChatProvider: s.getChatProvider,
      isProviderReady: s.isProviderReady,
      asrChoice: s.prefs.asrChoice,
      asrLang: s.prefs.asrLang,
      asrStatus: s.asrStatus,
      asrKeyStatus: s.asrKeyStatus,
      keyStatus: s.keyStatus,
      savePrefs: s.savePrefs,
      chatProviderId: s.chatProviderId,
      chatModel: s.chatModel,
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      providerOverrides: s.providerOverrides,
    })),
  );

  const listRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const prevActiveRef = useRef(-1);
  const [offscreen, setOffscreen] = useState<"above" | "below" | null>(null);
  const [showAsrOpts, setShowAsrOpts] = useState(false);
  const [copiedGuide, setCopiedGuide] = useState(false);
  const copyTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  useEffect(() => {
    followRef.current = true;
    prevActiveRef.current = -1;
    setCopiedGuide(false);
    void loadEpisodeGuide(ep.id);
  }, [ep.id]);

  const onSeek = useCallback(
    (t: number) => {
      seekToEpisode(ep, t);
    },
    [ep, seekToEpisode],
  );

  const provider = useMemo(
    () => getChatProvider(),
    [getChatProvider, chatProviderId, chatModel, agents, verifiedAgents, providerOverrides],
  );
  const providerReady = isProviderReady(provider);
  const streaming = guide?.streaming ?? null;
  const summary = guide?.summary ?? null;
  const error = guide?.error ?? null;
  const isStreaming = streaming !== null;
  const rawMd = streaming ?? summary ?? "";
  const parsed = useMemo(() => parseGuideMarkdown(rawMd), [rawMd]);
  const timeline = parsed.timeline;

  const activeIdx = useStore((s) => {
    if (s.current?.id !== ep.id || !timeline.length) return -1;
    const t = s.time;
    let hit = -1;
    for (let i = 0; i < timeline.length; i++) {
      if (timeline[i].sec <= t + 0.5) hit = i;
      else break;
    }
    return hit;
  });

  const checkActiveVisibility = useCallback(() => {
    const wrap = listRef.current;
    if (!wrap) {
      setOffscreen(null);
      return;
    }
    const activeEl = wrap.querySelector<HTMLElement>("[data-gt-active]");
    if (!activeEl) {
      setOffscreen(null);
      return;
    }
    const box = wrap.getBoundingClientRect();
    const rect = activeEl.getBoundingClientRect();
    if (rect.bottom < box.top + 8) {
      setOffscreen("above");
      followRef.current = false;
    } else if (rect.top > box.bottom - 8) {
      setOffscreen("below");
      followRef.current = false;
    } else {
      setOffscreen(null);
      followRef.current = true;
    }
  }, []);

  useEffect(() => {
    if (activeIdx === prevActiveRef.current) return;
    prevActiveRef.current = activeIdx;
    if (activeIdx < 0 || !followRef.current) return;
    listRef.current
      ?.querySelector<HTMLElement>("[data-gt-active]")
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [activeIdx]);

  useEffect(() => {
    checkActiveVisibility();
  }, [activeIdx, timeline.length, checkActiveVisibility]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => checkActiveVisibility());
    ro.observe(el);
    return () => ro.disconnect();
  }, [checkActiveVisibility, timeline.length, summary]);

  const handleWheel = () => {
    followRef.current = false;
  };

  const transcriptLoading = transcript === undefined || officialStatus === "loading";
  const guideLoading = !!transcript && !guide?.loaded && !summary && !isStreaming;

  if (asrJob?.running) {
    const pct = typeof asrJob.pct === "number" ? Math.round(asrJob.pct * 100) : null;
    return (
      <div className="panel-empty gt-fade-in">
        <CassetteArt mode="listen" />
        <p className="lead">{asrJob.stage || "正在语音转写…"}</p>
        {pct != null && (
          <div className="progress-block">
            <div className="bar">
              <div style={{ width: `${Math.max(3, pct)}%` }} />
            </div>
            <span>{pct}%</span>
          </div>
        )}
        <button type="button" className="btn sm ghost" onClick={() => stopTranscribe(ep.id)}>
          <Square size={12} /> 取消转写
        </button>
      </div>
    );
  }

  if (transcriptLoading) {
    return (
      <div className="gt-panel">
        <div className="gt-skeleton" aria-busy="true" aria-label="正在读取字幕与导读">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gt-sk-row">
              <div className="gt-sk-rail">
                <span className="gt-sk-dot" />
                <span className="gt-sk-line" />
              </div>
              <div className="gt-sk-card">
                <div className="sk sk-line sm" style={{ width: "38%" }} />
                <div className="sk sk-line" style={{ width: i % 2 === 0 ? "92%" : "78%" }} />
                <div className="sk sk-line" style={{ width: "64%" }} />
              </div>
            </div>
          ))}
          <p className="muted small gt-sk-hint">正在读取字幕与导读…</p>
        </div>
      </div>
    );
  }

  if (!transcript) {
    if (officialStatus === "searching") {
      return (
        <div className="panel-empty gt-fade-in">
          <Loader2 size={24} className="spin muted" />
          <p className="lead thinking-shine">正在获取官方字幕…</p>
          <p className="muted small">拿到字幕后即可生成精炼梳理与章节导读</p>
        </div>
      );
    }

    const hasMedia = !!(ep.audioUrl || ep.videoId);
    const isCloud = asrChoice.startsWith("cloud:");
    const cloudPreset = isCloud ? CLOUD_ASR_PRESETS.find((p) => p.id === asrChoice.slice(6)) : undefined;
    const localReady = !!(asrStatus?.engineReady && asrStatus?.modelReady);
    const cloudReady =
      !cloudPreset ||
      !cloudPreset.needsKey ||
      !!asrKeyStatus[cloudPreset.id] ||
      (cloudPreset.id === "deepseek" && !!keyStatus.deepseek);

    return (
      <div className="panel-empty gt-fade-in">
        <div className="gen-card">
          <WaveToTextArt />
          <h3 className="gen-title">这一集还没有字幕</h3>
          <p className="muted small">
            {isCloud
              ? `使用「${cloudPreset?.name ?? "云端 ASR"}」转写，拿到文字稿后即可生成导读与问答。`
              : "先通过本机离线转写或导入字幕拿到文字稿，即可生成精炼导读与随时问答。"}
          </p>
          {officialError && <p className="error-text small">官方字幕读取失败：{officialError}</p>}
          {asrJob?.error && (
            <div className="setup-note">
              <span>{asrJob.error}</span>
              <button type="button" className="btn sm primary" onClick={() => openSettings("asr")}>
                去设置
              </button>
            </div>
          )}
          <div className="row-actions center" style={{ marginTop: 6 }}>
            {hasMedia && (
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  if ((!isCloud && !localReady) || (isCloud && !cloudReady)) {
                    openSettings("asr");
                    return;
                  }
                  void runTranscribe(ep);
                }}
              >
                <Mic size={15} />
                <span>
                  {!isCloud && !localReady
                    ? "去下载离线转写模型"
                    : isCloud && !cloudReady
                      ? "去填写云端 ASR Key"
                      : "语音转写生成字幕"}
                </span>
              </button>
            )}
            {(ep.videoId || ep.transcriptUrl) && (
              <button type="button" className="btn" onClick={() => void fetchOfficialSub(ep, false)}>
                <RefreshCw size={14} /> 重试官方字幕
              </button>
            )}
            <button type="button" className="btn ghost" onClick={() => setImportOpen(true)}>
              导入字幕 / 文稿
            </button>
          </div>
          {hasMedia && (
            <>
              <button type="button" className="link-btn" onClick={() => setShowAsrOpts((v) => !v)}>
                <span>识别引擎与语言设置</span>
                <ChevronDown size={13} className={showAsrOpts ? "flip" : ""} />
              </button>
              {showAsrOpts && (
                <div className="gen-options">
                  <label>
                    <span>识别引擎</span>
                    <select value={asrChoice} onChange={(e) => savePrefs({ asrChoice: e.target.value })}>
                      <option value="qwen3">本机离线转写（{localReady ? "已就绪" : "需下载"}）</option>
                      {CLOUD_ASR_PRESETS.map((p) => (
                        <option key={p.id} value={`cloud:${p.id}`}>
                          云端 · {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>音频语言</span>
                    <select value={asrLang} onChange={(e) => savePrefs({ asrLang: e.target.value })}>
                      <option value="auto">自动识别</option>
                      <option value="zh">中文</option>
                      <option value="en">英文</option>
                      <option value="ja">日文</option>
                    </select>
                  </label>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    );
  }

  if (guideLoading) {
    return (
      <div className="gt-panel">
        <div className="gt-skeleton" aria-busy="true" aria-label="正在加载导读">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="gt-sk-row">
              <div className="gt-sk-rail">
                <span className="gt-sk-dot" />
                <span className="gt-sk-line" />
              </div>
              <div className="gt-sk-card">
                <div className="sk sk-line sm" style={{ width: "38%" }} />
                <div className="sk sk-line" style={{ width: i % 2 === 0 ? "92%" : "78%" }} />
                <div className="sk sk-line" style={{ width: "64%" }} />
              </div>
            </div>
          ))}
          <p className="muted small gt-sk-hint">正在读取已保存的导读…</p>
        </div>
      </div>
    );
  }

  if (!summary && !isStreaming) {
    const modelLabel = provider
      ? `${provider.name}${provider.model ? ` · ${shortModelName(provider.model)}` : ""}`
      : "未配置";
    return (
      <div className="panel-empty gt-fade-in">
        <div className="gt-empty">
          <PageArt />
          <h3 className="gen-title">为这期生成导读与梳理</h3>
          <p className="muted small">
            一次通读全片文字稿（共 {transcript.segments.length} 段），左侧生成全内容精炼梳理，此处生成随播放推进的章节时间线。
          </p>
          {error && (
            <div className="setup-note">
              <span>{error}</span>
              <button type="button" className="btn sm primary" onClick={() => openSettings("ai", provider?.id)}>
                去设置
              </button>
            </div>
          )}
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              if (!providerReady) {
                openSettings("ai", provider?.id);
                return;
              }
              void runEpisodeGuide(ep);
            }}
          >
            <Sparkles size={15} />
            <span>{providerReady ? "生成导读与梳理" : "去设置验证模型"}</span>
          </button>
          <p className="gt-model-hint">
            当前模型：{modelLabel}
            {!providerReady ? "（尚未验证可用）" : ""}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="gt-panel">
      <div className="gt-scroll-wrap">
        <div className="gt-scroll notranslate" translate="no" ref={listRef} onScroll={checkActiveVisibility} onWheel={handleWheel}>
          {timeline.length > 0 ? (
            <div className="gt-list gt-fade-in">
              {timeline.map((item, idx) => {
                const active = idx === activeIdx;
                const isPast = activeIdx > idx;
                return (
                  <div
                    key={`${item.stamp}-${idx}`}
                    className={`gt-item ${active ? "active" : isPast ? "is-past" : "is-future"}`}
                    data-gt-active={active || undefined}
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      followRef.current = true;
                      onSeek(item.sec);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        followRef.current = true;
                        onSeek(item.sec);
                      }
                    }}
                  >
                    <span className="gt-rail" aria-hidden="true">
                      <span className="gt-line-top" />
                      <span className="gt-dot" />
                      <span className="gt-line-bot" />
                    </span>
                    <div className="gt-card">
                      <div className="gt-item-head">
                        <span className="stamp">{item.stamp}</span>
                        <span className="gt-item-title">{item.title}</span>
                      </div>
                      {item.body && <p className="gt-item-body">{item.body}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : isStreaming ? (
            <div className="gt-skeleton" aria-busy="true" aria-label="正在生成章节时间线">
              {[0, 1, 2].map((i) => (
                <div key={i} className="gt-sk-row">
                  <div className="gt-sk-rail">
                    <span className="gt-sk-dot" />
                    <span className="gt-sk-line" />
                  </div>
                  <div className="gt-sk-card">
                    <div className="sk sk-line sm" style={{ width: "36%" }} />
                    <div className="sk sk-line" style={{ width: i % 2 === 0 ? "88%" : "72%" }} />
                  </div>
                </div>
              ))}
              <p className="muted small gt-sk-hint thinking-shine">
                {hasTimelineHeading(rawMd)
                  ? "正在生成首个章节时间线…"
                  : parsed.overviewMd
                    ? "正在提炼左侧核心要点，随后生成章节时间线…"
                    : "正在通读整集文字稿并生成导读与时间线…"}
              </p>
            </div>
          ) : parsed.timelineRaw || rawMd ? (
            <div className="summary">
              <Markdown text={parsed.timelineRaw || rawMd} onSeek={onSeek} />
            </div>
          ) : (
            <p className="muted row-tight">
              <span className="thinking-shine">正在通读整集文字稿并生成导读与时间线…</span>
            </p>
          )}

          {error && (
            <p className="error-text small" style={{ marginTop: 10 }}>
              {error}
            </p>
          )}
        </div>

        {offscreen !== null && activeIdx >= 0 && (
          <button
            type="button"
            className="follow-pill"
            onClick={() => {
              followRef.current = true;
              setOffscreen(null);
              listRef.current
                ?.querySelector<HTMLElement>("[data-gt-active]")
                ?.scrollIntoView({ block: "center", behavior: "smooth" });
            }}
          >
            {offscreen === "above" ? <ArrowUp size={13} /> : <ArrowDown size={13} />} 回到当前章节
          </button>
        )}
      </div>

      <div className="gt-foot">
        {isStreaming ? (
          <>
            <span className="muted small row-tight">
              <span className="thinking-shine">正在生成中…</span>
            </span>
            <span className="spacer" />
            <button type="button" className="btn sm ghost" onClick={() => stopEpisodeGuide(ep.id)}>
              <Square size={11} /> 停止
            </button>
          </>
        ) : summary ? (
          <>
            <span className="gt-progress">
              {timeline.length > 0
                ? activeIdx >= 0
                  ? `${activeIdx + 1} / ${timeline.length} 章`
                  : `共 ${timeline.length} 章`
                : "已保存"}
            </span>
            <span className="spacer" />
            {(Boolean(error) || timeline.length === 0) && (
              <button
                type="button"
                className="btn sm ghost gt-foot-btn gt-regen-btn"
                title="重新生成导读"
                aria-label="重新生成导读"
                onClick={() => void runEpisodeGuide(ep)}
              >
                <RefreshCw size={13} />
                <span className="gt-btn-label">重新生成</span>
              </button>
            )}
            <button
              type="button"
              className={`btn sm gt-foot-btn ${copiedGuide ? "is-done" : ""}`}
              title="复制导读 Markdown"
              aria-label="复制导读"
              onClick={() => {
                void copyTextSafe(formatAnswerCopy(summary, "markdown", ep));
                setCopiedGuide(true);
                window.clearTimeout(copyTimerRef.current);
                copyTimerRef.current = window.setTimeout(() => setCopiedGuide(false), 1400);
              }}
            >
              {copiedGuide ? <Check size={13} className="check-draw-icon" /> : <Copy size={13} />}
              <span className="gt-btn-label">{copiedGuide ? "已复制" : "复制"}</span>
            </button>
            <button
              type="button"
              className="btn sm gt-foot-btn"
              title="导出导读 .md 文件"
              aria-label="导出导读"
              onClick={() => {
                downloadTextFile(
                  safeFileName(`${ep.title}-导读`, "md"),
                  formatAnswerCopy(summary, "markdown", ep),
                );
                useStore.getState().notify("已导出导读 .md 文件");
              }}
            >
              <Download size={13} />
              <span className="gt-btn-label">导出</span>
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
