use super::{api_error, AppState};
use crate::{asr, db, model::*, net, transcript, youtube};
use axum::{
    extract::{Multipart, Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::{path::PathBuf, sync::Arc};
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodesQuery {
    show_id: Option<String>,
    limit: Option<i64>,
}

pub async fn list_episodes(State(state): State<Arc<AppState>>, Query(q): Query<EpisodesQuery>) -> Response {
    let limit = q.limit.unwrap_or(300).clamp(1, 1000);
    let (res, is_yt_show) = {
        let conn = state.db_lock();
        let is_yt = q
            .show_id
            .as_deref()
            .is_some_and(|sid| db::get_show(&conn, sid).ok().flatten().is_some_and(|s| s.kind == "youtube"));
        (db::list_episodes(&conn, q.show_id.as_deref(), limit), is_yt)
    };
    if is_yt_show {
        if let Some(show_id) = q.show_id {
            super::shows::spawn_youtube_pub_backfill(state.clone(), show_id);
        }
    }
    match res {
        Ok(eps) => Json(eps).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn recent_episodes(State(state): State<Arc<AppState>>) -> Response {
    let conn = state.db_lock();
    match db::recent_episodes(&conn, 50) {
        Ok(eps) => Json(eps).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn get_episode(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let (mut ep, backfill_vid) = {
        let conn = state.db_lock();
        match db::get_episode(&conn, &id) {
            Ok(Some(ep)) => {
                let _ = db::touch_episode(&conn, &id);
                let vid = if ep.video_id.is_some()
                    && db::get_blob(&conn, &id, "yt-pub-v1").ok().flatten().is_none()
                {
                    ep.video_id.clone()
                } else {
                    None
                };
                let refreshed = db::get_episode(&conn, &id).ok().flatten().unwrap_or(ep);
                (refreshed, vid)
            }
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "单集不存在"),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };

    if let Some(vid) = backfill_vid {
        if let Some(published) = youtube::fetch_publish_date(&vid).await {
            let conn = state.db_lock();
            let _ = db::update_episode_published(&conn, &id, Some(published));
            let _ = db::set_blob(&conn, &id, "yt-pub-v1", "1");
            if let Ok(Some(updated)) = db::get_episode(&conn, &id) {
                ep = updated;
            } else {
                ep.published = Some(published);
            }
        }
    }

    Json(ep).into_response()
}

pub async fn remove_episode(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let audio_url = {
        let conn = state.db_lock();
        match db::delete_episode(&conn, &id) {
            Ok(Some(url)) => url,
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "单集不存在"),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };
    if let Some(file) = audio_url.strip_prefix("/api/media/") {
        if !file.is_empty() && !file.contains('/') && !file.contains('\\') && !file.contains("..") {
            let path = state.data_dir.join("media").join(file);
            if let Err(e) = tokio::fs::remove_file(&path).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    return api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("删除本地媒体失败：{e}"));
                }
            }
        }
    }
    Json(json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
pub struct ProgressBody {
    seconds: f64,
}

pub async fn set_progress(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ProgressBody>,
) -> Response {
    let conn = state.db_lock();
    match db::set_progress(&conn, &id, body.seconds) {
        Ok(completed) => Json(json!({ "ok": true, "completed": completed })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct CompletedBody {
    completed: bool,
}

pub async fn set_completed(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<CompletedBody>,
) -> Response {
    let conn = state.db_lock();
    match db::set_completed(&conn, &id, body.completed) {
        Ok(Some(ep)) => Json(json!({ "ok": true, "episode": ep })).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "单集不存在"),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn get_transcript(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db_lock();
    match db::get_transcript(&conn, &id) {
        Ok(tr) => Json(tr).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn fetch_official_transcript(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let ep = {
        let conn = state.db_lock();
        match db::get_episode(&conn, &id) {
            Ok(Some(ep)) => ep,
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "单集不存在"),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };

    if let Some(video_id) = ep.video_id.as_deref() {
        let info = match youtube::video_info(video_id).await {
            Ok(i) => i,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        let Some(chosen) = youtube::choose(&info.tracks, info.original_language.as_deref(), youtube::script_hint(&ep.title)).cloned() else {
            return api_error(StatusCode::NOT_FOUND, "该视频暂无可用的官方字幕");
        };
        let raw = match youtube::fetch_track(&chosen).await {
            Ok(s) => s,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        let segments = transcript::resegment(transcript::clean(raw));
        if segments.is_empty() {
            return api_error(StatusCode::NOT_FOUND, "官方字幕内容为空");
        }
        let tr = Transcript {
            episode_id: ep.id.clone(),
            source: if chosen.auto { "youtube-auto".into() } else { "youtube".into() },
            language: chosen.language.clone(),
            segments,
        };

        let mut aligned_zh: Option<Vec<Option<String>>> = None;
        if let Some(zh_track) = youtube::official_chinese(&info.tracks, &chosen.language).cloned() {
            if let Ok(zh_raw) = youtube::fetch_track(&zh_track).await {
                let items = youtube::align(&tr.segments, &transcript::clean(zh_raw));
                let covered = items.iter().filter(|x| x.is_some()).count();
                if covered * 2 >= tr.segments.len() {
                    aligned_zh = Some(items);
                }
            }
        }

        let conn = state.db_lock();
        if let Err(e) = db::save_transcript(&conn, &tr) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Some(items) = &aligned_zh {
            if let Ok(payload) = serde_json::to_string(&json!({ "lang": "zh-CN", "items": items })) {
                let _ = db::set_blob(&conn, &ep.id, "translation", &payload);
            }
        }
        return Json(json!({ "transcript": tr, "alignedTranslation": aligned_zh })).into_response();
    }

    if let Some(url) = ep.transcript_url.as_deref() {
        let body = match net::get_text(url).await {
            Ok(b) => b,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        let parsed = if ep.transcript_type.as_deref().is_some_and(|t| t.contains("json")) || body.trim_start().starts_with('{') {
            transcript::parse_podcast_json(&body)
        } else {
            transcript::parse_cues(&body)
        };
        let segments = transcript::resegment(transcript::clean(parsed));
        if segments.is_empty() {
            return api_error(StatusCode::NOT_FOUND, "未从官方字幕链接解析出有效片段");
        }
        let tr = Transcript {
            episode_id: ep.id.clone(),
            source: "rss".into(),
            language: "und".into(),
            segments,
        };
        let conn = state.db_lock();
        if let Err(e) = db::save_transcript(&conn, &tr) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        return Json(json!({ "transcript": tr })).into_response();
    }

    api_error(StatusCode::NOT_FOUND, "该单集暂无官方字幕")
}

pub async fn get_blob(
    State(state): State<Arc<AppState>>,
    AxumPath((id, kind)): AxumPath<(String, String)>,
) -> Response {
    let conn = state.db_lock();
    match db::get_blob(&conn, &id, &kind) {
        Ok(data) => Json(json!({ "data": data })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
pub struct BlobBody {
    data: String,
}

pub async fn set_blob(
    State(state): State<Arc<AppState>>,
    AxumPath((id, kind)): AxumPath<(String, String)>,
    Json(body): Json<BlobBody>,
) -> Response {
    let conn = state.db_lock();
    match db::set_blob(&conn, &id, &kind, &body.data) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportTextBody {
    title: Option<String>,
    text: String,
    format: Option<String>,
}

fn split_plain_paragraphs(raw: &str) -> Vec<String> {
    let cleaned = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n").trim().to_string();
    if cleaned.is_empty() {
        return vec![];
    }
    let mut blocks: Vec<String> = cleaned
        .split("\n\n")
        .map(|p| p.lines().map(str::trim).filter(|l| !l.is_empty()).collect::<Vec<_>>().join(" "))
        .filter(|p| !p.is_empty())
        .collect();
    if blocks.len() <= 2 && cleaned.lines().count() > 2 {
        blocks = cleaned.lines().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect();
    }
    let mut out = Vec::new();
    for block in blocks {
        if block.chars().count() <= 350 {
            out.push(block);
            continue;
        }
        let approx_dur = (block.chars().count() as f64 / 7.5).max(10.0);
        for seg in transcript::split_timed(&block, 0.0, approx_dur) {
            if !seg.text.trim().is_empty() {
                out.push(seg.text);
            }
        }
    }
    out
}

pub(crate) fn build_imported_segments(raw: &str, format: &str) -> Result<(Vec<Segment>, String), String> {
    let cleaned = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return Err("导入的文本内容为空".into());
    }
    let fmt = format.trim().to_ascii_lowercase();
    let explicit_cues = fmt == "srt" || fmt == "vtt";
    let maybe_cues = (fmt.is_empty() || fmt == "auto") && trimmed.contains("-->");
    if explicit_cues || maybe_cues {
        let cues = transcript::resegment(transcript::clean(transcript::parse_cues(trimmed)));
        if !cues.is_empty() {
            return Ok((cues, fmt_or(&fmt, "cue")));
        }
        if explicit_cues {
            return Err("未能从 SRT/VTT 字幕中解析出有效时间轴与文本".into());
        }
    }
    let paragraphs = split_plain_paragraphs(trimmed);
    if paragraphs.is_empty() {
        return Err("未能切分出有效段落".into());
    }
    let mut cursor = 0.0;
    let mut segs = Vec::with_capacity(paragraphs.len());
    for p in paragraphs {
        let dur = (p.chars().count() as f64 / 7.5).clamp(5.0, 30.0);
        segs.push(Segment { start: cursor, end: cursor + dur, text: p });
        cursor += dur;
    }
    Ok((segs, "txt".into()))
}

fn fmt_or(fmt: &str, fallback: &str) -> String {
    if fmt == "srt" || fmt == "vtt" { fmt.to_string() } else { fallback.to_string() }
}

pub(crate) fn detect_script_lang(segs: &[Segment]) -> String {
    let mut total = 0usize;
    let mut cjk = 0usize;
    for s in segs {
        for ch in s.text.chars() {
            total += 1;
            if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                cjk += 1;
            }
        }
    }
    if cjk * 100 > total.max(1) * 15 { "zh".into() } else { "en".into() }
}

pub async fn import_text(State(state): State<Arc<AppState>>, Json(body): Json<ImportTextBody>) -> Response {
    let fmt = body.format.as_deref().unwrap_or("auto");
    let (segments, detected_fmt) = match build_imported_segments(&body.text, fmt) {
        Ok(v) => v,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };
    let fallback_title: String = segments
        .first()
        .map(|s| s.text.chars().take(36).collect::<String>())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| "导入文稿".into());
    let title = body
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .unwrap_or(&fallback_title)
        .to_string();
    let content_hash = short_hash(body.text.trim(), 16);
    let ep_id = short_hash(&format!("import-text:{title}:{content_hash}"), 20);
    let duration = segments.last().map(|s| s.end);
    let ep = Episode {
        id: ep_id.clone(),
        show_id: "single".into(),
        guid: format!("import:{content_hash}"),
        title,
        published: None,
        duration,
        notes: Some(format!("手动导入文稿（{detected_fmt}），共 {} 段", segments.len())),
        has_transcript: true,
        touched_at: Some(now_ms()),
        ..Default::default()
    };
    let tr = Transcript {
        episode_id: ep_id.clone(),
        source: "import".into(),
        language: detect_script_lang(&segments),
        segments,
    };
    let saved_ep = {
        let mut conn = state.db_lock();
        if let Err(e) = db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Err(e) = db::save_transcript(&conn, &tr) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        db::get_episode(&conn, &ep_id).ok().flatten().unwrap_or(ep)
    };
    Json(json!({ "episode": saved_ep, "transcript": tr })).into_response()
}

pub(crate) fn allowed_media_ext(filename: &str) -> Option<String> {
    let ext = std::path::Path::new(filename)
        .extension()
        .and_then(|e| e.to_str())?
        .to_ascii_lowercase();
    matches!(
        ext.as_str(),
        "mp3" | "m4a" | "aac" | "wav" | "flac" | "ogg" | "opus" | "mp4" | "webm" | "mov" | "mkv"
    )
    .then_some(ext)
}

pub async fn import_media(State(state): State<Arc<AppState>>, mut multipart: Multipart) -> Response {
    let media_dir = state.data_dir.join("media");
    if let Err(e) = tokio::fs::create_dir_all(&media_dir).await {
        return api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("创建媒体目录失败：{e}"));
    }

    let mut custom_title: Option<String> = None;
    let mut saved_file: Option<(String, String, String, PathBuf, u64)> = None;

    loop {
        let next = match multipart.next_field().await {
            Ok(Some(f)) => f,
            Ok(None) => break,
            Err(e) => {
                if let Some((_, _, _, path, _)) = &saved_file {
                    let _ = tokio::fs::remove_file(path).await;
                }
                return api_error(StatusCode::BAD_REQUEST, format!("读取上传数据失败：{e}"));
            }
        };
        let name = next.name().unwrap_or("").to_string();
        if name == "title" {
            if let Ok(t) = next.text().await {
                let t = t.trim().to_string();
                if !t.is_empty() {
                    custom_title = Some(t);
                }
            }
            continue;
        }
        if name == "file" {
            let orig_name = next.file_name().unwrap_or("media").to_string();
            let Some(ext) = allowed_media_ext(&orig_name) else {
                return api_error(
                    StatusCode::BAD_REQUEST,
                    "不支持的格式；支持 mp3 / m4a / aac / wav / flac / ogg / opus / mp4 / webm / mov / mkv",
                );
            };
            let ep_id = format!("m_{}", short_hash(&uuid::Uuid::new_v4().to_string(), 18));
            let dest = media_dir.join(format!("{ep_id}.{ext}"));
            let mut file = match tokio::fs::File::create(&dest).await {
                Ok(f) => f,
                Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("保存文件失败：{e}")),
            };
            let mut size = 0u64;
            let mut field = next;
            loop {
                match field.chunk().await {
                    Ok(Some(chunk)) => {
                        size += chunk.len() as u64;
                        if let Err(e) = file.write_all(&chunk).await {
                            drop(file);
                            let _ = tokio::fs::remove_file(&dest).await;
                            return api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("写入媒体文件失败：{e}"));
                        }
                    }
                    Ok(None) => break,
                    Err(e) => {
                        drop(file);
                        let _ = tokio::fs::remove_file(&dest).await;
                        return api_error(StatusCode::BAD_REQUEST, format!("读取上传分片失败：{e}"));
                    }
                }
            }
            if let Err(e) = file.flush().await {
                let _ = tokio::fs::remove_file(&dest).await;
                return api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("落盘失败：{e}"));
            }
            if size == 0 {
                let _ = tokio::fs::remove_file(&dest).await;
                return api_error(StatusCode::BAD_REQUEST, "上传的音视频文件为空");
            }
            let stem = std::path::Path::new(&orig_name)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("本地音视频")
                .to_string();
            saved_file = Some((ep_id, ext, stem, dest, size));
        }
    }

    let Some((ep_id, ext, stem, _, size)) = saved_file else {
        return api_error(StatusCode::BAD_REQUEST, "请选择要导入的音视频文件");
    };
    let title = custom_title.unwrap_or(stem);
    let ep = Episode {
        id: ep_id.clone(),
        show_id: "single".into(),
        guid: ep_id.clone(),
        title,
        published: None,
        audio_url: Some(format!("/api/media/{ep_id}.{ext}")),
        notes: Some(format!("本地导入媒体文件（.{ext}，{:.1} MB）", size as f64 / 1_048_576.0)),
        touched_at: Some(now_ms()),
        ..Default::default()
    };
    let saved = {
        let mut conn = state.db_lock();
        if let Err(e) = db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        db::get_episode(&conn, &ep_id).ok().flatten().unwrap_or(ep)
    };
    Json(json!({ "episode": saved })).into_response()
}

#[derive(Deserialize)]
pub struct StreamQuery {
    fresh: Option<bool>,
}

pub async fn episode_stream_url(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<StreamQuery>,
) -> Response {
    let video_id = {
        let conn = state.db_lock();
        match db::get_episode(&conn, &id) {
            Ok(Some(ep)) => match ep.video_id {
                Some(vid) => vid,
                None => return api_error(StatusCode::BAD_REQUEST, "该单集不是 YouTube 视频"),
            },
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "单集不存在"),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };
    let fresh = q.fresh.unwrap_or(false);
    let data = state.data_dir.clone();
    let yt_login = state.yt_login.clone();
    match asr::with_ytdlp(&state.data_dir, |bin| {
        let d = data.clone();
        let vid = video_id.clone();
        let login = yt_login.clone();
        async move { asr::youtube_stream_url(&d, &bin, &vid, fresh, login).await }
    })
    .await
    {
        Ok(url) => Json(json!({ "url": url })).into_response(),
        Err(e) => api_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_srt_and_plain_text_cleanly() {
        let srt = "1\n00:00:01,000 --> 00:00:03,000\nFirst sentence.\n\n2\n00:00:03,500 --> 00:00:06,000\nSecond sentence.";
        let (segs, fmt) = build_imported_segments(srt, "auto").unwrap();
        assert_eq!(fmt, "cue");
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "First sentence.");

        let txt = "第一段内容。\n\n第二段内容在这里，用来检查段落切分与合成时间戳。";
        let (segs2, fmt2) = build_imported_segments(txt, "auto").unwrap();
        assert_eq!(fmt2, "txt");
        assert_eq!(segs2.len(), 2);
        assert_eq!(segs2[0].start, 0.0);
        assert!(segs2[1].start >= 5.0);
    }

    #[test]
    fn validates_media_extensions() {
        assert_eq!(allowed_media_ext("Podcast.MP3").as_deref(), Some("mp3"));
        assert_eq!(allowed_media_ext("talk.m4a").as_deref(), Some("m4a"));
        assert_eq!(allowed_media_ext("video.mp4").as_deref(), Some("mp4"));
        assert_eq!(allowed_media_ext("script.exe"), None);
    }
}
