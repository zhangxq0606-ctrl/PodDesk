//! One HTTP client for the whole backend, rebuilt when the proxy setting changes.
//! With no proxy configured, the system proxy (macOS/Windows settings, or HTTP(S)_PROXY) is used.
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use std::sync::RwLock;
use std::time::Duration;

pub const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) PodcastDesk/0.1";

struct ClientState {
    configured: String,
    applied_effective: Option<String>,
    client: reqwest::Client,
}

static CLIENT: Lazy<RwLock<ClientState>> = Lazy::new(|| {
    RwLock::new(ClientState {
        configured: String::new(),
        applied_effective: None,
        client: DIRECT.clone(),
    })
});
static SYSTEM_PROXY_CACHE: Lazy<RwLock<(Option<std::time::Instant>, String)>> =
    Lazy::new(|| RwLock::new((None, String::new())));
static GITHUB_MIRROR: Lazy<RwLock<String>> = Lazy::new(|| RwLock::new(String::new()));
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

fn validate_proxy(proxy: &str) -> Result<String> {
    let trimmed = proxy.trim();
    if !trimmed.is_empty() {
        let lower = trimmed.to_lowercase();
        if !(lower.starts_with("http://")
            || lower.starts_with("https://")
            || lower.starts_with("socks5://")
            || lower.starts_with("socks5h://"))
        {
            return Err(anyhow!("代理地址无效：请以 http://、https:// 或 socks5:// 开头"));
        }
        reqwest::Proxy::all(trimmed).map_err(|e| anyhow!("代理地址无效：{e}"))?;
    }
    Ok(trimmed.to_string())
}

fn build_no_proxy() -> Option<reqwest::NoProxy> {
    let mut parts = vec!["127.0.0.1".to_string(), "localhost".to_string(), "::1".to_string()];
    for k in ["NO_PROXY", "no_proxy"] {
        if let Ok(v) = std::env::var(k) {
            if !v.trim().is_empty() {
                parts.push(v);
                break;
            }
        }
    }
    reqwest::NoProxy::from_string(&parts.join(","))
}

fn build_for_effective(effective: &str) -> Result<reqwest::Client> {
    let mut b = base();
    let trimmed = effective.trim();
    if trimmed.is_empty() {
        b = b.no_proxy();
    } else {
        let proxy = reqwest::Proxy::all(trimmed)
            .map_err(|e| anyhow!("代理地址无效：{e}"))?
            .no_proxy(build_no_proxy());
        b = b.proxy(proxy);
    }
    Ok(b.build()?)
}

fn invalidate_system_proxy_cache() {
    *SYSTEM_PROXY_CACHE.write().unwrap_or_else(|e| e.into_inner()) = (None, String::new());
}

pub fn set_proxy(proxy: &str) -> Result<()> {
    let trimmed = validate_proxy(proxy)?;
    invalidate_system_proxy_cache();
    let built = if trimmed.is_empty() {
        None
    } else {
        Some(build_for_effective(&trimmed)?)
    };
    let mut guard = CLIENT.write().unwrap_or_else(|e| e.into_inner());
    guard.configured = trimmed.clone();
    match built {
        Some(client) => {
            guard.applied_effective = Some(trimmed);
            guard.client = client;
        }
        None => {
            guard.applied_effective = None;
        }
    }
    Ok(())
}

pub fn proxy() -> String {
    CLIENT.read().unwrap_or_else(|e| e.into_inner()).configured.clone()
}

pub fn set_github_mirror(raw: &str) -> Result<()> {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    if !trimmed.is_empty() {
        let lower = trimmed.to_ascii_lowercase();
        if !(lower.starts_with("http://") || lower.starts_with("https://")) {
            return Err(anyhow!("GitHub 镜像地址需以 http:// 或 https:// 开头"));
        }
        reqwest::Url::parse(&trimmed).map_err(|e| anyhow!("GitHub 镜像地址无效：{e}"))?;
    }
    *GITHUB_MIRROR.write().unwrap_or_else(|e| e.into_inner()) = trimmed;
    Ok(())
}

pub fn github_mirror() -> String {
    GITHUB_MIRROR.read().unwrap_or_else(|e| e.into_inner()).clone()
}

pub fn github_release_urls(original_url: &str) -> Vec<String> {
    if !original_url.starts_with("https://github.com/") {
        return vec![original_url.to_string()];
    }
    const PUBLIC_MIRRORS: &[&str] = &["https://ghfast.top", "https://gh-proxy.com"];
    let custom = github_mirror();
    let mut urls = Vec::new();
    let mut push_unique = |u: String| {
        if !urls.contains(&u) {
            urls.push(u);
        }
    };
    if !custom.is_empty() {
        push_unique(format!("{custom}/{original_url}"));
        push_unique(original_url.to_string());
    } else {
        push_unique(original_url.to_string());
        for m in PUBLIC_MIRRORS {
            push_unique(format!("{m}/{original_url}"));
        }
    }
    urls
}

fn cached_system_proxy() -> String {
    if let Some(at) = SYSTEM_PROXY_CACHE.read().unwrap_or_else(|e| e.into_inner()).0 {
        if at.elapsed().as_secs() < 30 {
            return SYSTEM_PROXY_CACHE.read().unwrap_or_else(|e| e.into_inner()).1.clone();
        }
    }
    let found = system_proxy().unwrap_or_default();
    *SYSTEM_PROXY_CACHE.write().unwrap_or_else(|e| e.into_inner()) = (Some(std::time::Instant::now()), found.clone());
    found
}

fn resolve_target_proxy() -> (String, String) {
    let own = proxy();
    if !own.is_empty() {
        return (own.clone(), own);
    }
    (String::new(), cached_system_proxy())
}

/// The proxy for child tools (yt-dlp, local AI agents): the one set manually, else the system's.
pub fn effective_proxy() -> String {
    resolve_target_proxy().1
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
            (a.trim() == k).then(|| b.trim().to_string()).filter(|v| !v.is_empty())
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
            if !hp.is_empty() {
                return Some(if hp.contains("://") { hp.to_string() } else { format!("http://{hp}") });
            }
        }
    }
    None
}

pub fn client() -> reqwest::Client {
    let (configured, want) = resolve_target_proxy();
    {
        let guard = CLIENT.read().unwrap_or_else(|e| e.into_inner());
        if guard.configured == configured && guard.applied_effective.as_deref() == Some(want.as_str()) {
            return guard.client.clone();
        }
    }
    let built = build_for_effective(&want).unwrap_or_else(|err| {
        eprintln!("警告：应用生效代理失败（{err}），已回退直连");
        DIRECT.clone()
    });
    let mut guard = CLIENT.write().unwrap_or_else(|e| e.into_inner());
    if guard.configured == configured && guard.applied_effective.as_deref() != Some(want.as_str()) {
        guard.applied_effective = Some(want);
        guard.client = built;
    }
    guard.client.clone()
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

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetCheckItem {
    /// proxy | youtube | video | ytdlpSource | ytdlp
    pub id: &'static str,
    pub ok: bool,
    pub ms: Option<u64>,
    pub detail: String,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NetworkReport {
    pub checks: Vec<NetCheckItem>,
    /// app | system | restart | unsupported-os | unsupported-proxy | browser
    pub webview_proxy: String,
    pub github_mirror: String,
}

/// A proxy address without user credentials, safe to display and copy into feedback reports.
pub fn redact_proxy(p: &str) -> String {
    match p.split_once("://") {
        Some((scheme, rest)) => match rest.rsplit_once('@') {
            Some((_, host)) => format!("{scheme}://***@{host}"),
            None => p.to_string(),
        },
        None => match p.rsplit_once('@') {
            Some((_, host)) => format!("***@{host}"),
            None => p.to_string(),
        },
    }
}

async fn probe_url(id: &'static str, url: &str) -> NetCheckItem {
    let start = std::time::Instant::now();
    let res = tokio::time::timeout(Duration::from_secs(10), client().get(url).send()).await;
    let ms = Some(start.elapsed().as_millis() as u64);
    match res {
        Ok(Ok(_)) => NetCheckItem { id, ok: true, ms, detail: String::new() },
        Ok(Err(e)) => NetCheckItem { id, ok: false, ms, detail: describe(e).to_string() },
        Err(_) => NetCheckItem { id, ok: false, ms, detail: "10 秒内没有响应".into() },
    }
}

pub async fn run_network_check(data: &std::path::Path, webview_proxy_status: &str) -> NetworkReport {
    invalidate_system_proxy_cache();
    let own = proxy();
    let used = effective_proxy();
    let proxy_item = NetCheckItem {
        id: "proxy",
        ok: true,
        ms: None,
        detail: if !own.trim().is_empty() {
            format!("PodDesk: {}", redact_proxy(own.trim()))
        } else if !used.trim().is_empty() {
            format!("系统代理: {}", redact_proxy(used.trim()))
        } else {
            "直连（未检测到代理）".into()
        },
    };
    let ytdlp_source_url = github_release_urls(crate::asr::ytdlp::YTDLP_GITHUB_SUMS)
        .into_iter()
        .next()
        .unwrap_or_else(|| crate::asr::ytdlp::YTDLP_GITHUB_SUMS.to_string());
    let ytdlp_item = async {
        match crate::asr::find_ytdlp(data) {
            None => NetCheckItem { id: "ytdlp", ok: false, ms: None, detail: "未安装（首次回退播放或转写时会自动下载）".into() },
            Some(bin) => match crate::asr::ytdlp_version(&bin).await {
                Some(v) => NetCheckItem { id: "ytdlp", ok: true, ms: None, detail: v },
                None => NetCheckItem { id: "ytdlp", ok: false, ms: None, detail: "无法执行 yt-dlp".into() },
            },
        }
    };
    let (youtube, video, source, ytdlp) = tokio::join!(
        probe_url("youtube", "https://www.youtube.com/generate_204"),
        probe_url("video", "https://redirector.googlevideo.com/generate_204"),
        probe_url("ytdlpSource", &ytdlp_source_url),
        ytdlp_item,
    );
    NetworkReport {
        checks: vec![proxy_item, youtube, video, source, ytdlp],
        webview_proxy: webview_proxy_status.to_string(),
        github_mirror: github_mirror(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_LOCK: Lazy<std::sync::Mutex<()>> = Lazy::new(|| std::sync::Mutex::new(()));

    #[test]
    fn validates_proxy_urls_and_refused_errors() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        assert!(set_proxy("http://127.0.0.1:7890").is_ok());
        assert_eq!(proxy(), "http://127.0.0.1:7890");
        assert!(set_proxy("socks5://127.0.0.1:7891").is_ok());
        assert!(set_proxy("invalid-proxy").is_err());
        assert!(set_proxy("://bad").is_err());
        assert!(set_proxy("http://not a valid proxy").is_err());
        assert!(set_proxy("").is_ok());
        assert_eq!(proxy(), "");

        assert!(refused("tcp connect error: Connection refused (os error 10061)"));
        assert!(!refused("timed out"));
    }

    #[test]
    fn rebuilds_client_when_system_proxy_changes() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        set_proxy("").unwrap();

        *SYSTEM_PROXY_CACHE.write().unwrap_or_else(|e| e.into_inner()) =
            (Some(std::time::Instant::now()), "http://127.0.0.1:17890".to_string());
        let _ = client();
        assert_eq!(
            CLIENT.read().unwrap_or_else(|e| e.into_inner()).applied_effective.as_deref(),
            Some("http://127.0.0.1:17890")
        );

        *SYSTEM_PROXY_CACHE.write().unwrap_or_else(|e| e.into_inner()) =
            (Some(std::time::Instant::now()), "http://127.0.0.1:17897".to_string());
        let _ = client();
        assert_eq!(
            CLIENT.read().unwrap_or_else(|e| e.into_inner()).applied_effective.as_deref(),
            Some("http://127.0.0.1:17897")
        );

        *SYSTEM_PROXY_CACHE.write().unwrap_or_else(|e| e.into_inner()) =
            (Some(std::time::Instant::now()), String::new());
        let _ = client();
        assert_eq!(
            CLIENT.read().unwrap_or_else(|e| e.into_inner()).applied_effective.as_deref(),
            Some("")
        );

        set_proxy("").unwrap();
    }

    #[test]
    fn bypasses_proxy_for_loopback_addresses() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let rt = tokio::runtime::Runtime::new().unwrap();
        let body = rt.block_on(async {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            tokio::spawn(async move {
                if let Ok((mut sock, _)) = listener.accept().await {
                    let mut buf = [0u8; 512];
                    let _ = sock.read(&mut buf).await;
                    let _ = sock
                        .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                        .await;
                }
            });

            set_proxy("http://127.0.0.1:1").unwrap();
            let res = client()
                .get(format!("http://127.0.0.1:{}/ping", addr.port()))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 200);
            res.text().await.unwrap()
        });
        set_proxy("").unwrap();
        assert_eq!(body, "ok");
    }

    #[test]
    fn redacts_proxy_credentials() {
        assert_eq!(redact_proxy("http://127.0.0.1:7890"), "http://127.0.0.1:7890");
        assert_eq!(redact_proxy("http://user:pass@proxy.example:8080"), "http://***@proxy.example:8080");
        assert_eq!(redact_proxy("socks5://a:b@c@host:1080"), "socks5://***@host:1080");
        assert_eq!(redact_proxy("user:pw@host:3128"), "***@host:3128");
    }

    #[test]
    fn github_mirror_normalization_and_candidate_order() {
        let _guard = TEST_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let orig = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
        set_github_mirror("").unwrap();
        assert_eq!(github_mirror(), "");
        let defaults = github_release_urls(orig);
        assert_eq!(defaults[0], orig);
        assert!(defaults.iter().any(|u| u.starts_with("https://ghfast.top/https://github.com/")));
        assert!(defaults.iter().any(|u| u.starts_with("https://gh-proxy.com/https://github.com/")));

        assert!(set_github_mirror("ftp://bad").is_err());
        assert!(set_github_mirror("not-a-url").is_err());

        set_github_mirror("  https://mirror.example.com/// ").unwrap();
        assert_eq!(github_mirror(), "https://mirror.example.com");
        let custom = github_release_urls(orig);
        assert_eq!(
            custom,
            vec![
                format!("https://mirror.example.com/{orig}"),
                orig.to_string()
            ]
        );
        assert_eq!(github_release_urls("https://hf-mirror.com/foo"), vec!["https://hf-mirror.com/foo"]);
        set_github_mirror("").unwrap();
    }

    #[test]
    #[ignore]
    fn reads_the_system_proxy() {
        println!("effective proxy: {:?}", effective_proxy());
    }
}
