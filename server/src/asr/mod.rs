//! Local ASR subsystem: 3-tier model catalog, CrispASR v0.8.55 hardware probe & CPU fallback,
//! `AsrEngine` execution, pure-Rust `symphonia` 16 kHz decoding, and `yt-dlp` fallback.
pub mod catalog;
pub mod engine;
pub mod hardware;
pub mod media;
pub mod ytdlp;

use crate::net;
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use tokio::io::AsyncWriteExt;

pub use catalog::{download_model, download_vad_model, has_vad_model, list_models, normalize_model_id, resolve_model, spec};
pub use engine::{AsrEngine, CrispAsrEngine, LocalTranscribeRequest};
pub use hardware::{
    detect_hardware, find_any_crispasr, find_crispasr_variant, install_crispasr_variant, installed_variants,
    load_runtime_state, probe_and_verify, RuntimeVariant, CRISPASR_VERSION,
};
pub use media::{decode_16k_mono, write_wav};
pub use ytdlp::{
    find_ytdlp, has_cookies, save_cookies, streams, with_ytdlp, youtube_audio, youtube_stream_url, ytdlp_version,
    StreamInfo,
};

#[derive(Default, Clone, Debug)]
pub struct AsrContext {
    pub prompt: String,
    pub background: String,
    pub doubao: String,
    pub hotwords: Vec<String>,
}

pub fn build_asr_context(title: &str, show: &str, notes: &str, ctx_json: Option<&str>, language: &str) -> AsrContext {
    let mut hotwords: Vec<String> = Vec::new();
    if let Some(raw) = ctx_json {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            for s in v["speakers"].as_array().into_iter().flatten() {
                for key in ["zh", "name"] {
                    if let Some(w) = s[key].as_str().map(str::trim).filter(|w| !w.is_empty()) {
                        hotwords.push(w.to_string());
                    }
                }
            }
            for t in v["terms"].as_array().into_iter().flatten() {
                for key in ["zh", "src"] {
                    if let Some(w) = t[key].as_str().map(str::trim).filter(|w| !w.is_empty()) {
                        hotwords.push(w.to_string());
                    }
                }
            }
        }
    }
    let meta = crate::asr_context::Meta {
        title: title.into(),
        show: show.into(),
        description: notes.into(),
        chapters: vec![],
    };
    let bg = crate::asr_context::background(&meta, crate::asr_context::BUDGET_QWEN);
    let prompt = crate::asr_context::prompt(&meta, crate::asr_context::BUDGET_PROMPT);
    let fits = |text: &str| language == "auto" || crate::asr_context::fits_language(text, language);
    AsrContext {
        background: if fits(&bg) { bg } else { String::new() },
        prompt: if fits(&prompt) { prompt } else { String::new() },
        doubao: crate::asr_context::doubao(&meta, &hotwords),
        hotwords,
    }
}

/// Streams `url` into `dest` via a `.part` file with HTTP Range resume on transient stream drops.
pub async fn download(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    download_attempts(url, dest, cancel, 4, progress).await
}

/// Tries candidate URLs in order (2 attempts each when multiple, 4 when single),
/// stopping immediately on cancellation and returning an actionable hint if all fail.
pub async fn download_from_candidates(
    urls: &[String],
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    if urls.is_empty() {
        return Err(anyhow!("未提供有效的下载地址"));
    }
    let attempts = if urls.len() > 1 { 2 } else { 4 };
    let mut last_err = anyhow!("下载失败");
    for url in urls {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        match download_attempts(url, dest, cancel, attempts, &mut progress).await {
            Ok(()) => return Ok(()),
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => last_err = e,
        }
    }
    Err(anyhow!(
        "所有下载源均失败（{last_err}）。如国内无代理访问 GitHub 受限，请在「设置 › 网络」配置代理或自定义 GitHub 镜像后重试"
    ))
}

async fn download_attempts(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    max_attempts: u32,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    let part = dest.with_extension("part");
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let _ = tokio::fs::remove_file(&part).await;

    let mut received = 0u64;
    let mut total: Option<u64> = None;
    let mut last_err = anyhow!("下载失败");

    for attempt in 0..max_attempts {
        if cancel.load(Ordering::Relaxed) {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(anyhow!("已取消"));
        }
        if attempt > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(700 * attempt as u64)).await;
        }

        let mut req = net::client().get(url);
        if received > 0 {
            req = req.header(reqwest::header::RANGE, format!("bytes={received}-"));
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_err = e.into();
                continue;
            }
        };

        let status = res.status();
        let is_partial = status == reqwest::StatusCode::PARTIAL_CONTENT;
        if !status.is_success() {
            if status.as_u16() == 416 && total.is_some_and(|t| received >= t) {
                break;
            }
            return Err(anyhow!("下载失败（HTTP {}）", status.as_u16()));
        }

        let mut file = if is_partial && received > 0 {
            if total.is_none() {
                total = res.content_length().map(|rem| received + rem);
            }
            tokio::fs::OpenOptions::new().create(true).append(true).open(&part).await?
        } else {
            received = 0;
            total = res.content_length();
            tokio::fs::File::create(&part).await?
        };

        let mut stream = res.bytes_stream();
        let mut last = std::time::Instant::now();
        let mut stream_err: Option<anyhow::Error> = None;
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                drop(file);
                let _ = tokio::fs::remove_file(&part).await;
                return Err(anyhow!("已取消"));
            }
            match chunk {
                Ok(bytes) => {
                    file.write_all(&bytes).await?;
                    received += bytes.len() as u64;
                    if last.elapsed().as_millis() > 200 {
                        progress(received, total);
                        last = std::time::Instant::now();
                    }
                }
                Err(e) => {
                    stream_err = Some(e.into());
                    break;
                }
            }
        }
        file.flush().await?;
        drop(file);

        if let Some(e) = stream_err {
            last_err = e;
            continue;
        }
        if let Some(t) = total {
            if received < t {
                last_err = anyhow!("下载不完整（{received}/{t}）");
                continue;
            }
        }
        tokio::fs::rename(&part, dest).await?;
        progress(received, total);
        return Ok(());
    }

    let _ = tokio::fs::remove_file(&part).await;
    Err(last_err)
}
