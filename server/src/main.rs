use anyhow::{anyhow, Context, Result};
use podcast_desk_core::{
    detect_dist_dir, dev_or_standard_data_dir, open_browser, start_server, ServerConfig, DEFAULT_PORT,
};
use std::path::PathBuf;

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

#[tokio::main]
async fn main() -> Result<()> {
    let cli = parse_args()?;
    let data_dir = cli.data_dir.unwrap_or_else(dev_or_standard_data_dir);
    let dist_dir = cli.dist_dir.unwrap_or_else(detect_dist_dir);

    let mut server = start_server(ServerConfig {
        port: cli.port,
        data_dir,
        dist_dir: Some(dist_dir),
    })
    .await?;

    println!("podcast-desk server listening on {}", server.url);
    println!("  data_dir: {}", server.data_dir.display());
    println!("  dist_dir: {}", server.dist_source);

    if !cli.no_open {
        open_browser(&server.url);
    }

    let _ = tokio::signal::ctrl_c().await;
    println!("\npodcast-desk server shutting down...");
    server.shutdown();
    Ok(())
}
