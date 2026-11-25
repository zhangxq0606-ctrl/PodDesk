use super::{api_error, AppState};
use crate::{agents, llm};
use axum::{
    extract::State,
    http::StatusCode,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Json, Response,
    },
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    convert::Infallible,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    task::{Context, Poll},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio_stream::{wrappers::UnboundedReceiverStream, Stream};

const MAX_RECENT_TRACES: usize = 40;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderMetric {
    pub calls: u64,
    pub errors: u64,
    pub rate_limits: u64,
    pub cancelled: u64,
    pub ttft_samples: u64,
    pub ttft_sum_ms: u64,
    pub total_sum_ms: u64,
    pub avg_ttft_ms: Option<u64>,
    pub avg_total_ms: u64,
    pub last_ttft_ms: Option<u64>,
    pub last_total_ms: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentLlmTrace {
    pub at_ms: u64,
    pub provider: String,
    pub priority: String,
    pub ttft_ms: Option<u64>,
    pub total_ms: u64,
    pub ok: bool,
    pub cancelled: bool,
    pub error: Option<String>,
}

#[derive(Default)]
struct MetricsStore {
    providers: HashMap<String, ProviderMetric>,
    recent: VecDeque<RecentLlmTrace>,
}

static AI_METRICS: once_cell::sync::Lazy<Mutex<MetricsStore>> =
    once_cell::sync::Lazy::new(|| Mutex::new(MetricsStore::default()));

fn now_unix_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn is_rate_limit_text(msg: &str) -> bool {
    let l = msg.to_lowercase();
    l.contains("429")
        || l.contains("rate limit")
        || l.contains("usage limit")
        || l.contains("quota")
        || l.contains("resource exhausted")
        || msg.contains("频繁")
        || msg.contains("额度")
}

fn apply_metric(
    store: &mut MetricsStore,
    key: &str,
    priority: &str,
    ttft_ms: Option<u64>,
    total_ms: u64,
    err_msg: Option<&str>,
    cancelled: bool,
) {
    let m = store.providers.entry(key.to_string()).or_default();
    m.calls += 1;
    m.last_total_ms = total_ms;
    m.total_sum_ms += total_ms;
    m.avg_total_ms = m.total_sum_ms / m.calls;
    if let Some(t) = ttft_ms {
        m.last_ttft_ms = Some(t);
        m.ttft_samples += 1;
        m.ttft_sum_ms += t;
        m.avg_ttft_ms = Some(m.ttft_sum_ms / m.ttft_samples);
    }
    if cancelled {
        m.cancelled += 1;
    } else if let Some(msg) = err_msg {
        m.errors += 1;
        if is_rate_limit_text(msg) {
            m.rate_limits += 1;
        }
    }
    if store.recent.len() >= MAX_RECENT_TRACES {
        store.recent.pop_front();
    }
    store.recent.push_back(RecentLlmTrace {
        at_ms: now_unix_ms(),
        provider: key.to_string(),
        priority: priority.to_string(),
        ttft_ms,
        total_ms,
        ok: !cancelled && err_msg.is_none(),
        cancelled,
        error: err_msg.map(|s| s.chars().take(160).collect()),
    });
}

pub async fn llm_metrics() -> Response {
    let snapshot = AI_METRICS.lock().unwrap_or_else(|e| e.into_inner());
    Json(json!({ "providers": &snapshot.providers, "recent": &snapshot.recent })).into_response()
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

struct CancelOnDropStream<S> {
    inner: S,
    cancel: Arc<AtomicBool>,
}

impl<S: Stream + Unpin> Stream for CancelOnDropStream<S> {
    type Item = S::Item;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        Pin::new(&mut self.inner).poll_next(cx)
    }
}

impl<S> Drop for CancelOnDropStream<S> {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
    }
}

pub async fn llm_chat(
    State(state): State<Arc<AppState>>,
    Json(body): Json<LlmChatBody>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let request_id = body.request_id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let cancel = state.start_job(&request_id);
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();

    let state_clone = state.clone();
    let cancel_worker = cancel.clone();

    tokio::spawn(async move {
        let cancel = cancel_worker;
        let started = Instant::now();
        let first_delta_ms = Arc::new(AtomicU64::new(u64::MAX));
        let last_think_ms = Arc::new(AtomicU64::new(0));
        let metric_key = format!("{}:{}", body.provider.protocol, body.provider.id);
        let send_json = |v: Value| {
            let _ = tx.send(Ok(Event::default().data(v.to_string())));
        };
        let emit_thinking = {
            let tx_t = tx.clone();
            let fd = first_delta_ms.clone();
            let lt = last_think_ms.clone();
            move || {
                if fd.load(Ordering::Relaxed) != u64::MAX {
                    return;
                }
                let now = started.elapsed().as_millis() as u64;
                let prev = lt.load(Ordering::Relaxed);
                if prev == 0 || now.saturating_sub(prev) >= 800 {
                    if lt.compare_exchange(prev, now.max(1), Ordering::Relaxed, Ordering::Relaxed).is_ok() {
                        let _ = tx_t.send(Ok(Event::default().data(json!({ "type": "thinking" }).to_string())));
                    }
                }
            }
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
                priority: if body.quick.unwrap_or(false) {
                    agents::Priority::Background
                } else {
                    agents::Priority::Interactive
                },
            };
            let tx_delta = tx.clone();
            let fd = first_delta_ms.clone();
            agents::complete(
                kind,
                &path,
                req,
                cancel.clone(),
                move |delta| {
                    if !delta.is_empty() {
                        let _ = fd.compare_exchange(
                            u64::MAX,
                            started.elapsed().as_millis() as u64,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        );
                    }
                    let _ = tx_delta.send(Ok(Event::default().data(json!({ "type": "delta", "text": delta }).to_string())));
                },
                emit_thinking,
            )
            .await
        } else {
            let tx_delta = tx.clone();
            let fd = first_delta_ms.clone();
            llm::chat(
                &body.provider,
                &body.system,
                &body.messages,
                body.max_tokens.unwrap_or(8000),
                body.json_mode.unwrap_or(false),
                body.quick.unwrap_or(false),
                &cancel,
                move |delta| {
                    if !delta.is_empty() {
                        let _ = fd.compare_exchange(
                            u64::MAX,
                            started.elapsed().as_millis() as u64,
                            Ordering::Relaxed,
                            Ordering::Relaxed,
                        );
                    }
                    let _ = tx_delta.send(Ok(Event::default().data(json!({ "type": "delta", "text": delta }).to_string())));
                },
                emit_thinking,
            )
            .await
        };

        let total_ms = started.elapsed().as_millis() as u64;
        let raw_ttft = first_delta_ms.load(Ordering::Relaxed);
        let ttft_ms = (raw_ttft != u64::MAX).then_some(raw_ttft);
        let cancelled = cancel.load(Ordering::Relaxed);
        let priority_label = if body.quick.unwrap_or(false) { "background" } else { "interactive" };
        {
            let err_str = result.as_ref().err().map(|e| e.to_string());
            let mut m = AI_METRICS.lock().unwrap_or_else(|e| e.into_inner());
            apply_metric(&mut m, &metric_key, priority_label, ttft_ms, total_ms, err_str.as_deref(), cancelled);
        }

        match result {
            Ok(full) => send_json(json!({ "type": "done", "text": full, "ttftMs": ttft_ms, "totalMs": total_ms })),
            Err(err) => send_json(json!({ "type": "error", "message": err.to_string(), "ttftMs": ttft_ms, "totalMs": total_ms })),
        }
        state_clone.finish_job(&request_id, &cancel);
    });

    Sse::new(CancelOnDropStream {
        inner: UnboundedReceiverStream::new(rx),
        cancel,
    })
    .keep_alive(KeepAlive::default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;

    #[tokio::test]
    async fn sse_stream_closes_on_sender_drop_and_cancels_on_client_drop() {
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<Result<Event, Infallible>>();
        let mut stream = CancelOnDropStream {
            inner: UnboundedReceiverStream::new(rx),
            cancel: cancel.clone(),
        };
        let _ = tx.send(Ok(Event::default().data("{}")));
        drop(tx);
        assert!(stream.next().await.is_some());
        assert!(stream.next().await.is_none());
        assert!(!cancel.load(Ordering::Relaxed));
        drop(stream);
        assert!(cancel.load(Ordering::Relaxed));
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
    fn aggregates_provider_metrics_and_rate_limits() {
        let mut store = MetricsStore::default();
        apply_metric(&mut store, "cli:codex", "interactive", Some(320), 1400, None, false);
        apply_metric(&mut store, "cli:codex", "background", None, 2000, Some("429 quota exceeded"), false);
        apply_metric(&mut store, "cli:codex", "interactive", None, 500, Some("已取消"), true);
        let m = store.providers.get("cli:codex").unwrap();
        assert_eq!(m.calls, 3);
        assert_eq!(m.errors, 1);
        assert_eq!(m.rate_limits, 1);
        assert_eq!(m.cancelled, 1);
        assert_eq!(m.avg_ttft_ms, Some(320));
        assert_eq!(m.avg_total_ms, 1300);
        assert_eq!(store.recent.len(), 3);
        assert!(store.recent[0].ok);
        assert!(!store.recent[1].ok);
        assert!(store.recent[2].cancelled);
    }
}
