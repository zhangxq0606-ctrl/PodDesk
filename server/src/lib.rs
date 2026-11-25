pub mod agents;
pub mod asr;
pub mod asr_context;
pub mod cloud;
pub mod db;
pub mod feeds;
pub mod llm;
pub mod model;
pub mod net;
pub mod routes;
pub mod transcript;
pub mod translate;
pub mod update;
pub mod youtube;

use anyhow::{anyhow, Context, Result};
use routes::AppState;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;

pub const DEFAULT_PORT: u16 = 14327;
const PORT_SPAN: u16 = 20;

/// Desktop-shell hook for in-app YouTube sign-in & cookie jar export without linking `tauri` into `server`.
pub trait YtLoginBridge: Send + Sync {
    fn is_signed_in(&self) -> bool;
    fn open_login(&self) -> std::result::Result<(), String>;
    fn sign_out(&self) -> std::result::Result<(), String>;
    fn export_cookie_jar(&self) -> Option<String>;
}

pub struct ServerConfig {
    pub port: u16,
    pub data_dir: PathBuf,
    pub dist_dir: Option<PathBuf>,
    pub quit_tx: Option<tokio::sync::oneshot::Sender<()>>,
    pub yt_login: Option<Arc<dyn YtLoginBridge>>,
}

pub struct RunningServer {
    pub port: u16,
    pub url: String,
    pub data_dir: PathBuf,
    pub dist_source: String,
    state: Arc<AppState>,
    shutdown_tx: Option<tokio::sync::oneshot::Sender<()>>,
    handle: Option<tokio::task::JoinHandle<Result<()>>>,
}

impl RunningServer {
    pub fn active_jobs(&self) -> usize {
        self.state.active_job_count()
    }

    pub fn cancel_all_jobs(&self) {
        self.state.cancel_all_jobs();
    }

    pub fn shutdown(&mut self) {
        self.cancel_all_jobs();
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
        }
        if let Some(h) = self.handle.take() {
            h.abort();
        }
    }

    pub async fn wait(mut self) -> Result<()> {
        if let Some(h) = self.handle.take() {
            h.await.context("server task join failed")??;
        }
        Ok(())
    }
}

pub fn standard_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("podcast-desk")
}

pub fn dev_or_standard_data_dir() -> PathBuf {
    let cwd_dist = Path::new("package.json").is_file() || Path::new("../package.json").is_file();
    if cwd_dist {
        if Path::new("package.json").is_file() {
            return PathBuf::from("data");
        }
        return PathBuf::from("../data");
    }
    standard_data_dir()
}

pub fn detect_dist_dir() -> PathBuf {
    let mut candidates = vec![PathBuf::from("dist"), PathBuf::from("../dist")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("dist"));
            if let Some(up2) = dir.parent().and_then(|p| p.parent()) {
                candidates.push(up2.join("dist"));
                if let Some(up3) = up2.parent() {
                    candidates.push(up3.join("dist"));
                }
            }
        }
    }
    for c in &candidates {
        if c.join("index.html").is_file() {
            return c.clone();
        }
    }
    candidates.into_iter().next().unwrap_or_else(|| PathBuf::from("dist"))
}

pub fn open_browser(url: &str) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(target_os = "linux")]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

async fn bind_free_port(start: u16) -> Result<(u16, TcpListener)> {
    for offset in 0..PORT_SPAN {
        let Some(p) = start.checked_add(offset) else { break };
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", p)).await {
            return Ok((p, listener));
        }
    }
    Err(anyhow!("端口 {start}..{} 均已被占用", start.saturating_add(PORT_SPAN - 1)))
}

pub async fn start_server(cfg: ServerConfig) -> Result<RunningServer> {
    std::fs::create_dir_all(&cfg.data_dir)
        .with_context(|| format!("创建数据目录失败：{}", cfg.data_dir.display()))?;
    std::fs::create_dir_all(cfg.data_dir.join("media"))
        .with_context(|| format!("创建媒体目录失败：{}", cfg.data_dir.join("media").display()))?;
    asr::streams::init(&cfg.data_dir);

    let db_path = cfg.data_dir.join("podcast-desk.sqlite");
    let conn = db::open(&db_path).with_context(|| format!("打开数据库失败：{}", db_path.display()))?;
    if let Ok(Some(saved_proxy)) = db::get_setting(&conn, "proxy") {
        if let Err(err) = net::set_proxy(&saved_proxy) {
            eprintln!("警告：恢复已保存代理失败（{err}），将使用系统代理");
        }
    }
    if let Ok(Some(saved_mirror)) = db::get_setting(&conn, "githubMirror") {
        if let Err(err) = net::set_github_mirror(&saved_mirror) {
            eprintln!("警告：恢复已保存 GitHub 镜像失败（{err}），将使用直连与内置回退");
        }
    }

    let (port, listener) = bind_free_port(cfg.port).await?;
    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        data_dir: cfg.data_dir.clone(),
        port,
        jobs: Mutex::new(HashMap::new()),
        pub_backfills: Mutex::new(std::collections::HashSet::new()),
        quit_tx: Mutex::new(cfg.quit_tx),
        yt_login: cfg.yt_login,
    });
    let dist_source = match &cfg.dist_dir {
        Some(d) if d.join("index.html").is_file() => d.display().to_string(),
        _ => "embedded".to_string(),
    };
    let app = routes::router(state.clone(), cfg.dist_dir);
    let url = format!("http://127.0.0.1:{port}");
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();

    let handle = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .await?;
        Ok(())
    });

    Ok(RunningServer {
        port,
        url,
        data_dir: cfg.data_dir,
        dist_source,
        state,
        shutdown_tx: Some(shutdown_tx),
        handle: Some(handle),
    })
}
