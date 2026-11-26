import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUpDown,
  CheckCheck,
  CheckCircle2,
  Circle,
  ExternalLink,
  FileText,
  FileUp,
  Headphones,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Trash2,
  Tv,
  X,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { Episode, Show } from "../lib/api";
import { readScroll, saveScroll } from "../lib/cache";
import { ask } from "../lib/confirm";
import { clock, formatDate, formatDuration, groupLabel, notesText } from "../lib/format";
import { clearEpisodeJobs } from "../lib/jobs";
import { isEpisodeDone, pickContinueHero } from "../lib/recent";
import { getCachedTitleZh, useEpisodeTitleDisplay, useTitleZh } from "../lib/zh";
import { isBilibiliEpisode, isYouTubeEpisode } from "../lib/videoSource";
import { useStore } from "../store";
import { DeskArt, EqBars, SkeletonFeed } from "./Illustrations";
import { MonthFilter, useMonthFilter } from "./MonthFilter";

function cleanCoverUrl(ep: Episode): string | undefined {
  const isYt = isYouTubeEpisode(ep);
  if (!ep.cover) return isYt && ep.videoId ? `https://i.ytimg.com/vi/${ep.videoId}/mqdefault.jpg` : undefined;
  return isYt ? ep.cover.replace(/\/hqdefault\.jpg(\?|$)/i, "/mqdefault.jpg$1") : ep.cover;
}

const HOME_TAB_KEY = "podcast-desk-home-tab";

function readHomeTab(): "recent" | "updates" {
  try {
    return localStorage.getItem(HOME_TAB_KEY) === "updates" ? "updates" : "recent";
  } catch {
    return "recent";
  }
}

const EpisodeRow = memo(function EpisodeRow({
  ep,
  showShow,
  useTouched,
  allowDelete,
  onDelete,
}: {
  ep: Episode;
  showShow: boolean;
  useTouched?: boolean;
  allowDelete?: boolean;
  onDelete?: (ep: Episode) => void;
}) {
  const openEpisode = useStore((s) => s.openEpisode);
  const toggleEpisodeCompleted = useStore((s) => s.toggleEpisodeCompleted);
  const isPlaying = useStore((s) => s.playing && s.current?.id === ep.id);
  const titleDisplay = useEpisodeTitleDisplay(ep.title);
  const done = isEpisodeDone(ep);
  const pct = done && ep.duration ? 100 : ep.duration && ep.progress > 5 ? Math.min(100, (ep.progress / ep.duration) * 100) : 0;
  const remainMins = !done && ep.duration && pct > 0 ? Math.max(1, Math.round((ep.duration - ep.progress) / 60)) : 0;
  const coverSrc = cleanCoverUrl(ep);
  const dateMs = useTouched ? (ep.touchedAt ?? ep.published) : ep.published;
  const checkLabel = done ? (ep.videoId ? "标为未看" : "标为未听") : ep.videoId ? "标为已看" : "标为已听";

  return (
    <div
      className={`ep-item-row ${isPlaying ? "playing" : ""} ${done ? "played" : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => openEpisode(ep)}
      onKeyDown={(e) => {
        if (e.key === "Enter") openEpisode(ep);
      }}
    >
      <div className={`ep-thumb ${ep.videoId ? "is-video" : "square"}`}>
        {coverSrc && !ep.videoId && (
          <img className="thumb-bg" src={coverSrc} alt="" aria-hidden loading="lazy" referrerPolicy="no-referrer" />
        )}
        {coverSrc ? (
          <img
            className="thumb-img"
            src={coverSrc}
            alt=""
            loading="lazy"
            referrerPolicy="no-referrer"
            onError={(e) => {
              const img = e.currentTarget;
              if (isYouTubeEpisode(ep) && ep.videoId && !img.dataset.f) {
                img.dataset.f = "1";
                img.src = `https://i.ytimg.com/vi/${ep.videoId}/hqdefault.jpg`;
              } else {
                img.style.visibility = "hidden";
              }
            }}
          />
        ) : (
          <div className="cover-fallback">
            {ep.videoId ? <Tv size={18} /> : ep.audioUrl ? <Headphones size={18} /> : <FileText size={18} />}
          </div>
        )}
        {ep.videoId && ep.duration ? <span className="thumb-dur">{clock(ep.duration)}</span> : null}
        {pct > 0 && (
          <span className="thumb-bar">
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>

      <div className="ep-body-col">
        <p className="ep-kicker">
          {showShow && (
            <span className="show-name">
              {ep.showTitle ||
                (isBilibiliEpisode(ep)
                  ? "B站单集"
                  : ep.videoId
                    ? "YouTube 单集"
                    : ep.audioUrl
                      ? "本地/单集音频"
                      : "导入文稿")}
            </span>
          )}
          {dateMs ? <span>{formatDate(dateMs)}</span> : null}
          {ep.duration ? <span>{formatDuration(ep.duration)}</span> : null}
        </p>
        <p className="ep-title2">
          {isPlaying && <EqBars className="inline-eq" />}
          <span>{titleDisplay.primary}</span>
        </p>
        {titleDisplay.secondary && <p className="ep-title-orig clamp1">{titleDisplay.secondary}</p>}
        {(ep.hasTranscript || ep.transcriptUrl || ep.videoId || remainMins > 0 || done) && (
          <p className="ep-tags">
            {ep.hasTranscript ? (
              <span className="tag ok">已有字幕</span>
            ) : ep.transcriptUrl ? (
              <span className="tag">含官方字幕</span>
            ) : null}
            {ep.videoId && <span className="tag">视频</span>}
            {remainMins > 0 && <span className="tag progress">剩 {remainMins} 分钟</span>}
            {done && <span className="tag">{ep.videoId ? "已看完" : "已听完"}</span>}
          </p>
        )}
      </div>

      <div className="row-ops">
        <button
          type="button"
          className={`icon-btn sm row-check-btn ${done ? "done" : ""}`}
          title={checkLabel}
          aria-label={checkLabel}
          onClick={(e) => {
            e.stopPropagation();
            void toggleEpisodeCompleted(ep, !done);
          }}
        >
          {done ? <CheckCircle2 size={15} /> : <Circle size={15} />}
        </button>
        {allowDelete && onDelete && (
          <button
            type="button"
            className="icon-btn sm row-del-btn"
            title="删除这一集"
            aria-label="删除这一集"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(ep);
            }}
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
});

function ShowTile({ show }: { show: Show }) {
  const go = useStore((s) => s.go);
  const subText = show.author && show.author !== show.title ? show.author : null;
  return (
    <div
      className="show-tile"
      role="button"
      tabIndex={0}
      onClick={() => go({ kind: "show", id: show.id })}
      onKeyDown={(e) => {
        if (e.key === "Enter") go({ kind: "show", id: show.id });
      }}
    >
      <div className="tile-cover">
        {show.cover ? (
          <img src={show.cover} alt="" loading="lazy" />
        ) : (
          <div className="cover-fallback">{show.title.slice(0, 1).toUpperCase()}</div>
        )}
      </div>
      <p className="tile-name clamp1">{show.title}</p>
      {subText && <p className="tile-sub clamp1">{subText}</p>}
    </div>
  );
}

function GroupedEpisodes({
  episodes,
  showShow,
  useTouched,
  allowDelete,
  onDelete,
}: {
  episodes: Episode[];
  showShow: boolean;
  useTouched?: boolean;
  allowDelete?: boolean;
  onDelete?: (ep: Episode) => void;
}) {
  const groups = useMemo(() => {
    const out: { label: string; items: Episode[] }[] = [];
    for (const ep of episodes) {
      const label = groupLabel(useTouched ? (ep.touchedAt ?? ep.published) : ep.published);
      if (out[out.length - 1]?.label !== label) out.push({ label, items: [] });
      out[out.length - 1].items.push(ep);
    }
    return out;
  }, [episodes, useTouched]);

  return (
    <div className="ep-feed">
      {groups.map((g) => (
        <section key={g.label} className="ep-group">
          <h3 className="ep-group-h">{g.label}</h3>
          {g.items.map((ep) => (
            <EpisodeRow
              key={ep.id}
              ep={ep}
              showShow={showShow}
              useTouched={useTouched}
              allowDelete={allowDelete}
              onDelete={onDelete}
            />
          ))}
        </section>
      ))}
    </div>
  );
}

function ContinueHero({ ep }: { ep: Episode }) {
  const { openEpisode, load, playSoon } = useStore(
    useShallow((s) => ({ openEpisode: s.openEpisode, load: s.load, playSoon: s.playSoon })),
  );
  const liveSec = useStore((s) => (s.current?.id === ep.id ? Math.floor(s.time) : null));
  const titleDisplay = useEpisodeTitleDisplay(ep.title);
  const progress = liveSec != null && liveSec > 0 ? liveSec : ep.progress;
  const coverSrc = cleanCoverUrl(ep);
  const pct = ep.duration ? Math.min(100, (progress / ep.duration) * 100) : 0;
  const remainMins = ep.duration ? Math.max(1, Math.round((ep.duration - progress) / 60)) : 0;
  const resume = () => {
    load({ ...ep, progress });
    openEpisode(ep);
    playSoon(ep.id);
  };

  return (
    <div
      className="hero"
      role="button"
      tabIndex={0}
      title="继续播放"
      onClick={resume}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          resume();
        }
      }}
    >
      <div className={`hero-cover ${ep.videoId ? "wide" : ""}`}>
        {coverSrc && !ep.videoId && <img className="thumb-bg" src={coverSrc} alt="" aria-hidden referrerPolicy="no-referrer" />}
        {coverSrc ? (
          <img className="thumb-img" src={coverSrc} alt="" referrerPolicy="no-referrer" />
        ) : (
          <div className="cover-fallback">
            {ep.videoId ? <Tv size={22} /> : ep.audioUrl ? <Headphones size={22} /> : <FileText size={22} />}
          </div>
        )}
        {pct > 0 && (
          <span className="hero-bar" aria-hidden>
            <span style={{ width: `${pct}%` }} />
          </span>
        )}
      </div>
      <div className="hero-meta">
        <p className="meta-line">
          <span>{ep.videoId ? "继续观看" : "继续收听"}</span>
          {ep.showTitle && ep.showId !== "single" ? <span>· {ep.showTitle}</span> : null}
        </p>
        <p className="hero-title">{titleDisplay.primary}</p>
        {titleDisplay.secondary && <p className="title-orig-sub clamp1">{titleDisplay.secondary}</p>}
        <div className="hero-foot">
          <span className="btn sm primary hero-play" aria-hidden>
            <Play size={13} fill="currentColor" />
            <span>继续播放</span>
          </span>
          {remainMins > 0 && <span className="muted small">还剩 {remainMins} 分钟</span>}
        </div>
      </div>
    </div>
  );
}

function capPerShow(list: Episode[], maxPerShow = 5): Episode[] {
  const counts = new Map<string, number>();
  const out: Episode[] = [];
  for (const ep of list) {
    const n = counts.get(ep.showId) ?? 0;
    if (n >= maxPerShow) continue;
    counts.set(ep.showId, n + 1);
    out.push(ep);
  }
  return out;
}

function pickUpdates(
  episodes: Episode[],
  days: 7 | 30,
  onlyUnwatched: boolean,
): { items: Episode[]; fallback: boolean } {
  const base = onlyUnwatched ? episodes.filter((e) => !isEpisodeDone(e)) : episodes;
  const cutoff = Date.now() - days * 86_400_000;
  const inWindow = base.filter((e) => e.published && e.published >= cutoff);
  if (inWindow.length > 0) {
    return { items: capPerShow(inWindow, 5), fallback: false };
  }
  if (base.length > 0) {
    return { items: capPerShow(base, 5).slice(0, 10), fallback: true };
  }
  return { items: [], fallback: false };
}

export function HomeView() {
  const {
    shows,
    recentEpisodes,
    latestEpisodes,
    current,
    refreshingAll,
    refreshAllShows,
    setImportOpen,
    setSubscribeOpen,
    deleteEpisode,
  } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      recentEpisodes: s.recentEpisodes,
      latestEpisodes: s.latestEpisodes,
      current: s.current,
      refreshingAll: s.refreshingAll,
      refreshAllShows: s.refreshAllShows,
      setImportOpen: s.setImportOpen,
      setSubscribeOpen: s.setSubscribeOpen,
      deleteEpisode: s.deleteEpisode,
    })),
  );

  const [homeTab, setHomeTab] = useState<"recent" | "updates">(readHomeTab);
  const [updateDays, setUpdateDays] = useState<7 | 30>(30);
  const [onlyUnwatched, setOnlyUnwatched] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const hasContent = shows.length > 0 || recentEpisodes.length > 0;

  useEffect(() => {
    const st = useStore.getState();
    if (st.current && st.time > 0) {
      st.syncProgressLocal(st.current.id, st.time, undefined, st.current);
    }
  }, []);

  useLayoutEffect(() => {
    if (!hasContent || !pageRef.current) return;
    const y = readScroll("home");
    if (y > 0) pageRef.current.scrollTop = y;
  }, [hasContent]);

  const switchTab = (next: "recent" | "updates") => {
    setHomeTab(next);
    try {
      localStorage.setItem(HOME_TAB_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const handleDelete = (ep: Episode) => {
    void ask({
      title: `删除「${ep.title}」？`,
      message: "会同时删除该单集的本地字幕、翻译、问答记录与上传媒体文件。",
      ok: "删除",
      danger: true,
    }).then((yes) => {
      if (yes) {
        clearEpisodeJobs(ep.id);
        void deleteEpisode(ep.id);
      }
    });
  };

  const hero = useMemo(
    () => pickContinueHero(recentEpisodes, current ? { ep: current, time: current.progress } : null),
    [recentEpisodes, current],
  );

  const updatesResult = useMemo(
    () => pickUpdates(latestEpisodes, updateDays, onlyUnwatched),
    [latestEpisodes, updateDays, onlyUnwatched],
  );

  if (shows.length === 0 && recentEpisodes.length === 0) {
    return (
      <div className="page">
        <div className="welcome-card">
          <DeskArt />
          <h1>开始你的播客与视频精读</h1>
          <p className="muted">
            粘贴 YouTube、B站、小宇宙、Spotify 或任意播客 RSS 与音视频直链，或者导入本地音视频与文稿，即可同步双语阅读与在场感 AI 问答。
          </p>
          <div className="row-actions center" style={{ marginTop: 8 }}>
            <button type="button" className="btn primary" onClick={() => setSubscribeOpen(true)}>
              <Search size={15} />
              <span>搜索或粘贴链接</span>
            </button>
            <button type="button" className="btn" onClick={() => setImportOpen(true)}>
              <FileUp size={15} />
              <span>导入本地内容</span>
            </button>
          </div>
        </div>
      </div>
    );
  }

  const effectiveTab = shows.length > 0 ? homeTab : "recent";

  return (
    <div className="page" ref={pageRef} onScroll={(e) => saveScroll("home", e.currentTarget.scrollTop)}>
      <div className="page-inner">
        {hero && (
          <section>
            <ContinueHero ep={hero} />
          </section>
        )}

        {shows.length > 0 && (
          <section>
            <div className="module-head">
              <h2 className="module-title">我的订阅（{shows.length}）</h2>
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => void refreshAllShows()}
                disabled={refreshingAll}
              >
                {refreshingAll ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
                <span>{refreshingAll ? "刷新中..." : "全部刷新"}</span>
              </button>
            </div>
            <div className="tile-strip">
              {shows.map((s) => (
                <ShowTile key={s.id} show={s} />
              ))}
            </div>
          </section>
        )}

        <section>
          <header className="home-head">
            {shows.length > 0 ? (
              <div className="seg-control" role="tablist" aria-label="首页内容视图">
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveTab === "recent"}
                  className={effectiveTab === "recent" ? "on" : ""}
                  onClick={() => switchTab("recent")}
                >
                  最近与单集
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={effectiveTab === "updates"}
                  className={effectiveTab === "updates" ? "on" : ""}
                  onClick={() => switchTab("updates")}
                >
                  订阅更新
                </button>
              </div>
            ) : (
              <h1 className="home-title">最近与单集</h1>
            )}
            {effectiveTab === "recent" && recentEpisodes.length > 0 && (
              <span className="home-count">{recentEpisodes.length} 集</span>
            )}
            <span className="spacer" />
            {effectiveTab === "updates" && (
              <div className="home-filters">
                <div className="seg-control" role="tablist" aria-label="更新时间范围">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={updateDays === 7}
                    className={updateDays === 7 ? "on" : ""}
                    onClick={() => setUpdateDays(7)}
                  >
                    近 7 天
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={updateDays === 30}
                    className={updateDays === 30 ? "on" : ""}
                    onClick={() => setUpdateDays(30)}
                  >
                    近 30 天
                  </button>
                </div>
                <button
                  type="button"
                  className={`chip sm ${onlyUnwatched ? "on" : ""}`}
                  onClick={() => setOnlyUnwatched((v) => !v)}
                >
                  仅看未看
                </button>
              </div>
            )}
          </header>

          {effectiveTab === "updates" ? (
            updatesResult.items.length === 0 ? (
              <p className="muted small">
                {onlyUnwatched ? "当前订阅已全部看完，可关闭「仅看未看」浏览历史单集。" : "暂无更新，可点击上方「全部刷新」拉取最新单集。"}
              </p>
            ) : (
              <>
                {updatesResult.fallback && (
                  <p className="updates-fallback-note">
                    近 {updateDays} 天暂无新发布，为你展示最新 {updatesResult.items.length} 集
                  </p>
                )}
                <GroupedEpisodes episodes={updatesResult.items} showShow useTouched={false} />
                <p className="updates-foot-note">
                  每个频道最多展示最新 5 集；更早的历史单集，可点击上方订阅频道按年月浏览
                </p>
              </>
            )
          ) : recentEpisodes.length === 0 ? (
            <p className="muted small">点击上方订阅频道即可浏览单集，或切换「订阅更新」查看最新节目。</p>
          ) : (
            <GroupedEpisodes episodes={recentEpisodes} showShow useTouched allowDelete onDelete={handleDelete} />
          )}
        </section>
      </div>
    </div>
  );
}

type StatusFilter = "all" | "unwatched" | "watched" | "subs";

export function ShowView({ id }: { id: string }) {
  const {
    shows,
    showEpisodes,
    showHasMore,
    loadShowEpisodes,
    refreshShow,
    loadMoreShow,
    markShowAllCompleted,
    deleteShow,
    deleteEpisode,
  } = useStore(
    useShallow((s) => ({
      shows: s.shows,
      showEpisodes: s.showEpisodes,
      showHasMore: s.showHasMore,
      loadShowEpisodes: s.loadShowEpisodes,
      refreshShow: s.refreshShow,
      loadMoreShow: s.loadMoreShow,
      markShowAllCompleted: s.markShowAllCompleted,
      deleteShow: s.deleteShow,
      deleteEpisode: s.deleteEpisode,
    })),
  );

  const show = shows.find((s) => s.id === id);
  const cleanDesc = useMemo(() => notesText(show?.description), [show?.description]);
  const descZh = useTitleZh(cleanDesc ? cleanDesc.slice(0, 600) : undefined);

  const episodes = showEpisodes[id];
  const [filter, setFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortOrder, setSortOrder] = useState<"desc" | "asc">("desc");
  const [descExpanded, setDescExpanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const restoredKeyRef = useRef<string | null>(null);
  const scrollKey = `show:${id}`;

  useLayoutEffect(() => {
    if (!show || !episodes || restoredKeyRef.current === scrollKey) return;
    const el = pageRef.current;
    if (!el) return;
    restoredKeyRef.current = scrollKey;
    el.scrollTop = readScroll(scrollKey);
  }, [show, episodes, scrollKey]);

  useEffect(() => {
    void loadShowEpisodes(id);
  }, [id, loadShowEpisodes]);

  const isYtShow = show?.kind === "youtube";
  const missingPubCount = useMemo(
    () => (isYtShow && episodes ? episodes.filter((e) => e.videoId && !e.published).length : 0),
    [isYtShow, episodes],
  );
  const pubRetryRef = useRef<{ key: string; tries: number }>({ key: "", tries: 0 });
  useEffect(() => {
    if (!isYtShow || !episodes || missingPubCount === 0) return;
    const key = `${id}:${episodes.length}`;
    if (pubRetryRef.current.key !== key) {
      pubRetryRef.current = { key, tries: 0 };
    }
    if (pubRetryRef.current.tries >= 2) return;
    pubRetryRef.current.tries += 1;
    const delay = pubRetryRef.current.tries === 1 ? 3500 : 5000;
    const timer = window.setTimeout(() => {
      void loadShowEpisodes(id).catch(() => {});
    }, delay);
    return () => window.clearTimeout(timer);
  }, [id, isYtShow, episodes, missingPubCount, loadShowEpisodes]);

  const counts = useMemo(() => {
    const list = episodes ?? [];
    let unwatched = 0;
    let watched = 0;
    let subs = 0;
    for (const e of list) {
      if (isEpisodeDone(e)) watched += 1;
      else unwatched += 1;
      if (e.hasTranscript || e.transcriptUrl) subs += 1;
    }
    return { total: list.length, unwatched, watched, subs };
  }, [episodes]);

  const filteredByStatusAndTitle = useMemo(() => {
    const list = episodes ?? [];
    const q = filter.trim().toLowerCase();
    return list.filter((e) => {
      if (statusFilter === "unwatched" && isEpisodeDone(e)) return false;
      if (statusFilter === "watched" && !isEpisodeDone(e)) return false;
      if (statusFilter === "subs" && !e.hasTranscript && !e.transcriptUrl) return false;
      if (q) {
        const zhTitle = getCachedTitleZh(e.title)?.toLowerCase();
        if (!e.title.toLowerCase().includes(q) && (!zhTitle || !zhTitle.includes(q))) return false;
      }
      return true;
    });
  }, [episodes, statusFilter, filter]);

  const { month, setMonth, filtered: shown } = useMonthFilter(episodes ? filteredByStatusAndTitle : null);
  const orderedShown = useMemo(
    () => (shown && sortOrder === "asc" ? [...shown].reverse() : shown),
    [shown, sortOrder],
  );

  const handleRefresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      await refreshShow(id);
    } finally {
      setRefreshing(false);
    }
  };

  const handleLoadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      await loadMoreShow(id);
    } catch (err) {
      useStore.getState().notify(err instanceof Error ? err.message : "加载更早单集失败", false);
    } finally {
      setLoadingMore(false);
    }
  };

  const handleMarkAllDone = () => {
    if (!show || counts.unwatched <= 0) return;
    const isYtShow = show.kind === "youtube";
    void ask({
      title: `将「${show.title}」全部标为${isYtShow ? "已看" : "已听"}？`,
      message: `共 ${counts.unwatched} 集未${isYtShow ? "看" : "听"}单集将被标记完成，之后仍可单独取消。`,
      ok: "全部标记",
    }).then((yes) => {
      if (yes) void markShowAllCompleted(id, isYtShow);
    });
  };

  const handleUnsub = () => {
    if (!show) return;
    void ask({
      title: `取消订阅「${show.title}」？`,
      message: "未保存字幕的单集将被清理，已有字幕的单集仍会保留在本地。",
      ok: "取消订阅",
      danger: true,
    }).then((yes) => {
      if (yes) void deleteShow(id);
    });
  };

  const handleDeleteEp = (ep: Episode) => {
    void ask({
      title: `删除单集「${ep.title}」？`,
      message: "会删除该集已保存的字幕、译文与问答记录。",
      ok: "删除",
      danger: true,
    }).then((yes) => {
      if (yes) {
        clearEpisodeJobs(ep.id);
        void deleteEpisode(ep.id);
      }
    });
  };

  if (!show) {
    return (
      <div className="page">
        <p className="muted">订阅频道不存在或已被取消。</p>
      </div>
    );
  }

  const isYt = show.kind === "youtube";
  const kindLabel = show.kind === "youtube" ? "YouTube 频道" : show.kind === "xiaoyuzhou" ? "小宇宙" : "播客";
  const hasMoreYt = isYt && showHasMore[id] !== false;
  const shownDesc = descZh ?? cleanDesc;

  return (
    <div className="page" ref={pageRef} onScroll={(e) => saveScroll(scrollKey, e.currentTarget.scrollTop)}>
      <div className="page-inner">
        <div className="show-head">
          {show.cover ? (
            <img src={show.cover} alt="" />
          ) : (
            <div className="cover-fallback">{show.title.slice(0, 1).toUpperCase()}</div>
          )}
          <div className="show-info">
            <p className="meta-line">
              <span>{kindLabel}</span>
              {show.author && show.author !== show.title ? <span>· {show.author}</span> : null}
            </p>
            <h1 className="show-title-h">{show.title}</h1>
            {shownDesc && (
              <div>
                <p className={`show-desc ${descExpanded ? "" : "clamp3"}`}>{shownDesc}</p>
                {shownDesc.length > 120 && (
                  <button type="button" className="link-btn" onClick={() => setDescExpanded((v) => !v)}>
                    {descExpanded ? "收起简介" : "展开简介"}
                  </button>
                )}
              </div>
            )}
            <div className="row-actions">
              <button type="button" className="btn sm primary" onClick={() => void handleRefresh()} disabled={refreshing}>
                {refreshing ? <Loader2 size={14} className="spin" /> : <RefreshCw size={14} />}
                <span>{refreshing ? "刷新中..." : "刷新最新单集"}</span>
              </button>
              {show.link && (
                <a className="btn sm" href={show.link} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} />
                  <span>原网页</span>
                </a>
              )}
              {counts.unwatched > 0 && (
                <button type="button" className="btn sm ghost" onClick={handleMarkAllDone}>
                  <CheckCheck size={14} />
                  <span>{isYt ? "全部标为已看" : "全部标为已听"}</span>
                </button>
              )}
              <button type="button" className="btn sm ghost" onClick={handleUnsub}>
                <Trash2 size={14} />
                <span>取消订阅</span>
              </button>
            </div>
          </div>
        </div>

        <div className="list-head">
          <div className="row-actions">
            <h2 className="section-title flush">单集（{orderedShown?.length ?? 0}）</h2>
            <div className="seg-control" role="tablist" aria-label="单集状态筛选">
              {(
                [
                  ["all", "全部"],
                  ["unwatched", `${isYt ? "未看" : "未听"}${counts.unwatched > 0 ? ` ${counts.unwatched}` : ""}`],
                  ["watched", `${isYt ? "已看" : "已听"}${counts.watched > 0 ? ` ${counts.watched}` : ""}`],
                  ["subs", `有字幕${counts.subs > 0 ? ` ${counts.subs}` : ""}`],
                ] as [StatusFilter, string][]
              ).map(([k, label]) => (
                <button
                  key={k}
                  type="button"
                  role="tab"
                  aria-selected={statusFilter === k}
                  className={statusFilter === k ? "on" : ""}
                  onClick={() => setStatusFilter(k)}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              className={`chip sm ${sortOrder === "asc" ? "on" : ""}`}
              title={sortOrder === "desc" ? "当前：最新在前，点击切换最早在前" : "当前：最早在前，点击切换最新在前"}
              onClick={() => setSortOrder((o) => (o === "desc" ? "asc" : "desc"))}
            >
              <ArrowUpDown size={12} />
              <span>{sortOrder === "desc" ? "最新" : "最早"}</span>
            </button>
          </div>
          <div className="search-inline">
            <Search size={14} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="按标题过滤..."
              spellCheck={false}
            />
            {filter && (
              <button
                type="button"
                className="icon-btn sm"
                aria-label="清除过滤"
                onClick={() => setFilter("")}
              >
                <X size={13} />
              </button>
            )}
          </div>
        </div>

        <MonthFilter
          episodes={episodes ? filteredByStatusAndTitle : null}
          month={month}
          onChange={setMonth}
        />

        {!episodes ? (
          <SkeletonFeed count={6} />
        ) : !orderedShown || orderedShown.length === 0 ? (
          filter.trim() && hasMoreYt ? (
            <div className="load-more-bar" style={{ justifyContent: "flex-start", gap: 10 }}>
              <span className="muted small">当前已载 {episodes.length} 集未匹配「{filter.trim()}」</span>
              <button
                type="button"
                className="btn sm"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 size={13} className="spin" />}
                <span>{loadingMore ? "加载中..." : "继续加载更早单集"}</span>
              </button>
            </div>
          ) : (
            <p className="muted small" style={{ paddingTop: 12 }}>
              没有匹配的单集。
            </p>
          )
        ) : (
          <GroupedEpisodes episodes={orderedShown} showShow={false} allowDelete onDelete={handleDeleteEp} />
        )}

        {isYt && episodes && episodes.length > 0 && (
          <div className="load-more-bar">
            {hasMoreYt ? (
              <button
                type="button"
                className="btn sm"
                onClick={() => void handleLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore && <Loader2 size={13} className="spin" />}
                <span>{loadingMore ? "加载中..." : `加载更早单集（当前已载 ${episodes.length} 集）`}</span>
              </button>
            ) : (
              <span className="muted small">已加载全部 {episodes.length} 集</span>
            )}
          </div>
        )}
        {show.kind === "xiaoyuzhou" && episodes && episodes.length > 0 && (
          <div className="load-more-bar">
            <span className="muted small">
              已加载小宇宙网页端公开的最近 {episodes.length} 集；如需更早单集，可直接粘贴单集链接导入
            </span>
          </div>
        )}
        {show.kind === "podcast" && episodes && episodes.length >= 300 && (
          <div className="load-more-bar">
            <span className="muted small">RSS 订阅单次最多导入最新 300 集</span>
          </div>
        )}
      </div>
    </div>
  );
}
