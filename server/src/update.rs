//! Lightweight in-app update checker backed by GitHub Releases (no auto-overwrite or private server).
use crate::net;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const RELEASES_API: &str = "https://api.github.com/repos/zhangxq0606-ctrl/PodDesk/releases?per_page=10";
const RELEASES_PAGE: &str = "https://github.com/zhangxq0606-ctrl/PodDesk/releases";
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
        return UpdateInfo {
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
        };
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

pub async fn check(force: bool) -> Result<UpdateInfo> {
    if !force {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, info)) = guard.as_ref() {
            if at.elapsed() < CACHE_TTL {
                return Ok(info.clone());
            }
        }
    }

    let res = tokio::time::timeout(
        Duration::from_secs(10),
        net::client()
            .get(RELEASES_API)
            .header("User-Agent", "podcast-desk")
            .header("Accept", "application/vnd.github+json")
            .send(),
    )
    .await
    .map_err(|_| anyhow!("检查更新超时，请检查网络或代理"))?
    .map_err(net::describe)?;

    if !res.status().is_success() {
        return Err(anyhow!("检查更新失败（GitHub HTTP {}）", res.status().as_u16()));
    }

    let payload: Value = res.json().await.map_err(|e| anyhow!("解析更新信息失败：{e}"))?;
    let releases = payload.as_array().ok_or_else(|| anyhow!("更新信息格式异常"))?;
    let (os, arch) = (std::env::consts::OS, std::env::consts::ARCH);
    let info = pick_latest_release(releases, env!("CARGO_PKG_VERSION"), os, arch, crate::model::now_ms());

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
}
