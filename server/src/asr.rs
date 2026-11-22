//! Local transcription via external CrispASR (`Qwen3-ASR`), pure-Rust `symphonia` decoding,
//! `yt-dlp` fallback with optional Netscape `cookies.txt`, and `streams.json` caching.
use crate::model::Segment;
use crate::net;
use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub repo: &'static str,
    pub file: &'static str,
    pub size_mb: u32,
    pub note: &'static str,
}

pub const QWEN3_MODEL_ID: &str = "qwen3-asr";

pub const MODELS: &[ModelSpec] = &[ModelSpec {
    id: QWEN3_MODEL_ID,
    name: "Qwen3-ASR 0.6B（中英离线推荐）",
    repo: "cstr/qwen3-asr-0.6b-GGUF",
    file: "qwen3-asr-0.6b-q8_0.gguf",
    size_mb: 960,
    note: "中英文识别准确且自带标点，支持 Show Notes 专有名词上下文；首次安装另需约 20 MB CrispASR 推理程序",
}];

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    MODELS.iter().find(|m| m.id == id)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub size_mb: u32,
    pub note: String,
    pub installed: bool,
    pub from: Option<String>,
}

pub fn models_dir(data: &Path) -> PathBuf {
    data.join("models")
}

pub fn list_models(data: &Path) -> Vec<ModelInfo> {
    adopt_found(data);
    let dir = models_dir(data);
    let mut out: Vec<ModelInfo> = MODELS
        .iter()
        .map(|m| {
            let path = dir.join(m.file);
            ModelInfo {
                id: m.id.into(),
                name: m.name.into(),
                size_mb: m.size_mb,
                note: m.note.into(),
                installed: path.is_file(),
                from: linked_from(&path),
            }
        })
        .collect();

    for name in extra_qwen_files(data) {
        let path = dir.join(&name);
        let size_mb = std::fs::metadata(&path).map(|m| (m.len() / 1_048_576) as u32).unwrap_or(0);
        let label = name.trim_end_matches(".gguf");
        out.push(ModelInfo {
            id: format!("file:{name}"),
            name: format!("Qwen3-ASR（{label}）"),
            size_mb,
            note: String::new(),
            installed: path.is_file(),
            from: Some(linked_from(&path).unwrap_or_else(|| "本机".into())),
        });
    }
    out
}

pub fn resolve_qwen_model(data: &Path, id: Option<&str>) -> Option<PathBuf> {
    let target = id.unwrap_or(QWEN3_MODEL_ID);
    if let Some(m) = spec(target) {
        let p = models_dir(data).join(m.file);
        return p.is_file().then_some(p);
    }
    if let Some(name) = target.strip_prefix("file:") {
        if !name.contains('/') && !name.contains('\\') && !name.contains("..") && is_qwen_gguf(name) {
            let p = models_dir(data).join(name);
            return p.is_file().then_some(p);
        }
    }
    list_models(data)
        .into_iter()
        .find(|m| m.installed)
        .and_then(|m| resolve_qwen_model(data, Some(&m.id)))
}

fn is_qwen_gguf(name: &str) -> bool {
    let n = name.to_lowercase();
    n.starts_with("qwen3-asr") && n.ends_with(".gguf")
}

fn linked_from(path: &Path) -> Option<String> {
    let target = std::fs::read_link(path).ok()?;
    let s = target.to_string_lossy();
    if s.contains("huggingface") {
        return Some("Hugging Face 缓存".into());
    }
    target.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string())
}

fn extra_qwen_files(data: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(models_dir(data))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            (is_qwen_gguf(&n) && !MODELS.iter().any(|m| m.file == n) && e.path().is_file()).then_some(n)
        })
        .collect();
    v.sort();
    v
}

fn looks_like_gguf(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() < 300 * 1_048_576 {
        return false;
    }
    let mut magic = [0u8; 4];
    std::fs::File::open(path).and_then(|mut f| f.read_exact(&mut magic)).is_ok() && &magic == b"GGUF"
}

fn model_roots() -> Vec<(PathBuf, usize)> {
    let h = dirs::home_dir().unwrap_or_default();
    let mut v = vec![(h.join(".cache/huggingface/hub"), 5), (h.join(".cache"), 3), (h.join("Downloads"), 1)];
    if let Some(d) = dirs::data_dir() {
        v.push((d, 3));
    }
    if let Some(d) = dirs::data_local_dir() {
        v.push((d, 3));
    }
    v
}

static SCANNED: std::sync::Mutex<Option<std::time::Instant>> = std::sync::Mutex::new(None);

fn adopt_found(data: &Path) {
    {
        let mut last = SCANNED.lock().unwrap();
        if last.is_some_and(|t| t.elapsed().as_secs() < 60) {
            return;
        }
        *last = Some(std::time::Instant::now());
    }
    let dir = models_dir(data);
    let _ = std::fs::create_dir_all(&dir);
    let own = dir.canonicalize().unwrap_or(dir.clone());
    let mut found: Vec<PathBuf> = Vec::new();

    fn walk(p: &Path, depth: usize, own: &Path, out: &mut Vec<PathBuf>, budget: &mut usize) {
        if *budget == 0 {
            return;
        }
        let Ok(rd) = std::fs::read_dir(p) else { return };
        for e in rd.flatten() {
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return;
            }
            let Ok(ft) = e.file_type() else { continue };
            let path = e.path();
            if ft.is_symlink() && !path.to_string_lossy().contains("huggingface") {
                continue;
            }
            if path.starts_with(own) {
                continue;
            }
            let name = e.file_name().to_string_lossy().to_string();
            if (ft.is_file() || ft.is_symlink()) && is_qwen_gguf(&name) {
                out.push(path);
            } else if ft.is_dir() && depth > 0 && (!name.starts_with('.') || name == ".cache" || name.starts_with("models--")) {
                if matches!(name.as_str(), "node_modules" | "Caches" | "Logs" | "CrashReporter") {
                    continue;
                }
                walk(&path, depth - 1, own, out, budget);
            }
        }
    }

    let mut budget = 40_000;
    for (root, depth) in model_roots() {
        walk(&root, depth, &own, &mut found, &mut budget);
    }

    for src in found {
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        let real = src.canonicalize().unwrap_or(src.clone());
        let dest = dir.join(&name);
        if dest.exists() || !looks_like_gguf(&real) {
            continue;
        }
        // CrispASR requires a single-file GGUF (skip split mmproj folders).
        if real
            .parent()
            .and_then(|d| std::fs::read_dir(d).ok())
            .is_some_and(|rd| rd.flatten().any(|e| e.file_name().to_string_lossy().to_lowercase().starts_with("mmproj")))
        {
            continue;
        }
        link_model_file(&real, &dest);
    }
}

fn link_model_file(real: &Path, dest: &Path) {
    #[cfg(unix)]
    let _ = std::os::unix::fs::symlink(real, dest);
    #[cfg(windows)]
    let _ = std::fs::hard_link(real, dest).or_else(|_| std::os::windows::fs::symlink_file(real, dest));
}

/// Streams `url` into `dest` via a `.part` file, reporting (received, total).
pub async fn download(
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<()> {
    let res = net::client().get(url).send().await?;
    if !res.status().is_success() {
        return Err(anyhow!("下载失败（HTTP {}）", res.status().as_u16()));
    }
    let total = res.content_length();
    let part = dest.with_extension("part");
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = res.bytes_stream();
    let mut received = 0u64;
    let mut last = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            drop(file);
            let _ = tokio::fs::remove_file(&part).await;
            return Err(anyhow!("已取消"));
        }
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        received += chunk.len() as u64;
        if last.elapsed().as_millis() > 200 {
            progress(received, total);
            last = std::time::Instant::now();
        }
    }
    file.flush().await?;
    drop(file);
    if let Some(t) = total {
        if received < t {
            let _ = tokio::fs::remove_file(&part).await;
            return Err(anyhow!("下载不完整"));
        }
    }
    tokio::fs::rename(&part, dest).await?;
    progress(received, total);
    Ok(())
}

pub async fn download_model(
    data: &Path,
    id: &str,
    cancel: &AtomicBool,
    mirror_first: bool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    let m = spec(id).ok_or_else(|| anyhow!("未知语音模型：{id}"))?;
    let dest = models_dir(data).join(m.file);
    if dest.is_file() {
        return Ok(dest);
    }
    let hosts = if mirror_first {
        ["hf-mirror.com", "huggingface.co"]
    } else {
        ["huggingface.co", "hf-mirror.com"]
    };
    let mut err = anyhow!("下载模型失败");
    for host in hosts {
        let url = format!("https://{host}/{}/resolve/main/{}", m.repo, m.file);
        match download(&url, &dest, cancel, &mut progress).await {
            Ok(()) => return Ok(dest),
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => err = e,
        }
    }
    Err(err)
}

// ---- yt-dlp + optional Netscape cookies.txt fallback ---------------------------------------------

fn exe(name: &str) -> String {
    if cfg!(windows) { format!("{name}.exe") } else { name.to_string() }
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
    fetch_checked(YTDLP_GITHUB, name, &dest, cancel, &mut progress).await?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(dest)
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
    download(&format!("{base}/{name}"), &tmp, cancel, |a, b| progress(a, b)).await?;
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
                Err(e) => {
                    return find_ytdlp(data).ok_or_else(|| anyhow!("未找到 yt-dlp 且下载失败：{e}"))
                }
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
    let res = net::client()
        .get("https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest")
        .header("User-Agent", "podcast-desk")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await?;
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
    if !fresh {
        if let Some(url) = streams::get(&key) {
            return Ok(url);
        }
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
        let map = MAP.lock().unwrap();
        map.get(key).filter(|(_, until)| *until > now()).map(|(u, _)| u.clone())
    }

    pub fn put(key: &str, url: &str) {
        let t = now();
        let until = expiry(url).map(|e| e.saturating_sub(MARGIN)).unwrap_or(t + DEFAULT_LIFE);
        let mut map = MAP.lock().unwrap();
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
        use super::expiry;

        #[test]
        fn reads_expiry() {
            assert_eq!(expiry("https://rr1.googlevideo.com/videoplayback?expire=1700000000&ei=x"), Some(1700000000));
            assert_eq!(
                expiry("https://manifest.googlevideo.com/api/manifest/hls_variant/expire/1700001234/ei/abc/file/index.m3u8"),
                Some(1700001234)
            );
            assert_eq!(expiry("https://example.com/a.mp4"), None);
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

// ---- CrispASR (runs Qwen3-ASR without C++/whisper-rs compile step) ------------------------------

const CRISPASR_VERSION: &str = "v0.8.54";

fn crispasr_asset() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("crispasr-macos-arm64.tar.gz")
    } else if cfg!(target_os = "macos") {
        Some("crispasr-macos-x86_64.tar.gz")
    } else if cfg!(windows) {
        Some("crispasr-windows-x86_64-cpu.zip")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("crispasr-linux-arm64.tar.gz")
    } else if cfg!(target_os = "linux") {
        Some("crispasr-linux-x86_64.tar.gz")
    } else {
        None
    }
}

fn find_file(dir: &Path, name: &str) -> Option<PathBuf> {
    for e in std::fs::read_dir(dir).ok()?.flatten() {
        let p = e.path();
        if p.is_dir() {
            if let Some(f) = find_file(&p, name) {
                return Some(f);
            }
        } else if p.file_name().is_some_and(|n| n == name) {
            return Some(p);
        }
    }
    None
}

pub fn find_crispasr(data: &Path) -> Option<PathBuf> {
    find_file(&data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}")), &exe("crispasr"))
}

pub async fn install_crispasr(
    data: &Path,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if let Some(existing) = find_crispasr(data) {
        return Ok(existing);
    }
    let asset = crispasr_asset().ok_or_else(|| anyhow!("当前操作系统暂不支持 CrispASR"))?;
    let archive = data.join("bin").join(asset);
    download(
        &format!("https://github.com/CrispStrobe/CrispASR/releases/download/{CRISPASR_VERSION}/{asset}"),
        &archive,
        cancel,
        progress,
    )
    .await?;
    let dest = data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}"));
    let (a, d) = (archive.clone(), dest.clone());
    tokio::task::spawn_blocking(move || -> Result<()> {
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d)?;
        let file = std::fs::File::open(&a)?;
        if a.extension().is_some_and(|e| e == "zip") {
            zip::ZipArchive::new(file)?.extract(&d)?;
        } else {
            tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(&d)?;
        }
        Ok(())
    })
    .await??;
    let _ = std::fs::remove_file(&archive);
    let bin = find_crispasr(data).ok_or_else(|| anyhow!("识别程序解压后未找到可执行文件"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(bin)
}

#[derive(Default, Clone, Debug)]
pub struct AsrContext {
    pub prompt: String,
    pub background: String,
    pub doubao: String,
    pub hotwords: Vec<String>,
}

pub fn build_asr_context(title: &str, show: &str, notes: &str, ctx_json: Option<&str>, language: &str) -> AsrContext {
    let mut hotwords: Vec<String> = Vec::new();
    if let Some(raw) = ctx_json {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(raw) {
            for s in v["speakers"].as_array().into_iter().flatten() {
                for key in ["zh", "name"] {
                    if let Some(w) = s[key].as_str().map(str::trim).filter(|w| !w.is_empty()) {
                        hotwords.push(w.to_string());
                    }
                }
            }
            for t in v["terms"].as_array().into_iter().flatten() {
                for key in ["zh", "src"] {
                    if let Some(w) = t[key].as_str().map(str::trim).filter(|w| !w.is_empty()) {
                        hotwords.push(w.to_string());
                    }
                }
            }
        }
    }
    let meta = crate::asr_context::Meta {
        title: title.into(),
        show: show.into(),
        description: notes.into(),
        chapters: vec![],
    };
    let bg = crate::asr_context::background(&meta, crate::asr_context::BUDGET_QWEN);
    let prompt = crate::asr_context::prompt(&meta, crate::asr_context::BUDGET_PROMPT);
    let fits = |text: &str| language == "auto" || crate::asr_context::fits_language(text, language);
    AsrContext {
        background: if fits(&bg) { bg } else { String::new() },
        prompt: if fits(&prompt) { prompt } else { String::new() },
        doubao: crate::asr_context::doubao(&meta, &hotwords),
        hotwords,
    }
}

pub async fn run_crispasr(
    bin: &Path,
    model: &Path,
    wav: &Path,
    language: &str,
    ctx: &AsrContext,
    cancel: Arc<AtomicBool>,
    mut on_progress: impl FnMut(f64),
) -> Result<Vec<Segment>> {
    let out = wav.with_extension("");
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-m").arg(model).arg("-f").arg(wav).args(["-oj", "-np", "-pp"]).arg("-of").arg(&out);
    let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
    cmd.args(["-t", &threads.to_string()]);
    if language == "auto" {
        cmd.args(["-l", "auto", "--lid-backend", "off"]);
    } else {
        cmd.args(["-l", language]);
    }
    if !ctx.background.is_empty() {
        cmd.arg("--context").arg(&ctx.background);
    }
    let words: Vec<&str> = ctx
        .hotwords
        .iter()
        .map(|w| w.trim())
        .filter(|w| !w.is_empty() && !w.contains(','))
        .take(60)
        .collect();
    if !words.is_empty() {
        cmd.arg("--hotwords").arg(words.join(","));
    }
    cmd.kill_on_drop(true).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let mut child = cmd.spawn().context("无法启动 CrispASR 识别程序")?;
    let mut lines = BufReader::new(child.stderr.take().unwrap()).lines();
    let re = regex::Regex::new(r"progress\s*=\s*(\d+)%").unwrap();
    let mut tail: Vec<String> = Vec::new();
    loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill().await;
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            line = lines.next_line() => {
                let Some(line) = line? else { break };
                if let Some(c) = re.captures(&line) {
                    on_progress(c[1].parse::<f64>().unwrap_or(0.0) / 100.0);
                } else if !line.starts_with("ggml_") {
                    tail.push(line);
                    if tail.len() > 6 { tail.remove(0); }
                }
            }
            _ = tokio::time::sleep(std::time::Duration::from_millis(300)) => {
                if cancel.load(Ordering::Relaxed) {
                    let _ = child.kill().await;
                    return Err(anyhow!("已取消"));
                }
            }
        }
    }
    let status = child.wait().await?;
    let json_path = out.with_extension("json");
    if !status.success() || !json_path.is_file() {
        return Err(anyhow!("Qwen3-ASR 识别失败：{}", tail.last().cloned().unwrap_or_default()));
    }
    let v: serde_json::Value = serde_json::from_str(&tokio::fs::read_to_string(&json_path).await?)?;
    let _ = tokio::fs::remove_file(&json_path).await;
    let mut segs = Vec::new();
    for t in v["transcription"].as_array().into_iter().flatten() {
        let start = t["offsets"]["from"].as_f64().unwrap_or(0.0) / 1000.0;
        let end = t["offsets"]["to"].as_f64().unwrap_or(0.0) / 1000.0;
        let text = t["text"].as_str().unwrap_or("").trim();
        if !text.is_empty() {
            segs.extend(crate::transcript::split_timed(text, start, end));
        }
    }
    Ok(segs)
}

// ---- symphonia decode + streaming resampler + WAV writer -----------------------------------------

pub fn write_wav(path: &Path, samples: &[f32]) -> Result<()> {
    use std::io::Write;
    let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);
    let data_len = (samples.len() * 2) as u32;
    f.write_all(b"RIFF")?;
    f.write_all(&(36 + data_len).to_le_bytes())?;
    f.write_all(b"WAVEfmt ")?;
    f.write_all(&16u32.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&1u16.to_le_bytes())?;
    f.write_all(&16000u32.to_le_bytes())?;
    f.write_all(&32000u32.to_le_bytes())?;
    f.write_all(&2u16.to_le_bytes())?;
    f.write_all(&16u16.to_le_bytes())?;
    f.write_all(b"data")?;
    f.write_all(&data_len.to_le_bytes())?;
    for s in samples {
        f.write_all(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes())?;
    }
    f.flush()?;
    Ok(())
}

pub fn decode_16k_mono(path: &Path) -> Result<Vec<f32>> {
    use symphonia::core::{
        audio::SampleBuffer, codecs::DecoderOptions, errors::Error, formats::FormatOptions, io::MediaSourceStream,
        meta::MetadataOptions, probe::Hint,
    };
    let file = std::fs::File::open(path)?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| anyhow!("无法识别音频格式：{e}"))?;
    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != symphonia::core::codecs::CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("文件中没有可用音轨"))?;
    let track_id = track.id;
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("不支持的音频编码：{e}"))?;
    let mut resampler: Option<Resampler> = None;
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(Error::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(Error::ResetRequired) => break,
            Err(e) => return Err(anyhow!("读取音频失败：{e}")),
        };
        if packet.track_id() != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(Error::DecodeError(_)) => continue,
            Err(e) => return Err(anyhow!("解码失败：{e}")),
        };
        let spec = *decoded.spec();
        let r = resampler.get_or_insert_with(|| Resampler::new(spec.rate, 16000));
        let channels = spec.channels.count().max(1);
        if buf.as_ref().is_none_or(|b| b.capacity() < decoded.capacity() * channels) {
            buf = Some(SampleBuffer::new(decoded.capacity() as u64, spec));
        }
        let b = buf.as_mut().unwrap();
        b.copy_interleaved_ref(decoded);
        for frame in b.samples().chunks(channels) {
            r.push(frame.iter().sum::<f32>() / channels as f32);
        }
    }
    Ok(resampler.map(Resampler::finish).unwrap_or_default())
}

#[cfg(test)]
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let mut r = Resampler::new(from, to);
    for &x in input {
        r.push(x);
    }
    r.finish()
}

pub struct Resampler {
    ratio: f64,
    width: usize,
    hist: std::collections::VecDeque<f32>,
    acc: f32,
    count: usize,
    prev: Option<f32>,
    next: usize,
    out: Vec<f32>,
}

impl Resampler {
    pub fn new(from: u32, to: u32) -> Self {
        let ratio = from as f64 / to as f64;
        let width = ratio.ceil().max(1.0) as usize;
        Self {
            ratio,
            width,
            hist: std::collections::VecDeque::with_capacity(width + 1),
            acc: 0.0,
            count: 0,
            prev: None,
            next: 0,
            out: Vec::new(),
        }
    }
    pub fn push(&mut self, x: f32) {
        let f = if self.width > 1 {
            self.acc += x;
            self.hist.push_back(x);
            if self.hist.len() > self.width {
                self.acc -= self.hist.pop_front().unwrap_or(0.0);
            }
            self.acc / self.hist.len() as f32
        } else {
            x
        };
        let i = self.count;
        self.count += 1;
        if let Some(p) = self.prev {
            loop {
                let pos = self.next as f64 * self.ratio;
                let j = pos as usize;
                if j + 1 != i {
                    break;
                }
                let frac = (pos - j as f64) as f32;
                self.out.push(p + (f - p) * frac);
                self.next += 1;
            }
        }
        self.prev = Some(f);
    }
    pub fn finish(mut self) -> Vec<f32> {
        let n = (self.count as f64 / self.ratio) as usize;
        if let Some(p) = self.prev {
            while self.next < n {
                self.out.push(p);
                self.next += 1;
            }
        }
        self.out.truncate(n);
        self.out
    }
}

#[cfg(test)]
mod resample_tests {
    fn batch(input: &[f32], from: u32, to: u32) -> Vec<f32> {
        if from == to || input.is_empty() {
            return input.to_vec();
        }
        let ratio = from as f64 / to as f64;
        let width = ratio.ceil().max(1.0) as usize;
        let filtered: Vec<f32> = if width > 1 {
            let mut acc = 0.0f32;
            let mut out = Vec::with_capacity(input.len());
            for i in 0..input.len() {
                acc += input[i];
                if i >= width {
                    acc -= input[i - width];
                }
                out.push(acc / width.min(i + 1) as f32);
            }
            out
        } else {
            input.to_vec()
        };
        let n = (input.len() as f64 / ratio) as usize;
        (0..n)
            .map(|i| {
                let pos = i as f64 * ratio;
                let j = pos as usize;
                let frac = (pos - j as f64) as f32;
                let a = filtered[j.min(filtered.len() - 1)];
                let b = filtered[(j + 1).min(filtered.len() - 1)];
                a + (b - a) * frac
            })
            .collect()
    }

    #[test]
    fn streaming_matches_batch() {
        let input: Vec<f32> = (0..100_003)
            .map(|i| ((i as f32) * 0.013).sin() * 0.7 + ((i * 7919 % 1000) as f32 / 1000.0 - 0.5) * 0.2)
            .collect();
        for (from, to) in [(48_000, 16_000), (44_100, 16_000), (22_050, 16_000), (8_000, 16_000), (16_000, 16_000)] {
            let a = batch(&input, from, to);
            let b = super::resample(&input, from, to);
            assert_eq!(a.len(), b.len(), "{from}->{to} length");
            let worst = a.iter().zip(&b).map(|(x, y)| (x - y).abs()).fold(0.0f32, f32::max);
            assert!(worst < 1e-4, "{from}->{to} differs by {worst}");
        }
    }
}

#[cfg(test)]
mod audio_and_cookies_tests {
    use super::*;

    #[test]
    fn write_wav_and_decode_round_trip() {
        let dir = std::env::temp_dir().join(format!("pdesk-wav-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let wav = dir.join("sine.wav");
        let input: Vec<f32> = (0..8000).map(|i| ((i as f32) * 0.08).sin() * 0.4).collect();
        write_wav(&wav, &input).unwrap();
        let decoded = decode_16k_mono(&wav).unwrap();
        assert!(!decoded.is_empty() && decoded.len() <= input.len() + 32);
        let max_diff = input
            .iter()
            .zip(&decoded)
            .map(|(a, b)| (a - b).abs())
            .fold(0.0f32, f32::max);
        assert!(max_diff < 0.01, "max_diff={max_diff}");
        let _ = std::fs::remove_dir_all(&dir);
    }

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
