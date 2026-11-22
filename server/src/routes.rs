use crate::{agents, asr, asr_context, cloud, db, feeds, llm, model::*, net, transcript, translate, youtube};
use axum::{
    extract::{DefaultBodyLimit, Multipart, Path as AxumPath, Query, State},
    http::{HeaderValue, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Json, Response,
    },
    routing::{delete, get, post},
    Router,
};
use rusqlite::Connection;
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;
use tokio_stream::{
    wrappers::{ReceiverStream, UnboundedReceiverStream},
    Stream,
};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub port: u16,
    pub jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl AppState {
    fn start_job(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.jobs.lock().unwrap().insert(id.to_string(), flag.clone());
        flag
    }

    fn finish_job(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut jobs = self.jobs.lock().unwrap();
        if jobs.get(id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            jobs.remove(id);
        }
    }

    fn cancel_job(&self, id: &str) {
        if let Some(flag) = self.jobs.lock().unwrap().get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

fn api_error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

fn is_local_origin(origin: &HeaderValue) -> bool {
    let Ok(s) = origin.to_str() else { return false };
    s.starts_with("http://127.0.0.1:")
        || s.starts_with("http://localhost:")
        || s == "http://127.0.0.1"
        || s == "http://localhost"
}

pub fn router(state: Arc<AppState>, dist_dir: PathBuf) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| is_local_origin(origin)))
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::RANGE]);

    let media_dir = state.data_dir.join("media");
    let media_upload = Router::new()
        .route("/api/episodes/import-media", post(import_media))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024));

    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(get_settings).post(save_settings))
        .route("/api/search", get(search_shows))
        .route("/api/shows", get(list_shows))
        .route("/api/shows/refresh-all", post(refresh_all_shows))
        .route("/api/shows/{id}", delete(remove_show))
        .route("/api/shows/{id}/refresh", post(refresh_show))
        .route("/api/shows/{id}/load-more", post(load_more_show))
        .route("/api/shows/{id}/mark-all-completed", post(mark_show_all_completed))
        .route("/api/subscriptions", post(add_subscription))
        .route("/api/episodes", get(list_episodes))
        .route("/api/episodes/recent", get(recent_episodes))
        .route("/api/episodes/import-text", post(import_text))
        .merge(media_upload)
        .route("/api/episodes/{id}", get(get_episode).delete(remove_episode))
        .route("/api/episodes/{id}/progress", post(set_progress))
        .route("/api/episodes/{id}/completed", post(set_completed))
        .route("/api/episodes/{id}/transcript", get(get_transcript))
        .route("/api/episodes/{id}/transcript/official", post(fetch_official_transcript))
        .route("/api/episodes/{id}/transcribe", post(transcribe_episode))
        .route("/api/episodes/{id}/stream-url", get(episode_stream_url))
        .route("/api/episodes/{id}/blobs/{kind}", get(get_blob).post(set_blob))
        .route("/api/asr/models", get(asr_models))
        .route("/api/asr/models/download", post(download_asr_models))
        .route("/api/cookies", get(get_cookies).post(set_cookies))
        .route("/api/translate/google", post(translate_google))
        .route("/api/agents", get(detect_agents))
        .route("/api/agents/warm", post(warm_agent))
        .route("/api/agents/probe", post(probe_agent))
        .route("/api/agents/models", post(agent_models))
        .route("/api/keys/{provider}", get(has_key).post(set_key))
        .route("/api/llm/chat", post(llm_chat))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
        .route("/api/events/ping", get(ping_sse))
        .nest_service("/api/media", ServeDir::new(media_dir))
        .with_state(state)
        .layer(cors);

    let index = dist_dir.join("index.html");
    if index.is_file() {
        let spa = ServeDir::new(&dist_dir).not_found_service(ServeFile::new(index));
        api.fallback_service(spa)
    } else {
        api.fallback(get(missing_frontend))
    }
}

async fn missing_frontend() -> Html<&'static str> {
    Html(
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><title>Podcast Desk</title></head>\
         <body style='font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 16px;'>\
         <h2>Podcast Desk 后端服务已启动</h2>\
         <p>未找到前端构建产物 <code>dist/index.html</code>。请在项目根目录执行 <code>npm run build</code>，或使用 Vite 开发模式 <code>npm run dev</code>。</p>\
         </body></html>",
    )
}

async fn health(State(state): State<Arc<AppState>>) -> Response {
    let shows_count = {
        let conn = state.db.lock().unwrap();
        match conn.query_row("SELECT COUNT(*) FROM shows", [], |r| r.get::<_, i64>(0)) {
            Ok(n) => n,
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("SQLite 查询失败：{e}")),
        }
    };
    Json(json!({
        "ok": true,
        "version": env!("CARGO_PKG_VERSION"),
        "port": state.port,
        "db": "ok",
        "dataDir": state.data_dir.to_string_lossy(),
        "shows": shows_count,
        "configuredProxy": net::proxy(),
        "effectiveProxy": net::effective_proxy(),
    }))
    .into_response()
}

async fn get_settings(State(state): State<Arc<AppState>>) -> Response {
    let conn = state.db.lock().unwrap();
    match db::list_settings(&conn) {
        Ok(map) => Json(map).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn save_settings(State(state): State<Arc<AppState>>, Json(patch): Json<HashMap<String, String>>) -> Response {
    if let Some(p) = patch.get("proxy") {
        if let Err(e) = net::set_proxy(p) {
            return api_error(StatusCode::BAD_REQUEST, e.to_string());
        }
    }
    {
        let conn = state.db.lock().unwrap();
        for (k, v) in &patch {
            if let Err(e) = db::set_setting(&conn, k, v) {
                return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
        }
    }
    Json(json!({
        "ok": true,
        "configuredProxy": net::proxy(),
        "effectiveProxy": net::effective_proxy(),
    }))
    .into_response()
}

#[derive(Deserialize)]
struct SubscriptionInput {
    input: String,
}

async fn single_youtube(state: &AppState, video_id: &str) -> Result<Episode, String> {
    let info = youtube::video_info(video_id).await.map_err(|e| e.to_string())?;
    let ep = Episode {
        id: short_hash(&format!("single:{video_id}"), 20),
        show_id: "single".into(),
        guid: video_id.into(),
        title: if info.title.is_empty() { video_id.to_string() } else { info.title },
        published: info.published,
        duration: info.duration,
        video_id: Some(video_id.into()),
        link: Some(format!("https://www.youtube.com/watch?v={video_id}")),
        cover: Some(format!("https://i.ytimg.com/vi/{video_id}/hqdefault.jpg")),
        notes: Some(format!("{}\n\n{}", info.author, info.description)),
        touched_at: Some(now_ms()),
        ..Default::default()
    };
    let mut conn = state.db.lock().unwrap();
    db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)).map_err(|e| e.to_string())?;
    let _ = db::set_blob(&conn, &ep.id, "yt-pub-v1", "1");
    Ok(db::get_episode(&conn, &ep.id).map_err(|e| e.to_string())?.unwrap_or(ep))
}

async fn fetch_feed_with_fallback(url: &str, kind: &str) -> Result<(Show, Vec<Episode>), String> {
    match feeds::fetch_show(url, kind).await {
        Ok(pair) if !pair.1.is_empty() => Ok(pair),
        other if url.contains("playlist_id=UULF") => {
            let all = url.replace("playlist_id=UULF", "channel_id=UC");
            match feeds::fetch_show(&all, kind).await {
                Ok(pair) => Ok(pair),
                Err(err) => Err(other.err().map(|e| e.to_string()).unwrap_or_else(|| err.to_string())),
            }
        }
        Ok(pair) => Ok(pair),
        Err(e) => Err(e.to_string()),
    }
}

fn page_video_to_episode(show_id: &str, pv: &youtube::PageVideo) -> Episode {
    Episode {
        id: short_hash(&format!("{show_id}:{}", pv.video_id), 20),
        show_id: show_id.to_string(),
        guid: pv.video_id.clone(),
        title: pv.title.clone(),
        published: pv.published,
        duration: pv.duration,
        video_id: Some(pv.video_id.clone()),
        link: Some(format!("https://www.youtube.com/watch?v={}", pv.video_id)),
        cover: Some(pv.cover.clone()),
        ..Default::default()
    }
}

fn build_cont_state(batch: &youtube::PageBatch) -> Option<youtube::ContinuationState> {
    batch.api_key.as_ref().map(|key| youtube::ContinuationState {
        token: batch.continuation.clone(),
        api_key: key.clone(),
        client_version: batch
            .client_version
            .clone()
            .unwrap_or_else(|| "2.20250101.00.00".to_string()),
        exhausted: batch.continuation.is_none(),
    })
}

async fn fetch_youtube_initial(url: &str) -> Result<(Show, Vec<Episode>, Option<youtube::ContinuationState>), String> {
    let (rss_res, page_res) = tokio::join!(
        fetch_feed_with_fallback(url, "youtube"),
        youtube::fetch_channel_initial_50(url),
    );
    match (rss_res, page_res) {
        (Ok((mut show, mut rss_eps)), Ok(batch)) => {
            if let Some(av) = &batch.avatar {
                show.cover = Some(av.clone());
            }
            if let Some(desc) = &batch.description {
                show.description = Some(desc.clone());
            }
            if show.title.trim().is_empty() {
                if let Some(t) = &batch.title {
                    show.title = t.clone();
                }
            }
            if show.author.is_none() {
                show.author = batch.author.clone();
            }
            let page_map: HashMap<&str, &youtube::PageVideo> = batch
                .items
                .iter()
                .map(|pv| (pv.video_id.as_str(), pv))
                .collect();
            let mut seen: HashSet<String> = HashSet::new();
            for ep in &mut rss_eps {
                if let Some(vid) = ep.video_id.as_deref() {
                    seen.insert(vid.to_string());
                    if let Some(pv) = page_map.get(vid) {
                        ep.duration = ep.duration.or(pv.duration);
                        ep.cover = Some(pv.cover.clone());
                    }
                }
            }
            for pv in &batch.items {
                if seen.insert(pv.video_id.clone()) {
                    rss_eps.push(page_video_to_episode(&show.id, pv));
                }
            }
            let cont = build_cont_state(&batch);
            Ok((show, rss_eps, cont))
        }
        (Ok((show, rss_eps)), Err(_)) => Ok((show, rss_eps, None)),
        (Err(rss_err), Ok(batch)) => {
            if batch.items.is_empty() {
                return Err(rss_err);
            }
            let show_id = short_hash(url, 16);
            let show = Show {
                id: show_id.clone(),
                kind: "youtube".into(),
                title: batch.title.clone().unwrap_or_else(|| "YouTube 频道".into()),
                author: batch.author.clone(),
                cover: batch.avatar.clone().or_else(|| batch.items.first().map(|i| i.cover.clone())),
                feed_url: url.to_string(),
                link: batch.link.clone(),
                description: batch.description.clone(),
                updated_at: now_ms(),
                unplayed: 0,
            };
            let eps: Vec<Episode> = batch.items.iter().map(|pv| page_video_to_episode(&show_id, pv)).collect();
            let cont = build_cont_state(&batch);
            Ok((show, eps, cont))
        }
        (Err(e), Err(_)) => Err(e),
    }
}

fn preserve_youtube_show_meta(existing: &Show, fresh: &mut Show) {
    if existing.kind == "youtube" {
        if existing.cover.as_deref().is_some_and(|c| c.contains("yt3."))
            && fresh.cover.as_deref().is_none_or(|c| !c.contains("yt3."))
        {
            fresh.cover = existing.cover.clone();
        }
        if fresh.description.is_none() {
            fresh.description = existing.description.clone();
        }
    }
}

async fn add_subscription(State(state): State<Arc<AppState>>, Json(body): Json<SubscriptionInput>) -> Response {
    let resolved = match feeds::resolve(&body.input).await {
        Ok(s) => s,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e.to_string()),
    };

    let (show, eps, yt_cont) = match resolved {
        feeds::Source::YouTubeVideo(video_id) => match single_youtube(&state, &video_id).await {
            Ok(episode) => return Json(json!({ "episode": episode })).into_response(),
            Err(err) => return api_error(StatusCode::BAD_GATEWAY, err),
        },
        feeds::Source::XiaoyuzhouEpisode(url) => match feeds::xiaoyuzhou_episode(&url).await {
            Ok(mut ep) => {
                ep.id = short_hash(&format!("single:{}", ep.guid), 20);
                ep.touched_at = Some(now_ms());
                let mut conn = state.db.lock().unwrap();
                if let Err(e) = db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)) {
                    return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
                }
                let ep = db::get_episode(&conn, &ep.id).ok().flatten().unwrap_or(ep);
                return Json(json!({ "episode": ep })).into_response();
            }
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        },
        feeds::Source::Xiaoyuzhou(url) => match feeds::xiaoyuzhou_show(&url).await {
            Ok((s, e)) => (s, e, None),
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        },
        feeds::Source::Feed(url) if url.contains("youtube.com") => match fetch_youtube_initial(&url).await {
            Ok(triple) => triple,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e),
        },
        feeds::Source::Feed(url) => match fetch_feed_with_fallback(&url, "podcast").await {
            Ok((s, e)) => (s, e, None),
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e),
        },
    };

    if eps.is_empty() {
        return api_error(StatusCode::UNPROCESSABLE_ENTITY, "这个订阅源里没有可播放的节目");
    }

    {
        let mut conn = state.db.lock().unwrap();
        if let Err(e) = db::upsert_show(&conn, &show) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Err(e) = db::upsert_episodes(&mut conn, &eps) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Some(cont) = yt_cont {
            if let Ok(raw) = serde_json::to_string(&cont) {
                let _ = db::set_blob(&conn, &show.id, "yt-cont", &raw);
            }
        }
    }

    Json(json!({ "show": show, "episodesCount": eps.len() })).into_response()
}

#[derive(Deserialize)]
struct SearchQuery {
    term: String,
    country: Option<String>,
}

async fn search_shows(Query(q): Query<SearchQuery>) -> Response {
    let term = q.term.trim();
    if term.is_empty() {
        return Json(Vec::<feeds::SearchResult>::new()).into_response();
    }
    let country = q.country.as_deref().filter(|c| !c.trim().is_empty()).unwrap_or("us");
    match feeds::search_podcasts(term, country).await {
        Ok(results) => Json(results).into_response(),
        Err(e) => api_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn refresh_show(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let existing = {
        let conn = state.db.lock().unwrap();
        match db::get_show(&conn, &id) {
            Ok(Some(s)) => s,
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "订阅源不存在"),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };
    let (mut show, eps) = match fetch_feed_with_fallback(&existing.feed_url, &existing.kind).await {
        Ok(pair) => pair,
        Err(e) => return api_error(StatusCode::BAD_GATEWAY, e),
    };
    show.id = existing.id.clone();
    show.kind = existing.kind.clone();
    preserve_youtube_show_meta(&existing, &mut show);
    if !eps.is_empty() {
        let mut conn = state.db.lock().unwrap();
        if let Err(e) = db::upsert_show(&conn, &show) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Err(e) = db::upsert_episodes(&mut conn, &eps) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
    }
    Json(json!({ "show": show, "episodesCount": eps.len() })).into_response()
}

static REFRESHING_ALL: AtomicBool = AtomicBool::new(false);

struct RefreshAllGuard;
impl Drop for RefreshAllGuard {
    fn drop(&mut self) {
        REFRESHING_ALL.store(false, Ordering::SeqCst);
    }
}

async fn refresh_all_shows(State(state): State<Arc<AppState>>) -> Response {
    if REFRESHING_ALL.swap(true, Ordering::SeqCst) {
        return Json(json!({ "shows": 0, "newEpisodes": 0, "skipped": true })).into_response();
    }
    let _guard = RefreshAllGuard;

    let shows = {
        let conn = state.db.lock().unwrap();
        match db::list_shows(&conn) {
            Ok(list) => list,
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        }
    };

    let sem = Arc::new(tokio::sync::Semaphore::new(4));
    let mut handles = Vec::with_capacity(shows.len());
    for s in shows {
        let sem = sem.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await.ok()?;
            let res = tokio::time::timeout(
                Duration::from_secs(20),
                fetch_feed_with_fallback(&s.feed_url, &s.kind),
            )
            .await
            .ok()?
            .ok()?;
            Some((s, res))
        }));
    }

    let mut refreshed_shows = 0usize;
    let mut new_episodes = 0usize;
    for h in handles {
        let Ok(Some((existing, (mut fresh, eps)))) = h.await else {
            continue;
        };
        if eps.is_empty() {
            continue;
        }
        fresh.id = existing.id.clone();
        fresh.kind = existing.kind.clone();
        preserve_youtube_show_meta(&existing, &mut fresh);
        let mut conn = state.db.lock().unwrap();
        let known = eps
            .iter()
            .filter(|e| conn.query_row("SELECT 1 FROM episodes WHERE id=?1", [&e.id], |_| Ok(())).is_ok())
            .count();
        if db::upsert_show(&conn, &fresh).is_ok() && db::upsert_episodes(&mut conn, &eps).is_ok() {
            refreshed_shows += 1;
            new_episodes += eps.len().saturating_sub(known);
        }
    }

    Json(json!({ "shows": refreshed_shows, "newEpisodes": new_episodes, "skipped": false })).into_response()
}

async fn load_more_show(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let (show, cont_raw, total_before) = {
        let conn = state.db.lock().unwrap();
        let show = match db::get_show(&conn, &id) {
            Ok(Some(s)) => s,
            Ok(None) => return api_error(StatusCode::NOT_FOUND, "订阅源不存在"),
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        let cont = db::get_blob(&conn, &id, "yt-cont").ok().flatten();
        let total = conn
            .query_row("SELECT COUNT(*) FROM episodes WHERE show_id=?1", [&id], |r| r.get::<_, i64>(0))
            .unwrap_or(0);
        (show, cont, total)
    };

    if show.kind != "youtube" {
        return Json(json!({ "added": 0, "total": total_before, "hasMore": false })).into_response();
    }

    let Some(raw) = cont_raw else {
        let batch = match youtube::fetch_channel_initial_50(&show.feed_url).await {
            Ok(b) => b,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        let eps: Vec<Episode> = batch.items.iter().map(|pv| page_video_to_episode(&show.id, pv)).collect();
        let cont = build_cont_state(&batch);
        let has_more = cont.as_ref().is_some_and(|c| !c.exhausted && c.token.is_some());

        let (added, total, updated_show) = {
            let mut conn = state.db.lock().unwrap();
            let mut next_show = show.clone();
            if let Some(av) = batch.avatar {
                next_show.cover = Some(av);
            }
            if let Some(desc) = batch.description {
                next_show.description = Some(desc);
            }
            next_show.updated_at = now_ms();
            if let Err(e) = db::upsert_show(&conn, &next_show) {
                return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
            }
            let added = match db::upsert_older_episodes(&mut conn, &eps) {
                Ok(n) => n,
                Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
            };
            if let Some(c) = &cont {
                if let Ok(json_str) = serde_json::to_string(c) {
                    let _ = db::set_blob(&conn, &id, "yt-cont", &json_str);
                }
            }
            let total = conn
                .query_row("SELECT COUNT(*) FROM episodes WHERE show_id=?1", [&id], |r| r.get::<_, i64>(0))
                .unwrap_or(total_before);
            let updated_show = db::get_show(&conn, &id).ok().flatten().unwrap_or(next_show);
            (added, total, updated_show)
        };

        return Json(json!({ "added": added, "total": total, "hasMore": has_more, "show": updated_show })).into_response();
    };

    let mut cont: youtube::ContinuationState = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(_) => return Json(json!({ "added": 0, "total": total_before, "hasMore": false })).into_response(),
    };
    let Some(token) = cont.token.clone().filter(|t| !cont.exhausted && !t.is_empty()) else {
        return Json(json!({ "added": 0, "total": total_before, "hasMore": false })).into_response();
    };

    let (items, next_token) = match youtube::fetch_browse_continuation(&cont.api_key, &cont.client_version, &token).await {
        Ok(pair) => pair,
        Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
    };
    let eps: Vec<Episode> = items.iter().map(|pv| page_video_to_episode(&show.id, pv)).collect();
    cont.token = next_token;
    cont.exhausted = cont.token.is_none();
    let has_more = !cont.exhausted;

    let (added, total) = {
        let mut conn = state.db.lock().unwrap();
        let added = match db::upsert_older_episodes(&mut conn, &eps) {
            Ok(n) => n,
            Err(e) => return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        };
        if let Ok(json_str) = serde_json::to_string(&cont) {
            let _ = db::set_blob(&conn, &id, "yt-cont", &json_str);
        }
        let total = conn
            .query_row("SELECT COUNT(*) FROM episodes WHERE show_id=?1", [&id], |r| r.get::<_, i64>(0))
            .unwrap_or(total_before);
        (added, total)
    };

    Json(json!({ "added": added, "total": total, "hasMore": has_more })).into_response()
}

async fn mark_show_all_completed(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db.lock().unwrap();
    match db::mark_show_completed(&conn, &id) {
        Ok(updated) => Json(json!({ "ok": true, "updated": updated })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportTextBody {
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
    // Single-newline transcript dumps have no blank lines; split line-by-line when blocks are still sparse.
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

fn build_imported_segments(raw: &str, format: &str) -> Result<(Vec<Segment>, String), String> {
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

fn detect_script_lang(segs: &[Segment]) -> String {
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

async fn import_text(State(state): State<Arc<AppState>>, Json(body): Json<ImportTextBody>) -> Response {
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
        let mut conn = state.db.lock().unwrap();
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

fn allowed_media_ext(filename: &str) -> Option<String> {
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

async fn import_media(State(state): State<Arc<AppState>>, mut multipart: Multipart) -> Response {
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
        let mut conn = state.db.lock().unwrap();
        if let Err(e) = db::upsert_episodes(&mut conn, std::slice::from_ref(&ep)) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        db::get_episode(&conn, &ep_id).ok().flatten().unwrap_or(ep)
    };
    Json(json!({ "episode": saved })).into_response()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranslateGoogleBody {
    lines: Vec<String>,
    target_lang: Option<String>,
}

async fn translate_google(State(state): State<Arc<AppState>>, Json(body): Json<TranslateGoogleBody>) -> Response {
    if body.lines.is_empty() {
        return Json(json!({ "items": Vec::<String>::new() })).into_response();
    }
    let tl = body
        .target_lang
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("zh-CN")
        .to_string();

    let mut cached: HashMap<String, String> = HashMap::new();
    let mut missing: Vec<String> = Vec::new();
    {
        let conn = state.db.lock().unwrap();
        for line in &body.lines {
            let trimmed = line.trim();
            if trimmed.is_empty() || cached.contains_key(trimmed) {
                continue;
            }
            let key = format!("{tl}|{}", short_hash(trimmed, 24));
            match db::tr_get(&conn, &key) {
                Ok(Some(hit)) => {
                    cached.insert(trimmed.to_string(), hit);
                }
                _ => {
                    if !missing.iter().any(|m| m == trimmed) {
                        missing.push(trimmed.to_string());
                    }
                }
            }
        }
    }

    if !missing.is_empty() {
        let translated = match translate::translate_lines(&missing, &tl).await {
            Ok(v) => v,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        let conn = state.db.lock().unwrap();
        for (src, dst) in missing.into_iter().zip(translated.into_iter()) {
            let key = format!("{tl}|{}", short_hash(&src, 24));
            let _ = db::tr_put(&conn, &key, &dst);
            cached.insert(src, dst);
        }
    }

    let items: Vec<String> = body
        .lines
        .iter()
        .map(|l| {
            let trimmed = l.trim();
            if trimmed.is_empty() {
                String::new()
            } else {
                cached.get(trimmed).cloned().unwrap_or_default()
            }
        })
        .collect();
    Json(json!({ "items": items })).into_response()
}

async fn list_shows(State(state): State<Arc<AppState>>) -> Response {
    let conn = state.db.lock().unwrap();
    match db::list_shows(&conn) {
        Ok(shows) => Json(shows).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn remove_show(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db.lock().unwrap();
    match db::delete_show(&conn, &id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EpisodesQuery {
    show_id: Option<String>,
    limit: Option<i64>,
}

async fn list_episodes(State(state): State<Arc<AppState>>, Query(q): Query<EpisodesQuery>) -> Response {
    let conn = state.db.lock().unwrap();
    let limit = q.limit.unwrap_or(300).clamp(1, 1000);
    match db::list_episodes(&conn, q.show_id.as_deref(), limit) {
        Ok(eps) => Json(eps).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn recent_episodes(State(state): State<Arc<AppState>>) -> Response {
    let conn = state.db.lock().unwrap();
    match db::recent_episodes(&conn, 50) {
        Ok(eps) => Json(eps).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_episode(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let (mut ep, backfill_vid) = {
        let conn = state.db.lock().unwrap();
        match db::get_episode(&conn, &id) {
            Ok(Some(ep)) => {
                let _ = db::touch_episode(&conn, &id);
                let vid = if ep.show_id == "single"
                    && ep.video_id.is_some()
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
        if let Ok(Ok(info)) = tokio::time::timeout(std::time::Duration::from_secs(6), youtube::video_info(&vid)).await {
            let conn = state.db.lock().unwrap();
            let _ = db::update_episode_published(&conn, &id, info.published);
            let _ = db::set_blob(&conn, &id, "yt-pub-v1", "1");
            if let Ok(Some(updated)) = db::get_episode(&conn, &id) {
                ep = updated;
            } else {
                ep.published = info.published;
            }
        }
    }

    Json(ep).into_response()
}

async fn remove_episode(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let audio_url = {
        let conn = state.db.lock().unwrap();
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
struct ProgressBody {
    seconds: f64,
}

async fn set_progress(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<ProgressBody>,
) -> Response {
    let conn = state.db.lock().unwrap();
    match db::set_progress(&conn, &id, body.seconds) {
        Ok(completed) => Json(json!({ "ok": true, "completed": completed })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct CompletedBody {
    completed: bool,
}

async fn set_completed(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<CompletedBody>,
) -> Response {
    let conn = state.db.lock().unwrap();
    match db::set_completed(&conn, &id, body.completed) {
        Ok(Some(ep)) => Json(json!({ "ok": true, "episode": ep })).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "单集不存在"),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn get_transcript(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db.lock().unwrap();
    match db::get_transcript(&conn, &id) {
        Ok(tr) => Json(tr).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn fetch_official_transcript(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let ep = {
        let conn = state.db.lock().unwrap();
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

        let conn = state.db.lock().unwrap();
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
        let conn = state.db.lock().unwrap();
        if let Err(e) = db::save_transcript(&conn, &tr) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        return Json(json!({ "transcript": tr })).into_response();
    }

    api_error(StatusCode::NOT_FOUND, "该单集暂无官方字幕（后续阶段将接入离线/云端转写）")
}

async fn get_blob(
    State(state): State<Arc<AppState>>,
    AxumPath((id, kind)): AxumPath<(String, String)>,
) -> Response {
    let conn = state.db.lock().unwrap();
    match db::get_blob(&conn, &id, &kind) {
        Ok(data) => Json(json!({ "data": data })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[derive(Deserialize)]
struct BlobBody {
    data: String,
}

async fn set_blob(
    State(state): State<Arc<AppState>>,
    AxumPath((id, kind)): AxumPath<(String, String)>,
    Json(body): Json<BlobBody>,
) -> Response {
    let conn = state.db.lock().unwrap();
    match db::set_blob(&conn, &id, &kind, &body.data) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

async fn detect_agents() -> Response {
    Json(agents::detect().await).into_response()
}

#[derive(Deserialize)]
struct AgentKindBody {
    kind: String,
}

async fn warm_agent(Json(body): Json<AgentKindBody>) -> Response {
    if let Some(kind) = agents::Kind::parse(&body.kind) {
        if let Some(path) = agents::path_of(kind) {
            tokio::spawn(async move {
                agents::warm(kind, &path).await;
            });
        }
    }
    Json(json!({ "ok": true })).into_response()
}

async fn probe_agent(Json(body): Json<AgentKindBody>) -> Response {
    let Some(kind) = agents::Kind::parse(&body.kind) else {
        return api_error(StatusCode::BAD_REQUEST, format!("未知本机 AI：{}", body.kind));
    };
    let Some(path) = agents::path_of(kind) else {
        return api_error(StatusCode::BAD_REQUEST, format!("本机未找到 {}", agents::display(kind)));
    };
    match agents::probe(kind, &path).await {
        Ok(login) => Json(json!({ "login": login })).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn agent_models(Json(body): Json<AgentKindBody>) -> Response {
    let Some(kind) = agents::Kind::parse(&body.kind) else {
        return api_error(StatusCode::BAD_REQUEST, format!("未知本机 AI：{}", body.kind));
    };
    let Some(path) = agents::path_of(kind) else {
        return api_error(StatusCode::BAD_REQUEST, format!("本机未找到 {}", agents::display(kind)));
    };
    match agents::models(kind, &path).await {
        Ok(models) => Json(json!({ "models": models })).into_response(),
        Err(e) => api_error(StatusCode::BAD_REQUEST, e.to_string()),
    }
}

async fn has_key(AxumPath(provider): AxumPath<String>) -> Response {
    let has = llm::get_key(&provider).is_some_and(|k| !k.trim().is_empty());
    Json(json!({ "hasKey": has })).into_response()
}

#[derive(Deserialize)]
struct KeyBody {
    key: String,
}

async fn set_key(AxumPath(provider): AxumPath<String>, Json(body): Json<KeyBody>) -> Response {
    match llm::set_key(&provider, body.key.trim()) {
        Ok(()) => Json(json!({ "ok": true, "hasKey": !body.key.trim().is_empty() })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("保存钥匙串失败：{e}")),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LlmChatBody {
    request_id: Option<String>,
    provider: llm::Provider,
    system: String,
    messages: Vec<llm::Message>,
    max_tokens: Option<u32>,
    json_mode: Option<bool>,
}

fn format_cli_prompt(messages: &[llm::Message]) -> String {
    if messages.len() <= 1 {
        return messages.first().map(|m| m.content.clone()).unwrap_or_default();
    }
    let last_idx = messages.len() - 1;
    let history: Vec<String> = messages[..last_idx]
        .iter()
        .map(|m| {
            let role = if m.role == "assistant" { "助手" } else { "用户" };
            format!("{role}：{}", m.content)
        })
        .collect();
    format!("历史对话：\n{}\n\n当前问题：\n{}", history.join("\n\n"), messages[last_idx].content)
}

async fn llm_chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LlmChatBody>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let request_id = body.request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = state.start_job(&request_id);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let state_clone = state.clone();
    tokio::spawn(async move {
        let send_json = |v: Value| {
            let _ = tx.send(Ok(Event::default().data(v.to_string())));
        };

        let result: anyhow::Result<String> = if body.provider.protocol == "cli" {
            let Some(kind) = agents::Kind::parse(&body.provider.id) else {
                send_json(json!({ "type": "error", "message": format!("未知本地 Agent：{}", body.provider.id) }));
                state_clone.finish_job(&request_id, &cancel);
                return;
            };
            let Some(path) = agents::path_of(kind) else {
                send_json(json!({ "type": "error", "message": format!("本机未找到 {}", agents::display(kind)) }));
                state_clone.finish_job(&request_id, &cancel);
                return;
            };
            let user_prompt = format_cli_prompt(&body.messages);
            let model = (!body.provider.model.trim().is_empty()).then_some(body.provider.model.as_str());
            let req = agents::Request {
                system: &body.system,
                user: &user_prompt,
                model,
                json: body.json_mode.unwrap_or(false),
            };
            let tx_delta = tx.clone();
            agents::complete(kind, &path, req, cancel.clone(), move |delta| {
                let _ = tx_delta.send(Ok(Event::default().data(json!({ "type": "delta", "text": delta }).to_string())));
            })
            .await
        } else {
            let tx_delta = tx.clone();
            llm::chat(
                &body.provider,
                &body.system,
                &body.messages,
                body.max_tokens.unwrap_or(8000),
                body.json_mode.unwrap_or(false),
                &cancel,
                move |delta| {
                    let _ = tx_delta.send(Ok(Event::default().data(json!({ "type": "delta", "text": delta }).to_string())));
                },
            )
            .await
        };

        match result {
            Ok(full) => send_json(json!({ "type": "done", "text": full })),
            Err(err) => send_json(json!({ "type": "error", "message": err.to_string() })),
        }
        state_clone.finish_job(&request_id, &cancel);
    });

    Sse::new(UnboundedReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

async fn cancel_job(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    state.cancel_job(&id);
    Json(json!({ "ok": true })).into_response()
}

// ---- ASR models, transcription, YouTube stream fallback & cookies ------------------------------

async fn asr_models(State(state): State<Arc<AppState>>) -> Response {
    let models = asr::list_models(&state.data_dir);
    let qwen = models.iter().find(|m| m.id == asr::QWEN3_MODEL_ID);
    let any_model = models.iter().any(|m| m.installed);
    Json(json!({
        "modelId": asr::QWEN3_MODEL_ID,
        "name": qwen.map(|m| m.name.clone()).unwrap_or_else(|| "Qwen3-ASR 0.6B".into()),
        "sizeMb": qwen.map(|m| m.size_mb).unwrap_or(960),
        "modelReady": qwen.is_some_and(|m| m.installed) || any_model,
        "engineReady": asr::find_crispasr(&state.data_dir).is_some(),
        "ytdlpReady": asr::find_ytdlp(&state.data_dir).is_some(),
        "models": models,
    }))
    .into_response()
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct DownloadAsrBody {
    request_id: Option<String>,
    model_id: Option<String>,
    mirror_first: Option<bool>,
}

async fn download_asr_models(
    State(state): State<Arc<AppState>>,
    Json(body): Json<DownloadAsrBody>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let request_id = body.request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let model_id = body
        .model_id
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(asr::QWEN3_MODEL_ID)
        .to_string();
    let mirror_first = body.mirror_first.unwrap_or(true);
    let cancel = state.start_job(&request_id);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let state_clone = state.clone();
    tokio::spawn(async move {
        let send = |v: Value| {
            let _ = tx.send(Ok(Event::default().data(v.to_string())));
        };

        let res: anyhow::Result<()> = async {
            if asr::find_crispasr(&state_clone.data_dir).is_none() {
                send(json!({ "type": "progress", "stage": "正在下载 CrispASR 推理引擎（约 20 MB）...", "pct": 0.0 }));
                let tx_p = tx.clone();
                asr::install_crispasr(&state_clone.data_dir, &cancel, move |received, total| {
                    let pct = total.filter(|&t| t > 0).map(|t| (received as f64 / t as f64) * 0.15).unwrap_or(0.05);
                    let _ = tx_p.send(Ok(Event::default().data(
                        json!({
                            "type": "progress",
                            "stage": format!("正在下载 CrispASR（{:.1} MB）...", received as f64 / 1_048_576.0),
                            "received": received,
                            "total": total,
                            "pct": pct,
                        })
                        .to_string(),
                    )));
                })
                .await?;
            }

            if asr::resolve_qwen_model(&state_clone.data_dir, Some(&model_id)).is_none() {
                send(json!({ "type": "progress", "stage": "正在下载 Qwen3-ASR 0.6B 模型（约 960 MB）...", "pct": 0.15 }));
                let tx_p = tx.clone();
                asr::download_model(&state_clone.data_dir, &model_id, &cancel, mirror_first, move |received, total| {
                    let frac = total.filter(|&t| t > 0).map(|t| received as f64 / t as f64).unwrap_or(0.0);
                    let _ = tx_p.send(Ok(Event::default().data(
                        json!({
                            "type": "progress",
                            "stage": format!(
                                "正在下载 Qwen3-ASR 0.6B（{:.0}/{:.0} MB）",
                                received as f64 / 1_048_576.0,
                                total.unwrap_or(960 * 1_048_576) as f64 / 1_048_576.0
                            ),
                            "received": received,
                            "total": total,
                            "pct": 0.15 + frac * 0.85,
                        })
                        .to_string(),
                    )));
                })
                .await?;
            }
            Ok(())
        }
        .await;

        match res {
            Ok(()) => send(json!({ "type": "done", "modelId": model_id })),
            Err(err) => send(json!({ "type": "error", "message": err.to_string() })),
        }
        state_clone.finish_job(&request_id, &cancel);
    });

    Sse::new(UnboundedReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TranscribeBody {
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
        let conn = state.db.lock().unwrap();
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

    let (crisp_bin, qwen_model, cloud_cfg) = if body.engine == "cloud" {
        let cfg = body.cloud.clone().ok_or_else(|| anyhow::anyhow!("缺少云端语音识别配置"))?;
        cloud::resolve_key(&cfg)?;
        (None, None, Some(cfg))
    } else {
        let bin = asr::find_crispasr(&state.data_dir)
            .ok_or_else(|| anyhow::anyhow!("尚未安装 CrispASR 推理程序，请先在「设置 › 语音转写」一键下载"))?;
        let model = asr::resolve_qwen_model(&state.data_dir, body.model_id.as_deref())
            .ok_or_else(|| anyhow::anyhow!("尚未安装 Qwen3-ASR 离线模型，请先在「设置 › 语音转写」一键下载"))?;
        (Some(bin), Some(model), None)
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

        let (raw_segs, source_name) = if let Some(cfg) = cloud_cfg {
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
            (segs, "cloud".to_string())
        } else {
            let wav_path = job_dir.join("input.wav");
            let wp = wav_path.clone();
            tokio::task::spawn_blocking(move || asr::write_wav(&wp, &samples)).await??;
            send(json!({ "type": "progress", "stage": "Qwen3-ASR 离线转写中...", "pct": 0.28 }));
            let tx_p = tx.clone();
            let segs = asr::run_crispasr(
                crisp_bin.as_deref().unwrap(),
                qwen_model.as_deref().unwrap(),
                &wav_path,
                &lang,
                &ctx,
                cancel.clone(),
                move |p| {
                    let _ = tx_p.send(Ok(Event::default().data(
                        json!({
                            "type": "progress",
                            "stage": format!("Qwen3-ASR 识别中（{:.0}%）...", p * 100.0),
                            "pct": 0.28 + p * 0.68,
                        })
                        .to_string(),
                    )));
                },
            )
            .await?;
            (segs, "qwen3".to_string())
        };

        let filtered: Vec<Segment> = raw_segs
            .into_iter()
            .filter(|s| ctx.background.is_empty() || !asr_context::is_echo(&s.text, &ctx.background))
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
        let conn = state.db.lock().unwrap();
        db::save_transcript(&conn, &tr)?;
        Ok(tr)
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&job_dir).await;
    result
}

async fn transcribe_episode(
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

#[derive(Deserialize)]
struct StreamQuery {
    fresh: Option<bool>,
}

async fn episode_stream_url(
    State(state): State<Arc<AppState>>,
    AxumPath(id): AxumPath<String>,
    Query(q): Query<StreamQuery>,
) -> Response {
    let video_id = {
        let conn = state.db.lock().unwrap();
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
    match asr::with_ytdlp(&state.data_dir, |bin| {
        let d = data.clone();
        let vid = video_id.clone();
        async move { asr::youtube_stream_url(&d, &bin, &vid, fresh).await }
    })
    .await
    {
        Ok(url) => Json(json!({ "url": url })).into_response(),
        Err(e) => api_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn get_cookies(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "hasCookies": asr::has_cookies(&state.data_dir) })).into_response()
}

#[derive(Deserialize)]
struct CookiesBody {
    text: String,
}

async fn set_cookies(State(state): State<Arc<AppState>>, Json(body): Json<CookiesBody>) -> Response {
    match asr::save_cookies(&state.data_dir, &body.text) {
        Ok(has) => Json(json!({ "ok": true, "hasCookies": has })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("保存 Cookie 失败：{e}")),
    }
}

async fn ping_sse() -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<Event, Infallible>>(8);
    tokio::spawn(async move {
        let payloads: [Value; 3] = [
            json!({ "step": 1, "message": "SSE 通道已建立", "done": false }),
            json!({ "step": 2, "message": "本地 Rust 底座流式推送正常", "done": false }),
            json!({ "step": 3, "message": "阶段 1 流式探针完成", "done": true }),
        ];
        for payload in payloads {
            tokio::time::sleep(Duration::from_millis(100)).await;
            if tx.send(Ok(Event::default().data(payload.to_string()))).await.is_err() {
                break;
            }
        }
    });
    Sse::new(ReceiverStream::new(rx)).keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn allows_only_localhost_origins() {
        assert!(is_local_origin(&HeaderValue::from_static("http://127.0.0.1:1420")));
        assert!(is_local_origin(&HeaderValue::from_static("http://localhost:14327")));
        assert!(!is_local_origin(&HeaderValue::from_static("https://evil.example.com")));
    }

    #[test]
    fn formats_cli_multi_turn_context() {
        let one = vec![llm::Message { role: "user".into(), content: "hi".into() }];
        assert_eq!(format_cli_prompt(&one), "hi");
        let many = vec![
            llm::Message { role: "user".into(), content: "q1".into() },
            llm::Message { role: "assistant".into(), content: "a1".into() },
            llm::Message { role: "user".into(), content: "q2".into() },
        ];
        let prompt = format_cli_prompt(&many);
        assert!(prompt.contains("用户：q1") && prompt.contains("助手：a1") && prompt.ends_with("当前问题：\nq2"));
    }

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
