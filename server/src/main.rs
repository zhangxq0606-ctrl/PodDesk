mod agents;
mod asr;
mod asr_context;
mod cloud;
mod db;
mod feeds;
mod llm;
mod model;
mod net;
mod routes;
mod transcript;
mod translate;
mod youtube;

use anyhow::{anyhow, Context, Result};
use routes::AppState;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tokio::net::TcpListener;

const DEFAULT_PORT: u16 = 14327;
const PORT_SPAN: u16 = 20;

struct CliArgs {
    port: u16,
    data_dir: Option<PathBuf>,
    dist_dir: Option<PathBuf>,
    no_open: bool,
}

fn parse_args() -> Result<CliArgs> {
    let mut port = DEFAULT_PORT;
    let mut data_dir = std::env::var_os("PODCAST_DESK_DATA").map(PathBuf::from);
    let mut dist_dir = std::env::var_os("PODCAST_DESK_DIST").map(PathBuf::from);
    let mut no_open = std::env::var("PODCAST_DESK_NO_OPEN").is_ok_and(|v| v == "1" || v.eq_ignore_ascii_case("true"));

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                let val = args.next().ok_or_else(|| anyhow!("--port 需要一个端口号参数"))?;
                port = val.parse().context("--port 参数必须是合法端口号")?;
            }
            "--data-dir" => {
                let val = args.next().ok_or_else(|| anyhow!("--data-dir 需要一个路径参数"))?;
                data_dir = Some(PathBuf::from(val));
            }
            "--dist-dir" => {
                let val = args.next().ok_or_else(|| anyhow!("--dist-dir 需要一个路径参数"))?;
                dist_dir = Some(PathBuf::from(val));
            }
            "--no-open" => no_open = true,
            other => return Err(anyhow!("未知参数：{other}")),
        }
    }
    Ok(CliArgs { port, data_dir, dist_dir, no_open })
}

fn default_data_dir() -> PathBuf {
    let cwd_dist = Path::new("package.json").is_file() || Path::new("../package.json").is_file();
    if cwd_dist {
        if Path::new("package.json").is_file() {
            return PathBuf::from("data");
        }
        return PathBuf::from("../data");
    }
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("podcast-desk")
}

fn detect_dist_dir() -> PathBuf {
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

async fn bind_free_port(start: u16) -> Result<(u16, TcpListener)> {
    for offset in 0..PORT_SPAN {
        let Some(p) = start.checked_add(offset) else { break };
        if let Ok(listener) = TcpListener::bind(("127.0.0.1", p)).await {
            return Ok((p, listener));
        }
    }
    Err(anyhow!("端口 {start}..{} 均已被占用", start.saturating_add(PORT_SPAN - 1)))
}

fn open_browser(url: &str) {
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

#[tokio::main]
async fn main() -> Result<()> {
    let cli = parse_args()?;
    let data_dir = cli.data_dir.unwrap_or_else(default_data_dir);
    std::fs::create_dir_all(&data_dir).with_context(|| format!("创建数据目录失败：{}", data_dir.display()))?;
    std::fs::create_dir_all(data_dir.join("media"))
        .with_context(|| format!("创建媒体目录失败：{}", data_dir.join("media").display()))?;
    asr::streams::init(&data_dir);

    let db_path = data_dir.join("podcast-desk.sqlite");
    let conn = db::open(&db_path).with_context(|| format!("打开数据库失败：{}", db_path.display()))?;
    if let Ok(Some(saved_proxy)) = db::get_setting(&conn, "proxy") {
        if let Err(err) = net::set_proxy(&saved_proxy) {
            eprintln!("警告：恢复已保存代理失败（{err}），将使用系统代理");
        }
    }

    let dist_dir = cli.dist_dir.unwrap_or_else(detect_dist_dir);
    let (port, listener) = bind_free_port(cli.port).await?;
    let state = Arc::new(AppState {
        db: Mutex::new(conn),
        data_dir: data_dir.clone(),
        port,
        jobs: Mutex::new(HashMap::new()),
    });
    let app = routes::router(state, dist_dir.clone());
    let url = format!("http://127.0.0.1:{port}");
    println!("podcast-desk server listening on {url}");
    println!("  data_dir: {}", data_dir.display());
    println!("  dist_dir: {}", dist_dir.display());

    if !cli.no_open {
        open_browser(&url);
    }

    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
            println!("\npodcast-desk server shutting down...");
        })
        .await?;

    Ok(())
}
