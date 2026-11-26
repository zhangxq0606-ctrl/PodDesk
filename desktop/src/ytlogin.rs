//! In-app YouTube & Bilibili sign-in windows and Netscape cookie-jar bridge (AGPL-3.0, inspired by SubCast).
use podcast_desk_core::YtLoginBridge;
use tauri::{webview::Cookie, AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};

#[derive(Clone, Copy)]
struct LoginSite {
    label: &'static str,
    title: &'static str,
    sign_in_url: &'static str,
    cookie_name: &'static str,
    primary_domain: &'static str,
    domains: &'static [&'static str],
    event_name: &'static str,
    window_size: (f64, f64),
}

const YOUTUBE_SITE: LoginSite = LoginSite {
    label: "youtube-sign-in",
    title: "登录 YouTube（用于视频与转写验证）",
    sign_in_url: "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F",
    cookie_name: "LOGIN_INFO",
    primary_domain: "youtube.com",
    domains: &["youtube.com", "google.com"],
    event_name: "poddesk:yt-login-changed",
    window_size: (480.0, 680.0),
};

const BILIBILI_SITE: LoginSite = LoginSite {
    label: "bilibili-sign-in",
    title: "登录 B站（用于官方与 AI 字幕及高清流）",
    sign_in_url: "https://passport.bilibili.com/login",
    cookie_name: "SESSDATA",
    primary_domain: "bilibili.com",
    domains: &["bilibili.com"],
    event_name: "poddesk:bili-login-changed",
    window_size: (520.0, 680.0),
};

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

fn domain_matches(domain: &str, suffix: &str) -> bool {
    let d = domain.trim_start_matches('.').to_ascii_lowercase();
    d == suffix || d.ends_with(&format!(".{suffix}"))
}

fn belongs_to(domain: &str, site: &LoginSite) -> bool {
    site.domains.iter().any(|suffix| domain_matches(domain, suffix))
}

fn webview_cookies(app: &AppHandle, site: &LoginSite) -> Vec<Cookie<'static>> {
    let Some(w) = app.get_webview_window(site.label).or_else(|| app.get_webview_window("main")) else {
        return vec![];
    };
    w.cookies()
        .unwrap_or_default()
        .into_iter()
        .filter(|c| c.domain().is_some_and(|d| belongs_to(d, site)))
        .collect()
}

fn signed_in_with(cs: &[Cookie<'static>], site: &LoginSite) -> bool {
    cs.iter().any(|c| {
        c.name() == site.cookie_name
            && !c.value().trim().is_empty()
            && c.domain().is_some_and(|d| domain_matches(d, site.primary_domain))
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

fn notify_main(app: &AppHandle, event_name: &str) {
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.eval(&format!("window.dispatchEvent(new CustomEvent('{event_name}'))"));
    }
}

fn open_window_on_main(app: &AppHandle, site: LoginSite) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(site.label) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        return Ok(());
    }
    let handle = app.clone();
    let parsed_url: url::Url = site.sign_in_url.parse().map_err(|e| format!("登录地址无效：{e}"))?;
    let mut builder = WebviewWindowBuilder::new(app, site.label, WebviewUrl::External(parsed_url))
        .title(site.title)
        .inner_size(site.window_size.0, site.window_size.1)
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
            if !p.url().host_str().is_some_and(|h| domain_matches(h, site.primary_domain)) {
                return;
            }
            let app_clone = handle.clone();
            std::thread::spawn(move || {
                if signed_in_with(&webview_cookies(&app_clone, &site), &site) {
                    notify_main(&app_clone, site.event_name);
                    let _ = w.close();
                }
            });
        })
        .build()
        .map_err(|e| format!("无法打开登录窗口：{e}"))?;

    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.remove_menu();
    }

    let app_on_close = app.clone();
    win.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            notify_main(&app_on_close, site.event_name);
        }
    });
    Ok(())
}

fn open_site_login(app: &AppHandle, site: LoginSite) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<(), String>>(1);
    let app_inner = app.clone();
    app.run_on_main_thread(move || {
        let _ = tx.send(open_window_on_main(&app_inner, site));
    })
    .map_err(|e| format!("无法调度登录窗口：{e}"))?;
    rx.recv().map_err(|_| "登录窗口打开超时".to_string())?
}

fn sign_out_site(app: &AppHandle, site: &LoginSite) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("main") {
        for c in webview_cookies(app, site) {
            let _ = w.delete_cookie(c);
        }
    }
    notify_main(app, site.event_name);
    Ok(())
}

fn export_site_cookies(app: &AppHandle, site: &LoginSite) -> Option<String> {
    let cs = webview_cookies(app, site);
    if !signed_in_with(&cs, site) {
        return None;
    }
    Some(jar_text(&cs))
}

impl YtLoginBridge for DesktopYtLogin {
    fn is_signed_in(&self) -> bool {
        signed_in_with(&webview_cookies(&self.app, &YOUTUBE_SITE), &YOUTUBE_SITE)
    }

    fn open_login(&self) -> Result<(), String> {
        open_site_login(&self.app, YOUTUBE_SITE)
    }

    fn sign_out(&self) -> Result<(), String> {
        sign_out_site(&self.app, &YOUTUBE_SITE)
    }

    fn export_cookie_jar(&self) -> Option<String> {
        export_site_cookies(&self.app, &YOUTUBE_SITE)
    }

    fn is_bilibili_signed_in(&self) -> bool {
        signed_in_with(&webview_cookies(&self.app, &BILIBILI_SITE), &BILIBILI_SITE)
    }

    fn open_bilibili_login(&self) -> Result<(), String> {
        open_site_login(&self.app, BILIBILI_SITE)
    }

    fn sign_out_bilibili(&self) -> Result<(), String> {
        sign_out_site(&self.app, &BILIBILI_SITE)
    }

    fn export_bilibili_cookie_jar(&self) -> Option<String> {
        export_site_cookies(&self.app, &BILIBILI_SITE)
    }

    fn webview_proxy_status(&self) -> &'static str {
        crate::webview_proxy_status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_netscape_jar_and_detects_youtube_and_bilibili_login() {
        let mut a = Cookie::new("LOGIN_INFO", "abc");
        a.set_domain(".youtube.com");
        a.set_path("/");
        a.set_secure(true);
        a.set_http_only(true);
        let mut b = Cookie::new("PREF", "f6=40000000");
        b.set_domain("www.youtube.com");
        let cs = vec![a, b];
        assert!(signed_in_with(&cs, &YOUTUBE_SITE));
        let jar = jar_text(&cs);
        assert!(jar.starts_with("# Netscape HTTP Cookie File\n"));
        assert!(jar.contains("#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\tLOGIN_INFO\tabc\n"));
        assert!(jar.contains(".www.youtube.com\tTRUE\t/\tFALSE\t0\tPREF\tf6=40000000\n"));
        assert!(!signed_in_with(&cs[1..], &YOUTUBE_SITE));
        assert!(
            belongs_to(".google.com", &YOUTUBE_SITE)
                && belongs_to("accounts.google.com", &YOUTUBE_SITE)
                && !belongs_to("notyoutube.com", &YOUTUBE_SITE)
        );

        let mut bs = Cookie::new("SESSDATA", "bili-token");
        bs.set_domain(".bilibili.com");
        assert!(signed_in_with(&[bs], &BILIBILI_SITE));
        assert!(belongs_to("passport.bilibili.com", &BILIBILI_SITE));
        assert!(!belongs_to("evilbilibili.com", &BILIBILI_SITE));
    }
}
