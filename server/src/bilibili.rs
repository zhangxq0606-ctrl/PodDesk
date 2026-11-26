//! Bilibili single-episode metadata, WBI subtitle fetching, CDN candidate sorting, and stream/audio access.
use crate::asr;
use crate::model::{now_ms, short_hash, Episode, Segment};
use crate::net;
use crate::transcript;
use anyhow::{anyhow, Context, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, RwLock,
};
use std::time::{Duration, Instant};
use tokio::io::AsyncWriteExt;

pub const BILI_REFERER: &str = "https://www.bilibili.com";
pub const BILI_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BiliTarget {
    pub bvid: Option<String>,
    pub aid: Option<u64>,
    pub page: u32,
}

#[derive(Clone, Debug)]
pub struct BiliView {
    pub bvid: String,
    pub cid: i64,
    pub page: u32,
    pub pages_count: usize,
    pub title: String,
    pub part_title: Option<String>,
    pub author: String,
    pub cover: Option<String>,
    pub desc: String,
    pub duration: Option<f64>,
    pub published: Option<i64>,
}

#[derive(Clone, Debug)]
pub struct PlayCandidates {
    pub urls: Vec<String>,
    pub duration: Option<f64>,
    pub cookie: Option<String>,
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

pub fn encode_video_id(bvid: &str, page: u32) -> String {
    if page <= 1 {
        format!("bili:{bvid}")
    } else {
        format!("bili:{bvid}:{page}")
    }
}

pub fn parse_video_id(video_id: &str) -> Option<(&str, u32)> {
    let rest = video_id.strip_prefix("bili:")?;
    if let Some((bvid, p)) = rest.split_once(':') {
        let page = p.parse::<u32>().ok().filter(|&n| n >= 1).unwrap_or(1);
        (!bvid.is_empty()).then_some((bvid, page))
    } else {
        (!rest.is_empty()).then_some((rest, 1))
    }
}

pub fn is_short_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.contains("b23.tv/") || lower.contains("bili2233.cn/")
}

pub fn parse_url(url: &str) -> Option<BiliTarget> {
    if !url.to_ascii_lowercase().contains("bilibili.com") {
        return None;
    }
    let page = re(r"[?&]p=(\d+)")
        .captures(url)
        .and_then(|c| c[1].parse::<u32>().ok())
        .filter(|&n| n >= 1)
        .unwrap_or(1);
    if let Some(c) = re(r"(?i)(?:video/|[?&]bvid=)(BV[0-9A-Za-z]{10})").captures(url) {
        return Some(BiliTarget {
            bvid: Some(c[1].to_string()),
            aid: None,
            page,
        });
    }
    if let Some(c) = re(r"(?i)(?:video/av|[?&]aid=)(\d+)").captures(url) {
        if let Ok(aid) = c[1].parse::<u64>() {
            return Some(BiliTarget {
                bvid: None,
                aid: Some(aid),
                page,
            });
        }
    }
    None
}

pub async fn resolve_short_url(url: &str) -> Result<BiliTarget> {
    for client in http_clients() {
        let Ok(res) = tokio::time::timeout(
            Duration::from_secs(10),
            client.get(url).header("User-Agent", BILI_UA).send(),
        )
        .await
        else {
            continue;
        };
        let Ok(res) = res else { continue };
        let final_url = res.url().as_str().to_string();
        if let Some(target) = parse_url(&final_url) {
            return Ok(target);
        }
        if let Ok(text) = res.text().await {
            if let Some(c) = re(r#"https?://(?:www\.|m\.)?bilibili\.com/video/[^\s"'<>]+"#).captures(&text) {
                if let Some(target) = parse_url(&c[0]) {
                    return Ok(target);
                }
            }
        }
    }
    Err(anyhow!("未能从这个 B站短链接解析出视频地址"))
}

pub fn cookie_header_from_netscape(jar: &str) -> Option<String> {
    let mut pairs = Vec::new();
    for raw in jar.lines() {
        let line = raw.trim();
        let line = line.strip_prefix("#HttpOnly_").unwrap_or(line);
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let cols: Vec<&str> = line.split('\t').collect();
        if cols.len() < 7 {
            continue;
        }
        let domain = cols[0].trim_start_matches('.').to_ascii_lowercase();
        if domain != "bilibili.com" && !domain.ends_with(".bilibili.com") {
            continue;
        }
        let name = cols[5].trim();
        let value = cols[6].trim();
        if !name.is_empty() && !value.is_empty() {
            pairs.push(format!("{name}={value}"));
        }
    }
    (!pairs.is_empty()).then(|| pairs.join("; "))
}

pub fn resolve_cookie_header(data: &Path, yt_login: Option<&dyn crate::YtLoginBridge>) -> Option<String> {
    if let Some(bridge) = yt_login {
        if let Some(jar) = bridge.export_bilibili_cookie_jar() {
            if let Some(header) = cookie_header_from_netscape(&jar) {
                return Some(header);
            }
        }
    }
    let path = asr::ytdlp::cookies_path(data);
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| cookie_header_from_netscape(&raw))
}

pub fn http_clients() -> Vec<reqwest::Client> {
    if net::effective_proxy().is_empty() {
        vec![net::direct_client()]
    } else {
        // Prefer direct connection for domestic Bilibili endpoints even when a global/system proxy is active,
        // falling back to the active proxy when direct access is blocked (e.g. restricted intranet).
        vec![net::direct_client(), net::client()]
    }
}

async fn bili_get_text(url: &str, cookie: Option<&str>) -> Result<String> {
    let mut last_err = anyhow!("请求 B站接口失败");
    for client in http_clients() {
        let mut req = client
            .get(url)
            .header("User-Agent", BILI_UA)
            .header("Referer", BILI_REFERER);
        if let Some(ck) = cookie {
            req = req.header("Cookie", ck);
        }
        match tokio::time::timeout(Duration::from_secs(12), req.send()).await {
            Ok(Ok(res)) if res.status().is_success() => match res.text().await {
                Ok(text) => return Ok(text),
                Err(e) => last_err = e.into(),
            },
            Ok(Ok(res)) => last_err = anyhow!("B站返回 HTTP {}", res.status().as_u16()),
            Ok(Err(e)) => last_err = net::describe(e),
            Err(_) => last_err = anyhow!("连接 B站接口超时"),
        }
    }
    Err(last_err)
}

async fn bili_get_json(url: &str, cookie: Option<&str>) -> Result<Value> {
    let text = bili_get_text(url, cookie).await?;
    serde_json::from_str(&text).map_err(Into::into)
}

pub async fn fetch_view(target: &BiliTarget, cookie: Option<&str>) -> Result<BiliView> {
    let url = if let Some(bvid) = &target.bvid {
        format!("https://api.bilibili.com/x/web-interface/view?bvid={}", urlencoding::encode(bvid))
    } else if let Some(aid) = target.aid {
        format!("https://api.bilibili.com/x/web-interface/view?aid={aid}")
    } else {
        return Err(anyhow!("无效的 B站视频标识"));
    };
    let v = bili_get_json(&url, cookie).await?;
    let code = v["code"].as_i64().unwrap_or(-1);
    if code != 0 {
        let msg = v["message"].as_str().unwrap_or("读取视频信息失败");
        return Err(anyhow!("无法获取 B站视频信息：{msg}"));
    }
    let d = &v["data"];
    let bvid = d["bvid"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| anyhow!("B站返回缺少 BV 号"))?
        .to_string();
    let pages = d["pages"].as_array().cloned().unwrap_or_default();
    let page = target.page.max(1);
    let picked = pages
        .iter()
        .find(|p| p["page"].as_u64() == Some(page as u64))
        .or_else(|| pages.first());
    let actual_page = picked
        .and_then(|p| p["page"].as_u64())
        .map(|n| n as u32)
        .unwrap_or(1);
    let cid = picked
        .and_then(|p| p["cid"].as_i64())
        .or_else(|| d["cid"].as_i64())
        .ok_or_else(|| anyhow!("B站返回缺少视频分集 CID"))?;
    let duration = picked
        .and_then(|p| p["duration"].as_f64())
        .or_else(|| d["duration"].as_f64())
        .filter(|&secs| secs.is_finite() && secs > 0.0);
    let part_title = picked
        .and_then(|p| p["part"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from);
    let cover = d["pic"].as_str().map(|u| {
        if let Some(rest) = u.strip_prefix("http://") {
            format!("https://{rest}")
        } else if u.starts_with("//") {
            format!("https:{u}")
        } else {
            u.to_string()
        }
    });
    let published = d["pubdate"].as_i64().filter(|&s| s > 0).map(|s| s * 1000);
    Ok(BiliView {
        bvid,
        cid,
        page: actual_page,
        pages_count: pages.len().max(1),
        title: d["title"].as_str().unwrap_or("").trim().to_string(),
        part_title,
        author: d["owner"]["name"].as_str().unwrap_or("").trim().to_string(),
        cover,
        desc: d["desc"].as_str().unwrap_or("").trim().to_string(),
        duration,
        published,
    })
}

pub fn to_episode(view: &BiliView) -> Episode {
    let full_title = if view.pages_count > 1 {
        match &view.part_title {
            Some(part) if part != &view.title => format!("{} · P{} {}", view.title, view.page, part),
            _ => format!("{} · P{}", view.title, view.page),
        }
    } else {
        view.title.clone()
    };
    let link = if view.page > 1 {
        format!("https://www.bilibili.com/video/{}?p={}", view.bvid, view.page)
    } else {
        format!("https://www.bilibili.com/video/{}", view.bvid)
    };
    let notes = if view.author.is_empty() {
        (!view.desc.is_empty()).then(|| view.desc.clone())
    } else if view.desc.is_empty() {
        Some(view.author.clone())
    } else {
        Some(format!("{}\n\n{}", view.author, view.desc))
    };
    Episode {
        id: short_hash(&format!("single:bili:{}:{}", view.bvid, view.page), 20),
        show_id: "single".into(),
        guid: format!("bili:{}:p{}", view.bvid, view.page),
        title: if full_title.is_empty() { view.bvid.clone() } else { full_title },
        published: view.published,
        duration: view.duration,
        video_id: Some(encode_video_id(&view.bvid, view.page)),
        link: Some(link),
        cover: view.cover.clone(),
        notes,
        touched_at: Some(now_ms()),
        ..Default::default()
    }
}

// ---- Pure-Rust RFC 1321 MD5 & WBI signing -------------------------------------------------------

const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12,
    38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62,
    11, 36, 20, 34, 44, 52,
];

fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
        14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15,
        21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
        0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
        0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
        0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
        0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
        0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
        0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
    ];
    let mut msg = data.to_vec();
    let bit_len = (data.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0) = (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);
    for chunk in msg.chunks_exact(64) {
        let mut m = [0u32; 16];
        for (i, w) in m.iter_mut().enumerate() {
            *w = u32::from_le_bytes([chunk[i * 4], chunk[i * 4 + 1], chunk[i * 4 + 2], chunk[i * 4 + 3]]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i {
                0..=15 => ((b & c) | ((!b) & d), i),
                16..=31 => ((d & b) | ((!d) & c), (5 * i + 1) % 16),
                32..=47 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | (!d)), (7 * i) % 16),
            };
            let temp = d;
            d = c;
            c = b;
            b = b.wrapping_add(
                a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g]).rotate_left(S[i]),
            );
            a = temp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }
    let mut digest = [0u8; 16];
    digest[0..4].copy_from_slice(&a0.to_le_bytes());
    digest[4..8].copy_from_slice(&b0.to_le_bytes());
    digest[8..12].copy_from_slice(&c0.to_le_bytes());
    digest[12..16].copy_from_slice(&d0.to_le_bytes());
    hex::encode(digest)
}

pub fn wbi_mixin_key(img_key: &str, sub_key: &str) -> String {
    let raw: Vec<u8> = format!("{img_key}{sub_key}").into_bytes();
    MIXIN_KEY_ENC_TAB
        .iter()
        .filter_map(|&idx| raw.get(idx).copied())
        .take(32)
        .map(char::from)
        .collect()
}

pub fn sign_wbi_query(params: &[(&str, &str)], img_key: &str, sub_key: &str, wts: u64) -> String {
    let mixin = wbi_mixin_key(img_key, sub_key);
    let wts_str = wts.to_string();
    let mut pairs: Vec<(String, String)> = params
        .iter()
        .map(|(k, v)| {
            let cleaned: String = v.chars().filter(|c| !matches!(c, '!' | '\'' | '(' | ')' | '*')).collect();
            (k.to_string(), cleaned)
        })
        .collect();
    pairs.push(("wts".to_string(), wts_str));
    pairs.sort_by(|a, b| a.0.cmp(&b.0));
    let query = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", urlencoding::encode(k), urlencoding::encode(v)))
        .collect::<Vec<_>>()
        .join("&");
    let w_rid = md5_hex(format!("{query}{mixin}").as_bytes());
    format!("{query}&w_rid={w_rid}")
}

static WBI_KEYS: Lazy<RwLock<Option<(Instant, String, String)>>> = Lazy::new(|| RwLock::new(None));

fn extract_key_stem(url: &str) -> Option<String> {
    url.rsplit('/').next()?.split('.').next().filter(|s| !s.is_empty()).map(String::from)
}

async fn get_wbi_keys(cookie: Option<&str>) -> Result<(String, String)> {
    if let Some((at, img, sub)) = WBI_KEYS.read().unwrap_or_else(|e| e.into_inner()).clone() {
        if at.elapsed() < Duration::from_secs(3600) {
            return Ok((img, sub));
        }
    }
    let nav = bili_get_json("https://api.bilibili.com/x/web-interface/nav", cookie).await?;
    let w = &nav["data"]["wbi_img"];
    let img = w["img_url"]
        .as_str()
        .and_then(extract_key_stem)
        .ok_or_else(|| anyhow!("无法获取 B站 WBI img_key"))?;
    let sub = w["sub_url"]
        .as_str()
        .and_then(extract_key_stem)
        .ok_or_else(|| anyhow!("无法获取 B站 WBI sub_key"))?;
    *WBI_KEYS.write().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), img.clone(), sub.clone()));
    Ok((img, sub))
}

// ---- Official / AI Subtitles --------------------------------------------------------------------

fn sub_rank(item: &Value) -> (i32, i32) {
    let ai = item["ai_type"].as_i64().unwrap_or(0) != 0;
    let lang = item["lan"].as_str().unwrap_or("").to_ascii_lowercase();
    let human_score = if ai { 0 } else { 10 };
    let lang_score = if lang == "zh-cn" || lang == "zh-hans" || lang == "zh" || lang == "ai-zh" {
        5
    } else if lang.starts_with("zh") {
        4
    } else if lang.starts_with("en") || lang == "ai-en" {
        3
    } else {
        1
    };
    (human_score, lang_score)
}

pub fn parse_bili_subtitle_json(body: &str) -> Vec<Segment> {
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return vec![];
    };
    v["body"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let start = item["from"].as_f64()?;
            let end = item["to"].as_f64().unwrap_or(start + 2.0);
            let text = item["content"].as_str()?.trim().to_string();
            (!text.is_empty()).then_some(Segment { start, end, text })
        })
        .collect()
}

pub async fn fetch_subtitles(
    data: &Path,
    bvid: &str,
    page: u32,
    yt_login: Option<&dyn crate::YtLoginBridge>,
) -> Result<(Vec<Segment>, String, String, Option<f64>)> {
    let cookie = resolve_cookie_header(data, yt_login);
    let view = fetch_view(
        &BiliTarget {
            bvid: Some(bvid.to_string()),
            aid: None,
            page,
        },
        cookie.as_deref(),
    )
    .await?;
    let cid_str = view.cid.to_string();
    let wts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let url = if let Ok((img, sub)) = get_wbi_keys(cookie.as_deref()).await {
        let qs = sign_wbi_query(&[("bvid", &view.bvid), ("cid", &cid_str)], &img, &sub, wts);
        format!("https://api.bilibili.com/x/player/wbi/v2?{qs}")
    } else {
        format!("https://api.bilibili.com/x/player/wbi/v2?bvid={}&cid={}", view.bvid, view.cid)
    };
    let res = bili_get_json(&url, cookie.as_deref()).await?;
    let list = res["data"]["subtitle"]["subtitles"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let best = list
        .iter()
        .filter(|item| item["subtitle_url"].as_str().is_some_and(|u| !u.trim().is_empty()))
        .max_by_key(|item| sub_rank(item));
    let Some(chosen) = best else {
        return if cookie.is_none() {
            Err(anyhow!("未登录 B站暂无法读取官方或 AI 字幕，登录后可自动获取"))
        } else {
            Err(anyhow!("该 B站视频暂未提供官方或 AI 字幕，可使用语音转写"))
        };
    };
    let raw_url = chosen["subtitle_url"].as_str().unwrap_or("");
    let sub_url = if raw_url.starts_with("//") {
        format!("https:{raw_url}")
    } else if let Some(rest) = raw_url.strip_prefix("http://") {
        format!("https://{rest}")
    } else {
        raw_url.to_string()
    };
    let sub_body = bili_get_text(&sub_url, None).await.context("下载 B站字幕内容失败")?;
    let segments = transcript::resegment(transcript::clean(parse_bili_subtitle_json(&sub_body)));
    if segments.is_empty() {
        return Err(anyhow!("B站字幕内容为空"));
    }
    let source = if chosen["ai_type"].as_i64().unwrap_or(0) != 0 {
        "bilibili-ai"
    } else {
        "bilibili"
    };
    let raw_lang = chosen["lan"].as_str().unwrap_or("zh");
    let language = raw_lang.strip_prefix("ai-").unwrap_or(raw_lang).to_string();
    Ok((segments, source.to_string(), language, view.duration))
}

// ---- CDN candidate sorting & playurl cache ------------------------------------------------------

pub fn sort_cdn_urls(urls: Vec<String>) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::new();
    for u in urls {
        let trimmed = u.trim().to_string();
        if !trimmed.is_empty() && seen.insert(trimmed.clone()) {
            deduped.push(trimmed);
        }
    }
    fn tier(url: &str) -> u8 {
        let host = url
            .split("://")
            .nth(1)
            .unwrap_or(url)
            .split('/')
            .next()
            .unwrap_or("")
            .to_ascii_lowercase();
        if host.starts_with("upos-") {
            0
        } else if host.contains("mcdn") || host.contains("pcdn") || host.starts_with("cn-") {
            2
        } else {
            1
        }
    }
    deduped.sort_by_key(|u| tier(u));
    deduped
}

#[derive(Clone, Debug)]
struct CachedPlay {
    at: Instant,
    proxy: String,
    logged_in: bool,
    info: PlayCandidates,
}

static PLAY_CACHE: Lazy<Mutex<HashMap<String, CachedPlay>>> = Lazy::new(|| Mutex::new(HashMap::new()));
const PLAY_CACHE_TTL: Duration = Duration::from_secs(20 * 60);

pub async fn fetch_play_candidates(
    data: &Path,
    bvid: &str,
    page: u32,
    qn_cap: u32,
    fresh: bool,
    yt_login: Option<&dyn crate::YtLoginBridge>,
) -> Result<PlayCandidates> {
    let cookie = resolve_cookie_header(data, yt_login);
    let proxy = net::effective_proxy();
    let key = format!("{bvid}:{page}:{qn_cap}");
    if !fresh {
        let mut guard = PLAY_CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(hit) = guard.get(&key) {
            if hit.at.elapsed() < PLAY_CACHE_TTL && hit.proxy == proxy && hit.logged_in == cookie.is_some() {
                return Ok(hit.info.clone());
            }
        }
        guard.remove(&key);
    }

    let view = fetch_view(
        &BiliTarget {
            bvid: Some(bvid.to_string()),
            aid: None,
            page,
        },
        cookie.as_deref(),
    )
    .await?;
    let target_qn = if cookie.is_some() { qn_cap } else { qn_cap.min(64) };

    let mut urls = Vec::new();
    let mut last_err = anyhow!("无法获取 B站视频流地址");
    for extra in ["", "&platform=html5&high_quality=1"] {
        let api_url = format!(
            "https://api.bilibili.com/x/player/playurl?bvid={}&cid={}&qn={target_qn}&fnval=1{extra}",
            view.bvid, view.cid
        );
        match bili_get_json(&api_url, cookie.as_deref()).await {
            Ok(v) if v["code"].as_i64() == Some(0) => {
                if let Some(durl) = v["data"]["durl"].as_array().and_then(|a| a.first()) {
                    if let Some(u) = durl["url"].as_str() {
                        urls.push(u.to_string());
                    }
                    for bu in durl["backup_url"].as_array().into_iter().flatten() {
                        if let Some(u) = bu.as_str() {
                            urls.push(u.to_string());
                        }
                    }
                }
                if !urls.is_empty() {
                    break;
                }
            }
            Ok(v) => {
                last_err = anyhow!("B站播放接口拒绝：{}", v["message"].as_str().unwrap_or("未知错误"));
            }
            Err(e) => last_err = e,
        }
    }
    let urls = sort_cdn_urls(urls);
    if urls.is_empty() {
        return Err(last_err);
    }
    let info = PlayCandidates {
        urls,
        duration: view.duration,
        cookie,
    };
    PLAY_CACHE.lock().unwrap_or_else(|e| e.into_inner()).insert(
        key,
        CachedPlay {
            at: Instant::now(),
            proxy,
            logged_in: info.cookie.is_some(),
            info: info.clone(),
        },
    );
    Ok(info)
}

pub async fn download_audio(
    data: &Path,
    bvid: &str,
    page: u32,
    dir: &Path,
    cancel: Arc<AtomicBool>,
    yt_login: Option<&dyn crate::YtLoginBridge>,
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    // Progressive 480p/360p MP4 avoids fragmented DASH decoding pitfalls while staying compact.
    let play = fetch_play_candidates(data, bvid, page, 32, false, yt_login).await?;
    let dest = dir.join(format!("{bvid}_p{page}.mp4"));
    let mut last_err = anyhow!("下载 B站视频音频失败");

    'urls: for url in &play.urls {
        for client in http_clients() {
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("已取消"));
            }
            let part = dest.with_extension("part");
            let _ = tokio::fs::remove_file(&part).await;
            let mut req = client
                .get(url)
                .header("User-Agent", BILI_UA)
                .header("Referer", BILI_REFERER);
            if let Some(ck) = &play.cookie {
                req = req.header("Cookie", ck);
            }
            let res = match tokio::time::timeout(Duration::from_secs(12), req.send()).await {
                Ok(Ok(r)) if r.status().is_success() => r,
                Ok(Ok(r)) => {
                    last_err = anyhow!("下载 B站媒体失败（HTTP {}）", r.status().as_u16());
                    continue;
                }
                Ok(Err(e)) => {
                    last_err = net::describe(e);
                    continue;
                }
                Err(_) => {
                    last_err = anyhow!("连接 B站媒体节点超时");
                    continue;
                }
            };
            let mut file = tokio::fs::File::create(&part).await?;
            let mut stream = res.bytes_stream();
            use futures_util::StreamExt;
            let mut stream_err = None;
            while let Some(chunk) = stream.next().await {
                if cancel.load(Ordering::Relaxed) {
                    drop(file);
                    let _ = tokio::fs::remove_file(&part).await;
                    return Err(anyhow!("已取消"));
                }
                match chunk {
                    Ok(bytes) => {
                        file.write_all(&bytes).await?;
                    }
                    Err(e) => {
                        stream_err = Some(e);
                        break;
                    }
                }
            }
            file.flush().await?;
            drop(file);
            if let Some(e) = stream_err {
                let _ = tokio::fs::remove_file(&part).await;
                last_err = net::describe(e);
                continue;
            }
            tokio::fs::rename(&part, &dest).await?;
            if tokio::fs::metadata(&dest).await.is_ok_and(|m| m.len() > 0) {
                return Ok(dest);
            }
            last_err = anyhow!("下载到的 B站文件为空");
            break 'urls;
        }
    }
    Err(last_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_bilibili_urls_and_video_ids() {
        assert_eq!(
            parse_url("https://www.bilibili.com/video/BV1xx411c7mD/?p=3&vd_source=abc"),
            Some(BiliTarget {
                bvid: Some("BV1xx411c7mD".into()),
                aid: None,
                page: 3
            })
        );
        assert_eq!(
            parse_url("https://m.bilibili.com/video/av170001?p=2"),
            Some(BiliTarget {
                bvid: None,
                aid: Some(170001),
                page: 2
            })
        );
        assert!(is_short_url("https://b23.tv/abcDEF"));
        assert_eq!(encode_video_id("BV1xx411c7mD", 1), "bili:BV1xx411c7mD");
        assert_eq!(encode_video_id("BV1xx411c7mD", 2), "bili:BV1xx411c7mD:2");
        assert_eq!(parse_video_id("bili:BV1xx411c7mD"), Some(("BV1xx411c7mD", 1)));
        assert_eq!(parse_video_id("bili:BV1xx411c7mD:4"), Some(("BV1xx411c7mD", 4)));
        assert_eq!(parse_video_id("dQw4w9WgXcQ"), None);
    }

    #[test]
    fn computes_md5_and_wbi_signature() {
        assert_eq!(md5_hex(b"hello"), "5d41402abc4b2a76b9719d911017c592");
        let mixin = wbi_mixin_key(
            "7cd084941338484aae1ad9425b84077c",
            "4932caff0ff746eab6f01bf08b70ac45",
        );
        assert_eq!(mixin.len(), 32);
        let q = sign_wbi_query(&[("cid", "62131"), ("bvid", "BV1xx411c7mD")], "7cd084941338484aae1ad9425b84077c", "4932caff0ff746eab6f01bf08b70ac45", 1700000000);
        assert!(q.starts_with("bvid=BV1xx411c7mD&cid=62131&wts=1700000000&w_rid="));
    }

    #[test]
    fn filters_bilibili_cookies_and_sorts_cdn_urls() {
        let jar = "# Netscape HTTP Cookie File\n\
                   .youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tyt\n\
                   #HttpOnly_.bilibili.com\tTRUE\t/\tTRUE\t0\tSESSDATA\tsecret123\n\
                   .bilibili.com\tTRUE\t/\tFALSE\t0\tbili_jct\tcsrf456\n";
        assert_eq!(
            cookie_header_from_netscape(jar).as_deref(),
            Some("SESSDATA=secret123; bili_jct=csrf456")
        );

        let sorted = sort_cdn_urls(vec![
            "https://cn-jsnj-fx-02-01.bilivideo.com/a.mp4".into(),
            "https://upos-sz-mirrorcos.bilivideo.com/a.mp4".into(),
            "https://xy111x222mcdn.bilivideo.cn/a.mp4".into(),
            "https://upos-sz-estgcos.bilivideo.com/a.mp4".into(),
        ]);
        assert!(sorted[0].contains("upos-sz-mirrorcos"));
        assert!(sorted[1].contains("upos-sz-estgcos"));
        assert!(sorted[2].contains("cn-jsnj-fx"));
    }

    #[test]
    fn parses_bilibili_subtitle_json() {
        let raw = r#"{"body":[{"from":0.5,"to":2.1,"content":"大家好"},{"from":2.4,"to":4.0,"content":"欢迎来到本期节目"}]}"#;
        let segs = parse_bili_subtitle_json(raw);
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].text, "大家好");
        assert!((segs[1].start - 2.4).abs() < 1e-6);
    }
}
