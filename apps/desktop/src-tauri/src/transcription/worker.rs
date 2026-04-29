use log::error;
use std::sync::mpsc;
use std::sync::mpsc::Sender;
use std::thread::{self, JoinHandle};
use tauri::AppHandle;

use crate::audio::state::{try_recording_state, RecordingState};
use crate::emit_backend_error;
use crate::emit_backend_error_with_kind;
use crate::emit_transcription_segment;
use crate::whisper::WHISPER_CTX;

use super::llm_client;
use super::{TranscriptionCommand, TranscriptionSource};

#[derive(Debug, Clone)]
pub enum TranscriptionError {
    LlmAuth(String),
    Other(String),
}

impl TranscriptionError {
    fn is_llm_auth(&self) -> bool {
        matches!(self, TranscriptionError::LlmAuth(_))
    }
}

impl std::fmt::Display for TranscriptionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TranscriptionError::LlmAuth(message) | TranscriptionError::Other(message) => {
                f.write_str(message)
            }
        }
    }
}

fn emit_transcription_error(
    app_handle: &AppHandle,
    source: TranscriptionSource,
    err: &TranscriptionError,
) {
    let message = format!(
        "Transcription request failed ({}): {}",
        source.event_source(),
        err
    );

    if err.is_llm_auth() {
        emit_backend_error_with_kind(app_handle, "llm_auth", message);
    } else {
        emit_backend_error(app_handle, message);
    }
}

pub fn spawn_transcription_worker(
    app_handle: AppHandle,
) -> (mpsc::Sender<TranscriptionCommand>, JoinHandle<()>) {
    let (tx, rx) = mpsc::channel::<TranscriptionCommand>();
    let handle = thread::spawn(move || {
        use std::collections::{HashMap, HashSet};

        #[cfg(feature = "diarization")]
        let mut last_profile_save = std::time::Instant::now();

        while let Ok(command) = rx.recv() {
            match command {
                TranscriptionCommand::Run {
                    audio,
                    language,
                    source,
                    session_id_counter,
                    is_final,
                    speaker_id,
                } => {
                    let mut all_commands = vec![(
                        audio,
                        language,
                        source,
                        session_id_counter,
                        is_final,
                        speaker_id,
                    )];
                    while let Ok(next_command) = rx.try_recv() {
                        match next_command {
                            TranscriptionCommand::Run {
                                audio: a,
                                language: l,
                                source: src,
                                session_id_counter: sid,
                                is_final: f,
                                speaker_id: spk,
                            } => {
                                all_commands.push((a, l, src, sid, f, spk));
                            }
                            TranscriptionCommand::Stop => return,
                        }
                    }

                    let mut latest_requests: HashMap<
                        (TranscriptionSource, u64),
                        (Vec<f32>, Option<String>, bool, Option<String>),
                    > = HashMap::new();
                    let mut final_requests = Vec::new();
                    let mut sessions_with_final = HashSet::new();

                    for (
                        audio,
                        language,
                        source,
                        session_id_counter,
                        is_final,
                        speaker_id,
                    ) in all_commands
                    {
                        let key = (source, session_id_counter);
                        if is_final {
                            sessions_with_final.insert(key);
                            final_requests.push((
                                audio,
                                language,
                                source,
                                session_id_counter,
                                speaker_id,
                            ));
                        } else {
                            latest_requests.insert(key, (audio, language, is_final, speaker_id));
                        }
                    }

                    for (audio, language, source, session_id_counter, speaker_id) in final_requests {
                        if let Err(err) = transcribe_and_emit(
                            &audio,
                            language.clone(),
                            source,
                            true,
                            &app_handle,
                            speaker_id,
                            Some(session_id_counter),
                        ) {
                            error!("Transcription worker error: {}", err);
                            emit_transcription_error(&app_handle, source, &err);
                        }
                    }

                    for (key, (audio, language, is_final, speaker_id)) in latest_requests {
                        if sessions_with_final.contains(&key) {
                            continue;
                        }
                        let (source, session_id_counter) = key;
                        if let Err(err) = transcribe_and_emit(
                            &audio,
                            language.clone(),
                            source,
                            is_final,
                            &app_handle,
                            speaker_id,
                            Some(session_id_counter),
                        ) {
                            error!("Transcription worker error: {}", err);
                            emit_transcription_error(&app_handle, source, &err);
                        }
                    }

                    #[cfg(feature = "diarization")]
                    {
                        if last_profile_save.elapsed().as_secs() >= 5 {
                            if let Some(manager) = crate::DIARIZATION_MANAGER.get() {
                                let mut guard = manager.lock();
                                if guard.tracker().is_dirty() {
                                    if let Ok(path) = crate::speaker_profiles_path() {
                                        if let Err(e) = guard.tracker().save_to_file(&path) {
                                            log::warn!("Failed to persist speaker profiles: {}", e);
                                        } else {
                                            guard.tracker_mut().clear_dirty();
                                        }
                                    }
                                }
                            }
                            last_profile_save = std::time::Instant::now();
                        }
                    }
                }
                TranscriptionCommand::Stop => break,
            }
        }
    });
    (tx, handle)
}

pub fn ensure_transcription_worker(state: &mut RecordingState, app_handle: AppHandle) {
    if state.transcription_tx.is_some() {
        return;
    }

    let (tx, handle) = spawn_transcription_worker(app_handle);
    state.transcription_tx = Some(tx);
    state.transcription_handle = Some(handle);
}

pub fn transcribe_and_emit_common(
    audio_data: &[f32],
    language: &str,
    session_id_counter: u64,
    is_final: bool,
    app_handle: &AppHandle,
    source: &str,
    message_id_counter: u64,
    transcribed_samples: usize,
    transcription_mode: &str,
    speaker_id: Option<String>,
) -> Result<(usize, u64), TranscriptionError> {
    let mut next_message_id = message_id_counter;

    if transcribed_samples >= audio_data.len() {
        return Ok((transcribed_samples, next_message_id));
    }

    let audio_to_transcribe = &audio_data[transcribed_samples..];

    let text = if transcription_mode == "local" {
        let ctx_lock = WHISPER_CTX
            .get()
            .ok_or_else(|| {
                TranscriptionError::Other(
                    "Whisper not initialized. Install/select a local model first.".to_string(),
                )
            })?
            .clone();
        let ctx_guard = ctx_lock
            .lock()
            .map_err(|_| TranscriptionError::Other("Failed to lock Whisper context".to_string()))?;
        let ctx = ctx_guard
            .as_ref()
            .ok_or_else(|| TranscriptionError::Other("Whisper context not available".to_string()))?;

        ctx.transcribe_with_language(audio_to_transcribe, language)
            .map_err(|e| TranscriptionError::Other(format!("Local transcription failed: {}", e)))?
    } else {
        llm_client::transcribe_audio_chunk(audio_to_transcribe, Some(language)).map_err(|err| {
            match err {
                llm_client::LlmTranscriptionError::Auth(message) => {
                    TranscriptionError::LlmAuth(message)
                }
                llm_client::LlmTranscriptionError::Other(message) => {
                    TranscriptionError::Other(message)
                }
            }
        })?
    };

    if text.trim().is_empty() {
        return Ok((audio_data.len(), next_message_id));
    }

    emit_transcription_segment(
        app_handle,
        text,
        Some(audio_to_transcribe.to_vec()),
        session_id_counter,
        next_message_id,
        is_final,
        source.to_string(),
        speaker_id.clone(),
    )
    .map_err(TranscriptionError::Other)?;

    next_message_id = next_message_id.wrapping_add(1);
    Ok((audio_data.len(), next_message_id))
}

fn transcribe_and_emit(
    audio_data: &[f32],
    language: Option<String>,
    source: TranscriptionSource,
    is_final: bool,
    app_handle: &AppHandle,
    speaker_id: Option<String>,
    command_session_id: Option<u64>,
) -> Result<(), TranscriptionError> {
    let state =
        try_recording_state()
            .ok_or_else(|| TranscriptionError::Other("Recording state not initialized".to_string()))?;

    let (lang, source_state, transcription_mode, llm_auth_blocked) = {
        let state_guard = state.lock();
        let lang = language
            .clone()
            .or_else(|| state_guard.language.clone())
            .unwrap_or_else(|| "en".to_string());
        let source_state = state_guard.transcription_state(source).clone();
        let transcription_mode = state_guard.transcription_mode.clone();
        let llm_auth_blocked = state_guard.llm_auth_blocked;
        (lang, source_state, transcription_mode, llm_auth_blocked)
    };

    // Use the session_id from the command if provided (captures the value at
    // queue time), otherwise fall back to the current shared-state value.
    // This avoids a race where the caller eagerly increments session_id_counter
    // before the worker processes the queued command.
    let emit_session_id = command_session_id.unwrap_or(source_state.session_id_counter);

    let result = if transcription_mode != "local" && llm_auth_blocked {
        Ok((audio_data.len(), source_state.message_id_counter))
    } else {
        transcribe_and_emit_common(
            audio_data,
            &lang,
            emit_session_id,
            is_final,
            app_handle,
            source.event_source(),
            source_state.message_id_counter,
            source_state.transcribed_samples,
            &transcription_mode,
            speaker_id,
        )
    };

    {
        let mut state_guard = state.lock();
        if matches!(result, Err(ref err) if err.is_llm_auth()) && !state_guard.llm_auth_blocked {
            state_guard.llm_auth_blocked = true;
        }

        let source_state_mut = state_guard.transcription_state_mut(source);

        match result {
            Ok((new_transcribed_samples, next_message_id)) => {
                if is_final {
                    // Only increment if we haven't already advanced past the
                    // session_id we emitted (caller may have eagerly incremented).
                    if source_state_mut.session_id_counter == emit_session_id {
                        source_state_mut.session_id_counter =
                            source_state_mut.session_id_counter.wrapping_add(1);
                    }
                    source_state_mut.message_id_counter = 0;
                    source_state_mut.transcribed_samples = 0;
                } else {
                    source_state_mut.transcribed_samples = new_transcribed_samples;
                    source_state_mut.message_id_counter = next_message_id;
                }
            }
            Err(ref err) => {
                if is_final {
                    if source_state_mut.session_id_counter == emit_session_id {
                        source_state_mut.session_id_counter =
                            source_state_mut.session_id_counter.wrapping_add(1);
                    }
                    source_state_mut.message_id_counter = 0;
                    source_state_mut.transcribed_samples = 0;
                }

                return Err(err.clone());
            }
        }
    }

    Ok(())
}

pub fn queue_transcription_with_source(
    audio: Vec<f32>,
    language: Option<String>,
    session_id_counter: u64,
    source: TranscriptionSource,
    is_final: bool,
    tx: &Sender<TranscriptionCommand>,
    speaker_id: Option<String>,
) {
    if audio.is_empty() {
        return;
    }

    if tx
        .send(TranscriptionCommand::Run {
            audio,
            language,
            source,
            session_id_counter,
            is_final,
            speaker_id,
        })
        .is_err()
    {
        log::error!("Failed to send transcription command");
    }
}

pub fn queue_transcription(state: &RecordingState, is_final: bool) {
    if state.session_audio.is_empty() {
        return;
    }
    let Some(tx) = &state.transcription_tx else {
        return;
    };

    let session_id_counter = state
        .transcription_state(TranscriptionSource::Mic)
        .session_id_counter;

    queue_transcription_with_source(
        state.session_audio.clone(),
        state.language.clone(),
        session_id_counter,
        TranscriptionSource::Mic,
        is_final,
        tx,
        None,
    );
}

pub fn stop_transcription_worker_parts(
    tx: Option<Sender<TranscriptionCommand>>,
    handle: Option<JoinHandle<()>>,
) {
    if let Some(tx) = tx {
        let _ = tx.send(TranscriptionCommand::Stop);
    }
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}
