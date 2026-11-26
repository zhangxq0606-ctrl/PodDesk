//! Lightweight in-app update checker backed by GitHub Releases (no auto-overwrite or private server).
use crate::net;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RELEASES_API: &str = "https://api.github.com/repos/zhangxq0606-ctrl/PodDesk/releases?per_page=10";
const RELEASES_ATOM: &str = "https://github.com/zhangxq0606-ctrl/PodDesk/releases.atom";
const RELEASES_PAGE: &str = "https://github.com/zhangxq0606-ctrl/PodDesk/releases";
const DOWNLOAD_BASE: &str = "https://github.com/zhangxq0606-ctrl/PodDesk/releases/download";
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub current_version: String,
    pub latest_version: String,
    pub has_update: bool,
    pub tag_name: String,
    pub title: String,
    pub notes: String,
    pub published_at: Option<String>,
    pub prerelease: bool,
    pub release_url: String,
    pub download_url: String,
    pub mirror_download_url: Option<String>,
    pub asset_name: Option<String>,
    pub asset_size: Option<u64>,
    pub platform: String,
    pub checked_at: i64,
}

static CACHE: Lazy<Mutex<Option<(Instant, UpdateInfo)>>> = Lazy::new(|| Mutex::new(None));
static HTML_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"<[^>]+>").unwrap());

pub fn parse_semver(raw: &str) -> Option<(u64, u64, u64)> {
    let trimmed = raw.trim().trim_start_matches(['v', 'V']);
    let core = trimmed.split(['-', '+']).next()?.trim();
    let mut parts = core.split('.');
    let major = parts.next()?.parse::<u64>().ok()?;
    let minor = parts.next()?.parse::<u64>().ok()?;
    let patch = parts.next()?.parse::<u64>().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

pub fn platform_target(os: &str, arch: &str) -> (String, Option<&'static str>) {
    match (os, arch) {
        ("windows", "x86_64") => ("windows-x64".to_string(), Some("_x64-setup.exe")),
        ("macos", "aarch64") => ("macos-arm64".to_string(), Some("_aarch64.dmg")),
        _ => (format!("{os}-{arch}"), None),
    }
}

pub fn current_platform() -> (String, Option<&'static str>) {
    platform_target(std::env::consts::OS, std::env::consts::ARCH)
}

fn empty_update_info(current: &str, platform: String, now_ms: i64) -> UpdateInfo {
    UpdateInfo {
        current_version: current.to_string(),
        latest_version: current.to_string(),
        has_update: false,
        tag_name: format!("v{current}"),
        title: String::new(),
        notes: String::new(),
        published_at: None,
        prerelease: false,
        release_url: RELEASES_PAGE.to_string(),
        download_url: RELEASES_PAGE.to_string(),
        mirror_download_url: None,
        asset_name: None,
        asset_size: None,
        platform,
        checked_at: now_ms,
    }
}

pub fn pick_latest_release<'a>(releases: &'a [Value], current: &str, os: &str, arch: &str, now_ms: i64) -> UpdateInfo {
    let cur_sem = parse_semver(current).unwrap_or((0, 0, 0));
    let (platform, asset_suffix) = platform_target(os, arch);

    let best = releases
        .iter()
        .filter(|r| r["draft"].as_bool() != Some(true))
        .filter_map(|r| {
            let tag = r["tag_name"].as_str()?;
            let sem = parse_semver(tag)?;
            Some((sem, r))
        })
        .max_by_key(|(sem, _)| *sem);

    let Some((latest_sem, rel)) = best else {
        return empty_update_info(current, platform, now_ms);
    };

    let tag_name = rel["tag_name"].as_str().unwrap_or_default().to_string();
    let latest_version = format!("{}.{}.{}", latest_sem.0, latest_sem.1, latest_sem.2);
    let release_url = rel["html_url"].as_str().unwrap_or(RELEASES_PAGE).to_string();
    let asset = asset_suffix.and_then(|sfx| {
        rel["assets"].as_array().and_then(|arr| {
            arr.iter().find(|a| {
                a["name"].as_str().is_some_and(|n| n.ends_with(sfx))
                    && a["state"].as_str().is_none_or(|st| st == "uploaded")
            })
        })
    });

    let asset_name = asset.and_then(|a| a["name"].as_str()).map(str::to_string);
    let asset_size = asset.and_then(|a| a["size"].as_u64());
    let direct_url = asset
        .and_then(|a| a["browser_download_url"].as_str())
        .map(str::to_string)
        .unwrap_or_else(|| release_url.clone());

    let mirror_download_url = asset
        .and_then(|a| a["browser_download_url"].as_str())
        .and_then(|orig| net::github_release_urls(orig).into_iter().find(|u| u != orig));

    UpdateInfo {
        current_version: current.to_string(),
        latest_version,
        has_update: latest_sem > cur_sem,
        tag_name,
        title: rel["name"].as_str().unwrap_or_default().trim().to_string(),
        notes: rel["body"].as_str().unwrap_or_default().trim().to_string(),
        published_at: rel["published_at"].as_str().map(str::to_string),
        prerelease: rel["prerelease"].as_bool().unwrap_or(false),
        release_url,
        download_url: direct_url,
        mirror_download_url,
        asset_name,
        asset_size,
        platform,
        checked_at: now_ms,
    }
}

fn atom_html_to_markdown(raw: &str) -> String {
    let text = raw
        .replace("<h3>", "\n### ")
        .replace("</h3>", "\n")
        .replace("<h4>", "\n#### ")
        .replace("</h4>", "\n")
        .replace("<li>", "- ")
        .replace("</li>", "\n")
        .replace("</p>", "\n\n")
        .replace("<br>", "\n")
        .replace("<br/>", "\n")
        .replace("<br />", "\n")
        .replace("<strong>", "**")
        .replace("</strong>", "**")
        .replace("<code>", "`")
        .replace("</code>", "`");

    let stripped = HTML_TAG_RE.replace_all(&text, "");
    let unescaped = stripped
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");

    let mut out = Vec::new();
    let mut prev_blank = true;
    for line in unescaped.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            if !prev_blank {
                out.push(String::new());
                prev_blank = true;
            }
        } else {
            out.push(trimmed.to_string());
            prev_blank = false;
        }
    }
    out.join("\n").trim().to_string()
}

pub fn parse_atom_releases(xml: &str, current: &str, os: &str, arch: &str, now_ms: i64) -> Result<UpdateInfo> {
    let doc = roxmltree::Document::parse(xml).map_err(|e| anyhow!("解析更新订阅失败：{e}"))?;
    let cur_sem = parse_semver(current).unwrap_or((0, 0, 0));
    let (platform, asset_suffix) = platform_target(os, arch);

    let best = doc
        .descendants()
        .filter(|n| n.is_element() && n.tag_name().name() == "entry")
        .filter_map(|entry| {
            let link = entry
                .children()
                .find(|c| {
                    c.is_element()
                        && c.tag_name().name() == "link"
                        && c.attribute("rel").is_none_or(|r| r == "alternate")
                })
                .and_then(|c| c.attribute("href"))
                .unwrap_or(RELEASES_PAGE)
                .to_string();
            let id = entry
                .children()
                .find(|c| c.is_element() && c.tag_name().name() == "id")
                .and_then(|c| c.text())
                .unwrap_or_default();
            let tag = link
                .split("/releases/tag/")
                .nth(1)
                .or_else(|| id.rsplit('/').next())
                .unwrap_or_default()
                .trim()
                .to_string();
            let sem = parse_semver(&tag)?;
            let title = entry
                .children()
                .find(|c| c.is_element() && c.tag_name().name() == "title")
                .and_then(|c| c.text())
                .unwrap_or_default()
                .trim()
                .to_string();
            let updated = entry
                .children()
                .find(|c| c.is_element() && c.tag_name().name() == "updated")
                .and_then(|c| c.text())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty());
            let notes = entry
                .children()
                .find(|c| c.is_element() && c.tag_name().name() == "content")
                .and_then(|c| c.text())
                .map(atom_html_to_markdown)
                .unwrap_or_default();
            Some((sem, tag, link, title, updated, notes))
        })
        .max_by_key(|(sem, ..)| *sem);

    let Some((latest_sem, tag_name, release_url, title, published_at, notes)) = best else {
        return Ok(empty_update_info(current, platform, now_ms));
    };

    let latest_version = format!("{}.{}.{}", latest_sem.0, latest_sem.1, latest_sem.2);
    let asset_name = asset_suffix.map(|sfx| format!("PodDesk_{latest_version}{sfx}"));
    let direct_url = asset_name
        .as_ref()
        .map(|name| format!("{DOWNLOAD_BASE}/{tag_name}/{name}"))
        .unwrap_or_else(|| release_url.clone());
    let mirror_download_url = asset_name
        .as_ref()
        .and_then(|_| net::github_release_urls(&direct_url).into_iter().find(|u| u != &direct_url));

    Ok(UpdateInfo {
        current_version: current.to_string(),
        latest_version,
        has_update: latest_sem > cur_sem,
        tag_name,
        prerelease: title.contains("内测") || title.to_ascii_lowercase().contains("beta"),
        title,
        notes,
        published_at,
        release_url,
        download_url: direct_url,
        mirror_download_url,
        asset_name,
        asset_size: None,
        platform,
        checked_at: now_ms,
    })
}

async fn fetch_via_api(current: &str, os: &str, arch: &str, now_ms: i64) -> Result<UpdateInfo> {
    let res = tokio::time::timeout(
        Duration::from_secs(8),
        net::client()
            .get(RELEASES_API)
            .header("User-Agent", "podcast-desk")
            .header("Accept", "application/vnd.github+json")
            .send(),
    )
    .await
    .map_err(|_| anyhow!("请求 GitHub API 超时"))?
    .map_err(net::describe)?;

    if !res.status().is_success() {
        let code = res.status().as_u16();
        if code == 403 || code == 429 {
            return Err(anyhow!("GitHub API 限流（HTTP {code}）"));
        }
        return Err(anyhow!("GitHub API 返回 HTTP {code}"));
    }

    let payload: Value = res.json().await.map_err(|e| anyhow!("解析更新信息失败：{e}"))?;
    let releases = payload.as_array().ok_or_else(|| anyhow!("更新信息格式异常"))?;
    Ok(pick_latest_release(releases, current, os, arch, now_ms))
}

async fn fetch_via_atom(current: &str, os: &str, arch: &str, now_ms: i64) -> Result<UpdateInfo> {
    let mut last_err = anyhow!("无法访问发布订阅");
    for url in net::github_release_urls(RELEASES_ATOM) {
        let resp = tokio::time::timeout(
            Duration::from_secs(8),
            net::client()
                .get(&url)
                .header("User-Agent", "podcast-desk")
                .header("Accept", "application/atom+xml,application/xml,text/xml")
                .send(),
        )
        .await;
        match resp {
            Ok(Ok(r)) if r.status().is_success() => match r.text().await {
                Ok(xml) => match parse_atom_releases(&xml, current, os, arch, now_ms) {
                    Ok(info) => return Ok(info),
                    Err(e) => last_err = e,
                },
                Err(e) => last_err = anyhow!("读取更新订阅失败：{e}"),
            },
            Ok(Ok(r)) => last_err = anyhow!("GitHub 更新页返回 HTTP {}", r.status().as_u16()),
            Ok(Err(e)) => last_err = net::describe(e),
            Err(_) => last_err = anyhow!("请求更新订阅超时"),
        }
    }
    Err(last_err)
}

pub async fn check(force: bool) -> Result<UpdateInfo> {
    if !force {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, info)) = guard.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Ok(info.clone());
            }
        }
    }

    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let current = env!("CARGO_PKG_VERSION");
    let now_ms = crate::model::now_ms();

    let info = match fetch_via_api(current, os, arch, now_ms).await {
        Ok(info) => info,
        Err(api_err) => match fetch_via_atom(current, os, arch, now_ms).await {
            Ok(info) => info,
            Err(atom_err) => return Err(anyhow!("检查更新失败：{api_err}；备用通道也失败：{atom_err}")),
        },
    };

    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Instant::now(), info.clone()));
    Ok(info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_semver_tags() {
        assert_eq!(parse_semver("v0.2.0"), Some((0, 2, 0)));
        assert_eq!(parse_semver("0.1.1"), Some((0, 1, 1)));
        assert_eq!(parse_semver("V1.2.3-beta.1"), Some((1, 2, 3)));
        assert_eq!(parse_semver("invalid"), None);
        assert_eq!(parse_semver("v1.2"), None);
    }

    #[test]
    fn picks_highest_non_draft_release_and_platform_asset() {
        let releases = vec![
            json!({
                "tag_name": "v9.9.9",
                "draft": true,
                "prerelease": true,
                "html_url": "https://github.com/zhangxq0606-ctrl/PodDesk/releases/tag/draft",
                "assets": []
            }),
            json!({
                "tag_name": "v0.1.0",
                "draft": false,
                "prerelease": true,
                "name": "PodDesk v0.1.0",
                "html_url": "https://github.com/zhangxq0606-ctrl/PodDesk/releases/tag/v0.1.0",
                "assets": []
            }),
            json!({
                "tag_name": "v0.3.0",
                "draft": false,
                "prerelease": true,
                "name": "PodDesk v0.3.0",
                "body": "- New feature",
                "published_at": "2026-11-25T10:00:00Z",
                "html_url": "https://github.com/zhangxq0606-ctrl/PodDesk/releases/tag/v0.3.0",
                "assets": [
                    {
                        "name": "PodDesk_0.3.0_x64-setup.exe",
                        "size": 6500000,
                        "state": "uploaded",
                        "browser_download_url": "https://github.com/zhangxq0606-ctrl/PodDesk/releases/download/v0.3.0/PodDesk_0.3.0_x64-setup.exe"
                    },
                    {
                        "name": "PodDesk_0.3.0_aarch64.dmg",
                        "size": 8700000,
                        "state": "uploaded",
                        "browser_download_url": "https://github.com/zhangxq0606-ctrl/PodDesk/releases/download/v0.3.0/PodDesk_0.3.0_aarch64.dmg"
                    }
                ]
            }),
        ];

        let win = pick_latest_release(&releases, "0.2.0", "windows", "x86_64", 123);
        assert!(win.has_update);
        assert_eq!(win.latest_version, "0.3.0");
        assert_eq!(win.platform, "windows-x64");
        assert_eq!(win.asset_name.as_deref(), Some("PodDesk_0.3.0_x64-setup.exe"));
        assert!(win.mirror_download_url.is_some());

        let mac = pick_latest_release(&releases, "0.3.0", "macos", "aarch64", 123);
        assert!(!mac.has_update);
        assert_eq!(mac.platform, "macos-arm64");
        assert_eq!(mac.asset_name.as_deref(), Some("PodDesk_0.3.0_aarch64.dmg"));
    }

    #[test]
    fn parses_atom_feed_and_builds_platform_download_urls() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1468344039/v0.2.3</id>
    <updated>2026-11-26T08:16:14Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/zhangxq0606-ctrl/PodDesk/releases/tag/v0.2.3"/>
    <title>PodDesk v0.2.3 (内测版)</title>
    <content type="html">&lt;h3&gt;改进&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;&lt;strong&gt;更快&lt;/strong&gt;：支持 &lt;code&gt;Atom&lt;/code&gt; 回退&lt;/li&gt;&lt;/ul&gt;</content>
  </entry>
  <entry>
    <id>tag:github.com,2008:Repository/1468344039/v0.2.2</id>
    <updated>2026-11-25T11:01:39Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/zhangxq0606-ctrl/PodDesk/releases/tag/v0.2.2"/>
    <title>PodDesk v0.2.2 (内测版)</title>
    <content type="html">&lt;p&gt;Old release&lt;/p&gt;</content>
  </entry>
</feed>"#;

        let win = parse_atom_releases(xml, "0.2.2", "windows", "x86_64", 456).unwrap();
        assert!(win.has_update);
        assert_eq!(win.latest_version, "0.2.3");
        assert_eq!(win.tag_name, "v0.2.3");
        assert_eq!(win.title, "PodDesk v0.2.3 (内测版)");
        assert!(win.prerelease);
        assert_eq!(
            win.download_url,
            "https://github.com/zhangxq0606-ctrl/PodDesk/releases/download/v0.2.3/PodDesk_0.2.3_x64-setup.exe"
        );
        assert!(win.mirror_download_url.is_some());
        assert_eq!(win.asset_name.as_deref(), Some("PodDesk_0.2.3_x64-setup.exe"));
        assert!(win.notes.contains("### 改进"));
        assert!(win.notes.contains("- **更快**：支持 `Atom` 回退"));

        let same = parse_atom_releases(xml, "0.2.3", "macos", "aarch64", 456).unwrap();
        assert!(!same.has_update);
        assert_eq!(same.asset_name.as_deref(), Some("PodDesk_0.2.3_aarch64.dmg"));
    }
}
