use super::{api_error, AppState};
use crate::{asr, db, llm, net};
use axum::{
    extract::{Path as AxumPath, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, sync::Arc};

pub async fn get_settings(State(state): State<Arc<AppState>>) -> Response {
    let conn = state.db_lock();
    match db::list_settings(&conn) {
        Ok(map) => Json(map).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn save_settings(
    State(state): State<Arc<AppState>>,
    Json(patch): Json<HashMap<String, String>>,
) -> Response {
    if let Some(p) = patch.get("proxy") {
        if let Err(e) = net::set_proxy(p) {
            return api_error(StatusCode::BAD_REQUEST, e.to_string());
        }
        asr::streams::clear();
    }
    if let Some(m) = patch.get("githubMirror") {
        if let Err(e) = net::set_github_mirror(m) {
            return api_error(StatusCode::BAD_REQUEST, e.to_string());
        }
    }
    {
        let conn = state.db_lock();
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
        "githubMirror": net::github_mirror(),
    }))
    .into_response()
}

pub async fn has_key(AxumPath(provider): AxumPath<String>) -> Response {
    let has = llm::get_key(&provider).is_some_and(|k| !k.trim().is_empty());
    Json(json!({ "hasKey": has })).into_response()
}

#[derive(Deserialize)]
pub struct KeyBody {
    key: String,
}

pub async fn set_key(AxumPath(provider): AxumPath<String>, Json(body): Json<KeyBody>) -> Response {
    match llm::set_key(&provider, body.key.trim()) {
        Ok(()) => Json(json!({ "ok": true, "hasKey": !body.key.trim().is_empty() })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("保存钥匙串失败：{e}")),
    }
}

pub async fn get_cookies(State(state): State<Arc<AppState>>) -> Response {
    Json(json!({ "hasCookies": asr::has_cookies(&state.data_dir) })).into_response()
}

#[derive(Deserialize)]
pub struct CookiesBody {
    text: String,
}

pub async fn set_cookies(State(state): State<Arc<AppState>>, Json(body): Json<CookiesBody>) -> Response {
    match asr::save_cookies(&state.data_dir, &body.text) {
        Ok(has) => Json(json!({ "ok": true, "hasCookies": has })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, format!("保存 Cookie 失败：{e}")),
    }
}

pub async fn get_youtube_auth(State(state): State<Arc<AppState>>) -> Response {
    let Some(bridge) = state.yt_login.clone() else {
        return Json(json!({ "supported": false, "signedIn": false })).into_response();
    };
    let signed_in = tokio::task::spawn_blocking(move || bridge.is_signed_in())
        .await
        .unwrap_or(false);
    Json(json!({ "supported": true, "signedIn": signed_in })).into_response()
}

pub async fn open_youtube_login(State(state): State<Arc<AppState>>) -> Response {
    let Some(bridge) = state.yt_login.as_ref() else {
        return api_error(
            StatusCode::BAD_REQUEST,
            "当前仅桌面端支持内置 YouTube 登录窗口，请使用下方的 cookies.txt 导入",
        );
    };
    match bridge.open_login() {
        Ok(()) => Json(json!({ "ok": true })).into_response(),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}

pub async fn logout_youtube(State(state): State<Arc<AppState>>) -> Response {
    let Some(bridge) = state.yt_login.clone() else {
        return Json(json!({ "ok": true, "signedIn": false })).into_response();
    };
    match tokio::task::spawn_blocking(move || bridge.sign_out()).await {
        Ok(Ok(())) => Json(json!({ "ok": true, "signedIn": false })).into_response(),
        Ok(Err(e)) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
        Err(e) => api_error(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    }
}
