use std::time::Duration;

use reqwest::blocking::Client;
use serde_json::{json, Value};

use super::{SummarizationConfig, SummarizationErrorKind};

const DEFAULT_SYSTEM_PROMPT: &str = r#"You are a meeting transcript analyst. Analyze the following transcript and produce a structured summary.

CRITICAL INSTRUCTIONS:
- Preserve SPECIFIC DETAILS: names of people, clients, companies, systems, tools, times, dates, dollar amounts, version numbers, ticket numbers, phone numbers, and any other concrete details mentioned. Do not generalize or abstract away specifics.
- When participants reference names of people, clients, vendors, or systems, include those exact names in the summary.
- Distinguish between actions that were AGREED upon versus actions that were merely PROPOSED or DECLINED.
- Do not merge separate topics into a single action item. Each distinct task is its own item.
- For technical issues, include: what system is affected, what the symptoms are, what troubleshooting was already done, what the root cause is (if identified), and what the resolution path is.
- For ANY discussion of schedule changes, time off, or availability adjustments, you MUST extract and list ALL of the following:
  * Every specific day of week affected
  * Every time block with start AND end times (e.g., "Wednesday 10:00-11:00 AM and 12:00-2:00 PM")
  * The person's normal/previous schedule vs. the proposed new schedule
  * How the time is being made up (exact offset per day, e.g., "arriving 30 minutes early each day, shifting start from 8:30 AM to 8:00 AM")
  * The total hours affected and how the math works out
  * Whether calendar blocks are already in place
  * Any conditions discussed (padding between appointments, remote vs. in-person, approval workflow)
- Silently EXCLUDE all small talk, personal chatter, pleasantries, greetings, goodbyes, casual banter, and off-topic conversation from the summary. Do not mention, reference, or acknowledge excluded content anywhere in the output.
- If any detail appears malformed or potentially garbled by transcription (e.g., phone numbers with too many/few digits, addresses that don't parse correctly, names that seem misspelled or inconsistent), still include the detail but flag it with [verify] so the reader knows to double-check.

OUTPUT FORMAT:

1. Meeting Title
A concise, descriptive title capturing the main topic(s).

2. Meeting Summary

Overview — 2-3 sentences summarizing the meeting at a high level.

Topics Discussed — For each topic, include:
  - The subject
  - Key specifics (names, numbers, times, systems, clients)
  - Context or background mentioned

Decisions & Next Steps — Specific conclusions, approvals, or agreements reached, along with planned follow-up actions and intentions. Include any reasoning or conditions discussed.

Concerns & Issues — Problems, risks, or blockers raised. Include specifics about what system, client, or process is affected and any diagnostic steps already taken.

Skip any subsection that does not apply.

3. Action Items
List every discrete action item that was AGREED upon (not just proposed):
- [Action description with full specifics] (Assigned to: [Name if mentioned], Due: [date or "Not specified"])

Do not combine multiple actions into one item.

TRANSCRIPT:"#;

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
    let api_key = crate::api_keys::get_summary_api_key()
        .map_err(|err| (SummarizationErrorKind::InvalidConfig, err))?
        .ok_or((SummarizationErrorKind::Unconfigured, "Missing API key".to_string()))?;

    summarize_with_api_key(config, transcript, language, &api_key)
}

fn summarize_with_api_key(
    config: &SummarizationConfig,
    transcript: &str,
    language: &str,
    api_key: &str,
) -> Result<String, (SummarizationErrorKind, String)> {
    let client = Client::builder()
        .timeout(Duration::from_secs(config.timeout_secs.max(5)))
        .build()
        .map_err(|e| (SummarizationErrorKind::Transient, format!("Failed to build HTTP client: {e}")))?;

    let url = format!("{}/chat/completions", config.api_base_url.trim_end_matches('/'));

    let system_prompt = config
        .custom_system_prompt
        .as_deref()
        .unwrap_or(DEFAULT_SYSTEM_PROMPT);
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
        .bearer_auth(api_key)
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
    let api_key = crate::api_keys::get_summary_api_key()
        .map_err(|err| (SummarizationErrorKind::InvalidConfig, err))?
        .ok_or((SummarizationErrorKind::Unconfigured, "Missing API key".to_string()))?;

    smoke_check_with_api_key(config, api_key)
}

pub fn smoke_check_with_api_key(
    config: &SummarizationConfig,
    api_key: String,
) -> Result<(), (SummarizationErrorKind, String)> {

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

    let _ = summarize_with_api_key(config, "Speaker A: hello\nSpeaker B: hi", "en", &api_key)?;
    Ok(())
}
