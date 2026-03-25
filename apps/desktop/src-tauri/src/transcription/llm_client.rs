use std::time::Duration;

use hound::{SampleFormat, WavSpec, WavWriter};
use reqwest::blocking::{multipart, Client};
use serde_json::Value;

const DEFAULT_LLM_API_BASE_URL: &str = "http://localhost:8317/v1";
const DEFAULT_LLM_TIMEOUT_SECS: u64 = 45;

fn llm_api_base_url() -> String {
    std::env::var("LLM_API_BASE_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_LLM_API_BASE_URL.to_string())
}

fn llm_api_key() -> Option<String> {
    std::env::var("LLM_API_KEY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn llm_transcription_model() -> Result<String, String> {
    std::env::var("LLM_TRANSCRIPTION_MODEL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| {
            "LLM_TRANSCRIPTION_MODEL is not set. Configure it in .env or src-tauri/.env"
                .to_string()
        })
}

fn pcm_f32_to_wav_bytes(audio_16k_f32: &[f32]) -> Result<Vec<u8>, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate: 16_000,
        bits_per_sample: 16,
        sample_format: SampleFormat::Int,
    };

    let mut path = std::env::temp_dir();
    let unique = format!(
        "llm-transcription-{}-{}.wav",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| format!("Failed to generate temp wav timestamp: {e}"))?
            .as_nanos()
    );
    path.push(unique);

    let mut writer = WavWriter::create(&path, spec)
        .map_err(|e| format!("Failed to create temporary WAV file: {e}"))?;

    for sample in audio_16k_f32 {
        let sample_i16 = (sample.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        writer
            .write_sample(sample_i16)
            .map_err(|e| format!("Failed to write WAV sample: {e}"))?;
    }

    writer
        .finalize()
        .map_err(|e| format!("Failed to finalize temporary WAV file: {e}"))?;
    let wav_bytes = std::fs::read(&path)
        .map_err(|e| format!("Failed to read temporary WAV file: {e}"))?;
    let _ = std::fs::remove_file(&path);
    Ok(wav_bytes)
}

fn parse_transcription_text(value: &Value) -> Option<String> {
    value
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| value.get("transcript").and_then(Value::as_str))
        .or_else(|| {
            value
                .get("data")
                .and_then(|v| v.get("text"))
                .and_then(Value::as_str)
        })
        .map(|s| s.trim().to_string())
}

fn parse_error_text(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|err| {
            err.as_str().map(|s| s.to_string()).or_else(|| {
                err.get("message")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
            })
        })
        .or_else(|| {
            value
                .get("message")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        })
}

pub fn transcribe_audio_chunk(
    audio_16k_f32: &[f32],
    language: Option<&str>,
) -> Result<String, String> {
    if audio_16k_f32.is_empty() {
        return Ok(String::new());
    }

    let base_url = llm_api_base_url();
    let model = llm_transcription_model()?;
    let wav_bytes = pcm_f32_to_wav_bytes(audio_16k_f32)?;

    let file_part = multipart::Part::bytes(wav_bytes)
        .file_name("chunk.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("Failed to build multipart file part: {e}"))?;

    let mut form = multipart::Form::new().text("model", model).part("file", file_part);
    if let Some(lang) = language
        .map(|s| s.trim())
        .filter(|s| !s.is_empty() && *s != "auto")
    {
        form = form.text("language", lang.to_string());
    }

    let client = Client::builder()
        .timeout(Duration::from_secs(DEFAULT_LLM_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {e}"))?;

    let mut request = client
        .post(format!("{}/audio/transcriptions", base_url.trim_end_matches('/')))
        .multipart(form);

    if let Some(api_key) = llm_api_key() {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .map_err(|e| format!("LLM transcription request failed: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .map_err(|e| format!("Failed to read LLM transcription response body: {e}"))?;

    if !status.is_success() {
        if let Ok(json) = serde_json::from_str::<Value>(&body) {
            let detail = parse_error_text(&json).unwrap_or(body.clone());
            return Err(format!(
                "LLM transcription request failed with status {}: {}",
                status.as_u16(),
                detail
            ));
        }
        return Err(format!(
            "LLM transcription request failed with status {}: {}",
            status.as_u16(),
            body
        ));
    }

    let parsed = serde_json::from_str::<Value>(&body)
        .map_err(|e| format!("Invalid LLM transcription JSON response: {e}"))?;
    Ok(parse_transcription_text(&parsed).unwrap_or_default())
}
