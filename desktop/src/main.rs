#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ytlogin;

use podcast_desk_core::{
    detect_dist_dir, open_browser, standard_data_dir, start_server, RunningServer, ServerConfig, DEFAULT_PORT,
};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, PhysicalPosition, Position, RunEvent, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};

struct ServerState(Mutex<Option<RunningServer>>);
struct LastQuitPrompt(Mutex<Option<Instant>>);

static WEBVIEW_PROXY: std::sync::OnceLock<Option<url::Url>> = std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn macos_major() -> u32 {
    std::process::Command::new("sw_vers")
        .arg("-productVersion")
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).trim().split('.').next()?.parse().ok())
        .unwrap_or(0)
}

fn parse_webview_proxy(raw: &str) -> Result<url::Url, &'static str> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("none");
    }
    let normalized = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("http://{raw}")
    };
    let url: url::Url = normalized.parse().map_err(|_| "unsupported-proxy")?;
    if !matches!(url.scheme(), "http" | "socks5") || url.host().is_none() || url.port().is_none() {
        return Err("unsupported-proxy");
    }
    #[cfg(target_os = "macos")]
    if macos_major() < 14 {
        return Err("unsupported-os");
    }
    Ok(url)
}

pub(crate) fn webview_proxy() -> Option<url::Url> {
    WEBVIEW_PROXY
        .get_or_init(|| parse_webview_proxy(&podcast_desk_core::net::proxy()).ok())
        .clone()
}

pub(crate) fn webview_proxy_status() -> &'static str {
    let applied = webview_proxy();
    match parse_webview_proxy(&podcast_desk_core::net::proxy()) {
        Ok(now) if applied.as_ref() == Some(&now) => "app",
        Ok(_) => "restart",
        Err("none") if applied.is_some() => "restart",
        Err("none") => "system",
        Err(why) => why,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct WindowState {
    width: f64,
    height: f64,
    x: Option<i32>,
    y: Option<i32>,
    maximized: bool,
}

impl Default for WindowState {
    fn default() -> Self {
        Self {
            width: 1320.0,
            height: 840.0,
            x: None,
            y: None,
            maximized: false,
        }
    }
}

struct WindowPersist {
    path: PathBuf,
    state: WindowState,
    last_flush: Instant,
}

struct WindowPersistState(Mutex<Option<WindowPersist>>);

fn load_window_state(path: &Path) -> Option<WindowState> {
    let raw = std::fs::read_to_string(path).ok()?;
    let st: WindowState = serde_json::from_str(&raw).ok()?;
    if !st.width.is_finite() || !st.height.is_finite() || st.width < 600.0 || st.height < 420.0 {
        return None;
    }
    Some(st)
}

fn save_window_state(path: &Path, st: &WindowState) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(json) = serde_json::to_string_pretty(st) {
        let _ = std::fs::write(path, json);
    }
}

fn position_visible_on_monitors(app: &AppHandle, x: i32, y: i32, width: f64, height: f64) -> bool {
    let Ok(monitors) = app.available_monitors() else {
        return false;
    };
    let w = (width.max(320.0)) as i32;
    let h = (height.max(240.0)) as i32;
    monitors.iter().any(|m| {
        let area = m.work_area();
        let mx0 = area.position.x;
        let my0 = area.position.y;
        let mx1 = mx0 + area.size.width as i32;
        let my1 = my0 + area.size.height as i32;
        let overlap_x = (x + w).min(mx1) - x.max(mx0);
        let overlap_y = (y + h).min(my1) - y.max(my0);
        overlap_x >= 120 && overlap_y >= 80
    })
}

fn capture_window_state(win: &WebviewWindow, prev: &mut WindowState) {
    let maximized = win.is_maximized().unwrap_or(false);
    let minimized = win.is_minimized().unwrap_or(false);
    prev.maximized = maximized;
    if maximized || minimized {
        return;
    }
    let scale = win.scale_factor().unwrap_or(1.0).max(0.5);
    if let Ok(size) = win.inner_size() {
        let logical = size.to_logical::<f64>(scale);
        if logical.width >= 600.0 && logical.height >= 420.0 {
            prev.width = logical.width.round();
            prev.height = logical.height.round();
        }
    }
    if let Ok(pos) = win.outer_position() {
        if pos.x > -30000 && pos.y > -30000 {
            prev.x = Some(pos.x);
            prev.y = Some(pos.y);
        }
    }
}

fn update_window_persist(app: &AppHandle, win: &WebviewWindow, force_flush: bool) {
    let Some(holder) = app.try_state::<WindowPersistState>() else { return };
    let mut guard = holder.0.lock().unwrap_or_else(|e| e.into_inner());
    let Some(persist) = guard.as_mut() else { return };
    capture_window_state(win, &mut persist.state);
    if force_flush || persist.last_flush.elapsed() >= Duration::from_millis(800) {
        save_window_state(&persist.path, &persist.state);
        persist.last_flush = Instant::now();
    }
}

fn flush_window_persist(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        update_window_persist(app, &win, true);
    } else if let Some(holder) = app.try_state::<WindowPersistState>() {
        if let Some(persist) = holder.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            save_window_state(&persist.path, &persist.state);
        }
    }
}

fn shutdown_and_exit(app: &AppHandle) {
    flush_window_persist(app);
    if let Some(st) = app.try_state::<ServerState>() {
        if let Some(mut srv) = st.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
            srv.shutdown();
        }
    }
    app.exit(0);
}

fn focus_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn is_allowed_in_app(url: &url::Url) -> bool {
    match url.scheme() {
        "about" | "data" | "blob" | "tauri" => return true,
        "http" | "https" => {}
        _ => return false,
    }
    let Some(host) = url.host_str().map(|h| h.to_ascii_lowercase()) else {
        return false;
    };
    host == "127.0.0.1"
        || host == "localhost"
        || host == "youtu.be"
        || host.ends_with(".youtube.com")
        || host == "youtube.com"
        || host.ends_with(".youtube-nocookie.com")
        || host == "youtube-nocookie.com"
        || host.ends_with(".googlevideo.com")
        || host.ends_with(".ytimg.com")
        || host == "accounts.google.com"
        || host.ends_with(".gstatic.com")
        || host.ends_with(".ggpht.com")
}

fn prepend_exe_dir_to_path() {
    #[cfg(target_os = "windows")]
    {
        let Ok(exe) = std::env::current_exe() else { return };
        let Some(dir) = exe.parent() else { return };
        let current = std::env::var_os("PATH").unwrap_or_default();
        let mut paths = vec![dir.to_path_buf()];
        paths.extend(std::env::split_paths(&current));
        if let Ok(joined) = std::env::join_paths(paths) {
            // Safety: runs once on main thread before spawning worker threads/subprocesses.
            unsafe {
                std::env::set_var("PATH", joined);
            }
        }
    }
}

fn open_folder(path: &Path) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("explorer.exe")
            .arg(path)
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = open_browser(&path.to_string_lossy());
    }
}

fn build_tray(app: &AppHandle, data_dir: PathBuf) -> tauri::Result<()> {
    let show_item = MenuItemBuilder::with_id("show", "打开 PodDesk").build(app)?;
    let data_item = MenuItemBuilder::with_id("data_dir", "打开数据目录").build(app)?;
    let quit_item = MenuItemBuilder::with_id("quit", "退出").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&show_item)
        .item(&data_item)
        .separator()
        .item(&quit_item)
        .build()?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("PodDesk")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    let dd = data_dir.clone();
    builder
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "show" => focus_main_window(app),
            "data_dir" => open_folder(&dd),
            "quit" => {
                let active_jobs = app
                    .try_state::<ServerState>()
                    .and_then(|st| st.0.lock().unwrap_or_else(|e| e.into_inner()).as_ref().map(|s| s.active_jobs()))
                    .unwrap_or(0);
                if active_jobs > 0 {
                    let recently_prompted = app
                        .try_state::<LastQuitPrompt>()
                        .is_some_and(|p| p.0.lock().unwrap_or_else(|e| e.into_inner()).is_some_and(|t| t.elapsed().as_secs() < 6));
                    if !recently_prompted {
                        if let Some(p) = app.try_state::<LastQuitPrompt>() {
                            *p.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
                        }
                        focus_main_window(app);
                        if let Some(win) = app.get_webview_window("main") {
                            if win.eval("window.__poddeskRequestQuit && window.__poddeskRequestQuit()").is_ok() {
                                return;
                            }
                        }
                    }
                }
                shutdown_and_exit(app);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                focus_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn main() {
    prepend_exe_dir_to_path();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main_window(app);
        }))
        .manage(ServerState(Mutex::new(None)))
        .manage(LastQuitPrompt(Mutex::new(None)))
        .manage(WindowPersistState(Mutex::new(None)))
        .setup(|app| {
            let data_dir = std::env::var_os("PODCAST_DESK_DATA")
                .map(PathBuf::from)
                .unwrap_or_else(standard_data_dir);
            let dist_dir = if cfg!(debug_assertions) {
                Some(detect_dist_dir())
            } else {
                None
            };

            let yt_login = Arc::new(ytlogin::DesktopYtLogin::new(app.handle().clone()));
            let (quit_tx, quit_rx) = tokio::sync::oneshot::channel::<()>();
            let server = tauri::async_runtime::block_on(start_server(ServerConfig {
                port: DEFAULT_PORT,
                data_dir: data_dir.clone(),
                dist_dir,
                quit_tx: Some(quit_tx),
                yt_login: Some(yt_login),
            }))?;

            let url: url::Url = server.url.parse()?;
            *app.state::<ServerState>().0.lock().unwrap_or_else(|e| e.into_inner()) = Some(server);

            let quit_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                if quit_rx.await.is_ok() {
                    shutdown_and_exit(&quit_app);
                }
            });

            let win_state_path = data_dir.join("window-state.json");
            let saved_win = load_window_state(&win_state_path).unwrap_or_default();
            let width = saved_win.width.clamp(720.0, 3840.0);
            let height = saved_win.height.clamp(560.0, 2160.0);
            let valid_pos = match (saved_win.x, saved_win.y) {
                (Some(x), Some(y)) if position_visible_on_monitors(app.handle(), x, y, width, height) => Some((x, y)),
                _ => None,
            };

            *app.state::<WindowPersistState>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Some(WindowPersist {
                path: win_state_path,
                state: saved_win.clone(),
                last_flush: Instant::now(),
            });

            let mut win_builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("PodDesk")
                .inner_size(width, height)
                .min_inner_size(720.0, 560.0)
                .on_navigation(|nav_url| {
                    if is_allowed_in_app(nav_url) {
                        true
                    } else {
                        if matches!(nav_url.scheme(), "http" | "https") {
                            open_browser(nav_url.as_str());
                        }
                        false
                    }
                })
                .on_new_window(|new_url, _features| {
                    if matches!(new_url.scheme(), "http" | "https") {
                        open_browser(new_url.as_str());
                    }
                    NewWindowResponse::Deny
                });
            if valid_pos.is_none() {
                win_builder = win_builder.center();
            }
            if let Some(p) = webview_proxy() {
                win_builder = win_builder.proxy_url(p);
            }
            let win = win_builder.build()?;

            if let Some((x, y)) = valid_pos {
                let _ = win.set_position(Position::Physical(PhysicalPosition::new(x, y)));
            }
            if saved_win.maximized {
                let _ = win.maximize();
            }

            let app_for_events = app.handle().clone();
            let win_clone = win.clone();
            win.on_window_event(move |event| match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    update_window_persist(&app_for_events, &win_clone, false);
                }
                WindowEvent::CloseRequested { api, .. } => {
                    update_window_persist(&app_for_events, &win_clone, true);
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
                _ => {}
            });

            build_tray(app.handle(), data_dir)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build PodDesk desktop app");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } => {
            focus_main_window(app_handle);
        }
        RunEvent::Exit => {
            flush_window_persist(app_handle);
            if let Some(st) = app_handle.try_state::<ServerState>() {
                if let Some(mut srv) = st.0.lock().unwrap_or_else(|e| e.into_inner()).take() {
                    srv.shutdown();
                }
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::parse_webview_proxy;

    #[test]
    fn parses_valid_webview_proxies_and_rejects_unsupported() {
        assert_eq!(parse_webview_proxy(""), Err("none"));
        assert!(parse_webview_proxy("http://127.0.0.1:7897").is_ok());
        assert!(parse_webview_proxy("127.0.0.1:7890").is_ok());
        assert!(parse_webview_proxy("socks5://127.0.0.1:1080").is_ok());
        assert_eq!(parse_webview_proxy("https://127.0.0.1:7890"), Err("unsupported-proxy"));
        assert_eq!(parse_webview_proxy("http://127.0.0.1"), Err("unsupported-proxy"));
    }
}
