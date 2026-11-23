#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use podcast_desk_core::{
    detect_dist_dir, open_browser, standard_data_dir, start_server, RunningServer, ServerConfig, DEFAULT_PORT,
};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

struct ServerState(Mutex<Option<RunningServer>>);

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

fn open_folder(path: &std::path::Path) {
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
                if let Some(st) = app.try_state::<ServerState>() {
                    if let Some(mut srv) = st.0.lock().unwrap().take() {
                        srv.shutdown();
                    }
                }
                app.exit(0);
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
        .setup(|app| {
            let data_dir = std::env::var_os("PODCAST_DESK_DATA")
                .map(PathBuf::from)
                .unwrap_or_else(standard_data_dir);
            let dist_dir = if cfg!(debug_assertions) {
                Some(detect_dist_dir())
            } else {
                None
            };

            let server = tauri::async_runtime::block_on(start_server(ServerConfig {
                port: DEFAULT_PORT,
                data_dir: data_dir.clone(),
                dist_dir,
            }))?;

            let url: url::Url = server.url.parse()?;
            *app.state::<ServerState>().0.lock().unwrap() = Some(server);

            let win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("PodDesk")
                .inner_size(1320.0, 840.0)
                .min_inner_size(960.0, 640.0)
                .center()
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
                })
                .build()?;

            let win_clone = win.clone();
            win.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = win_clone.hide();
                }
            });

            build_tray(app.handle(), data_dir)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build PodDesk desktop app");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(st) = app_handle.try_state::<ServerState>() {
                if let Some(mut srv) = st.0.lock().unwrap().take() {
                    srv.shutdown();
                }
            }
        }
    });
}
