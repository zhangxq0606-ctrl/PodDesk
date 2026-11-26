//! Local AI agents the listener already has (their own subscription, no API key), kept running between requests:
//!
//! - Claude Code: `claude -p --input-format stream-json --output-format stream-json`
//! - Codex: `codex app-server` (JSON-RPC)
//! - Kimi Code, OpenCode, Antigravity: Agent Client Protocol (ACP) over stdio.
//!
//! Every agent runs in an empty temporary folder with its tools off: text answers only.
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex, Notify};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Claude,
    Codex,
    Antigravity,
    Kimi,
    Opencode,
}

impl Kind {
    pub const ALL: [Kind; 5] = [
        Kind::Claude,
        Kind::Codex,
        Kind::Antigravity,
        Kind::Kimi,
        Kind::Opencode,
    ];
    pub fn parse(s: &str) -> Option<Kind> {
        Kind::ALL.into_iter().find(|k| k.id() == s)
    }
    pub fn id(self) -> &'static str {
        match self {
            Kind::Claude => "claude",
            Kind::Codex => "codex",
            Kind::Antigravity => "antigravity",
            Kind::Kimi => "kimi",
            Kind::Opencode => "opencode",
        }
    }
    fn exe(self) -> &'static str {
        if self == Kind::Antigravity { "agy" } else { self.id() }
    }
    pub fn max_parallel(self) -> usize {
        2
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Found {
    pub kind: Kind,
    pub path: String,
    pub version: String,
    /// ready | needsLogin | unknown
    pub login: &'static str,
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_default()
}

fn search_dirs() -> Vec<PathBuf> {
    let h = home();
    let mut v: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
    for rel in [
        ".local/bin",
        ".claude/local",
        ".bun/bin",
        ".npm-global/bin",
        ".cargo/bin",
        ".opencode/bin",
        ".kimi-code/bin",
        ".volta/bin",
        "bin",
    ] {
        v.push(h.join(rel));
    }
    for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"] {
        v.push(PathBuf::from(d));
    }
    for base in [h.join(".nvm/versions/node"), h.join(".volta/tools/image/node")] {
        if let Ok(rd) = std::fs::read_dir(&base) {
            let mut vers: Vec<PathBuf> = rd.flatten().map(|e| e.path().join("bin")).collect();
            vers.sort();
            v.extend(vers.into_iter().rev());
        }
    }
    if cfg!(windows) {
        if let Some(a) = std::env::var_os("APPDATA") {
            v.push(PathBuf::from(a).join("npm"));
        }
        if let Some(l) = std::env::var_os("LOCALAPPDATA") {
            v.push(PathBuf::from(&l).join("Programs"));
            v.push(PathBuf::from(l).join("Microsoft\\WinGet\\Links"));
        }
    }
    let mut seen = std::collections::HashSet::new();
    v.retain(|p| seen.insert(p.clone()));
    v
}

pub fn child_path() -> std::ffi::OsString {
    std::env::join_paths(search_dirs()).unwrap_or_default()
}

fn find(kind: Kind) -> Option<PathBuf> {
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"].iter().map(|e| format!("{}.{e}", kind.exe())).collect()
    } else {
        vec![kind.exe().to_string()]
    };
    for d in search_dirs() {
        for n in &names {
            let p = d.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

pub fn path_of(kind: Kind) -> Option<PathBuf> {
    find(kind)
}

fn apply_isolation_env(c: &mut Command, kind: Kind) {
    match kind {
        Kind::Antigravity => {
            // Skip ~230 MB background CLI auto-update inside PodDesk child sessions; terminal `agy` updates normally.
            c.env("AGY_CLI_DISABLE_AUTO_UPDATE", "1");
        }
        Kind::Opencode => {
            // Strip tool permissions at runtime while keeping user-defined providers/relays and auth intact.
            c.env("OPENCODE_CONFIG_CONTENT", r#"{"permission":{"*":"deny"}}"#)
                .env("OPENCODE_DISABLE_CLAUDE_CODE", "1");
        }
        _ => {}
    }
}

fn command(kind: Option<Kind>, path: &Path) -> Command {
    let is_script = cfg!(windows) && path.extension().is_some_and(|e| e.eq_ignore_ascii_case("cmd") || e.eq_ignore_ascii_case("bat"));
    let mut c = if is_script {
        let mut c = Command::new("cmd");
        c.arg("/C").arg(path);
        c
    } else {
        Command::new(path)
    };
    c.env("PATH", child_path()).kill_on_drop(true);
    #[cfg(windows)]
    {
        c.creation_flags(0x08000000);
    }
    let proxy = crate::net::effective_proxy();
    if !proxy.is_empty() {
        c.env("HTTPS_PROXY", &proxy).env("HTTP_PROXY", &proxy);
    }
    if let Some(k) = kind {
        apply_isolation_env(&mut c, k);
    }
    c
}

async fn output(kind: Option<Kind>, path: &Path, args: &[&str], secs: u64) -> Option<String> {
    let mut c = command(kind, path);
    c.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(work_dir().ok()?);
    let out = tokio::time::timeout(Duration::from_secs(secs), c.output()).await.ok()?.ok()?;
    Some(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

fn work_dir() -> Result<PathBuf> {
    let d = std::env::temp_dir().join("podcast-desk-agent");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

async fn login(kind: Kind, path: &Path) -> &'static str {
    let h = home();
    match kind {
        Kind::Claude => match output(Some(kind), path, &["auth", "status", "--json"], 10).await {
            Some(s) => match serde_json::from_str::<Value>(s.trim())
                .ok()
                .or_else(|| s.find('{').and_then(|i| serde_json::from_str(&s[i..]).ok()))
            {
                Some(v) if v["loggedIn"].as_bool() == Some(true) => "ready",
                Some(_) => "needsLogin",
                None => "unknown",
            },
            None => "unknown",
        },
        Kind::Codex => {
            let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|| h.join(".codex"));
            if dir.join("auth.json").is_file() { "ready" } else { "needsLogin" }
        }
        Kind::Antigravity => {
            if cfg!(target_os = "macos") {
                let ok = Command::new("/usr/bin/security")
                    .args(["find-generic-password", "-s", "gemini", "-a", "antigravity"])
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .await
                    .is_ok_and(|s| s.success());
                if ok { "ready" } else { "needsLogin" }
            } else {
                "unknown"
            }
        }
        Kind::Kimi => {
            if h.join(".kimi/credentials").exists() { "ready" } else { "unknown" }
        }
        Kind::Opencode => "unknown",
    }
}

pub async fn detect() -> Vec<Found> {
    let jobs = Kind::ALL.into_iter().filter_map(|k| find(k).map(|p| (k, p))).map(|(kind, path)| async move {
        let version = output(Some(kind), &path, &["--version"], 8)
            .await
            .unwrap_or_default()
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .chars()
            .take(60)
            .collect();
        let login = login(kind, &path).await;
        Found { kind, path: path.to_string_lossy().into(), version, login }
    });
    futures_util::future::join_all(jobs).await
}

pub async fn probe(kind: Kind, path: &Path) -> Result<&'static str> {
    match kind {
        Kind::Claude | Kind::Codex => Ok(login(kind, path).await),
        Kind::Antigravity if cfg!(target_os = "macos") => {
            let st = login(kind, path).await;
            if st == "ready" {
                return Ok("ready");
            }
            probe_acp(kind, path).await
        }
        _ => probe_acp(kind, path).await,
    }
}

async fn probe_acp(kind: Kind, path: &Path) -> Result<&'static str> {
    let conn = Acp::start(kind, path).await?;
    let r = conn.session().await;
    conn.close().await;
    match r {
        Ok(_) => Ok("ready"),
        Err(e) => {
            let lower = e.to_string().to_lowercase();
            if lower.contains("auth") || lower.contains("login") || lower.contains("unauthor") || lower.contains("登录") {
                Ok("needsLogin")
            } else {
                Err(e)
            }
        }
    }
}

#[derive(serde::Serialize, Debug, PartialEq)]
pub struct AgentModel {
    pub id: String,
    pub name: String,
}

pub async fn models(kind: Kind, path: &Path) -> Result<Vec<AgentModel>> {
    match kind {
        Kind::Claude => Ok(Vec::new()),
        Kind::Codex => {
            let c = Codex::start(path).await?;
            let r = c.rpc.request("model/list", json!({}), 30).await;
            c.rpc.close().await;
            Ok(parse_codex_models(&r?))
        }
        _ => {
            let conn = Acp::start_raw(kind, path).await.map_err(|e| friendly(kind, e))?;
            let r = conn.rpc.request("session/new", json!({ "cwd": work_dir()?.to_string_lossy(), "mcpServers": [] }), 60).await;
            conn.close().await;
            Ok(parse_acp_models(&r.map_err(|e| friendly(kind, e))?))
        }
    }
}

fn parse_codex_models(v: &Value) -> Vec<AgentModel> {
    let list = v["data"].as_array().or(v["models"].as_array()).cloned().unwrap_or_default();
    list.iter()
        .filter(|m| m["hidden"].as_bool() != Some(true))
        .filter_map(|m| {
            let id = m["model"].as_str().or(m["id"].as_str())?.to_string();
            let name = m["displayName"].as_str().or(m["name"].as_str()).unwrap_or(&id).to_string();
            Some(AgentModel { id, name })
        })
        .collect()
}

fn parse_acp_models(v: &Value) -> Vec<AgentModel> {
    let mut out: Vec<AgentModel> = Vec::new();
    for m in v["models"]["availableModels"].as_array().into_iter().flatten() {
        if let Some(id) = m["modelId"].as_str() {
            out.push(AgentModel { id: id.into(), name: m["name"].as_str().unwrap_or(id).into() });
        }
    }
    if out.is_empty() {
        for o in v["configOptions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|o| o["id"].as_str() == Some("model") || o["category"].as_str() == Some("model"))
        {
            let opts = o["options"].as_array().cloned().unwrap_or_default();
            for x in opts.iter().flat_map(|x| x["options"].as_array().cloned().unwrap_or_else(|| vec![x.clone()])) {
                if let Some(id) = x["value"].as_str() {
                    out.push(AgentModel { id: id.into(), name: x["name"].as_str().unwrap_or(id).into() });
                }
            }
        }
    }
    out
}

// ---- requests --------------------------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Priority {
    Interactive,
    Background,
}

pub struct Request<'a> {
    pub system: &'a str,
    pub user: &'a str,
    pub model: Option<&'a str>,
    pub json: bool,
    pub priority: Priority,
}

pub async fn complete(
    kind: Kind,
    path: &Path,
    mut req: Request<'_>,
    cancel: Arc<AtomicBool>,
    on_delta: impl Fn(&str) + Send,
    on_thinking: impl Fn() + Send,
) -> Result<String> {
    let reminded;
    if req.json {
        reminded = format!("{}\n\n(Answer with the JSON only, no Markdown fences, no other text.)", req.user);
        req.user = &reminded;
    }
    let (conn, guard) = POOL.take(kind, path, req.system, req.model, req.priority, &cancel)
        .await
        .map_err(|e| friendly(kind, e))?;
    let result = conn.ask(&req, cancel.clone(), &on_delta, &on_thinking).await;
    POOL.give_back(conn, guard, result.is_ok()).await;
    match result {
        Ok(text) if text.trim().is_empty() => Err(anyhow!("{} 没有给出回答（可能只输出了思考过程，或被中途打断），请重试或换一个模型", display(kind))),
        Ok(text) => Ok(text),
        Err(e) => Err(friendly(kind, e)),
    }
}

fn friendly(kind: Kind, e: anyhow::Error) -> anyhow::Error {
    let m = e.to_string();
    if kind == Kind::Antigravity {
        if let Some(f) = agy_friendly(&m) {
            return anyhow!(f);
        }
    }
    let name = display(kind);
    let l = m.to_lowercase();
    if l.contains("model is unavailable") || l.contains("model not found") || l.contains("unknown model") {
        anyhow!("{name} 的默认模型不可用，请在设置里为它选一个模型")
    } else if l.contains("not logged in") || l.contains("login") || l.contains("unauthor") || l.contains("auth_required") || l.contains("authentication") {
        anyhow!("{name} 需要登录：在终端运行 {} 完成登录后，回到设置点「重新检测」", kind.exe())
    } else if l.contains("rate limit") || l.contains("usage limit") || l.contains("quota") || l.contains("429") || l.contains("limit reached") {
        anyhow!("{name} 的订阅额度暂时用完了（请求太频繁或额度不足）：{}", m.chars().take(160).collect::<String>())
    } else {
        e
    }
}

fn agy_friendly(m: &str) -> Option<String> {
    let l = m.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| l.contains(w));
    Some(if has(&[AGY_TOO_OLD, "flag provided but not defined", "unknown command", "unknown flag", "unknown argument"]) {
        "Antigravity CLI 版本太旧，不支持当前调用方式：在终端运行 agy update 升级后，回到设置点「重新检测」".to_string()
    } else if has(&["individual quota reached", "third-party quota reached"]) {
        let third = l.contains("third-party");
        match agy_reset_in(m) {
            Some(t) if third => format!("Antigravity CLI 的 Claude / GPT 额度用完了，{t} 后恢复；Gemini 模型额度单独计算，可先切换 Gemini 模型"),
            Some(t) => format!("Antigravity CLI 所用 Google 账号的额度用完了，{t} 后恢复；也可以先换一个模型"),
            None if third => String::from("Antigravity CLI 的 Claude / GPT 额度用完了；Gemini 模型额度单独计算，可先切换 Gemini 模型"),
            None => String::from("Antigravity CLI 所用 Google 账号的额度用完了，稍后再试或先换一个模型"),
        }
    } else if has(&["credits balance is too low"]) {
        "Antigravity CLI 的 AI 点数余额不足，等额度恢复或在 Google 账号内补充后再试".to_string()
    } else if has(&["violation of terms of service", "service has been disabled"]) {
        "Google 停用了这个账号的 Antigravity 服务（判定违反服务条款），需要先向 Google 申诉".to_string()
    } else if has(&["verification required", "validation_required"]) {
        "Google 要求先验证这个账号：在终端运行 agy，按提示完成验证后再试".to_string()
    } else if has(&["high traffic", "no capacity available", "code 503"]) {
        "Google 服务器正忙，所选模型暂时没有空余算力：过一分钟再试或切换其他模型".to_string()
    } else if has(&["network issue connecting"]) {
        "Antigravity CLI 连不上 Google 服务器：请检查网络或代理后重试".to_string()
    } else if has(&["resource_exhausted", "resource has been exhausted", "resource exhausted", "code 429"]) {
        "Antigravity CLI 暂时拒绝了这次请求（Google 返回 429，不一定是额度用完）：稍后再试或切换其他模型".to_string()
    } else if has(&["agent execution terminated"]) {
        "Antigravity CLI 回答到一半出错停止了，请重试".to_string()
    } else {
        return None;
    })
}

fn agy_reset_in(m: &str) -> Option<String> {
    let i = m.to_lowercase().find("resets in ")?;
    let t: String = m[i + "resets in ".len()..].chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
    (!t.is_empty()).then_some(t)
}

/// `agy` reports failed model calls at the end of a normal turn prefixed with `⚠`.
fn agy_error_line(text: &str) -> Option<&str> {
    const STARTS: [&str; 10] = [
        "RESOURCE_EXHAUSTED",
        "PERMISSION_DENIED",
        "Individual quota reached",
        "Third-party quota reached",
        "Verification Required",
        "Agent execution terminated",
        "There was a network issue",
        "Your AI credits balance",
        "Our servers are experiencing high traffic",
        "This service has been disabled",
    ];
    let last = text.lines().rev().find(|l| !l.trim().is_empty())?.trim();
    let body = last.strip_prefix('⚠')?.trim_start();
    STARTS.iter().any(|s| body.starts_with(s)).then_some(last)
}

pub fn display(kind: Kind) -> &'static str {
    match kind {
        Kind::Claude => "Claude Code",
        Kind::Codex => "Codex",
        Kind::Antigravity => "Antigravity CLI",
        Kind::Kimi => "Kimi Code",
        Kind::Opencode => "OpenCode",
    }
}

// ---- the pool of warm processes ----------------------------------------------------------------------------

const IDLE: Duration = Duration::from_secs(240);
const BUSY_WAIT: Duration = Duration::from_secs(90);

enum Conn {
    Claude(ClaudeConn),
    Codex(Codex),
    Acp(Acp),
}

struct Pooled {
    kind: Kind,
    conn: Conn,
    idle_since: Instant,
}

#[derive(Default)]
struct PoolState {
    idle: Vec<Pooled>,
    busy: HashMap<Kind, usize>,
    waiting_interactive: HashMap<Kind, usize>,
}

struct Pool {
    state: std::sync::Mutex<PoolState>,
    notify: Notify,
}

struct BusyGuard<'a> {
    pool: &'a Pool,
    kind: Kind,
    active: bool,
}

impl BusyGuard<'_> {
    fn disarm(mut self) {
        self.active = false;
    }
}

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        if self.active {
            self.pool.release(self.kind);
        }
    }
}

struct WaitGuard<'a> {
    pool: &'a Pool,
    kind: Kind,
}

impl Drop for WaitGuard<'_> {
    fn drop(&mut self) {
        let mut st = self.pool.state.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(n) = st.waiting_interactive.get_mut(&self.kind) {
            *n = n.saturating_sub(1);
        }
        self.pool.notify.notify_waiters();
    }
}

static POOL: once_cell::sync::Lazy<Pool> = once_cell::sync::Lazy::new(|| {
    tokio::spawn(async {
        loop {
            tokio::time::sleep(Duration::from_secs(30)).await;
            let stale: Vec<Pooled> = {
                let mut st = POOL.state.lock().unwrap_or_else(|e| e.into_inner());
                let (old, keep) = st.idle.drain(..).partition(|p| p.idle_since.elapsed() > IDLE);
                st.idle = keep;
                old
            };
            for p in stale {
                p.conn.close().await;
            }
        }
    });
    Pool::new()
});

async fn cancellable<T, F>(cancel: &AtomicBool, fut: F) -> Result<T>
where
    F: std::future::Future<Output = Result<T>>,
{
    tokio::pin!(fut);
    let mut tick = tokio::time::interval(Duration::from_millis(50));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        tokio::select! {
            res = &mut fut => return res,
            _ = tick.tick() => {}
        }
    }
}

impl Pool {
    fn new() -> Self {
        Self { state: std::sync::Mutex::new(PoolState::default()), notify: Notify::new() }
    }

    fn try_acquire(&self, kind: Kind, priority: Priority) -> Option<(Option<Pooled>, BusyGuard<'_>)> {
        let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let bg_cap = kind.max_parallel();
        let fg_cap = bg_cap + 1;
        let busy = *st.busy.get(&kind).unwrap_or(&0);
        let fg_waiting = *st.waiting_interactive.get(&kind).unwrap_or(&0);
        let allowed = match priority {
            Priority::Interactive => busy < fg_cap,
            Priority::Background => busy < bg_cap && fg_waiting == 0,
        };
        if !allowed {
            return None;
        }
        *st.busy.entry(kind).or_default() += 1;
        let reused = if kind == Kind::Claude {
            None
        } else {
            st.idle.iter().position(|p| p.kind == kind).map(|i| st.idle.remove(i))
        };
        Some((reused, BusyGuard { pool: self, kind, active: true }))
    }

    async fn acquire_slot(&self, kind: Kind, priority: Priority, cancel: &AtomicBool) -> Result<(Option<Pooled>, BusyGuard<'_>)> {
        if let Some(hit) = self.try_acquire(kind, priority) {
            return Ok(hit);
        }
        let _wait_guard = if priority == Priority::Interactive {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            *st.waiting_interactive.entry(kind).or_default() += 1;
            Some(WaitGuard { pool: self, kind })
        } else {
            None
        };
        let waiting = Instant::now();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Err(anyhow!("已取消"));
            }
            if waiting.elapsed() > BUSY_WAIT {
                return Err(anyhow!("{} 正忙（可能在并发翻译或排队），请稍后再试", display(kind)));
            }
            if let Some(hit) = self.try_acquire(kind, priority) {
                return Ok(hit);
            }
            let _ = tokio::time::timeout(Duration::from_millis(100), self.notify.notified()).await;
        }
    }

    async fn take(
        &self,
        kind: Kind,
        path: &Path,
        system: &str,
        model: Option<&str>,
        priority: Priority,
        cancel: &AtomicBool,
    ) -> Result<(Pooled, BusyGuard<'_>)> {
        let (reused, guard) = self.acquire_slot(kind, priority, cancel).await?;
        if let Some(p) = reused {
            if p.conn.alive() {
                return Ok((p, guard));
            }
            p.conn.close().await;
        }
        let conn = cancellable(cancel, async {
            match kind {
                Kind::Claude => ClaudeConn::start(path, system, model).await.map(Conn::Claude),
                Kind::Codex => Codex::start(path).await.map(Conn::Codex),
                _ => Acp::start(kind, path).await.map(Conn::Acp),
            }
        })
        .await?;
        Ok((Pooled { kind, conn, idle_since: Instant::now() }, guard))
    }

    fn release(&self, kind: Kind) {
        {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(n) = st.busy.get_mut(&kind) {
                *n = n.saturating_sub(1);
            }
        }
        self.notify.notify_waiters();
    }

    async fn give_back(&self, mut p: Pooled, guard: BusyGuard<'_>, ok: bool) {
        guard.disarm();
        self.release(p.kind);
        // ClaudeConn keeps conversation memory across turns on the same process, so never reuse it across calls.
        if p.kind == Kind::Claude || !ok || !p.conn.alive() {
            p.conn.close().await;
            return;
        }
        p.idle_since = Instant::now();
        let mut evicted = Vec::new();
        {
            let mut st = self.state.lock().unwrap_or_else(|e| e.into_inner());
            let kind = p.kind;
            st.idle.push(p);
            while st.idle.iter().filter(|x| x.kind == kind).count() > 2 {
                if let Some(i) = st.idle.iter().position(|x| x.kind == kind) {
                    evicted.push(st.idle.remove(i));
                }
            }
        }
        for old in evicted {
            old.conn.close().await;
        }
    }
}

impl Pooled {
    async fn ask(
        &self,
        req: &Request<'_>,
        cancel: Arc<AtomicBool>,
        on_delta: &(impl Fn(&str) + Send),
        on_thinking: &(impl Fn() + Send),
    ) -> Result<String> {
        match &self.conn {
            Conn::Claude(c) => c.ask(req, cancel, on_delta, on_thinking).await,
            Conn::Codex(c) => c.ask(req, cancel, on_delta, on_thinking).await,
            Conn::Acp(c) => c.ask(req, cancel, on_delta, on_thinking).await,
        }
    }
}

impl Conn {
    fn alive(&self) -> bool {
        match self {
            Conn::Claude(c) => c.rpc.alive(),
            Conn::Codex(c) => c.rpc.alive(),
            Conn::Acp(c) => c.rpc.alive(),
        }
    }
    async fn close(self) {
        match self {
            Conn::Claude(c) => c.rpc.close().await,
            Conn::Codex(c) => c.rpc.close().await,
            Conn::Acp(c) => c.close().await,
        }
    }
}

pub async fn warm(kind: Kind, path: &Path) {
    if kind == Kind::Claude {
        return;
    }
    let cancel = AtomicBool::new(false);
    if let Ok((p, guard)) = POOL.take(kind, path, "", None, Priority::Background, &cancel).await {
        POOL.give_back(p, guard, true).await;
    }
}

// ---- line-oriented JSON over a child's stdio -------------------------------------------------------------------

struct Rpc {
    child: Mutex<Option<Child>>,
    stdin: Mutex<ChildStdin>,
    next: AtomicU64,
    waiting: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>,
    events: Mutex<mpsc::UnboundedReceiver<Value>>,
    dead: Arc<AtomicBool>,
    stderr: Arc<std::sync::Mutex<String>>,
}

impl Rpc {
    async fn spawn(kind: Option<Kind>, path: &Path, args: &[&str]) -> Result<Rpc> {
        let mut c = command(kind, path);
        c.args(args)
            .current_dir(work_dir()?)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = c.spawn().with_context(|| format!("无法启动 {}", path.display()))?;
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let waiting: Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = Arc::default();
        let (tx, rx) = mpsc::unbounded_channel();
        let dead = Arc::new(AtomicBool::new(false));
        let err_tail = Arc::new(std::sync::Mutex::new(String::new()));
        {
            let (waiting, dead) = (waiting.clone(), dead.clone());
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let Ok(v) = serde_json::from_str::<Value>(line.trim()) else { continue };
                    if v.get("method").is_none() && (v.get("result").is_some() || v.get("error").is_some()) {
                        if let Some(id) = v["id"].as_u64() {
                            if let Some(w) = waiting.lock().await.remove(&id) {
                                let _ = w.send(v);
                                continue;
                            }
                        }
                    }
                    let _ = tx.send(v);
                }
                dead.store(true, Ordering::Relaxed);
                waiting.lock().await.clear();
            });
        }
        {
            let tail = err_tail.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let mut t = tail.lock().unwrap();
                    t.push_str(&line);
                    t.push('\n');
                    if t.len() > 4000 {
                        let cut = t.len() - 2000;
                        *t = t[cut..].to_string();
                    }
                }
            });
        }
        Ok(Rpc {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(stdin),
            next: AtomicU64::new(1),
            waiting,
            events: Mutex::new(rx),
            dead,
            stderr: err_tail,
        })
    }

    fn alive(&self) -> bool {
        !self.dead.load(Ordering::Relaxed)
    }

    fn last_error(&self) -> String {
        self.stderr
            .lock()
            .unwrap()
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .unwrap_or("")
            .chars()
            .take(200)
            .collect()
    }

    async fn send(&self, v: &Value) -> Result<()> {
        let mut s = self.stdin.lock().await;
        s.write_all(format!("{v}\n").as_bytes()).await?;
        s.flush().await?;
        Ok(())
    }

    async fn request(&self, method: &str, params: Value, secs: u64) -> Result<Value> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.waiting.lock().await.insert(id, tx);
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await?;
        let v = tokio::time::timeout(Duration::from_secs(secs), rx)
            .await
            .map_err(|_| anyhow!("{method} 超时"))?
            .map_err(|_| anyhow!("本机 AI 意外退出：{}", self.last_error()))?;
        if let Some(e) = v.get("error") {
            return Err(anyhow!("{}", e["message"].as_str().unwrap_or(&e.to_string())));
        }
        Ok(v["result"].clone())
    }

    async fn notify(&self, method: &str, params: Value) -> Result<()> {
        self.send(&json!({ "jsonrpc": "2.0", "method": method, "params": params })).await
    }

    async fn reply(&self, id: &Value, result: Value) -> Result<()> {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "result": result })).await
    }

    async fn reply_error(&self, id: &Value, message: &str) -> Result<()> {
        self.send(&json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } })).await
    }

    async fn event(&self, secs: u64) -> Result<Value> {
        let mut rx = self.events.lock().await;
        match tokio::time::timeout(Duration::from_secs(secs), rx.recv()).await {
            Ok(Some(v)) => Ok(v),
            Ok(None) => Err(anyhow!("本机 AI 意外退出：{}", self.last_error())),
            Err(_) => Err(anyhow!("本机 AI 长时间没有回应")),
        }
    }

    async fn close(&self) {
        if let Some(mut c) = self.child.lock().await.take() {
            #[cfg(windows)]
            if let Some(pid) = c.id() {
                // `.cmd` shims (`opencode.cmd`, `codex.cmd`) spawn grandchildren that `start_kill` alone orphans.
                let mut tk = Command::new("taskkill");
                tk.args(["/PID", &pid.to_string(), "/T", "/F"])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .creation_flags(0x08000000);
                let _ = tokio::time::timeout(Duration::from_secs(2), tk.status()).await;
            }
            let _ = c.start_kill();
            let _ = tokio::time::timeout(Duration::from_secs(3), c.wait()).await;
        }
    }
}

fn check_timeouts(started: Instant, last_activity: Instant, priority: Priority) -> Result<()> {
    let idle_limit = match priority {
        Priority::Background => Duration::from_secs(60),
        Priority::Interactive => Duration::from_secs(120),
    };
    const MAX_WALL: Duration = Duration::from_secs(420);
    if last_activity.elapsed() > idle_limit {
        return Err(anyhow!("本机 AI 超过 {} 秒没有任何响应，请重试或切换模型", idle_limit.as_secs()));
    }
    if started.elapsed() > MAX_WALL {
        return Err(anyhow!("本机 AI 超过 {} 分钟没有答完", MAX_WALL.as_secs() / 60));
    }
    Ok(())
}

async fn next_event(
    rpc: &Rpc,
    cancel: &AtomicBool,
    started: Instant,
    last_activity: Instant,
    priority: Priority,
) -> Result<Value> {
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err(anyhow!("已取消"));
        }
        check_timeouts(started, last_activity, priority)?;
        match rpc.event(1).await {
            Ok(v) => return Ok(v),
            Err(e) if e.to_string().contains("长时间没有回应") => continue,
            Err(e) => return Err(e),
        }
    }
}

// ---- Claude Code ------------------------------------------------------------

struct ClaudeConn {
    rpc: Rpc,
}

impl ClaudeConn {
    async fn start(path: &Path, system: &str, model: Option<&str>) -> Result<ClaudeConn> {
        let mut args = vec![
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--tools",
            "",
            "--strict-mcp-config",
            "--no-session-persistence",
            "--system-prompt",
            system,
        ];
        if let Some(m) = model.filter(|m| !m.is_empty()) {
            args.extend(["--model", m]);
        }
        Ok(ClaudeConn { rpc: Rpc::spawn(Some(Kind::Claude), path, &args).await? })
    }

    async fn ask(
        &self,
        req: &Request<'_>,
        cancel: Arc<AtomicBool>,
        on_delta: &(impl Fn(&str) + Send),
        on_thinking: &(impl Fn() + Send),
    ) -> Result<String> {
        self.rpc
            .send(&json!({ "type": "user", "message": { "role": "user", "content": req.user } }))
            .await?;
        let started = Instant::now();
        let mut last_activity = started;
        let mut text = String::new();
        loop {
            let v = match next_event(&self.rpc, &cancel, started, last_activity, req.priority).await {
                Ok(v) => {
                    last_activity = Instant::now();
                    v
                }
                Err(e) => {
                    if cancel.load(Ordering::Relaxed) {
                        self.rpc.close().await;
                    }
                    return Err(e);
                }
            };
            match v["type"].as_str() {
                Some("stream_event") => {
                    let ev = &v["event"];
                    if (ev["type"] == "content_block_start" && ev["content_block"]["type"] == "thinking")
                        || (ev["type"] == "content_block_delta" && ev["delta"]["type"] == "thinking_delta")
                    {
                        on_thinking();
                    } else if ev["type"] == "content_block_delta" && ev["delta"]["type"] == "text_delta" {
                        if let Some(d) = ev["delta"]["text"].as_str() {
                            text.push_str(d);
                            on_delta(d);
                        }
                    }
                }
                Some("result") => {
                    if v["is_error"].as_bool() == Some(true) {
                        return Err(anyhow!("{}", v["result"].as_str().unwrap_or("Claude Code 出错")));
                    }
                    if text.is_empty() {
                        text = v["result"].as_str().unwrap_or("").to_string();
                        on_delta(&text);
                    }
                    return Ok(text);
                }
                _ => {}
            }
        }
    }
}

// ---- Codex app-server ---------------------------------------------------------------------------------------------

struct Codex {
    rpc: Rpc,
}

impl Codex {
    async fn start(path: &Path) -> Result<Codex> {
        let rpc = Rpc::spawn(
            Some(Kind::Codex),
            path,
            &[
                "app-server",
                "--disable",
                "hooks",
                "-c",
                "mcp_servers={}",
                "-c",
                "project_doc_max_bytes=0",
            ],
        )
        .await?;
        rpc.request(
            "initialize",
            json!({ "clientInfo": { "name": "podcast-desk", "title": "PodDesk", "version": env!("CARGO_PKG_VERSION") } }),
            30,
        )
        .await?;
        rpc.notify("initialized", json!({})).await?;
        Ok(Codex { rpc })
    }

    async fn ask(
        &self,
        req: &Request<'_>,
        cancel: Arc<AtomicBool>,
        on_delta: &(impl Fn(&str) + Send),
        on_thinking: &(impl Fn() + Send),
    ) -> Result<String> {
        let cwd = work_dir()?.to_string_lossy().to_string();
        let mut thread = json!({
            "cwd": cwd,
            "sandbox": "read-only",
            "approvalPolicy": "never",
            "ephemeral": true,
            "baseInstructions": req.system
        });
        if let Some(m) = req.model.filter(|m| !m.is_empty()) {
            thread["model"] = json!(m);
        }
        let t = cancellable(&cancel, self.rpc.request("thread/start", thread, 60)).await?;
        let thread_id = t["thread"]["id"]
            .as_str()
            .or(t["threadId"].as_str())
            .ok_or_else(|| anyhow!("Codex 没有返回会话"))?
            .to_string();
        let turn = json!({ "threadId": thread_id, "input": [{ "type": "text", "text": req.user }], "effort": "low" });
        cancellable(&cancel, self.rpc.request("turn/start", turn, 60)).await?;
        let started = Instant::now();
        let mut last_activity = started;
        let mut text = String::new();
        loop {
            let v = match next_event(&self.rpc, &cancel, started, last_activity, req.priority).await {
                Ok(v) => {
                    last_activity = Instant::now();
                    v
                }
                Err(e) => {
                    if cancel.load(Ordering::Relaxed) {
                        let _ = self.rpc.request("turn/interrupt", json!({ "threadId": thread_id }), 5).await;
                    }
                    return Err(e);
                }
            };
            let m = v["method"].as_str().unwrap_or("");
            if v.get("id").is_some() && !m.is_empty() {
                let _ = self.rpc.reply_error(&v["id"], "PodDesk 不允许本机 AI 执行操作").await;
                continue;
            }
            if v["params"]["threadId"].as_str().is_some_and(|t| t != thread_id) {
                continue;
            }
            match m {
                "item/agentMessage/delta" => {
                    if let Some(d) = v["params"]["delta"].as_str() {
                        text.push_str(d);
                        on_delta(d);
                    }
                }
                "item/completed" => {
                    if text.is_empty() && v["params"]["item"]["type"].as_str() == Some("agentMessage") {
                        if let Some(t) = v["params"]["item"]["text"].as_str() {
                            text.push_str(t);
                            on_delta(t);
                        }
                    }
                }
                "turn/completed" => {
                    let turn = &v["params"]["turn"];
                    if turn["status"].as_str() == Some("failed") {
                        return Err(anyhow!("{}", turn["error"]["message"].as_str().unwrap_or("Codex 没有完成回答")));
                    }
                    return Ok(text);
                }
                "error" => {
                    return Err(anyhow!(
                        "{}",
                        v["params"]["error"]["message"]
                            .as_str()
                            .or(v["params"]["message"].as_str())
                            .unwrap_or("Codex 出错")
                    ));
                }
                m if m.contains("reasoning") => {
                    on_thinking();
                }
                "item/started" => {
                    if v["params"]["item"]["type"].as_str().is_some_and(|t| t.contains("reasoning")) {
                        on_thinking();
                    }
                }
                _ => {}
            }
        }
    }
}

// ---- Agent Client Protocol (Kimi Code, OpenCode, Antigravity) -------------------------

struct Acp {
    kind: Kind,
    rpc: Rpc,
    spare: std::sync::Mutex<Option<oneshot::Receiver<Value>>>,
}

const AGY_TOO_OLD: &str = "agy has no acp server";

static AGY_HELP: once_cell::sync::Lazy<std::sync::Mutex<HashMap<String, String>>> =
    once_cell::sync::Lazy::new(Default::default);

async fn agy_acp_help(path: &Path) -> String {
    let key = match std::fs::metadata(path) {
        Ok(md) => format!("{}|{}|{:?}", path.display(), md.len(), md.modified().ok()),
        Err(_) => path.display().to_string(),
    };
    if let Some(h) = AGY_HELP.lock().unwrap().get(&key) {
        return h.clone();
    }
    let help = output(Some(Kind::Antigravity), path, &["acp", "--help"], 15)
        .await
        .unwrap_or_default();
    if !help.trim().is_empty() {
        AGY_HELP.lock().unwrap().insert(key, help.clone());
    }
    help
}

fn agy_flags(help: &str) -> Result<Vec<&'static str>> {
    if !help.trim().is_empty() && !help.contains("--agent") && !help.to_lowercase().contains("agent client protocol") {
        return Err(anyhow!("{AGY_TOO_OLD}"));
    }
    let mut v = Vec::new();
    if help.contains("--include-default-customizations") {
        v.push("--include-default-customizations=false");
    }
    if help.contains("--disable-telemetry") || help.contains("--disable_telemetry") {
        v.push("--disable-telemetry");
    }
    Ok(v)
}

const EFFORTS: [&str; 6] = ["minimal", "low", "medium", "high", "xhigh", "max"];

fn config_applied(result: &Value, id: &str, value: &str) -> bool {
    match result["configOptions"].as_array() {
        Some(opts) => opts
            .iter()
            .find(|o| o["id"].as_str() == Some(id))
            .is_some_and(|o| o["currentValue"].as_str() == Some(value)),
        None => true,
    }
}

fn split_leveled(config_options: &Value, model: &str) -> Option<(String, String)> {
    let opt = config_options
        .as_array()?
        .iter()
        .find(|o| o["id"].as_str() == Some("model") || o["category"].as_str() == Some("model"))?;
    let values: Vec<String> = opt["options"]
        .as_array()?
        .iter()
        .flat_map(|x| x["options"].as_array().cloned().unwrap_or_else(|| vec![x.clone()]))
        .filter_map(|x| x["value"].as_str().map(str::to_string))
        .collect();
    values
        .into_iter()
        .filter_map(|v| {
            let level = model.strip_prefix(v.as_str())?.strip_prefix('-')?;
            EFFORTS.contains(&level).then(|| (v.clone(), level.to_string()))
        })
        .max_by_key(|(v, _)| v.len())
}

fn acp_args(kind: Kind) -> &'static [&'static str] {
    match kind {
        Kind::Antigravity => &["acp", "--agent", "podcast-desk"],
        Kind::Kimi | Kind::Opencode => &["acp"],
        _ => &[],
    }
}

static ANTIGRAVITY_INIT: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();

impl Acp {
    async fn start_raw(kind: Kind, path: &Path) -> Result<Acp> {
        let mut args: Vec<&str> = acp_args(kind).to_vec();
        if kind == Kind::Antigravity {
            args.extend(agy_flags(&agy_acp_help(path).await)?);
            ANTIGRAVITY_INIT
                .get_or_try_init(|| async {
                    let dir = work_dir()?.join(".agents/agents/podcast-desk");
                    std::fs::create_dir_all(&dir)?;
                    std::fs::write(
                        dir.join("agent.md"),
                        "---\nname: podcast-desk\ndescription: Answers in text only\nmainAgent: true\nsubagent: false\ntools: []\ninheritMcp: false\ninheritCustomizations: false\nexcludeDefaultComponents: true\n---\nAnswer in text only. You have no tools.\n",
                    )?;
                    Ok::<_, anyhow::Error>(())
                })
                .await?;
        }
        let rpc = Rpc::spawn(Some(kind), path, &args).await?;
        rpc.request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false }, "terminal": false },
                "clientInfo": { "name": "podcast-desk", "version": env!("CARGO_PKG_VERSION") }
            }),
            60,
        )
        .await?;
        Ok(Acp { kind, rpc, spare: std::sync::Mutex::new(None) })
    }

    async fn start(kind: Kind, path: &Path) -> Result<Acp> {
        let acp = Self::start_raw(kind, path).await?;
        acp.prepare_session().await;
        Ok(acp)
    }

    async fn prepare_session(&self) {
        let Ok(dir) = work_dir() else { return };
        let id = self.rpc.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.rpc.waiting.lock().await.insert(id, tx);
        if self
            .rpc
            .send(&json!({ "jsonrpc": "2.0", "id": id, "method": "session/new", "params": { "cwd": dir.to_string_lossy(), "mcpServers": [] } }))
            .await
            .is_ok()
        {
            *self.spare.lock().unwrap_or_else(|e| e.into_inner()) = Some(rx);
        }
    }

    async fn session(&self) -> Result<String> {
        let spare = self.spare.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(rx) = spare {
            if let Ok(Ok(v)) = tokio::time::timeout(Duration::from_secs(30), rx).await {
                if let Some(id) = v["result"]["sessionId"].as_str() {
                    return Ok(id.to_string());
                }
            }
        }
        self.new_session().await
    }

    async fn new_session(&self) -> Result<String> {
        let r = self
            .rpc
            .request("session/new", json!({ "cwd": work_dir()?.to_string_lossy(), "mcpServers": [] }), 60)
            .await?;
        r["sessionId"].as_str().map(str::to_string).ok_or_else(|| anyhow!("本机 AI 没有返回会话"))
    }

    async fn ask(
        &self,
        req: &Request<'_>,
        cancel: Arc<AtomicBool>,
        on_delta: &(impl Fn(&str) + Send),
        on_thinking: &(impl Fn() + Send),
    ) -> Result<String> {
        let session = cancellable(&cancel, self.session()).await?;
        if let Some(m) = req.model.filter(|m| !m.is_empty()) {
            let applied = cancellable(&cancel, self.select_model(&session, m)).await?;
            if !applied && self.kind == Kind::Antigravity {
                return Err(anyhow!("Antigravity CLI 当前未提供所选模型「{m}」，请在 PodDesk 设置中重新选择模型"));
            }
        }
        let prompt = if req.system.is_empty() {
            req.user.to_string()
        } else {
            format!("{}\n\n---\n\n{}", req.system, req.user)
        };
        let id = self.rpc.next.fetch_add(1, Ordering::Relaxed);
        let (tx, mut rx) = oneshot::channel();
        self.rpc.waiting.lock().await.insert(id, tx);
        self.rpc
            .send(&json!({ "jsonrpc": "2.0", "id": id, "method": "session/prompt", "params": { "sessionId": session, "prompt": [{ "type": "text", "text": prompt }] } }))
            .await?;
        let started = Instant::now();
        let mut last_activity = started;
        let mut text = String::new();
        loop {
            if let Ok(done) = rx.try_recv() {
                if let Some(e) = done.get("error") {
                    return Err(anyhow!("{}", e["message"].as_str().unwrap_or("本机 AI 出错")));
                }
                while let Ok(v) = self.rpc.event(0).await {
                    if let Some(tool_err) = self.on_update(&v, &session, &mut text, on_delta, on_thinking, &mut last_activity).await {
                        return Err(anyhow!("{tool_err}"));
                    }
                }
                self.prepare_session().await;
                if self.kind == Kind::Antigravity {
                    if let Some(line) = agy_error_line(&text) {
                        return Err(anyhow!("{line}"));
                    }
                }
                return Ok(text);
            }
            if cancel.load(Ordering::Relaxed) {
                let _ = self.rpc.notify("session/cancel", json!({ "sessionId": session })).await;
                return Err(anyhow!("已取消"));
            }
            check_timeouts(started, last_activity, req.priority)?;
            let v = match tokio::time::timeout(Duration::from_millis(200), async { self.rpc.events.lock().await.recv().await }).await {
                Ok(Some(v)) => v,
                Ok(None) => return Err(anyhow!("本机 AI 意外退出：{}", self.rpc.last_error())),
                Err(_) => continue,
            };
            if let Some(tool_err) = self.on_update(&v, &session, &mut text, on_delta, on_thinking, &mut last_activity).await {
                let _ = self.rpc.notify("session/cancel", json!({ "sessionId": session })).await;
                return Err(anyhow!("{tool_err}"));
            }
        }
    }

    async fn select_model(&self, session: &str, m: &str) -> Result<bool> {
        let set = |id: &str, value: &str| {
            self.rpc.request(
                "session/set_config_option",
                json!({ "sessionId": session, "configId": id, "value": value }),
                15,
            )
        };
        let first = set("model", m).await;
        if first.as_ref().is_ok_and(|r| config_applied(r, "model", m)) {
            return Ok(true);
        }
        if self
            .rpc
            .request("session/set_model", json!({ "sessionId": session, "modelId": m }), 15)
            .await
            .is_ok()
        {
            return Ok(true);
        }
        let Some((family, level)) = first.ok().and_then(|r| split_leveled(&r["configOptions"], m)) else {
            return Ok(false);
        };
        let fam_ok = set("model", &family).await.is_ok_and(|r| config_applied(&r, "model", &family));
        let lvl_ok = set("thought_level", &level)
            .await
            .is_ok_and(|r| config_applied(&r, "thought_level", &level));
        Ok(fam_ok && lvl_ok)
    }

    async fn on_update(
        &self,
        v: &Value,
        session: &str,
        text: &mut String,
        on_delta: &(impl Fn(&str) + Send),
        on_thinking: &(impl Fn() + Send),
        last_activity: &mut Instant,
    ) -> Option<String> {
        let m = v["method"].as_str().unwrap_or("");
        if v.get("id").is_some() && !m.is_empty() {
            let _ = if m == "session/request_permission" {
                self.rpc.reply(&v["id"], json!({ "outcome": { "outcome": "cancelled" } })).await
            } else {
                self.rpc.reply_error(&v["id"], "not supported").await
            };
            return None;
        }
        if m != "session/update" || v["params"]["sessionId"].as_str() != Some(session) {
            return None;
        }
        let u = &v["params"]["update"];
        if let Some(err) = check_acp_tool_update(u) {
            return Some(err);
        }
        if u["sessionUpdate"] == "agent_thought_chunk" {
            *last_activity = Instant::now();
            on_thinking();
        } else if u["sessionUpdate"] == "agent_message_chunk" && u["content"]["type"] == "text" {
            if let Some(d) = u["content"]["text"].as_str() {
                if !d.is_empty() {
                    *last_activity = Instant::now();
                }
                text.push_str(d);
                on_delta(d);
            }
        }
        None
    }

    async fn close(&self) {
        self.rpc.close().await;
    }
}

fn check_acp_tool_update(u: &Value) -> Option<String> {
    let kind = u["sessionUpdate"].as_str()?;
    if kind == "tool_call" || kind == "tool_call_update" {
        let name = u["title"].as_str().or(u["kind"].as_str()).filter(|s| !s.is_empty()).unwrap_or("未知工具");
        return Some(format!("本机 AI 尝试调用外部工具（{name}），PodDesk 已拦截；请重试或切换直连 API 模型"));
    }
    None
}

#[cfg(test)]
mod model_list_tests {
    use super::*;

    #[test]
    fn reads_codex_and_acp_listings() {
        let codex = json!({ "data": [{ "id": "a", "model": "gpt-x", "displayName": "GPT X" }, { "model": "old", "hidden": true }] });
        assert_eq!(parse_codex_models(&codex), vec![AgentModel { id: "gpt-x".into(), name: "GPT X".into() }]);
        let acp = json!({ "sessionId": "s", "models": { "currentModelId": "k3", "availableModels": [{ "modelId": "k3", "name": "Kimi K3" }] } });
        assert_eq!(parse_acp_models(&acp)[0].id, "k3");
        let cfg = json!({ "configOptions": [{ "id": "model", "options": [{ "group": "x", "options": [{ "value": "m1", "name": "M1" }] }, { "value": "m2" }] }] });
        assert_eq!(parse_acp_models(&cfg).iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), ["m1", "m2"]);
    }

    #[tokio::test]
    async fn pool_reserves_interactive_lane_and_cancels_cleanly() {
        let pool = Pool::new();
        let cancel_ok = AtomicBool::new(false);

        let (_r1, g1) = pool.acquire_slot(Kind::Codex, Priority::Background, &cancel_ok).await.unwrap();
        let (_r2, g2) = pool.acquire_slot(Kind::Codex, Priority::Background, &cancel_ok).await.unwrap();
        assert!(pool.try_acquire(Kind::Codex, Priority::Background).is_none());

        // Interactive request still gets dedicated headroom while background slots are full.
        let (_ri, gi) = pool.acquire_slot(Kind::Codex, Priority::Interactive, &cancel_ok).await.unwrap();
        assert_eq!(*pool.state.lock().unwrap().busy.get(&Kind::Codex).unwrap(), 3);

        // Cancelled waiter fails fast without leaking busy or waiting counts.
        let cancel_hit = Arc::new(AtomicBool::new(true));
        let err = pool
            .acquire_slot(Kind::Codex, Priority::Interactive, &cancel_hit)
            .await
            .err()
            .unwrap();
        assert!(err.to_string().contains("取消"));
        assert_eq!(*pool.state.lock().unwrap().waiting_interactive.get(&Kind::Codex).unwrap_or(&0), 0);

        drop(gi);
        drop(g2);
        drop(g1);
        assert_eq!(*pool.state.lock().unwrap().busy.get(&Kind::Codex).unwrap_or(&0), 0);
    }

    #[test]
    fn heartbeat_timeout_protects_active_thinking_and_fails_fast_when_silent() {
        let now = Instant::now();
        assert!(check_timeouts(now - Duration::from_secs(180), now - Duration::from_secs(5), Priority::Interactive).is_ok());
        assert!(check_timeouts(now - Duration::from_secs(70), now - Duration::from_secs(65), Priority::Background)
            .unwrap_err()
            .to_string()
            .contains("60"));
        assert!(check_timeouts(now - Duration::from_secs(70), now - Duration::from_secs(65), Priority::Interactive).is_ok());
        assert!(check_timeouts(now - Duration::from_secs(125), now - Duration::from_secs(125), Priority::Interactive)
            .unwrap_err()
            .to_string()
            .contains("120"));
        assert!(check_timeouts(now - Duration::from_secs(425), now - Duration::from_secs(1), Priority::Interactive)
            .unwrap_err()
            .to_string()
            .contains("7 分钟"));
    }

    #[test]
    fn rejects_acp_tool_calls_immediately() {
        assert!(check_acp_tool_update(&json!({ "sessionUpdate": "agent_message_chunk" })).is_none());
        let err = check_acp_tool_update(&json!({ "sessionUpdate": "tool_call", "title": "exa_web_search" })).unwrap();
        assert!(err.contains("exa_web_search"));
        assert!(check_acp_tool_update(&json!({ "sessionUpdate": "tool_call_update" })).is_some());
    }

    #[test]
    fn handles_agy_flags_models_and_error_lines() {
        let newer = "Usage: agy acp\n  --agent\n  --include-default-customizations\n  --disable-telemetry\n";
        assert_eq!(agy_flags(newer).unwrap(), ["--include-default-customizations=false", "--disable-telemetry"]);
        let older = "Usage: agy acp\n  --agent\n";
        assert!(agy_flags(older).unwrap().is_empty());
        assert!(agy_flags("").unwrap().is_empty());
        let before = "Usage of agy:\n  --model\n";
        assert!(friendly(Kind::Antigravity, agy_flags(before).unwrap_err()).to_string().contains("agy update"));

        let opts = json!([
            { "id": "model", "category": "model", "currentValue": "gemini-4-neon", "options": [
                { "value": "gemini-4-neon" },
                { "value": "gemini-3.8-flash" },
                { "value": "gpt-oss-120b-medium" }
            ] },
            { "id": "thought_level", "currentValue": "high", "options": [{ "value": "low" }, { "value": "high" }] }
        ]);
        assert!(!config_applied(&json!({ "configOptions": opts }), "model", "gemini-4-neon-high"));
        assert!(config_applied(&json!({ "configOptions": opts }), "model", "gemini-4-neon"));
        assert_eq!(split_leveled(&opts, "gemini-3.8-flash-medium"), Some(("gemini-3.8-flash".into(), "medium".into())));
        assert_eq!(split_leveled(&opts, "gpt-oss-120b-medium"), None);

        let quota = "部分内容\n\n⚠ Individual quota reached. Resets in 1h18m40s.\n";
        let line = agy_error_line(quota).unwrap();
        let msg = friendly(Kind::Antigravity, anyhow!("{line}")).to_string();
        assert!(msg.contains("1h18m40s"));
    }
}
