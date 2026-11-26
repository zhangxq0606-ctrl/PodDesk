export interface HealthInfo {
  ok: boolean;
  version: string;
  port: number;
  db: string;
  dataDir: string;
  shows: number;
  configuredProxy: string;
  effectiveProxy: string;
  githubMirror?: string;
  activeJobs?: number;
  ytLoginSupported?: boolean;
}

export interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  tagName: string;
  title: string;
  notes: string;
  publishedAt?: string | null;
  prerelease: boolean;
  releaseUrl: string;
  downloadUrl: string;
  mirrorDownloadUrl?: string | null;
  assetName?: string | null;
  assetSize?: number | null;
  platform: string;
  checkedAt: number;
}

export interface Show {
  id: string;
  kind: "youtube" | "podcast" | "xiaoyuzhou" | "single";
  title: string;
  author?: string;
  cover?: string;
  feedUrl: string;
  link?: string;
  description?: string;
  updatedAt: number;
  unplayed: number;
}

export interface Episode {
  id: string;
  showId: string;
  guid: string;
  title: string;
  published?: number;
  duration?: number;
  audioUrl?: string;
  videoId?: string;
  link?: string;
  cover?: string;
  notes?: string;
  transcriptUrl?: string;
  transcriptType?: string;
  progress: number;
  hasTranscript: boolean;
  showTitle?: string;
  touchedAt?: number;
  completed: boolean;
}

export interface Segment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  episodeId: string;
  source: string;
  language: string;
  segments: Segment[];
}

export interface FoundAgent {
  kind: "claude" | "codex" | "antigravity" | "kimi" | "opencode";
  path: string;
  version: string;
  login: "ready" | "needsLogin" | "unknown";
}

export interface AgentModel {
  id: string;
  name: string;
}

export interface ProviderConfig {
  id: string;
  name: string;
  protocol: "openai" | "anthropic" | "cli";
  baseUrl: string;
  model: string;
  needsKey: boolean;
  group: "cli" | "provider" | "relay" | "local";
  keyUrl?: string;
  models?: string[];
  login?: FoundAgent["login"];
  version?: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  model?: string;
}

export interface OfficialTranscriptResult {
  transcript: Transcript;
  alignedTranslation?: (string | null)[] | null;
  duration?: number | null;
}

export interface NetCheckItem {
  id: "proxy" | "youtube" | "video" | "ytdlpSource" | "ytdlp";
  ok: boolean;
  ms?: number | null;
  detail: string;
}

export interface NetworkReport {
  checks: NetCheckItem[];
  webviewProxy: string;
  githubMirror: string;
}

export interface SearchResult {
  title: string;
  author: string;
  cover?: string;
  feedUrl: string;
  genre?: string;
  episodes?: number;
  source?: string;
}

export interface ImportTextResult {
  episode: Episode;
  transcript: Transcript;
}

export interface AsrGpuInfo {
  name: string;
  vendor: string;
  vramMb?: number | null;
  discrete: boolean;
}

export type AsrVariant = "vulkan" | "cuda13" | "cpu" | "cpu-legacy";

export interface AsrHardwareInfo {
  os: string;
  arch: string;
  avx2: boolean;
  windowsArm64: boolean;
  gpus: AsrGpuInfo[];
  hasDiscreteGpu: boolean;
  hasNvidia: boolean;
  recommendedVariant?: AsrVariant | null;
  recommendedModel: string;
  summary: string;
}

export interface AsrRuntimeInfo {
  version: string;
  activeVariant?: AsrVariant | null;
  preferredVariant?: AsrVariant | null;
  installedVariants: AsrVariant[];
  deviceIndex?: number | null;
  gpuName?: string | null;
  verified: boolean;
  fallbackReason?: string | null;
}

export interface AsrModelEntry {
  id: string;
  name: string;
  tier: "fast" | "balanced" | "accurate";
  backend: "sensevoice" | "qwen3";
  fileName: string;
  sizeMb: number;
  note: string;
  license: string;
  supportsContext: boolean;
  installed: boolean;
  recommended: boolean;
  from?: string | null;
}

export interface AsrModelsStatus {
  modelId: string;
  name: string;
  sizeMb: number;
  modelReady: boolean;
  engineReady: boolean;
  ytdlpReady: boolean;
  vadReady: boolean;
  hardware?: AsrHardwareInfo;
  runtime?: AsrRuntimeInfo;
  models: AsrModelEntry[];
}

export interface CloudAsrConfig {
  id: string;
  protocol: "doubao" | "deepseek" | "openai";
  baseUrl: string;
  model: string;
  chunkSecs?: number;
  needsKey?: boolean;
}

export interface ProgressEvent {
  stage: string;
  pct?: number;
  received?: number;
  total?: number;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(typeof data?.error === "string" ? data.error : `请求失败 (${res.status})`);
  }
  return data as T;
}

async function consumeSse<T extends { type?: string; message?: string }>(opts: {
  url: string;
  body: unknown;
  requestId: string;
  signal?: AbortSignal;
  onEvent: (ev: T) => void;
}): Promise<void> {
  const onAbort = () => {
    void api.cancelJob(opts.requestId);
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: opts.signal,
      body: JSON.stringify(opts.body),
    });
    if (!res.ok || !res.body) {
      throw new Error(`流式接口连接失败 (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line.startsWith("data:")) {
          const raw = line.slice(5).trim();
          if (raw) {
            const ev = JSON.parse(raw) as T;
            if (ev.type === "error") {
              throw new Error(ev.message || "任务执行失败");
            }
            opts.onEvent(ev);
          }
        }
        idx = buffer.indexOf("\n");
      }
    }
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
  }
}

export const api = {
  health: () => requestJson<HealthInfo>("/api/health"),
  getSettings: () => requestJson<Record<string, string>>("/api/settings"),
  saveSettings: (patch: Record<string, string>) =>
    requestJson<{ ok: boolean; configuredProxy: string; effectiveProxy: string; githubMirror?: string }>("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }),
  listShows: () => requestJson<Show[]>("/api/shows"),
  searchShows: (term: string, country = "us") => {
    const qs = new URLSearchParams({ term, country });
    return requestJson<SearchResult[]>(`/api/search?${qs.toString()}`);
  },
  refreshShow: (id: string) =>
    requestJson<{ show: Show; episodesCount: number }>(`/api/shows/${encodeURIComponent(id)}/refresh`, {
      method: "POST",
    }),
  refreshAllShows: () =>
    requestJson<{ shows: number; newEpisodes: number; skipped?: boolean }>("/api/shows/refresh-all", {
      method: "POST",
    }),
  loadMoreShow: (id: string) =>
    requestJson<{ added: number; total: number; hasMore: boolean; show?: Show }>(
      `/api/shows/${encodeURIComponent(id)}/load-more`,
      { method: "POST" },
    ),
  markShowAllCompleted: (id: string) =>
    requestJson<{ ok: boolean; updated: number }>(`/api/shows/${encodeURIComponent(id)}/mark-all-completed`, {
      method: "POST",
    }),
  removeShow: (id: string) => requestJson<{ ok: boolean }>(`/api/shows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  addSubscription: (input: string) =>
    requestJson<{ show?: Show; episode?: Episode; episodesCount?: number; hasMore?: boolean }>("/api/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ input }),
    }),
  listEpisodes: (showId?: string, limit = 300) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (showId) qs.set("showId", showId);
    return requestJson<Episode[]>(`/api/episodes?${qs.toString()}`);
  },
  recentEpisodes: () => requestJson<Episode[]>("/api/episodes/recent"),
  importText: (opts: { title?: string; text: string; format?: "auto" | "srt" | "vtt" | "txt" }) =>
    requestJson<ImportTextResult>("/api/episodes/import-text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  importMedia: (file: File, title?: string) => {
    const form = new FormData();
    if (title?.trim()) form.append("title", title.trim());
    form.append("file", file, file.name);
    return requestJson<{ episode: Episode }>("/api/episodes/import-media", {
      method: "POST",
      body: form,
    });
  },
  getEpisode: (id: string) => requestJson<Episode>(`/api/episodes/${encodeURIComponent(id)}`),
  removeEpisode: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/episodes/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setProgress: (id: string, seconds: number) =>
    requestJson<{ ok: boolean; completed?: boolean }>(`/api/episodes/${encodeURIComponent(id)}/progress`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seconds }),
    }),
  setCompleted: (id: string, completed: boolean) =>
    requestJson<{ ok: boolean; episode: Episode }>(`/api/episodes/${encodeURIComponent(id)}/completed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed }),
    }),
  getTranscript: (id: string) => requestJson<Transcript | null>(`/api/episodes/${encodeURIComponent(id)}/transcript`),
  fetchOfficialTranscript: (id: string) =>
    requestJson<OfficialTranscriptResult>(`/api/episodes/${encodeURIComponent(id)}/transcript/official`, {
      method: "POST",
    }),
  getBlob: (id: string, kind: string) =>
    requestJson<{ data: string | null }>(`/api/episodes/${encodeURIComponent(id)}/blobs/${encodeURIComponent(kind)}`),
  setBlob: (id: string, kind: string, data: string) =>
    requestJson<{ ok: boolean }>(`/api/episodes/${encodeURIComponent(id)}/blobs/${encodeURIComponent(kind)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    }),
  detectAgents: () => requestJson<FoundAgent[]>("/api/agents"),
  warmAgent: (kind: string) =>
    requestJson<{ ok: boolean }>("/api/agents/warm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
  probeAgent: (kind: string) =>
    requestJson<{ login: FoundAgent["login"] }>("/api/agents/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
  getAgentModels: (kind: string) =>
    requestJson<{ models: AgentModel[] }>("/api/agents/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind }),
    }),
  hasKey: (provider: string) => requestJson<{ hasKey: boolean }>(`/api/keys/${encodeURIComponent(provider)}`),
  setKey: (provider: string, key: string) =>
    requestJson<{ ok: boolean; hasKey: boolean }>(`/api/keys/${encodeURIComponent(provider)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }),
  cancelJob: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }).catch(() => ({
      ok: false,
    })),

  getAsrModels: () => requestJson<AsrModelsStatus>("/api/asr/models"),
  probeAsrRuntime: (opts?: { variant?: string; deviceIndex?: number; forceHardware?: boolean }) =>
    requestJson<AsrModelsStatus & { needsDownload?: boolean; variant?: AsrVariant; approxMb?: number }>("/api/asr/probe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts ?? {}),
    }),
  downloadAsrModel: async (opts: {
    requestId: string;
    modelId?: string;
    variant?: string;
    runtimeOnly?: boolean;
    signal?: AbortSignal;
    onProgress: (p: ProgressEvent) => void;
  }): Promise<void> => {
    await consumeSse<{ type?: string; stage?: string; pct?: number; received?: number; total?: number; message?: string }>({
      url: "/api/asr/models/download",
      requestId: opts.requestId,
      signal: opts.signal,
      body: {
        requestId: opts.requestId,
        modelId: opts.modelId,
        variant: opts.variant,
        runtimeOnly: opts.runtimeOnly ?? false,
        mirrorFirst: true,
      },
      onEvent: (ev) => {
        if (ev.type === "progress") {
          opts.onProgress({
            stage: ev.stage ?? "下载中...",
            pct: ev.pct,
            received: ev.received,
            total: ev.total,
          });
        }
      },
    });
  },
  transcribeEpisode: async (opts: {
    episodeId: string;
    requestId: string;
    engine: "local" | "qwen3" | "cloud";
    modelId?: string;
    language: string;
    cloud?: CloudAsrConfig;
    signal?: AbortSignal;
    onProgress: (p: ProgressEvent) => void;
  }): Promise<Transcript> => {
    let result: Transcript | null = null;
    await consumeSse<{ type?: string; stage?: string; pct?: number; transcript?: Transcript; message?: string }>({
      url: `/api/episodes/${encodeURIComponent(opts.episodeId)}/transcribe`,
      requestId: opts.requestId,
      signal: opts.signal,
      body: {
        requestId: opts.requestId,
        engine: opts.engine,
        modelId: opts.modelId,
        language: opts.language,
        cloud: opts.cloud,
      },
      onEvent: (ev) => {
        if (ev.type === "progress") {
          opts.onProgress({ stage: ev.stage ?? "处理中...", pct: ev.pct });
        } else if (ev.type === "done" && ev.transcript) {
          result = ev.transcript;
        }
      },
    });
    if (!result) throw new Error("未收到转写结果");
    return result;
  },
  getStreamUrl: (episodeId: string, fresh = false, signal?: AbortSignal) =>
    requestJson<{ url: string; duration?: number | null }>(
      `/api/episodes/${encodeURIComponent(episodeId)}/stream-url?fresh=${fresh ? "true" : "false"}`,
      signal ? { signal } : undefined,
    ),
  networkCheck: () => requestJson<NetworkReport>("/api/network/check"),
  getCookiesStatus: () => requestJson<{ hasCookies: boolean }>("/api/cookies"),
  saveCookies: (text: string) =>
    requestJson<{ ok: boolean; hasCookies: boolean }>("/api/cookies", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }),
  getYouTubeAuth: () => requestJson<{ supported: boolean; signedIn: boolean }>("/api/youtube/auth"),
  openYouTubeLogin: () => requestJson<{ ok: boolean }>("/api/youtube/auth/login", { method: "POST" }),
  logoutYouTube: () => requestJson<{ ok: boolean; signedIn: boolean }>("/api/youtube/auth/logout", { method: "POST" }),
  checkUpdate: (force = false) =>
    requestJson<UpdateInfo>(`/api/app/update${force ? "?force=1" : ""}`),

  quitApp: () => requestJson<{ ok: boolean }>("/api/app/quit", { method: "POST" }),

  async streamChat(opts: {
    requestId: string;
    provider: Pick<ProviderConfig, "id" | "protocol" | "baseUrl" | "model">;
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    maxTokens?: number;
    jsonMode?: boolean;
    quick?: boolean;
    signal?: AbortSignal;
    onDelta?: (text: string) => void;
    onThinking?: () => void;
  }): Promise<string> {
    let full = "";
    let finalText = "";
    await consumeSse<{ type?: string; text?: string; message?: string }>({
      url: "/api/llm/chat",
      requestId: opts.requestId,
      signal: opts.signal,
      body: {
        requestId: opts.requestId,
        provider: opts.provider,
        system: opts.system,
        messages: opts.messages,
        maxTokens: opts.maxTokens ?? 8000,
        jsonMode: opts.jsonMode ?? false,
        quick: opts.quick ?? false,
      },
      onEvent: (ev) => {
        if (ev.type === "thinking") {
          opts.onThinking?.();
        } else if (ev.type === "delta" && ev.text) {
          full += ev.text;
          opts.onDelta?.(ev.text);
        } else if (ev.type === "done" && ev.text) {
          finalText = ev.text;
        }
      },
    });
    return finalText || full;
  },
};
