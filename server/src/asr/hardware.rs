//! Hardware detection, discrete GPU selection (`-dev`), CrispASR v0.8.55 variant management,
//! short-audio smoke-probe, and CPU/CPU-Legacy automatic fallback.
use super::catalog::{ModelBackend, QWEN3_06B_MODEL_ID, SENSEVOICE_MODEL_ID};
use super::media::synth_probe_wav;
use super::ytdlp::exe;
use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::Mutex;

pub const CRISPASR_VERSION: &str = "v0.8.55";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RuntimeVariant {
    Vulkan,
    Cuda13,
    Cpu,
    CpuLegacy,
}

impl RuntimeVariant {
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "vulkan" => Some(Self::Vulkan),
            "cuda13" | "cuda" => Some(Self::Cuda13),
            "cpu" => Some(Self::Cpu),
            "cpu-legacy" | "legacy" => Some(Self::CpuLegacy),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Vulkan => "vulkan",
            Self::Cuda13 => "cuda13",
            Self::Cpu => "cpu",
            Self::CpuLegacy => "cpu-legacy",
        }
    }

    pub fn label(self) -> &'static str {
        // On Apple Silicon the only macOS/arm64 build is compiled with Metal + BLAS,
        // so the generic "CPU (AVX2)" wording would be misleading there.
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            return match self {
                Self::Vulkan => "Vulkan GPU",
                Self::Cuda13 => "NVIDIA CUDA 13",
                Self::Cpu => "Apple Silicon (Metal)",
                Self::CpuLegacy => "CPU Legacy",
            };
        }
        #[allow(unreachable_code)]
        match self {
            Self::Vulkan => "Vulkan GPU",
            Self::Cuda13 => "NVIDIA CUDA 13",
            Self::Cpu => "CPU (AVX2)",
            Self::CpuLegacy => "CPU Legacy",
        }
    }

    pub fn is_gpu(self) -> bool {
        matches!(self, Self::Vulkan | Self::Cuda13)
    }

    pub fn approx_mb(self) -> u32 {
        match self {
            Self::Vulkan => 36,
            Self::Cuda13 => 544,
            Self::Cpu => 9,
            Self::CpuLegacy => 9,
        }
    }

    pub fn asset_name(self) -> Option<&'static str> {
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        {
            return Some(match self {
                Self::Vulkan => "crispasr-windows-x86_64-vulkan.zip",
                Self::Cuda13 => "crispasr-windows-x86_64-cuda13.zip",
                Self::Cpu => "crispasr-windows-x86_64-cpu.zip",
                Self::CpuLegacy => "crispasr-windows-x86_64-cpu-legacy.zip",
            });
        }
        #[cfg(all(target_os = "windows", target_arch = "aarch64"))]
        {
            let _ = self;
            return None;
        }
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        {
            let _ = self;
            return Some("crispasr-macos-arm64.tar.gz");
        }
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        {
            return Some(match self {
                Self::CpuLegacy => "crispasr-macos-x86_64-cpu-legacy.tar.gz",
                _ => "crispasr-macos-x86_64.tar.gz",
            });
        }
        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        {
            let _ = self;
            return Some("crispasr-linux-arm64.tar.gz");
        }
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        {
            return Some(match self {
                Self::Vulkan => "crispasr-linux-x86_64-vulkan.tar.gz",
                Self::Cuda13 => "crispasr-linux-x86_64-cuda13.tar.gz",
                Self::CpuLegacy => "crispasr-linux-x86_64-cpu-legacy.tar.gz",
                Self::Cpu => "crispasr-linux-x86_64.tar.gz",
            });
        }
        #[allow(unreachable_code)]
        None
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub name: String,
    pub vendor: String,
    pub vram_mb: Option<u64>,
    pub discrete: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HardwareProfile {
    pub os: String,
    pub arch: String,
    pub avx2: bool,
    pub windows_arm64: bool,
    pub gpus: Vec<GpuInfo>,
    pub has_discrete_gpu: bool,
    pub has_nvidia: bool,
    pub recommended_variant: Option<RuntimeVariant>,
    pub recommended_model: String,
    pub summary: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeState {
    pub version: String,
    pub active_variant: Option<RuntimeVariant>,
    pub preferred_variant: Option<RuntimeVariant>,
    pub device_index: Option<u32>,
    pub gpu_name: Option<String>,
    pub verified: bool,
    pub fallback_reason: Option<String>,
    pub verified_at: Option<i64>,
}

static HW_CACHE: once_cell::sync::Lazy<Mutex<Option<HardwareProfile>>> =
    once_cell::sync::Lazy::new(|| Mutex::new(None));

pub fn cpu_supports_avx2() -> bool {
    #[cfg(any(target_arch = "x86", target_arch = "x86_64"))]
    {
        return std::is_x86_feature_detected!("avx2");
    }
    #[allow(unreachable_code)]
    false
}

fn apple_chip_name() -> Option<String> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let out = std::process::Command::new("/usr/sbin/sysctl")
            .args(["-n", "machdep.cpu.brand_string"])
            .output()
            .ok()?;
        let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if out.status.success() && !name.is_empty() {
            return Some(name);
        }
        return None;
    }
    #[allow(unreachable_code)]
    None
}

pub fn cpu_fallback_variant(avx2: bool) -> RuntimeVariant {
    if avx2 {
        RuntimeVariant::Cpu
    } else {
        RuntimeVariant::CpuLegacy
    }
}

fn is_virtual_display(name: &str, pnp: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let p = pnp.to_ascii_uppercase();
    p.starts_with("ROOT\\")
        || [
            "virtual",
            "microsoft basic",
            "remote",
            "citrix",
            "vmware",
            "gameviewer",
            "parsec",
            "idd",
            "luminon",
            "oray",
            "todesk",
            "sunlogin",
        ]
        .iter()
        .any(|k| n.contains(k))
}

fn classify_vendor(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n.contains("nvidia") || n.contains("geforce") || n.contains("rtx") || n.contains("gtx") || n.contains("quadro") {
        "nvidia"
    } else if n.contains("amd") || n.contains("radeon") {
        "amd"
    } else if n.contains("intel") {
        "intel"
    } else {
        "other"
    }
}

fn is_discrete_gpu(name: &str, vendor: &str, vram_mb: Option<u64>) -> bool {
    let n = name.to_ascii_lowercase();
    match vendor {
        "nvidia" => true,
        "intel" => n.contains("arc"),
        "amd" => {
            if n.contains("radeon(tm) graphics") || (n.contains("vega") && vram_mb.unwrap_or(0) <= 2048) {
                false
            } else {
                vram_mb.unwrap_or(0) >= 3072
                    || n.contains("rx ")
                    || n.contains("xt")
                    || n.contains("pro ")
            }
        }
        _ => false,
    }
}

pub fn parse_windows_gpus(cim_json: &str, nvsmi_out: Option<&str>) -> Vec<GpuInfo> {
    let mut nvidia_vram: Vec<(String, Option<u64>)> = Vec::new();
    if let Some(raw) = nvsmi_out {
        for line in raw.lines() {
            let parts: Vec<&str> = line.split(',').map(str::trim).collect();
            if let Some(name) = parts.first().filter(|s| !s.is_empty()) {
                let vram = parts.get(1).and_then(|v| v.parse::<u64>().ok());
                nvidia_vram.push((name.to_string(), vram));
            }
        }
    }

    let mut out: Vec<GpuInfo> = Vec::new();
    if let Ok(v) = serde_json::from_str::<serde_json::Value>(cim_json.trim()) {
        let items: Vec<&serde_json::Value> = match &v {
            serde_json::Value::Array(a) => a.iter().collect(),
            serde_json::Value::Object(_) => vec![&v],
            _ => vec![],
        };
        for item in items {
            let name = item["Name"].as_str().unwrap_or("").trim().to_string();
            let pnp = item["PNPDeviceID"].as_str().unwrap_or("");
            if name.is_empty() || is_virtual_display(&name, pnp) {
                continue;
            }
            let vendor = classify_vendor(&name).to_string();
            let raw_mb = item["AdapterRAM"].as_u64().map(|b| b / (1024 * 1024)).filter(|&m| m > 0);
            let vram_mb = if vendor == "nvidia" {
                nvidia_vram
                    .iter()
                    .find(|(nv, _)| nv.eq_ignore_ascii_case(&name) || name.contains(nv) || nv.contains(&name))
                    .and_then(|(_, m)| *m)
                    .or(raw_mb)
            } else {
                raw_mb
            };
            let discrete = is_discrete_gpu(&name, &vendor, vram_mb);
            out.push(GpuInfo { name, vendor, vram_mb, discrete });
        }
    }

    for (nv_name, nv_mb) in nvidia_vram {
        if !out.iter().any(|g| g.name.eq_ignore_ascii_case(&nv_name)) {
            out.push(GpuInfo {
                name: nv_name,
                vendor: "nvidia".into(),
                vram_mb: nv_mb,
                discrete: true,
            });
        }
    }

    out.sort_by_key(|g| (!g.discrete, g.vendor != "nvidia"));
    out
}

pub fn recommend_defaults(
    os: &str,
    arch: &str,
    avx2: bool,
    gpus: &[GpuInfo],
) -> (Option<RuntimeVariant>, String) {
    if os == "windows" && arch == "aarch64" {
        return (None, SENSEVOICE_MODEL_ID.to_string());
    }
    if os == "macos" && arch == "aarch64" {
        return (Some(RuntimeVariant::Cpu), QWEN3_06B_MODEL_ID.to_string());
    }
    let has_discrete = gpus.iter().any(|g| g.discrete);
    if has_discrete {
        (Some(RuntimeVariant::Vulkan), QWEN3_06B_MODEL_ID.to_string())
    } else {
        (Some(cpu_fallback_variant(avx2)), SENSEVOICE_MODEL_ID.to_string())
    }
}

fn probe_windows_hardware() -> Vec<GpuInfo> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        let nvsmi = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=name,memory.total", "--format=csv,noheader,nounits"])
            .creation_flags(0x08000000)
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string());

        let cim = std::process::Command::new("pwsh")
            .args([
                "-NoProfile",
                "-Command",
                "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,PNPDeviceID | ConvertTo-Json -Compress",
            ])
            .creation_flags(0x08000000)
            .output()
            .or_else(|_| {
                std::process::Command::new("powershell")
                    .args([
                        "-NoProfile",
                        "-Command",
                        "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,PNPDeviceID | ConvertTo-Json -Compress",
                    ])
                    .creation_flags(0x08000000)
                    .output()
            })
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();

        return parse_windows_gpus(&cim, nvsmi.as_deref());
    }
    #[allow(unreachable_code)]
    Vec::new()
}

pub fn detect_hardware(force: bool) -> HardwareProfile {
    if !force {
        if let Some(cached) = HW_CACHE.lock().unwrap().clone() {
            return cached;
        }
    }
    let os = std::env::consts::OS.to_string();
    let arch = std::env::consts::ARCH.to_string();
    let avx2 = cpu_supports_avx2();
    let windows_arm64 = os == "windows" && arch == "aarch64";
    let gpus = if os == "windows" && !windows_arm64 {
        probe_windows_hardware()
    } else {
        Vec::new()
    };
    let has_discrete_gpu = gpus.iter().any(|g| g.discrete);
    let has_nvidia = gpus.iter().any(|g| g.vendor == "nvidia");
    let (recommended_variant, recommended_model) = recommend_defaults(&os, &arch, avx2, &gpus);

    let summary = if windows_arm64 {
        "Windows ARM64 · 首版建议使用云端 ASR".to_string()
    } else if let Some(dgpu) = gpus.iter().find(|g| g.discrete) {
        if let Some(mb) = dgpu.vram_mb {
            format!("{} ({:.1} GB 显存)", dgpu.name, mb as f64 / 1024.0)
        } else {
            dgpu.name.clone()
        }
    } else if let Some(igpu) = gpus.first() {
        format!("{} · 纯 CPU/{}", igpu.name, if avx2 { "AVX2" } else { "Legacy" })
    } else if os == "macos" && arch == "aarch64" {
        // The macOS arm64 CrispASR build ships the embedded Metal library and
        // picks Metal automatically (`--gpu-backend auto`); AVX2 does not apply on ARM.
        match apple_chip_name() {
            Some(chip) => format!("{chip} · Metal 加速（{arch}）"),
            None => format!("Apple Silicon · Metal 加速（{arch}）"),
        }
    } else {
        format!("{os}/{arch} · {}", if avx2 { "AVX2 CPU" } else { "Legacy CPU" })
    };

    let profile = HardwareProfile {
        os,
        arch,
        avx2,
        windows_arm64,
        gpus,
        has_discrete_gpu,
        has_nvidia,
        recommended_variant,
        recommended_model,
        summary,
    };
    *HW_CACHE.lock().unwrap() = Some(profile.clone());
    profile
}

// ---- Variant binary directories & persisted runtime state --------------------------------------

pub fn variant_dir(data: &Path, variant: RuntimeVariant) -> PathBuf {
    data.join("bin").join(format!("crispasr-{CRISPASR_VERSION}-{}", variant.as_str()))
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

pub fn find_crispasr_variant(data: &Path, variant: RuntimeVariant) -> Option<PathBuf> {
    find_file(&variant_dir(data, variant), &exe("crispasr"))
}

pub fn installed_variants(data: &Path) -> Vec<RuntimeVariant> {
    [
        RuntimeVariant::Vulkan,
        RuntimeVariant::Cuda13,
        RuntimeVariant::Cpu,
        RuntimeVariant::CpuLegacy,
    ]
    .into_iter()
    .filter(|&v| find_crispasr_variant(data, v).is_some())
    .collect()
}

pub fn find_any_crispasr(data: &Path) -> Option<(RuntimeVariant, PathBuf)> {
    let state = load_runtime_state(data);
    if let Some(v) = state.active_variant {
        if let Some(p) = find_crispasr_variant(data, v) {
            return Some((v, p));
        }
    }
    for v in [
        RuntimeVariant::Vulkan,
        RuntimeVariant::Cuda13,
        RuntimeVariant::Cpu,
        RuntimeVariant::CpuLegacy,
    ] {
        if let Some(p) = find_crispasr_variant(data, v) {
            return Some((v, p));
        }
    }
    None
}

pub fn runtime_state_path(data: &Path) -> PathBuf {
    data.join("asr-runtime.json")
}

pub fn load_runtime_state(data: &Path) -> RuntimeState {
    let path = runtime_state_path(data);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return RuntimeState::default();
    };
    let Ok(st) = serde_json::from_str::<RuntimeState>(&raw) else {
        return RuntimeState::default();
    };
    if st.version != CRISPASR_VERSION {
        return RuntimeState::default();
    }
    st
}

pub fn save_runtime_state(data: &Path, state: &RuntimeState) -> Result<()> {
    std::fs::create_dir_all(data)?;
    let mut s = state.clone();
    s.version = CRISPASR_VERSION.to_string();
    std::fs::write(runtime_state_path(data), serde_json::to_string_pretty(&s)?)?;
    Ok(())
}

pub async fn install_crispasr_variant(
    data: &Path,
    variant: RuntimeVariant,
    cancel: &AtomicBool,
    progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    if let Some(existing) = find_crispasr_variant(data, variant) {
        return Ok(existing);
    }
    let asset = variant
        .asset_name()
        .ok_or_else(|| anyhow!("当前平台暂不支持离线 CrispASR（建议改用云端 ASR）"))?;
    let archive = data.join("bin").join(format!("{variant_prefix}-{asset}", variant_prefix = variant.as_str()));
    let orig_url = format!("https://github.com/CrispStrobe/CrispASR/releases/download/{CRISPASR_VERSION}/{asset}");
    let urls = crate::net::github_release_urls(&orig_url);
    super::download_from_candidates(&urls, &archive, cancel, progress).await?;
    let dest = variant_dir(data, variant);
    let (a, d) = (archive.clone(), dest.clone());
    let extract_res = tokio::task::spawn_blocking(move || -> Result<()> {
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
    .await;
    let _ = std::fs::remove_file(&archive);
    extract_res??;
    let bin = find_crispasr_variant(data, variant)
        .ok_or_else(|| anyhow!("CrispASR（{}）解压后未找到可执行文件", variant.label()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(bin)
}

// ---- Device discovery & smoke-probe --------------------------------------------------------------

pub fn parse_crispasr_devices(stderr: &str) -> Vec<(u32, String)> {
    let re_eq = regex::Regex::new(r"(?i)(?:ggml_vulkan|ggml_cuda|cuda|vulkan|device)\s*:?\s*(\d+)\s*=\s*(.+)$").unwrap();
    let re_dev = regex::Regex::new(r"(?i)^Device\s+(\d+)\s*:\s*(.+)$").unwrap();
    let mut out: Vec<(u32, String)> = Vec::new();
    for raw in stderr.lines() {
        let line = raw.trim();
        let cap = re_eq.captures(line).or_else(|| re_dev.captures(line));
        if let Some(c) = cap {
            if let Ok(idx) = c[1].parse::<u32>() {
                let raw_name = c[2].split('|').next().unwrap_or(&c[2]);
                let name = raw_name.trim().trim_end_matches(',').to_string();
                if !name.is_empty() && !out.iter().any(|(i, _)| *i == idx) {
                    out.push((idx, name));
                }
            }
        }
    }
    out
}

pub fn pick_preferred_device(devices: &[(u32, String)]) -> Option<(u32, String)> {
    fn score(name: &str) -> i32 {
        let n = name.to_ascii_lowercase();
        if n.contains("llvmpipe") || n.contains("microsoft basic") || n.contains("swiftshader") {
            return -10;
        }
        if n.contains("nvidia") || n.contains("geforce") || n.contains("rtx") || n.contains("gtx") || n.contains("quadro") {
            return 100;
        }
        if n.contains("intel") && n.contains("arc") {
            return 80;
        }
        if (n.contains("amd") || n.contains("radeon")) && !n.contains("radeon(tm) graphics") {
            return 75;
        }
        if n.contains("intel") || n.contains("uhd") || n.contains("iris") {
            return 20;
        }
        40
    }
    devices
        .iter()
        .max_by_key(|(idx, name)| (score(name), std::cmp::Reverse(*idx)))
        .cloned()
}

async fn run_smoke_once(
    bin: &Path,
    variant: RuntimeVariant,
    model_path: &Path,
    backend: ModelBackend,
    wav_path: &Path,
    out_prefix: &Path,
    device_index: Option<u32>,
) -> std::result::Result<String, String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["-v", "--backend", backend.as_flag()])
        .arg("-m")
        .arg(model_path)
        .arg("-f")
        .arg(wav_path)
        .args(["-oj", "-np", "-t", "4"])
        .arg("-of")
        .arg(out_prefix);
    match variant {
        RuntimeVariant::Vulkan => {
            cmd.args(["--gpu-backend", "vulkan"]);
            if let Some(dev) = device_index {
                cmd.args(["-dev", &dev.to_string()]);
            }
        }
        RuntimeVariant::Cuda13 => {
            cmd.args(["--gpu-backend", "cuda"]);
            if let Some(dev) = device_index {
                cmd.args(["-dev", &dev.to_string()]);
            }
        }
        RuntimeVariant::Cpu | RuntimeVariant::CpuLegacy => {}
    }
    cmd.kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }

    let out = tokio::time::timeout(std::time::Duration::from_secs(45), cmd.output())
        .await
        .map_err(|_| "试跑超时（>45 秒）".to_string())?
        .map_err(|e| format!("无法启动进程：{e}"))?;

    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let combined = format!("{stderr}\n{stdout}");
    let json_path = out_prefix.with_extension("json");
    if !out.status.success() || !json_path.is_file() {
        let code = out.status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into());
        let tail = stderr
            .lines()
            .rev()
            .find(|l| !l.trim().is_empty())
            .or_else(|| stdout.lines().rev().find(|l| !l.trim().is_empty()))
            .unwrap_or("无输出")
            .chars()
            .take(180)
            .collect::<String>();
        return Err(format!("退出码 {code}：{tail}"));
    }
    let _ = std::fs::remove_file(&json_path);
    Ok(combined)
}

async fn check_version_only(bin: &Path) -> Result<()> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("--version").kill_on_drop(true);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = tokio::time::timeout(std::time::Duration::from_secs(15), cmd.output())
        .await
        .map_err(|_| anyhow!("CrispASR 启动超时"))?
        .context("无法启动 CrispASR")?;
    if !out.status.success() {
        return Err(anyhow!("CrispASR --version 返回异常"));
    }
    Ok(())
}

pub async fn probe_and_verify(
    data: &Path,
    target: RuntimeVariant,
    requested_dev: Option<u32>,
    model: Option<(&Path, ModelBackend)>,
    hw: &HardwareProfile,
    cancel: &AtomicBool,
    mut on_fallback_download: impl FnMut(&str, u64, Option<u64>),
) -> Result<RuntimeState> {
    let bin = find_crispasr_variant(data, target)
        .ok_or_else(|| anyhow!("尚未安装 CrispASR {}", target.label()))?;

    let Some((model_path, backend)) = model else {
        check_version_only(&bin).await?;
        let st = RuntimeState {
            version: CRISPASR_VERSION.into(),
            active_variant: Some(target),
            preferred_variant: Some(target),
            device_index: requested_dev,
            gpu_name: None,
            verified: false,
            fallback_reason: None,
            verified_at: Some(chrono::Utc::now().timestamp()),
        };
        save_runtime_state(data, &st)?;
        return Ok(st);
    };

    let probe_dir = data.join("tmp").join(format!("probe-{}", uuid::Uuid::new_v4()));
    tokio::fs::create_dir_all(&probe_dir).await?;
    let wav_path = probe_dir.join("probe.wav");
    let wp = wav_path.clone();
    tokio::task::spawn_blocking(move || synth_probe_wav(&wp)).await??;

    let result = async {
        let out_first = probe_dir.join("out0");
        match run_smoke_once(&bin, target, model_path, backend, &wav_path, &out_first, requested_dev).await {
            Ok(logs) => {
                let devices = parse_crispasr_devices(&logs);
                let picked = if target.is_gpu() && requested_dev.is_none() {
                    pick_preferred_device(&devices)
                } else if let Some(idx) = requested_dev {
                    devices
                        .iter()
                        .find(|(i, _)| *i == idx)
                        .cloned()
                        .or(Some((idx, hw.gpus.first().map(|g| g.name.clone()).unwrap_or_default())))
                } else {
                    None
                };

                // If a discrete GPU sits at another `-dev` index (e.g. -dev 1 instead of default 0), re-verify with `-dev`.
                if let Some((best_idx, ref best_name)) = picked {
                    if requested_dev.is_none() && best_idx != 0 {
                        let out_pinned = probe_dir.join("out1");
                        if run_smoke_once(&bin, target, model_path, backend, &wav_path, &out_pinned, Some(best_idx))
                            .await
                            .is_ok()
                        {
                            let st = RuntimeState {
                                version: CRISPASR_VERSION.into(),
                                active_variant: Some(target),
                                preferred_variant: Some(target),
                                device_index: Some(best_idx),
                                gpu_name: Some(best_name.clone()),
                                verified: true,
                                fallback_reason: None,
                                verified_at: Some(chrono::Utc::now().timestamp()),
                            };
                            save_runtime_state(data, &st)?;
                            return Ok(st);
                        }
                    }
                }

                let gpu_name = picked
                    .as_ref()
                    .map(|(_, n)| n.clone())
                    .filter(|n| !n.is_empty())
                    .or_else(|| {
                        if target.is_gpu() {
                            hw.gpus.iter().find(|g| g.discrete).or(hw.gpus.first()).map(|g| g.name.clone())
                        } else {
                            None
                        }
                    });
                let st = RuntimeState {
                    version: CRISPASR_VERSION.into(),
                    active_variant: Some(target),
                    preferred_variant: Some(target),
                    device_index: picked.map(|(i, _)| i),
                    gpu_name,
                    verified: true,
                    fallback_reason: None,
                    verified_at: Some(chrono::Utc::now().timestamp()),
                };
                save_runtime_state(data, &st)?;
                Ok(st)
            }
            Err(gpu_err) if target.is_gpu() => {
                let cpu_var = cpu_fallback_variant(hw.avx2);
                let reason = format!("{} 试跑失败（{gpu_err}），已自动回退至 {}", target.label(), cpu_var.label());
                let cpu_bin = if let Some(p) = find_crispasr_variant(data, cpu_var) {
                    p
                } else {
                    install_crispasr_variant(data, cpu_var, cancel, |rec, tot| {
                        on_fallback_download(cpu_var.label(), rec, tot);
                    })
                    .await?
                };
                let out_cpu = probe_dir.join("out_cpu");
                run_smoke_once(&cpu_bin, cpu_var, model_path, backend, &wav_path, &out_cpu, None)
                    .await
                    .map_err(|cpu_err| anyhow!("{reason}；CPU 兜底也失败：{cpu_err}"))?;
                let st = RuntimeState {
                    version: CRISPASR_VERSION.into(),
                    active_variant: Some(cpu_var),
                    preferred_variant: Some(target),
                    device_index: None,
                    gpu_name: None,
                    verified: true,
                    fallback_reason: Some(reason),
                    verified_at: Some(chrono::Utc::now().timestamp()),
                };
                save_runtime_state(data, &st)?;
                Ok(st)
            }
            Err(err) => Err(anyhow!("{} 试跑失败：{err}", target.label())),
        }
    }
    .await;

    let _ = tokio::fs::remove_dir_all(&probe_dir).await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn filters_virtual_adapters_and_merges_nvidia_vram() {
        let cim = r#"[
            {"Name":"GameViewer Virtual Display Adapter","AdapterRAM":null,"PNPDeviceID":"ROOT\\DISPLAY\\0000"},
            {"Name":"NVIDIA GeForce RTX 5070 Ti Laptop GPU","AdapterRAM":4293918720,"PNPDeviceID":"PCI\\VEN_10DE&DEV_2F18"},
            {"Name":"Intel(R) Graphics","AdapterRAM":2147479552,"PNPDeviceID":"PCI\\VEN_8086&DEV_7D67"}
        ]"#;
        let nvsmi = "NVIDIA GeForce RTX 5070 Ti Laptop GPU, 12227";
        let gpus = parse_windows_gpus(cim, Some(nvsmi));
        assert_eq!(gpus.len(), 2);
        assert_eq!(gpus[0].name, "NVIDIA GeForce RTX 5070 Ti Laptop GPU");
        assert!(gpus[0].discrete);
        assert_eq!(gpus[0].vram_mb, Some(12227));
        assert_eq!(gpus[1].name, "Intel(R) Graphics");
        assert!(!gpus[1].discrete);
    }

    #[test]
    fn parses_crispasr_devices_and_prefers_discrete_gpu() {
        let stderr = "\
ggml_vulkan: Found 2 Vulkan devices:
ggml_vulkan: 0 = Intel(R) Graphics (Intel Corporation) | uma: 1
ggml_vulkan: 1 = NVIDIA GeForce RTX 5070 Ti Laptop GPU (NVIDIA) | uma: 0
";
        let devs = parse_crispasr_devices(stderr);
        assert_eq!(devs.len(), 2);
        let best = pick_preferred_device(&devs).unwrap();
        assert_eq!(best.0, 1);
        assert!(best.1.contains("RTX 5070 Ti"));
    }

    #[test]
    fn recommends_metal_engine_on_apple_silicon() {
        let (v, m) = recommend_defaults("macos", "aarch64", false, &[]);
        assert_eq!(v, Some(RuntimeVariant::Cpu));
        assert_eq!(m, QWEN3_06B_MODEL_ID);
    }

    #[test]
    fn recommends_cpu_sensevoice_when_no_discrete_gpu() {
        let igpu = vec![GpuInfo {
            name: "Intel(R) UHD Graphics".into(),
            vendor: "intel".into(),
            vram_mb: Some(1024),
            discrete: false,
        }];
        let (v, m) = recommend_defaults("windows", "x86_64", true, &igpu);
        assert_eq!(v, Some(RuntimeVariant::Cpu));
        assert_eq!(m, SENSEVOICE_MODEL_ID);

        let (v_leg, m_leg) = recommend_defaults("windows", "x86_64", false, &[]);
        assert_eq!(v_leg, Some(RuntimeVariant::CpuLegacy));
        assert_eq!(m_leg, SENSEVOICE_MODEL_ID);

        let (v_arm, _) = recommend_defaults("windows", "aarch64", false, &[]);
        assert_eq!(v_arm, None);
    }
}
