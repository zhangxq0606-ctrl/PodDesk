pub mod ai;
pub mod asr;
pub mod episodes;
pub mod settings;
pub mod shows;

use crate::net;
#[cfg(test)]
use crate::db;
use axum::{
    extract::{DefaultBodyLimit, State},
    http::{HeaderValue, Method, StatusCode},
    response::{
        sse::{Event, KeepAlive, Sse},
        Html, IntoResponse, Json, Response,
    },
    routing::{delete, get, post},
    Router,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    convert::Infallible,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, MutexGuard,
    },
    time::Duration,
};
use tokio_stream::{wrappers::ReceiverStream, Stream};
use tower_http::{
    cors::{AllowOrigin, CorsLayer},
    services::{ServeDir, ServeFile},
};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub data_dir: PathBuf,
    pub port: u16,
    pub jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
    pub pub_backfills: Mutex<HashSet<String>>,
    pub quit_tx: Mutex<Option<tokio::sync::oneshot::Sender<()>>>,
    pub yt_login: Option<Arc<dyn crate::YtLoginBridge>>,
}

impl AppState {
    pub(crate) fn db_lock(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn start_job(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.jobs
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id.to_string(), flag.clone());
        flag
    }

    pub(crate) fn finish_job(&self, id: &str, flag: &Arc<AtomicBool>) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        if jobs.get(id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            jobs.remove(id);
        }
    }

    pub(crate) fn cancel_job(&self, id: &str) {
        if let Some(flag) = self.jobs.lock().unwrap_or_else(|e| e.into_inner()).get(id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    pub fn active_job_count(&self) -> usize {
        self.jobs.lock().unwrap_or_else(|e| e.into_inner()).len()
    }

    pub fn cancel_all_jobs(&self) {
        for flag in self.jobs.lock().unwrap_or_else(|e| e.into_inner()).values() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

pub(crate) fn api_error(status: StatusCode, msg: impl Into<String>) -> Response {
    (status, Json(json!({ "error": msg.into() }))).into_response()
}

pub(crate) fn is_local_origin(origin: &HeaderValue) -> bool {
    let Ok(s) = origin.to_str() else { return false };
    s.starts_with("http://127.0.0.1:")
        || s.starts_with("http://localhost:")
        || s == "http://127.0.0.1"
        || s == "http://localhost"
}

#[derive(rust_embed::RustEmbed)]
#[folder = "../dist"]
struct EmbeddedDist;

pub fn router(state: Arc<AppState>, dist_dir: Option<PathBuf>) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(AllowOrigin::predicate(|origin, _| is_local_origin(origin)))
        .allow_methods([Method::GET, Method::POST, Method::DELETE])
        .allow_headers([axum::http::header::CONTENT_TYPE, axum::http::header::RANGE]);

    let media_dir = state.data_dir.join("media");
    let media_upload = Router::new()
        .route("/api/episodes/import-media", post(episodes::import_media))
        .layer(DefaultBodyLimit::max(512 * 1024 * 1024));

    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/settings", get(settings::get_settings).post(settings::save_settings))
        .route("/api/search", get(shows::search_shows))
        .route("/api/shows", get(shows::list_shows))
        .route("/api/shows/refresh-all", post(shows::refresh_all_shows))
        .route("/api/shows/{id}", delete(shows::remove_show))
        .route("/api/shows/{id}/refresh", post(shows::refresh_show))
        .route("/api/shows/{id}/load-more", post(shows::load_more_show))
        .route("/api/shows/{id}/mark-all-completed", post(shows::mark_show_all_completed))
        .route("/api/subscriptions", post(shows::add_subscription))
        .route("/api/episodes", get(episodes::list_episodes))
        .route("/api/episodes/recent", get(episodes::recent_episodes))
        .route("/api/episodes/import-text", post(episodes::import_text))
        .merge(media_upload)
        .route("/api/episodes/{id}", get(episodes::get_episode).delete(episodes::remove_episode))
        .route("/api/episodes/{id}/progress", post(episodes::set_progress))
        .route("/api/episodes/{id}/completed", post(episodes::set_completed))
        .route("/api/episodes/{id}/transcript", get(episodes::get_transcript))
        .route("/api/episodes/{id}/transcript/official", post(episodes::fetch_official_transcript))
        .route("/api/episodes/{id}/transcribe", post(asr::transcribe_episode))
        .route("/api/episodes/{id}/stream-url", get(episodes::episode_stream_url))
        .route("/api/episodes/{id}/blobs/{kind}", get(episodes::get_blob).post(episodes::set_blob))
        .route("/api/asr/models", get(asr::asr_models))
        .route("/api/asr/models/download", post(asr::download_asr_models))
        .route("/api/asr/probe", post(asr::probe_asr_runtime))
        .route("/api/cookies", get(settings::get_cookies).post(settings::set_cookies))
        .route("/api/youtube/auth", get(settings::get_youtube_auth))
        .route("/api/youtube/auth/login", post(settings::open_youtube_login))
        .route("/api/youtube/auth/logout", post(settings::logout_youtube))
        .route("/api/network/check", get(settings::network_check))
        .route("/api/agents", get(ai::detect_agents))
        .route("/api/agents/warm", post(ai::warm_agent))
        .route("/api/agents/probe", post(ai::probe_agent))
        .route("/api/agents/models", post(ai::agent_models))
        .route("/api/keys/{provider}", get(settings::has_key).post(settings::set_key))
        .route("/api/llm/chat", post(ai::llm_chat))
        .route("/api/llm/metrics", get(ai::llm_metrics))
        .route("/api/jobs/active", get(active_jobs))
        .route("/api/jobs/{id}/cancel", post(cancel_job))
        .route("/api/app/update", get(app_update))
        .route("/api/app/quit", post(app_quit))
        .route("/api/events/ping", get(ping_sse))
        .nest_service("/api/media", ServeDir::new(media_dir))
        .with_state(state)
        .layer(cors);

    if let Some(dir) = dist_dir {
        let index = dir.join("index.html");
        if index.is_file() {
            let spa = ServeDir::new(&dir).not_found_service(ServeFile::new(index));
            return api.fallback_service(spa);
        }
    }
    if EmbeddedDist::get("index.html").is_some() {
        api.fallback(get(serve_embedded))
    } else {
        api.fallback(get(missing_frontend))
    }
}

async fn serve_embedded(uri: axum::http::Uri) -> Response {
    let rel = uri.path().trim_start_matches('/');
    let key = if rel.is_empty() { "index.html" } else { rel };
    let (resolved, file) = match EmbeddedDist::get(key) {
        Some(f) => (key, f),
        None => match EmbeddedDist::get("index.html") {
            Some(f) => ("index.html", f),
            None => return missing_frontend().await.into_response(),
        },
    };
    let mime = mime_guess::from_path(resolved).first_or_octet_stream();
    (
        [(axum::http::header::CONTENT_TYPE, mime.as_ref().to_string())],
        file.data.into_owned(),
    )
        .into_response()
}

async fn missing_frontend() -> Html<&'static str> {
    Html(
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'><title>PodDesk</title></head>\
         <body style='font-family:system-ui,sans-serif;max-width:620px;margin:48px auto;padding:0 16px;'>\
         <h2>PodDesk 后端服务已启动</h2>\
         <p>未找到前端构建产物 <code>dist/index.html</code>。请在项目根目录执行 <code>npm run build</code>，或使用 Vite 开发模式 <code>npm run dev</code>。</p>\
         </body></html>",
    )
}

async fn health(State(state): State<Arc<AppState>>) -> Response {
    let shows_count = {
        let conn = state.db_lock();
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
        "githubMirror": net::github_mirror(),
        "activeJobs": state.active_job_count(),
        "ytLoginSupported": state.yt_login.is_some(),
    }))
    .into_response()
}

#[derive(serde::Deserialize, Default)]
struct UpdateQuery {
    force: Option<String>,
}

async fn app_update(axum::extract::Query(q): axum::extract::Query<UpdateQuery>) -> Response {
    let force = q
        .force
        .as_deref()
        .is_some_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));
    match crate::update::check(force).await {
        Ok(info) => Json(info).into_response(),
        Err(e) => api_error(StatusCode::BAD_GATEWAY, e.to_string()),
    }
}

async fn cancel_job(
    State(state): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Response {
    state.cancel_job(&id);
    Json(json!({ "ok": true })).into_response()
}

async fn active_jobs(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "count": state.active_job_count() })).into_response()
}

async fn app_quit(State(state): State<Arc<AppState>>) -> Response {
    state.cancel_all_jobs();
    if let Some(tx) = state.quit_tx.lock().unwrap_or_else(|e| e.into_inner()).take() {
        let _ = tx.send(());
    }
    Json(json!({ "ok": true })).into_response()
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
    fn tracks_and_cancels_active_jobs() {
        let path = std::env::temp_dir().join(format!("pdesk-jobs-test-{}.sqlite", uuid::Uuid::new_v4()));
        let conn = db::open(&path).unwrap();
        let state = AppState {
            db: Mutex::new(conn),
            data_dir: std::env::temp_dir(),
            port: 14327,
            jobs: Mutex::new(HashMap::new()),
            pub_backfills: Mutex::new(HashSet::new()),
            quit_tx: Mutex::new(None),
            yt_login: None,
        };
        assert_eq!(state.active_job_count(), 0);
        let f1 = state.start_job("j1");
        let f2 = state.start_job("j2");
        assert_eq!(state.active_job_count(), 2);
        state.cancel_all_jobs();
        assert!(f1.load(Ordering::Relaxed));
        assert!(f2.load(Ordering::Relaxed));
        state.finish_job("j1", &f1);
        assert_eq!(state.active_job_count(), 1);
        drop(state);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(path.with_extension("sqlite-wal"));
        let _ = std::fs::remove_file(path.with_extension("sqlite-shm"));
    }
}
