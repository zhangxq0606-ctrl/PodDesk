//! YouTube captions via InnerTube mobile player clients, plus channel/playlist page parsing & pagination.
use crate::model::{now_ms, Segment};
use crate::net;
use crate::transcript;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::Duration;

const CLIENTS: &[(&str, &str, Option<u32>)] = &[
    ("ANDROID", "20.10.38", Some(34)),
    ("IOS", "20.10.3", None),
    ("ANDROID_VR", "1.60.19", Some(32)),
];

#[derive(Clone, Debug)]
pub struct Track {
    pub base_url: String,
    pub language: String,
    pub auto: bool,
}

pub struct VideoInfo {
    pub title: String,
    pub author: String,
    pub duration: Option<f64>,
    pub published: Option<i64>,
    pub description: String,
    pub tracks: Vec<Track>,
    pub original_language: Option<String>,
}

pub fn parse_youtube_date(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_millis());
    }
    let d = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()?;
    Some(d.and_hms_opt(12, 0, 0)?.and_utc().timestamp_millis())
}

fn published_of(player: &Value) -> Option<i64> {
    let mf = &player["microformat"]["playerMicroformatRenderer"];
    mf["publishDate"]
        .as_str()
        .and_then(parse_youtube_date)
        .or_else(|| mf["uploadDate"].as_str().and_then(parse_youtube_date))
}

async fn fetch_watch_publish_date(video_id: &str) -> Option<i64> {
    let url = format!("https://www.youtube.com/watch?v={video_id}");
    let res = net::client()
        .get(url)
        .timeout(std::time::Duration::from_secs(6))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let html = res.text().await.ok()?;
    for pat in [
        r#""publishDate"\s*:\s*"([^"]+)""#,
        r#""uploadDate"\s*:\s*"([^"]+)""#,
        r#"itemprop="datePublished"\s+content="([^"]+)""#,
    ] {
        if let Some(c) = regex::Regex::new(pat).ok()?.captures(&html) {
            if let Some(ts) = parse_youtube_date(&c[1]) {
                return Some(ts);
            }
        }
    }
    None
}

fn original_language(player: &Value) -> Option<String> {
    let mut found = std::collections::BTreeSet::new();
    for key in ["formats", "adaptiveFormats"] {
        for f in player["streamingData"][key].as_array().into_iter().flatten() {
            let a = &f["audioTrack"];
            if a["displayName"].as_str().is_some_and(|n| n.to_lowercase().contains("original")) {
                if let Some(id) = a["id"].as_str() {
                    found.insert(base(id.split('.').next().unwrap_or(id)));
                }
            }
        }
    }
    (found.len() == 1).then(|| found.into_iter().next().unwrap())
}

fn base(lang: &str) -> String {
    lang.split(['-', '_']).next().unwrap_or(lang).to_lowercase()
}

fn tracks_of(player: &Value) -> Vec<Track> {
    player["captions"]["playerCaptionsTracklistRenderer"]["captionTracks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| {
            let url = t["baseUrl"].as_str()?;
            if url.contains("exp=xpe") {
                return None;
            }
            Some(Track {
                base_url: url.to_string(),
                language: t["languageCode"].as_str().unwrap_or("und").to_string(),
                auto: t["kind"].as_str() == Some("asr"),
            })
        })
        .collect()
}

pub async fn video_info(video_id: &str) -> Result<VideoInfo> {
    let mut last_err = anyhow!("YouTube 没有返回视频信息");
    let mut fallback: Option<VideoInfo> = None;
    for &(name, version, sdk) in CLIENTS {
        let mut client = json!({ "clientName": name, "clientVersion": version, "hl": "en" });
        if let Some(sdk) = sdk {
            client["androidSdkVersion"] = json!(sdk);
        }
        let body = json!({ "context": { "client": client }, "videoId": video_id, "contentCheckOk": true, "racyCheckOk": true });
        let res = net::client().post("https://www.youtube.com/youtubei/v1/player?prettyPrint=false").json(&body).send().await;
        let player: Value = match res {
            Ok(r) if r.status().is_success() => match r.json().await {
                Ok(v) => v,
                Err(e) => {
                    last_err = e.into();
                    continue;
                }
            },
            Ok(r) => {
                last_err = anyhow!("YouTube {}", r.status());
                continue;
            }
            Err(e) => {
                last_err = anyhow!("连不上 YouTube（国内需要设置代理）：{e}");
                continue;
            }
        };
        let d = &player["videoDetails"];
        let info = VideoInfo {
            title: d["title"].as_str().unwrap_or("").to_string(),
            author: d["author"].as_str().unwrap_or("").to_string(),
            duration: d["lengthSeconds"].as_str().and_then(|s| s.parse().ok()),
            published: published_of(&player),
            description: d["shortDescription"].as_str().unwrap_or("").to_string(),
            tracks: tracks_of(&player),
            original_language: original_language(&player),
        };
        if !info.tracks.is_empty() {
            let mut info = info;
            if info.published.is_none() {
                info.published = fetch_watch_publish_date(video_id).await;
            }
            return Ok(info);
        }
        if fallback.is_none() && !info.title.is_empty() {
            fallback = Some(info);
        }
    }
    if let Some(mut info) = fallback {
        if info.published.is_none() {
            info.published = fetch_watch_publish_date(video_id).await;
        }
        return Ok(info);
    }
    Err(last_err)
}

pub fn choose<'a>(tracks: &'a [Track], original: Option<&str>, hint: Option<&str>) -> Option<&'a Track> {
    let autos: Vec<&Track> = tracks.iter().filter(|t| t.auto).collect();
    let spoken = original
        .map(base)
        .or_else(|| (autos.len() == 1).then(|| base(&autos[0].language)))
        .or_else(|| hint.map(base));
    if let Some(sp) = &spoken {
        if let Some(t) = tracks.iter().find(|t| !t.auto && &base(&t.language) == sp) {
            return Some(t);
        }
        if let Some(t) = autos.iter().find(|t| &base(&t.language) == sp) {
            return Some(t);
        }
    }
    tracks
        .iter()
        .find(|t| !t.auto && base(&t.language) == "en")
        .or_else(|| autos.iter().copied().find(|t| base(&t.language) == "en"))
        .or_else(|| tracks.iter().find(|t| !t.auto))
        .or_else(|| tracks.first())
}

pub fn script_hint(title: &str) -> Option<&'static str> {
    let has = |lo: char, hi: char| title.chars().any(|c| (lo..=hi).contains(&c));
    if has('\u{3040}', '\u{30ff}') {
        Some("ja")
    } else if has('\u{ac00}', '\u{d7af}') {
        Some("ko")
    } else if title.chars().filter(|c| ('\u{4e00}'..='\u{9fff}').contains(c)).count() >= 2 {
        Some("zh")
    } else {
        None
    }
}

pub fn official_chinese<'a>(tracks: &'a [Track], spoken: &str) -> Option<&'a Track> {
    if base(spoken) == "zh" {
        return None;
    }
    let zh: Vec<&Track> = tracks.iter().filter(|t| !t.auto && base(&t.language) == "zh").collect();
    zh.iter()
        .find(|t| matches!(t.language.as_str(), "zh-Hans" | "zh-CN" | "zh-SG" | "zh"))
        .or(zh.first())
        .copied()
}

pub fn align(orig: &[Segment], other: &[Segment]) -> Vec<Option<String>> {
    let mut out: Vec<Option<String>> = vec![None; orig.len()];
    for s in other {
        let mid = (s.start + s.end) / 2.0;
        let i = orig.partition_point(|o| o.start <= mid).saturating_sub(1);
        if orig.is_empty() || mid > orig[i].end + 2.0 {
            continue;
        }
        let text = s.text.trim();
        if text.is_empty() {
            continue;
        }
        match &mut out[i] {
            Some(prev) => prev.push_str(text),
            slot => *slot = Some(text.to_string()),
        }
    }
    out
}

pub async fn fetch_track(track: &Track) -> Result<Vec<Segment>> {
    let base = regex::Regex::new(r"&fmt=[^&]*").unwrap().replace_all(&track.base_url, "").to_string();
    for url in [format!("{base}&fmt=json3"), base.clone()] {
        if let Ok(r) = net::client().get(&url).send().await {
            if let Ok(body) = r.text().await {
                let segs = transcript::parse_youtube(&body);
                if !segs.is_empty() {
                    return Ok(segs);
                }
            }
        }
    }
    Err(anyhow!("字幕下载失败"))
}

// ---- channel / playlist page parsing & continuation --------------------------------------------

#[derive(Clone, Debug, Default)]
pub struct PageBatch {
    pub title: Option<String>,
    pub author: Option<String>,
    pub avatar: Option<String>,
    pub description: Option<String>,
    pub link: Option<String>,
    pub items: Vec<PageVideo>,
    pub continuation: Option<String>,
    pub api_key: Option<String>,
    pub client_version: Option<String>,
}

#[derive(Clone, Debug)]
pub struct PageVideo {
    pub video_id: String,
    pub title: String,
    pub duration: Option<f64>,
    pub published: Option<i64>,
    pub cover: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ContinuationState {
    pub token: Option<String>,
    pub api_key: String,
    pub client_version: String,
    pub exhausted: bool,
}

pub fn feed_page_url(feed_url: &str) -> Option<String> {
    if let Some(c) = regex::Regex::new(r"[?&]playlist_id=UULF([A-Za-z0-9_-]+)").ok()?.captures(feed_url) {
        return Some(format!("https://www.youtube.com/channel/UC{}/videos", &c[1]));
    }
    if let Some(c) = regex::Regex::new(r"[?&]channel_id=(UC[A-Za-z0-9_-]+)").ok()?.captures(feed_url) {
        return Some(format!("https://www.youtube.com/channel/{}/videos", &c[1]));
    }
    if let Some(c) = regex::Regex::new(r"[?&]playlist_id=([A-Za-z0-9_-]+)").ok()?.captures(feed_url) {
        return Some(format!("https://www.youtube.com/playlist?list={}", &c[1]));
    }
    None
}

async fn fetch_yt_html(url: &str) -> Result<String> {
    let res = net::client()
        .get(url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .header("Cookie", "CONSENT=YES+cb")
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(net::describe)?;
    if !res.status().is_success() {
        return Err(anyhow!("YouTube 页面请求失败（{}）", res.status()));
    }
    Ok(res.text().await?)
}

pub fn extract_initial_data(html: &str) -> Option<Value> {
    let markers = [
        "var ytInitialData = ",
        "var ytInitialData=",
        r#"window["ytInitialData"] = "#,
        r#"window["ytInitialData"]="#,
    ];
    let start_after = markers.iter().find_map(|m| html.find(m).map(|idx| idx + m.len()))?;
    let slice = html.get(start_after..)?;
    let brace_offset = slice.find('{')?;
    let json_slice = &slice[brace_offset..];

    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    let mut end_idx = None;
    for (i, ch) in json_slice.char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end_idx = Some(i + ch.len_utf8());
                    break;
                }
            }
            _ => {}
        }
    }
    let raw = json_slice.get(..end_idx?)?;
    serde_json::from_str(raw).ok()
}

fn extract_cfg_str(html: &str, key: &str) -> Option<String> {
    let pat = format!(r#""{key}"\s*:\s*"([^"]+)""#);
    regex::Regex::new(&pat)
        .ok()?
        .captures(html)
        .map(|c| c[1].to_string())
}

pub fn parse_duration_text(s: &str) -> Option<f64> {
    let s = s.trim();
    if s.is_empty() || s.eq_ignore_ascii_case("live") || s.eq_ignore_ascii_case("shorts") {
        return None;
    }
    let parts: Vec<&str> = s.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut total = 0.0;
    for p in parts {
        let v: f64 = p.trim().parse().ok()?;
        if v < 0.0 {
            return None;
        }
        total = total * 60.0 + v;
    }
    (total > 0.0).then_some(total)
}

pub fn parse_relative_time(s: &str, now: i64) -> Option<i64> {
    let lower = s.trim().to_lowercase();
    if lower.is_empty() {
        return None;
    }
    let re_en = regex::Regex::new(r"(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago").ok()?;
    if let Some(c) = re_en.captures(&lower) {
        let n: i64 = c[1].parse().ok()?;
        let unit_ms: i64 = match &c[2] {
            "second" => 1_000,
            "minute" => 60_000,
            "hour" => 3_600_000,
            "day" => 86_400_000,
            "week" => 7 * 86_400_000,
            "month" => 30 * 86_400_000,
            "year" => 365 * 86_400_000,
            _ => return None,
        };
        return Some(now - n * unit_ms);
    }
    let re_zh = regex::Regex::new(r"(\d+)\s*(秒|分钟|小时|天|周|个月|月|年)前").ok()?;
    if let Some(c) = re_zh.captures(&lower) {
        let n: i64 = c[1].parse().ok()?;
        let unit_ms: i64 = match &c[2] {
            "秒" => 1_000,
            "分钟" => 60_000,
            "小时" => 3_600_000,
            "天" => 86_400_000,
            "周" => 7 * 86_400_000,
            "个月" | "月" => 30 * 86_400_000,
            "年" => 365 * 86_400_000,
            _ => return None,
        };
        return Some(now - n * unit_ms);
    }
    None
}

fn text_field(v: &Value) -> Option<String> {
    if let Some(s) = v["simpleText"].as_str() {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    if let Some(runs) = v["runs"].as_array() {
        let joined: String = runs.iter().filter_map(|r| r["text"].as_str()).collect();
        let t = joined.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

fn normalize_url(u: &str) -> String {
    if u.starts_with("//") {
        format!("https:{u}")
    } else {
        u.to_string()
    }
}

fn last_thumbnail(arr: &Value) -> Option<String> {
    arr.as_array()?
        .last()
        .and_then(|t| t["url"].as_str())
        .map(normalize_url)
}

fn extract_avatar(data: &Value) -> Option<String> {
    last_thumbnail(&data["metadata"]["channelMetadataRenderer"]["avatar"]["thumbnails"])
        .or_else(|| {
            last_thumbnail(
                &data["header"]["pageHeaderRenderer"]["content"]["pageHeaderViewModel"]["image"]["decoratedAvatarViewModel"]
                    ["avatar"]["avatarViewModel"]["image"]["sources"],
            )
        })
        .or_else(|| last_thumbnail(&data["header"]["c4TabbedHeaderRenderer"]["avatar"]["thumbnails"]))
}

fn is_short_video_renderer(v: &Value) -> bool {
    if v["navigationEndpoint"]["reelWatchEndpoint"].is_object() {
        return true;
    }
    if v["navigationEndpoint"]["commandMetadata"]["webCommandMetadata"]["url"]
        .as_str()
        .is_some_and(|u| u.contains("/shorts/"))
    {
        return true;
    }
    if v["thumbnailOverlays"].as_array().is_some_and(|arr| {
        arr.iter().any(|o| {
            o["thumbnailOverlayTimeStatusRenderer"]["style"]
                .as_str()
                .is_some_and(|s| s.eq_ignore_ascii_case("SHORTS"))
        })
    }) {
        return true;
    }
    false
}

pub fn collect_page_videos(v: &Value, now: i64, out: &mut Vec<PageVideo>, cont: &mut Option<String>) {
    match v {
        Value::Object(map) => {
            if let Some(vr) = map.get("videoRenderer") {
                if !is_short_video_renderer(vr) {
                    if let (Some(vid), Some(title)) = (vr["videoId"].as_str(), text_field(&vr["title"])) {
                        let dur_str = text_field(&vr["lengthText"]).or_else(|| {
                            vr["thumbnailOverlays"].as_array().and_then(|arr| {
                                arr.iter().find_map(|o| text_field(&o["thumbnailOverlayTimeStatusRenderer"]["text"]))
                            })
                        });
                        if !dur_str.as_deref().is_some_and(|d| d.eq_ignore_ascii_case("shorts")) {
                            let duration = dur_str.as_deref().and_then(parse_duration_text);
                            let published = text_field(&vr["publishedTimeText"]).and_then(|s| parse_relative_time(&s, now));
                            out.push(PageVideo {
                                video_id: vid.to_string(),
                                title,
                                duration,
                                published,
                                cover: format!("https://i.ytimg.com/vi/{vid}/mqdefault.jpg"),
                            });
                        }
                    }
                }
                return;
            }
            if let Some(pr) = map.get("playlistVideoRenderer") {
                if let (Some(vid), Some(title)) = (pr["videoId"].as_str(), text_field(&pr["title"])) {
                    let duration = pr["lengthSeconds"]
                        .as_str()
                        .and_then(|s| s.parse::<f64>().ok())
                        .filter(|&d| d > 0.0)
                        .or_else(|| text_field(&pr["lengthText"]).as_deref().and_then(parse_duration_text));
                    out.push(PageVideo {
                        video_id: vid.to_string(),
                        title,
                        duration,
                        published: None,
                        cover: format!("https://i.ytimg.com/vi/{vid}/mqdefault.jpg"),
                    });
                }
                return;
            }
            if let Some(cr) = map.get("continuationItemRenderer") {
                if cont.is_none() {
                    if let Some(tok) = cr["continuationEndpoint"]["continuationCommand"]["token"].as_str() {
                        if !tok.trim().is_empty() {
                            *cont = Some(tok.to_string());
                        }
                    }
                }
                return;
            }
            for child in map.values() {
                collect_page_videos(child, now, out, cont);
            }
        }
        Value::Array(arr) => {
            for item in arr {
                collect_page_videos(item, now, out, cont);
            }
        }
        _ => {}
    }
}

pub fn parse_page_initial_html(html: &str, page_url: &str, now: i64) -> Result<PageBatch> {
    let data = extract_initial_data(html).ok_or_else(|| anyhow!("未能解析 YouTube 页面初始数据"))?;
    let mut items = Vec::new();
    let mut continuation = None;
    collect_page_videos(&data, now, &mut items, &mut continuation);

    let ch_meta = &data["metadata"]["channelMetadataRenderer"];
    let pl_meta = &data["metadata"]["playlistMetadataRenderer"];
    let title = ch_meta["title"]
        .as_str()
        .or_else(|| pl_meta["title"].as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let description = ch_meta["description"]
        .as_str()
        .or_else(|| pl_meta["description"].as_str())
        .map(|s| s.trim().chars().take(2000).collect::<String>())
        .filter(|s| !s.is_empty());
    let author = title.clone();
    let avatar = extract_avatar(&data);
    let link = ch_meta["channelUrl"]
        .as_str()
        .map(String::from)
        .or_else(|| Some(page_url.to_string()));

    Ok(PageBatch {
        title,
        author,
        avatar,
        description,
        link,
        items,
        continuation,
        api_key: extract_cfg_str(html, "INNERTUBE_API_KEY"),
        client_version: extract_cfg_str(html, "INNERTUBE_CLIENT_VERSION"),
    })
}

pub async fn fetch_page_initial(feed_url: &str) -> Result<PageBatch> {
    let page_url = feed_page_url(feed_url).ok_or_else(|| anyhow!("不是受支持的 YouTube 频道或片单地址"))?;
    let html = fetch_yt_html(&page_url).await?;
    parse_page_initial_html(&html, &page_url, now_ms())
}

pub async fn fetch_browse_continuation(
    api_key: &str,
    client_version: &str,
    token: &str,
) -> Result<(Vec<PageVideo>, Option<String>)> {
    let url = format!("https://www.youtube.com/youtubei/v1/browse?key={}", urlencoding::encode(api_key));
    let body = json!({
        "context": {
            "client": {
                "clientName": "WEB",
                "clientVersion": client_version,
                "hl": "en",
                "gl": "US"
            }
        },
        "continuation": token
    });
    let res = net::client()
        .post(url)
        .header("Accept-Language", "en-US,en;q=0.9")
        .timeout(Duration::from_secs(15))
        .json(&body)
        .send()
        .await
        .map_err(net::describe)?;
    if !res.status().is_success() {
        return Err(anyhow!("YouTube 续页请求失败（{}）", res.status()));
    }
    let data: Value = res.json().await?;
    let mut items = Vec::new();
    let mut next_token = None;
    collect_page_videos(&data, now_ms(), &mut items, &mut next_token);
    Ok((items, next_token))
}

pub async fn fetch_channel_initial_50(feed_url: &str) -> Result<PageBatch> {
    let mut batch = fetch_page_initial(feed_url).await?;
    let mut seen: HashSet<String> = batch.items.iter().map(|v| v.video_id.clone()).collect();
    if batch.items.len() < 50 {
        if let (Some(tok), Some(key)) = (batch.continuation.clone(), batch.api_key.clone()) {
            let ver = batch
                .client_version
                .clone()
                .unwrap_or_else(|| "2.20250101.00.00".to_string());
            if let Ok((more, next_tok)) = fetch_browse_continuation(&key, &ver, &tok).await {
                for item in more {
                    if seen.insert(item.video_id.clone()) {
                        batch.items.push(item);
                    }
                }
                batch.continuation = next_tok;
            }
        }
    }
    Ok(batch)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn t(l: &str, auto: bool) -> Track {
        Track { base_url: String::new(), language: l.into(), auto }
    }

    #[test]
    fn dubbed_video_picks_original() {
        let tracks = vec![t("ar", true), t("en", true), t("en-US", false), t("de", true)];
        assert_eq!(choose(&tracks, Some("en"), None).unwrap().language, "en-US");
        assert_eq!(choose(&tracks, None, None).unwrap().language, "en-US");
        let only_auto = vec![t("ar", true), t("en", true)];
        assert_eq!(choose(&only_auto, None, None).unwrap().language, "en");
        assert_eq!(choose(&[t("ja", true)], None, None).unwrap().language, "ja");
    }

    #[test]
    fn chinese_show_with_english_subtitles_opens_in_chinese() {
        let tracks = vec![t("en", false), t("zh-Hans", false), t("zh-Hans", true), t("en", true)];
        let hint = script_hint("#010 黄仁勋辞职，Fable 杀死比赛，语言即世界");
        assert_eq!(hint, Some("zh"));
        assert_eq!(choose(&tracks, None, hint).unwrap().language, "zh-Hans");
        assert!(official_chinese(&tracks, "zh-Hans").is_none());
        assert_eq!(script_hint("Recursive self-improvement has started"), None);
        assert_eq!(script_hint("ChatGPTの使い方"), Some("ja"));
    }

    #[test]
    fn english_video_takes_the_publishers_chinese() {
        let tracks = vec![t("en", false), t("zh-TW", false), t("zh-Hans", false), t("en", true)];
        assert_eq!(official_chinese(&tracks, "en").unwrap().language, "zh-Hans");
        let seg = |s: f64, e: f64, x: &str| Segment { start: s, end: e, text: x.into() };
        let orig = vec![seg(0.0, 4.0, "Hello there."), seg(4.0, 9.0, "How are you?"), seg(9.0, 12.0, "Fine.")];
        let zh = vec![seg(0.2, 2.0, "你好"), seg(2.0, 3.8, "呀。"), seg(4.5, 8.0, "你好吗？")];
        assert_eq!(align(&orig, &zh), vec![Some("你好呀。".into()), Some("你好吗？".into()), None]);
    }

    #[test]
    fn parses_youtube_publish_dates() {
        let day_ms = parse_youtube_date("2024-09-24").unwrap();
        let dt_ms = parse_youtube_date("2024-09-24T08:00:01-07:00").unwrap();
        assert!(day_ms > 1_700_000_000_000);
        assert!(dt_ms > 1_700_000_000_000);
        assert_eq!(parse_youtube_date("not-a-date"), None);
        assert_eq!(parse_youtube_date("  "), None);

        let player = json!({
            "microformat": {
                "playerMicroformatRenderer": {
                    "publishDate": "2024-09-24",
                    "uploadDate": "2024-09-23"
                }
            }
        });
        assert_eq!(published_of(&player), Some(day_ms));
    }

    #[test]
    fn parses_page_urls_durations_and_relative_times() {
        assert_eq!(
            feed_page_url("https://www.youtube.com/feeds/videos.xml?playlist_id=UULF33VP_gIBzCVcEvaGKBocZA").as_deref(),
            Some("https://www.youtube.com/channel/UC33VP_gIBzCVcEvaGKBocZA/videos")
        );
        assert_eq!(
            feed_page_url("https://www.youtube.com/feeds/videos.xml?channel_id=UC33VP_gIBzCVcEvaGKBocZA").as_deref(),
            Some("https://www.youtube.com/channel/UC33VP_gIBzCVcEvaGKBocZA/videos")
        );
        assert_eq!(
            feed_page_url("https://www.youtube.com/feeds/videos.xml?playlist_id=PL12345").as_deref(),
            Some("https://www.youtube.com/playlist?list=PL12345")
        );
        assert_eq!(feed_page_url("https://example.com/feed.xml"), None);

        assert_eq!(parse_duration_text("1:02:03"), Some(3723.0));
        assert_eq!(parse_duration_text("14:25"), Some(865.0));
        assert_eq!(parse_duration_text("LIVE"), None);
        assert_eq!(parse_duration_text("SHORTS"), None);

        let now = 1_700_000_000_000i64;
        assert_eq!(parse_relative_time("Streamed 2 weeks ago", now), Some(now - 14 * 86_400_000));
        assert_eq!(parse_relative_time("3 months ago", now), Some(now - 90 * 86_400_000));
        assert_eq!(parse_relative_time("5 天前", now), Some(now - 5 * 86_400_000));
    }

    #[test]
    fn extracts_initial_data_and_filters_shorts() {
        let html = r#"
        <script>var ytCfg = {"INNERTUBE_API_KEY":"key_123","INNERTUBE_CLIENT_VERSION":"2.20250505.00.00"};</script>
        <script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"title":"Demo Channel","description":"Talks & code","avatar":{"thumbnails":[{"url":"//yt3.ggpht.com/a=s88"},{"url":"//yt3.ggpht.com/a=s240"}]},"channelUrl":"https://www.youtube.com/channel/UC123"}},"contents":[{"videoRenderer":{"videoId":"vid_ok_0001","title":{"runs":[{"text":"Hello; } World"}]},"lengthText":{"simpleText":"12:34"},"publishedTimeText":{"simpleText":"2 days ago"}}},{"videoRenderer":{"videoId":"vid_short_1","title":{"simpleText":"Short clip"},"navigationEndpoint":{"reelWatchEndpoint":{"videoId":"vid_short_1"}}}},{"playlistVideoRenderer":{"videoId":"vid_pl_0002","title":{"simpleText":"Playlist Item"},"lengthSeconds":"615"}},{"continuationItemRenderer":{"continuationEndpoint":{"continuationCommand":{"token":"CONT_ABC"}}}}]};</script>
        "#;
        let now = 1_700_000_000_000i64;
        let batch = parse_page_initial_html(html, "https://www.youtube.com/channel/UC123/videos", now).unwrap();
        assert_eq!(batch.title.as_deref(), Some("Demo Channel"));
        assert_eq!(batch.description.as_deref(), Some("Talks & code"));
        assert_eq!(batch.avatar.as_deref(), Some("https://yt3.ggpht.com/a=s240"));
        assert_eq!(batch.api_key.as_deref(), Some("key_123"));
        assert_eq!(batch.client_version.as_deref(), Some("2.20250505.00.00"));
        assert_eq!(batch.continuation.as_deref(), Some("CONT_ABC"));
        assert_eq!(batch.items.len(), 2);
        assert_eq!(batch.items[0].video_id, "vid_ok_0001");
        assert_eq!(batch.items[0].title, "Hello; } World");
        assert_eq!(batch.items[0].duration, Some(754.0));
        assert_eq!(batch.items[0].published, Some(now - 2 * 86_400_000));
        assert_eq!(batch.items[0].cover, "https://i.ytimg.com/vi/vid_ok_0001/mqdefault.jpg");
        assert_eq!(batch.items[1].video_id, "vid_pl_0002");
        assert_eq!(batch.items[1].duration, Some(615.0));
    }
}
