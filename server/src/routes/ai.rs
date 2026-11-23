use super::{api_error, AppState};
use crate::{agents, db, llm, model::short_hash, translate};
use axum::{
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{collections::HashMap, convert::Infallible, sync::Arc};
use tokio_stream::{wrappers::UnboundedReceiverStream, Stream};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslateGoogleBody {
    lines: Vec<String>,
    target_lang: Option<String>,
}

pub async fn translate_google(
    State(state): State<Arc<AppState>>,
    Json(body): Json<TranslateGoogleBody>,
) -> Response {
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
        let conn = state.db_lock();
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
        let conn = state.db_lock();
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

pub async fn detect_agents() -> Response {
    Json(agents::detect().await).into_response()
}

#[derive(Deserialize)]
pub struct AgentKindBody {
    kind: String,
}

pub async fn warm_agent(Json(body): Json<AgentKindBody>) -> Response {
    if let Some(kind) = agents::Kind::parse(&body.kind) {
        if let Some(path) = agents::path_of(kind) {
            tokio::spawn(async move {
                agents::warm(kind, &path).await;
            });
        }
    }
    Json(json!({ "ok": true })).into_response()
}

pub async fn probe_agent(Json(body): Json<AgentKindBody>) -> Response {
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

pub async fn agent_models(Json(body): Json<AgentKindBody>) -> Response {
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmChatBody {
    request_id: Option<String>,
    provider: llm::Provider,
    system: String,
    messages: Vec<llm::Message>,
    max_tokens: Option<u32>,
    json_mode: Option<bool>,
    quick: Option<bool>,
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

pub async fn llm_chat(
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
                body.quick.unwrap_or(false),
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

#[cfg(test)]
mod tests {
    use super::*;

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
}
