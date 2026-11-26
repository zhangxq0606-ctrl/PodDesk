//! Turning whatever the user pastes into a subscription, and reading feeds.
//! Every source ends up as RSS/Atom except 小宇宙, whose show page carries its latest episodes.
use crate::model::*;
use crate::net;
use anyhow::{anyhow, Result};
use regex::Regex;
use roxmltree::{Document, Node, ParsingOptions};
use serde::Serialize;

pub const MAX_EPISODES: usize = 300;

#[derive(Debug)]
pub enum Source {
    Feed(String),
    Xiaoyuzhou(String),
    YouTubeVideo(String),
    XiaoyuzhouEpisode(String),
    BilibiliVideo(crate::bilibili::BiliTarget),
    DirectMedia(String),
}

fn re(p: &str) -> Regex {
    Regex::new(p).unwrap()
}

/// A feed hosted by 小宇宙 (feed.xyzfm.space), which turns away readers outside its whitelist.
fn is_xyzfm_feed(url: &str) -> bool {
    url.contains("xyzfm.space/")
}

/// A channel's long-form uploads (the "UULF" playlist), so Shorts do not crowd out real episodes.
pub fn channel_feed(channel_id: &str) -> String {
    format!("https://www.youtube.com/feeds/videos.xml?playlist_id=UULF{}", &channel_id[2..])
}

pub fn youtube_video_id(url: &str) -> Option<String> {
    re(r"(?:youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/)|youtu\.be/)([A-Za-z0-9_-]{11})")
        .captures(url)
        .map(|c| c[1].to_string())
}

pub fn extract_pasted_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.contains(char::is_whitespace) {
        if let Some(m) = re(r#"https?://[^\s<>"'）)】\]]+"#).find(trimmed) {
            return m.as_str().trim_end_matches(['.', ',', ';', '。', '，']).to_string();
        }
    }
    trimmed.to_string()
}

pub fn is_direct_media_url(url: &str) -> bool {
    let clean = url.trim().split(['?', '#']).next().unwrap_or(url).to_ascii_lowercase();
    [".mp3", ".m4a", ".aac", ".wav", ".flac", ".ogg", ".opus", ".mp4", ".webm", ".mov", ".mkv"]
        .iter()
        .any(|ext| clean.ends_with(ext))
}

fn meta_content(html: &str, prop: &str) -> Option<String> {
    let p1 = format!(r#"(?i)<meta[^>]+(?:property|name)=["']{}["'][^>]+content=["']([^"']+)["']"#, regex::escape(prop));
    let p2 = format!(r#"(?i)<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']{}["']"#, regex::escape(prop));
    re(&p1)
        .captures(html)
        .or_else(|| re(&p2).captures(html))
        .map(|c| crate::transcript::decode_entities(&c[1]).trim().to_string())
        .filter(|s| !s.is_empty())
}

pub fn parse_spotify_show_query(page_url: &str, html: &str) -> Option<(Option<String>, Option<String>)> {
    if page_url.contains("/episode/") {
        if let Some(c) = re(r#"https://open\.spotify\.com/show/[A-Za-z0-9]+"#).find(html) {
            return Some((None, Some(c.as_str().to_string())));
        }
        if let Some(c) = re(r#""/show/([A-Za-z0-9]+)""#).captures(html) {
            return Some((None, Some(format!("https://open.spotify.com/show/{}", &c[1]))));
        }
        if let Some(raw) = re(r"(?is)<title>(.*?)</title>").captures(html).map(|c| crate::transcript::decode_entities(&c[1])) {
            let clean = raw.trim().strip_suffix("| Podcast on Spotify").unwrap_or(&raw).trim();
            if let Some((_, show)) = clean.rsplit_once(" - ") {
                let s = show.trim().to_string();
                if !s.is_empty() {
                    return Some((Some(s), None));
                }
            }
        }
    }
    if let Some(og) = meta_content(html, "og:title") {
        let cleaned = og.strip_suffix("| Podcast on Spotify").unwrap_or(&og).trim().to_string();
        if !cleaned.is_empty() {
            return Some((Some(cleaned), None));
        }
    }
    re(r"(?is)<title>(.*?)</title>")
        .captures(html)
        .map(|c| {
            let raw = crate::transcript::decode_entities(&c[1]);
            raw.trim().strip_suffix("| Podcast on Spotify").unwrap_or(raw.trim()).trim().to_string()
        })
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("Spotify"))
        .map(|s| (Some(s), None))
}

async fn resolve_apple_podcast_id(id: &str) -> Result<Source> {
    let v: serde_json::Value = net::client()
        .get(format!("https://itunes.apple.com/lookup?id={id}&entity=podcast"))
        .send()
        .await?
        .json()
        .await?;
    let feed = v["results"][0]["feedUrl"]
        .as_str()
        .ok_or_else(|| anyhow!("这档节目没有公开 RSS（可能是 Apple 独家）"))?;
    if is_xyzfm_feed(feed) {
        if let Ok(html) = net::get_text(&format!("https://podcasts.apple.com/podcast/id{id}")).await {
            if let Some(c) = re(r"xiaoyuzhoufm\.com/podcast/([0-9a-f]{24})").captures(&html) {
                return Ok(Source::Xiaoyuzhou(format!("https://www.xiaoyuzhoufm.com/podcast/{}", &c[1])));
            }
        }
    }
    Ok(Source::Feed(feed.to_string()))
}

async fn resolve_spotify(url: &str) -> Result<Source> {
    let res = net::get(url).await?;
    let final_url = res.url().as_str().to_string();
    let html = res.text().await?;
    let parsed = parse_spotify_show_query(&final_url, &html);
    let show_name = match parsed {
        Some((Some(name), _)) => name,
        Some((None, Some(show_url))) => {
            let show_html = net::get_text(&show_url).await?;
            match parse_spotify_show_query(&show_url, &show_html) {
                Some((Some(name), _)) => name,
                _ => return Err(anyhow!("未能从 Spotify 页面识别节目名称")),
            }
        }
        _ => return Err(anyhow!("未能从 Spotify 页面识别节目名称（可能需要登录或为平台独家）")),
    };
    let mut best: Option<SearchResult> = None;
    for country in ["us", "cn"] {
        if let Ok(list) = search_apple(&show_name, country).await {
            let norm = |s: &str| s.trim().to_lowercase();
            let target = norm(&show_name);
            if let Some(hit) = list
                .iter()
                .find(|r| norm(&r.title) == target)
                .or_else(|| list.first())
                .cloned()
            {
                best = Some(hit);
                break;
            }
        }
    }
    let Some(hit) = best else {
        return Err(anyhow!("未能从公开播客目录匹配到「{show_name}」的 RSS（可能是 Spotify 独家节目）"));
    };
    if hit.feed_url.contains("podcasts.apple.com") {
        if let Some(c) = re(r"/id(\d+)").captures(&hit.feed_url) {
            return resolve_apple_podcast_id(&c[1]).await;
        }
    }
    Ok(Source::Feed(hit.feed_url))
}

/// Works out what a pasted link points at. May fetch a page (YouTube handles, Apple Podcasts ids, Bilibili, Spotify, HTML pages).
pub async fn resolve(input: &str) -> Result<Source> {
    let extracted = extract_pasted_url(input);
    let input = extracted.trim();
    if input.is_empty() {
        return Err(anyhow!("请粘贴链接"));
    }
    let url = if input.starts_with("http://") || input.starts_with("https://") {
        input.to_string()
    } else if input.starts_with('@') {
        format!("https://www.youtube.com/{input}")
    } else {
        format!("https://{input}")
    };
    if let Some(target) = crate::bilibili::parse_url(&url) {
        return Ok(Source::BilibiliVideo(target));
    }
    if crate::bilibili::is_short_url(&url) {
        let target = crate::bilibili::resolve_short_url(&url).await?;
        return Ok(Source::BilibiliVideo(target));
    }
    if let Some(id) = youtube_video_id(&url) {
        if !url.contains("list=") || url.contains("watch?v=") {
            return Ok(Source::YouTubeVideo(id));
        }
    }
    if url.contains("youtube.com") {
        if let Some(c) = re(r"[?&]list=([A-Za-z0-9_-]+)").captures(&url) {
            return Ok(Source::Feed(format!("https://www.youtube.com/feeds/videos.xml?playlist_id={}", &c[1])));
        }
        if let Some(c) = re(r"youtube\.com/channel/(UC[A-Za-z0-9_-]{22})").captures(&url) {
            return Ok(Source::Feed(channel_feed(&c[1])));
        }
        if url.contains("feeds/videos.xml") {
            return Ok(Source::Feed(url));
        }
        let html = net::get_text(&url).await?;
        let id = re(r#"<link rel="canonical" href="https://www\.youtube\.com/channel/(UC[A-Za-z0-9_-]{22})""#)
            .captures(&html)
            .or_else(|| re(r#""externalId":"(UC[A-Za-z0-9_-]{22})""#).captures(&html))
            .or_else(|| re(r#""channelId":"(UC[A-Za-z0-9_-]{22})""#).captures(&html))
            .map(|c| c[1].to_string())
            .ok_or_else(|| anyhow!("没有在这个页面找到 YouTube 频道"))?;
        return Ok(Source::Feed(channel_feed(&id)));
    }
    if url.contains("podcasts.apple.com") {
        let id = re(r"/id(\d+)")
            .captures(&url)
            .map(|c| c[1].to_string())
            .ok_or_else(|| anyhow!("无法识别 Apple Podcasts 链接"))?;
        return resolve_apple_podcast_id(&id).await;
    }
    if url.contains("open.spotify.com/") || url.contains("spotify.link/") {
        return resolve_spotify(&url).await;
    }
    if url.contains("xiaoyuzhoufm.com/podcast/") {
        return Ok(Source::Xiaoyuzhou(url));
    }
    if url.contains("xiaoyuzhoufm.com/episode/") {
        return Ok(Source::XiaoyuzhouEpisode(url));
    }
    if is_direct_media_url(&url) {
        return Ok(Source::DirectMedia(url));
    }
    if is_direct_feed(&url) {
        return Ok(Source::Feed(url));
    }
    let res = net::get(&url).await?;
    let final_url = res.url().as_str().to_string();
    let content_type = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    if content_type.starts_with("audio/") || content_type.starts_with("video/") {
        return Ok(Source::DirectMedia(final_url));
    }
    let body = res.text().await?;
    if is_xyzfm_feed(&url) && body.contains("403 Forbidden") {
        return Err(anyhow!("小宇宙的 RSS 不对外开放，请粘贴小宇宙 App 里分享的节目链接"));
    }
    let head = body.trim_start().get(..800).unwrap_or(body.trim_start());
    if head.starts_with("<?xml") || head.contains("<rss") || head.contains("<feed") {
        return Ok(Source::Feed(url));
    }
    if let Some(c) = re(r#"<link[^>]+type="application/(?:rss|atom)\+xml"[^>]*href="([^"]+)""#).captures(&body) {
        let href = crate::transcript::decode_entities(&c[1]);
        let abs = reqwest::Url::parse(&url)?.join(&href)?;
        return Ok(Source::Feed(abs.to_string()));
    }
    Err(anyhow!(
        "没有识别出订阅源。支持 YouTube、B站视频、Apple/Spotify 播客、小宇宙、RSS 和音视频直链"
    ))
}

pub fn is_direct_feed(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    let rest = u.split_once("://").map(|(_, r)| r).unwrap_or(&u);
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.split(['?', '#']).next().unwrap_or(path);
    host.starts_with("feeds.")
        || host.starts_with("rss.")
        || path.ends_with(".xml")
        || path.ends_with(".rss")
        || path.split('/').any(|s| s == "rss" || s == "feed" || s == "atom")
}

// ---- RSS / Atom ---------------------------------------------------------------------------------

fn child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children().find(|c| c.is_element() && c.tag_name().name() == name)
}
fn child_ns<'a, 'i>(n: Node<'a, 'i>, ns: &str, name: &str) -> Option<Node<'a, 'i>> {
    n.children()
        .find(|c| c.is_element() && c.tag_name().name() == name && c.tag_name().namespace().is_some_and(|x| x.contains(ns)))
}
fn text_of(n: Option<Node>) -> Option<String> {
    let t: String = n?.descendants().filter(|d| d.is_text()).map(|d| d.text().unwrap_or("")).collect();
    let t = t.trim().to_string();
    (!t.is_empty()).then_some(t)
}
fn plain_child<'a, 'i>(n: Node<'a, 'i>, name: &str) -> Option<Node<'a, 'i>> {
    n.children()
        .find(|c| c.is_element() && c.tag_name().name() == name && c.tag_name().namespace().is_none_or(|x| x.is_empty() || x.contains("Atom")))
}

fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let no_weekday = s
        .split_once(", ")
        .filter(|(d, _)| d.len() <= 9 && d.chars().all(|c| c.is_ascii_alphabetic()))
        .map(|(_, r)| r)
        .unwrap_or(s);
    chrono::DateTime::parse_from_rfc2822(no_weekday)
        .or_else(|_| chrono::DateTime::parse_from_rfc2822(s))
        .or_else(|_| chrono::DateTime::parse_from_rfc3339(s))
        .or_else(|_| chrono::DateTime::parse_from_str(s, "%a, %d %b %Y %H:%M:%S %Z"))
        .map(|d| d.timestamp_millis())
        .ok()
}

fn parse_duration(s: &str) -> Option<f64> {
    let s = s.trim();
    if let Ok(v) = s.parse::<f64>() {
        return (v > 0.0).then_some(v);
    }
    let mut total = 0.0;
    for p in s.split(':') {
        total = total * 60.0 + p.trim().parse::<f64>().ok()?;
    }
    (total > 0.0).then_some(total)
}

fn transcript_rank(kind: &str) -> i32 {
    match kind {
        k if k.contains("vtt") => 4,
        k if k.contains("srt") || k.contains("subrip") => 3,
        k if k.contains("json") => 2,
        _ => 0,
    }
}

pub fn parse_feed(xml: &str, feed_url: &str) -> Result<(Show, Vec<Episode>)> {
    parse_feed_limit(xml, feed_url, MAX_EPISODES)
}

pub fn parse_feed_limit(xml: &str, feed_url: &str, limit: usize) -> Result<(Show, Vec<Episode>)> {
    let opts = ParsingOptions { allow_dtd: true, ..Default::default() };
    let doc = Document::parse_with_options(xml, opts).map_err(|e| anyhow!("订阅源格式错误：{e}"))?;
    let root = doc.root_element();
    let show_id = short_hash(feed_url, 16);
    let mut episodes = Vec::new();
    if root.tag_name().name() == "feed" {
        let youtube = feed_url.contains("youtube.com");
        let title = text_of(child(root, "title")).unwrap_or_default();
        let author = child(root, "author").and_then(|a| text_of(child(a, "name")));
        let title = if youtube && feed_url.contains("playlist_id=UU") {
            author.clone().unwrap_or(title)
        } else {
            title
        };
        let link = root
            .children()
            .find(|c| c.tag_name().name() == "link" && c.attribute("rel") == Some("alternate"))
            .and_then(|l| l.attribute("href"))
            .map(String::from);
        for e in root.children().filter(|c| c.tag_name().name() == "entry").take(limit) {
            let video_id = text_of(child_ns(e, "youtube", "videoId"));
            let guid = video_id.clone().or_else(|| text_of(child(e, "id"))).unwrap_or_default();
            let group = child_ns(e, "search.yahoo.com/mrss", "group");
            let cover = group
                .and_then(|g| child_ns(g, "mrss", "thumbnail"))
                .and_then(|t| t.attribute("url"))
                .map(String::from);
            let notes = group
                .and_then(|g| text_of(child_ns(g, "mrss", "description")))
                .or_else(|| text_of(child(e, "summary")));
            let link = e
                .children()
                .find(|c| c.tag_name().name() == "link")
                .and_then(|l| l.attribute("href"))
                .map(String::from);
            if link.as_deref().is_some_and(|l| l.contains("/shorts/")) {
                continue;
            }
            episodes.push(Episode {
                id: short_hash(&format!("{show_id}:{guid}"), 20),
                show_id: show_id.clone(),
                guid,
                title: text_of(child(e, "title")).unwrap_or_default(),
                published: text_of(child(e, "published")).and_then(|d| parse_date(&d)),
                video_id,
                link,
                cover,
                notes: notes.map(|n| n.chars().take(20_000).collect()),
                ..Default::default()
            });
        }
        let cover = episodes.first().and_then(|e| e.cover.clone());
        let show = Show {
            id: show_id,
            kind: if youtube { "youtube" } else { "podcast" }.into(),
            title,
            author,
            cover,
            feed_url: feed_url.into(),
            link,
            description: None,
            updated_at: now_ms(),
            unplayed: 0,
        };
        return Ok((show, episodes));
    }
    let channel = child(root, "channel").ok_or_else(|| anyhow!("不是 RSS 订阅源"))?;
    let cover = child_ns(channel, "itunes", "image")
        .and_then(|i| i.attribute("href"))
        .map(String::from)
        .or_else(|| plain_child(channel, "image").and_then(|i| text_of(child(i, "url"))));
    for item in channel.children().filter(|c| c.tag_name().name() == "item").take(limit) {
        let enclosure = child(item, "enclosure");
        let audio = enclosure.and_then(|e| e.attribute("url")).map(|u| u.trim().to_string());
        let link = text_of(plain_child(item, "link"));
        let video_id = link.as_deref().and_then(youtube_video_id);
        if audio.is_none() && video_id.is_none() {
            continue;
        }
        let guid = text_of(child(item, "guid")).or_else(|| audio.clone()).unwrap_or_default();
        let transcript = item
            .children()
            .filter(|c| c.tag_name().name() == "transcript" && c.tag_name().namespace().is_some_and(|n| n.contains("podcastindex")))
            .filter_map(|t| Some((t.attribute("url")?.to_string(), t.attribute("type").unwrap_or("").to_lowercase())))
            .filter(|(_, k)| transcript_rank(k) > 0)
            .max_by_key(|(_, k)| transcript_rank(k));
        let notes = text_of(child_ns(item, "purl.org/rss/1.0/modules/content", "encoded"))
            .or_else(|| text_of(plain_child(item, "description")))
            .or_else(|| text_of(child_ns(item, "itunes", "summary")));
        episodes.push(Episode {
            id: short_hash(&format!("{show_id}:{guid}"), 20),
            show_id: show_id.clone(),
            guid,
            title: text_of(plain_child(item, "title")).unwrap_or_default(),
            published: text_of(child(item, "pubDate")).and_then(|d| parse_date(&d)),
            duration: text_of(child_ns(item, "itunes", "duration")).and_then(|d| parse_duration(&d)),
            audio_url: audio,
            video_id,
            link,
            cover: child_ns(item, "itunes", "image").and_then(|i| i.attribute("href")).map(String::from),
            notes: notes.map(|n| n.chars().take(40_000).collect()),
            transcript_url: transcript.as_ref().map(|t| t.0.clone()),
            transcript_type: transcript.map(|t| t.1),
            ..Default::default()
        });
    }
    let show = Show {
        id: show_id,
        kind: "podcast".into(),
        title: text_of(plain_child(channel, "title")).unwrap_or_default(),
        author: text_of(child_ns(channel, "itunes", "author")),
        cover,
        feed_url: feed_url.into(),
        link: text_of(plain_child(channel, "link")),
        description: text_of(plain_child(channel, "description")).map(|d| d.chars().take(2000).collect()),
        updated_at: now_ms(),
        unplayed: 0,
    };
    Ok((show, episodes))
}

// ---- 小宇宙 ---------------------------------------------------------------------------------------

fn next_data(html: &str) -> Result<serde_json::Value> {
    let c = re(r#"(?s)<script id="__NEXT_DATA__"[^>]*>(.*?)</script>"#)
        .captures(html)
        .ok_or_else(|| anyhow!("小宇宙页面结构变化，读取失败"))?;
    Ok(serde_json::from_str(&c[1])?)
}

fn xyz_episode(e: &serde_json::Value, show_id: &str) -> Option<Episode> {
    let eid = e["eid"].as_str()?;
    Some(Episode {
        id: short_hash(&format!("{show_id}:{eid}"), 20),
        show_id: show_id.to_string(),
        guid: eid.to_string(),
        title: e["title"].as_str().unwrap_or_default().to_string(),
        published: e["pubDate"].as_str().and_then(parse_date),
        duration: e["duration"].as_f64(),
        audio_url: e["enclosure"]["url"].as_str().or_else(|| e["media"]["source"]["url"].as_str()).map(String::from),
        link: Some(format!("https://www.xiaoyuzhoufm.com/episode/{eid}")),
        cover: e["image"]["picUrl"].as_str().map(String::from),
        notes: e["shownotes"].as_str().or_else(|| e["description"].as_str()).map(String::from),
        ..Default::default()
    })
}

pub async fn xiaoyuzhou_show(url: &str) -> Result<(Show, Vec<Episode>)> {
    let v = next_data(&net::get_text(url).await?)?;
    let p = &v["props"]["pageProps"]["podcast"];
    let pid = p["pid"].as_str().ok_or_else(|| anyhow!("没有找到小宇宙节目"))?;
    let feed_url = format!("https://www.xiaoyuzhoufm.com/podcast/{pid}");
    let show_id = short_hash(&feed_url, 16);
    let episodes = p["episodes"].as_array().into_iter().flatten().filter_map(|e| xyz_episode(e, &show_id)).collect();
    let show = Show {
        id: show_id,
        kind: "xiaoyuzhou".into(),
        title: p["title"].as_str().unwrap_or_default().into(),
        author: p["author"].as_str().map(String::from),
        cover: p["image"]["middlePicUrl"].as_str().or_else(|| p["image"]["picUrl"].as_str()).map(String::from),
        feed_url: feed_url.clone(),
        link: Some(feed_url),
        description: p["description"].as_str().map(String::from),
        updated_at: now_ms(),
        unplayed: 0,
    };
    Ok((show, episodes))
}

pub async fn xiaoyuzhou_episode(url: &str) -> Result<Episode> {
    let v = next_data(&net::get_text(url).await?)?;
    let e = &v["props"]["pageProps"]["episode"];
    let mut ep = xyz_episode(e, "single").ok_or_else(|| anyhow!("没有找到这集节目"))?;
    ep.cover = ep.cover.or_else(|| e["podcast"]["image"]["middlePicUrl"].as_str().map(String::from));
    Ok(ep)
}

pub async fn fetch_show(feed_url: &str, kind: &str) -> Result<(Show, Vec<Episode>)> {
    if kind == "xiaoyuzhou" {
        return xiaoyuzhou_show(feed_url).await;
    }
    let xml = net::get_text(feed_url).await?;
    parse_feed(&xml, feed_url)
}

// ---- search ---------------------------------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub author: String,
    pub cover: Option<String>,
    pub feed_url: String,
    pub genre: Option<String>,
    pub episodes: Option<i64>,
    pub source: Option<String>,
}

pub async fn search_podcasts(term: &str, country: &str) -> Result<Vec<SearchResult>> {
    let (yt, pods) = tokio::join!(search_youtube_channels(term), search_apple(term, country));
    let mut out = yt.unwrap_or_default();
    match pods {
        Ok(p) => out.extend(p),
        Err(e) if out.is_empty() => return Err(e),
        Err(_) => {}
    }
    Ok(out)
}

async fn search_youtube_channels(term: &str) -> Result<Vec<SearchResult>> {
    const MAX: usize = 3;
    let html = net::get_text(&format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAg%253D%253D",
        urlencoding::encode(term)
    ))
    .await?;
    let json = re(r"var ytInitialData = (\{.*?\});</script>")
        .captures(&html)
        .ok_or_else(|| anyhow!("YouTube 搜索页没有结果数据"))?;
    let data: serde_json::Value = serde_json::from_str(&json[1])?;
    let mut found = Vec::new();
    collect_channels(&data, &mut found, MAX);
    Ok(found)
}

fn collect_channels(v: &serde_json::Value, out: &mut Vec<SearchResult>, max: usize) {
    if out.len() >= max {
        return;
    }
    match v {
        serde_json::Value::Object(m) => {
            if let Some(c) = m.get("channelRenderer") {
                if let (Some(id), Some(title)) = (c["channelId"].as_str(), c["title"]["simpleText"].as_str()) {
                    if id.starts_with("UC") && id.len() == 24 {
                        let cover = c["thumbnail"]["thumbnails"]
                            .as_array()
                            .and_then(|t| t.last())
                            .and_then(|t| t["url"].as_str())
                            .map(|u| if u.starts_with("//") { format!("https:{u}") } else { u.to_string() });
                        out.push(SearchResult {
                            title: title.into(),
                            author: c["subscriberCountText"]["simpleText"]
                                .as_str()
                                .filter(|h| h.starts_with('@'))
                                .unwrap_or("YouTube")
                                .into(),
                            cover,
                            feed_url: channel_feed(id),
                            genre: None,
                            episodes: None,
                            source: Some("youtube".into()),
                        });
                    }
                }
                return;
            }
            for x in m.values() {
                collect_channels(x, out, max);
            }
        }
        serde_json::Value::Array(a) => {
            for x in a {
                collect_channels(x, out, max);
            }
        }
        _ => {}
    }
}

async fn search_apple(term: &str, country: &str) -> Result<Vec<SearchResult>> {
    let url = format!(
        "https://itunes.apple.com/search?media=podcast&entity=podcast&limit=25&country={}&term={}",
        country,
        urlencoding::encode(term)
    );
    let v: serde_json::Value = net::get_json(&url).await?;
    Ok(v["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(SearchResult {
                title: r["collectionName"].as_str()?.into(),
                author: r["artistName"].as_str().unwrap_or("").into(),
                cover: r["artworkUrl600"].as_str().or_else(|| r["artworkUrl100"].as_str()).map(String::from),
                feed_url: match (r["feedUrl"].as_str()?, r["collectionId"].as_i64()) {
                    (f, Some(id)) if is_xyzfm_feed(f) => format!("https://podcasts.apple.com/podcast/id{id}"),
                    (f, _) => f.into(),
                },
                genre: r["primaryGenreName"].as_str().map(String::from),
                episodes: r["trackCount"].as_i64(),
                source: None,
            })
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rss_with_transcript() {
        let xml = r#"<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel><title>Show</title><itunes:image href="https://x/c.jpg"/>
        <item><title>Ep 1</title><guid>g1</guid><pubDate>Mon, 10 Nov 2026 10:00:00 GMT</pubDate><itunes:duration>1:02:03</itunes:duration>
        <enclosure url="https://x/1.mp3" type="audio/mpeg"/><podcast:transcript url="https://x/1.json" type="application/json"/><podcast:transcript url="https://x/1.vtt" type="text/vtt"/></item></channel></rss>"#;
        let (s, e) = parse_feed(xml, "https://x/feed").unwrap();
        assert_eq!(s.title, "Show");
        assert_eq!(s.cover.as_deref(), Some("https://x/c.jpg"));
        assert_eq!(e[0].duration, Some(3723.0));
        assert_eq!(e[0].transcript_url.as_deref(), Some("https://x/1.vtt"));
        assert!(e[0].published.is_some());
    }

    #[test]
    fn youtube_channel_results() {
        let data: serde_json::Value = serde_json::from_str(r#"{"contents":[{"itemSectionRenderer":{"contents":[
            {"channelRenderer":{"channelId":"UC33VP_gIBzCVcEvaGKBocZA","title":{"simpleText":"罗永浩的十字路口"},"subscriberCountText":{"simpleText":"@罗永浩的十字路口"},"thumbnail":{"thumbnails":[{"url":"//yt3.ggpht.com/a=s88"},{"url":"//yt3.ggpht.com/a=s176"}]}}},
            {"channelRenderer":{"channelId":"UC3Ilesza14SKQBwCTCmhj4w","title":{"simpleText":"二号"},"thumbnail":{"thumbnails":[]}}}]}}]}"#).unwrap();
        let mut out = Vec::new();
        collect_channels(&data, &mut out, 3);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].feed_url, "https://www.youtube.com/feeds/videos.xml?playlist_id=UULF33VP_gIBzCVcEvaGKBocZA");
        assert_eq!(out[0].author, "@罗永浩的十字路口");
        assert_eq!(out[0].cover.as_deref(), Some("https://yt3.ggpht.com/a=s176"));
        assert_eq!(out[1].author, "YouTube");
    }

    #[test]
    fn direct_feeds_skip_the_probe() {
        assert!(is_direct_feed("https://feeds.simplecast.com/JGE3yC0V"));
        assert!(is_direct_feed("https://rss.libsyn.com/shows/61840/destinations/240976.xml"));
        assert!(is_direct_feed("https://anchor.fm/s/f7cac464/podcast/rss"));
        assert!(is_direct_feed("https://api.substack.com/feed/podcast/10845.rss"));
        assert!(!is_direct_feed("https://www.youtube.com/@ycombinator"));
        assert!(!is_direct_feed("https://podcasts.apple.com/us/podcast/example/id123"));
    }

    #[test]
    fn video_ids() {
        assert_eq!(youtube_video_id("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1").as_deref(), Some("dQw4w9WgXcQ"));
        assert_eq!(youtube_video_id("https://youtu.be/dQw4w9WgXcQ").as_deref(), Some("dQw4w9WgXcQ"));
    }

    #[test]
    fn direct_media_share_text_and_spotify_meta() {
        assert!(is_direct_media_url("https://cdn.example.com/talk/ep12.mp3?token=1"));
        assert!(is_direct_media_url("https://cdn.example.com/video/clip.MP4"));
        assert!(!is_direct_media_url("https://example.com/feed.xml"));

        assert_eq!(
            extract_pasted_url("【罗翔老师讲刑法】 https://b23.tv/abc123。"),
            "https://b23.tv/abc123"
        );

        let show_html = r#"<html><head><meta property="og:title" content="The Joe Rogan Experience"><title>The Joe Rogan Experience | Podcast on Spotify</title></head></html>"#;
        assert_eq!(
            parse_spotify_show_query("https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk", show_html),
            Some((Some("The Joe Rogan Experience".into()), None))
        );

        let ep_html = r#"<html><head><title>Ep 100 - Acquired | Podcast on Spotify</title></head></html>"#;
        assert_eq!(
            parse_spotify_show_query("https://open.spotify.com/episode/abc", ep_html),
            Some((Some("Acquired".into()), None))
        );
    }
}
