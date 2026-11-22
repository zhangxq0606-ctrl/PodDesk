//! One HTTP client for the whole backend, rebuilt when the proxy setting changes.
//! With no proxy configured, the system proxy (macOS/Windows settings, or HTTP(S)_PROXY) is used.
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::sync::RwLock;
use std::time::Duration;

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) PodcastDesk/0.1";

static CLIENT: Lazy<RwLock<(String, reqwest::Client)>> = Lazy::new(|| RwLock::new((String::new(), build("").unwrap())));
/// Ignores every proxy: the fallback when the system proxy (Clash and the like, on 127.0.0.1) isn't running.
static DIRECT: Lazy<reqwest::Client> = Lazy::new(|| base().no_proxy().build().unwrap());

fn base() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(UA)
        .connect_timeout(Duration::from_secs(20))
        .read_timeout(Duration::from_secs(120))
        .pool_idle_timeout(Duration::from_secs(20))
        .tcp_keepalive(Duration::from_secs(30))
        .gzip(true)
        .brotli(true)
}

fn build(proxy: &str) -> Result<reqwest::Client> {
    let mut b = base();
    let trimmed = proxy.trim();
    if !trimmed.is_empty() {
        let lower = trimmed.to_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://") || lower.starts_with("socks5://") || lower.starts_with("socks5h://")) {
            return Err(anyhow!("代理地址无效：请以 http://、https:// 或 socks5:// 开头"));
        }
        b = b.proxy(reqwest::Proxy::all(trimmed).map_err(|e| anyhow!("代理地址无效：{e}"))?);
    }
    Ok(b.build()?)
}

pub fn set_proxy(proxy: &str) -> Result<()> {
    let trimmed = proxy.trim().to_string();
    let client = build(&trimmed)?;
    *CLIENT.write().unwrap() = (trimmed, client);
    Ok(())
}

pub fn proxy() -> String {
    CLIENT.read().unwrap().0.clone()
}

/// The proxy for child tools (yt-dlp, local AI agents): the one set manually, else the system's.
pub fn effective_proxy() -> String {
    let own = proxy();
    if !own.is_empty() {
        return own;
    }
    static CACHE: Lazy<RwLock<(Option<std::time::Instant>, String)>> = Lazy::new(|| RwLock::new((None, String::new())));
    if let Some(at) = CACHE.read().unwrap().0 {
        if at.elapsed().as_secs() < 30 {
            return CACHE.read().unwrap().1.clone();
        }
    }
    let found = system_proxy().unwrap_or_default();
    *CACHE.write().unwrap() = (Some(std::time::Instant::now()), found.clone());
    found
}

fn system_proxy() -> Option<String> {
    for k in ["HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy", "HTTP_PROXY", "http_proxy"] {
        if let Ok(v) = std::env::var(k) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/scutil").arg("--proxy").output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let get = |k: &str| text.lines().find_map(|l| {
            let (a, b) = l.split_once(" : ")?;
            (a.trim() == k).then(|| b.trim().to_string())
        });
        if get("HTTPSEnable").as_deref() == Some("1") {
            if let (Some(h), Some(p)) = (get("HTTPSProxy"), get("HTTPSPort")) {
                return Some(format!("http://{h}:{p}"));
            }
        }
        if get("HTTPEnable").as_deref() == Some("1") {
            if let (Some(h), Some(p)) = (get("HTTPProxy"), get("HTTPPort")) {
                return Some(format!("http://{h}:{p}"));
            }
        }
        if get("SOCKSEnable").as_deref() == Some("1") {
            if let (Some(h), Some(p)) = (get("SOCKSProxy"), get("SOCKSPort")) {
                return Some(format!("socks5://{h}:{p}"));
            }
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let q = |v: &str| {
            std::process::Command::new("reg")
                .args(["query", r"HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings", "/v", v])
                .creation_flags(0x08000000)
                .output()
                .ok()
                .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
        };
        let on = q("ProxyEnable")?.contains("0x1");
        if on {
            let server = q("ProxyServer")?;
            let v = server.lines().find(|l| l.contains("ProxyServer"))?.split_whitespace().last()?.to_string();
            let pick = v
                .split(';')
                .find(|p| p.starts_with("https="))
                .or_else(|| v.split(';').find(|p| p.starts_with("http=")))
                .unwrap_or(&v);
            let hp = pick.split('=').last()?;
            return Some(if hp.contains("://") { hp.to_string() } else { format!("http://{hp}") });
        }
    }
    None
}

pub fn client() -> reqwest::Client {
    CLIENT.read().unwrap().1.clone()
}

/// A GET with up to two retries on connection-level failures, timeouts, 429 and 5xx.
pub async fn get(url: &str) -> Result<reqwest::Response> {
    let mut last: Option<anyhow::Error> = None;
    for attempt in 0..3u64 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(400 * attempt * attempt + 200)).await;
        }
        match client().get(url).send().await {
            Ok(res) if res.status().is_server_error() || res.status().as_u16() == 429 => {
                last = Some(anyhow!("请求失败（{}）：{}", res.status().as_u16(), url));
            }
            Ok(res) if !res.status().is_success() => return Err(anyhow!("请求失败（{}）：{}", res.status().as_u16(), url)),
            Ok(res) => return Ok(res),
            Err(e) if e.is_connect() || e.is_timeout() || e.is_request() => last = Some(describe(e)),
            Err(e) => return Err(describe(e)),
        }
    }
    if proxy().is_empty() && last.as_ref().is_some_and(|e| refused(&e.to_string())) {
        if let Ok(res) = DIRECT.get(url).send().await {
            if res.status().is_success() {
                return Ok(res);
            }
        }
    }
    Err(last.unwrap_or_else(|| anyhow!("请求失败：{url}")))
}

pub fn describe(e: reqwest::Error) -> anyhow::Error {
    let mut cause: &dyn std::error::Error = &e;
    while let Some(next) = cause.source() {
        cause = next;
    }
    let host = e.url().and_then(|u| u.host_str()).unwrap_or("").to_string();
    let why = cause.to_string();
    if refused(&why) {
        anyhow!("连不上 {host}：连接被拒绝。如果开着代理软件（如 Clash），请确认它在运行，或在设置里填写代理地址")
    } else if e.is_timeout() {
        anyhow!("连接 {host} 超时，请检查网络或代理")
    } else if e.is_connect() {
        anyhow!("连不上 {host}：{why}。请检查网络或代理设置")
    } else if why != e.to_string() {
        anyhow!("网络请求失败（{host}）：{why}")
    } else {
        anyhow!("网络请求失败（{host}）")
    }
}

pub async fn get_text(url: &str) -> Result<String> {
    Ok(get(url).await?.text().await?)
}

pub async fn get_json(url: &str) -> Result<serde_json::Value> {
    Ok(get(url).await?.json().await?)
}

fn refused(msg: &str) -> bool {
    let m = msg.to_lowercase();
    m.contains("refused") || m.contains("os error 61") || m.contains("os error 111") || m.contains("os error 10061") || m.contains("连接被拒绝")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_proxy_urls_and_refused_errors() {
        assert!(set_proxy("http://127.0.0.1:7890").is_ok());
        assert_eq!(proxy(), "http://127.0.0.1:7890");
        assert!(set_proxy("socks5://127.0.0.1:7891").is_ok());
        assert!(set_proxy("invalid-proxy").is_err());
        assert!(set_proxy("://bad").is_err());
        assert!(set_proxy("").is_ok());
        assert_eq!(proxy(), "");

        assert!(refused("tcp connect error: Connection refused (os error 10061)"));
        assert!(!refused("timed out"));
    }

    #[test]
    #[ignore]
    fn reads_the_system_proxy() {
        println!("effective proxy: {:?}", effective_proxy());
    }
}
