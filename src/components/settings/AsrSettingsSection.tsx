import { useRef, useState } from "react";
import { Check, Cpu, Download, ExternalLink, RefreshCw, Square } from "lucide-react";
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

  const cpuFallbackVar: AsrVariant = appleSilicon ? "cpu" : hw?.avx2 === false ? "cpu-legacy" : "cpu";
  const variantOptions: { key: string; label: string }[] = [{ key: "auto", label: "自动推荐" }];
  if (hw?.hasDiscreteGpu) variantOptions.push({ key: "vulkan", label: "Vulkan GPU" });
  if (hw?.hasNvidia) variantOptions.push({ key: "cuda13", label: "CUDA 13 (544 MB)" });
  variantOptions.push({
    key: cpuFallbackVar,
    label: appleSilicon ? "Apple Silicon (Metal)" : hw?.avx2 === false ? "纯 CPU Legacy" : "纯 CPU",
  });

  const currentVariantKey = rt?.activeVariant ?? rt?.preferredVariant ?? hw?.recommendedVariant ?? "auto";

  return (
    <>
      <section className="setup-block">
        <div className="row-between">
          <div>
            <p className="setup-title">本机硬件与推理引擎（CrispASR {rt?.version ?? "v0.8.55"}）</p>
            <p className="muted small">
              {hw?.summary ?? "正在探测 CPU / GPU 硬件..."}
              {asrStatus?.vadReady ? " · Silero VAD 已就绪" : " · 首次下载将附带 864 KB Silero VAD"}
            </p>
          </div>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void switchVariant(currentVariantKey, true)}
            disabled={!!dlTarget || probing}
          >
            <RefreshCw size={13} className={probing ? "spin" : ""} /> {probing ? "试跑探测中…" : "重新探测"}
          </button>
        </div>

        <div className="asr-hw-card">
          <div className="row-between">
            <span className="row-tight small">
              <Cpu size={14} className="muted" />
              <span>
                当前后端：
                <strong>{rt?.activeVariant ? variantLabel(rt.activeVariant) : "未安装"}</strong>
                {rt?.deviceIndex != null && rt.gpuName ? ` · -dev ${rt.deviceIndex}（${rt.gpuName}）` : ""}
              </span>
            </span>
            <span className={`pill ${rt?.activeVariant ? (rt.verified ? "ok" : "warn") : ""}`}>
              {rt?.activeVariant ? (rt.verified ? "试跑已通过" : "待模型试跑") : "未安装"}
            </span>
          </div>

          {rt?.fallbackReason && <p className="error-text small">{rt.fallbackReason}</p>}

          {hw?.windowsArm64 ? (
            <p className="muted small">Windows ARM64 首版不提供离线 CrispASR 二进制，请使用下方云端语音识别。</p>
          ) : (
            <div className="asr-variant-row">
              <span className="muted small">加速模式：</span>
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
            </div>
          )}
        </div>
      </section>

      <section className="setup-block">
        <div className="row-between">
          <div>
            <p className="setup-title">三档本地离线模型（音频不出本机）</p>
            <p className="muted small">按硬件分层推荐，支持 VAD 停顿切句与 [mm:ss] 跳转；不含 Whisper 与 imatrix 量化</p>
          </div>
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void refreshAsrStatus()}
            disabled={!!dlTarget}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        </div>

        <div className="asr-tier-list">
          {curatedModels.map((m) => {
            const isSelected = prefs.asrChoice === `local:${m.id}` || (!prefs.asrChoice.startsWith("cloud:") && activeLocalId === m.id);
            const isBusyThis = dlTarget === m.id;
            return (
              <div key={m.id} className={`model-item ${isSelected ? "on" : ""}`}>
                <div className="model-item-meta">
                  <div className="row-tight">
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    <span className="pill">{formatSizeMb(m.sizeMb)}</span>
                    <span className="pill">{TIER_LABEL[m.tier]}</span>
                    {m.recommended && <span className="pill ok">本机推荐</span>}
                  </div>
                  <p className="muted small">{m.note}</p>
                  {m.backend === "sensevoice" && <p className="asr-license">{m.license}</p>}
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
                    <button
                      type="button"
                      className={`btn sm ${isSelected ? "" : "primary"}`}
                      disabled={isSelected}
                      onClick={() => savePrefs({ asrChoice: `local:${m.id}` })}
                    >
                      {isSelected ? (
                        <>
                          <Check size={13} /> 默认使用
                        </>
                      ) : (
                        "设为默认"
                      )}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn sm primary"
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
              <div key={m.id} className={`model-item ${isSelected ? "on" : ""}`}>
                <div className="model-item-meta">
                  <div className="row-tight">
                    <span style={{ fontWeight: 600 }}>{m.name}</span>
                    <span className="pill">{formatSizeMb(m.sizeMb)}</span>
                    {m.from && <span className="pill">{m.from}</span>}
                  </div>
                  <p className="muted small">{m.note}</p>
                </div>
                <button
                  type="button"
                  className={`btn sm ${isSelected ? "" : "primary"}`}
                  disabled={isSelected}
                  onClick={() => savePrefs({ asrChoice: `local:${m.id}` })}
                >
                  {isSelected ? (
                    <>
                      <Check size={13} /> 默认使用
                    </>
                  ) : (
                    "设为默认"
                  )}
                </button>
              </div>
            );
          })}
        </div>

        {dlInfo && (
          <div className="stack" style={{ marginTop: 6 }}>
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
  );
}
