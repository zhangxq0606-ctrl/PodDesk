import type { FoundAgent, ProviderConfig } from "./api";

export interface AgentMeta {
  name: string;
  vendor: string;
  loginCmd: string;
  plan: string;
  defaultModels: string[];
  installUrl: string;
}

export const AGENT_META: Record<FoundAgent["kind"], AgentMeta> = {
  claude: {
    name: "Claude Code",
    vendor: "Anthropic",
    loginCmd: "claude",
    plan: "Claude 订阅（Pro / Max）",
    defaultModels: ["sonnet", "opus", "haiku"],
    installUrl: "https://claude.com/claude-code",
  },
  codex: {
    name: "Codex",
    vendor: "OpenAI",
    loginCmd: "codex login",
    plan: "ChatGPT 订阅",
    defaultModels: [],
    installUrl: "https://developers.openai.com/codex/cli",
  },
  antigravity: {
    name: "Antigravity CLI",
    vendor: "Google",
    loginCmd: "agy",
    plan: "Google 账号（Gemini）",
    defaultModels: [],
    installUrl: "https://antigravity.google",
  },
  kimi: {
    name: "Kimi Code",
    vendor: "月之暗面",
    loginCmd: "kimi",
    plan: "Kimi 账号",
    defaultModels: [],
    installUrl: "https://www.kimi.com/code",
  },
  opencode: {
    name: "OpenCode",
    vendor: "OpenCode",
    loginCmd: "opencode auth login",
    plan: "OpenCode 里配置或免费的额度",
    defaultModels: [],
    installUrl: "https://opencode.ai",
  },
};

export const CORE_PRESETS: ProviderConfig[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai",
    group: "provider",
    baseUrl: "https://api.deepseek.com/v1",
    model: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
    needsKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    protocol: "openai",
    group: "relay",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "deepseek-ai/DeepSeek-V3",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen3-235B-A22B"],
    needsKey: true,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai",
    group: "relay",
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-4",
    models: ["anthropic/claude-sonnet-4", "openai/gpt-4.1-mini"],
    needsKey: true,
    keyUrl: "https://openrouter.ai/settings/keys",
  },
  {
    id: "anthropic",
    name: "Claude (Anthropic)",
    protocol: "anthropic",
    group: "provider",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-20250514",
    models: ["claude-sonnet-4-20250514", "claude-3-7-sonnet-latest"],
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai",
    group: "provider",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4.1-mini",
    models: ["gpt-4.1-mini", "gpt-4.1"],
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "google-gemini",
    name: "Google Gemini",
    protocol: "openai",
    group: "provider",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro"],
    needsKey: true,
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  {
    id: "moonshot",
    name: "Kimi（月之暗面）",
    protocol: "openai",
    group: "provider",
    baseUrl: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-auto",
    models: ["moonshot-v1-auto"],
    needsKey: true,
    keyUrl: "https://platform.moonshot.cn/console/api-keys",
  },
  {
    id: "qwen-cn",
    name: "通义千问（百炼）",
    protocol: "openai",
    group: "provider",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
    models: ["qwen-plus", "qwen-max"],
    needsKey: true,
    keyUrl: "https://bailian.console.aliyun.com/?apiKey=1",
  },
  {
    id: "ollama",
    name: "Ollama（本机）",
    protocol: "openai",
    group: "local",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen3",
    models: ["qwen3", "llama3.2"],
    needsKey: false,
  },
  {
    id: "custom",
    name: "自定义（OpenAI 兼容）",
    protocol: "openai",
    group: "provider",
    baseUrl: "",
    model: "",
    models: [],
    needsKey: true,
  },
];

export interface ProviderOverride {
  baseUrl?: string;
  model?: string;
  models?: string[];
}

export function buildProviders(
  agents: FoundAgent[],
  overrides: Record<string, ProviderOverride>,
  verifiedAgents: Record<string, FoundAgent["login"]> = {},
): ProviderConfig[] {
  const cliList: ProviderConfig[] = agents
    .filter((a) => a.kind in AGENT_META)
    .map((a) => {
      const meta = AGENT_META[a.kind];
      const ov = overrides[a.kind];
      const verified = verifiedAgents[a.kind];
      const effectiveLogin =
        a.login === "ready"
          ? "ready"
          : a.login === "unknown" && (verified === "ready" || verified === "needsLogin")
            ? verified
            : a.login;
      const models = ov?.models !== undefined ? ov.models : meta.defaultModels;
      return {
        id: a.kind,
        name: meta.name,
        protocol: "cli",
        group: "cli",
        baseUrl: "",
        model: ov?.model ?? "",
        models,
        needsKey: false,
        login: effectiveLogin,
        version: a.version,
      };
    });

  const presets = CORE_PRESETS.map((p) => {
    const ov = overrides[p.id];
    const models = ov?.models
      ? [...new Set([...(p.models ?? []), ...ov.models])]
      : p.models;
    return {
      ...p,
      baseUrl: ov?.baseUrl ?? p.baseUrl,
      model: ov?.model ?? p.model,
      models,
    };
  });

  return [...cliList, ...presets];
}

export interface CloudAsrPreset {
  id: string;
  name: string;
  note: string;
  protocol: "doubao" | "deepseek" | "openai";
  baseUrl: string;
  model: string;
  models: string[];
  needsKey: boolean;
  chunkSecs: number;
  keyUrl?: string;
}

export const CLOUD_ASR_PRESETS: CloudAsrPreset[] = [
  {
    id: "doubao",
    name: "豆包语音（极速版）",
    note: "中文识别最准，支持热词上下文",
    protocol: "doubao",
    baseUrl: "https://openspeech.bytedance.com/api/v3",
    model: "bigmodel",
    models: ["bigmodel"],
    needsKey: true,
    chunkSecs: 300,
    keyUrl: "https://console.volcengine.com/speech/new/experience/asr",
  },
  {
    id: "siliconflow",
    name: "硅基流动",
    note: "Qwen3-ASR / SenseVoice 等，低成本",
    protocol: "openai",
    baseUrl: "https://api.siliconflow.cn/v1",
    model: "Qwen/Qwen3-ASR-1.7B",
    models: ["Qwen/Qwen3-ASR-1.7B", "FunAudioLLM/SenseVoiceSmall"],
    needsKey: true,
    chunkSecs: 20,
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
  },
  {
    id: "deepseek",
    name: "DeepSeek ASR",
    note: "可共用已配置的 DeepSeek Key",
    protocol: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "asr",
    models: ["asr"],
    needsKey: true,
    chunkSecs: 60,
    keyUrl: "https://platform.deepseek.com/api_keys",
  },
  {
    id: "groq",
    name: "Groq Whisper",
    note: "Whisper large-v3-turbo，极速英文转写",
    protocol: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    model: "whisper-large-v3-turbo",
    models: ["whisper-large-v3-turbo", "whisper-large-v3"],
    needsKey: true,
    chunkSecs: 600,
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "openai",
    name: "OpenAI Audio",
    note: "gpt-4o-mini-transcribe / whisper-1",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-transcribe",
    models: ["gpt-4o-mini-transcribe", "whisper-1", "gpt-4o-transcribe"],
    needsKey: true,
    chunkSecs: 600,
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "glm",
    name: "智谱 GLM-ASR",
    note: "中文口播识别",
    protocol: "openai",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    model: "glm-asr-2512",
    models: ["glm-asr-2512"],
    needsKey: true,
    chunkSecs: 25,
    keyUrl: "https://open.bigmodel.cn/usercenter/proj-mgmt/apikeys",
  },
  {
    id: "local-server",
    name: "本机识别服务",
    note: "OpenAI 兼容 /audio/transcriptions 本地接口",
    protocol: "openai",
    baseUrl: "http://127.0.0.1:8765/v1",
    model: "Qwen/Qwen3-ASR-0.6B",
    models: ["Qwen/Qwen3-ASR-0.6B", "whisper-1"],
    needsKey: false,
    chunkSecs: 60,
  },
];
