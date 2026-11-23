import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronLeft,
  FileUp,
  Home,
  Link2,
  Loader2,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  Pause,
  Play,
  Plus,
  RotateCcw,
  RotateCw,
  Search,
  Settings,
  Sun,
  Tv,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, type SearchResult } from "../lib/api";
import { clock } from "../lib/format";
import { useJobs } from "../lib/jobs";
import { triggerSidebarAnim, useLayout } from "../lib/layout";
import { getDarkThemeMeta, getLightThemeMeta, resolveEffectiveMode } from "../lib/themes";
import { useStore, type View } from "../store";
import { BrandMark } from "./Illustrations";
import { isVideoMediaUrl } from "./Players";

const LINK_RE =
  /^(https?:\/\/|@)|youtube\.com|youtu\.be|xiaoyuzhoufm\.com|feed\.xyzfm\.space|podcasts\.apple\.com|\.(xml|rss)\b/i;

function looksLikeLink(text: string): boolean {
  return LINK_RE.test(text.trim());
}

function TaskChip() {
  const activeAsrId = useJobs((s) => {
    for (const [id, j] of Object.entries(s.asr)) {
      if (j.running) return id;
    }
    return null;
  });
  const activeTrId = useJobs((s) => {
    for (const [id, j] of Object.entries(s.translations)) {
      if (j.running) return id;
    }
    return null;
  });
  const asrJob = useJobs((s) => (activeAsrId ? s.asr[activeAsrId] : undefined));
  const trJob = useJobs((s) => (activeTrId ? s.translations[activeTrId] : undefined));
  const go = useStore((s) => s.go);

  if (activeAsrId && asrJob) {
    const pct = typeof asrJob.pct === "number" ? ` · ${Math.round(asrJob.pct * 100)}%` : "";
    return (
      <button type="button" className="task-chip" onClick={() => go({ kind: "episode", id: activeAsrId })} title={asrJob.stage}>
        <Loader2 size={13} className="spin" />
        <span className="label">转写中{pct}</span>
      </button>
    );
  }
  if (activeTrId && trJob) {
    const pct = trJob.total > 0 ? ` · ${trJob.done}/${trJob.total}` : "";
    return (
      <button type="button" className="task-chip" onClick={() => go({ kind: "episode", id: activeTrId })}>
        <Loader2 size={13} className="spin" />
        <span className="label">翻译中{pct}</span>
      </button>
    );
  }
  return null;
}

export function Sidebar({ isDrawer }: { isDrawer: boolean }) {
  const { shows, view, go, openSettings, setImportOpen } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      view: s.view,
      go: s.go,
      openSettings: s.openSettings,
      setImportOpen: s.setImportOpen,
    })),
  );
  const { sideDrawerOpen, put } = useLayout(
    useShallow((l) => ({ sideDrawerOpen: l.sideDrawerOpen, put: l.put })),
  );

  const isActiveView = (v: View) =>
    view.kind === v.kind && (v.kind !== "show" || (view.kind === "show" && view.id === v.id));

  const closeDrawer = () => {
    if (isDrawer) useLayout.setState({ sideDrawerOpen: false });
  };

  const focusTopSearch = () => {
    closeDrawer();
    const input = document.querySelector<HTMLInputElement>(".top-search input");
    if (input) {
      input.focus();
      input.select();
    }
  };

  const body = (
    <aside className="sidebar">
      <div className="brand">
        <button
          type="button"
          className="icon-btn pane-toggle side-toggle"
          onClick={() => {
            if (isDrawer) closeDrawer();
            else {
              triggerSidebarAnim();
              put({ sideOpen: false });
            }
          }}
          title="收起侧栏 (Ctrl+B)"
          aria-label="收起侧栏"
        >
          <PanelLeftClose size={16} />
        </button>
        <div className="brand-text">
          <div className="brand-name">PodDesk</div>
        </div>
        <BrandMark />
      </div>

      <nav className="side-nav">
        <button
          type="button"
          className={`nav ${isActiveView({ kind: "home" }) ? "on" : ""}`}
          onClick={() => {
            closeDrawer();
            go({ kind: "home" });
          }}
        >
          <Home size={16} />
          <span className="label">首页与最近</span>
        </button>
        <button
          type="button"
          className="nav"
          onClick={() => {
            closeDrawer();
            setImportOpen(true);
          }}
        >
          <FileUp size={16} />
          <span className="label">导入本地内容</span>
        </button>
      </nav>

      <div className="side-sep" />

      <div className="side-head">
        <span className="label">订阅频道</span>
        <button type="button" className="icon-btn sm" title="搜索或粘贴链接订阅 (Ctrl+L)" onClick={focusTopSearch}>
          <Plus size={14} />
        </button>
      </div>

      <div className="show-list">
        {shows.map((s) => (
          <button
            key={s.id}
            type="button"
            className={`show-item ${isActiveView({ kind: "show", id: s.id }) ? "on" : ""}`}
            onClick={() => {
              closeDrawer();
              go({ kind: "show", id: s.id });
            }}
            title={s.title}
          >
            <span className="show-cover">
              {s.cover ? (
                <img src={s.cover} alt="" loading="lazy" />
              ) : (
                <span className="cover-fallback">{s.title.slice(0, 1).toUpperCase()}</span>
              )}
            </span>
            <span className="show-names">
              <span className="show-title">{s.title}</span>
            </span>
            {s.unplayed > 0 && <span className="fresh-dot" title="近 7 天有新更新" aria-label="近 7 天有新更新" />}
          </button>
        ))}
        {!shows.length && <p className="muted small side-empty">暂无订阅，可在顶部搜索添加</p>}
      </div>

      <TaskChip />

      <div className="side-foot">
        <button
          type="button"
          className="nav settings-btn"
          onClick={() => {
            closeDrawer();
            openSettings("appearance");
          }}
        >
          <Settings size={16} />
          <span className="label">设置</span>
        </button>
      </div>
    </aside>
  );

  if (isDrawer) {
    return (
      <div key="drawer" className={`side-drawer ${sideDrawerOpen ? "open" : ""}`} aria-hidden={!sideDrawerOpen}>
        {body}
      </div>
    );
  }
  return (
    <div key="dock" className="sidebar-slot">
      {body}
    </div>
  );
}

export function TopBar({ rightExtra }: { rightExtra?: ReactNode }) {
  const { history, back, go, addSubscription, shows, notify, theme, lightTheme, darkTheme, savePrefs, viewKind } =
    useStore(
      useShallow((s) => ({
        history: s.history,
        back: s.back,
        go: s.go,
        addSubscription: s.addSubscription,
        shows: s.shows,
        notify: s.notify,
        theme: s.prefs.theme,
        lightTheme: s.prefs.lightTheme,
        darkTheme: s.prefs.darkTheme,
        savePrefs: s.savePrefs,
        viewKind: s.view.kind,
      })),
    );
  const { sideOpen, sideDrawerOpen, put } = useLayout(
    useShallow((l) => ({ sideOpen: l.sideOpen, sideDrawerOpen: l.sideDrawerOpen, put: l.put })),
  );

  const isDark = resolveEffectiveMode(theme) === "dark";
  const lightLabel = getLightThemeMeta(lightTheme).name;
  const darkLabel = getDarkThemeMeta(darkTheme).name;

  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);

  const isLink = looksLikeLink(q);

  useEffect(() => {
    window.clearTimeout(timerRef.current);
    const trimmed = q.trim();
    if (!trimmed || isLink) {
      setResults(null);
      setBusy(false);
      return;
    }
    timerRef.current = window.setTimeout(async () => {
      setBusy(true);
      try {
        const country = /[\u4e00-\u9fff]/.test(trimmed) ? "cn" : "us";
        const list = await api.searchShows(trimmed, country);
        setResults(list.slice(0, 10));
      } catch {
        setResults([]);
      } finally {
        setBusy(false);
      }
    }, 320);
    return () => window.clearTimeout(timerRef.current);
  }, [q, isLink]);

  const subscribe = async (value: string) => {
    if (adding) return;
    setAdding(value);
    try {
      await addSubscription(value);
      setQ("");
      setOpen(false);
      setResults(null);
    } catch (err) {
      notify(err instanceof Error ? err.message : "订阅或打开失败", false);
    } finally {
      setAdding(null);
    }
  };

  const handleEnter = () => {
    const trimmed = q.trim();
    if (!trimmed) return;
    if (isLink) {
      void subscribe(trimmed);
    } else if (results?.[0]) {
      void subscribe(results[0].feedUrl);
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-left">
        {(viewKind === "episode" || !sideOpen) && (
          <button
            type="button"
            className="icon-btn pane-toggle"
            onClick={() => {
              if (viewKind === "episode") useLayout.setState({ sideDrawerOpen: !sideDrawerOpen });
              else {
                triggerSidebarAnim();
                put({ sideOpen: true });
              }
            }}
            title="展开侧栏 (Ctrl+B)"
            aria-label="展开侧栏"
          >
            <PanelLeftOpen size={16} />
          </button>
        )}
        {history.length > 0 && (
          <button
            type="button"
            className="round-btn"
            onClick={back}
            title="返回上一页"
            aria-label="返回"
          >
            <ChevronLeft size={18} />
          </button>
        )}
      </div>

      <div className="search-wrap">
        <div className={`top-search ${open ? "focus" : ""}`}>
          {isLink ? <Link2 size={15} /> : <Search size={15} />}
          <input
            ref={inputRef}
            value={q}
            placeholder="粘贴 YouTube / 小宇宙 / RSS 链接，或搜索节目名 (Ctrl+L)"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            onFocus={() => setOpen(true)}
            onBlur={() => window.setTimeout(() => setOpen(false), 160)}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing) return;
              if (e.key === "Enter") {
                e.preventDefault();
                handleEnter();
              } else if (e.key === "Escape") {
                setQ("");
                setResults(null);
                inputRef.current?.blur();
              }
            }}
          />
          {busy || adding ? (
            <Loader2 size={14} className="spin" />
          ) : isLink ? (
            <>
              <button
                type="button"
                className="icon-btn sm"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setQ("");
                  setResults(null);
                }}
                aria-label="清空"
              >
                <X size={13} />
              </button>
              <button
                type="button"
                className="search-go"
                title="打开或订阅 (Enter)"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => handleEnter()}
              >
                确认
              </button>
            </>
          ) : q ? (
            <button
              type="button"
              className="icon-btn sm"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setQ("");
                setResults(null);
              }}
              aria-label="清空"
            >
              <X size={13} />
            </button>
          ) : (
            <kbd className="kbd-hint">Ctrl+L</kbd>
          )}
        </div>

        {open && results && (
          <div className="search-drop">
            {results.length === 0 ? (
              <p className="muted small drop-empty">没有找到匹配的播客或频道，试试英文原名或直接粘贴链接。</p>
            ) : (
              results.map((r, idx) => {
                const matchedShow = shows.find((s) => s.feedUrl === r.feedUrl);
                return (
                  <div key={`${r.feedUrl}-${idx}`} className="drop-row" onMouseDown={(e) => e.preventDefault()}>
                    {r.cover ? (
                      <img src={r.cover} alt="" />
                    ) : (
                      <div className="cover-fallback">
                        {r.source === "youtube" ? <Tv size={15} /> : r.title.slice(0, 1)}
                      </div>
                    )}
                    <div className="drop-meta">
                      <p className="ep-name clamp1">{r.title}</p>
                      <p className="meta-line clamp1">
                        <span>{r.author || "未知作者"}</span>
                        {r.source === "youtube" ? (
                          <span className="pill-tag">YouTube</span>
                        ) : r.genre ? (
                          <span className="pill-tag">{r.genre}</span>
                        ) : null}
                      </p>
                    </div>
                    {matchedShow ? (
                      <button
                        type="button"
                        className="btn sm ghost sub-enter-btn"
                        onClick={() => {
                          setQ("");
                          setOpen(false);
                          setResults(null);
                          go({ kind: "show", id: matchedShow.id });
                        }}
                      >
                        <Check size={13} />
                        <span>已订阅 · 进入</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={adding !== null}
                        onClick={() => void subscribe(r.feedUrl)}
                      >
                        {adding === r.feedUrl ? <Loader2 size={13} className="spin" /> : <Plus size={13} />}
                        <span>订阅</span>
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}
      </div>

      <div className="topbar-right">
        <div className="theme-switch" role="radiogroup" aria-label="主题切换">
          <span className={`theme-thumb ${isDark ? "dark" : ""}`} aria-hidden />
          <button
            type="button"
            role="radio"
            aria-checked={!isDark}
            className={!isDark ? "on" : ""}
            title={`浅色 · ${lightLabel}`}
            aria-label={`浅色模式（${lightLabel}）`}
            onClick={() => savePrefs({ theme: "light" })}
          >
            <Sun size={14} />
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={isDark}
            className={isDark ? "on" : ""}
            title={`深色 · ${darkLabel}`}
            aria-label={`深色模式（${darkLabel}）`}
            onClick={() => savePrefs({ theme: "dark" })}
          >
            <Moon size={14} />
          </button>
        </div>
        {rightExtra}
      </div>
    </header>
  );
}

export function MiniPlayer() {
  const { current, view, playing, player, time, length, loadingSince, openEpisode, closeMiniPlayer } = useStore(
    useShallow((s) => ({
      current: s.current,
      view: s.view,
      playing: s.playing,
      player: s.player,
      time: Math.floor(s.time),
      length: s.length,
      loadingSince: s.loadingSince,
      openEpisode: s.openEpisode,
      closeMiniPlayer: s.closeMiniPlayer,
    })),
  );
  const { sideOpen, sidebar } = useLayout(useShallow((l) => ({ sideOpen: l.sideOpen, sidebar: l.sidebar })));

  if (!current || current.videoId || isVideoMediaUrl(current.audioUrl) || (view.kind === "episode" && view.id === current.id)) {
    return null;
  }

  const offsetLeft = view.kind !== "episode" && sideOpen ? sidebar : 0;
  const pct = length > 0 ? Math.min(100, (time / length) * 100) : 0;
  const showLabel = current.showTitle && current.showId !== "single" ? `${current.showTitle} · ` : "";
  const timeLabel = `${clock(time)}${length > 0 ? ` / ${clock(length)}` : ""}`;

  return (
    <div
      className="mini"
      style={{ "--mini-offset": `${offsetLeft}px` } as React.CSSProperties}
    >
      <div className="mini-progress" aria-hidden="true">
        <div style={{ width: `${pct}%` }} />
      </div>
      <div
        className="mini-main"
        role="button"
        tabIndex={0}
        title="回到当前单集"
        onClick={() => openEpisode(current)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            openEpisode(current);
          }
        }}
      >
        <span className="mini-cover-wrap">
          {current.cover ? (
            <img className="mini-cover" src={current.cover} alt="" />
          ) : (
            <span className="mini-cover cover-fallback">{current.title.slice(0, 1).toUpperCase()}</span>
          )}
        </span>
        <span className="mini-text">
          <span className="ep-name clamp1">{current.title}</span>
          <span className="meta-line clamp1">{`${showLabel}${timeLabel}`}</span>
        </span>
      </div>
      <div className="mini-controls">
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => player?.seek(Math.max(0, time - 15))}
          disabled={!player}
          title="后退 15 秒"
          aria-label="后退 15 秒"
        >
          <RotateCcw size={14} />
        </button>
        <button
          type="button"
          className="play-btn sm"
          onClick={() => player?.toggle()}
          disabled={!player}
          aria-label={playing ? "暂停" : "播放"}
        >
          {loadingSince ? (
            <Loader2 size={14} className="spin" />
          ) : playing ? (
            <Pause size={14} fill="currentColor" />
          ) : (
            <Play size={14} fill="currentColor" />
          )}
        </button>
        <button
          type="button"
          className="icon-btn sm"
          onClick={() => player?.seek(length > 0 ? Math.min(length, time + 15) : time + 15)}
          disabled={!player}
          title="前进 15 秒"
          aria-label="前进 15 秒"
        >
          <RotateCw size={14} />
        </button>
        <button
          type="button"
          className="icon-btn sm mini-close"
          onClick={closeMiniPlayer}
          title="停止并关闭"
          aria-label="停止并关闭小播放器"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

export function ImportModal() {
  const { open, setImportOpen, importText, importMedia } = useStore(
    useShallow((s) => ({
      open: s.importOpen,
      setImportOpen: s.setImportOpen,
      importText: s.importText,
      importMedia: s.importMedia,
    })),
  );

  const [tab, setTab] = useState<"text" | "media">("text");
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState<"auto" | "srt" | "vtt" | "txt">("auto");
  const [text, setText] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) setImportOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, setImportOpen]);

  if (!open) return null;

  const close = () => {
    if (!busy) setImportOpen(false);
  };

  const handlePickTextFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const raw = await f.text();
    setText(raw);
    if (!title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""));
    const lower = f.name.toLowerCase();
    if (lower.endsWith(".srt")) setFormat("srt");
    else if (lower.endsWith(".vtt")) setFormat("vtt");
    else if (lower.endsWith(".txt") || lower.endsWith(".md")) setFormat("txt");
  };

  const handleSubmitText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await importText({ title: title.trim() || undefined, text, format });
      setTitle("");
      setText("");
      setImportOpen(false);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "导入文稿失败");
    } finally {
      setBusy(false);
    }
  };

  const handleSubmitMedia = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!mediaFile || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await importMedia(mediaFile, title.trim() || undefined);
      setTitle("");
      setMediaFile(null);
      setImportOpen(false);
    } catch (error) {
      setErr(error instanceof Error ? error.message : "上传本地音视频失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="导入本地内容">
        <div className="modal-head">
          <h3>导入本地内容</h3>
          <button type="button" className="icon-btn" onClick={close} aria-label="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="seg-control" role="tablist" style={{ marginBottom: 14 }}>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "text"}
              className={tab === "text" ? "on" : ""}
              disabled={busy}
              onClick={() => {
                setTab("text");
                setErr(null);
              }}
            >
              文稿 / SRT / VTT 字幕
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "media"}
              className={tab === "media" ? "on" : ""}
              disabled={busy}
              onClick={() => {
                setTab("media");
                setErr(null);
              }}
            >
              本地音频 / 视频文件
            </button>
          </div>

          {tab === "text" ? (
            <form className="stack" onSubmit={handleSubmitText}>
              <div className="row">
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="标题（可选，默认从首段或文件名截取）"
                  disabled={busy}
                  style={{ flex: 1 }}
                />
                <select
                  value={format}
                  onChange={(e) => setFormat(e.target.value as "auto" | "srt" | "vtt" | "txt")}
                  disabled={busy}
                >
                  <option value="auto">自动识别</option>
                  <option value="srt">SRT 字幕</option>
                  <option value="vtt">VTT 字幕</option>
                  <option value="txt">纯文本 / 逐字稿</option>
                </select>
              </div>
              <div className="row-between">
                <span className="muted small">可直接粘贴文字，或选择 .srt / .vtt / .txt 文件</span>
                <label className="btn sm">
                  <span>选择字幕文件</span>
                  <input
                    type="file"
                    accept=".txt,.srt,.vtt,.md,text/plain"
                    hidden
                    onChange={(e) => void handlePickTextFile(e)}
                  />
                </label>
              </div>
              <textarea
                className="import-textarea"
                rows={9}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="把 B站 / 课程 / 会议逐字稿，或 SRT / WebVTT 字幕文本粘贴到这里..."
                disabled={busy}
              />
              {err && <p className="error-text">{err}</p>}
              <div className="modal-foot">
                <button type="submit" className="btn primary" disabled={busy || !text.trim()}>
                  {busy ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />}
                  <span>导入并开始阅读</span>
                </button>
              </div>
            </form>
          ) : (
            <form className="stack" onSubmit={handleSubmitMedia}>
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="单集标题（可选，默认使用文件名）"
                disabled={busy}
              />
              <label className="file-drop">
                <input
                  type="file"
                  accept=".mp3,.m4a,.aac,.wav,.flac,.ogg,.opus,.mp4,.webm,.mov,.mkv,audio/*,video/*"
                  hidden
                  disabled={busy}
                  onChange={(e) => {
                    const f = e.target.files?.[0] ?? null;
                    setMediaFile(f);
                    if (f && !title.trim()) setTitle(f.name.replace(/\.[^.]+$/, ""));
                  }}
                />
                <span>
                  {mediaFile
                    ? `已选择：${mediaFile.name}（${(mediaFile.size / 1048576).toFixed(1)} MB）`
                    : "点击选择本地 mp3 / m4a / wav / mp4 等文件（最大 512 MB）"}
                </span>
              </label>
              <p className="muted small">文件会保存在本机数据目录并支持拖动播放；导入后可用离线 Qwen3-ASR 或云端识别字幕。</p>
              {err && <p className="error-text">{err}</p>}
              <div className="modal-foot">
                <button type="submit" className="btn primary" disabled={busy || !mediaFile}>
                  {busy ? <Loader2 size={14} className="spin" /> : <FileUp size={14} />}
                  <span>{busy ? "上传保存中..." : "导入音视频"}</span>
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}

export function Toast() {
  const notice = useStore((s) => s.notice);
  if (!notice) return null;
  return <div className={`toast ${notice.ok ? "" : "bad"}`}>{notice.text}</div>;
}
