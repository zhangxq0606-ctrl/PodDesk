import { create } from "zustand";
import {
  api,
  type AsrModelsStatus,
  type Episode,
  type FoundAgent,
  type HealthInfo,
  type ProviderConfig,
  type Show,
} from "./lib/api";
import { AGENT_META, buildProviders, CLOUD_ASR_PRESETS, type ProviderOverride } from "./lib/providers";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  normalizeDarkTheme,
  normalizeLightTheme,
  type DarkThemeId,
  type LightThemeId,
} from "./lib/themes";
import { upsertRecentTop } from "./lib/recent";

export type View =
  | { kind: "home" }
  | { kind: "show"; id: string }
  | { kind: "episode"; id: string };

export type SubtitleMode = "bilingual" | "translation" | "original" | "off";
export type SubtitleSize = "s" | "m" | "l";
export type ChatSize = "m" | "l";
export type ThemeMode = "system" | "light" | "dark";
export type SettingsSection = "appearance" | "asr" | "ai" | "network" | "reading";

export interface PlayerHandle {
  episodeId: string;
  seek: (seconds: number) => void;
  toggle: () => void;
  play: () => void;
  setRate: (rate: number) => void;
}

export interface Prefs {
  subtitleMode: SubtitleMode;
  subtitleSize: SubtitleSize;
  chatSize: ChatSize;
  theme: ThemeMode;
  lightTheme: LightThemeId;
  darkTheme: DarkThemeId;
  audioNextLine: boolean;
  audioStageSub: boolean;
  autoTranslateTitles: boolean;
  playbackRate: number;
  volume: number;
  muted: boolean;
  translateEngine: "auto" | "llm" | "google";
  translateProviderId: string; // "follow" or specific provider id
  translateModel: string;
  translateQuality: "fast" | "best";
  asrChoice: string;
  asrLang: string;
  chatInstruction: string;
  chatInstructionEnabled: boolean;
}

const PREFS_KEY = "podcast-desk-prefs";

const DEFAULT_PREFS: Prefs = {
  subtitleMode: "bilingual",
  subtitleSize: "m",
  chatSize: "m",
  theme: "light",
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  audioNextLine: true,
  audioStageSub: true,
  autoTranslateTitles: true,
  playbackRate: 1,
  volume: 1,
  muted: false,
  translateEngine: "auto",
  translateProviderId: "follow",
  translateModel: "",
  translateQuality: "fast",
  asrChoice: "qwen3",
  asrLang: "auto",
  chatInstruction: "",
  chatInstructionEnabled: true,
};

export function resolveLocalModelId(choice: string, status: AsrModelsStatus | null): string {
  if (choice.startsWith("local:")) {
    const id = choice.slice(6).trim();
    if (id) return id;
  }
  if (choice === "qwen3" || choice === "qwen3-asr") {
    const installedRec = status?.models.find((m) => m.recommended && m.installed);
    if (installedRec) return installedRec.id;
    const anyInstalled = status?.models.find((m) => m.installed);
    if (anyInstalled) return anyInstalled.id;
    return status?.hardware?.recommendedModel || status?.modelId || "qwen3-0.6b";
  }
  return status?.hardware?.recommendedModel || status?.modelId || "qwen3-0.6b";
}

function normalizeAsrChoice(raw: string | undefined, status: AsrModelsStatus | null): string {
  if (!raw || raw === "qwen3" || raw === "qwen3-asr") {
    const id = resolveLocalModelId("qwen3", status);
    return `local:${id}`;
  }
  return raw;
}

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Partial<Prefs>;
    return {
      ...DEFAULT_PREFS,
      ...raw,
      lightTheme: normalizeLightTheme(raw.lightTheme),
      darkTheme: normalizeDarkTheme(raw.darkTheme),
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function savePrefsLocal(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore storage error */
  }
}

function parseJsonSafe<T>(raw: string | undefined | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

interface AppStore {
  ready: boolean;
  health: HealthInfo | null;
  shows: Show[];
  recentEpisodes: Episode[];
  latestEpisodes: Episode[];
  showEpisodes: Record<string, Episode[]>;
  showHasMore: Record<string, boolean>;
  episodeCache: Record<string, Episode>;
  refreshingAll: boolean;

  view: View;
  history: View[];

  // Unified playback state (persists across pages)
  current: Episode | null;
  playing: boolean;
  time: number;
  length: number;
  loadingSince: number | null;
  player: PlayerHandle | null;
  playWhenReady: string | null;
  seekWhenReady: { id: string; at: number } | null;

  // Providers & keys
  agents: FoundAgent[];
  chatProviderId: string;
  chatModel: string;
  verifiedAgents: Record<string, FoundAgent["login"]>;
  providerOverrides: Record<string, ProviderOverride>;
  keyStatus: Record<string, boolean>;
  asrKeyStatus: Record<string, boolean>;
  asrStatus: AsrModelsStatus | null;
  hasCookies: boolean;

  prefs: Prefs;
  settingsOpen: boolean;
  settingsSection: SettingsSection;
  settingsTargetId: string | null;
  importOpen: boolean;
  notice: { ok: boolean; text: string; action?: { label: string; run: () => void } } | null;

  set: (patch: Partial<AppStore>) => void;
  setNotice: (notice: { ok: boolean; text: string; action?: { label: string; run: () => void } } | null) => void;
  notify: (text: string, ok?: boolean, action?: { label: string; run: () => void }) => void;
  openSettings: (section?: SettingsSection, targetId?: string | null) => void;
  closeSettings: () => void;
  setImportOpen: (open: boolean) => void;

  go: (v: View) => void;
  back: () => void;
  openEpisode: (ep: Episode) => void;

  load: (ep: Episode) => void;
  offerPlayer: (handle: PlayerHandle, meta?: { length?: number }) => void;
  withdrawPlayer: (handle: PlayerHandle) => void;
  seekToEpisode: (ep: Episode, seconds: number) => void;
  playSoon: (id: string) => void;
  closeMiniPlayer: () => void;

  savePrefs: (patch: Partial<Prefs>) => void;
  bootstrap: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  loadShowEpisodes: (showId: string) => Promise<Episode[]>;
  addSubscription: (input: string) => Promise<void>;
  refreshShow: (id: string) => Promise<void>;
  refreshAllShows: () => Promise<void>;
  loadMoreShow: (id: string) => Promise<{ added: number; hasMore: boolean }>;
  markShowAllCompleted: (id: string, isVideo?: boolean) => Promise<void>;
  deleteShow: (id: string) => Promise<void>;
  deleteEpisode: (id: string) => Promise<void>;
  toggleEpisodeCompleted: (ep: Episode, next?: boolean) => Promise<void>;
  touchEpisodeLocal: (ep: Episode) => void;
  syncProgressLocal: (id: string, seconds: number, completed?: boolean, epHint?: Episode) => void;
  importText: (opts: { title?: string; text: string; format?: "auto" | "srt" | "vtt" | "txt" }) => Promise<void>;
  importMedia: (file: File, title?: string) => Promise<void>;
  markHasTranscript: (episodeId: string) => void;

  refreshAgents: () => Promise<void>;
  refreshAsrStatus: () => Promise<void>;
  setAgentLoginState: (kind: string, login: FoundAgent["login"]) => Promise<void>;
  selectChatProvider: (id: string) => Promise<void>;
  selectChatModel: (providerId: string, model: string) => Promise<void>;
  saveProviderOverride: (id: string, patch: ProviderOverride) => Promise<void>;
  saveApiKey: (id: string, key: string) => Promise<void>;
  saveAsrKey: (id: string, key: string) => Promise<void>;
  saveCookies: (text: string) => Promise<boolean>;

  getAllProviders: () => ProviderConfig[];
  getChatProvider: () => ProviderConfig | undefined;
  getTranslateProvider: () => ProviderConfig | undefined;
  isProviderReady: (p?: ProviderConfig) => boolean;
}

function sameView(a: View, b: View): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "show" && b.kind === "show") return a.id === b.id;
  if (a.kind === "episode" && b.kind === "episode") return a.id === b.id;
  return true;
}

function mergeAgents(
  rawAgents: FoundAgent[],
  verified: Record<string, FoundAgent["login"]>,
): FoundAgent[] {
  return rawAgents
    .filter((a) => a.kind in AGENT_META)
    .map((a) => {
      const v = verified[a.kind];
      const login =
        a.login === "ready"
          ? "ready"
          : a.login === "unknown" && (v === "ready" || v === "needsLogin")
            ? v
            : a.login;
      return { ...a, login };
    });
}

export const useStore = create<AppStore>((set, get) => ({
  ready: false,
  health: null,
  shows: [],
  recentEpisodes: [],
  latestEpisodes: [],
  showEpisodes: {},
  showHasMore: {},
  episodeCache: {},
  refreshingAll: false,

  view: { kind: "home" },
  history: [],

  current: null,
  playing: false,
  time: 0,
  length: 0,
  loadingSince: null,
  player: null,
  playWhenReady: null,
  seekWhenReady: null,

  agents: [],
  chatProviderId: "deepseek",
  chatModel: "",
  verifiedAgents: {},
  providerOverrides: {},
  keyStatus: {},
  asrKeyStatus: {},
  asrStatus: null,
  hasCookies: false,

  prefs: readPrefs(),
  settingsOpen: false,
  settingsSection: "asr",
  settingsTargetId: null,
  importOpen: false,
  notice: null,

  set: (patch) => set(patch),
  setNotice: (notice) => set({ notice }),
  notify: (text, ok = true, action) => set({ notice: { ok, text, action } }),
  openSettings: (section = "asr", targetId = null) =>
    set({ settingsOpen: true, settingsSection: section, settingsTargetId: targetId ?? null }),
  closeSettings: () => set({ settingsOpen: false, settingsTargetId: null }),
  setImportOpen: (open) => set({ importOpen: open }),

  go: (v) => {
    const cur = get().view;
    if (sameView(cur, v)) return;
    const s = get();
    if (s.view.kind === "episode" && s.current && s.time > 0) {
      const playingEp = s.current;
      const changed = Math.abs(s.time - (playingEp.progress ?? 0)) >= 1;
      const missingFromRecent = s.time > 5 && !s.recentEpisodes.some((e) => e.id === playingEp.id && e.progress > 5);
      if (changed || missingFromRecent) {
        s.syncProgressLocal(playingEp.id, s.time, undefined, playingEp);
        void api.setProgress(playingEp.id, s.time).catch(() => {});
      }
    }
    set((prev) => ({
      view: v,
      history: [...prev.history.slice(-30), cur],
    }));
  },

  back: () => {
    const hist = get().history;
    if (!hist.length) return;
    const s = get();
    if (s.view.kind === "episode" && s.current && s.time > 0) {
      const playingEp = s.current;
      const changed = Math.abs(s.time - (playingEp.progress ?? 0)) >= 1;
      const missingFromRecent = s.time > 5 && !s.recentEpisodes.some((e) => e.id === playingEp.id && e.progress > 5);
      if (changed || missingFromRecent) {
        s.syncProgressLocal(playingEp.id, s.time, undefined, playingEp);
        void api.setProgress(playingEp.id, s.time).catch(() => {});
      }
    }
    const prev = hist[hist.length - 1];
    set({ view: prev, history: hist.slice(0, -1) });
  },

  openEpisode: (ep) => {
    set((s) => ({
      episodeCache: { ...s.episodeCache, [ep.id]: ep },
    }));
    get().go({ kind: "episode", id: ep.id });
  },

  load: (ep) => {
    const cur = get().current;
    if (cur?.id === ep.id && cur.videoId === ep.videoId) return;
    set({
      current: ep,
      playing: false,
      time: ep.progress ?? 0,
      length: ep.duration ?? 0,
      loadingSince: null,
      player: null,
    });
  },

  offerPlayer: (handle, meta) => {
    const s = get();
    if (s.current?.id !== handle.episodeId) return;
    set({
      player: handle,
      ...(meta?.length ? { length: meta.length } : {}),
    });
    if (s.seekWhenReady && s.seekWhenReady.id === handle.episodeId) {
      const at = s.seekWhenReady.at;
      set({ seekWhenReady: null, playWhenReady: null });
      window.setTimeout(() => handle.seek(at), 0);
    } else if (s.playWhenReady === handle.episodeId) {
      set({ playWhenReady: null });
      window.setTimeout(() => handle.play(), 0);
    }
  },

  withdrawPlayer: (handle) => {
    if (get().player === handle) {
      set({ player: null, playing: false, loadingSince: null });
    }
  },

  seekToEpisode: (ep, seconds) => {
    const s = get();
    const target = Math.max(0, seconds);
    if (s.current?.id === ep.id) {
      set({ time: target });
      if (s.player) {
        s.player.seek(target);
      } else {
        set({ seekWhenReady: { id: ep.id, at: target }, playWhenReady: null });
      }
      return;
    }
    set({
      current: { ...ep, progress: target },
      time: target,
      length: ep.duration ?? 0,
      playing: false,
      player: null,
      seekWhenReady: { id: ep.id, at: target },
      playWhenReady: null,
      loadingSince: Date.now(),
    });
  },

  playSoon: (id) => {
    const s = get();
    set({ loadingSince: Date.now() });
    if (s.current?.id === id && s.player) {
      s.player.play();
      return;
    }
    set({ playWhenReady: id });
  },

  closeMiniPlayer: () => {
    const s = get();
    const cur = s.current;
    const savedAt = cur && s.time > 0 ? Math.floor(s.time) : null;
    if (cur && savedAt && savedAt > 0) {
      s.syncProgressLocal(cur.id, savedAt, undefined, cur);
      void api.setProgress(cur.id, savedAt).catch(() => {});
    }
    set({
      current: null,
      playing: false,
      time: 0,
      length: 0,
      loadingSince: null,
      player: null,
      playWhenReady: null,
      seekWhenReady: null,
    });
  },

  savePrefs: (patch) => {
    const next = { ...get().prefs, ...patch };
    set({ prefs: next });
    savePrefsLocal(next);
  },

  getAllProviders: () => buildProviders(get().agents, get().providerOverrides, get().verifiedAgents),

  getChatProvider: () => {
    const all = get().getAllProviders();
    const id = get().chatProviderId;
    const base = all.find((p) => p.id === id) ?? all[0];
    if (!base) return undefined;
    const m = get().chatModel;
    return m ? { ...base, model: m } : base;
  },

  getTranslateProvider: () => {
    const all = get().getAllProviders();
    const { translateProviderId, translateModel } = get().prefs;
    if (translateProviderId && translateProviderId !== "follow") {
      const hit = all.find((p) => p.id === translateProviderId);
      if (hit) return translateModel ? { ...hit, model: translateModel } : hit;
    }
    const id = get().chatProviderId;
    return all.find((p) => p.id === id) ?? all[0];
  },

  isProviderReady: (p) => {
    if (!p) return false;
    if (p.protocol === "cli") return p.login === "ready";
    if (!p.needsKey) return !!(p.baseUrl && p.model);
    return !!(p.baseUrl && p.model && get().keyStatus[p.id]);
  },

  bootstrap: async () => {
    const [health, settings, shows, recent, latest, rawAgents, asrStatus, cookiesRes] = await Promise.all([
      api.health(),
      api.getSettings(),
      api.listShows(),
      api.recentEpisodes(),
      api.listEpisodes(undefined, 200).catch(() => [] as Episode[]),
      api.detectAgents().catch(() => [] as FoundAgent[]),
      api.getAsrModels().catch(() => null),
      api.getCookiesStatus().catch(() => ({ hasCookies: false })),
    ]);

    const overrides = parseJsonSafe<Record<string, ProviderOverride>>(settings.providerOverrides, {});
    const verifiedAgents = parseJsonSafe<Record<string, FoundAgent["login"]>>(settings.verifiedAgents, {});
    const agents = mergeAgents(rawAgents, verifiedAgents);
    const readyAgent = agents.find((a) => a.login === "ready");
    const savedChat = settings.chatProvider;
    const chatProviderId =
      savedChat && savedChat !== "gemini" ? savedChat : readyAgent?.kind || "deepseek";
    const chatModel = savedChat === chatProviderId ? (settings.chatModel ?? "") : "";

    const cacheEntries: Record<string, Episode> = {};
    for (const e of latest) cacheEntries[e.id] = e;
    for (const e of recent) cacheEntries[e.id] = e;

    set((s) => {
      const nextChoice = normalizeAsrChoice(s.prefs.asrChoice, asrStatus);
      const nextPrefs = nextChoice !== s.prefs.asrChoice ? { ...s.prefs, asrChoice: nextChoice } : s.prefs;
      if (nextChoice !== s.prefs.asrChoice) savePrefsLocal(nextPrefs);
      return {
        ready: true,
        health,
        shows,
        recentEpisodes: recent,
        latestEpisodes: latest,
        episodeCache: { ...s.episodeCache, ...cacheEntries },
        agents,
        asrStatus,
        prefs: nextPrefs,
        hasCookies: cookiesRes.hasCookies,
        providerOverrides: overrides,
        verifiedAgents,
        chatProviderId,
        chatModel,
      };
    });

    const presets = buildProviders(agents, overrides, verifiedAgents).filter((p) => p.needsKey);
    const [keyEntries, asrKeyEntries] = await Promise.all([
      Promise.all(
        presets.map(async (p) => {
          const res = await api.hasKey(p.id).catch(() => ({ hasKey: false }));
          return [p.id, res.hasKey] as const;
        }),
      ),
      Promise.all(
        CLOUD_ASR_PRESETS.filter((p) => p.needsKey).map(async (p) => {
          const res = await api.hasKey(`asr.${p.id}`).catch(() => ({ hasKey: false }));
          return [p.id, res.hasKey] as const;
        }),
      ),
    ]);
    set({
      keyStatus: Object.fromEntries(keyEntries),
      asrKeyStatus: Object.fromEntries(asrKeyEntries),
    });

    if (readyAgent) {
      void api.warmAgent(readyAgent.kind).catch(() => {});
    }
  },

  refreshLibrary: async () => {
    const [shows, recent, latest] = await Promise.all([
      api.listShows(),
      api.recentEpisodes(),
      api.listEpisodes(undefined, 200).catch(() => [] as Episode[]),
    ]);
    set((s) => {
      const nextCache = { ...s.episodeCache };
      for (const e of latest) nextCache[e.id] = e;
      for (const e of recent) nextCache[e.id] = e;
      return { shows, recentEpisodes: recent, latestEpisodes: latest, episodeCache: nextCache };
    });
  },

  loadShowEpisodes: async (showId) => {
    const eps = await api.listEpisodes(showId, 500);
    set((s) => {
      const nextCache = { ...s.episodeCache };
      for (const e of eps) nextCache[e.id] = e;
      return {
        showEpisodes: { ...s.showEpisodes, [showId]: eps },
        episodeCache: nextCache,
      };
    });
    return eps;
  },

  addSubscription: async (input) => {
    const res = await api.addSubscription(input);
    await get().refreshLibrary();
    if (res.episode) {
      get().openEpisode(res.episode);
      get().notify(`已打开单集：${res.episode.title}`);
    } else if (res.show) {
      await get().loadShowEpisodes(res.show.id);
      get().go({ kind: "show", id: res.show.id });
      get().notify(`已订阅「${res.show.title}」（${res.episodesCount ?? 0} 集）`);
    }
  },

  refreshShow: async (id) => {
    const res = await api.refreshShow(id);
    await Promise.all([get().refreshLibrary(), get().loadShowEpisodes(id)]);
    get().notify(`已刷新「${res.show.title}」（${res.episodesCount} 集）`);
  },

  refreshAllShows: async () => {
    if (get().refreshingAll) return;
    set({ refreshingAll: true });
    try {
      const res = await api.refreshAllShows();
      const v = get().view;
      await Promise.all([
        get().refreshLibrary(),
        v.kind === "show" ? get().loadShowEpisodes(v.id) : Promise.resolve(),
      ]);
      if (res.skipped) {
        get().notify("正在刷新订阅，请稍候");
      } else if (res.newEpisodes > 0) {
        get().notify(`已刷新 ${res.shows} 个订阅，新增 ${res.newEpisodes} 集`);
      } else {
        get().notify(`已刷新 ${res.shows} 个订阅，已是最新`);
      }
    } catch (err) {
      get().notify(err instanceof Error ? err.message : "全部刷新失败", false);
    } finally {
      set({ refreshingAll: false });
    }
  },

  loadMoreShow: async (id) => {
    const res = await api.loadMoreShow(id);
    set((s) => ({
      showHasMore: { ...s.showHasMore, [id]: res.hasMore },
    }));
    await Promise.all([get().loadShowEpisodes(id), get().refreshLibrary()]);
    if (res.added > 0) {
      get().notify(`已加载 ${res.added} 集更早单集`);
    } else if (!res.hasMore) {
      get().notify("已加载全部公开单集");
    }
    return { added: res.added, hasMore: res.hasMore };
  },

  markShowAllCompleted: async (id, isVideo) => {
    const res = await api.markShowAllCompleted(id);
    await Promise.all([get().loadShowEpisodes(id), get().refreshLibrary()]);
    get().notify(
      res.updated > 0
        ? `已将本频道 ${res.updated} 集标为${isVideo ? "已看" : "已听"}`
        : "当前没有未看单集",
    );
  },

  deleteShow: async (id) => {
    await api.removeShow(id);
    const v = get().view;
    if (v.kind === "show" && v.id === id) {
      set({ view: { kind: "home" } });
    }
    set((s) => {
      const next = { ...s.showEpisodes };
      delete next[id];
      const nextMore = { ...s.showHasMore };
      delete nextMore[id];
      return { showEpisodes: next, showHasMore: nextMore };
    });
    await get().refreshLibrary();
    get().notify("已取消订阅");
  },

  deleteEpisode: async (id) => {
    await api.removeEpisode(id);
    set((s) => {
      const nextCache = { ...s.episodeCache };
      delete nextCache[id];
      const nextShowEps: Record<string, Episode[]> = {};
      for (const [k, list] of Object.entries(s.showEpisodes)) {
        nextShowEps[k] = list.filter((e) => e.id !== id);
      }
      const isCur = s.current?.id === id;
      const inEp = s.view.kind === "episode" && s.view.id === id;
      return {
        recentEpisodes: s.recentEpisodes.filter((e) => e.id !== id),
        latestEpisodes: s.latestEpisodes.filter((e) => e.id !== id),
        episodeCache: nextCache,
        showEpisodes: nextShowEps,
        ...(isCur ? { current: null, playing: false, player: null, time: 0, length: 0 } : {}),
        ...(inEp ? { view: { kind: "home" as const } } : {}),
      };
    });
    await get().refreshLibrary();
    get().notify("已删除该单集及关联本地数据");
  },

  toggleEpisodeCompleted: async (ep, next) => {
    const target = next ?? !ep.completed;
    const res = await api.setCompleted(ep.id, target);
    const updated = res.episode;
    set((s) => {
      const patchList = (list: Episode[]) => list.map((e) => (e.id === ep.id ? updated : e));
      const nextShowEps: Record<string, Episode[]> = {};
      for (const [k, list] of Object.entries(s.showEpisodes)) nextShowEps[k] = patchList(list);
      return {
        recentEpisodes: patchList(s.recentEpisodes),
        latestEpisodes: patchList(s.latestEpisodes),
        showEpisodes: nextShowEps,
        episodeCache: { ...s.episodeCache, [ep.id]: updated },
        current: s.current?.id === ep.id ? updated : s.current,
      };
    });
    void Promise.all([api.listShows(), api.recentEpisodes()])
      .then(([shows, recent]) => {
        set({ shows, recentEpisodes: recent });
      })
      .catch(() => {});
    get().notify(
      target ? (ep.videoId ? "已标为已看" : "已标为已听") : ep.videoId ? "已标为未看" : "已标为未听",
    );
  },

  touchEpisodeLocal: (ep) => {
    set((s) => {
      const touched: Episode = { ...ep, touchedAt: Math.max(ep.touchedAt ?? 0, Date.now()) };
      const qualifies =
        touched.progress > 0 ||
        touched.hasTranscript ||
        touched.showId === "single" ||
        s.recentEpisodes.some((e) => e.id === touched.id);
      return {
        episodeCache: { ...s.episodeCache, [touched.id]: touched },
        ...(qualifies ? { recentEpisodes: upsertRecentTop(s.recentEpisodes, touched) } : {}),
      };
    });
  },

  syncProgressLocal: (id, seconds, completed, epHint) => {
    const prevDone = !!(get().episodeCache[id]?.completed || (get().current?.id === id && get().current?.completed));
    const newlyCompleted = completed === true && !prevDone;
    const nextSec = Math.max(0, seconds);
    const now = Date.now();
    set((s) => {
      const patch = (e: Episode): Episode =>
        e.id === id
          ? {
              ...e,
              progress: nextSec,
              touchedAt: now,
              ...(completed !== undefined ? { completed } : {}),
            }
          : e;
      const nextShowEps: Record<string, Episode[]> = {};
      for (const [k, list] of Object.entries(s.showEpisodes)) nextShowEps[k] = list.map(patch);
      const base =
        s.episodeCache[id] ??
        s.recentEpisodes.find((e) => e.id === id) ??
        (s.current?.id === id ? s.current : undefined) ??
        epHint ??
        s.latestEpisodes.find((e) => e.id === id) ??
        Object.values(s.showEpisodes)
          .flat()
          .find((e) => e.id === id);
      const updated = base ? patch(base) : undefined;
      const promote = updated && (nextSec > 0 || completed !== undefined || s.recentEpisodes.some((e) => e.id === id));
      return {
        recentEpisodes: promote && updated ? upsertRecentTop(s.recentEpisodes, updated) : s.recentEpisodes.map(patch),
        latestEpisodes: s.latestEpisodes.map(patch),
        showEpisodes: nextShowEps,
        current: s.current?.id === id ? patch(s.current) : s.current,
        episodeCache: updated ? { ...s.episodeCache, [id]: updated } : s.episodeCache,
      };
    });
    if (newlyCompleted) {
      void api
        .listShows()
        .then((shows) => set({ shows }))
        .catch(() => {});
    }
  },

  importText: async (opts) => {
    const res = await api.importText(opts);
    await get().refreshLibrary();
    get().openEpisode(res.episode);
    get().notify(`已导入文稿「${res.episode.title}」（${res.transcript.segments.length} 段）`);
  },

  importMedia: async (file, title) => {
    const res = await api.importMedia(file, title);
    await get().refreshLibrary();
    get().openEpisode(res.episode);
    get().notify(`已导入本地音视频「${res.episode.title}」`);
  },

  markHasTranscript: (episodeId) => {
    set((s) => {
      const patchList = (list: Episode[]) =>
        list.map((e) => (e.id === episodeId ? { ...e, hasTranscript: true } : e));
      const nextShowEps: Record<string, Episode[]> = {};
      for (const [k, list] of Object.entries(s.showEpisodes)) nextShowEps[k] = patchList(list);
      const cached = s.episodeCache[episodeId];
      return {
        recentEpisodes: patchList(s.recentEpisodes),
        latestEpisodes: patchList(s.latestEpisodes),
        showEpisodes: nextShowEps,
        current: s.current?.id === episodeId ? { ...s.current, hasTranscript: true } : s.current,
        episodeCache: cached ? { ...s.episodeCache, [episodeId]: { ...cached, hasTranscript: true } } : s.episodeCache,
      };
    });
  },

  refreshAgents: async () => {
    const rawAgents = await api.detectAgents();
    const verified = get().verifiedAgents;
    set({ agents: mergeAgents(rawAgents, verified) });
  },

  refreshAsrStatus: async () => {
    const asrStatus = await api.getAsrModels();
    set({ asrStatus });
  },

  setAgentLoginState: async (kind, login) => {
    const nextVerified = { ...get().verifiedAgents, [kind]: login };
    set((s) => ({
      verifiedAgents: nextVerified,
      agents: s.agents.map((a) => (a.kind === kind ? { ...a, login } : a)),
    }));
    await api.saveSettings({ verifiedAgents: JSON.stringify(nextVerified) });
  },

  selectChatProvider: async (id) => {
    set({ chatProviderId: id, chatModel: "" });
    await api.saveSettings({ chatProvider: id, chatModel: "" });
    const p = get().getAllProviders().find((x) => x.id === id);
    if (p?.protocol === "cli" && p.login === "ready") {
      void api.warmAgent(p.id).catch(() => {});
    }
  },

  selectChatModel: async (providerId, model) => {
    set({ chatProviderId: providerId, chatModel: model });
    await api.saveSettings({ chatProvider: providerId, chatModel: model });
    const p = get().getAllProviders().find((x) => x.id === providerId);
    if (p?.protocol === "cli" && p.login === "ready") {
      void api.warmAgent(p.id).catch(() => {});
    }
  },

  saveProviderOverride: async (id, patch) => {
    const next = {
      ...get().providerOverrides,
      [id]: { ...get().providerOverrides[id], ...patch },
    };
    set({ providerOverrides: next });
    await api.saveSettings({ providerOverrides: JSON.stringify(next) });
  },

  saveApiKey: async (id, key) => {
    const res = await api.setKey(id, key);
    set((s) => ({ keyStatus: { ...s.keyStatus, [id]: res.hasKey } }));
  },

  saveAsrKey: (id, key) =>
    api.setKey(`asr.${id}`, key).then((res) => {
      set((s) => ({ asrKeyStatus: { ...s.asrKeyStatus, [id]: res.hasKey } }));
    }),

  saveCookies: async (text) => {
    const res = await api.saveCookies(text);
    set({ hasCookies: res.hasCookies });
    return res.hasCookies;
  },
}));
