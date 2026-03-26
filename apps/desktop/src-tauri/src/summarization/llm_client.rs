use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::{json, Value};

use super::{SummarizationConfig, SummarizationErrorKind};

fn env_api_key() -> Option<String> {
    std::env::var("LLM_SUMMARY_API_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .or_else(|| {
            std::env::var("LLM_API_KEY")
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        })
}

fn parse_content(value: &Value) -> Option<String> {
    value
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(|v| v.trim().to_string())
}

fn parse_error_text(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|error| {
            error
                .get("message")
                .and_then(Value::as_str)
                .or_else(|| error.as_str())
        })
        .map(|v| v.to_string())
        .or_else(|| value.get("message").and_then(Value::as_str).map(|v| v.to_string()))
}

fn classify_http_error(status: u16, detail: &str) -> SummarizationErrorKind {
    match status {
        401 | 403 => SummarizationErrorKind::Auth,
        404 | 422 => SummarizationErrorKind::InvalidConfig,
        408 | 429 | 500 | 502 | 503 | 504 => SummarizationErrorKind::Transient,
        _ => {
            let lowered = detail.to_lowercase();
            if lowered.contains("api key") || lowered.contains("unauthorized") {
                SummarizationErrorKind::Auth
            } else if lowered.contains("model") || lowered.contains("not found") {
                SummarizationErrorKind::InvalidConfig
            } else {
                SummarizationErrorKind::Provider
            }
        }
    }
}

pub fn summarize(config: &SummarizationConfig, transcript: &str, language: &str) -> Result<String, (SummarizationErrorKind, String)> {
    let api_key = env_api_key()
        .ok_or((SummarizationErrorKind::Unconfigured, "Missing API key".to_string()))?;

    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs.max(5)))
        .build()
        .map_err(|e| (SummarizationErrorKind::Transient, format!("Failed to build HTTP client: {e}")))?;

    let url = format!("{}/chat/completions", config.api_base_url.trim_end_matches('/'));

    let system_prompt = "You summarize spoken conversations. Return concise markdown with sections: Summary, Key Points, Action Items. Keep factual and avoid fabrication.";
    let user_prompt = format!(
        "Language hint: {language}\n\nTranscript:\n{transcript}"
    );

    let payload = json!({
        "model": config.model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ]
    });

    let response = client
        .post(url)
        .bearer_auth(&api_key)
        .json(&payload)
        .send()
        .map_err(|e| (SummarizationErrorKind::Transient, format!("Request failed: {e}")))?;

    let status = response.status();
    let status_code = status.as_u16();
    let body = response
        .text()
        .map_err(|e| (SummarizationErrorKind::Transient, format!("Failed to read response body: {e}")))?;

    let value: Value = serde_json::from_str(&body)
        .map_err(|e| (SummarizationErrorKind::Provider, format!("Invalid JSON response: {e}")))?;

    if !status.is_success() {
        let detail = parse_error_text(&value).unwrap_or_else(|| "Unknown provider error".to_string());
        return Err((classify_http_error(status_code, &detail), format!("HTTP {}: {}", status_code, detail)));
    }

    let content = parse_content(&value)
        .filter(|v| !v.is_empty())
        .ok_or((SummarizationErrorKind::Provider, "Missing choices[0].message.content".to_string()))?;

    Ok(content)
}

pub fn smoke_check(config: &SummarizationConfig) -> Result<(), (SummarizationErrorKind, String)> {
    let api_key = env_api_key()
        .ok_or((SummarizationErrorKind::Unconfigured, "Missing API key".to_string()))?;

    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs.max(5)))
        .build()
        .map_err(|e| (SummarizationErrorKind::Transient, format!("Failed to build HTTP client: {e}")))?;

    let models_url = format!("{}/models", config.api_base_url.trim_end_matches('/'));
    let models_res = client
        .get(models_url)
        .bearer_auth(&api_key)
        .send()
        .map_err(|e| (SummarizationErrorKind::Transient, format!("GET /models failed: {e}")))?;
    if !models_res.status().is_success() {
        return Err((SummarizationErrorKind::Provider, format!("GET /models returned {}", models_res.status().as_u16())));
    }

    let _ = summarize(config, "Speaker A: hello\nSpeaker B: hi", "en")?;
    Ok(())
}
