//! `AsrEngine` abstraction and CrispASR v0.8.55 runner (Qwen3-ASR + SenseVoice-Small + Silero VAD + CPU fallback).
use super::catalog::{vad_model_path, has_vad_model, ModelBackend, ResolvedModel};
use super::hardware::{
    cpu_fallback_variant, detect_hardware, find_any_crispasr, find_crispasr_variant, install_crispasr_variant,
    load_runtime_state, save_runtime_state, RuntimeState, RuntimeVariant, CRISPASR_VERSION,
};
use super::AsrContext;
use crate::model::Segment;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

pub struct LocalTranscribeRequest<'a> {
    pub data_dir: &'a Path,
    pub model: &'a ResolvedModel,
    pub wav_path: &'a Path,
    pub language: &'a str,
    pub ctx: &'a AsrContext,
    pub cancel: Arc<AtomicBool>,
}

pub struct LocalTranscribeOutcome {
    pub segments: Vec<Segment>,
    pub used_variant: RuntimeVariant,
    pub fell_back_to_cpu: bool,
}

pub fn build_crispasr_args(
    model: &ResolvedModel,
    variant: RuntimeVariant,
    device_index: Option<u32>,
    wav_path: &Path,
    out_prefix: &Path,
    vad_path: Option<&Path>,
    language: &str,
    ctx: &AsrContext,
    threads: usize,
) -> Vec<String> {
    let mut args = vec![
        "--backend".to_string(),
        model.backend.as_flag().to_string(),
        "-m".to_string(),
        model.path.to_string_lossy().into_owned(),
        "-f".to_string(),
        wav_path.to_string_lossy().into_owned(),
        "-oj".to_string(),
        "-np".to_string(),
        "-pp".to_string(),
        "-of".to_string(),
        out_prefix.to_string_lossy().into_owned(),
        "-t".to_string(),
        threads.to_string(),
    ];

    match variant {
        RuntimeVariant::Vulkan => {
            args.push("--gpu-backend".into());
            args.push("vulkan".into());
            if let Some(dev) = device_index {
                args.push("-dev".into());
                args.push(dev.to_string());
            }
        }
        RuntimeVariant::Cuda13 => {
            args.push("--gpu-backend".into());
            args.push("cuda".into());
            if let Some(dev) = device_index {
                args.push("-dev".into());
                args.push(dev.to_string());
            }
        }
        RuntimeVariant::Cpu | RuntimeVariant::CpuLegacy => {}
    }

    if let Some(vad) = vad_path {
        args.push("--vad".into());
        args.push("-vm".into());
        args.push(vad.to_string_lossy().into_owned());
        args.push("-vsd".into());
        args.push("300".into());
        args.push("-vmsd".into());
        args.push("25".into());
    } else {
        args.push("-ck".into());
        args.push("25".into());
    }

    match model.backend {
        ModelBackend::Qwen3 => {
            if language == "auto" {
                args.extend(["-l".into(), "auto".into(), "--lid-backend".into(), "off".into()]);
            } else {
                args.extend(["-l".into(), language.to_string()]);
            }
            if !ctx.background.is_empty() {
                args.push("--context".into());
                args.push(ctx.background.clone());
            }
            let words: Vec<&str> = ctx
                .hotwords
                .iter()
                .map(|w| w.trim())
                .filter(|w| !w.is_empty() && !w.contains(','))
                .take(60)
                .collect();
            if !words.is_empty() {
                args.push("--hotwords".into());
                args.push(words.join(","));
            }
        }
        ModelBackend::Sensevoice => {
            args.push("-l".into());
            args.push(if language.is_empty() { "auto".into() } else { language.to_string() });
        }
    }

    args
}

pub fn clean_sensevoice_tags(text: &str) -> String {
    static TAG: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"<\|[^|>]+\|>").unwrap());
    static SPACES: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"\s{2,}").unwrap());
    let stripped = TAG.replace_all(text, " ");
    SPACES.replace_all(stripped.trim(), " ").trim().to_string()
}

pub async fn run_crispasr_once(
    bin: &Path,
    variant: RuntimeVariant,
    device_index: Option<u32>,
    model: &ResolvedModel,
    wav: &Path,
    vad_path: Option<&Path>,
    language: &str,
    ctx: &AsrContext,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64),
) -> Result<Vec<Segment>> {
    let out = wav.with_extension("");
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    let args = build_crispasr_args(
        model,
        variant,
        device_index,
        wav,
        &out,
        vad_path,
        language,
        ctx,
        threads,
    );

    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(&args)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let mut child = cmd.spawn().context("无法启动 CrispASR 识别程序")?;
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();
    let mut tail: Vec<String> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                if let Some(c) = re.captures(&line) {
                    on_progress(c[1].parse::<f64>().unwrap_or(0.0) / 100.0);
                } else if !line.starts_with("ggml_") {
                    tail.push(line);
                    if tail.len() > 8 { tail.remove(0); }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = child.kill().await;
                    return Err(anyhow!("已取消"));
                }
            }
        }
    }
    let status = child.wait().await?;
    let json_path = out.with_extension("json");
    if !status.success() || !json_path.is_file() {
        let hint = tail.last().cloned().unwrap_or_else(|| format!("退出码 {:?}", status.code()));
        return Err(anyhow!("{} 识别失败：{hint}", model.display_name));
    }
    let v: serde_json::Value = serde_json::from_str(&tokio::fs::read_to_string(&json_path).await?)?;
    let _ = tokio::fs::remove_file(&json_path).await;
    let mut segs = Vec::new();
    for t in v["transcription"].as_array().into_iter().flatten() {
        let start = t["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
        let end = t["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
        let raw_text = t["text"].as_str().unwrap_or("").trim();
        let cleaned = if model.backend == ModelBackend::Sensevoice {
            clean_sensevoice_tags(raw_text)
        } else {
            raw_text.to_string()
        };
        if !cleaned.is_empty() {
            segs.extend(crate::transcript::split_timed(&cleaned, start, end));
        }
    }
    Ok(segs)
}

pub trait AsrEngine {
    fn transcribe<F>(
        &self,
        req: LocalTranscribeRequest<'_>,
        on_stage: F,
    ) -> impl std::future::Future<Output = Result<LocalTranscribeOutcome>> + Send
    where
        F: FnMut(&str, Option<f64>) + Send;
}

pub struct CrispAsrEngine;

impl AsrEngine for CrispAsrEngine {
    async fn transcribe<F>(&self, req: LocalTranscribeRequest<'_>, mut on_stage: F) -> Result<LocalTranscribeOutcome>
    where
        F: FnMut(&str, Option<f64>) + Send,
    {
        let state = load_runtime_state(req.data_dir);
        let (variant, bin): (RuntimeVariant, PathBuf) = find_any_crispasr(req.data_dir)
            .ok_or_else(|| anyhow!("尚未安装 CrispASR v{CRISPASR_VERSION} 推理程序，请先在「设置 › 字幕与转写」下载"))?;
        let device_index = if state.active_variant == Some(variant) {
            state.device_index
        } else {
            None
        };
        let vad_path = has_vad_model(req.data_dir).then(|| vad_model_path(req.data_dir));

        on_stage(&format!("{}（{}）转写中...", req.model.display_name, variant.label()), Some(0.0));
        match run_crispasr_once(
            &bin,
            variant,
            device_index,
            req.model,
            req.wav_path,
            vad_path.as_deref(),
            req.language,
            req.ctx,
            req.cancel.clone(),
            |p| on_stage(&format!("{} 识别中（{:.0}%）...", req.model.display_name, p * 100.0), Some(p)),
        )
        .await
        {
            Ok(segments) => Ok(LocalTranscribeOutcome {
                segments,
                used_variant: variant,
                fell_back_to_cpu: false,
            }),
            Err(err) if variant.is_gpu() && !req.cancel.load(Ordering::Relaxed) => {
                let hw = detect_hardware(false);
                let cpu_var = cpu_fallback_variant(hw.avx2);
                on_stage(
                    &format!("{} 异常，正在回退至 {} 继续转写...", variant.label(), cpu_var.label()),
                    Some(0.0),
                );
                let cpu_bin = if let Some(p) = find_crispasr_variant(req.data_dir, cpu_var) {
                    p
                } else {
                    install_crispasr_variant(req.data_dir, cpu_var, &req.cancel, |rec, _| {
                        on_stage(&format!("正在拉取 CPU 兜底引擎（{:.1} MB）...", rec as f64 / 1_048_576.0), Some(0.0));
                    })
                    .await?
                };
                let segments = run_crispasr_once(
                    &cpu_bin,
                    cpu_var,
                    None,
                    req.model,
                    req.wav_path,
                    vad_path.as_deref(),
                    req.language,
                    req.ctx,
                    req.cancel.clone(),
                    |p| on_stage(&format!("{}（CPU 回退）识别中（{:.0}%）...", req.model.display_name, p * 100.0), Some(p)),
                )
                .await?;
                let next_state = RuntimeState {
                    version: CRISPASR_VERSION.into(),
                    active_variant: Some(cpu_var),
                    preferred_variant: Some(variant),
                    device_index: None,
                    gpu_name: None,
                    verified: true,
                    fallback_reason: Some(format!("{} 运行异常（{err}），已自动回退至 {}", variant.label(), cpu_var.label())),
                    verified_at: Some(chrono::Utc::now().timestamp()),
                };
                let _ = save_runtime_state(req.data_dir, &next_state);
                Ok(LocalTranscribeOutcome {
                    segments,
                    used_variant: cpu_var,
                    fell_back_to_cpu: true,
                })
            }
            Err(err) => Err(err),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ctx() -> AsrContext {
        AsrContext {
            prompt: "prompt".into(),
            background: "Tech Podcast".into(),
            doubao: String::new(),
            hotwords: vec!["Anthropic".into(), "bad,word".into(), "OpenAI".into()],
        }
    }

    #[test]
    fn builds_qwen3_args_with_vad_dev_and_context() {
        let model = ResolvedModel {
            id: "qwen3-0.6b".into(),
            display_name: "Qwen3-ASR 0.6B".into(),
            path: PathBuf::from("models/qwen3-asr-0.6b-q4_k.gguf"),
            backend: ModelBackend::Qwen3,
            supports_context: true,
        };
        let args = build_crispasr_args(
            &model,
            RuntimeVariant::Vulkan,
            Some(1),
            Path::new("in.wav"),
            Path::new("in"),
            Some(Path::new("models/ggml-silero-v6.2.0.bin")),
            "auto",
            &ctx(),
            8,
        );
        assert!(args.windows(2).any(|w| w == ["--backend", "qwen3"]));
        assert!(args.windows(2).any(|w| w == ["--gpu-backend", "vulkan"]));
        assert!(args.windows(2).any(|w| w == ["-dev", "1"]));
        assert!(args.windows(2).any(|w| w == ["--lid-backend", "off"]));
        assert!(args.windows(2).any(|w| w == ["-vm", "models/ggml-silero-v6.2.0.bin"]));
        assert!(args.windows(2).any(|w| w == ["--context", "Tech Podcast"]));
        assert!(args.windows(2).any(|w| w == ["--hotwords", "Anthropic,OpenAI"]));
    }

    #[test]
    fn builds_sensevoice_args_without_qwen3_only_flags() {
        let model = ResolvedModel {
            id: "sensevoice-small".into(),
            display_name: "SenseVoice-Small".into(),
            path: PathBuf::from("models/sensevoice-small-q8_0.gguf"),
            backend: ModelBackend::Sensevoice,
            supports_context: false,
        };
        let args = build_crispasr_args(
            &model,
            RuntimeVariant::Cpu,
            None,
            Path::new("in.wav"),
            Path::new("in"),
            None,
            "auto",
            &ctx(),
            4,
        );
        assert!(args.windows(2).any(|w| w == ["--backend", "sensevoice"]));
        assert!(!args.iter().any(|a| a == "--gpu-backend" || a == "--context" || a == "--hotwords" || a == "--lid-backend"));
        assert!(args.windows(2).any(|w| w == ["-ck", "25"]));
    }

    #[test]
    fn strips_sensevoice_special_tags() {
        assert_eq!(
            clean_sensevoice_tags("<|zh|><|NEUTRAL|><|Speech|><|withitn|>今天天气不错。"),
            "今天天气不错。"
        );
        assert_eq!(clean_sensevoice_tags("<|en|> Hello   world! "), "Hello world!");
    }
}
