use std::path::PathBuf;
use std::sync::Arc;

use log::{info, warn};
use once_cell::sync::OnceCell;
use parking_lot::Mutex as ParkingMutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub mod llm_client;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizationConfig {
    pub enabled: bool,
    pub api_base_url: String,
    pub model: String,
    pub timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizationConfigView {
    pub enabled: bool,
    pub api_base_url: String,
    pub model: String,
    pub has_api_key: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizationConfigUpdate {
    pub enabled: bool,
    pub api_base_url: String,
    pub model: String,
}

#[derive(Debug, Clone, Copy)]
pub enum SummarizationErrorKind {
    Unconfigured,
    Transient,
    Auth,
    InvalidConfig,
    Provider,
}

impl SummarizationErrorKind {
    pub fn code(self) -> &'static str {
        match self {
            SummarizationErrorKind::Unconfigured => "SUMMARY_UNCONFIGURED",
            SummarizationErrorKind::Transient => "SUMMARY_TRANSIENT",
            SummarizationErrorKind::Auth => "SUMMARY_AUTH",
            SummarizationErrorKind::InvalidConfig => "SUMMARY_INVALID_CONFIG",
            SummarizationErrorKind::Provider => "SUMMARY_PROVIDER",
        }
    }
}

static CONFIG: OnceCell<Arc<ParkingMutex<SummarizationConfig>>> = OnceCell::new();

fn env_bool(name: &str, default: bool) -> bool {
    std::env::var(name)
        .ok()
        .map(|v| {
            let n = v.trim().to_lowercase();
            matches!(n.as_str(), "1" | "true" | "yes" | "on")
        })
        .unwrap_or(default)
}

fn env_string(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(default)
}

fn env_api_key() -> Option<String> {
    env_string("LLM_SUMMARY_API_KEY").or_else(|| env_string("LLM_API_KEY"))
}

fn default_config() -> SummarizationConfig {
    SummarizationConfig {
        enabled: env_bool("LLM_SUMMARY_ENABLED", false),
        api_base_url: env_string("LLM_SUMMARY_API_BASE_URL")
            .or_else(|| env_string("LLM_API_BASE_URL"))
            .unwrap_or_else(|| "http://localhost:8317/v1".to_string()),
        model: env_string("LLM_SUMMARY_MODEL")
            .or_else(|| env_string("LLM_MODEL"))
            .unwrap_or_else(|| "gpt-4o-mini".to_string()),
        timeout_secs: env_u64("LLM_SUMMARY_TIMEOUT_SECS", 30),
    }
}

fn settings_path(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let mut dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create config dir: {e}"))?;
    dir.push("summarization-config.json");
    Ok(dir)
}

fn load_persisted_config(app_handle: &AppHandle) -> Option<SummarizationConfig> {
    let path = settings_path(app_handle).ok()?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<SummarizationConfig>(&raw).ok()
}

fn persist_config(app_handle: &AppHandle, config: &SummarizationConfig) -> Result<(), String> {
    let path = settings_path(app_handle)?;
    let data = serde_json::to_string_pretty(config)
        .map_err(|e| format!("Failed to serialize summarization config: {e}"))?;
    std::fs::write(path, data).map_err(|e| format!("Failed to persist summarization config: {e}"))
}

pub fn init(app_handle: &AppHandle) {
    let mut cfg = default_config();
    if let Some(persisted) = load_persisted_config(app_handle) {
        cfg = persisted;
    }
    // Ensure any legacy persisted apiKey field is removed from disk by
    // rewriting the config in the current schema.
    if let Err(err) = persist_config(app_handle, &cfg) {
        warn!("Failed to normalize persisted summarization config: {}", err);
    }
    let _ = CONFIG.set(Arc::new(ParkingMutex::new(cfg)));
}

fn config_handle() -> Result<Arc<ParkingMutex<SummarizationConfig>>, String> {
    CONFIG
        .get()
        .cloned()
        .ok_or_else(|| "Summarization config not initialized".to_string())
}

pub fn get_config_view() -> Result<SummarizationConfigView, String> {
    let config = config_handle()?;
    let guard = config.lock();
    Ok(SummarizationConfigView {
        enabled: guard.enabled,
        api_base_url: guard.api_base_url.clone(),
        model: guard.model.clone(),
        has_api_key: env_api_key().is_some(),
    })
}

pub fn set_config(app_handle: &AppHandle, update: SummarizationConfigUpdate) -> Result<SummarizationConfigView, String> {
    let config = config_handle()?;
    let mut guard = config.lock();

    guard.enabled = update.enabled;
    guard.api_base_url = update.api_base_url.trim().to_string();
    guard.model = update.model.trim().to_string();

    if guard.api_base_url.is_empty() {
        return Err("apiBaseUrl cannot be empty".to_string());
    }
    if guard.model.is_empty() {
        return Err("model cannot be empty".to_string());
    }

    persist_config(app_handle, &guard)?;

    Ok(SummarizationConfigView {
        enabled: guard.enabled,
        api_base_url: guard.api_base_url.clone(),
        model: guard.model.clone(),
        has_api_key: env_api_key().is_some(),
    })
}

fn normalize_transcript(input: &str) -> String {
    input
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn truncate_transcript(input: &str, max_chars: usize) -> String {
    if input.chars().count() <= max_chars {
        return input.to_string();
    }

    let head_chars = max_chars / 3;
    let tail_chars = max_chars - head_chars;
    let head: String = input.chars().take(head_chars).collect();
    let tail: String = input
        .chars()
        .rev()
        .take(tail_chars)
        .collect::<String>()
        .chars()
        .rev()
        .collect();

    format!(
        "{}\n\n[... middle omitted to fit context window ...]\n\n{}",
        head, tail
    )
}

fn map_err(kind: SummarizationErrorKind, detail: String) -> String {
    format!("{}: {}", kind.code(), detail)
}

pub async fn summarize_transcript(transcript: String, language: String) -> Result<String, String> {
    let config = config_handle()?;
    let cfg = config.lock().clone();

    if !cfg.enabled {
        return Err(map_err(
            SummarizationErrorKind::Unconfigured,
            "LLM summarization is disabled".to_string(),
        ));
    }

    let normalized = normalize_transcript(&transcript);
    if normalized.is_empty() {
        return Err(map_err(
            SummarizationErrorKind::InvalidConfig,
            "Transcript is empty".to_string(),
        ));
    }

    let prepared = truncate_transcript(&normalized, 12_000);

    info!("Summarization request started");
    let cfg_for_worker = cfg.clone();
    let prepared_for_worker = prepared.clone();
    let language_for_worker = language.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        llm_client::summarize(&cfg_for_worker, &prepared_for_worker, &language_for_worker)
    })
    .await
    .map_err(|err| {
        map_err(
            SummarizationErrorKind::Transient,
            format!("Summarization worker failed: {err}"),
        )
    })?;

    match result {
        Ok(summary) => {
            info!("Summarization request succeeded");
            Ok(summary)
        }
        Err((kind, detail)) => {
            warn!("Summarization request failed with {}", kind.code());
            Err(map_err(kind, detail))
        }
    }
}

pub async fn provider_smoke_check() -> Result<String, String> {
    let config = config_handle()?;
    let cfg = config.lock().clone();
    let cfg_for_worker = cfg.clone();
    tauri::async_runtime::spawn_blocking(move || llm_client::smoke_check(&cfg_for_worker))
        .await
        .map_err(|err| {
            map_err(
                SummarizationErrorKind::Transient,
                format!("Summarization smoke-check worker failed: {err}"),
            )
        })?
        .map_err(|(kind, detail)| map_err(kind, detail))?;
    Ok("Provider smoke check passed (/models + /chat/completions)".to_string())
}
