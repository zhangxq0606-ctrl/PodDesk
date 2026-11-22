//! Cloud ASR proxy: Doubao Flash, DeepSeek ASR, and OpenAI-compatible `/audio/transcriptions`.
//! Only invoked when the user explicitly selects a cloud ASR provider and supplies a key (`asr.<id>`).
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Result};
use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const RATE: u32 = 16_000;

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CloudAsr {
    pub id: String,
    /// "doubao" | "deepseek" | "openai"
    pub protocol: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub chunk_secs: Option<f64>,
    #[serde(default)]
    pub needs_key: Option<bool>,
}

pub fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

fn client() -> reqwest::Client {
    net::client()
}

async fn recognize_chunk(
    cfg: &CloudAsr,
    key: &str,
    wav: Vec<u8>,
    offset: f64,
    len: f64,
    language: &str,
    ctx: &crate::asr::AsrContext,
) -> Result<Vec<Segment>> {
    let base = cfg.base_url.trim().trim_end_matches('/');
    let mut last = String::new();
    for attempt in 0..3 {
        let res = if cfg.protocol == "deepseek" {
            let part = reqwest::multipart::Part::bytes(wav.clone())
                .file_name("input.wav")
                .mime_str("audio/wav")?;
            client()
                .post(format!("{base}/v1/tools/asr"))
                .bearer_auth(key)
                .multipart(reqwest::multipart::Form::new().part("file", part))
                .timeout(std::time::Duration::from_secs(180))
                .send()
                .await
        } else if cfg.protocol == "doubao" {
            let audio = base64::engine::general_purpose::STANDARD.encode(&wav);
            client()
                .post(format!("{base}/auc/bigmodel/recognize/flash"))
                .header("X-Api-Key", key)
                .header("X-Api-Resource-Id", "volc.bigasr.auc_turbo")
                .header("X-Api-Request-Id", uuid::Uuid::new_v4().to_string())
                .header("X-Api-Sequence", "-1")
                .json(&{
                    let mut body = json!({
                        "user": { "uid": "podcast-desk" },
                        "audio": { "data": audio },
                        "request": {
                            "model_name": if cfg.model.is_empty() { "bigmodel" } else { cfg.model.as_str() },
                            "enable_itn": true,
                            "enable_punc": true,
                            "show_utterances": true
                        }
                    });
                    if !ctx.doubao.is_empty() {
                        body["request"]["corpus"] = json!({ "context": ctx.doubao });
                    }
                    body
                })
                .timeout(std::time::Duration::from_secs(180))
                .send()
                .await
        } else {
            let part = reqwest::multipart::Part::bytes(wav.clone())
                .file_name("chunk.wav")
                .mime_str("audio/wav")?;
            let mut form = reqwest::multipart::Form::new()
                .text("model", cfg.model.clone())
                .text("response_format", "verbose_json")
                .text("timestamp_granularities[]", "segment");
            if language != "auto" {
                form = form.text("language", language.to_string());
            }
            if !ctx.prompt.is_empty() && (base.contains("openai.com") || base.contains("groq.com")) {
                form = form.text("prompt", ctx.prompt.clone());
            }
            let b = client()
                .post(format!("{base}/audio/transcriptions"))
                .multipart(form.part("file", part))
                .timeout(std::time::Duration::from_secs(180));
            (if key.is_empty() { b } else { b.bearer_auth(key) }).send().await
        };

        match res {
            Err(err) => {
                last = err.to_string();
            }
            Ok(r) => {
                let status = r.status();
                let code = r
                    .headers()
                    .get("X-Api-Status-Code")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let msg = r
                    .headers()
                    .get("X-Api-Message")
                    .and_then(|v| v.to_str().ok())
                    .unwrap_or("")
                    .to_string();
                let body = r.text().await.unwrap_or_default();
                if !status.is_success() {
                    let detail: String = body.chars().take(200).collect();
                    if status.as_u16() == 401 || status.as_u16() == 403 {
                        return Err(anyhow!("识别服务拒绝了请求：Key 无效或没有权限（{detail}）"));
                    }
                    if status.is_client_error() && status.as_u16() != 429 {
                        return Err(anyhow!("识别服务出错（{status}）：{detail}"));
                    }
                    last = format!("{status} {detail}");
                } else if cfg.protocol == "deepseek" {
                    let v: Value = serde_json::from_str(&body).map_err(|_| anyhow!("DeepSeek 返回了无法解析的结果"))?;
                    if let Some(err) = v.get("error") {
                        return Err(anyhow!(
                            "DeepSeek 识别失败：{}",
                            err["message"].as_str().unwrap_or(&err.to_string())
                        ));
                    }
                    let text = v["text"].as_str().unwrap_or("").trim().to_string();
                    return Ok(if text.is_empty() {
                        vec![]
                    } else {
                        crate::transcript::split_timed(&text, offset, offset + len)
                    });
                } else if cfg.protocol == "doubao" {
                    if code == "20000003" {
                        return Ok(vec![]);
                    }
                    if !code.is_empty() && code != "20000000" {
                        if code.starts_with("55") {
                            last = format!("{code} {msg}");
                        } else {
                            return Err(anyhow!("豆包识别失败（{code}）：{msg}"));
                        }
                    } else {
                        let v: Value = serde_json::from_str(&body).map_err(|_| anyhow!("豆包返回了无法解析的结果"))?;
                        let utts = v["result"]["utterances"].as_array().cloned().unwrap_or_default();
                        return Ok(utts
                            .iter()
                            .filter_map(|u| {
                                let text = u["text"].as_str()?.trim().to_string();
                                (!text.is_empty()).then(|| Segment {
                                    start: offset + u["start_time"].as_f64().unwrap_or(0.0) / 1000.0,
                                    end: offset + u["end_time"].as_f64().unwrap_or(0.0) / 1000.0,
                                    text,
                                })
                            })
                            .collect());
                    }
                } else {
                    let v: Value = serde_json::from_str(&body).map_err(|_| anyhow!("识别服务返回了无法解析的结果"))?;
                    let segs = v["segments"].as_array().cloned().unwrap_or_default();
                    if !segs.is_empty() {
                        return Ok(segs
                            .iter()
                            .filter_map(|s| {
                                let text = s["text"].as_str()?.trim().to_string();
                                let st = s["start"].as_f64().unwrap_or(0.0);
                                (!text.is_empty()).then(|| Segment {
                                    start: offset + st,
                                    end: offset + s["end"].as_f64().unwrap_or(st).max(st),
                                    text,
                                })
                            })
                            .collect());
                    }
                    let text = v["text"].as_str().unwrap_or("").trim().to_string();
                    return Ok(if text.is_empty() {
                        vec![]
                    } else {
                        crate::transcript::split_timed(&text, offset, offset + len)
                    });
                }
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(800 * (attempt + 1))).await;
    }
    Err(anyhow!("连接识别服务失败：{last}"))
}

pub fn resolve_key(cfg: &CloudAsr) -> Result<String> {
    let key = crate::llm::get_key(&format!("asr.{}", cfg.id))
        .filter(|k| !k.is_empty())
        .or_else(|| (cfg.protocol == "deepseek").then(|| crate::llm::get_key("deepseek")).flatten())
        .unwrap_or_default();
    if cfg.needs_key.unwrap_or(true) && key.is_empty() {
        return Err(anyhow!("请先在设置里填写这个云端语音服务的 API Key"));
    }
    Ok(key)
}

pub async fn transcribe(
    cfg: &CloudAsr,
    samples: Vec<f32>,
    language: &str,
    ctx: &crate::asr::AsrContext,
    cancel: Arc<AtomicBool>,
    on_progress: impl Fn(f64),
) -> Result<Vec<Segment>> {
    let key = resolve_key(cfg)?;
    let chunk = (cfg.chunk_secs.unwrap_or(if cfg.protocol == "doubao" { 300.0 } else { 20.0 }) * RATE as f64) as usize;
    let chunks: Vec<(usize, &[f32])> = samples.chunks(chunk.max(RATE as usize)).enumerate().collect();
    let total = chunks.len().max(1);
    let done = std::sync::atomic::AtomicUsize::new(0);
    let parallel = match cfg.protocol.as_str() {
        "doubao" => 2,
        "deepseek" => 4,
        _ => 4,
    };
    let slots = tokio::sync::Semaphore::new(parallel);
    let parts: Vec<Vec<Segment>> = futures_util::future::try_join_all(chunks.into_iter().map(|(i, c)| {
        let (key, cfg, cancel, done, on_progress, slots) =
            (key.clone(), cfg.clone(), cancel.clone(), &done, &on_progress, &slots);
        let (language, ctx) = (language.to_string(), ctx.clone());
        async move {
            let _slot = slots.acquire().await;
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("已取消"));
            }
            let offset = (i * chunk) as f64 / RATE as f64;
            let len = c.len() as f64 / RATE as f64;
            let watch = async {
                while !cancel.load(Ordering::Relaxed) {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                }
            };
            let r = tokio::select! {
                r = recognize_chunk(&cfg, &key, wav_bytes(c, RATE), offset, len, &language, &ctx) => r,
                _ = watch => Err(anyhow!("已取消")),
            };
            let n = done.fetch_add(1, Ordering::Relaxed) + 1;
            on_progress(n as f64 / total as f64);
            r
        }
    }))
    .await?;
    Ok(parts.into_iter().flatten().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_valid_pcm_wav_header() {
        let wav = wav_bytes(&[0.0, 0.5, -0.5, 1.0], 16_000);
        assert_eq!(&wav[..4], b"RIFF");
        assert_eq!(&wav[8..16], b"WAVEfmt ");
        assert_eq!(wav.len(), 44 + 8);
    }
}
