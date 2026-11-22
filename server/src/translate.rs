//! Free direct Google Translate (`client=gtx`) with line chunking.
//! Strictly direct (or user's configured proxy): no third-party relay server is used.
use crate::net;
use anyhow::{anyhow, Result};
use serde_json::Value;

const DIRECT: &str = "https://translate.googleapis.com/translate_a/single";
const DIRECT_CHUNK: usize = 1800;
const MAX_GROUP_LINES: usize = 12;

fn parse(v: &Value) -> Option<String> {
    let parts = v.get(0)?.as_array()?;
    let text: String = parts.iter().filter_map(|p| p.get(0).and_then(Value::as_str)).collect();
    (!text.is_empty()).then_some(text)
}

async fn direct(text: &str, tl: &str) -> Result<String> {
    let delays_ms = [800u64, 2000u64];
    for attempt in 0..=delays_ms.len() {
        let res = net::client()
            .post(DIRECT)
            .header("Accept-Language", "zh-CN,zh;q=0.9,en;q=0.8")
            .query(&[("client", "gtx"), ("sl", "auto"), ("dt", "t"), ("tl", tl)])
            .form(&[("q", text)])
            .timeout(std::time::Duration::from_secs(12))
            .send()
            .await?;
        let status = res.status();
        if status.is_success() {
            return parse(&res.json().await?).ok_or_else(|| anyhow!("谷歌翻译没有返回内容"));
        }
        let code = status.as_u16();
        if (code == 429 || code == 503) && attempt < delays_ms.len() {
            tokio::time::sleep(std::time::Duration::from_millis(delays_ms[attempt])).await;
            continue;
        }
        return Err(anyhow!("谷歌翻译返回 {code}"));
    }
    unreachable!()
}

/// Groups lines into requests of at most `max_chars` characters and `max_lines` lines.
fn chunks(lines: &[String], max_chars: usize, max_lines: usize) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = Vec::new();
    let mut cur: Vec<String> = Vec::new();
    let mut size = 0;
    for l in lines {
        let l: String = l.replace('\n', " ").chars().take(max_chars).collect();
        let n = l.chars().count() + 1;
        if !cur.is_empty() && (size + n > max_chars || cur.len() >= max_lines) {
            out.push(std::mem::take(&mut cur));
            size = 0;
        }
        size += n;
        cur.push(l);
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

fn translate_group<'a>(
    lines: &'a [String],
    tl: &'a str,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<String>>> + Send + 'a>> {
    Box::pin(async move {
        if lines.is_empty() {
            return Ok(vec![]);
        }
        if lines.iter().all(|l| l.trim().is_empty()) {
            return Ok(vec![String::new(); lines.len()]);
        }
        if lines.len() == 1 {
            let trimmed = lines[0].trim();
            if trimmed.is_empty() {
                return Ok(vec![String::new()]);
            }
            let t = direct(trimmed, tl).await?;
            return Ok(vec![t.trim().to_string()]);
        }

        let joined = lines.join("\n");
        let text = direct(&joined, tl).await?;
        let parts: Vec<String> = text.split('\n').map(|s| s.trim().to_string()).collect();
        if parts.len() == lines.len() {
            return Ok(parts);
        }

        // Google merged or split newlines: binary-split with gentle pacing instead of 1-by-1 bursts.
        let mid = lines.len() / 2;
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let mut left = translate_group(&lines[..mid], tl).await?;
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        let right = translate_group(&lines[mid..], tl).await?;
        left.extend(right);
        Ok(left)
    })
}

/// Translates each line directly via Google Translate into `tl` ("zh-CN", "en", ...).
pub async fn translate_lines(lines: &[String], tl: &str) -> Result<Vec<String>> {
    if lines.is_empty() {
        return Ok(vec![]);
    }
    let mut out = Vec::with_capacity(lines.len());
    for (idx, group) in chunks(lines, DIRECT_CHUNK, MAX_GROUP_LINES).into_iter().enumerate() {
        if idx > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(180)).await;
        }
        let translated = translate_group(&group, tl)
            .await
            .map_err(|e| anyhow!("直连谷歌翻译失败（{e}）；请检查本机网络或代理，或切换为大模型精译"))?;
        out.extend(translated);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunking_splits_at_budget_and_max_lines() {
        let lines: Vec<String> = (0..10).map(|i| format!("line number {i}")).collect();
        let c = chunks(&lines, 40, 12);
        assert!(c.len() > 1);
        assert_eq!(c.iter().map(Vec::len).sum::<usize>(), 10);

        let many: Vec<String> = (0..25).map(|i| format!("s{i}")).collect();
        let capped = chunks(&many, 5000, MAX_GROUP_LINES);
        assert_eq!(capped.len(), 3);
        assert_eq!(capped[0].len(), MAX_GROUP_LINES);
        assert_eq!(capped[1].len(), MAX_GROUP_LINES);
        assert_eq!(capped[2].len(), 1);
    }

    #[test]
    fn parses_google_gtx_json_payload() {
        let payload: Value = serde_json::json!([
            [
                ["你好世界\n", "Hello world\n", null, null, 1],
                ["第二行", "Second line", null, null, 1]
            ],
            null,
            "en"
        ]);
        assert_eq!(parse(&payload).as_deref(), Some("你好世界\n第二行"));
        assert_eq!(parse(&serde_json::json!([])), None);
    }
}
