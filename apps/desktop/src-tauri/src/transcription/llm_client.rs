use std::time::Duration;

use hound::{SampleFormat, WavSpec, WavWriter};
use log::warn;
use reqwest::blocking::{multipart, Client};
use serde_json::Value;

const DEFAULT_LLM_API_BASE_URL: &str = "https://api.openai.com/v1";
const DEFAULT_LLM_TRANSCRIPTION_MODEL: &str = "gpt-4o-transcribe";
const DEFAULT_LLM_TIMEOUT_SECS: u64 = 45;
const MIN_LLM_CHUNK_SAMPLES: usize = 3_200; // 200ms at 16kHz

#[derive(Debug, Clone)]
pub enum LlmTranscriptionError {
    Auth(String),
    Other(String),
}

impl std::fmt::Display for LlmTranscriptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LlmTranscriptionError::Auth(message) | LlmTranscriptionError::Other(message) => {
                f.write_str(message)
            }
        }
    }
}

fn is_cjk_char(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF // CJK Unified Ideographs Extension A
            | 0x4E00..=0x9FFF // CJK Unified Ideographs
            | 0x3040..=0x309F // Kana block 1
            | 0x30A0..=0x30FF // Kana block 2
            | 0xAC00..=0xD7AF // Hangul Syllables
    )
}

fn should_drop_non_english_artifact(text: &str, language: Option<&str>) -> bool {
    let lang = language
        .map(|s| s.trim().to_ascii_lowercase())
        .unwrap_or_default();

    if !(lang == "en" || lang == "en-us" || lang == "en-gb" || lang == "english") {
        return false;
    }

    let chars: Vec<char> = text
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_ascii_punctuation())
        .collect();
    if chars.is_empty() {
        return false;
    }

    // Only suppress short, mostly-CJK snippets when language is explicitly English.
    // These commonly appear as hallucinated fragments on boundary/noise chunks.
    let cjk_count = chars.iter().filter(|&&c| is_cjk_char(c)).count();
    let ratio = cjk_count as f32 / chars.len() as f32;
    chars.len() <= 12 && ratio >= 0.5
}

fn llm_api_base_url() -> String {
    std::env::var("LLM_API_BASE_URL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_LLM_API_BASE_URL.to_string())
}

pub fn default_transcription_model() -> String {
    std::env::var("LLM_TRANSCRIPTION_MODEL")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_LLM_TRANSCRIPTION_MODEL.to_string())
}

fn llm_transcription_model() -> String {
    crate::audio::state::try_recording_state()
        .map(|state| state.lock().llm_transcription_model.clone())
        .map(|model| model.trim().to_string())
        .filter(|model| !model.is_empty())
        .unwrap_or_else(default_transcription_model)
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
) -> Result<String, LlmTranscriptionError> {
    if audio_16k_f32.is_empty() {
        return Ok(String::new());
    }

    // Some OpenAI-compatible backends reject ultra-short chunks as
    // "corrupted or unsupported". Skip those tiny fragments.
    if audio_16k_f32.len() < MIN_LLM_CHUNK_SAMPLES {
        return Ok(String::new());
    }

    let base_url = llm_api_base_url();
    let model = llm_transcription_model();
    let wav_bytes = pcm_f32_to_wav_bytes(audio_16k_f32).map_err(LlmTranscriptionError::Other)?;

    let file_part = multipart::Part::bytes(wav_bytes)
        .file_name("chunk.wav")
        .mime_str("audio/wav")
        .map_err(|e| {
            LlmTranscriptionError::Other(format!("Failed to build multipart file part: {e}"))
        })?;

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
        .map_err(|e| LlmTranscriptionError::Other(format!("Failed to build HTTP client: {e}")))?;

    let mut request = client
        .post(format!("{}/audio/transcriptions", base_url.trim_end_matches('/')))
        .multipart(form);

    if let Some(api_key) = crate::api_keys::get_llm_api_key().map_err(LlmTranscriptionError::Other)? {
        request = request.bearer_auth(api_key);
    }

    let response = request
        .send()
        .map_err(|e| {
            LlmTranscriptionError::Other(format!("LLM transcription request failed: {e}"))
        })?;
    let status = response.status();
    let status_code = status.as_u16();
    let body = response
        .text()
        .map_err(|e| {
            LlmTranscriptionError::Other(format!(
                "Failed to read LLM transcription response body: {e}"
            ))
        })?;

    if !status.is_success() {
        if let Ok(json) = serde_json::from_str::<Value>(&body) {
            let detail = parse_error_text(&json).unwrap_or(body.clone());

            if status_code == 400 {
                let normalized = detail.to_lowercase();
                if normalized.contains("corrupted") || normalized.contains("unsupported") {
                    warn!(
                        "LLM backend rejected audio chunk as unsupported/corrupted ({} samples, {}): {}",
                        audio_16k_f32.len(),
                        status.as_u16(),
                        detail
                    );
                    return Ok(String::new());
                }
            }

            if status_code == 401 || status_code == 403 {
                return Err(LlmTranscriptionError::Auth(format!(
                    "LLM transcription authentication failed with status {}: {}",
                    status_code, detail
                )));
            }

            return Err(LlmTranscriptionError::Other(format!(
                "LLM transcription request failed with status {}: {}",
                status_code,
                detail
            )));
        }

        if status_code == 401 || status_code == 403 {
            return Err(LlmTranscriptionError::Auth(format!(
                "LLM transcription authentication failed with status {}: {}",
                status_code, body
            )));
        }

        return Err(LlmTranscriptionError::Other(format!(
            "LLM transcription request failed with status {}: {}",
            status_code,
            body
        )));
    }

    let parsed = serde_json::from_str::<Value>(&body)
        .map_err(|e| LlmTranscriptionError::Other(format!("Invalid LLM transcription JSON response: {e}")))?;
    let text = parse_transcription_text(&parsed).unwrap_or_default();

    if should_drop_non_english_artifact(&text, language) {
        warn!(
            "Dropping likely non-English artifact for language=en ({} samples): {:?}",
            audio_16k_f32.len(),
            text
        );
        return Ok(String::new());
    }

    Ok(text)
}
