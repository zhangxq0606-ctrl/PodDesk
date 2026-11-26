//! In-app YouTube sign-in window & Netscape cookie-jar bridge (AGPL-3.0, inspired by SubCast).
use podcast_desk_core::YtLoginBridge;
use tauri::{webview::Cookie, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

const LABEL: &str = "youtube-sign-in";
const SIGN_IN_URL: &str =
    "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F";

#[cfg(target_os = "macos")]
const AGENT: &str =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15";
#[cfg(not(target_os = "macos"))]
const AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0";

pub struct DesktopYtLogin {
    app: AppHandle,
}

impl DesktopYtLogin {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

fn ours(domain: &str) -> bool {
    let d = domain.trim_start_matches('.');
    d == "youtube.com" || d.ends_with(".youtube.com") || d == "google.com" || d.ends_with(".google.com")
}

fn webview_cookies(app: &AppHandle) -> Vec<Cookie<'static>> {
    let Some(w) = app.get_webview_window(LABEL).or_else(|| app.get_webview_window("main")) else {
        return vec![];
    };
    w.cookies()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.domain().is_some_and(ours))
        .collect()
}

fn signed_in_with(cs: &[Cookie<'static>]) -> bool {
    cs.iter().any(|c| {
        c.name() == "LOGIN_INFO"
            && c.domain()
                .is_some_and(|d| d.trim_start_matches('.').ends_with("youtube.com"))
    })
}

fn jar_text(cs: &[Cookie<'static>]) -> String {
    let mut out = String::from("# Netscape HTTP Cookie File\n");
    for c in cs {
        let Some(domain) = c.domain() else { continue };
        let dotted = if domain.starts_with('.') {
            domain.to_string()
        } else {
            format!(".{domain}")
        };
        let expires = c.expires_datetime().map(|t| t.unix_timestamp().max(0)).unwrap_or(0);
        let clean = |s: &str| s.replace(['\t', '\n', '\r'], "");
        out.push_str(&format!(
            "{}{}\tTRUE\t{}\t{}\t{}\t{}\t{}\n",
            if c.http_only().unwrap_or(false) { "#HttpOnly_" } else { "" },
            dotted,
            c.path().unwrap_or("/"),
            if c.secure().unwrap_or(false) { "TRUE" } else { "FALSE" },
            expires,
            clean(c.name()),
            clean(c.value())
        ));
    }
    out
}

fn notify_main(app: &AppHandle) {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.eval("window.dispatchEvent(new CustomEvent('poddesk:yt-login-changed'))");
    }
}

fn open_window_on_main(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    let parsed_url: url::Url = SIGN_IN_URL.parse().map_err(|e| format!("登录地址无效：{e}"))?;
    let mut builder = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::External(parsed_url))
        .title("登录 YouTube（用于视频与转写验证）")
        .inner_size(480.0, 680.0)
        .user_agent(AGENT);
    // Keep proxy arguments identical to main window; WebView2 rejects a second window with differing args.
    if let Some(p) = crate::webview_proxy() {
        builder = builder.proxy_url(p);
    }
    let win = builder
        .on_page_load(move |w, p| {
            if !matches!(p.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            if !p.url().host_str().is_some_and(|h| h.ends_with("youtube.com")) {
                return;
            }
            let app_clone = handle.clone();
            std::thread::spawn(move || {
                if signed_in_with(&webview_cookies(&app_clone)) {
                    notify_main(&app_clone);
                    let _ = w.close();
                }
            });
        })
        .build()
        .map_err(|e| format!("无法打开 YouTube 登录窗口：{e}"))?;

    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.remove_menu();
    }

    let app_on_close = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            notify_main(&app_on_close);
        }
    });
    Ok(())
}

impl YtLoginBridge for DesktopYtLogin {
    fn is_signed_in(&self) -> bool {
        signed_in_with(&webview_cookies(&self.app))
    }

    fn open_login(&self) -> Result<(), String> {
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
        let app = self.app.clone();
        let app_inner = app.clone();
        app.run_on_main_thread(move || {
            let _ = tx.send(open_window_on_main(&app_inner));
        })
        .map_err(|e| format!("无法调度登录窗口：{e}"))?;
        rx.recv().map_err(|_| "登录窗口打开超时".to_string())?
    }

    fn sign_out(&self) -> Result<(), String> {
        if let Some(w) = self.app.get_webview_window("main") {
            for c in webview_cookies(&self.app) {
                let _ = w.delete_cookie(c);
            }
        }
        notify_main(&self.app);
        Ok(())
    }

    fn export_cookie_jar(&self) -> Option<String> {
        let cs = webview_cookies(&self.app);
        if !signed_in_with(&cs) {
            return None;
        }
        Some(jar_text(&cs))
    }

    fn webview_proxy_status(&self) -> &'static str {
        crate::webview_proxy_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_netscape_jar_and_detects_login() {
        let mut a = Cookie::new("LOGIN_INFO", "abc");
        a.set_domain(".youtube.com");
        a.set_path("/");
        a.set_secure(true);
        a.set_http_only(true);
        let mut b = Cookie::new("PREF", "f6=40000000");
        b.set_domain("www.youtube.com");
        let cs = vec![a, b];
        assert!(signed_in_with(&cs));
        let jar = jar_text(&cs);
        assert!(jar.starts_with("# Netscape HTTP Cookie File\n"));
        assert!(jar.contains("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tabc\n"));
        assert!(jar.contains(".www.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tf6=40000000\n"));
        assert!(!signed_in_with(&cs[1..]));
        assert!(ours(".google.com") && ours("accounts.google.com") && !ours("notyoutube.com"));
    }
}
