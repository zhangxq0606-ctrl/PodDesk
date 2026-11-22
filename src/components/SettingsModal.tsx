import { useEffect, useMemo, useRef, useState } from "react";
import {
  Captions,
  Check,
  ChevronDown,
  Copy,
  Download,
  ExternalLink,
  Globe,
  Keyboard,
  Loader2,
  RefreshCw,
  Search,
  Sparkles,
  Square,
  TerminalSquare,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, type AgentModel, type FoundAgent, type ProviderConfig } from "../lib/api";
import { formatBytes } from "../lib/format";
import { AGENT_META, CLOUD_ASR_PRESETS, CORE_PRESETS } from "../lib/providers";
import { useStore, type SettingsSection, type ThemeMode } from "../store";

const CLI_STATUS: Record<FoundAgent["login"], { text: string; tone: "ok" | "warn" | "idle" }> = {
  ready: { text: "可用", tone: "ok" },
  needsLogin: { text: "需登录", tone: "warn" },
  unknown: { text: "待验证", tone: "idle" },
};

const RECOMMENDED_API = new Set(["deepseek", "siliconflow", "openrouter", "ollama"]);
const agentModelsCache = new Map<string, AgentModel[]>();

function formatModelLabel(id: string, name?: string): { primary: string; secondary: string | null } {
  const cleanId = id.trim();
  const cleanName = name?.trim();
  if (!cleanName || cleanName.toLowerCase() === cleanId.toLowerCase()) {
    return { primary: cleanName || cleanId, secondary: null };
  }
  return { primary: cleanName, secondary: cleanId };
}

const SHORTCUTS: [string, string][] = [
  ["Space", "播放 / 暂停"],
  ["← / →", "后退 10 秒 / 前进 10 秒"],
  ["[ / ]", "减速 / 加速播放"],
  ["M", "静音 / 取消静音"],
  ["C", "切换双语 / 中文 / 原文 / 关闭"],
  ["Ctrl + L", "聚焦顶部搜索 / 链接框"],
  ["Ctrl + F", "在当前文字稿内搜索"],
  ["Ctrl + B", "展开 / 收起左侧栏"],
  ["Ctrl + \\", "展开 / 收起右侧栏"],
];

function AgentDetailPanel({
  agent,
  provider,
  isDefault,
  onSetDefault,
}: {
  agent: FoundAgent;
  provider: ProviderConfig;
  isDefault: boolean;
  onSetDefault: () => void;
}) {
  const { setAgentLoginState, saveProviderOverride } = useStore(
    useShallow((s) => ({
      setAgentLoginState: s.setAgentLoginState,
      saveProviderOverride: s.saveProviderOverride,
    })),
  );

  const meta = AGENT_META[agent.kind];
  const st = CLI_STATUS[agent.login];

  const [busy, setBusy] = useState<"probe" | "test" | "models" | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [fetched, setFetched] = useState<AgentModel[] | null>(() => agentModelsCache.get(agent.kind) ?? null);
  const [modelNames, setModelNames] = useState<Record<string, string>>(() =>
    Object.fromEntries((agentModelsCache.get(agent.kind) ?? []).map((m) => [m.id, m.name])),
  );
  const [modelsErr, setModelsErr] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState("");
  const [extraModel, setExtraModel] = useState("");

  useEffect(() => {
    const cached = agentModelsCache.get(agent.kind) ?? null;
    setResult(null);
    setFetched(cached);
    setModelNames(Object.fromEntries((cached ?? []).map((m) => [m.id, m.name])));
    setModelsErr(null);
    setModelFilter("");
    setExtraModel("");
    setCopied(false);
  }, [agent.kind]);

  const picked = provider.models ?? [];
  const candidateIds = useMemo(() => {
    const raw = Array.from(
      new Set([
        ...(fetched?.map((m) => m.id) ?? []),
        ...meta.defaultModels,
        ...picked,
        ...(provider.model ? [provider.model] : []),
      ]),
    ).filter(Boolean);
    const pickedSet = new Set(picked);
    return [...raw.filter((id) => pickedSet.has(id)), ...raw.filter((id) => !pickedSet.has(id))];
  }, [fetched, meta.defaultModels, picked, provider.model]);

  const shownIds = useMemo(() => {
    const q = modelFilter.trim().toLowerCase();
    if (!q) return candidateIds;
    return candidateIds.filter((id) => `${id} ${modelNames[id] ?? ""}`.toLowerCase().includes(q));
  }, [candidateIds, modelFilter, modelNames]);

  const handleProbe = async () => {
    if (busy) return;
    setBusy("probe");
    setResult(null);
    try {
      const res = await api.probeAgent(agent.kind);
      await setAgentLoginState(agent.kind, res.login);
      if (res.login === "ready") {
        setResult({ ok: true, text: "已检测到有效登录，可直接使用 ✓" });
      } else if (res.login === "needsLogin") {
        setResult({ ok: false, text: `尚未登录，请在终端运行「${meta.loginCmd}」完成登录` });
      } else {
        setResult({ ok: false, text: "无法确认登录态，可尝试点击「试一下」直接验证" });
      }
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "检测失败" });
    } finally {
      setBusy(null);
    }
  };

  const handleTest = async () => {
    if (busy) return;
    setBusy("test");
    setResult(null);
    const t0 = performance.now();
    try {
      const reply = await api.streamChat({
        requestId: crypto.randomUUID(),
        provider: {
          id: agent.kind,
          protocol: "cli",
          baseUrl: "",
          model: provider.model || "",
        },
        system: "Reply with one short word.",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 1200,
      });
      await setAgentLoginState(agent.kind, "ready");
      const sec = ((performance.now() - t0) / 1000).toFixed(1);
      setResult({ ok: true, text: `可用 ✓ ${reply.trim().slice(0, 18) || "ok"}（${sec} 秒）` });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : "连接失败" });
    } finally {
      setBusy(null);
    }
  };

  const handleFetchModels = async () => {
    if (busy) return;
    setBusy("models");
    setModelsErr(null);
    try {
      const res = await api.getAgentModels(agent.kind);
      agentModelsCache.set(agent.kind, res.models);
      setFetched(res.models);
      setModelNames((prev) => ({
        ...prev,
        ...Object.fromEntries(res.models.map((m) => [m.id, m.name])),
      }));
      if (res.models.length === 0) {
        setModelsErr(`${meta.name} 未返回子模型列表，可在下方手动添加。`);
      }
    } catch (err) {
      setModelsErr(err instanceof Error ? err.message : "读取模型列表失败");
    } finally {
      setBusy(null);
    }
  };

  const togglePick = (id: string) => {
    const next = picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id];
    void saveProviderOverride(agent.kind, { models: next });
  };

  const addExtra = () => {
    const m = extraModel.trim();
    if (!m) return;
    if (!picked.includes(m)) {
      void saveProviderOverride(agent.kind, { models: [...picked, m] });
    }
    setExtraModel("");
  };

  const copyLogin = async () => {
    try {
      await navigator.clipboard.writeText(meta.loginCmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard error */
    }
  };

  return (
    <div className="provider-form">
      <div className="ms-head">
        <div>
          <p className="ms-title">
            <span>{meta.name}</span>
            <span className={`pill ${st.tone === "ok" ? "ok" : st.tone === "warn" ? "warn" : ""}`}>{st.text}</span>
          </p>
          <p className="muted small">
            {meta.vendor}
            {agent.version ? ` · ${agent.version}` : ""} · 免 API Key
          </p>
        </div>
        <button
          type="button"
          className={`btn sm ${isDefault ? "" : "primary"}`}
          disabled={isDefault}
          onClick={onSetDefault}
        >
          {isDefault ? (
            <>
              <Check size={13} /> 当前默认
            </>
          ) : (
            "设为默认"
          )}
        </button>
      </div>

      {agent.login === "needsLogin" && (
        <div className="ms-callout">
          <TerminalSquare size={15} />
          <div>
            <p className="small">尚未登录。打开终端执行下方命令并完成授权后，点「检测登录」或「试一下」即可：</p>
            <div className="ms-cmd">
              <code>{meta.loginCmd}</code>
              <button type="button" className="icon-btn sm" onClick={() => void copyLogin()} title="复制命令">
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="row-actions">
        <button type="button" className="btn sm" disabled={busy !== null} onClick={() => void handleTest()}>
          {busy === "test" ? <Loader2 size={13} className="spin" /> : null}
          <span>试一下</span>
        </button>
        {agent.login !== "ready" && (
          <button type="button" className="btn sm ghost" disabled={busy !== null} onClick={() => void handleProbe()}>
            {busy === "probe" ? <Loader2 size={13} className="spin" /> : null}
            <span>检测登录</span>
          </button>
        )}
        {result && <span className={result.ok ? "ok-text small" : "error-text small"}>{result.text}</span>}
        <span className="spacer" />
        <a className="link-btn" href={meta.installUrl} target="_blank" rel="noreferrer">
          官网说明 <ExternalLink size={11} />
        </a>
      </div>

      <label>
        <span>默认子模型</span>
        <select
          value={provider.model || ""}
          onChange={(e) => void saveProviderOverride(agent.kind, { model: e.target.value })}
        >
          <option value="">跟随 {meta.name} 自身默认设置（推荐）</option>
          {candidateIds.map((m) => (
            <option key={m} value={m}>
              {formatModelLabel(m, modelNames[m]).primary}
            </option>
          ))}
        </select>
      </label>

      <div className="agent-models">
        <div className="agent-models-h">
          <span className="row-tight">
            <span>问答选单里可选的子模型</span>
            {picked.length > 0 && <span className="pill">已选 {picked.length}</span>}
          </span>
          <span className="row-tight">
            {picked.length > 0 && (
              <button
                type="button"
                className="link-btn"
                onClick={() => void saveProviderOverride(agent.kind, { models: [] })}
              >
                清空
              </button>
            )}
            <button type="button" className="link-btn" disabled={busy !== null} onClick={() => void handleFetchModels()}>
              {busy === "models" ? <Loader2 size={12} className="spin" /> : <RefreshCw size={12} />}
              <span>{fetched ? "重新读取" : "读取支持的模型"}</span>
            </button>
          </span>
        </div>

        {candidateIds.length > 6 && (
          <div className="model-filter">
            <Search size={13} />
            <input
              value={modelFilter}
              onChange={(e) => setModelFilter(e.target.value)}
              placeholder="筛选模型名或 ID…"
              spellCheck={false}
            />
            {modelFilter && (
              <button
                type="button"
                className="icon-btn sm"
                onClick={() => setModelFilter("")}
                aria-label="清空筛选"
              >
                <X size={12} />
              </button>
            )}
          </div>
        )}

        {candidateIds.length > 0 ? (
          <div className="agent-models-list">
            {shownIds.length === 0 ? (
              <p className="muted small">没有匹配的模型</p>
            ) : (
              shownIds.map((m) => {
                const lbl = formatModelLabel(m, modelNames[m]);
                return (
                  <label key={m} className="check model-opt" title={m}>
                    <input type="checkbox" checked={picked.includes(m)} onChange={() => togglePick(m)} />
                    <span className="model-opt-text">
                      <span>{lbl.primary}</span>
                      {lbl.secondary && <span className="model-opt-id">{lbl.secondary}</span>}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        ) : (
          <p className="muted small">点击右上角「读取支持的模型」或手动添加模型名，即可在问答区快速切换。</p>
        )}
        {modelsErr && <p className="muted small">{modelsErr}</p>}

        <div className="key-row">
          <input
            value={extraModel}
            onChange={(e) => setExtraModel(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addExtra();
              }
            }}
            placeholder="输入模型 ID 回车添加"
            spellCheck={false}
          />
          <button type="button" className="btn sm" disabled={!extraModel.trim()} onClick={addExtra}>
            添加
          </button>
        </div>
      </div>

      <p className="muted small">
        字幕与问题仅交给本机 {meta.name} 处理；它在空目录中运行，不能读写你的文件或执行命令。
      </p>
    </div>
  );
}

function AiSettingsSection() {
  const {
    agents,
    verifiedAgents,
    chatProviderId,
    providerOverrides,
    keyStatus,
    prefs,
    targetId,
    refreshAgents,
    selectChatProvider,
    saveProviderOverride,
    saveApiKey,
    savePrefs,
    getAllProviders,
    isProviderReady,
  } = useStore(
    useShallow((s) => ({
      agents: s.agents,
      verifiedAgents: s.verifiedAgents,
      chatProviderId: s.chatProviderId,
      providerOverrides: s.providerOverrides,
      keyStatus: s.keyStatus,
      prefs: s.prefs,
      targetId: s.settingsTargetId,
      refreshAgents: s.refreshAgents,
      selectChatProvider: s.selectChatProvider,
      saveProviderOverride: s.saveProviderOverride,
      saveApiKey: s.saveApiKey,
      savePrefs: s.savePrefs,
      getAllProviders: s.getAllProviders,
      isProviderReady: s.isProviderReady,
    })),
  );

  const allProviders = useMemo(
    () => getAllProviders(),
    [agents, verifiedAgents, providerOverrides, getAllProviders],
  );
  const [editId, setEditId] = useState<string>(() => targetId || chatProviderId || agents[0]?.kind || "deepseek");
  const [detecting, setDetecting] = useState(false);
  const [moreApiOpen, setMoreApiOpen] = useState(false);

  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [modelInput, setModelInput] = useState("");
  const [keyInput, setKeyInput] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [testingConn, setTestingConn] = useState(false);
  const [connMsg, setConnMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const splitInitial =
    prefs.translateEngine === "google" || (!!prefs.translateProviderId && prefs.translateProviderId !== "follow");
  const [divisionOpen, setDivisionOpen] = useState(splitInitial);

  useEffect(() => {
    if (!targetId) return;
    setEditId(targetId);
    useStore.setState({ settingsTargetId: null });
  }, [targetId]);

  useEffect(() => {
    if (!allProviders.some((p) => p.id === editId)) {
      setEditId(chatProviderId || allProviders[0]?.id || "deepseek");
    }
  }, [allProviders, editId, chatProviderId]);

  useEffect(() => {
    const preset = CORE_PRESETS.find((p) => p.id === editId);
    if (!preset) return;
    const ov = providerOverrides[editId];
    setBaseUrlInput(ov?.baseUrl ?? preset.baseUrl);
    setModelInput(ov?.model ?? preset.model);
    setKeyInput("");
    setConnMsg(null);
    setShowAdvanced(preset.id === "custom");
  }, [editId, providerOverrides]);

  const sortedAgents = useMemo(() => {
    const rank = { ready: 1, needsLogin: 2, unknown: 3 } as const;
    return [...agents].sort((a, b) => {
      const aUse = a.kind === chatProviderId ? 0 : rank[a.login];
      const bUse = b.kind === chatProviderId ? 0 : rank[b.login];
      return aUse - bUse;
    });
  }, [agents, chatProviderId]);

  const { coreApi, extraApi } = useMemo(() => {
    const isCore = (p: ProviderConfig) =>
      p.id === chatProviderId ||
      p.id === editId ||
      !p.needsKey ||
      !!keyStatus[p.id] ||
      RECOMMENDED_API.has(p.id);
    return {
      coreApi: CORE_PRESETS.filter(isCore),
      extraApi: CORE_PRESETS.filter((p) => !isCore(p)),
    };
  }, [chatProviderId, editId, keyStatus]);

  const selectedProvider = allProviders.find((p) => p.id === editId) ?? allProviders[0];
  const selectedAgent =
    selectedProvider?.protocol === "cli" ? agents.find((a) => a.kind === selectedProvider.id) : undefined;
  const activePreset = CORE_PRESETS.find((p) => p.id === editId);

  const readyProviders = useMemo(
    () => allProviders.filter((p) => isProviderReady(p)),
    [allProviders, keyStatus, isProviderReady],
  );
  const chatBase = allProviders.find((p) => p.id === chatProviderId);
  const trTargetId =
    prefs.translateProviderId && prefs.translateProviderId !== "follow" ? prefs.translateProviderId : chatProviderId;
  const trTarget = allProviders.find((p) => p.id === trTargetId);
  const trSubModels = useMemo(() => {
    if (!trTarget) return [];
    if (trTarget.protocol === "cli") return trTarget.models ?? [];
    return Array.from(new Set([trTarget.model, ...(trTarget.models ?? [])])).filter(Boolean);
  }, [trTarget]);

  const mergedApiModels = (preset: ProviderConfig, m: string) => {
    const clean = m.trim();
    const curList = providerOverrides[preset.id]?.models ?? preset.models ?? [];
    if (!clean || curList.includes(clean)) return curList;
    return [clean, ...curList];
  };

  const handleSaveModelMeta = async () => {
    if (!activePreset) return;
    await saveProviderOverride(editId, {
      baseUrl: baseUrlInput.trim(),
      model: modelInput.trim(),
      models: mergedApiModels(activePreset, modelInput),
    });
    setConnMsg({ ok: true, text: "接口与模型名已保存" });
  };

  const handleTestModel = async () => {
    if (testingConn || !activePreset) return;
    setTestingConn(true);
    setConnMsg(null);
    try {
      await saveProviderOverride(editId, {
        baseUrl: baseUrlInput.trim(),
        model: modelInput.trim(),
        models: mergedApiModels(activePreset, modelInput),
      });
      if (keyInput.trim()) {
        await saveApiKey(editId, keyInput.trim());
        setKeyInput("");
      }
      const reply = await api.streamChat({
        requestId: crypto.randomUUID(),
        provider: {
          id: editId,
          protocol: activePreset.protocol,
          baseUrl: baseUrlInput.trim(),
          model: modelInput.trim(),
        },
        system: "Reply with one short word.",
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 120,
      });
      setConnMsg({ ok: true, text: `连接可用 ✓ (${reply.trim().slice(0, 24) || "ok"})` });
    } catch (err) {
      setConnMsg({ ok: false, text: err instanceof Error ? err.message : "测试连接失败" });
    } finally {
      setTestingConn(false);
    }
  };

  const googleMode = prefs.translateEngine === "google";
  const splitTranslate = googleMode || (!!prefs.translateProviderId && prefs.translateProviderId !== "follow");
  const trSummaryName = googleMode
    ? "谷歌免费直连"
    : trTarget
      ? `${trTarget.name}${prefs.translateModel ? ` · ${prefs.translateModel.split("/").pop()}` : ""}`
      : "未设置";

  return (
    <div className="ai-settings">
      <div className="ai-summary-bar">
        {splitTranslate ? (
          <span>
            问答：<strong>{chatBase?.name ?? "未设置"}</strong> · 字幕翻译：<strong>{trSummaryName}</strong>
          </span>
        ) : (
          <span>
            当前默认：<strong>{chatBase?.name ?? "未设置"}</strong>
            <span className="muted"> · 管问答、导读与字幕翻译</span>
          </span>
        )}
        {!isProviderReady(chatBase) && <span className="ai-summary-warn">当前默认模型尚未验证或未配 Key</span>}
      </div>

      <div className="provider-split">
        <div className="provider-list">
          <div className="ai-group-h">
            <span>本机 AI · 免 Key</span>
            <button
              type="button"
              className="icon-btn sm"
              title="重新检测本机 CLI"
              disabled={detecting}
              onClick={() => {
                setDetecting(true);
                void refreshAgents().finally(() => setDetecting(false));
              }}
            >
              <RefreshCw size={12} className={detecting ? "spin" : ""} />
            </button>
          </div>
          {sortedAgents.length === 0 ? (
            <p className="muted small ai-list-empty">未检测到本机 CLI</p>
          ) : (
            sortedAgents.map((a) => {
              const p = allProviders.find((x) => x.id === a.kind);
              const st = CLI_STATUS[p?.login ?? a.login];
              const isDef = chatProviderId === a.kind;
              return (
                <button
                  key={a.kind}
                  type="button"
                  className={`provider-item ${editId === a.kind ? "on" : ""}`}
                  onClick={() => setEditId(a.kind)}
                >
                  <span className="pi-main">
                    <span className="clamp1">{AGENT_META[a.kind]?.name ?? a.kind}</span>
                    <small>{isDef ? "默认" : st.text}</small>
                  </span>
                  <span className={`ms-dot ${st.tone}`} />
                </button>
              );
            })
          )}

          <div className="ai-group-h" style={{ marginTop: 8 }}>
            <span>API 模型 · 按量付费</span>
          </div>
          {coreApi.map((p) => {
            const configured = !p.needsKey || !!keyStatus[p.id];
            const isDef = chatProviderId === p.id;
            const sub = isDef ? "默认" : !p.needsKey ? "免 Key" : configured ? "已配 Key" : "未配置";
            return (
              <button
                key={p.id}
                type="button"
                className={`provider-item ${editId === p.id ? "on" : ""}`}
                onClick={() => setEditId(p.id)}
              >
                <span className="pi-main">
                  <span className="clamp1">{p.name}</span>
                  <small>{sub}</small>
                </span>
                <span className={`ms-dot ${configured ? "ok" : "idle"}`} />
              </button>
            );
          })}
          {extraApi.length > 0 && (
            <>
              <button
                type="button"
                className="link-btn ai-more-btn"
                onClick={() => setMoreApiOpen((v) => !v)}
              >
                <ChevronDown size={12} className={moreApiOpen ? "flip" : ""} />
                <span>{moreApiOpen ? "收起其他 API" : `更多 API 服务商（${extraApi.length}）`}</span>
              </button>
              {moreApiOpen &&
                extraApi.map((p) => {
                  const configured = !p.needsKey || !!keyStatus[p.id];
                  const isDef = chatProviderId === p.id;
                  const sub = isDef ? "默认" : !p.needsKey ? "免 Key" : configured ? "已配 Key" : "未配置";
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`provider-item ${editId === p.id ? "on" : ""}`}
                      onClick={() => setEditId(p.id)}
                    >
                      <span className="pi-main">
                        <span className="clamp1">{p.name}</span>
                        <small>{sub}</small>
                      </span>
                      <span className={`ms-dot ${configured ? "ok" : "idle"}`} />
                    </button>
                  );
                })}
            </>
          )}
        </div>

        <div className="ai-detail">
          {selectedAgent && selectedProvider ? (
            <AgentDetailPanel
              agent={selectedAgent}
              provider={selectedProvider}
              isDefault={chatProviderId === selectedAgent.kind}
              onSetDefault={() => void selectChatProvider(selectedAgent.kind)}
            />
          ) : activePreset ? (
            <div className="provider-form">
              <div className="ms-head">
                <div>
                  <p className="ms-title">{activePreset.name}</p>
                  <p className="muted small">
                    {activePreset.needsKey ? "API Key 仅存本机系统钥匙串" : "本机运行服务，无需 API Key"}
                  </p>
                </div>
                <div className="row-tight">
                  {activePreset.keyUrl && (
                    <a className="link-btn" href={activePreset.keyUrl} target="_blank" rel="noreferrer">
                      申请 Key <ExternalLink size={11} />
                    </a>
                  )}
                  <button
                    type="button"
                    className={`btn sm ${chatProviderId === activePreset.id ? "" : "primary"}`}
                    disabled={chatProviderId === activePreset.id}
                    onClick={() => void selectChatProvider(activePreset.id)}
                  >
                    {chatProviderId === activePreset.id ? (
                      <>
                        <Check size={13} /> 当前默认
                      </>
                    ) : (
                      "设为默认"
                    )}
                  </button>
                </div>
              </div>

              {activePreset.needsKey ? (
                <KeyStatusRow
                  has={!!keyStatus[editId]}
                  value={keyInput}
                  onValue={setKeyInput}
                  placeholder={`输入 ${activePreset.name} API Key`}
                  onSave={async () => {
                    await saveApiKey(editId, keyInput.trim());
                    setKeyInput("");
                    setConnMsg({ ok: true, text: "API Key 已安全保存至系统钥匙串" });
                  }}
                  onDelete={async () => {
                    await saveApiKey(editId, "");
                    setConnMsg({ ok: true, text: "已清除保存的 API Key" });
                  }}
                />
              ) : (
                <p className="muted small">确保本机 Ollama 已启动即可直接测试或设为默认。</p>
              )}

              <div className="row-actions">
                <button
                  type="button"
                  className="btn sm"
                  disabled={testingConn}
                  onClick={() => void handleTestModel()}
                >
                  {testingConn ? <Loader2 size={13} className="spin" /> : null} 测试连接
                </button>
                {connMsg && (
                  <span className={connMsg.ok ? "ok-text small" : "error-text small"}>{connMsg.text}</span>
                )}
                <span className="spacer" />
                <button type="button" className="link-btn" onClick={() => setShowAdvanced((v) => !v)}>
                  高级设置 <ChevronDown size={12} className={showAdvanced ? "flip" : ""} />
                </button>
              </div>

              {showAdvanced && (
                <div className="stack" style={{ paddingTop: 8, borderTop: "1px solid var(--line)" }}>
                  <label>
                    <span>接口地址 (Base URL)</span>
                    <input
                      value={baseUrlInput}
                      onChange={(e) => setBaseUrlInput(e.target.value)}
                      placeholder="https://.../v1"
                    />
                  </label>
                  <label>
                    <span>模型名称</span>
                    <input
                      value={modelInput}
                      onChange={(e) => setModelInput(e.target.value)}
                      placeholder="如 deepseek-chat"
                    />
                  </label>
                  {activePreset.models && activePreset.models.length > 0 && (
                    <div className="model-chips">
                      {activePreset.models.map((m) => (
                        <button
                          key={m}
                          type="button"
                          className={`chip sm ${modelInput === m ? "on" : ""}`}
                          onClick={() => setModelInput(m)}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="row-end">
                    <button type="button" className="btn sm primary" onClick={() => void handleSaveModelMeta()}>
                      保存接口与模型名
                    </button>
                  </div>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>

      <div>
        <button type="button" className="link-btn" onClick={() => setDivisionOpen((v) => !v)}>
          <ChevronDown size={13} className={divisionOpen ? "flip" : ""} />
          <span>问答和翻译分别用不同模型</span>
        </button>

        {divisionOpen && (
          <div className="ai-adv-box">
            <div className="two">
              <label>
                <span>默认问答与导读</span>
                <select value={chatProviderId} onChange={(e) => void selectChatProvider(e.target.value)}>
                  {!readyProviders.some((p) => p.id === chatProviderId) && chatBase && (
                    <option value={chatBase.id}>{chatBase.name}（待验证/未配置）</option>
                  )}
                  {readyProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                <span>字幕批量翻译</span>
                <select
                  value={googleMode ? "google" : prefs.translateProviderId || "follow"}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "google") {
                      savePrefs({ translateEngine: "google", translateProviderId: "follow", translateModel: "" });
                    } else {
                      savePrefs({ translateEngine: "auto", translateProviderId: val, translateModel: "" });
                    }
                  }}
                >
                  <option value="follow">跟随默认模型（无就绪模型时自动回退谷歌）</option>
                  <option value="google">始终用谷歌免费直连（需可访问 Google，走本机代理）</option>
                  {prefs.translateProviderId &&
                    prefs.translateProviderId !== "follow" &&
                    !readyProviders.some((p) => p.id === prefs.translateProviderId) &&
                    trTarget && (
                      <option value={trTarget.id}>指定：{trTarget.name}（待验证/未配置）</option>
                    )}
                  {readyProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      指定：{p.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {!googleMode && prefs.translateProviderId && prefs.translateProviderId !== "follow" && trTarget && (
              <label>
                <span>翻译专用子模型（可将翻译拆给更轻快的免费模型）</span>
                <select
                  value={prefs.translateModel || ""}
                  onChange={(e) => savePrefs({ translateModel: e.target.value })}
                >
                  <option value="">跟随「{trTarget.name}」的默认模型</option>
                  {trSubModels.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {!googleMode && (
              <div className="reading-row">
                <div>
                  <span>翻译方式</span>
                  <p className="muted small">
                    {prefs.translateQuality === "best"
                      ? "翻完再通读润色一遍，更自然，耗时约加倍"
                      : "一遍结合上下文与术语表翻完，速度最快"}
                  </p>
                </div>
                <div className="seg-control">
                  <button
                    type="button"
                    className={prefs.translateQuality === "fast" ? "on" : ""}
                    onClick={() => savePrefs({ translateQuality: "fast" })}
                  >
                    快速
                  </button>
                  <button
                    type="button"
                    className={prefs.translateQuality === "best" ? "on" : ""}
                    onClick={() => savePrefs({ translateQuality: "best" })}
                  >
                    精翻
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function KeyStatusRow({
  has,
  value,
  onValue,
  onSave,
  onDelete,
  placeholder,
}: {
  has: boolean;
  value: string;
  onValue: (v: string) => void;
  onSave: () => Promise<void>;
  onDelete: () => Promise<void>;
  placeholder: string;
}) {
  const [editing, setEditing] = useState(false);

  if (has && !editing) {
    return (
      <div className="key-saved">
        <span className="ok-text small">
          <Check size={14} /> 已保存至系统钥匙串 (••••••••••••)
        </span>
        <span className="spacer" />
        <button type="button" className="btn sm" onClick={() => setEditing(true)}>
          更换
        </button>
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => void onDelete()}
        >
          清除
        </button>
      </div>
    );
  }

  return (
    <div className="key-row">
      <input
        type="password"
        value={value}
        onChange={(e) => onValue(e.target.value)}
        placeholder={placeholder}
        autoFocus={editing}
      />
      <button
        type="button"
        className="btn sm primary"
        disabled={!value.trim()}
        onClick={() => {
          void onSave().then(() => setEditing(false));
        }}
      >
        保存
      </button>
      {editing && (
        <button
          type="button"
          className="btn sm ghost"
          onClick={() => {
            onValue("");
            setEditing(false);
          }}
        >
          取消
        </button>
      )}
    </div>
  );
}

export function SettingsModal() {
  const {
    open,
    section,
    health,
    asrKeyStatus,
    asrStatus,
    hasCookies,
    prefs,
    closeSettings,
    openSettings,
    refreshAsrStatus,
    saveAsrKey,
    saveCookies,
    savePrefs,
    bootstrap,
  } = useStore(
    useShallow((s) => ({
      open: s.settingsOpen,
      section: s.settingsSection,
      health: s.health,
      asrKeyStatus: s.asrKeyStatus,
      asrStatus: s.asrStatus,
      hasCookies: s.hasCookies,
      prefs: s.prefs,
      closeSettings: s.closeSettings,
      openSettings: s.openSettings,
      refreshAsrStatus: s.refreshAsrStatus,
      saveAsrKey: s.saveAsrKey,
      saveCookies: s.saveCookies,
      savePrefs: s.savePrefs,
      bootstrap: s.bootstrap,
    })),
  );

  const [dlBusy, setDlBusy] = useState(false);
  const [dlInfo, setDlInfo] = useState<{ stage: string; pct?: number; received?: number; total?: number } | null>(null);
  const [dlMsg, setDlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const dlAbortRef = useRef<AbortController | null>(null);

  const [asrId, setAsrId] = useState("doubao");
  const [asrKeyInput, setAsrKeyInput] = useState("");
  const [asrMsg, setAsrMsg] = useState<string | null>(null);

  const [proxyInput, setProxyInput] = useState("");
  const [proxyMsg, setProxyMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cookiesInput, setCookiesInput] = useState("");
  const [cookieMsg, setCookieMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setProxyInput(health?.configuredProxy ?? "");
    setProxyMsg(null);
    setDlMsg(null);
    setAsrMsg(null);
    setCookieMsg(null);
    void refreshAsrStatus().catch(() => {});
  }, [open, health?.configuredProxy, refreshAsrStatus]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeSettings();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, closeSettings]);

  if (!open) return null;

  const NAV: [SettingsSection, string, LucideIcon][] = [
    ["asr", "字幕与转写", Captions],
    ["ai", "AI 模型与 Agent", Sparkles],
    ["network", "网络与风控", Globe],
    ["reading", "阅读与快捷键", Keyboard],
  ];

  const activeAsr = CLOUD_ASR_PRESETS.find((p) => p.id === asrId) ?? CLOUD_ASR_PRESETS[0];

  const handleDownloadQwen = async () => {
    if (dlBusy) return;
    const ctrl = new AbortController();
    dlAbortRef.current = ctrl;
    setDlBusy(true);
    setDlMsg(null);
    setDlInfo({ stage: "准备下载 CrispASR 与 Qwen3-ASR 0.6B..." });
    try {
      await api.downloadAsrModel({
        requestId: crypto.randomUUID(),
        modelId: "qwen3-asr",
        signal: ctrl.signal,
        onProgress: (p) => setDlInfo({ stage: p.stage, pct: p.pct, received: p.received, total: p.total }),
      });
      await refreshAsrStatus();
      setDlMsg({ ok: true, text: "离线 Qwen3-ASR 0.6B 与 CrispASR 引擎已就绪" });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setDlMsg({ ok: false, text: err instanceof Error ? err.message : "下载失败" });
      }
    } finally {
      dlAbortRef.current = null;
      setDlBusy(false);
      setDlInfo(null);
    }
  };

  const handleSaveProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    setProxyMsg(null);
    try {
      const res = await api.saveSettings({ proxy: proxyInput.trim() });
      setProxyMsg({
        ok: true,
        text: res.effectiveProxy ? `已保存，生效代理：${res.effectiveProxy}` : "已保存为直连模式",
      });
      await bootstrap();
    } catch (err) {
      setProxyMsg({ ok: false, text: err instanceof Error ? err.message : "代理保存失败" });
    }
  };

  return (
    <div className="modal-back" onMouseDown={(e) => e.target === e.currentTarget && closeSettings()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-label="设置">
        <div className="modal-head">
          <h3>设置</h3>
          <button type="button" className="icon-btn" onClick={closeSettings} aria-label="关闭">
            <X size={17} />
          </button>
        </div>

        <div className="modal-body">
          <div className="settings">
            <nav className="settings-nav">
              {NAV.map(([k, label, Icon]) => (
                <button
                  key={k}
                  type="button"
                  className={section === k ? "on" : ""}
                  onClick={() => openSettings(k)}
                >
                  <Icon size={15} />
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="settings-body">
              {section === "asr" && (
                <>
                  <section className="setup-block">
                    <div className="row-between">
                      <p className="setup-title">本机离线转写（Qwen3-ASR 0.6B）</p>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => void refreshAsrStatus()}
                        disabled={dlBusy}
                      >
                        <RefreshCw size={13} /> 刷新状态
                      </button>
                    </div>
                    <div className="model-item on">
                      <div style={{ flex: 1 }}>
                        <p style={{ fontWeight: 600 }}>Qwen3-ASR 0.6B + CrispASR</p>
                        <p className="muted small">约 960 MB · 音频不出本机 · 中英文混说均准确</p>
                      </div>
                      <span className={`pill ${asrStatus?.engineReady && asrStatus?.modelReady ? "ok" : ""}`}>
                        {asrStatus?.engineReady && asrStatus?.modelReady ? "已就绪" : "未下载"}
                      </span>
                      {dlBusy ? (
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => dlAbortRef.current?.abort()}
                        >
                          <Square size={12} /> 取消
                        </button>
                      ) : !(asrStatus?.engineReady && asrStatus?.modelReady) ? (
                        <button type="button" className="btn sm primary" onClick={() => void handleDownloadQwen()}>
                          <Download size={13} /> 一键下载安装
                        </button>
                      ) : null}
                    </div>
                    {dlInfo && (
                      <div className="stack" style={{ marginTop: 8 }}>
                        <div className="row-between small muted">
                          <span>{dlInfo.stage}</span>
                          {dlInfo.total ? (
                            <span>
                              {formatBytes(dlInfo.received)} / {formatBytes(dlInfo.total)} (
                              {Math.round(((dlInfo.received ?? 0) / dlInfo.total) * 100)}%)
                            </span>
                          ) : typeof dlInfo.pct === "number" ? (
                            <span>{Math.round(dlInfo.pct * 100)}%</span>
                          ) : null}
                        </div>
                        <div className="bar">
                          <div
                            style={{
                              width: `${
                                dlInfo.total
                                  ? Math.max(3, ((dlInfo.received ?? 0) / dlInfo.total) * 100)
                                  : typeof dlInfo.pct === "number"
                                    ? Math.max(3, dlInfo.pct * 100)
                                    : 20
                              }%`,
                            }}
                          />
                        </div>
                      </div>
                    )}
                    {dlMsg && <p className={dlMsg.ok ? "ok-text small" : "error-text small"}>{dlMsg.text}</p>}
                  </section>

                  <section className="setup-block">
                    <p className="setup-title">云端语音识别 API Key（按需可选）</p>
                    <div className="provider-tabs">
                      {CLOUD_ASR_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          className={`chip ${asrId === p.id ? "on" : ""}`}
                          onClick={() => {
                            setAsrId(p.id);
                            setAsrKeyInput("");
                            setAsrMsg(null);
                          }}
                        >
                          {p.name}
                        </button>
                      ))}
                    </div>
                    <div className="provider-form">
                      <div className="row-between">
                        <span className="muted small">{activeAsr.note}</span>
                        {activeAsr.keyUrl && (
                          <a className="link-btn" href={activeAsr.keyUrl} target="_blank" rel="noreferrer">
                            申请 Key <ExternalLink size={11} />
                          </a>
                        )}
                      </div>
                      {activeAsr.needsKey ? (
                        <KeyStatusRow
                          has={!!asrKeyStatus[activeAsr.id]}
                          value={asrKeyInput}
                          onValue={setAsrKeyInput}
                          placeholder={`输入 ${activeAsr.name} API Key`}
                          onSave={async () => {
                            await saveAsrKey(activeAsr.id, asrKeyInput.trim());
                            setAsrKeyInput("");
                            setAsrMsg("云端识别 Key 已更新");
                          }}
                          onDelete={async () => {
                            await saveAsrKey(activeAsr.id, "");
                            setAsrMsg("已清除该 Key");
                          }}
                        />
                      ) : (
                        <p className="muted small">该服务免 Key，接口地址：{activeAsr.baseUrl}</p>
                      )}
                      {asrMsg && <p className="ok-text small">{asrMsg}</p>}
                    </div>
                  </section>
                </>
              )}

              {section === "ai" && <AiSettingsSection />}

              {section === "network" && (
                <>
                  <section className="setup-block">
                    <p className="setup-title">本机代理</p>
                    <p className="muted small">
                      当前生效代理：<code>{health?.effectiveProxy || "无（直连）"}</code>
                    </p>
                    <form className="key-row" onSubmit={handleSaveProxy}>
                      <input
                        value={proxyInput}
                        onChange={(e) => setProxyInput(e.target.value)}
                        placeholder="留空自动跟随系统代理，或填 http://127.0.0.1:7897"
                      />
                      <button type="submit" className="btn sm primary">
                        保存
                      </button>
                    </form>
                    {proxyMsg && <p className={proxyMsg.ok ? "ok-text small" : "error-text small"}>{proxyMsg.text}</p>}
                  </section>

                  <section className="setup-block">
                    <div className="row-between">
                      <p className="setup-title">YouTube 防风控 cookies.txt（按需粘贴）</p>
                      <span className={`pill ${hasCookies ? "ok" : ""}`}>
                        {hasCookies ? "已保存" : "未配置"}
                      </span>
                    </div>
                    <p className="muted small">
                      仅当 yt-dlp 遇到 YouTube 人机校验时使用；仅保存于本机数据目录，绝不回显明文。
                    </p>
                    <textarea
                      className="import-textarea"
                      rows={4}
                      value={cookiesInput}
                      onChange={(e) => setCookiesInput(e.target.value)}
                      placeholder="# Netscape HTTP Cookie File ..."
                    />
                    <div className="row-end">
                      {hasCookies && (
                        <button
                          type="button"
                          className="btn sm"
                          onClick={() =>
                            void saveCookies("").then(() => {
                              setCookiesInput("");
                              setCookieMsg({ ok: true, text: "已清除本地 Cookie" });
                            })
                          }
                        >
                          <Trash2 size={13} /> 清除已存 Cookie
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={!cookiesInput.trim()}
                        onClick={() =>
                          void saveCookies(cookiesInput).then((saved) => {
                            setCookiesInput("");
                            setCookieMsg({ ok: true, text: saved ? "Cookie 已保存" : "已清除 Cookie" });
                          })
                        }
                      >
                        保存 Cookie
                      </button>
                    </div>
                    {cookieMsg && <p className={cookieMsg.ok ? "ok-text small" : "error-text small"}>{cookieMsg.text}</p>}
                  </section>
                </>
              )}

              {section === "reading" && (
                <>
                  <section className="setup-block">
                    <p className="setup-title">外观与阅读体验</p>
                    <div className="reading-preview">
                      <p className="zh">最重要的是，学习的速度要比世界变化的速度更快。</p>
                      <p className="orig">The most important thing is to keep learning faster than the world changes.</p>
                    </div>

                    <div className="reading-row">
                      <span>主题模式</span>
                      <div className="seg-control">
                        {(
                          [
                            ["system", "跟随系统"],
                            ["light", "浅色暖纸"],
                            ["dark", "深色护眼"],
                          ] as [ThemeMode, string][]
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            type="button"
                            className={prefs.theme === k ? "on" : ""}
                            onClick={() => savePrefs({ theme: k })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="reading-row">
                      <span>字幕字号</span>
                      <div className="seg-control">
                        {(
                          [
                            ["s", "小"],
                            ["m", "标准"],
                            ["l", "大"],
                          ] as const
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            type="button"
                            className={prefs.subtitleSize === k ? "on" : ""}
                            onClick={() => savePrefs({ subtitleSize: k })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <div className="reading-row">
                      <span>问答与导读字号</span>
                      <div className="seg-control">
                        {(
                          [
                            ["m", "标准"],
                            ["l", "大"],
                          ] as const
                        ).map(([k, label]) => (
                          <button
                            key={k}
                            type="button"
                            className={prefs.chatSize === k ? "on" : ""}
                            onClick={() => savePrefs({ chatSize: k })}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>

                    <label className="check">
                      <input
                        type="checkbox"
                        checked={prefs.audioNextLine}
                        onChange={(e) => savePrefs({ audioNextLine: e.target.checked })}
                      />
                      <span>纯音频舞台提前预告下一句字幕</span>
                    </label>
                  </section>

                  <section className="setup-block">
                    <p className="setup-title">全局快捷键</p>
                    <div className="shortcut-grid">
                      {SHORTCUTS.map(([keys, desc]) => (
                        <div key={keys} className="shortcut-row">
                          <kbd>{keys}</kbd>
                          <span>{desc}</span>
                        </div>
                      ))}
                    </div>
                  </section>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
