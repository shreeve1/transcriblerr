use crate::*;
#[cfg(feature = "diarization")]
use tauri::Emitter;
use tauri::{Builder, Runtime};

#[tauri::command]
async fn scan_models() -> Result<Vec<ModelInfo>, String> {
    crate::scan_models_impl().await
}

#[tauri::command]
async fn initialize_whisper(model_path: String) -> Result<String, String> {
    crate::initialize_whisper_impl(model_path).await
}

#[tauri::command]
async fn get_whisper_params() -> Result<WhisperParamsConfig, String> {
    crate::get_whisper_params_impl().await
}

#[tauri::command]
async fn set_whisper_params(config: WhisperParamsConfig) -> Result<(), String> {
    crate::set_whisper_params_impl(config).await
}

#[tauri::command]
async fn list_remote_models() -> Result<Vec<RemoteModelStatus>, String> {
    crate::list_remote_models_impl().await
}

#[tauri::command]
async fn install_model(model_id: String) -> Result<ModelInfo, String> {
    crate::install_model_impl(model_id).await
}

#[tauri::command]
async fn delete_model(model_path: String) -> Result<(), String> {
    crate::delete_model_impl(model_path).await
}

#[tauri::command]
async fn start_recording(language: Option<String>) -> Result<(), String> {
    crate::start_recording_impl(language).await
}

#[tauri::command]
async fn update_language(language: Option<String>) -> Result<(), String> {
    crate::update_language_impl(language).await
}

#[tauri::command]
async fn stop_recording() -> Result<(), String> {
    crate::stop_recording_impl().await
}

#[tauri::command]
async fn start_mic(language: Option<String>) -> Result<(), String> {
    crate::start_mic_impl(language).await
}

#[tauri::command]
async fn stop_mic() -> Result<(), String> {
    crate::stop_mic_impl().await
}

#[tauri::command]
async fn get_mic_status() -> Result<bool, String> {
    crate::get_mic_status_impl().await
}

#[tauri::command]
async fn list_audio_devices() -> Result<Vec<AudioDevice>, String> {
    crate::list_audio_devices_impl().await
}

#[tauri::command]
async fn select_audio_device(device_name: String) -> Result<(), String> {
    crate::select_audio_device_impl(device_name).await
}

#[tauri::command]
async fn get_streaming_config() -> Result<StreamingConfig, String> {
    crate::get_streaming_config_impl().await
}

#[tauri::command]
async fn set_streaming_config(config: StreamingConfig) -> Result<(), String> {
    crate::set_streaming_config_impl(config).await
}

#[tauri::command]
async fn get_transcription_backend_config() -> Result<TranscriptionBackendConfig, String> {
    crate::get_transcription_backend_config_impl().await
}

#[tauri::command]
async fn set_transcription_backend_config(config: TranscriptionBackendConfig) -> Result<(), String> {
    crate::set_transcription_backend_config_impl(config).await
}

#[tauri::command]
async fn get_api_key_status() -> Result<ApiKeyStatus, String> {
    crate::get_api_key_status_impl().await
}

#[tauri::command]
async fn set_api_key(api_key: String) -> Result<ApiKeyStatus, String> {
    crate::set_api_key_impl(api_key).await
}

#[tauri::command]
async fn delete_api_key() -> Result<ApiKeyStatus, String> {
    crate::delete_api_key_impl().await
}

#[tauri::command]
async fn test_api_key(api_key: Option<String>) -> Result<String, String> {
    crate::test_api_key_impl(api_key).await
}

#[tauri::command]
async fn check_microphone_permission() -> Result<bool, String> {
    crate::check_microphone_permission_impl().await
}

#[tauri::command]
async fn start_system_audio() -> Result<(), String> {
    crate::start_system_audio_impl().await
}

#[tauri::command]
async fn stop_system_audio() -> Result<(), String> {
    crate::stop_system_audio_impl().await
}

#[tauri::command]
async fn get_system_audio_status() -> Result<bool, String> {
    crate::get_system_audio_status_impl().await
}

#[tauri::command]
async fn set_recording_save_config(enabled: bool, path: Option<String>) -> Result<(), String> {
    crate::set_recording_save_config_impl(enabled, path).await
}

#[tauri::command]
async fn get_recording_save_config() -> Result<(bool, Option<String>), String> {
    crate::get_recording_save_config_impl().await
}

#[tauri::command]
async fn get_supported_languages() -> Result<Vec<(String, String)>, String> {
    crate::get_supported_languages_impl().await
}

#[tauri::command]
async fn get_summarization_config() -> Result<SummarizationConfigView, String> {
    crate::get_summarization_config_impl().await
}

#[tauri::command]
async fn set_summarization_config(
    config: SummarizationConfigUpdate,
) -> Result<SummarizationConfigView, String> {
    crate::set_summarization_config_impl(config).await
}

#[tauri::command]
async fn summarize_transcript(transcript: String, language: String) -> Result<String, String> {
    crate::summarize_transcript_impl(transcript, language).await
}

#[tauri::command]
async fn save_summary_to_file(path: String, content: String) -> Result<String, String> {
    crate::save_summary_to_file_impl(path, content).await
}

#[tauri::command]
async fn summarization_provider_smoke_check() -> Result<String, String> {
    crate::summarization_provider_smoke_check_impl().await
}

#[tauri::command]
async fn set_transcription_suppressed(enabled: bool) -> Result<(), String> {
    crate::set_transcription_suppressed_impl(enabled).await
}

#[cfg(feature = "diarization")]
#[tauri::command]
fn rename_speaker(speaker_id: String, display_name: String) -> Result<(), String> {
    let manager = crate::DIARIZATION_MANAGER
        .get()
        .ok_or("Diarization not initialized")?;
    let mut guard = manager.lock();
    guard.rename_speaker(&speaker_id, &display_name)?;

    if let Ok(path) = crate::speaker_profiles_path() {
        if let Err(e) = guard.tracker().save_to_file(&path) {
            log::warn!("Failed to persist speaker profiles after rename: {}", e);
        }
    }

    drop(guard);

    if let Some(app) = crate::APP_HANDLE.get() {
        let _ = app.emit("speaker-updated", serde_json::json!({
            "speakerId": speaker_id,
            "displayName": display_name,
        }));
    }

    Ok(())
}

#[cfg(feature = "diarization")]
#[tauri::command]
fn get_speakers() -> Result<Vec<crate::diarization::SpeakerInfo>, String> {
    let manager = crate::DIARIZATION_MANAGER
        .get()
        .ok_or("Diarization not initialized")?;
    Ok(manager.lock().list_speakers())
}

#[cfg(feature = "diarization")]
#[tauri::command]
fn reset_speakers() -> Result<(), String> {
    let manager = crate::DIARIZATION_MANAGER
        .get()
        .ok_or("Diarization not initialized")?;
    manager.lock().reset();

    if let Ok(path) = crate::speaker_profiles_path() {
        let _ = std::fs::remove_file(&path);
    }

    Ok(())
}

#[cfg(not(feature = "diarization"))]
#[tauri::command]
fn rename_speaker(_speaker_id: String, _display_name: String) -> Result<(), String> {
    Err("Diarization feature not enabled".to_string())
}

#[cfg(not(feature = "diarization"))]
#[tauri::command]
fn get_speakers() -> Result<Vec<serde_json::Value>, String> {
    Err("Diarization feature not enabled".to_string())
}

#[cfg(not(feature = "diarization"))]
#[tauri::command]
fn reset_speakers() -> Result<(), String> {
    Err("Diarization feature not enabled".to_string())
}

pub fn register<R: Runtime>(builder: Builder<R>) -> Builder<R> {
    builder.invoke_handler(tauri::generate_handler![
        scan_models,
        initialize_whisper,
        get_whisper_params,
        set_whisper_params,
        list_remote_models,
        install_model,
        delete_model,
        start_recording,
        update_language,
        stop_recording,
        start_mic,
        stop_mic,
        get_mic_status,
        list_audio_devices,
        select_audio_device,
        get_streaming_config,
        set_streaming_config,
        get_transcription_backend_config,
        set_transcription_backend_config,
        get_api_key_status,
        set_api_key,
        delete_api_key,
        test_api_key,
        check_microphone_permission,
        start_system_audio,
        stop_system_audio,
        get_system_audio_status,
        set_recording_save_config,
        get_recording_save_config,
        get_supported_languages,
        get_summarization_config,
        set_summarization_config,
        summarize_transcript,
        save_summary_to_file,
        summarization_provider_smoke_check,
        set_transcription_suppressed,
        rename_speaker,
        get_speakers,
        reset_speakers,
    ])
}
