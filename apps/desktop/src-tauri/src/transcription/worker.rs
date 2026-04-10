use log::error;
use std::sync::mpsc;
use std::sync::mpsc::Sender;
use std::thread::{self, JoinHandle};
use tauri::AppHandle;

use crate::audio::state::{try_recording_state, RecordingState};
use crate::emit_backend_error;
use crate::emit_transcription_segment;
use crate::whisper::WHISPER_CTX;

use super::llm_client;
use super::{TranscriptionCommand, TranscriptionSource};

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
                    let mut all_commands =
                        vec![(audio, language, source, session_id_counter, is_final, speaker_id)];
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

                    for (audio, language, source, session_id_counter, is_final, speaker_id) in all_commands {
                        let key = (source, session_id_counter);
                        if is_final {
                            sessions_with_final.insert(key);
                            final_requests.push((audio, language, source, session_id_counter, speaker_id));
                        } else {
                            latest_requests.insert(key, (audio, language, is_final, speaker_id));
                        }
                    }

                    for (audio, language, source, _session_id_counter, speaker_id) in final_requests {
                        if let Err(err) = transcribe_and_emit(
                            &audio,
                            language.clone(),
                            source,
                            true,
                            &app_handle,
                            speaker_id,
                        ) {
                            error!("Transcription worker error: {}", err);
                            emit_backend_error(
                                &app_handle,
                                format!(
                                    "Transcription request failed ({}): {}",
                                    source.event_source(),
                                    err
                                ),
                            );
                        }
                    }

                    for (key, (audio, language, is_final, speaker_id)) in latest_requests {
                        if sessions_with_final.contains(&key) {
                            continue;
                        }
                        let (source, _session_id_counter) = key;
                        if let Err(err) = transcribe_and_emit(
                            &audio,
                            language.clone(),
                            source,
                            is_final,
                            &app_handle,
                            speaker_id,
                        ) {
                            error!("Transcription worker error: {}", err);
                            emit_backend_error(
                                &app_handle,
                                format!(
                                    "Transcription request failed ({}): {}",
                                    source.event_source(),
                                    err
                                ),
                            );
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
) -> Result<(usize, u64), String> {
    let mut next_message_id = message_id_counter;

    if transcribed_samples >= audio_data.len() {
        return Ok((transcribed_samples, next_message_id));
    }

    let audio_to_transcribe = &audio_data[transcribed_samples..];

    let text = if transcription_mode == "local" {
        let ctx_lock = WHISPER_CTX
            .get()
            .ok_or_else(|| {
                "Whisper not initialized. Install/select a local model first.".to_string()
            })?
            .clone();
        let ctx_guard = ctx_lock
            .lock()
            .map_err(|_| "Failed to lock Whisper context".to_string())?;
        let ctx = ctx_guard
            .as_ref()
            .ok_or_else(|| "Whisper context not available".to_string())?;

        ctx.transcribe_with_language(audio_to_transcribe, language)
            .map_err(|e| format!("Local transcription failed: {}", e))?
    } else {
        llm_client::transcribe_audio_chunk(audio_to_transcribe, Some(language))?
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
    )?;

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
) -> Result<(), String> {
    let state =
        try_recording_state().ok_or_else(|| "Recording state not initialized".to_string())?;

    let (lang, source_state, transcription_mode) = {
        let state_guard = state.lock();
        let lang = language
            .clone()
            .or_else(|| state_guard.language.clone())
            .unwrap_or_else(|| "en".to_string());
        let source_state = state_guard.transcription_state(source).clone();
        let transcription_mode = state_guard.transcription_mode.clone();
        (lang, source_state, transcription_mode)
    };

    let result = transcribe_and_emit_common(
        audio_data,
        &lang,
        source_state.session_id_counter,
        is_final,
        app_handle,
        source.event_source(),
        source_state.message_id_counter,
        source_state.transcribed_samples,
        &transcription_mode,
        speaker_id,
    );

    {
        let mut state_guard = state.lock();
        let source_state_mut = state_guard.transcription_state_mut(source);

        match result {
            Ok((new_transcribed_samples, next_message_id)) => {
                if is_final {
                    source_state_mut.session_id_counter =
                        source_state_mut.session_id_counter.wrapping_add(1);
                    source_state_mut.message_id_counter = 0;
                    source_state_mut.transcribed_samples = 0;
                } else {
                    source_state_mut.transcribed_samples = new_transcribed_samples;
                    source_state_mut.message_id_counter = next_message_id;
                }
            }
            Err(ref err) => {
                // Keep session state healthy even when a final chunk fails.
                // Otherwise stale transcribed_samples/session_id can poison
                // subsequent chunks and make streaming appear to "lose track".
                if is_final {
                    source_state_mut.session_id_counter =
                        source_state_mut.session_id_counter.wrapping_add(1);
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

pub fn stop_transcription_worker(state: &mut RecordingState) {
    let tx = state.transcription_tx.take();
    let handle = state.transcription_handle.take();
    stop_transcription_worker_parts(tx, handle);
}
