import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  BookA,
  CheckCircle2,
  ChevronDown,
  Download,
  Ellipsis,
  Languages,
  Loader2,
  Mic,
  RefreshCw,
  Search,
  Square,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { isMostlyChinese, type EpisodeContext } from "../lib/ai";
import { type Episode, type Segment } from "../lib/api";
import { ask } from "../lib/confirm";
import { clock } from "../lib/format";
import {
  fetchOfficialSub,
  loadEpisodeContext,
  runTranscribe,
  runTranslate,
  saveEpisodeContext,
  stopTranscribe,
  stopTranslate,
  useJobs,
} from "../lib/jobs";
import { CLOUD_ASR_PRESETS } from "../lib/providers";
import { buildBlocks, downloadTextFile, renderTranscript, safeFileName, type SubFormat } from "../lib/subexport";
import { computeWindow, rowBounds, VIRTUAL_OVERSCAN, VIRTUAL_THRESHOLD, type VirtualWindow } from "../lib/virtualList";
import { resolveLocalModelId, useStore } from "../store";
import { CassetteArt, WaveToTextArt } from "./Illustrations";

const EMPTY_SEGMENTS: Segment[] = [];

export function activeIndex(segments: Segment[], time: number): number {
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

function highlightMatch(text: string, query: string) {
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark>{text.slice(idx, idx + query.length)}</mark>
      {text.slice(idx + query.length)}
    </>
  );
}

const Row = memo(function Row({
  seg,
  zh,
  active,
  cueState,
  edge,
  mode,
  pending,
  onSeek,
  query,
  currentHit,
  rowPos,
  onMeasure,
}: {
  seg: Segment;
  zh?: string | null;
  active: boolean;
  cueState?: "past" | "active" | "future";
  edge?: "first" | "last" | "only";
  mode: string;
  pending: boolean;
  onSeek: (t: number) => void;
  query: string;
  currentHit: boolean;
  rowPos: number;
  onMeasure?: (pos: number, el: HTMLDivElement) => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (elRef.current && onMeasure) onMeasure(rowPos, elRef.current);
  }, [rowPos, onMeasure, zh, mode, pending, seg.text]);

  const showZh = mode !== "original";
  const showOrig = mode !== "translation" || (!zh && !pending);
  const handleClick = () => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    onSeek(seg.start);
  };
  return (
    <div
      ref={elRef}
      className={`line ${active ? "active" : ""} ${currentHit ? "hit" : ""}`}
      data-row-pos={rowPos}
      data-active={active || undefined}
      data-state={cueState}
      data-edge={edge}
      data-hit={currentHit || undefined}
      onClick={handleClick}
    >
      <button
        type="button"
        className="line-time"
        title={`跳转到 ${clock(seg.start)}`}
        onClick={(e) => {
          e.stopPropagation();
          onSeek(seg.start);
        }}
      >
        {clock(seg.start)}
      </button>
      <div className="line-text">
        {showZh &&
          (zh ? (
            <p className="zh">{highlightMatch(zh, query)}</p>
          ) : pending ? (
            <span className="skeleton" />
          ) : null)}
        {showOrig && <p className="orig">{highlightMatch(seg.text, query)}</p>}
      </div>
    </div>
  );
});

function GlossaryModal({
  ep,
  onRetranslate,
  onClose,
}: {
  ep: Episode;
  onRetranslate: () => void;
  onClose: () => void;
}) {
  const [ctx, setCtx] = useState<EpisodeContext | null>(null);
  const [rows, setRows] = useState<{ src: string; zh: string; user?: boolean }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    void loadEpisodeContext(ep.id).then((c) => {
      if (!alive) return;
      setCtx(c);
      setRows(c?.terms ?? []);
      setLoading(false);
    });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      alive = false;
      window.removeEventListener("keydown", onKey);
    };
  }, [ep.id, onClose]);

  const save = async (andRetranslate: boolean) => {
    const terms = rows
      .map((r) => ({ src: r.src.trim(), zh: r.zh.trim(), user: true }))
      .filter((r) => r.src && r.zh);
    const next: EpisodeContext = {
      summary: ctx?.summary ?? "",
      speakers: ctx?.speakers ?? [],
      terms,
      basis: ctx?.basis,
    };
    await saveEpisodeContext(ep.id, next);
    onClose();
    if (andRetranslate) onRetranslate();
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="本集术语表">
        <div className="modal-head">
          <h3>本集术语表</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <X size={16} />
          </button>
        </div>
        <div className="modal-body">
          <p className="muted small" style={{ marginBottom: 10 }}>
            大模型精译时会严格遵循这里的译法，保证专有名词与人名全篇一致。
          </p>
          {ctx?.summary && <p className="gloss-summary">{ctx.summary}</p>}
          {loading ? (
            <p className="muted small">读取术语表...</p>
          ) : (
            <div className="gloss-list">
              {rows.map((r, i) => (
                <div className="gloss-row" key={i}>
                  <input
                    value={r.src}
                    placeholder="原文术语"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, src: e.target.value } : x)))}
                  />
                  <span className="muted">→</span>
                  <input
                    value={r.zh}
                    placeholder="中文译名"
                    onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, zh: e.target.value } : x)))}
                  />
                  <button
                    type="button"
                    className="icon-btn sm"
                    aria-label="删除"
                    onClick={() => setRows(rows.filter((_, j) => j !== i))}
                  >
                    <X size={13} />
                  </button>
                </div>
              ))}
              {!rows.length && (
                <p className="muted small">还没有术语。使用大模型精译时会自动提取，也可以手动添加。</p>
              )}
            </div>
          )}
          <div className="modal-foot">
            <button type="button" className="btn sm" onClick={() => setRows([...rows, { src: "", zh: "" }])}>
              添加术语
            </button>
            <span className="spacer" />
            <button type="button" className="btn sm" onClick={() => void save(false)}>
              仅保存
            </button>
            <button type="button" className="btn sm primary" onClick={() => void save(true)}>
              保存并重译
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function NoTranscriptCard({ ep }: { ep: Episode }) {
  const trEntry = useJobs((s) => s.transcripts[ep.id]);
  const officialStatus = useJobs((s) => s.officialStatus[ep.id] ?? "idle");
  const officialError = useJobs((s) => s.officialError[ep.id]);
  const asrJob = useJobs((s) => s.asr[ep.id]);
  const { asrChoice, asrLang, asrStatus, asrKeyStatus, keyStatus, savePrefs, openSettings, setImportOpen } = useStore(
    useShallow((s) => ({
      asrChoice: s.prefs.asrChoice,
      asrLang: s.prefs.asrLang,
      asrStatus: s.asrStatus,
      asrKeyStatus: s.asrKeyStatus,
      keyStatus: s.keyStatus,
      savePrefs: s.savePrefs,
      openSettings: s.openSettings,
      setImportOpen: s.setImportOpen,
    })),
  );
  const [showOptions, setShowOptions] = useState(false);

  if (asrJob?.running) {
    const pct = typeof asrJob.pct === "number" ? Math.round(asrJob.pct * 100) : null;
    return (
      <div className="panel-empty gt-fade-in">
        <CassetteArt mode="listen" />
        <p className="lead">{asrJob.stage || "正在语音转写..."}</p>
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

  if (trEntry === undefined || officialStatus === "loading") {
    return (
      <div className="lines-skeleton" aria-busy="true" aria-label="正在读取字幕">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="lines-sk-row">
            <div className="sk sk-line sm" style={{ width: 38, flex: "none" }} />
            <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 6 }}>
              <div className="sk sk-line" style={{ width: i % 2 === 0 ? "88%" : "74%" }} />
              <div className="sk sk-line sm" style={{ width: "56%" }} />
            </div>
          </div>
        ))}
        <p className="muted small gt-sk-hint">正在读取字幕…</p>
      </div>
    );
  }

  if (officialStatus === "searching") {
    return (
      <div className="panel-empty gt-fade-in">
        <Loader2 size={24} className="spin muted" />
        <p className="lead thinking-shine">正在查找官方字幕…</p>
        <p className="muted small">优先拉取节目自带字幕或 RSS 官方文字稿</p>
      </div>
    );
  }

  const hasMedia = !!(ep.audioUrl || ep.videoId);
  const isCloud = asrChoice.startsWith("cloud:");
  const cloudPreset = isCloud ? CLOUD_ASR_PRESETS.find((p) => p.id === asrChoice.slice(6)) : undefined;
  const localModels = asrStatus?.models ?? [];
  const localModelId = resolveLocalModelId(asrChoice, asrStatus);
  const selectedLocalModel = localModels.find((m) => m.id === localModelId) ?? localModels[0];
  const localSelectValue = isCloud ? `local:${localModelId}` : `local:${selectedLocalModel?.id ?? localModelId}`;
  const localReady = Boolean(asrStatus?.engineReady && (selectedLocalModel ? selectedLocalModel.installed : asrStatus?.modelReady));
  const variantTag = asrStatus?.runtime?.activeVariant
    ? asrStatus.runtime.activeVariant === "vulkan"
      ? "Vulkan GPU 加速"
      : asrStatus.runtime.activeVariant === "cuda13"
        ? "CUDA 13 加速"
        : "CPU 推理"
    : "本地离线";
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
            ? `使用「${cloudPreset?.name ?? "云端 ASR"}」转写，速度更快（音频会发送至所选服务）。`
            : `使用本机「${selectedLocalModel?.name ?? "离线模型"}」（${variantTag}）转写，音频不出本机。`}
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
                if (!isCloud && !localReady) {
                  openSettings("asr");
                  return;
                }
                if (isCloud && !cloudReady) {
                  openSettings("asr");
                  return;
                }
                void runTranscribe(ep);
              }}
            >
              <Mic size={15} />
              <span>
                {!isCloud && !localReady
                  ? `去下载 ${selectedLocalModel?.name.split(" (")[0] ?? "离线模型"}`
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
            <button type="button" className="link-btn" onClick={() => setShowOptions((v) => !v)}>
              <span>识别引擎与语言设置</span>
              <ChevronDown size={13} className={showOptions ? "flip" : ""} />
            </button>
            {showOptions && (
              <div className="gen-options">
                <label>
                  <span>识别引擎</span>
                  <select
                    value={isCloud ? asrChoice : localSelectValue}
                    onChange={(e) => savePrefs({ asrChoice: e.target.value })}
                  >
                    <optgroup label="本机离线（音频不出本机）">
                      {localModels.length > 0 ? (
                        localModels.map((m) => (
                          <option key={m.id} value={`local:${m.id}`}>
                            {m.name}（{m.sizeMb >= 1024 ? `${(m.sizeMb / 1024).toFixed(2)} GB` : `${m.sizeMb} MB`}
                            {m.recommended ? " · 推荐" : ""} · {m.installed && asrStatus?.engineReady ? "已就绪" : m.installed ? "缺引擎" : "需下载"}）
                          </option>
                        ))
                      ) : (
                        <option value="local:qwen3-0.6b">Qwen3-ASR 0.6B（需下载）</option>
                      )}
                    </optgroup>
                    <optgroup label="云端语音识别">
                      {CLOUD_ASR_PRESETS.map((p) => (
                        <option key={p.id} value={`cloud:${p.id}`}>
                          云端 · {p.name}
                        </option>
                      ))}
                    </optgroup>
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

export function TranscriptPanel({ ep }: { ep: Episode }) {
  const transcript = useJobs((s) => s.transcripts[ep.id]);
  const trJob = useJobs((s) => s.translations[ep.id]);
  const asrJob = useJobs((s) => s.asr[ep.id]);
  const segments = transcript?.segments ?? EMPTY_SEGMENTS;
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
    seekToEpisode,
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
      seekToEpisode: s.seekToEpisode,
    })),
  );
  const active = useStore((s) => (s.current?.id === ep.id ? activeIndex(segments, s.time) : -1));
  const savePrefs = useStore((s) => s.savePrefs);
  const getTranslateProvider = useStore((s) => s.getTranslateProvider);
  const isProviderReady = useStore((s) => s.isProviderReady);

  const listRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const followRef = useRef(true);
  const prevActiveRef = useRef(-1);
  const [offscreen, setOffscreen] = useState<"above" | "below" | null>(null);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [glossaryOpen, setGlossaryOpen] = useState(false);
  const menuBoxRef = useRef<HTMLDivElement>(null);

  const wantsZh = useMemo(() => !isMostlyChinese(segments), [segments]);
  const displayMode: "bilingual" | "translation" | "original" = wantsZh
    ? mode === "off"
      ? "bilingual"
      : mode
    : "original";

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    const items = trJob?.items;
    return segments
      .map((s, i) => (s.text.toLowerCase().includes(q) || items?.[i]?.toLowerCase().includes(q) ? i : -1))
      .filter((i) => i >= 0);
  }, [query, segments, trJob?.items]);

  const rows = useMemo(() => matches ?? segments.map((_, i) => i), [matches, segments]);
  const activePos = useMemo(
    () => (active < 0 ? -1 : matches ? matches.indexOf(active) : active),
    [active, matches],
  );
  const isVirtual = rows.length >= VIRTUAL_THRESHOLD;
  const estRowH = displayMode === "bilingual" ? 80 : 54;

  const heightsRef = useRef<Float32Array>(new Float32Array(0));
  if (heightsRef.current.length !== rows.length) {
    heightsRef.current = new Float32Array(rows.length).fill(estRowH);
  }
  const prevWidthRef = useRef(0);
  const isVirtualRef = useRef(isVirtual);
  isVirtualRef.current = isVirtual;
  const measureRafRef = useRef(0);
  const [win, setWin] = useState<VirtualWindow>(() => ({ start: 0, end: 60, topPad: 0, bottomPad: 0 }));

  const recomputeWindow = useCallback(() => {
    const wrap = listRef.current;
    if (!wrap || !isVirtualRef.current) return;
    const next = computeWindow(heightsRef.current, wrap.scrollTop, wrap.clientHeight || 600, VIRTUAL_OVERSCAN);
    setWin((prev) =>
      prev.start === next.start &&
      prev.end === next.end &&
      Math.abs(prev.topPad - next.topPad) < 1 &&
      Math.abs(prev.bottomPad - next.bottomPad) < 1
        ? prev
        : next,
    );
  }, []);

  const scheduleRecompute = useCallback(() => {
    if (measureRafRef.current) return;
    measureRafRef.current = window.requestAnimationFrame(() => {
      measureRafRef.current = 0;
      recomputeWindow();
    });
  }, [recomputeWindow]);

  useEffect(() => {
    return () => {
      if (measureRafRef.current) window.cancelAnimationFrame(measureRafRef.current);
    };
  }, []);

  const onMeasure = useCallback(
    (pos: number, el: HTMLDivElement) => {
      if (pos < 0 || pos >= heightsRef.current.length) return;
      const h = el.getBoundingClientRect().height;
      if (h > 0 && Math.abs(heightsRef.current[pos] - h) > 1) {
        heightsRef.current[pos] = h;
        if (isVirtualRef.current) scheduleRecompute();
      }
    },
    [scheduleRecompute],
  );

  useLayoutEffect(() => {
    heightsRef.current = new Float32Array(rows.length).fill(estRowH);
    const wrap = listRef.current;
    if (wrap && rows.length >= VIRTUAL_THRESHOLD) {
      setWin(computeWindow(heightsRef.current, wrap.scrollTop, wrap.clientHeight || 600, VIRTUAL_OVERSCAN));
    }
  }, [ep.id, displayMode, rows, estRowH]);

  useEffect(() => {
    followRef.current = true;
    prevActiveRef.current = -1;
    setOffscreen(null);
  }, [ep.id]);

  const onSeek = useCallback(
    (t: number) => {
      followRef.current = true;
      seekToEpisode(ep, t);
    },
    [ep, seekToEpisode],
  );

  const scrollToPos = useCallback((pos: number, behavior: ScrollBehavior = "smooth") => {
    const wrap = listRef.current;
    if (!wrap || pos < 0) return;
    const existing = wrap.querySelector<HTMLElement>(`[data-row-pos="${pos}"]`);
    if (existing) {
      existing.scrollIntoView({ block: "center", behavior });
      return;
    }
    const { top, height } = rowBounds(heightsRef.current, pos);
    const vh = wrap.clientHeight || 600;
    const targetTop = Math.max(0, top - vh / 2 + height / 2);
    wrap.scrollTop = targetTop;
    if (isVirtualRef.current) {
      setWin(computeWindow(heightsRef.current, targetTop, vh, VIRTUAL_OVERSCAN));
    }
    window.requestAnimationFrame(() => {
      listRef.current?.querySelector<HTMLElement>(`[data-row-pos="${pos}"]`)?.scrollIntoView({
        block: "center",
        behavior: "auto",
      });
    });
  }, []);

  const checkActiveVisibility = useCallback(() => {
    const wrap = listRef.current;
    if (!wrap || query || activePos < 0) {
      setOffscreen(null);
      return;
    }
    const activeEl = wrap.querySelector<HTMLElement>("[data-active]");
    if (activeEl) {
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
      return;
    }
    if (isVirtualRef.current && heightsRef.current.length > activePos) {
      const bounds = rowBounds(heightsRef.current, activePos);
      const viewTop = Math.max(0, wrap.scrollTop - 10);
      const viewBottom = viewTop + wrap.clientHeight;
      if (bounds.bottom < viewTop + 8) {
        setOffscreen("above");
        followRef.current = false;
      } else if (bounds.top > viewBottom - 8) {
        setOffscreen("below");
        followRef.current = false;
      } else {
        setOffscreen(null);
        followRef.current = true;
      }
      return;
    }
    setOffscreen(null);
  }, [query, activePos]);

  const handleScroll = useCallback(() => {
    recomputeWindow();
    checkActiveVisibility();
  }, [recomputeWindow, checkActiveVisibility]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuBoxRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearching(true);
        window.setTimeout(() => searchInputRef.current?.focus(), 0);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (activePos === prevActiveRef.current) return;
    prevActiveRef.current = activePos;
    if (activePos < 0 || !followRef.current || query) return;
    scrollToPos(activePos, "smooth");
  }, [activePos, query, scrollToPos]);

  useEffect(() => {
    checkActiveVisibility();
  }, [activePos, segments.length, query, checkActiveVisibility]);

  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    prevWidthRef.current = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (prevWidthRef.current > 0 && Math.abs(el.clientWidth - prevWidthRef.current) > 4) {
        heightsRef.current.fill(estRowH);
      }
      prevWidthRef.current = el.clientWidth;
      recomputeWindow();
      checkActiveVisibility();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [checkActiveVisibility, recomputeWindow, estRowH, segments.length]);

  useEffect(() => {
    setHit(0);
  }, [query]);

  useEffect(() => {
    if (!matches || matches.length === 0) return;
    scrollToPos(hit, "auto");
  }, [hit, matches, scrollToPos]);

  const trProvider = useMemo(
    () => getTranslateProvider(),
    [getTranslateProvider, trProviderId, trModel, chatProviderId, agents, verifiedAgents, providerOverrides],
  );
  const canLlm = isProviderReady(trProvider);
  void keyStatus;

  if (!transcript) {
    return <NoTranscriptCard ep={ep} />;
  }

  const total = segments.length;
  const items = trJob?.items ?? [];
  const done = Math.min(total, items.filter((x) => x != null && x !== "").length);
  const running = !!trJob?.running;
  const pending = wantsZh && running;
  const defaultEngine: "llm" | "google" =
    trEngine === "llm" ? "llm" : trEngine === "google" ? "google" : canLlm ? "llm" : "google";
  const hasDone = total > 0 && done >= total;
  const llmDone = Boolean(hasDone && trJob?.engine === "llm");
  const showRetranscribe = Boolean(
    (ep.audioUrl || ep.videoId) && !["rss", "youtube", "import"].includes(transcript.source),
  );
  const doneSourceLabel =
    trJob?.engine === "google" ? "谷歌快翻" : trJob?.engine === "llm" ? "大模型精译" : "中文字幕";
  const progressDone = trJob?.retranslating ? (trJob.pendingDone ?? 0) : done;
  const trEngineHint =
    defaultEngine === "google" || !canLlm || !trProvider
      ? "谷歌免费直连（需可访问 Google，走本机代理）"
      : `${trProvider.name}${trProvider.model ? ` · ${trProvider.model.split("/").pop()}` : ""} 术语精译`;

  const handleExport = (fmt: SubFormat) => {
    const blocks = buildBlocks(segments, items, displayMode);
    const content = renderTranscript(fmt, blocks, {
      title: ep.title,
      show: ep.showTitle,
      url: ep.videoId ? `https://youtu.be/${ep.videoId}` : ep.link,
    });
    downloadTextFile(safeFileName(ep.title, fmt), content);
    useStore.getState().notify(`已导出 ${fmt.toUpperCase()} 文件`);
    setMenuOpen(false);
  };

  const handleWheel = () => {
    followRef.current = false;
  };

  const renderStart = isVirtual ? Math.min(win.start, rows.length) : 0;
  const renderEnd = isVirtual ? Math.min(Math.max(win.end, renderStart), rows.length) : rows.length;
  const visibleSlice = isVirtual ? rows.slice(renderStart, renderEnd) : rows;
  const showBanner = Boolean(
    asrJob?.running ||
      running ||
      trJob?.error ||
      (wantsZh && done < total) ||
      (wantsZh && hasDone && trJob?.engine === "google" && canLlm),
  );

  return (
    <div className="transcript">
      <div className="status-line">
        {wantsZh ? (
          <div className="seg-control" role="radiogroup" aria-label="字幕显示模式 (快捷键 C)">
            {(["bilingual", "translation", "original"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "on" : ""}
                onClick={() => savePrefs({ subtitleMode: m })}
              >
                {m === "bilingual" ? "双语" : m === "translation" ? "中文" : "原文"}
              </button>
            ))}
          </div>
        ) : (
          <span className="source-tag">
            {transcript.source} · {total} 段
          </span>
        )}

        <span className="spacer" />

        {wantsZh && hasDone && !running && !trJob?.error && (
          <span className="tr-done-tag" title={`已译完 · ${doneSourceLabel}（${total} 段）`}>
            <CheckCircle2 size={12} />
            <span>{doneSourceLabel}</span>
          </span>
        )}

        <button
          type="button"
          className="icon-btn sm"
          style={{ flex: "none" }}
          title="搜索文稿 (Ctrl+F)"
          onClick={() => {
            setSearching((v) => !v);
            window.setTimeout(() => searchInputRef.current?.focus(), 0);
          }}
        >
          <Search size={15} />
        </button>

        <div className="panel-menu" ref={menuBoxRef}>
          <button
            type="button"
            className="icon-btn sm"
            title="导出、术语表与更多"
            onClick={() => setMenuOpen((v) => !v)}
          >
            <Ellipsis size={15} />
          </button>
          {menuOpen && (
            <div className="panel-menu-pop" role="menu">
              <div className="pop-export-row">
                <Download size={13} className="muted" />
                <span>导出：</span>
                {(["md", "txt", "srt", "vtt"] as SubFormat[]).map((fmt) => (
                  <button key={fmt} type="button" className="tiny-export-btn" onClick={() => handleExport(fmt)}>
                    {fmt.toUpperCase()}
                  </button>
                ))}
              </div>
              {wantsZh && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      setGlossaryOpen(true);
                    }}
                  >
                    <BookA size={14} /> 本集术语表…
                  </button>
                  <div className="pop-sep" />
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      if (llmDone) {
                        void ask({
                          title: "重新大模型精译？",
                          message: `当前已有 ${total} 段大模型精译，重新精译将在完成后替换现有译文。`,
                          ok: "重新精译",
                        }).then((yes) => {
                          if (yes) void runTranslate(ep, { forceEngine: "llm", restart: true });
                        });
                      } else {
                        void runTranslate(ep, { forceEngine: "llm", restart: true });
                      }
                    }}
                  >
                    <Languages size={14} /> {llmDone ? "重新大模型精译" : "用大模型术语精译"}
                  </button>
                  {!llmDone && (
                    <button
                      type="button"
                      role="menuitem"
                      title="需可访问 Google，自动走本机代理"
                      onClick={() => {
                        setMenuOpen(false);
                        void runTranslate(ep, { forceEngine: "google", restart: true });
                      }}
                    >
                      <Languages size={14} /> 用谷歌免费直连重译
                    </button>
                  )}
                </>
              )}
              {!wantsZh && showRetranscribe && <div className="pop-sep" />}
              {showRetranscribe && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    void ask({
                      title: "重新语音转写？",
                      message: "将替换当前文字稿与已有中文译文，可能需要较长时间。",
                      ok: "重新转写",
                      danger: true,
                    }).then((yes) => {
                      if (yes) void runTranscribe(ep);
                    });
                  }}
                >
                  <Mic size={14} /> 重新语音转写
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {showBanner && (
        <div className="tr-banner">
          <div className="tr-banner-info">
            {asrJob?.running ? (
              <>
                <Loader2 size={13} className="spin" />
                <span>{asrJob.stage || "语音转写中..."}</span>
              </>
            ) : running ? (
              <>
                <Loader2 size={13} className="spin" />
                <span>{trJob?.progressText || `翻译中 ${progressDone}/${total}`}</span>
              </>
            ) : trJob?.error ? (
              <span className="error-text" title={trJob.error}>
                {trJob.error}
              </span>
            ) : done > 0 && done < total ? (
              <span>
                已译 {done}/{total} 段
              </span>
            ) : done === 0 ? (
              <span>共 {total} 段 · 尚未翻译</span>
            ) : (
              <span>当前为谷歌快翻（{total} 段）</span>
            )}
          </div>

          {wantsZh && (
            <div className="tr-banner-act">
              {running ? (
                <button type="button" className="btn ghost sm" onClick={() => stopTranslate(ep.id)}>
                  停止
                </button>
              ) : done < total ? (
                <button
                  type="button"
                  className="btn primary sm"
                  title={`当前引擎：${trEngineHint}`}
                  onClick={() => void runTranslate(ep, { forceEngine: defaultEngine })}
                >
                  {defaultEngine === "llm"
                    ? done > 0
                      ? "继续大模型翻译"
                      : "大模型翻译"
                    : done > 0
                      ? "继续谷歌翻译"
                      : "谷歌翻译"}
                </button>
              ) : trJob?.engine === "google" && canLlm ? (
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={() => void runTranslate(ep, { forceEngine: "llm", restart: true })}
                >
                  升级大模型精译
                </button>
              ) : null}
            </div>
          )}

          {running && total > 0 && (
            <div className="bar slim">
              <div style={{ width: `${Math.max(3, (progressDone / total) * 100)}%` }} />
            </div>
          )}
        </div>
      )}

      {searching && (
        <div className="search-row">
          <Search size={14} />
          <input
            ref={searchInputRef}
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索中文或英文原文（Enter 下一条，Esc 关闭）"
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Escape") {
                setQuery("");
                setSearching(false);
              } else if (e.key === "Enter" && matches?.length) {
                setHit((h) => (h + (e.shiftKey ? -1 : 1) + matches.length) % matches.length);
              }
            }}
          />
          {matches && (
            <span className="muted small">{matches.length ? `${hit + 1}/${matches.length}` : "无结果"}</span>
          )}
          <button
            type="button"
            className="icon-btn sm"
            onClick={() => {
              setQuery("");
              setSearching(false);
            }}
            aria-label="关闭搜索"
          >
            <X size={14} />
          </button>
        </div>
      )}

      <div className="lines-wrap gt-fade-in">
        <div className="lines notranslate" translate="no" ref={listRef} onScroll={handleScroll} onWheel={handleWheel}>
          {isVirtual && win.topPad > 0 && <div style={{ height: win.topPad }} aria-hidden />}
          {visibleSlice.map((i, idx) => {
            const k = renderStart + idx;
            const cueState = active < 0 ? undefined : i < active ? "past" : i === active ? "active" : "future";
            const edge = rows.length === 1 ? "only" : k === 0 ? "first" : k === rows.length - 1 ? "last" : undefined;
            return (
              <Row
                key={`${segments[i].start}-${i}`}
                seg={segments[i]}
                zh={items[i]}
                active={i === active}
                cueState={cueState}
                edge={edge}
                mode={displayMode}
                pending={pending}
                onSeek={onSeek}
                query={query}
                currentHit={!!matches && k === hit}
                rowPos={k}
                onMeasure={onMeasure}
              />
            );
          })}
          {isVirtual && win.bottomPad > 0 && <div style={{ height: win.bottomPad }} aria-hidden />}
        </div>

        {offscreen !== null && activePos >= 0 && !query && (
          <button
            type="button"
            className="follow-pill"
            onClick={() => {
              followRef.current = true;
              setOffscreen(null);
              scrollToPos(activePos, "smooth");
            }}
          >
            {offscreen === "above" ? <ArrowUp size={13} /> : <ArrowDown size={13} />} 回到当前播放句
          </button>
        )}
      </div>

      {glossaryOpen && (
        <GlossaryModal
          ep={ep}
          onRetranslate={() => void runTranslate(ep, { forceEngine: "llm", restart: true })}
          onClose={() => setGlossaryOpen(false)}
        />
      )}
    </div>
  );
}
