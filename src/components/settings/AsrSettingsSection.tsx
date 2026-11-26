import { useRef, useState } from "react";
import { Check, ChevronDown, Cpu, Download, ExternalLink, RefreshCw, Square } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { api, type AsrModelEntry, type AsrVariant } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { CLOUD_ASR_PRESETS } from "../../lib/providers";
import { resolveLocalModelId, useStore } from "../../store";
import { KeyStatusRow } from "./KeyStatusRow";

const VARIANT_LABEL: Record<AsrVariant, string> = {
  vulkan: "Vulkan GPU",
  cuda13: "CUDA 13 GPU",
  cpu: "CPU (AVX2)",
  "cpu-legacy": "CPU Legacy",
};

const TIER_LABEL: Record<AsrModelEntry["tier"], string> = {
  fast: "轻量快转",
  balanced: "均衡推荐",
  accurate: "高配精转",
};

function formatSizeMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb} MB`;
}

function cleanGpuName(name?: string | null): string {
  if (!name) return "";
  return name.replace(/\s*\((NVIDIA|AMD|Intel)\)\s*$/i, "").trim();
}

export function AsrSettingsSection() {
  const { asrStatus, asrKeyStatus, prefs, refreshAsrStatus, saveAsrKey, savePrefs } = useStore(
    useShallow((s) => ({
      asrStatus: s.asrStatus,
      asrKeyStatus: s.asrKeyStatus,
      prefs: s.prefs,
      refreshAsrStatus: s.refreshAsrStatus,
      saveAsrKey: s.saveAsrKey,
      savePrefs: s.savePrefs,
    })),
  );

  const [dlTarget, setDlTarget] = useState<string | null>(null);
  const [dlInfo, setDlInfo] = useState<{ stage: string; pct?: number; received?: number; total?: number } | null>(null);
  const [dlMsg, setDlMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const dlAbortRef = useRef<AbortController | null>(null);

  const [cloudOpen, setCloudOpen] = useState(false);
  const [asrId, setAsrId] = useState("doubao");
  const [asrKeyInput, setAsrKeyInput] = useState("");
  const [asrMsg, setAsrMsg] = useState<string | null>(null);

  const hw = asrStatus?.hardware;
  const appleSilicon = hw?.os === "macos" && hw?.arch === "aarch64";
  const variantLabel = (v: AsrVariant) => (appleSilicon && v === "cpu" ? "Apple Silicon (Metal)" : VARIANT_LABEL[v]);
  const rt = asrStatus?.runtime;
  const models = asrStatus?.models ?? [];
  const activeLocalId = resolveLocalModelId(prefs.asrChoice, asrStatus);
  const activeAsr = CLOUD_ASR_PRESETS.find((p) => p.id === asrId) ?? CLOUD_ASR_PRESETS[0];

  const startDownload = async (opts: { modelId?: string; variant?: string; runtimeOnly?: boolean; label: string }) => {
    if (dlTarget || probing) return;
    const ctrl = new AbortController();
    dlAbortRef.current = ctrl;
    setDlTarget(opts.runtimeOnly ? `runtime:${opts.variant ?? "auto"}` : opts.modelId ?? "default");
    setDlMsg(null);
    setDlInfo({ stage: `准备下载 ${opts.label}...` });
    try {
      await api.downloadAsrModel({
        requestId: crypto.randomUUID(),
        modelId: opts.modelId,
        variant: opts.variant,
        runtimeOnly: opts.runtimeOnly,
        signal: ctrl.signal,
        onProgress: (p) => setDlInfo({ stage: p.stage, pct: p.pct, received: p.received, total: p.total }),
      });
      await refreshAsrStatus();
      if (opts.modelId) {
        savePrefs({ asrChoice: `local:${opts.modelId}` });
      }
      setDlMsg({ ok: true, text: `${opts.label} 已安装并校验就绪` });
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setDlMsg({ ok: false, text: err instanceof Error ? err.message : "下载或校验失败" });
      }
    } finally {
      dlAbortRef.current = null;
      setDlTarget(null);
      setDlInfo(null);
    }
  };

  const switchVariant = async (variant: string, forceHardware = false) => {
    if (dlTarget || probing) return;
    setProbing(true);
    setDlMsg(null);
    try {
      const res = await api.probeAsrRuntime({ variant, forceHardware });
      if (res.needsDownload && res.variant) {
        setProbing(false);
        await startDownload({
          variant: res.variant,
          runtimeOnly: true,
          label: `CrispASR ${variantLabel(res.variant)}（约 ${res.approxMb ?? 20} MB）`,
        });
        return;
      }
      await refreshAsrStatus();
      setDlMsg({ ok: true, text: "硬件探测与试跑校验完成" });
    } catch (err) {
      setDlMsg({ ok: false, text: err instanceof Error ? err.message : "硬件试跑校验失败" });
    } finally {
      setProbing(false);
    }
  };

  const curatedModels = models.filter((m) => !m.id.startsWith("file:"));
  const extraModels = models.filter((m) => m.id.startsWith("file:"));
  const hasSenseVoice = curatedModels.some((m) => m.backend === "sensevoice");

  const cpuFallbackVar: AsrVariant = appleSilicon ? "cpu" : hw?.avx2 === false ? "cpu-legacy" : "cpu";
  const variantOptions: { key: string; label: string }[] = [{ key: "auto", label: "自动推荐" }];
  if (hw?.hasDiscreteGpu) variantOptions.push({ key: "vulkan", label: "Vulkan GPU" });
  if (hw?.hasNvidia) variantOptions.push({ key: "cuda13", label: "CUDA 13 (544 MB)" });
  variantOptions.push({
    key: cpuFallbackVar,
    label: appleSilicon ? "Apple Silicon (Metal)" : hw?.avx2 === false ? "纯 CPU Legacy" : "纯 CPU",
  });

  const currentVariantKey = rt?.activeVariant ?? rt?.preferredVariant ?? hw?.recommendedVariant ?? "auto";
  const configuredCloudCount = CLOUD_ASR_PRESETS.filter((p) => p.needsKey && asrKeyStatus[p.id]).length;
  const gpuText = cleanGpuName(rt?.gpuName);

  return (
    <div className="settings-pane">
      <div className="settings-head">
        <div>
          <h4>字幕与转写</h4>
          <p>默认优先本机离线转写（音频不出本机），无外文字幕时自动接管识别</p>
        </div>
      </div>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">
            本机硬件与推理引擎
            <span className="muted small" style={{ fontWeight: 400 }}>
              CrispASR {rt?.version ?? "v0.8.55"}
            </span>
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void switchVariant(currentVariantKey, true)}
            disabled={!!dlTarget || probing}
          >
            <RefreshCw size={13} className={probing ? "spin" : ""} /> {probing ? "探测中…" : "重新探测"}
          </button>
        </div>

        <div className="s-card">
          <div className="s-row">
            <div className="s-row-meta">
              <span className="s-row-label row-tight">
                <Cpu size={14} className="muted" />
                <span>{rt?.activeVariant ? variantLabel(rt.activeVariant) : "推理引擎未安装"}</span>
                {gpuText && <span className="muted small">· {gpuText}</span>}
              </span>
              <span className="s-row-desc">
                {hw?.summary ?? "正在探测 CPU / GPU 硬件..."}
                {asrStatus?.vadReady ? " · Silero VAD 已就绪" : " · 首次下载将附带 864 KB Silero VAD"}
              </span>
              {rt?.fallbackReason && <span className="error-text small">{rt.fallbackReason}</span>}
            </div>
            <span className={`pill ${rt?.activeVariant ? (rt.verified ? "ok" : "warn") : ""}`}>
              {rt?.activeVariant ? (rt.verified ? "试跑已通过" : "待模型试跑") : "未安装"}
            </span>
          </div>

          <div className="s-row asr-variant-row">
            {hw?.windowsArm64 ? (
              <span className="s-row-desc">Windows ARM64 首版不提供离线 CrispASR 二进制，请展开下方云端识别。</span>
            ) : (
              <>
                <span className="s-row-label">加速模式</span>
                <div className="seg-control" role="radiogroup" aria-label="CrispASR 加速模式">
                  {variantOptions.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      role="radio"
                      aria-checked={currentVariantKey === opt.key}
                      className={currentVariantKey === opt.key ? "on" : ""}
                      disabled={!!dlTarget || probing}
                      onClick={() => void switchVariant(opt.key)}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="s-group">
        <div className="s-group-head">
          <span className="s-group-title">
            本地离线模型
            <span className="muted small" style={{ fontWeight: 400 }}>
              按硬件分层推荐，支持 VAD 停顿切句与时间戳跳转
            </span>
          </span>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void refreshAsrStatus()}
            disabled={!!dlTarget}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        </div>

        <div className="s-card">
          {curatedModels.map((m) => {
            const isSelected =
              prefs.asrChoice === `local:${m.id}` || (!prefs.asrChoice.startsWith("cloud:") && activeLocalId === m.id);
            const isBusyThis = dlTarget === m.id;
            return (
              <div key={m.id} className={`asr-model-row ${isSelected ? "on" : ""}`}>
                <div className="asr-model-left">
                  <span className={`asr-radio ${isSelected ? "on" : ""}`} aria-hidden />
                  <div className="asr-model-meta">
                    <div className="row-tight">
                      <span className="asr-model-title">{m.name}</span>
                      <span className="pill">{formatSizeMb(m.sizeMb)}</span>
                      {m.recommended ? (
                        <span className="pill ok">本机推荐</span>
                      ) : (
                        <span className="pill">{TIER_LABEL[m.tier]}</span>
                      )}
                    </div>
                    <p className="s-row-desc">{m.note}</p>
                  </div>
                </div>

                {isBusyThis ? (
                  <button type="button" className="btn sm danger" onClick={() => dlAbortRef.current?.abort()}>
                    <Square size={12} /> 取消
                  </button>
                ) : m.installed ? (
                  <div className="row-tight">
                    {!asrStatus?.engineReady && (
                      <button
                        type="button"
                        className="btn sm"
                        disabled={!!dlTarget || probing || hw?.windowsArm64}
                        onClick={() => void startDownload({ modelId: m.id, label: m.name })}
                      >
                        <Download size={13} /> 补装引擎
                      </button>
                    )}
                    {isSelected ? (
                      <span className="pill ok">
                        <Check size={12} /> 当前默认
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => savePrefs({ asrChoice: `local:${m.id}` })}
                      >
                        设为默认
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn sm"
                    disabled={!!dlTarget || probing || hw?.windowsArm64}
                    onClick={() => void startDownload({ modelId: m.id, label: m.name })}
                  >
                    <Download size={13} /> 下载安装
                  </button>
                )}
              </div>
            );
          })}

          {extraModels.map((m) => {
            const isSelected = prefs.asrChoice === `local:${m.id}`;
            return (
              <div key={m.id} className={`asr-model-row ${isSelected ? "on" : ""}`}>
                <div className="asr-model-left">
                  <span className={`asr-radio ${isSelected ? "on" : ""}`} aria-hidden />
                  <div className="asr-model-meta">
                    <div className="row-tight">
                      <span className="asr-model-title">{m.name}</span>
                      <span className="pill">{formatSizeMb(m.sizeMb)}</span>
                      {m.from && <span className="pill">{m.from}</span>}
                    </div>
                    <p className="s-row-desc">{m.note}</p>
                  </div>
                </div>
                {isSelected ? (
                  <span className="pill ok">
                    <Check size={12} /> 当前默认
                  </span>
                ) : (
                  <button type="button" className="btn sm" onClick={() => savePrefs({ asrChoice: `local:${m.id}` })}>
                    设为默认
                  </button>
                )}
              </div>
            );
          })}

          {dlInfo && (
            <div className="asr-dl-box">
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
        </div>

        {dlMsg && <p className={dlMsg.ok ? "ok-text small" : "error-text small"}>{dlMsg.text}</p>}
        {hasSenseVoice && (
          <p className="s-foot-note">
            注：SenseVoice-Small 遵循 FunASR Model License v1.1（按需在线下载，使用需保留 FunAudioLLM/SenseVoiceSmall 署名）。
          </p>
        )}
      </section>

      <section className="s-group">
        <div className="s-disclosure">
          <button
            type="button"
            className="s-disclosure-head"
            aria-expanded={cloudOpen}
            onClick={() => setCloudOpen((v) => !v)}
          >
            <div className="s-row-meta">
              <span className="s-row-label">云端语音识别 API Key（按需备选）</span>
              <span className="s-row-desc">仅当需要在单集转写弹窗中临时选用云端识别时配置，不填不影响本机离线转写</span>
            </div>
            <div className="s-disclosure-right">
              <span>{configuredCloudCount > 0 ? `已配 ${configuredCloudCount} 个` : "未配置"}</span>
              <ChevronDown size={14} className={cloudOpen ? "flip" : ""} />
            </div>
          </button>

          {cloudOpen && (
            <div className="s-disclosure-body">
              <div className="s-tab-row" role="tablist" aria-label="云端语音识别服务商">
                {CLOUD_ASR_PRESETS.map((p) => {
                  const active = asrId === p.id;
                  const configured = p.needsKey && !!asrKeyStatus[p.id];
                  return (
                    <button
                      key={p.id}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      className={`s-tab-pill ${active ? "on" : ""}`}
                      onClick={() => {
                        setAsrId(p.id);
                        setAsrKeyInput("");
                        setAsrMsg(null);
                      }}
                    >
                      {configured && <span className="s-tab-dot" aria-hidden />}
                      <span>{p.name}</span>
                    </button>
                  );
                })}
              </div>

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
          )}
        </div>
      </section>
    </div>
  );
}
