//! Streaming chat with the user's own model service: OpenAI-compatible `/chat/completions` (DeepSeek, SiliconFlow,
//! OpenRouter, Ollama, OpenAI, Kimi…) or Anthropic's Messages API. Keys live in the system keychain.
use crate::net;
use anyhow::{anyhow, Result};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};

const KEYRING_SERVICE: &str = "podcast-desk";

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub protocol: String,
    pub base_url: String,
    pub model: String,
}

#[derive(Deserialize, Clone, Debug)]
pub struct Message {
    pub role: String,
    pub content: String,
}

pub fn set_key(provider: &str, key: &str) -> Result<()> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, provider)?;
    if key.is_empty() {
        let _ = entry.delete_credential();
    } else {
        entry.set_password(key)?;
    }
    Ok(())
}

pub fn get_key(provider: &str) -> Option<String> {
    keyring::Entry::new(KEYRING_SERVICE, provider).ok()?.get_password().ok()
}

fn opencode_session() -> &'static str {
    static ID: once_cell::sync::Lazy<String> = once_cell::sync::Lazy::new(|| {
        let entry = keyring::Entry::new(KEYRING_SERVICE, "opencode-session").ok();
        if let Some(v) = entry.as_ref().and_then(|e| e.get_password().ok()).filter(|v| !v.is_empty()) {
            return v;
        }
        let v = uuid::Uuid::new_v4().to_string();
        if let Some(e) = entry {
            let _ = e.set_password(&v);
        }
        v
    });
    &ID
}

fn needs_opencode_session(base_url: &str) -> bool {
    base_url.contains("opencode.ai")
}

fn openai_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") { b.to_string() } else { format!("{b}/chat/completions") }
}

fn anthropic_url(base: &str) -> String {
    let b = base.trim().trim_end_matches('/');
    let b = if b.is_empty() { "https://api.anthropic.com" } else { b };
    if b.ends_with("/messages") {
        b.to_string()
    } else if b.ends_with("/v1") {
        format!("{b}/messages")
    } else {
        format!("{b}/v1/messages")
    }
}

fn api_error(status: u16, body: &str) -> anyhow::Error {
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v["error"]["message"]
                .as_str()
                .or_else(|| v["error"].as_str())
                .or_else(|| v["message"].as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status {
        401 | 403 => anyhow!("API Key 无效或没有权限：{msg}"),
        404 => anyhow!("模型或地址不存在：{msg}"),
        429 => anyhow!("请求太频繁或额度不足：{msg}"),
        _ => anyhow!("模型服务出错（{status}）：{msg}"),
    }
}

pub async fn chat(
    p: &Provider,
    system: &str,
    messages: &[Message],
    max_tokens: u32,
    json_mode: bool,
    quick: bool,
    cancel: &AtomicBool,
    mut on_delta: impl FnMut(&str),
    mut on_thinking: impl FnMut(),
) -> Result<String> {
    let key = get_key(&p.id);
    let anthropic = p.protocol == "anthropic";
    if anthropic && key.is_none() {
        return Err(anyhow!("请先在设置里填写 API Key"));
    }
    let (mut completion_tokens, mut json, mut anthropic_cache) = (false, json_mode, !system.is_empty());
    let mut think_off = if quick { think_off_param(p) } else { None };
    let mut tries = 0;
    let res = loop {
        tries += 1;
        let req = if anthropic {
            let msgs: Vec<Value> = messages.iter().map(|m| json!({"role": m.role, "content": m.content})).collect();
            let sys_val = if anthropic_cache {
                json!([{ "type": "text", "text": system, "cache_control": { "type": "ephemeral" } }])
            } else {
                json!(system)
            };
            net::client()
                .post(anthropic_url(&p.base_url))
                .header("x-api-key", key.clone().unwrap_or_default())
                .header("anthropic-version", "2023-06-01")
                .json(&json!({ "model": p.model, "max_tokens": max_tokens, "system": sys_val, "messages": msgs, "stream": true }))
        } else {
            let mut msgs = vec![json!({"role": "system", "content": system})];
            msgs.extend(messages.iter().map(|m| json!({"role": m.role, "content": m.content})));
            let mut body = json!({ "model": p.model, "messages": msgs, "stream": true });
            body[if completion_tokens { "max_completion_tokens" } else { "max_tokens" }] = json!(max_tokens);
            if json {
                body["response_format"] = json!({"type": "json_object"});
            }
            if let Some((k, v)) = &think_off {
                body[*k] = v.clone();
            }
            let mut r = net::client().post(openai_url(&p.base_url)).json(&body);
            if needs_opencode_session(&p.base_url) {
                r = r.header("x-opencode-session", opencode_session());
            }
            if let Some(k) = key.as_ref().filter(|k| !k.is_empty()) {
                r = r.bearer_auth(k);
            }
            r
        };
        let res = req.send().await.map_err(|e| anyhow!("连不上模型服务：{e}"))?;
        let status = res.status();
        if status.is_success() {
            break res;
        }
        let body = res.text().await.unwrap_or_default();
        let l = body.to_lowercase();
        if anthropic && anthropic_cache && matches!(status.as_u16(), 400 | 422) && tries < 3 && (l.contains("cache_control") || l.contains("system")) {
            anthropic_cache = false;
            continue;
        }
        if !anthropic && matches!(status.as_u16(), 400 | 422) && tries < 4 {
            if !completion_tokens && l.contains("max_completion_tokens") {
                completion_tokens = true;
                continue;
            }
            if json && (l.contains("response_format") || l.contains("json_object") || l.contains("json mode")) {
                json = false;
                continue;
            }
            if let Some((k, _)) = think_off {
                if l.contains(k) || l.contains("unrecognized") || l.contains("unknown") || l.contains("extra") {
                    think_off = None;
                    continue;
                }
            }
        }
        return Err(api_error(status.as_u16(), &body));
    };
    let mut stream = res.bytes_stream();
    let mut lines = LineBuf::default();
    let mut full = String::new();
    let mut think = ThinkFilter::default();
    let (mut thought, mut cut, mut streamed) = (false, false, false);
    let mut raw = String::new();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已停止"));
        }
        lines.push(&chunk.map_err(|e| anyhow!("连接中断：{e}"))?);
        while let Some(line) = lines.next_line() {
            let line = line.trim().to_string();
            let Some(data) = line.strip_prefix("data:") else {
                if !streamed && raw.len() < 4_000_000 {
                    raw.push_str(&line);
                    raw.push('\n');
                }
                continue;
            };
            streamed = true;
            let data = data.trim();
            if data == "[DONE]" {
                return finish(full, thought || think.saw, cut);
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            let piece = if anthropic {
                if v["delta"]["thinking"].is_string()
                    || (v["type"].as_str() == Some("content_block_start") && v["content_block"]["type"].as_str() == Some("thinking"))
                {
                    thought = true;
                    on_thinking();
                }
                if v["delta"]["stop_reason"].as_str() == Some("max_tokens") {
                    cut = true;
                }
                match v["type"].as_str() {
                    Some("content_block_delta") => v["delta"]["text"].as_str().map(String::from),
                    Some("error") => return Err(anyhow!("模型服务出错：{}", v["error"]["message"].as_str().unwrap_or("未知错误"))),
                    _ => None,
                }
            } else {
                if let Some(e) = v["error"]["message"].as_str() {
                    return Err(anyhow!("模型服务出错：{e}"));
                }
                let d = &v["choices"][0]["delta"];
                if d["reasoning_content"].as_str().is_some_and(|x| !x.is_empty())
                    || d["reasoning"].as_str().is_some_and(|x| !x.is_empty())
                {
                    thought = true;
                    on_thinking();
                }
                if v["choices"][0]["finish_reason"].as_str() == Some("length") {
                    cut = true;
                }
                text_of(&d["content"])
            };
            if let Some(raw_piece) = piece {
                let filtered = think.feed(&raw_piece);
                if think.inside {
                    on_thinking();
                }
                if !filtered.is_empty() {
                    full.push_str(&filtered);
                    on_delta(&filtered);
                }
            }
        }
    }
    if !streamed {
        let rest = lines.rest();
        let v: Value = serde_json::from_str(format!("{raw}{rest}").trim()).unwrap_or(Value::Null);
        if let Some(e) = v["error"]["message"].as_str() {
            return Err(anyhow!("模型服务出错：{e}"));
        }
        let msg = &v["choices"][0]["message"];
        if msg["reasoning_content"].is_string() || msg["reasoning"].is_string() {
            thought = true;
        }
        if v["choices"][0]["finish_reason"].as_str() == Some("length") || v["stop_reason"].as_str() == Some("max_tokens") {
            cut = true;
        }
        let text = text_of(&msg["content"]).or_else(|| text_of(&v["content"])).unwrap_or_default();
        let text = think.feed(&text);
        if !text.is_empty() {
            on_delta(&text);
            full.push_str(&text);
        }
    }
    finish(full, thought || think.saw, cut)
}

/// Returns the request field that disables or lowers reasoning for quick structured tasks.
fn think_off_param(p: &Provider) -> Option<(&'static str, Value)> {
    let base = p.base_url.to_lowercase();
    let model = p.model.to_lowercase();
    if base.contains("deepseek.com") || (model.contains("deepseek") && !base.contains("openrouter")) {
        Some(("thinking", json!({"type": "disabled"})))
    } else if base.contains("dashscope") || model.starts_with("qwen3") || model.starts_with("qwq") {
        Some(("enable_thinking", json!(false)))
    } else if base.contains("bigmodel.cn") || model.starts_with("glm-4.5") || model.starts_with("glm-4.6") || model.starts_with("glm-5") {
        Some(("thinking", json!({"type": "disabled"})))
    } else if base.contains("volces.com") || model.starts_with("doubao-seed") {
        Some(("thinking", json!({"type": "disabled"})))
    } else if base.contains("api.openai.com") && (model.starts_with('o') || model.starts_with("gpt-5")) {
        Some(("reasoning_effort", json!("low")))
    } else if base.contains("generativelanguage.googleapis.com")
        || ((model.starts_with("gemini-2.5") || model.starts_with("gemini-3")) && !base.contains("openrouter"))
    {
        Some(("reasoning_effort", json!("low")))
    } else {
        None
    }
}

fn text_of(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let parts = v.as_array()?;
    Some(
        parts
            .iter()
            .filter(|x| x["type"].as_str().is_none_or(|t| t == "text" || t == "output_text"))
            .filter_map(|x| x["text"].as_str())
            .collect(),
    )
}

fn finish(full: String, thought: bool, cut: bool) -> Result<String> {
    if !full.trim().is_empty() {
        return Ok(full.trim_start().to_string());
    }
    if thought || cut {
        return Err(anyhow!("模型把篇幅都用在了思考上，没有写出正文。请重试，或换一个不带深度思考的模型"));
    }
    Err(anyhow!("模型没有返回内容"))
}

#[derive(Default)]
struct ThinkFilter {
    inside: bool,
    pending: String,
    saw: bool,
}

impl ThinkFilter {
    fn feed(&mut self, piece: &str) -> String {
        let mut s = std::mem::take(&mut self.pending) + piece;
        let mut out = String::new();
        loop {
            let tag = if self.inside { "</think>" } else { "<think>" };
            if let Some(i) = s.find(tag) {
                if !self.inside {
                    out.push_str(&s[..i]);
                }
                self.inside = !self.inside;
                if self.inside {
                    self.saw = true;
                }
                s = s[i + tag.len()..].to_string();
                continue;
            }
            let keep = (1..tag.len())
                .rev()
                .find(|&n| s.len() >= n && s.is_char_boundary(s.len() - n) && tag.starts_with(&s[s.len() - n..]))
                .unwrap_or(0);
            let (now, later) = s.split_at(s.len() - keep);
            if !self.inside {
                out.push_str(now);
            }
            self.pending = later.to_string();
            return out;
        }
    }
}

#[derive(Default)]
struct LineBuf {
    bytes: Vec<u8>,
}

impl LineBuf {
    fn push(&mut self, chunk: &[u8]) {
        self.bytes.extend_from_slice(chunk);
    }
    fn next_line(&mut self) -> Option<String> {
        let pos = self.bytes.iter().position(|&b| b == b'\n')?;
        let line: Vec<u8> = self.bytes.drain(..=pos).collect();
        Some(String::from_utf8_lossy(&line[..pos]).into_owned())
    }
    fn rest(&mut self) -> String {
        String::from_utf8_lossy(&std::mem::take(&mut self.bytes)).into_owned()
    }
}

#[cfg(test)]
mod line_buf_tests {
    use super::LineBuf;

    #[test]
    fn a_character_split_across_chunks_stays_whole() {
        let text = "data: 黄仁勋能\n\ndata: [DONE]\n".as_bytes();
        let mut b = LineBuf::default();
        let mut got = Vec::new();
        for part in [&text[..10], &text[10..14], &text[14..]] {
            b.push(part);
            while let Some(l) = b.next_line() {
                got.push(l);
            }
        }
        assert_eq!(got, ["data: 黄仁勋能", "", "data: [DONE]"]);
        assert!(!got.concat().contains('\u{FFFD}'));
    }
}

#[cfg(test)]
mod reply_tests {
    use super::*;

    #[test]
    fn think_tags_are_dropped_across_pieces() {
        let mut f = ThinkFilter::default();
        let out: String = ["<thi", "nk>let me see</th", "ink>\n答案", "是 <b>42</b>"]
            .iter()
            .map(|p| f.feed(p))
            .collect();
        assert_eq!(out, "\n答案是 <b>42</b>");
        assert!(f.saw);
        let mut g = ThinkFilter::default();
        assert_eq!(g.feed("a < b"), "a < b");
        assert_eq!(g.feed(" x <"), " x ");
        assert_eq!(g.feed(" ok"), "< ok");
    }

    #[test]
    fn content_as_parts_and_empty_answers() {
        assert_eq!(text_of(&json!([{ "type": "text", "text": "你" }, { "type": "image_url" }, { "text": "好" }])).unwrap(), "你好");
        assert!(finish(String::new(), true, false).unwrap_err().to_string().contains("思考"));
        assert_eq!(finish("  \n答".into(), false, false).unwrap(), "答");
    }
}

#[cfg(test)]
mod think_off_tests {
    use super::*;

    fn p(base: &str, model: &str) -> Provider {
        Provider { id: "x".into(), protocol: "openai".into(), base_url: base.into(), model: model.into() }
    }

    #[test]
    fn picks_the_switch_per_provider() {
        assert_eq!(think_off_param(&p("https://api.deepseek.com", "deepseek-chat")).unwrap().0, "thinking");
        assert_eq!(think_off_param(&p("https://dashscope.aliyuncs.com/compatible-mode/v1", "qwen-plus")).unwrap().0, "enable_thinking");
        assert_eq!(think_off_param(&p("https://open.bigmodel.cn/api/paas/v4", "glm-4.5")).unwrap().0, "thinking");
        assert_eq!(think_off_param(&p("https://ark.cn-beijing.volces.com/api/v3", "doubao-seed-1.6")).unwrap().0, "thinking");
        assert_eq!(think_off_param(&p("https://api.openai.com/v1", "gpt-5-mini")).unwrap().1, json!("low"));
        assert_eq!(
            think_off_param(&p("https://generativelanguage.googleapis.com/v1beta/openai", "gemini-2.5-flash")).unwrap(),
            ("reasoning_effort", json!("low"))
        );
        assert!(think_off_param(&p("https://api.openai.com/v1", "gpt-4.1")).is_none());
        assert!(think_off_param(&p("https://openrouter.ai/api/v1", "deepseek/deepseek-r1")).is_none());
    }
}
