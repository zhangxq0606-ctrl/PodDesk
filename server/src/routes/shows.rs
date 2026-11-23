use super::{api_error, AppState};
use crate::{db, feeds, model::*, youtube};
use axum::{
    extract::{Path as AxumPath, Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};

#[derive(Deserialize)]
pub struct SubscriptionInput {
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
    let mut conn = state.db_lock();
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

pub async fn add_subscription(State(state): State<Arc<AppState>>, Json(body): Json<SubscriptionInput>) -> Response {
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
                let mut conn = state.db_lock();
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
        let mut conn = state.db_lock();
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
pub struct SearchQuery {
    term: String,
    country: Option<String>,
}

pub async fn search_shows(Query(q): Query<SearchQuery>) -> Response {
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

pub async fn list_shows(State(state): State<Arc<AppState>>) -> Response {
    let conn = state.db_lock();
    match db::list_shows(&conn) {
        Ok(shows) => Json(shows).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn remove_show(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db_lock();
    match db::delete_show(&conn, &id) {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn refresh_show(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let existing = {
        let conn = state.db_lock();
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
        let mut conn = state.db_lock();
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

pub async fn refresh_all_shows(State(state): State<Arc<AppState>>) -> Response {
    if REFRESHING_ALL.swap(true, Ordering::SeqCst) {
        return Json(json!({ "shows": 0, "newEpisodes": 0, "skipped": true })).into_response();
    }
    let _guard = RefreshAllGuard;

    let shows = {
        let conn = state.db_lock();
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
        let mut conn = state.db_lock();
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

pub async fn load_more_show(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let (show, cont_raw, total_before) = {
        let conn = state.db_lock();
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
            let mut conn = state.db_lock();
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
        let mut conn = state.db_lock();
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

pub async fn mark_show_all_completed(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db_lock();
    match db::mark_show_completed(&conn, &id) {
        Ok(updated) => Json(json!({ "ok": true, "updated": updated })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
