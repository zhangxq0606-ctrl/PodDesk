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

const YT_PAGE_SLICE: usize = 30;

fn slice_page_items(mut items: Vec<youtube::PageVideo>, limit: usize) -> (Vec<youtube::PageVideo>, Vec<youtube::PageVideo>) {
    let split = limit.min(items.len());
    let tail = items.split_off(split);
    (items, tail)
}

fn build_cont_state(
    batch: &youtube::PageBatch,
    buffered: Vec<youtube::PageVideo>,
) -> Option<youtube::ContinuationState> {
    batch.api_key.as_ref().map(|key| {
        let exhausted = buffered.is_empty() && batch.continuation.is_none();
        youtube::ContinuationState {
            token: batch.continuation.clone(),
            api_key: key.clone(),
            client_version: batch
                .client_version
                .clone()
                .unwrap_or_else(|| "2.20250101.00.00".to_string()),
            exhausted,
            buffered,
        }
    })
}

struct BackfillGuard {
    state: Arc<AppState>,
    show_id: String,
}

impl Drop for BackfillGuard {
    fn drop(&mut self) {
        self.state
            .pub_backfills
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&self.show_id);
    }
}

/// Low-concurrency background calibration for YouTube channel episodes lacking exact `publishDate`.
pub(crate) fn spawn_youtube_pub_backfill(state: Arc<AppState>, show_id: String) {
    {
        let mut active = state.pub_backfills.lock().unwrap_or_else(|e| e.into_inner());
        if !active.insert(show_id.clone()) {
            return;
        }
    }
    tokio::spawn(async move {
        let _guard = BackfillGuard {
            state: state.clone(),
            show_id: show_id.clone(),
        };
        let targets = {
            let conn = state.db_lock();
            if db::get_show(&conn, &show_id).ok().flatten().is_none_or(|s| s.kind != "youtube") {
                return;
            }
            db::list_youtube_episodes_needing_pub_date(&conn, &show_id, 120).unwrap_or_default()
        };
        if targets.is_empty() {
            return;
        }
        for chunk in targets.chunks(3) {
            let still_exists = {
                let conn = state.db_lock();
                db::get_show(&conn, &show_id).ok().flatten().is_some()
            };
            if !still_exists {
                break;
            }
            let mut handles = Vec::with_capacity(chunk.len());
            for (ep_id, vid) in chunk {
                let ep_id = ep_id.clone();
                let vid = vid.clone();
                handles.push(tokio::spawn(async move {
                    (ep_id, youtube::fetch_publish_date(&vid).await)
                }));
            }
            for h in handles {
                if let Ok((ep_id, Some(ts))) = h.await {
                    let conn = state.db_lock();
                    let _ = db::update_episode_published(&conn, &ep_id, Some(ts));
                    let _ = db::set_blob(&conn, &ep_id, "yt-pub-v1", "1");
                }
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    });
}

async fn fetch_youtube_initial(
    url: &str,
) -> Result<(Show, Vec<Episode>, Option<youtube::ContinuationState>, Vec<String>), String> {
    let (rss_res, page_res) = tokio::join!(
        fetch_feed_with_fallback(url, "youtube"),
        youtube::fetch_channel_initial(url),
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
            let mut exact_ids: Vec<String> = Vec::new();
            for ep in &mut rss_eps {
                if ep.published.is_some() {
                    exact_ids.push(ep.id.clone());
                }
                if let Some(vid) = ep.video_id.as_deref() {
                    seen.insert(vid.to_string());
                    if let Some(pv) = page_map.get(vid) {
                        ep.duration = ep.duration.or(pv.duration);
                        ep.cover = Some(pv.cover.clone());
                    }
                }
            }
            let mut extra: Vec<youtube::PageVideo> = Vec::new();
            for pv in &batch.items {
                if seen.insert(pv.video_id.clone()) {
                    extra.push(pv.clone());
                }
            }
            let take_n = YT_PAGE_SLICE.saturating_sub(rss_eps.len());
            let (head, tail) = slice_page_items(extra, take_n);
            for pv in &head {
                rss_eps.push(page_video_to_episode(&show.id, pv));
            }
            let cont = build_cont_state(&batch, tail);
            Ok((show, rss_eps, cont, exact_ids))
        }
        (Ok((show, rss_eps)), Err(_)) => {
            let exact_ids = rss_eps.iter().filter(|e| e.published.is_some()).map(|e| e.id.clone()).collect();
            Ok((show, rss_eps, None, exact_ids))
        }
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
            let (head, tail) = slice_page_items(batch.items.clone(), YT_PAGE_SLICE);
            let eps: Vec<Episode> = head.iter().map(|pv| page_video_to_episode(&show_id, pv)).collect();
            let cont = build_cont_state(&batch, tail);
            Ok((show, eps, cont, Vec::new()))
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

    let (show, eps, yt_cont, exact_ids) = match resolved {
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
            Ok((s, e)) => (s, e, None, Vec::new()),
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        },
        feeds::Source::Feed(url) if url.contains("youtube.com") => match fetch_youtube_initial(&url).await {
            Ok(quad) => quad,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e),
        },
        feeds::Source::Feed(url) => match fetch_feed_with_fallback(&url, "podcast").await {
            Ok((s, e)) => (s, e, None, Vec::new()),
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e),
        },
    };

    if eps.is_empty() {
        return api_error(StatusCode::UNPROCESSABLE_ENTITY, "这个订阅源里没有可播放的节目");
    }

    let has_more = yt_cont.as_ref().is_some_and(|c| !c.exhausted);

    {
        let mut conn = state.db_lock();
        if let Err(e) = db::upsert_show(&conn, &show) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if let Err(e) = db::upsert_episodes(&mut conn, &eps) {
            return api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string());
        }
        if !exact_ids.is_empty() {
            let _ = db::mark_episodes_pub_verified(&mut conn, &exact_ids);
        }
        if let Some(cont) = yt_cont {
            if let Ok(raw) = serde_json::to_string(&cont) {
                let _ = db::set_blob(&conn, &show.id, "yt-cont", &raw);
            }
        }
    }

    if show.kind == "youtube" {
        spawn_youtube_pub_backfill(state.clone(), show.id.clone());
    }

    Json(json!({ "show": show, "episodesCount": eps.len(), "hasMore": has_more })).into_response()
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
        if existing.kind == "youtube" {
            let exact_ids: Vec<String> = eps.iter().filter(|e| e.published.is_some()).map(|e| e.id.clone()).collect();
            let _ = db::mark_episodes_pub_verified(&mut conn, &exact_ids);
        }
    }
    if existing.kind == "youtube" {
        spawn_youtube_pub_backfill(state.clone(), existing.id);
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
            if existing.kind == "youtube" {
                let exact_ids: Vec<String> = eps.iter().filter(|e| e.published.is_some()).map(|e| e.id.clone()).collect();
                let _ = db::mark_episodes_pub_verified(&mut conn, &exact_ids);
            }
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
        let batch = match youtube::fetch_channel_initial(&show.feed_url).await {
            Ok(b) => b,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        let existing_vids: HashSet<String> = {
            let conn = state.db_lock();
            db::list_episodes(&conn, Some(&id), 1000)
                .unwrap_or_default()
                .into_iter()
                .filter_map(|e| e.video_id)
                .collect()
        };
        let unseen: Vec<youtube::PageVideo> = batch
            .items
            .iter()
            .filter(|pv| !existing_vids.contains(&pv.video_id))
            .cloned()
            .collect();
        let (head, tail) = slice_page_items(unseen, YT_PAGE_SLICE);
        let eps: Vec<Episode> = head.iter().map(|pv| page_video_to_episode(&show.id, pv)).collect();
        let cont = build_cont_state(&batch, tail);
        let has_more = cont.as_ref().is_some_and(|c| !c.exhausted);

        let (added, total, updated_show) = {
            let mut conn = state.db_lock();
            let mut next_show = show.clone();
            if let Some(av) = &batch.avatar {
                next_show.cover = Some(av.clone());
            }
            if let Some(desc) = &batch.description {
                next_show.description = Some(desc.clone());
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

        spawn_youtube_pub_backfill(state.clone(), id);
        return Json(json!({ "added": added, "total": total, "hasMore": has_more, "show": updated_show })).into_response();
    };

    let mut cont: youtube::ContinuationState = match serde_json::from_str(&raw) {
        Ok(c) => c,
        Err(_) => return Json(json!({ "added": 0, "total": total_before, "hasMore": false })).into_response(),
    };
    if cont.buffered.is_empty() {
        let Some(token) = cont.token.clone().filter(|t| !cont.exhausted && !t.is_empty()) else {
            return Json(json!({ "added": 0, "total": total_before, "hasMore": false })).into_response();
        };
        let (items, next_token) = match youtube::fetch_browse_continuation(&cont.api_key, &cont.client_version, &token).await {
            Ok(pair) => pair,
            Err(e) => return api_error(StatusCode::BAD_GATEWAY, e.to_string()),
        };
        cont.buffered = items;
        cont.token = next_token;
    }

    let (head, tail) = slice_page_items(std::mem::take(&mut cont.buffered), YT_PAGE_SLICE);
    cont.buffered = tail;
    cont.exhausted = cont.buffered.is_empty() && cont.token.is_none();
    let eps: Vec<Episode> = head.iter().map(|pv| page_video_to_episode(&show.id, pv)).collect();
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

    spawn_youtube_pub_backfill(state.clone(), id);
    Json(json!({ "added": added, "total": total, "hasMore": has_more })).into_response()
}

pub async fn mark_show_all_completed(State(state): State<Arc<AppState>>, AxumPath(id): AxumPath<String>) -> Response {
    let conn = state.db_lock();
    match db::mark_show_completed(&conn, &id) {
        Ok(updated) => Json(json!({ "ok": true, "updated": updated })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pv(n: usize) -> youtube::PageVideo {
        youtube::PageVideo {
            video_id: format!("vid_{n}"),
            title: format!("Ep {n}"),
            duration: Some(600.0),
            published: None,
            cover: format!("https://i.ytimg.com/vi/vid_{n}/mqdefault.jpg"),
        }
    }

    #[test]
    fn slices_and_buffers_large_playlist_batches() {
        let items: Vec<_> = (0..100).map(pv).collect();
        let (head, tail) = slice_page_items(items, YT_PAGE_SLICE.saturating_sub(12));
        assert_eq!(head.len(), 18);
        assert_eq!(tail.len(), 82);

        let batch = youtube::PageBatch {
            api_key: Some(String::new()),
            continuation: None,
            ..Default::default()
        };
        let mut cont = build_cont_state(&batch, tail).unwrap();
        assert!(!cont.exhausted);

        let (p2, rest2) = slice_page_items(std::mem::take(&mut cont.buffered), YT_PAGE_SLICE);
        assert_eq!(p2.len(), 30);
        assert_eq!(rest2.len(), 52);
        assert_eq!(p2[0].video_id, "vid_18");
    }
}
