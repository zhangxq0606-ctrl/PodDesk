import { create } from "zustand";
import {
  batches,
  batchShape,
  buildQaSystem,
  makeEpisodeContext,
  summaryPrompt,
  transcriptForModel,
  translateBatch,
  type EpisodeContext,
} from "./ai";
import { api, type ChatMessage, type Episode, type ProviderConfig, type Transcript } from "./api";
import { CLOUD_ASR_PRESETS } from "./providers";
import { resolveLocalModelId, useStore } from "../store";

export interface ArchivedChat {
  id: string;
  at: number;
  messages: ChatMessage[];
}

export interface TranslationJob {
  items: (string | null)[];
  running: boolean;
  engine?: "llm" | "google";
  progressText?: string;
  done: number;
  total: number;
  error?: string | null;
  retranslating?: boolean;
  pendingDone?: number;
}

export interface AsrJob {
  running: boolean;
  stage: string;
  pct?: number;
  error?: string | null;
}

export interface ChatJob {
  messages: ChatMessage[];
  archive: ArchivedChat[];
  streaming: string | null;
  loaded: boolean;
  error?: string | null;
}

export interface GuideJob {
  summary: string | null;
  streaming: string | null;
  loaded: boolean;
  error?: string | null;
}

interface JobsState {
  transcripts: Record<string, Transcript | null>;
  officialStatus: Record<string, "idle" | "loading" | "searching" | "ok" | "none" | "error">;
  officialError: Record<string, string | null>;
  translations: Record<string, TranslationJob>;
  asr: Record<string, AsrJob>;
  chats: Record<string, ChatJob>;
  guides: Record<string, GuideJob>;
  ctxByEpisode: Record<string, EpisodeContext | null>;
  draftAsk: { episodeId: string; text: string; nonce: number } | null;
}

export const useJobs = create<JobsState>(() => ({
  transcripts: {},
  officialStatus: {},
  officialError: {},
  translations: {},
  asr: {},
  chats: {},
  guides: {},
  ctxByEpisode: {},
  draftAsk: null,
}));

const translateAborts = new Map<string, AbortController>();
const asrAborts = new Map<string, AbortController>();
const chatAborts = new Map<string, AbortController>();
const guideAborts = new Map<string, AbortController>();
const loadingTranscripts = new Set<string>();

function putTranslation(id: string, patch: Partial<TranslationJob>) {
  useJobs.setState((s) => ({
    translations: {
      ...s.translations,
      [id]: {
        ...(s.translations[id] ?? { items: [], running: false, done: 0, total: 0 }),
        ...patch,
      },
    },
  }));
}

function putAsr(id: string, patch: Partial<AsrJob>) {
  useJobs.setState((s) => ({
    asr: {
      ...s.asr,
      [id]: { ...(s.asr[id] ?? { running: false, stage: "" }), ...patch },
    },
  }));
}

function putChat(id: string, patch: Partial<ChatJob>) {
  useJobs.setState((s) => ({
    chats: {
      ...s.chats,
      [id]: {
        ...(s.chats[id] ?? { messages: [], archive: [], streaming: null, loaded: false }),
        ...patch,
      },
    },
  }));
}

function putGuide(id: string, patch: Partial<GuideJob>) {
  useJobs.setState((s) => ({
    guides: {
      ...s.guides,
      [id]: {
        ...(s.guides[id] ?? { summary: null, streaming: null, loaded: false }),
        ...patch,
      },
    },
  }));
}

export function clearEpisodeJobs(id: string): void {
  translateAborts.get(id)?.abort();
  asrAborts.get(id)?.abort();
  chatAborts.get(id)?.abort();
  guideAborts.get(id)?.abort();
  useJobs.setState((s) => {
    const t = { ...s.transcripts };
    const os = { ...s.officialStatus };
    const oe = { ...s.officialError };
    const tr = { ...s.translations };
    const a = { ...s.asr };
    const c = { ...s.chats };
    const g = { ...s.guides };
    const ctx = { ...s.ctxByEpisode };
    delete t[id];
    delete os[id];
    delete oe[id];
    delete tr[id];
    delete a[id];
    delete c[id];
    delete g[id];
    delete ctx[id];
    return { transcripts: t, officialStatus: os, officialError: oe, translations: tr, asr: a, chats: c, guides: g, ctxByEpisode: ctx };
  });
}

export async function loadEpisodeContext(epId: string): Promise<EpisodeContext | null> {
  const existing = useJobs.getState().ctxByEpisode[epId];
  if (existing !== undefined) return existing;
  try {
    const res = await api.getBlob(epId, "ctx");
    const ctx = res.data ? (JSON.parse(res.data) as EpisodeContext) : null;
    useJobs.setState((s) => ({ ctxByEpisode: { ...s.ctxByEpisode, [epId]: ctx } }));
    return ctx;
  } catch {
    return null;
  }
}

export async function saveEpisodeContext(epId: string, ctx: EpisodeContext): Promise<void> {
  useJobs.setState((s) => ({ ctxByEpisode: { ...s.ctxByEpisode, [epId]: ctx } }));
  await api.setBlob(epId, "ctx", JSON.stringify(ctx));
}

export async function loadEpisodeTranscript(ep: Episode): Promise<void> {
  const state = useJobs.getState();
  if (state.transcripts[ep.id] && state.translations[ep.id]) {
    return;
  }
  if (loadingTranscripts.has(ep.id)) {
    return;
  }
  loadingTranscripts.add(ep.id);
  const prevStatus = state.officialStatus[ep.id];
  if (prevStatus !== "ok" && prevStatus !== "searching") {
    useJobs.setState((s) => ({
      officialStatus: { ...s.officialStatus, [ep.id]: "loading" },
    }));
  }

  try {
    const [tr, trBlob] = await Promise.all([
      api.getTranscript(ep.id).catch(() => null),
      api.getBlob(ep.id, "translation").catch(() => ({ data: null })),
    ]);
    void loadEpisodeContext(ep.id);

    let savedItems: (string | null)[] = [];
    let savedEngine: "llm" | "google" | undefined;
    if (trBlob.data) {
      try {
        const parsed = JSON.parse(trBlob.data) as { items?: (string | null)[]; engine?: "llm" | "google" };
        if (Array.isArray(parsed.items)) savedItems = parsed.items;
        if (parsed.engine === "llm" || parsed.engine === "google") savedEngine = parsed.engine;
      } catch {
        /* ignore malformed blob */
      }
    }

    if (tr) {
      const aligned = Array.from({ length: tr.segments.length }, (_, i) => savedItems[i] ?? null);
      const done = aligned.filter((x) => x != null && x !== "").length;
      useJobs.setState((s) => ({
        transcripts: { ...s.transcripts, [ep.id]: tr },
        officialStatus: { ...s.officialStatus, [ep.id]: "ok" },
      }));
      putTranslation(ep.id, {
        items: aligned,
        done,
        total: tr.segments.length,
        engine: savedEngine,
        running: useJobs.getState().translations[ep.id]?.running ?? false,
      });
      return;
    }

    useJobs.setState((s) => ({
      transcripts: { ...s.transcripts, [ep.id]: null },
    }));

    if ((ep.videoId || ep.transcriptUrl) && useJobs.getState().officialStatus[ep.id] !== "searching") {
      await fetchOfficialSub(ep, true);
    } else {
      useJobs.setState((s) => ({
        officialStatus: { ...s.officialStatus, [ep.id]: "none" },
      }));
    }
  } finally {
    loadingTranscripts.delete(ep.id);
  }
}

export async function fetchOfficialSub(ep: Episode, silent = false): Promise<void> {
  useJobs.setState((s) => ({
    officialStatus: { ...s.officialStatus, [ep.id]: "searching" },
    officialError: { ...s.officialError, [ep.id]: null },
  }));
  try {
    const res = await api.fetchOfficialTranscript(ep.id);
    const len = res.transcript.segments.length;
    const items = Array.from({ length: len }, (_, i) => res.alignedTranslation?.[i] ?? null);
    const done = items.filter((x) => x != null && x !== "").length;
    useJobs.setState((s) => ({
      transcripts: { ...s.transcripts, [ep.id]: res.transcript },
      officialStatus: { ...s.officialStatus, [ep.id]: "ok" },
    }));
    putTranslation(ep.id, { items, done, total: len, running: false, error: null });
    useStore.getState().markHasTranscript(ep.id);
    if (!silent) useStore.getState().notify(`已获取字幕（${len} 段）`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "获取官方字幕失败";
    const noSub = /没有|暂无|not found|none/i.test(msg);
    useJobs.setState((s) => ({
      officialStatus: { ...s.officialStatus, [ep.id]: noSub ? "none" : "error" },
      officialError: { ...s.officialError, [ep.id]: noSub ? null : msg },
    }));
    if (!silent) {
      const netLike = !noSub && /网络|超时|代理|连接|proxy|timeout|yt-dlp|cookie|403|429/i.test(msg);
      useStore
        .getState()
        .notify(msg, false, netLike ? { label: "检查网络", run: () => useStore.getState().openSettings("network") } : undefined);
    }
  }
}

export function stopTranslate(epId: string): void {
  translateAborts.get(epId)?.abort();
  translateAborts.delete(epId);
  putTranslation(epId, { running: false, retranslating: false, pendingDone: undefined, progressText: undefined });
}

export async function runTranslate(
  ep: Episode,
  opts?: { forceEngine?: "llm" | "google"; restart?: boolean },
): Promise<void> {
  const tr = useJobs.getState().transcripts[ep.id];
  if (!tr || useJobs.getState().translations[ep.id]?.running) return;

  const store = useStore.getState();
  const provider = store.getTranslateProvider();
  const canLlm = store.isProviderReady(provider);
  const prefEngine = store.prefs.translateEngine;
  const resolved: "llm" | "google" =
    opts?.forceEngine ?? (prefEngine === "llm" ? "llm" : prefEngine === "google" ? "google" : canLlm ? "llm" : "google");

  if (resolved === "llm" && !canLlm) {
    const msg =
      provider?.protocol === "cli"
        ? `请先在设置中验证「${provider.name}」可用，或改用谷歌免费直连。`
        : `请先在设置中配置「${provider?.name ?? "模型"}」的 API Key，或改用谷歌免费直连。`;
    putTranslation(ep.id, { error: msg });
    return;
  }

  const ctrl = new AbortController();
  translateAborts.set(ep.id, ctrl);

  const len = tr.segments.length;
  const prevJob = useJobs.getState().translations[ep.id];
  const prevItems = prevJob?.items ?? [];
  const prevEngine = prevJob?.engine;
  const prevDone = prevItems.filter((x) => x != null && x !== "").length;
  const isCopyOnWrite = Boolean(opts?.restart && prevDone > 0);
  const work: (string | null)[] = opts?.restart
    ? Array(len).fill(null)
    : Array.from({ length: len }, (_, i) => prevItems[i] ?? null);

  if (isCopyOnWrite) {
    putTranslation(ep.id, {
      items: prevItems,
      done: prevDone,
      engine: prevEngine,
      running: true,
      retranslating: true,
      pendingDone: 0,
      total: len,
      progressText: resolved === "llm" ? "准备重译上下文..." : "连接谷歌直连重译...",
      error: null,
    });
  } else {
    putTranslation(ep.id, {
      items: [...work],
      running: true,
      retranslating: false,
      pendingDone: undefined,
      engine: resolved,
      done: work.filter((x) => x != null && x !== "").length,
      total: len,
      progressText: resolved === "llm" ? "准备术语表与翻译上下文..." : "连接谷歌直连翻译...",
      error: null,
    });
  }

  try {
    if (resolved === "llm" && provider) {
      let ctx = await loadEpisodeContext(ep.id);
      if (!ctx) {
        putTranslation(ep.id, { progressText: "正在提取节目摘要与专有名词表..." });
        try {
          ctx = await makeEpisodeContext(provider, {
            title: ep.title,
            show: ep.showTitle || "",
            notes: ep.notes || "",
            segments: tr.segments,
            signal: ctrl.signal,
          });
          if (ctx) await saveEpisodeContext(ep.id, ctx);
        } catch (err) {
          if (ctrl.signal.aborted) throw err;
        }
      }

      const shape = batchShape(provider);
      let round = 0;
      while (round < 2 && !ctrl.signal.aborted) {
        const todo = batches(tr.segments, work, shape);
        if (todo.length === 0) break;
        round += 1;
        for (let idx = 0; idx < todo.length; idx++) {
          if (ctrl.signal.aborted) break;
          const doneNow = work.filter((x) => x != null && x !== "").length;
          putTranslation(ep.id, {
            ...(isCopyOnWrite ? { pendingDone: doneNow } : { done: doneNow }),
            progressText: `大模型精译 · 第 ${idx + 1}/${todo.length} 批`,
          });
          const mapped = await translateBatch(provider, tr.segments, todo[idx], {
            title: ep.title,
            show: ep.showTitle || "",
            ctx,
            signal: ctrl.signal,
            polish: store.prefs.translateQuality === "best",
          });
          for (const [segIdx, zhText] of mapped) {
            work[segIdx] = zhText;
          }
          const nextDone = work.filter((x) => x != null && x !== "").length;
          if (isCopyOnWrite) {
            putTranslation(ep.id, { pendingDone: nextDone });
          } else {
            putTranslation(ep.id, { items: [...work], done: nextDone });
            await api.setBlob(ep.id, "translation", JSON.stringify({ lang: "zh-CN", engine: "llm", items: work }));
          }
        }
      }
    } else {
      const missingIds = work.map((v, i) => (v == null ? i : -1)).filter((i) => i >= 0);
      const chunkSize = 40;
      for (let i = 0; i < missingIds.length; i += chunkSize) {
        if (ctrl.signal.aborted) break;
        const sliceIds = missingIds.slice(i, i + chunkSize);
        putTranslation(ep.id, {
          progressText: `谷歌直连翻译 · ${Math.min(i + sliceIds.length, missingIds.length)}/${missingIds.length}`,
        });
        const res = await api.translateGoogle(
          sliceIds.map((idx) => tr.segments[idx].text),
          "zh-CN",
          ctrl.signal,
        );
        sliceIds.forEach((segIdx, j) => {
          work[segIdx] = res.items[j] ?? "";
        });
        const nextDone = work.filter((x) => x != null && x !== "").length;
        if (isCopyOnWrite) {
          putTranslation(ep.id, { pendingDone: nextDone });
        } else {
          putTranslation(ep.id, { items: [...work], done: nextDone });
          await api.setBlob(ep.id, "translation", JSON.stringify({ lang: "zh-CN", engine: "google", items: work }));
        }
      }
    }

    if (!ctrl.signal.aborted) {
      const doneFinal = work.filter((x) => x != null && x !== "").length;
      if (isCopyOnWrite && doneFinal === 0) {
        putTranslation(ep.id, {
          items: prevItems,
          done: prevDone,
          engine: prevEngine,
          running: false,
          retranslating: false,
          pendingDone: undefined,
          progressText: undefined,
          error: "重译未生成有效译文，已保留原有译文",
        });
      } else {
        putTranslation(ep.id, {
          items: [...work],
          done: doneFinal,
          engine: resolved,
          running: false,
          retranslating: false,
          pendingDone: undefined,
          progressText: undefined,
          error: null,
        });
        if (isCopyOnWrite) {
          await api.setBlob(ep.id, "translation", JSON.stringify({ lang: "zh-CN", engine: resolved, items: work }));
        }
        useStore.getState().notify(`中文译文已完成（${doneFinal}/${len} 段）`);
      }
    }
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError") && !ctrl.signal.aborted) {
      putTranslation(ep.id, {
        ...(isCopyOnWrite ? { items: prevItems, done: prevDone, engine: prevEngine } : {}),
        running: false,
        retranslating: false,
        pendingDone: undefined,
        progressText: undefined,
        error: err instanceof Error ? err.message : "翻译失败",
      });
    } else {
      putTranslation(ep.id, {
        ...(isCopyOnWrite ? { items: prevItems, done: prevDone, engine: prevEngine } : {}),
        running: false,
        retranslating: false,
        pendingDone: undefined,
        progressText: undefined,
      });
    }
  } finally {
    translateAborts.delete(ep.id);
  }
}

export function stopTranscribe(epId: string): void {
  asrAborts.get(epId)?.abort();
  asrAborts.delete(epId);
  putAsr(epId, { running: false, stage: "" });
}

export async function runTranscribe(ep: Episode): Promise<void> {
  if (useJobs.getState().asr[ep.id]?.running) return;
  const store = useStore.getState();
  const choice = store.prefs.asrChoice;
  const lang = store.prefs.asrLang;
  const isCloud = choice.startsWith("cloud:");
  const cloudPreset = isCloud ? CLOUD_ASR_PRESETS.find((p) => p.id === choice.slice(6)) : undefined;
  const localModelId = isCloud ? undefined : resolveLocalModelId(choice, store.asrStatus);
  const localEntry = localModelId ? store.asrStatus?.models.find((m) => m.id === localModelId) : undefined;

  if (!isCloud && store.asrStatus && (!store.asrStatus.engineReady || (localEntry ? !localEntry.installed : !store.asrStatus.modelReady))) {
    putAsr(ep.id, {
      error: `本机离线模型「${localEntry?.name ?? localModelId ?? "语音模型"}」或 CrispASR 尚未安装，请前往「设置 › 字幕与转写」下载。`,
    });
    return;
  }
  if (isCloud && cloudPreset) {
    const hasK =
      !cloudPreset.needsKey ||
      !!store.asrKeyStatus[cloudPreset.id] ||
      (cloudPreset.id === "deepseek" && !!store.keyStatus.deepseek);
    if (!hasK) {
      putAsr(ep.id, { error: `请先在「设置 › 字幕与转写」填写「${cloudPreset.name}」的 API Key。` });
      return;
    }
  }

  const ctrl = new AbortController();
  asrAborts.set(ep.id, ctrl);
  putAsr(ep.id, { running: true, stage: "准备音频来源...", pct: undefined, error: null });

  try {
    const tr = await api.transcribeEpisode({
      episodeId: ep.id,
      requestId: crypto.randomUUID(),
      engine: isCloud ? "cloud" : "local",
      modelId: localModelId,
      language: lang,
      cloud: cloudPreset
        ? {
            id: cloudPreset.id,
            protocol: cloudPreset.protocol,
            baseUrl: cloudPreset.baseUrl,
            model: cloudPreset.model,
            chunkSecs: cloudPreset.chunkSecs,
            needsKey: cloudPreset.needsKey,
          }
        : undefined,
      signal: ctrl.signal,
      onProgress: (p) => {
        putAsr(ep.id, { stage: p.stage, pct: p.pct });
      },
    });
    if (!isCloud) void store.refreshAsrStatus().catch(() => {});
    useJobs.setState((s) => ({
      transcripts: { ...s.transcripts, [ep.id]: tr },
      officialStatus: { ...s.officialStatus, [ep.id]: "ok" },
    }));
    putTranslation(ep.id, { items: Array(tr.segments.length).fill(null), done: 0, total: tr.segments.length, running: false, error: null });
    putAsr(ep.id, { running: false, stage: "", pct: undefined });
    useStore.getState().markHasTranscript(ep.id);
    useStore.getState().notify(`语音转写完成，共生成 ${tr.segments.length} 段字幕`);
  } catch (err) {
    if (!(err instanceof DOMException && err.name === "AbortError") && !ctrl.signal.aborted) {
      putAsr(ep.id, {
        running: false,
        stage: "",
        error: err instanceof Error ? err.message : "语音转写失败",
      });
    } else {
      putAsr(ep.id, { running: false, stage: "" });
    }
  } finally {
    asrAborts.delete(ep.id);
  }
}

export async function loadEpisodeChat(epId: string): Promise<void> {
  if (useJobs.getState().chats[epId]?.loaded) return;
  const [chatRes, archRes] = await Promise.all([
    api.getBlob(epId, "chat").catch(() => ({ data: null })),
    api.getBlob(epId, "chat-archive").catch(() => ({ data: null })),
  ]);
  if (useJobs.getState().chats[epId]?.loaded) return;
  let messages: ChatMessage[] = [];
  let archive: ArchivedChat[] = [];
  try {
    if (chatRes.data) messages = JSON.parse(chatRes.data) as ChatMessage[];
  } catch {
    /* ignore */
  }
  try {
    if (archRes.data) archive = JSON.parse(archRes.data) as ArchivedChat[];
  } catch {
    /* ignore */
  }
  putChat(epId, { messages, archive, loaded: true });
}

export async function saveEpisodeChat(epId: string, messages: ChatMessage[]): Promise<void> {
  putChat(epId, { messages, loaded: true });
  await api.setBlob(epId, "chat", JSON.stringify(messages));
}

export async function saveEpisodeChatArchive(epId: string, archive: ArchivedChat[]): Promise<void> {
  putChat(epId, { archive });
  await api.setBlob(epId, "chat-archive", JSON.stringify(archive));
}

export function stopChatAsk(epId: string): void {
  chatAborts.get(epId)?.abort();
  chatAborts.delete(epId);
}

export async function sendChatAsk(ep: Episode, nextHistory: ChatMessage[]): Promise<void> {
  const tr = useJobs.getState().transcripts[ep.id];
  const store = useStore.getState();
  const provider: ProviderConfig | undefined = store.getChatProvider();
  if (!tr) {
    putChat(ep.id, { error: "需要先有字幕才能提问" });
    return;
  }
  if (!provider || !store.isProviderReady(provider)) {
    putChat(ep.id, { error: `请先在设置中配置「${provider?.name ?? "模型"}」的 API Key，或切换为已登录本机 CLI Agent。` });
    return;
  }

  const trItems = useJobs.getState().translations[ep.id]?.items;
  const fullTranscript = transcriptForModel(tr.segments, trItems);
  const playbackPos = store.current?.id === ep.id ? store.time : ep.progress;
  const { chatInstruction, chatInstructionEnabled } = store.prefs;
  const customPref = chatInstructionEnabled && chatInstruction.trim() ? chatInstruction.trim() : undefined;
  const system = buildQaSystem(ep.title, ep.showTitle || "", fullTranscript, playbackPos, customPref);

  await saveEpisodeChat(ep.id, nextHistory);
  putChat(ep.id, { streaming: "", error: null });

  const ctrl = new AbortController();
  chatAborts.set(ep.id, ctrl);
  let partial = "";

  try {
    const answer = await api.streamChat({
      requestId: crypto.randomUUID(),
      provider: {
        id: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        model: provider.model,
      },
      system,
      messages: nextHistory.map(({ role, content }) => ({ role, content })),
      signal: ctrl.signal,
      onDelta: (delta) => {
        partial += delta;
        putChat(ep.id, { streaming: partial });
      },
    });
    const finalText = answer.trim() ? answer : partial.trim();
    const content = finalText || "出错了：模型没有返回内容，请重试或换一个模型";
    await saveEpisodeChat(ep.id, [...nextHistory, { role: "assistant", content, model: provider.name }]);
  } catch (err) {
    const aborted = (err instanceof DOMException && err.name === "AbortError") || ctrl.signal.aborted;
    const note = aborted ? "（已停止）" : `出错了：${err instanceof Error ? err.message : "AI 回答失败"}`;
    const merged = partial ? `${partial}\n\n${note}` : note;
    await saveEpisodeChat(ep.id, [...nextHistory, { role: "assistant", content: merged, model: provider.name }]);
  } finally {
    putChat(ep.id, { streaming: null });
    chatAborts.delete(ep.id);
  }
}

export async function loadEpisodeGuide(epId: string): Promise<void> {
  if (useJobs.getState().guides[epId]?.loaded) return;
  try {
    const res = await api.getBlob(epId, "summary");
    if (useJobs.getState().guides[epId]?.loaded) return;
    putGuide(epId, { summary: res.data ?? null, loaded: true });
  } catch {
    putGuide(epId, { summary: null, loaded: true });
  }
}

export function stopEpisodeGuide(epId: string): void {
  guideAborts.get(epId)?.abort();
  guideAborts.delete(epId);
}

export async function runEpisodeGuide(ep: Episode): Promise<void> {
  if (useJobs.getState().guides[ep.id]?.streaming != null) return;
  const tr = useJobs.getState().transcripts[ep.id];
  const store = useStore.getState();
  const provider = store.getChatProvider();
  if (!tr) {
    putGuide(ep.id, { error: "需要先有字幕才能生成导读" });
    return;
  }
  if (!provider || !store.isProviderReady(provider)) {
    putGuide(ep.id, { error: `请先在设置中配置「${provider?.name ?? "模型"}」的 API Key，或切换为已登录本机 CLI Agent。` });
    return;
  }

  const trItems = useJobs.getState().translations[ep.id]?.items;
  const fullTranscript = transcriptForModel(tr.segments, trItems);
  const system = buildQaSystem(ep.title, ep.showTitle || "", fullTranscript);
  const totalSec = tr.segments[tr.segments.length - 1]?.end ?? ep.duration;

  const ctrl = new AbortController();
  guideAborts.set(ep.id, ctrl);
  putGuide(ep.id, { streaming: "", error: null });
  let partial = "";

  try {
    const answer = await api.streamChat({
      requestId: crypto.randomUUID(),
      provider: {
        id: provider.id,
        protocol: provider.protocol,
        baseUrl: provider.baseUrl,
        model: provider.model,
      },
      system,
      messages: [{ role: "user", content: summaryPrompt(totalSec) }],
      signal: ctrl.signal,
      onDelta: (delta) => {
        partial += delta;
        putGuide(ep.id, { streaming: partial });
      },
    });
    const out = answer.trim() ? answer : partial.trim();
    if (!out) throw new Error("模型没有返回内容，请重试");
    putGuide(ep.id, { summary: out, streaming: null, loaded: true, error: null });
    await api.setBlob(ep.id, "summary", out);
  } catch (err) {
    const aborted = (err instanceof DOMException && err.name === "AbortError") || ctrl.signal.aborted;
    putGuide(ep.id, {
      streaming: null,
      error: aborted ? null : err instanceof Error ? err.message : "生成导读失败",
    });
  } finally {
    guideAborts.delete(ep.id);
  }
}

export function queueDraftAsk(episodeId: string, text: string): void {
  useJobs.setState({
    draftAsk: { episodeId, text, nonce: Date.now() },
  });
}
