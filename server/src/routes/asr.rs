use super::{api_error, episodes::detect_script_lang, AppState};
use crate::{asr, asr_context, cloud, db, model::*, transcript};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    convert::Infallible,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use tokio_stream::{wrappers::UnboundedReceiverStream, Stream};

fn build_asr_status_json(data_dir: &std::path::Path, force_hw: bool) -> Value {
    let hw = asr::detect_hardware(force_hw);
    let models = asr::list_models(data_dir, &hw.recommended_model);
    let installed_variants = asr::installed_variants(data_dir);
    let state = asr::load_runtime_state(data_dir);
    let active_variant = state
        .active_variant
        .filter(|v| installed_variants.contains(v))
        .or_else(|| hw.recommended_variant.filter(|v| installed_variants.contains(v)))
        .or_else(|| installed_variants.first().copied());
    let preferred_variant = state.preferred_variant.or(hw.recommended_variant);
    let rec = models.iter().find(|m| m.id == hw.recommended_model).or_else(|| models.first());
    let any_model = models.iter().any(|m| m.installed);
    let engine_ready = active_variant.is_some();
    let vad_ready = asr::has_vad_model(data_dir);

    json!({
        "modelId": hw.recommended_model,
        "name": rec.map(|m| m.name.clone()).unwrap_or_else(|| "Qwen3-ASR 0.6B".into()),
        "sizeMb": rec.map(|m| m.size_mb).unwrap_or(602),
        "modelReady": rec.is_some_and(|m| m.installed) || any_model,
        "engineReady": engine_ready,
        "ytdlpReady": asr::find_ytdlp(data_dir).is_some(),
        "vadReady": vad_ready,
        "hardware": hw,
        "runtime": {
            "version": asr::CRISPASR_VERSION,
            "activeVariant": active_variant.map(|v| v.as_str()),
            "preferredVariant": preferred_variant.map(|v| v.as_str()),
            "installedVariants": installed_variants.iter().map(|v| v.as_str()).collect::<Vec<_>>(),
            "deviceIndex": if state.active_variant == active_variant { state.device_index } else { None },
            "gpuName": if state.active_variant == active_variant { state.gpu_name.clone() } else { None },
            "verified": state.verified && state.active_variant == active_variant,
            "fallbackReason": if state.active_variant == active_variant { state.fallback_reason.clone() } else { None },
        },
        "models": models,
    })
}

pub async fn asr_models(State(state): State<Arc<AppState>>) -> Response {
    let data = state.data_dir.clone();
    let payload = tokio::task::spawn_blocking(move || build_asr_status_json(&data, false))
        .await
        .unwrap_or_else(|_| json!({ "error": "读取 ASR 状态失败" }));
    Json(payload).into_response()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProbeAsrBody {
    variant: Option<String>,
    device_index: Option<u32>,
    force_hardware: Option<bool>,
}

pub async fn probe_asr_runtime(State(state): State<Arc<AppState>>, Json(body): Json<ProbeAsrBody>) -> Response {
    let force_hw = body.force_hardware.unwrap_or(false);
    let hw = tokio::task::spawn_blocking(move || asr::detect_hardware(force_hw))
        .await
        .unwrap_or_else(|_| asr::detect_hardware(false));

    let target = match body.variant.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "auto") {
        Some(raw) => match asr::RuntimeVariant::parse(raw) {
            Some(v) => v,
            None => return api_error(StatusCode::BAD_REQUEST, format!("未知推理后端：{raw}")),
        },
        None => match hw.recommended_variant {
            Some(v) => v,
            None => return api_error(StatusCode::BAD_REQUEST, "当前平台暂不支持离线 CrispASR，请使用云端 ASR"),
        },
    };

    if asr::find_crispasr_variant(&state.data_dir, target).is_none() {
        return Json(json!({
            "needsDownload": true,
            "variant": target.as_str(),
            "approxMb": target.approx_mb(),
        }))
        .into_response();
    }

    let resolved = asr::resolve_model(&state.data_dir, None, &hw.recommended_model);
    let model_pair = resolved.as_ref().map(|m| (m.path.as_path(), m.backend));
    let cancel = Arc::new(AtomicBool::new(false));
    match asr::probe_and_verify(&state.data_dir, target, body.device_index, model_pair, &hw, &cancel, |_, _, _| {}).await
    {
        Ok(_) => {
            let d = state.data_dir.clone();
            let payload = tokio::task::spawn_blocking(move || build_asr_status_json(&d, false))
                .await
                .unwrap_or_default();
            Json(payload).into_response()
        }
        Err(e) => api_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadAsrBody {
    request_id: Option<String>,
    model_id: Option<String>,
    variant: Option<String>,
    mirror_first: Option<bool>,
    runtime_only: Option<bool>,
}

pub async fn download_asr_models(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DownloadAsrBody>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let request_id = body.request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mirror_first = body.mirror_first.unwrap_or(true);
    let runtime_only = body.runtime_only.unwrap_or(false);
    let cancel = state.start_job(&request_id);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let state_clone = state.clone();
    tokio::spawn(async move {
        let send = |v: Value| {
            let _ = tx.send(Ok(Event::default().data(v.to_string())));
        };

        let hw = tokio::task::spawn_blocking(|| asr::detect_hardware(false))
            .await
            .unwrap_or_else(|_| asr::detect_hardware(false));
        let model_id = body
            .model_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .map(asr::normalize_model_id)
            .unwrap_or(&hw.recommended_model)
            .to_string();

        let res: anyhow::Result<()> = async {
            let target_variant = match body.variant.as_deref().map(str::trim).filter(|s| !s.is_empty() && *s != "auto") {
                Some(raw) => asr::RuntimeVariant::parse(raw)
                    .ok_or_else(|| anyhow::anyhow!("未知推理后端：{raw}"))?,
                None => hw
                    .recommended_variant
                    .ok_or_else(|| anyhow::anyhow!("当前平台暂不支持离线 CrispASR（建议改用云端 ASR）"))?,
            };

            if asr::find_crispasr_variant(&state_clone.data_dir, target_variant).is_none() {
                send(json!({
                    "type": "progress",
                    "stage": format!("正在下载 CrispASR {}（{}，约 {} MB）...", asr::CRISPASR_VERSION, target_variant.label(), target_variant.approx_mb()),
                    "pct": 0.0
                }));
                let tx_p = tx.clone();
                let label = target_variant.label().to_string();
                asr::install_crispasr_variant(&state_clone.data_dir, target_variant, &cancel, move |received, total| {
                    let frac = total.filter(|&t| t > 0).map(|t| received as f64 / t as f64).unwrap_or(0.2);
                    let _ = tx_p.send(Ok(Event::default().data(
                        json!({
                            "type": "progress",
                            "stage": format!("正在下载 CrispASR {label}（{:.1} MB）...", received as f64 / 1_048_576.0),
                            "received": received,
                            "total": total,
                            "pct": frac * 0.12,
                        })
                        .to_string(),
                    )));
                })
                .await?;
            }

            if !asr::has_vad_model(&state_clone.data_dir) {
                send(json!({ "type": "progress", "stage": "正在下载 Silero VAD 语音切片模型（864 KB）...", "pct": 0.12 }));
                let tx_p = tx.clone();
                asr::download_vad_model(&state_clone.data_dir, &cancel, mirror_first, move |received, total| {
                    let frac = total.filter(|&t| t > 0).map(|t| received as f64 / t as f64).unwrap_or(0.5);
                    let _ = tx_p.send(Ok(Event::default().data(
                        json!({
                            "type": "progress",
                            "stage": "正在下载 Silero VAD...",
                            "received": received,
                            "total": total,
                            "pct": 0.12 + frac * 0.03,
                        })
                        .to_string(),
                    )));
                })
                .await?;
            }

            if !runtime_only && asr::resolve_model(&state_clone.data_dir, Some(&model_id), &hw.recommended_model).is_none() {
                let spec = asr::spec(&model_id).ok_or_else(|| anyhow::anyhow!("未知语音模型：{model_id}"))?;
                send(json!({
                    "type": "progress",
                    "stage": format!("正在下载 {}（约 {} MB）...", spec.name, spec.size_mb),
                    "pct": 0.15
                }));
                let tx_p = tx.clone();
                let mname = spec.name.to_string();
                let est_bytes = spec.size_mb as u64 * 1_048_576;
                asr::download_model(&state_clone.data_dir, &model_id, &cancel, mirror_first, move |received, total| {
                    let frac = total.filter(|&t| t > 0).map(|t| received as f64 / t as f64).unwrap_or(0.0);
                    let _ = tx_p.send(Ok(Event::default().data(
                        json!({
                            "type": "progress",
                            "stage": format!(
                                "正在下载 {}（{:.0}/{:.0} MB）",
                                mname,
                                received as f64 / 1_048_576.0,
                                total.unwrap_or(est_bytes) as f64 / 1_048_576.0
                            ),
                            "received": received,
                            "total": total,
                            "pct": 0.15 + frac * 0.77,
                        })
                        .to_string(),
                    )));
                })
                .await?;
            }

            send(json!({
                "type": "progress",
                "stage": format!("正在用短样音试跑校验 {}...", target_variant.label()),
                "pct": 0.93
            }));
            let resolved = if runtime_only {
                asr::resolve_model(&state_clone.data_dir, None, &hw.recommended_model)
            } else {
                asr::resolve_model(&state_clone.data_dir, Some(&model_id), &hw.recommended_model)
                    .or_else(|| asr::resolve_model(&state_clone.data_dir, None, &hw.recommended_model))
            };
            let model_pair = resolved.as_ref().map(|m| (m.path.as_path(), m.backend));
            let tx_fb = tx.clone();
            asr::probe_and_verify(&state_clone.data_dir, target_variant, None, model_pair, &hw, &cancel, move |lbl, rec, tot| {
                let _ = tx_fb.send(Ok(Event::default().data(
                    json!({
                        "type": "progress",
                        "stage": format!("GPU 试跑失败，正在下载 {lbl} 回退引擎（{:.1} MB）...", rec as f64 / 1_048_576.0),
                        "received": rec,
                        "total": tot,
                        "pct": 0.96,
                    })
                    .to_string(),
                )));
            })
            .await?;

            Ok(())
        }
        .await;

        match res {
            Ok(()) => {
                let d = state_clone.data_dir.clone();
                let status = tokio::task::spawn_blocking(move || build_asr_status_json(&d, false))
                    .await
                    .unwrap_or_default();
                send(json!({ "type": "done", "modelId": model_id, "runtime": status["runtime"] }));
            }
            Err(err) => send(json!({ "type": "error", "message": err.to_string() })),
        }
        state_clone.finish_job(&request_id, &cancel);
    });

    Sse::new(UnboundedReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeBody {
    request_id: Option<String>,
    engine: String,
    model_id: Option<String>,
    language: Option<String>,
    cloud: Option<cloud::CloudAsr>,
}

fn infer_audio_ext(url: &str) -> &'static str {
    let clean = url.split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    for ext in ["m4a", "mp3", "mp4", "wav", "flac", "ogg", "opus", "aac", "webm"] {
        if clean.ends_with(&format!(".{ext}")) {
            return ext;
        }
    }
    "m4a"
}

async fn run_transcribe(
    state: &AppState,
    ep_id: &str,
    body: &TranscribeBody,
    cancel: &Arc<AtomicBool>,
    tx: &tokio::sync::mpsc::UnboundedSender<Result<Event, Infallible>>,
) -> anyhow::Result<Transcript> {
    let send = |v: Value| {
        let _ = tx.send(Ok(Event::default().data(v.to_string())));
    };

    let (ep, show_title, ctx_json) = {
        let conn = state.db_lock();
        let ep = db::get_episode(&conn, ep_id)?.ok_or_else(|| anyhow::anyhow!("单集不存在"))?;
        let show_title = ep
            .show_title
            .clone()
            .or_else(|| db::get_show(&conn, &ep.show_id).ok().flatten().map(|s| s.title))
            .unwrap_or_default();
        let ctx_json = db::get_blob(&conn, ep_id, "ctx").ok().flatten();
        (ep, show_title, ctx_json)
    };

    let lang = body
        .language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("auto")
        .to_string();

    let (local_model, cloud_cfg) = if body.engine == "cloud" {
        let cfg = body.cloud.clone().ok_or_else(|| anyhow::anyhow!("缺少云端语音识别配置"))?;
        cloud::resolve_key(&cfg)?;
        (None, Some(cfg))
    } else {
        let hw = asr::detect_hardware(false);
        if asr::find_any_crispasr(&state.data_dir).is_none() {
            return Err(anyhow::anyhow!("尚未安装 CrispASR 推理程序，请先在「设置 › 字幕与转写」下载"));
        }
        let model = asr::resolve_model(&state.data_dir, body.model_id.as_deref(), &hw.recommended_model)
            .ok_or_else(|| anyhow::anyhow!("所选离线语音模型尚未下载，请先在「设置 › 字幕与转写」下载"))?;
        (Some(model), None)
    };

    let ctx = asr::build_asr_context(
        &ep.title,
        &show_title,
        ep.notes.as_deref().unwrap_or(""),
        ctx_json.as_deref(),
        &lang,
    );

    let job_dir = state.data_dir.join("tmp").join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&job_dir).await?;

    let result: anyhow::Result<Transcript> = async {
        let audio_path = if let Some(media_rel) = ep.audio_url.as_deref().and_then(|u| u.strip_prefix("/api/media/")) {
            let safe_name = std::path::Path::new(media_rel)
                .file_name()
                .ok_or_else(|| anyhow::anyhow!("本地媒体路径无效"))?;
            let local_path = state.data_dir.join("media").join(safe_name);
            if !local_path.is_file() {
                return Err(anyhow::anyhow!("本地音视频文件不存在"));
            }
            local_path
        } else if let Some(url) = ep.audio_url.as_deref().filter(|u| u.starts_with("http://") || u.starts_with("https://")) {
            send(json!({ "type": "progress", "stage": "正在拉取节目音频...", "pct": 0.05 }));
            let dest = job_dir.join(format!("audio.{}", infer_audio_ext(url)));
            let tx_p = tx.clone();
            asr::download(url, &dest, cancel, move |received, total| {
                let frac = total.filter(|&t| t > 0).map(|t| received as f64 / t as f64).unwrap_or(0.0);
                let _ = tx_p.send(Ok(Event::default().data(
                    json!({
                        "type": "progress",
                        "stage": format!("正在下载音频（{:.1} MB）...", received as f64 / 1_048_576.0),
                        "pct": 0.05 + frac * 0.15,
                    })
                    .to_string(),
                )));
            })
            .await?;
            dest
        } else if let Some(vid) = ep.video_id.as_deref() {
            send(json!({ "type": "progress", "stage": "正在通过 yt-dlp 下载音轨...", "pct": 0.05 }));
            asr::with_ytdlp(&state.data_dir, |bin| {
                let data = state.data_dir.clone();
                let dir = job_dir.clone();
                let c = cancel.clone();
                let v = vid.to_string();
                async move { asr::youtube_audio(&data, &bin, &v, &dir, c).await }
            })
            .await?
        } else {
            return Err(anyhow::anyhow!("该单集没有可用于转写的音频或视频来源"));
        };

        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow::anyhow!("已取消"));
        }

        send(json!({ "type": "progress", "stage": "正在解码音频为 16 kHz 单声道...", "pct": 0.22 }));
        let decode_path = audio_path.clone();
        let samples = tokio::task::spawn_blocking(move || asr::decode_16k_mono(&decode_path)).await??;
        if samples.is_empty() {
            return Err(anyhow::anyhow!("音频解码结果为空"));
        }

        let (raw_segs, source_name, filter_echo) = if let Some(cfg) = cloud_cfg {
            send(json!({ "type": "progress", "stage": "正在调用云端 ASR 分片识别...", "pct": 0.28 }));
            let tx_p = tx.clone();
            let segs = cloud::transcribe(&cfg, samples, &lang, &ctx, cancel.clone(), move |p| {
                let _ = tx_p.send(Ok(Event::default().data(
                    json!({
                        "type": "progress",
                        "stage": format!("云端转写中（{:.0}%）...", p * 100.0),
                        "pct": 0.28 + p * 0.68,
                    })
                    .to_string(),
                )));
            })
            .await?;
            (segs, "cloud".to_string(), true)
        } else {
            let model = local_model.as_ref().ok_or_else(|| anyhow::anyhow!("未找到可用本地语音模型"))?;
            let wav_path = job_dir.join("input.wav");
            let wp = wav_path.clone();
            tokio::task::spawn_blocking(move || asr::write_wav(&wp, &samples)).await??;
            let engine = asr::CrispAsrEngine;
            let req = asr::LocalTranscribeRequest {
                data_dir: &state.data_dir,
                model,
                wav_path: &wav_path,
                language: &lang,
                ctx: &ctx,
                cancel: cancel.clone(),
            };
            let tx_p = tx.clone();
            let outcome = asr::AsrEngine::transcribe(&engine, req, move |stage: &str, p: Option<f64>| {
                let pct = 0.28 + p.unwrap_or(0.0) * 0.68;
                let _ = tx_p.send(Ok(Event::default().data(
                    json!({
                        "type": "progress",
                        "stage": stage,
                        "pct": pct,
                    })
                    .to_string(),
                )));
            })
            .await?;
            if outcome.fell_back_to_cpu {
                send(json!({
                    "type": "progress",
                    "stage": format!("已自动回退 {} 完成转写，正在整理字幕...", outcome.used_variant.label()),
                    "pct": 0.97,
                }));
            }
            (outcome.segments, model.id.clone(), model.supports_context)
        };

        let filtered: Vec<Segment> = raw_segs
            .into_iter()
            .filter(|s| !filter_echo || ctx.background.is_empty() || !asr_context::is_echo(&s.text, &ctx.background))
            .collect();
        let segments = transcript::resegment(transcript::clean(filtered));
        if segments.is_empty() {
            return Err(anyhow::anyhow!("未能识别出有效语音内容"));
        }

        let detected_lang = if lang == "auto" { detect_script_lang(&segments) } else { lang.clone() };
        let tr = Transcript {
            episode_id: ep.id.clone(),
            source: source_name,
            language: detected_lang,
            segments,
        };
        let conn = state.db_lock();
        db::save_transcript(&conn, &tr)?;
        Ok(tr)
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&job_dir).await;
    result
}

pub async fn transcribe_episode(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<TranscribeBody>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let request_id = body
        .request_id
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = state.start_job(&request_id);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let state_clone = state.clone();
    tokio::spawn(async move {
        let send = |v: Value| {
            let _ = tx.send(Ok(Event::default().data(v.to_string())));
        };
        match run_transcribe(&state_clone, &id, &body, &cancel, &tx).await {
            Ok(tr) => send(json!({ "type": "done", "transcript": tr })),
            Err(err) => send(json!({ "type": "error", "message": err.to_string() })),
        }
        state_clone.finish_job(&request_id, &cancel);
    });

    Sse::new(UnboundedReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}
