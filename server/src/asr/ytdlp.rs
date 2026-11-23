//! `yt-dlp` audio/stream fallback, optional Netscape `cookies.txt`, and `streams.json` caching.
use super::download;
use crate::net;
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, BufReader};

pub fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn cookies_path(data: &Path) -> PathBuf {
    data.join("youtube-cookies.txt")
}

pub fn has_cookies(data: &Path) -> bool {
    std::fs::read_to_string(cookies_path(data)).is_ok_and(|s| !s.trim().is_empty())
}

pub fn save_cookies(data: &Path, raw: &str) -> Result<bool> {
    let path = cookies_path(data);
    let cleaned = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        return Ok(false);
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&path, format!("{trimmed}\n"))?;
    Ok(true)
}

pub fn find_ytdlp(data: &Path) -> Option<PathBuf> {
    let own = data.join("bin").join(exe("yt-dlp"));
    if own.is_file() {
        return Some(own);
    }
    let dirs: Vec<PathBuf> = std::env::split_paths(&crate::agents::child_path()).collect();
    dirs.into_iter().map(|d| d.join(exe("yt-dlp"))).find(|p| p.is_file())
}

const YTDLP_GITHUB: &str = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";

fn ytdlp_asset() -> &'static str {
    if cfg!(target_os = "macos") {
        "yt-dlp_macos"
    } else if cfg!(windows) {
        "yt-dlp.exe"
    } else if cfg!(target_arch = "aarch64") {
        "yt-dlp_linux_aarch64"
    } else {
        "yt-dlp_linux"
    }
}

pub async fn install_ytdlp(data: &Path, cancel: &AtomicBool, mut progress: impl FnMut(u64, Option<u64>)) -> Result<PathBuf> {
    let name = ytdlp_asset();
    let dest = data.join("bin").join(exe("yt-dlp"));
    let bases = net::github_release_urls(YTDLP_GITHUB);
    let mut last_err = anyhow!("下载 yt-dlp 失败");
    for base in &bases {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        match fetch_checked(base, name, &dest, cancel, &mut progress).await {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
                }
                return Ok(dest);
            }
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => last_err = e,
        }
    }
    Err(anyhow!(
        "无法下载 yt-dlp（{last_err}）。如国内无代理访问 GitHub 受限，请在「设置 › 网络」配置代理或自定义 GitHub 镜像后重试"
    ))
}

async fn fetch_checked(
    base: &str,
    name: &str,
    dest: &Path,
    cancel: &AtomicBool,
    progress: &mut impl FnMut(u64, Option<u64>),
) -> Result<()> {
    use sha2::{Digest, Sha256};
    let sums = net::get_text(&format!("{base}/SHA2-256SUMS")).await?;
    let want = sums
        .lines()
        .find_map(|l| {
            let mut it = l.split_whitespace();
            let (hash, file) = (it.next()?, it.next()?);
            (file.trim_start_matches('*') == name).then(|| hash.to_lowercase())
        })
        .ok_or_else(|| anyhow!("校验清单里没有 {name}"))?;
    let tmp = dest.with_extension("download");
    if let Err(e) = download(&format!("{base}/{name}"), &tmp, cancel, |a, b| progress(a, b)).await {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(e);
    }
    let got = hex::encode(Sha256::digest(tokio::fs::read(&tmp).await?));
    if got != want {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(anyhow!("yt-dlp 校验失败（{base}）"));
    }
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

static INSTALLING: once_cell::sync::Lazy<tokio::sync::Mutex<()>> =
    once_cell::sync::Lazy::new(|| tokio::sync::Mutex::new(()));

pub async fn ytdlp(data: &Path) -> Result<PathBuf> {
    let own = data.join("bin").join(exe("yt-dlp"));
    if !own.is_file() {
        let _one = INSTALLING.lock().await;
        if !own.is_file() {
            match install_ytdlp(data, &AtomicBool::new(false), |_, _| {}).await {
                Ok(p) => return Ok(p),
                Err(e) => return find_ytdlp(data).ok_or_else(|| anyhow!("未找到 yt-dlp 且下载失败：{e}")),
            }
        }
    }
    Ok(own)
}

async fn ytdlp_version(bin: &Path) -> Option<String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(20), cmd.output()).await.ok()?.ok()?;
    out.status
        .success()
        .then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

pub async fn update_ytdlp(data: &Path, force: bool) -> Result<bool> {
    let own = data.join("bin").join(exe("yt-dlp"));
    let stamp = data.join("bin").join("yt-dlp.checked");
    if force
        && std::fs::metadata(&stamp)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age.as_secs() < 600)
    {
        return Ok(false);
    }
    if let Some(dir) = stamp.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(&stamp, b"")?;
    let res = tokio::time::timeout(
        std::time::Duration::from_secs(8),
        net::client()
            .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
            .header("User-Agent", "podcast-desk")
            .header("Accept", "application/vnd.github+json")
            .send(),
    )
    .await
    .map_err(|_| anyhow!("GitHub 版本检查超时"))??;
    if !res.status().is_success() {
        return Err(anyhow!("GitHub HTTP {}", res.status().as_u16()));
    }
    let latest = res.json::<serde_json::Value>().await?["tag_name"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    if latest.is_empty() {
        return Ok(false);
    }
    if own.is_file() && ytdlp_version(&own).await.as_deref() == Some(latest.as_str()) {
        return Ok(false);
    }
    install_ytdlp(data, &AtomicBool::new(false), |_, _| {}).await?;
    Ok(true)
}

pub async fn with_ytdlp<T, F, Fut>(data: &Path, job: F) -> Result<T>
where
    F: Fn(PathBuf) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let bin = ytdlp(data).await?;
    match job(bin.clone()).await {
        Ok(v) => Ok(v),
        Err(e) if e.to_string().contains("已取消") || e.to_string().contains("超时") => Err(e),
        Err(e) => match update_ytdlp(data, true).await {
            Ok(true) => job(data.join("bin").join(exe("yt-dlp"))).await,
            _ => Err(e),
        },
    }
}

pub fn ytdlp_command(ytdlp: &Path) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(ytdlp);
    cmd.env("PATH", crate::agents::child_path());
    if knows_js_runtimes(ytdlp) {
        cmd.args(["--js-runtimes", "deno", "--js-runtimes", "node", "--js-runtimes", "bun"]);
    }
    let proxy = net::effective_proxy();
    if !proxy.is_empty() {
        cmd.args(["--proxy", &proxy]);
    }
    cmd.args(["--socket-timeout", "15"]);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    cmd.kill_on_drop(true);
    cmd
}

pub async fn warm_ytdlp(ytdlp: &Path) {
    let p = ytdlp.to_path_buf();
    let _ = tokio::task::spawn_blocking(move || knows_js_runtimes(&p)).await;
}

fn knows_js_runtimes(ytdlp: &Path) -> bool {
    static SEEN: once_cell::sync::Lazy<std::sync::Mutex<std::collections::HashMap<PathBuf, bool>>> =
        once_cell::sync::Lazy::new(Default::default);
    if let Some(v) = SEEN.lock().unwrap().get(ytdlp) {
        return *v;
    }
    let mut c = std::process::Command::new(ytdlp);
    c.arg("--help");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x08000000);
    }
    let ok = c
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("--js-runtimes"))
        .unwrap_or(false);
    SEEN.lock().unwrap().insert(ytdlp.to_path_buf(), ok);
    ok
}

fn bot_check(msg: &str) -> bool {
    let m = msg.to_lowercase();
    (m.contains("confirm you") && m.contains("bot")) || m.contains("sign in to confirm")
}

pub async fn with_bot_fallback<T, F, Fut>(data: &Path, job: F) -> Result<T>
where
    F: Fn(Vec<String>) -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    match job(vec![]).await {
        Err(e) if bot_check(&e.to_string()) => {
            let alt = vec!["--extractor-args".to_string(), "youtube:player_client=tv,web_safari,mweb".to_string()];
            match job(alt).await {
                Err(e2) if bot_check(&e2.to_string()) => {
                    if !has_cookies(data) {
                        return Err(anyhow!(
                            "YouTube 触发了「确认不是机器人」校验。请按需在「设置 › YouTube 防风控 Cookie」粘贴导出后的 cookies.txt 后重试"
                        ));
                    }
                    let cookie_args = vec!["--cookies".into(), cookies_path(data).to_string_lossy().into_owned()];
                    job(cookie_args).await.map_err(|e3| {
                        if bot_check(&e3.to_string()) {
                            anyhow!("YouTube 仍然要求验证，当前保存的 cookies.txt 可能已过期，请在设置中重新导出粘贴")
                        } else {
                            e3
                        }
                    })
                }
                other => other,
            }
        }
        other => other,
    }
}

pub async fn youtube_audio(
    data: &Path,
    ytdlp: &Path,
    video_id: &str,
    dir: &Path,
    cancel: Arc<AtomicBool>,
) -> Result<PathBuf> {
    with_bot_fallback(data, |extra| {
        let c = cancel.clone();
        async move {
            let x: Vec<&str> = extra.iter().map(String::as_str).collect();
            youtube_audio_with(ytdlp, video_id, dir, c, &x).await
        }
    })
    .await
}

async fn youtube_audio_with(
    ytdlp: &Path,
    video_id: &str,
    dir: &Path,
    cancel: Arc<AtomicBool>,
    extra: &[&str],
) -> Result<PathBuf> {
    tokio::fs::create_dir_all(dir).await?;
    let template = dir.join(format!("{video_id}.%(ext)s"));
    warm_ytdlp(ytdlp).await;
    let mut cmd = ytdlp_command(ytdlp);
    cmd.args(["-f", "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/18", "--no-playlist", "--no-part"])
        .args(extra)
        .arg("-o")
        .arg(&template);
    cmd.arg(format!("https://www.youtube.com/watch?v={video_id}"))
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped());
    let mut child = cmd.spawn().context("无法启动 yt-dlp")?;
    let stderr = child.stderr.take();
    let tail = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(s) = stderr {
            let mut lines = BufReader::new(s).lines();
            while let Ok(Some(l)) = lines.next_line().await {
                text = l;
            }
        }
        text
    });
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        if let Some(status) = child.try_wait()? {
            let last = tail.await.unwrap_or_default();
            if !status.success() {
                return Err(anyhow!("下载 YouTube 音频失败：{}", last.chars().take(200).collect::<String>()));
            }
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    }
    let mut entries = tokio::fs::read_dir(dir).await?;
    while let Some(e) = entries.next_entry().await? {
        if e.file_name().to_string_lossy().starts_with(video_id) {
            return Ok(e.path());
        }
    }
    Err(anyhow!("没有找到下载的音频"))
}

pub async fn youtube_stream_url(data: &Path, ytdlp: &Path, video_id: &str, fresh: bool) -> Result<String> {
    let key = format!("{video_id}|mp4");
    if fresh {
        streams::forget(&key);
    } else if let Some(url) = streams::get(&key) {
        return Ok(url);
    }
    let url = with_bot_fallback(data, |extra| async move { stream_once(ytdlp, video_id, &extra).await }).await?;
    streams::put(&key, &url);
    Ok(url)
}

pub mod streams {
    use std::collections::HashMap;
    use std::path::PathBuf;
    use std::sync::Mutex;
    use std::time::{SystemTime, UNIX_EPOCH};

    static FILE: once_cell::sync::OnceCell<PathBuf> = once_cell::sync::OnceCell::new();
    static MAP: once_cell::sync::Lazy<Mutex<HashMap<String, (String, u64)>>> = once_cell::sync::Lazy::new(|| {
        let saved = FILE
            .get()
            .and_then(|f| std::fs::read(f).ok())
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        Mutex::new(saved)
    });
    const MARGIN: u64 = 20 * 60;
    const DEFAULT_LIFE: u64 = 4 * 3600;

    fn now() -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
    }

    pub fn init(data: &std::path::Path) {
        let _ = FILE.set(data.join("streams.json"));
    }

    pub fn expiry(url: &str) -> Option<u64> {
        let tail = url.split_once("expire=").or_else(|| url.split_once("/expire/"))?.1;
        let digits: String = tail.chars().take_while(|c| c.is_ascii_digit()).collect();
        digits.parse().ok()
    }

    pub fn get(key: &str) -> Option<String> {
        let map = MAP.lock().unwrap_or_else(|e| e.into_inner());
        map.get(key).filter(|(_, until)| *until > now()).map(|(u, _)| u.clone())
    }

    pub fn forget(key: &str) {
        let mut map = MAP.lock().unwrap_or_else(|e| e.into_inner());
        if map.remove(key).is_some() {
            if let (Some(f), Ok(b)) = (FILE.get(), serde_json::to_vec(&*map)) {
                let _ = std::fs::write(f, b);
            }
        }
    }

    pub fn put(key: &str, url: &str) {
        let t = now();
        let until = expiry(url).map(|e| e.saturating_sub(MARGIN)).unwrap_or(t + DEFAULT_LIFE);
        let mut map = MAP.lock().unwrap_or_else(|e| e.into_inner());
        map.retain(|_, (_, u)| *u > t);
        if until > t {
            map.insert(key.to_string(), (url.to_string(), until));
        }
        if let (Some(f), Ok(b)) = (FILE.get(), serde_json::to_vec(&*map)) {
            let _ = std::fs::write(f, b);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn reads_expiry() {
            assert_eq!(expiry("https://rr1.googlevideo.com/videoplayback?expire=1700000000&ei=x"), Some(1700000000));
            assert_eq!(
                expiry("https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1700001234/ei/abc/file/index.m3u8"),
                Some(1700001234)
            );
            assert_eq!(expiry("https://example.com/a.mp4"), None);
        }

        #[test]
        fn forgets_cached_stream_url() {
            let k = format!("forget-test-{}", uuid::Uuid::new_v4());
            put(&k, "https://example.com/video.mp4");
            assert_eq!(get(&k).as_deref(), Some("https://example.com/video.mp4"));
            forget(&k);
            assert!(get(&k).is_none());
        }
    }
}

async fn stream_once(ytdlp: &Path, video_id: &str, extra: &[String]) -> Result<String> {
    warm_ytdlp(ytdlp).await;
    let mut cmd = ytdlp_command(ytdlp);
    cmd.args(["-j", "--no-playlist", "--no-warnings"]).args(extra);
    cmd.arg(format!("https://www.youtube.com/watch?v={video_id}"));
    let out = tokio::time::timeout(std::time::Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| anyhow!("获取视频地址超时"))?
        .context("无法启动 yt-dlp")?;
    let info: serde_json::Value = serde_json::from_slice(&out.stdout).map_err(|_| {
        anyhow!(
            "无法获取视频地址：{}",
            String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("").chars().take(200).collect::<String>()
        )
    })?;
    let formats = info["formats"].as_array().cloned().unwrap_or_default();
    formats
        .iter()
        .rev()
        .filter(|f| {
            f["vcodec"].as_str().is_some_and(|v| v != "none")
                && f["acodec"].as_str().is_some_and(|a| a != "none")
                && f["protocol"].as_str() == Some("https")
        })
        .max_by_key(|f| (f["ext"].as_str() == Some("mp4"), f["height"].as_i64().unwrap_or(0)))
        .and_then(|f| f["url"].as_str().map(str::to_string))
        .ok_or_else(|| anyhow!("这个视频没有可直接播放的格式"))
}

#[cfg(test)]
mod cookies_tests {
    use super::*;

    #[test]
    fn saves_checks_and_clears_cookies() {
        let dir = std::env::temp_dir().join(format!("pdesk-ck-{}", uuid::Uuid::new_v4()));
        assert!(!has_cookies(&dir));
        assert!(save_cookies(&dir, "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\n").unwrap());
        assert!(has_cookies(&dir));
        assert!(!save_cookies(&dir, "   ").unwrap());
        assert!(!has_cookies(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
