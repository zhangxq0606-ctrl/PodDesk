//! Three-tier local ASR model catalog, Silero VAD companion, and GGUF discovery/download.
use super::download;
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelBackend {
    Sensevoice,
    Qwen3,
}

impl ModelBackend {
    pub fn as_flag(self) -> &'static str {
        match self {
            Self::Sensevoice => "sensevoice",
            Self::Qwen3 => "qwen3",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelTier {
    Fast,
    Balanced,
    Accurate,
}

pub struct ModelSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub tier: ModelTier,
    pub backend: ModelBackend,
    pub repo: &'static str,
    pub file: &'static str,
    pub size_mb: u32,
    pub note: &'static str,
    pub license: &'static str,
    pub supports_context: bool,
}

pub const SENSEVOICE_MODEL_ID: &str = "sensevoice-small";
pub const QWEN3_06B_MODEL_ID: &str = "qwen3-0.6b";
pub const QWEN3_17B_MODEL_ID: &str = "qwen3-1.7b";

pub const MODELS: &[ModelSpec] = &[
    ModelSpec {
        id: SENSEVOICE_MODEL_ID,
        name: "SenseVoice-Small (Q8_0)",
        tier: ModelTier::Fast,
        backend: ModelBackend::Sensevoice,
        repo: "cstr/sensevoice-small-GGUF",
        file: "sensevoice-small-q8_0.gguf",
        size_mb: 240,
        note: "纯 CPU 轻薄本默认 · 体积小速度快，适合日常中英播客快速出稿",
        license: "FunASR Model License v1.1（按需在线下载，使用需保留 FunAudioLLM/SenseVoiceSmall 署名）",
        supports_context: false,
    },
    ModelSpec {
        id: QWEN3_06B_MODEL_ID,
        name: "Qwen3-ASR 0.6B (Q4_K)",
        tier: ModelTier::Balanced,
        backend: ModelBackend::Qwen3,
        repo: "cstr/qwen3-asr-0.6b-GGUF",
        file: "qwen3-asr-0.6b-q4_k.gguf",
        size_mb: 602,
        note: "GPU 均衡推荐 · 中英混说与标点更自然，支持 Show Notes 术语上下文与 30 语种/22 方言",
        license: "Apache-2.0",
        supports_context: true,
    },
    ModelSpec {
        id: QWEN3_17B_MODEL_ID,
        name: "Qwen3-ASR 1.7B (Q5_K)",
        tier: ModelTier::Accurate,
        backend: ModelBackend::Qwen3,
        repo: "cstr/qwen3-asr-1.7b-GGUF",
        file: "qwen3-asr-1.7b-q5_k.gguf",
        size_mb: 1664,
        note: "高配独显可选 · 复杂长对话、专业术语与口音识别最稳",
        license: "Apache-2.0",
        supports_context: true,
    },
];

pub const VAD_REPO: &str = "ggml-org/whisper-vad";
pub const VAD_FILE: &str = "ggml-silero-v6.2.0.bin";

pub fn normalize_model_id(id: &str) -> &str {
    match id.trim() {
        "qwen3-asr" | "qwen3" => QWEN3_06B_MODEL_ID,
        other => other,
    }
}

pub fn spec(id: &str) -> Option<&'static ModelSpec> {
    let norm = normalize_model_id(id);
    MODELS.iter().find(|m| m.id == norm)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: String,
    pub name: String,
    pub tier: ModelTier,
    pub backend: ModelBackend,
    pub file_name: String,
    pub size_mb: u32,
    pub note: String,
    pub license: String,
    pub supports_context: bool,
    pub installed: bool,
    pub recommended: bool,
    pub from: Option<String>,
}

#[derive(Clone, Debug)]
pub struct ResolvedModel {
    pub id: String,
    pub display_name: String,
    pub path: PathBuf,
    pub backend: ModelBackend,
    pub supports_context: bool,
}

pub fn models_dir(data: &Path) -> PathBuf {
    data.join("models")
}

pub fn vad_model_path(data: &Path) -> PathBuf {
    models_dir(data).join(VAD_FILE)
}

pub fn has_vad_model(data: &Path) -> bool {
    let p = vad_model_path(data);
    p.is_file() && std::fs::metadata(&p).is_ok_and(|m| m.len() > 100 * 1024)
}

pub async fn download_vad_model(
    data: &Path,
    cancel: &AtomicBool,
    mirror_first: bool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<PathBuf> {
    let dest = vad_model_path(data);
    if has_vad_model(data) {
        return Ok(dest);
    }
    let hosts = if mirror_first {
        ["hf-mirror.com", "huggingface.co"]
    } else {
        ["huggingface.co", "hf-mirror.com"]
    };
    let mut err = anyhow!("下载 Silero VAD 模型失败");
    for host in hosts {
        let url = format!("https://{host}/{VAD_REPO}/resolve/main/{VAD_FILE}");
        match download(&url, &dest, cancel, &mut progress).await {
            Ok(()) => return Ok(dest),
            Err(e) if cancel.load(Ordering::Relaxed) => return Err(e),
            Err(e) => err = e,
        }
    }
    Err(err)
}

pub fn is_supported_gguf(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    n.ends_with(".gguf")
        && !n.contains("imatrix")
        && (n.starts_with("qwen3-asr") || n.starts_with("sensevoice-small"))
}

fn infer_backend_from_name(name: &str) -> ModelBackend {
    if name.to_ascii_lowercase().starts_with("sensevoice") {
        ModelBackend::Sensevoice
    } else {
        ModelBackend::Qwen3
    }
}

pub fn list_models(data: &Path, recommended_id: &str) -> Vec<ModelInfo> {
    adopt_found(data);
    let dir = models_dir(data);
    let mut out: Vec<ModelInfo> = MODELS
        .iter()
        .map(|m| {
            let path = dir.join(m.file);
            ModelInfo {
                id: m.id.into(),
                name: m.name.into(),
                tier: m.tier,
                backend: m.backend,
                file_name: m.file.into(),
                size_mb: m.size_mb,
                note: m.note.into(),
                license: m.license.into(),
                supports_context: m.supports_context,
                installed: path.is_file(),
                recommended: m.id == recommended_id,
                from: linked_from(&path),
            }
        })
        .collect();

    for name in extra_supported_files(data) {
        let path = dir.join(&name);
        let size_mb = std::fs::metadata(&path).map(|m| (m.len() / 1_048_576) as u32).unwrap_or(0);
        let label = name.trim_end_matches(".gguf");
        let backend = infer_backend_from_name(&name);
        out.push(ModelInfo {
            id: format!("file:{name}"),
            name: format!("本机模型（{label}）"),
            tier: ModelTier::Balanced,
            backend,
            file_name: name.clone(),
            size_mb,
            note: "已从本机缓存自动发现的兼容 GGUF 模型".into(),
            license: if backend == ModelBackend::Sensevoice {
                "FunASR Model License v1.1".into()
            } else {
                "Apache-2.0".into()
            },
            supports_context: backend == ModelBackend::Qwen3,
            installed: path.is_file(),
            recommended: false,
            from: Some(linked_from(&path).unwrap_or_else(|| "本机".into())),
        });
    }
    out
}

pub fn resolve_model(data: &Path, id: Option<&str>, recommended_id: &str) -> Option<ResolvedModel> {
    if let Some(raw) = id.map(str::trim).filter(|s| !s.is_empty()) {
        if let Some(m) = spec(raw) {
            let p = models_dir(data).join(m.file);
            if p.is_file() {
                return Some(ResolvedModel {
                    id: m.id.into(),
                    display_name: m.name.into(),
                    path: p,
                    backend: m.backend,
                    supports_context: m.supports_context,
                });
            }
            if matches!(raw, "qwen3-asr" | "qwen3") {
                return first_installed_qwen(data);
            }
            return None;
        }
        if let Some(name) = raw.strip_prefix("file:") {
            if !name.contains('/') && !name.contains('\\') && !name.contains("..") && is_supported_gguf(name) {
                let p = models_dir(data).join(name);
                if p.is_file() {
                    let backend = infer_backend_from_name(name);
                    return Some(ResolvedModel {
                        id: raw.into(),
                        display_name: name.trim_end_matches(".gguf").into(),
                        path: p,
                        backend,
                        supports_context: backend == ModelBackend::Qwen3,
                    });
                }
            }
        }
        return None;
    }

    if let Some(m) = spec(recommended_id) {
        let p = models_dir(data).join(m.file);
        if p.is_file() {
            return Some(ResolvedModel {
                id: m.id.into(),
                display_name: m.name.into(),
                path: p,
                backend: m.backend,
                supports_context: m.supports_context,
            });
        }
    }
    first_installed_any(data, recommended_id)
}

fn first_installed_qwen(data: &Path) -> Option<ResolvedModel> {
    for m in MODELS.iter().filter(|m| m.backend == ModelBackend::Qwen3) {
        let p = models_dir(data).join(m.file);
        if p.is_file() {
            return Some(ResolvedModel {
                id: m.id.into(),
                display_name: m.name.into(),
                path: p,
                backend: m.backend,
                supports_context: m.supports_context,
            });
        }
    }
    for name in extra_supported_files(data) {
        if infer_backend_from_name(&name) == ModelBackend::Qwen3 {
            let p = models_dir(data).join(&name);
            if p.is_file() {
                return Some(ResolvedModel {
                    id: format!("file:{name}"),
                    display_name: name.trim_end_matches(".gguf").into(),
                    path: p,
                    backend: ModelBackend::Qwen3,
                    supports_context: true,
                });
            }
        }
    }
    None
}

fn first_installed_any(data: &Path, recommended_id: &str) -> Option<ResolvedModel> {
    list_models(data, recommended_id)
        .into_iter()
        .find(|m| m.installed)
        .and_then(|m| resolve_model(data, Some(&m.id), recommended_id))
}

fn linked_from(path: &Path) -> Option<String> {
    let target = std::fs::read_link(path).ok()?;
    let s = target.to_string_lossy();
    if s.contains("huggingface") {
        return Some("Hugging Face 缓存".into());
    }
    target.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().to_string())
}

fn extra_supported_files(data: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(models_dir(data))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| {
            let n = e.file_name().to_string_lossy().to_string();
            (is_supported_gguf(&n) && !MODELS.iter().any(|m| m.file == n) && e.path().is_file()).then_some(n)
        })
        .collect();
    v.sort();
    v
}

pub fn looks_like_gguf(path: &Path) -> bool {
    use std::io::Read;
    let Ok(meta) = std::fs::metadata(path) else { return false };
    if meta.len() < 100 * 1_048_576 {
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
            if (ft.is_file() || ft.is_symlink()) && is_supported_gguf(&name) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn three_tiers_exclude_imatrix_and_whisper() {
        assert_eq!(MODELS.len(), 3);
        for m in MODELS {
            assert!(!m.file.contains("imatrix"));
            assert!(!m.id.contains("whisper"));
            assert!(is_supported_gguf(m.file));
        }
        assert!(!is_supported_gguf("qwen3-asr-0.6b-q4_k-imatrix.gguf"));
        assert!(!is_supported_gguf("ggml-large-v3.bin"));
    }

    #[test]
    fn normalizes_legacy_model_ids() {
        assert_eq!(normalize_model_id("qwen3-asr"), QWEN3_06B_MODEL_ID);
        assert_eq!(normalize_model_id("qwen3"), QWEN3_06B_MODEL_ID);
        assert_eq!(normalize_model_id("sensevoice-small"), SENSEVOICE_MODEL_ID);
    }

    #[test]
    fn looks_like_gguf_accepts_240mb_sensevoice() {
        use std::io::{Seek, SeekFrom, Write};
        let dir = std::env::temp_dir().join(format!("pdesk-gguf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let small = dir.join("tiny.gguf");
        std::fs::write(&small, b"GGUF1234").unwrap();
        assert!(!looks_like_gguf(&small));

        let sv = dir.join("sensevoice-small-q8_0.gguf");
        let mut f = std::fs::File::create(&sv).unwrap();
        f.write_all(b"GGUF").unwrap();
        f.seek(SeekFrom::Start(120 * 1_048_576)).unwrap();
        f.write_all(&[0u8]).unwrap();
        drop(f);
        assert!(looks_like_gguf(&sv));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
