use crate::audio::{
    try_recording_state, RecordingState, SILENCE_TIMEOUT_SAMPLES, VAD_CHUNK_SIZE,
    VAD_POST_BUFFER_SAMPLES, VAD_PRE_BUFFER_SAMPLES, VAD_SAMPLE_RATE,
};
use crate::transcription::worker::{ensure_transcription_worker, queue_transcription_with_source};
use crate::transcription::TranscriptionSource;
use log::{debug, error, info};
use parking_lot::Mutex as ParkingMutex;
use std::ffi::CStr;
use std::os::raw::{c_char, c_int};
use std::ptr::{addr_of, addr_of_mut};
use std::sync::Arc;
use tauri::AppHandle;
use voice_activity_detector::VoiceActivityDetector;
extern "C" {
    fn system_audio_start(callback: extern "C" fn(*const f32, c_int)) -> c_int;
    fn system_audio_stop() -> c_int;
    fn system_audio_last_error() -> *const c_char;
}

struct SystemAudioSession {
    session_audio: Vec<f32>,
    vad: VoiceActivityDetector,
    vad_pending: Vec<f32>,
    pre_buffer: Vec<f32>,
    post_buffer_remaining: usize,
    vad_threshold: f32,
    session_samples: usize,
    last_voice_sample: Option<usize>,
    last_partial_emit_samples: usize,
    partial_transcript_interval_samples: usize,
    last_vad_event_time: std::time::Instant,
    is_voice_active: bool,
    current_session_speaker_id: Option<String>,
    last_diarization_samples: usize,
    last_finalized_speaker_id: Option<String>,
    awaiting_first_speaker: bool,
}

static mut SYSTEM_AUDIO_SESSION: Option<SystemAudioSession> = None;
static mut APP_HANDLE: Option<AppHandle> = None;
static mut RECORDING_STATE: Option<Arc<ParkingMutex<RecordingState>>> = None;

fn reset_system_audio_session_tracking(session: &mut SystemAudioSession) {
    session.session_audio.clear();
    session.vad_pending.clear();
    session.pre_buffer.clear();
    session.post_buffer_remaining = 0;
    session.session_samples = 0;
    session.last_voice_sample = None;
    session.last_partial_emit_samples = 0;
    session.is_voice_active = false;
    session.current_session_speaker_id = None;
    session.last_diarization_samples = 0;
    // Note: last_finalized_speaker_id is NOT cleared here — it persists across
    // session resets since it tracks the *previous* session's speaker.
    session.awaiting_first_speaker = false;
}

fn last_system_audio_error_message() -> Option<String> {
    unsafe {
        let ptr = system_audio_last_error();
        if ptr.is_null() {
            None
        } else {
            CStr::from_ptr(ptr).to_str().ok().map(|s| s.to_string())
        }
    }
}

fn format_system_audio_error(default_message: &str) -> String {
    last_system_audio_error_message()
        .filter(|s| !s.is_empty())
        .map(|detail| format!("{default_message}: {detail}"))
        .unwrap_or_else(|| default_message.to_string())
}
fn current_session_max_samples() -> usize {
    try_recording_state()
        .map(|state| state.lock().session_max_samples)
        .unwrap_or(30 * VAD_SAMPLE_RATE as usize)
}

extern "C" fn audio_callback(samples: *const f32, count: c_int) {
    unsafe {
        let session_ptr = addr_of_mut!(SYSTEM_AUDIO_SESSION);
        let Some(session) = (*session_ptr).as_mut() else {
            return;
        };
        let state_ptr = addr_of!(RECORDING_STATE);
        let Some(state_arc) = (*state_ptr).as_ref() else {
            return;
        };
        let state = state_arc.lock();

        if !state.is_recording || !state.system_audio_enabled {
            return;
        }

        let app_handle_ptr = addr_of!(APP_HANDLE);
        let app_handle = (*app_handle_ptr).as_ref();
        let language = state.language.clone();
        let session_id_counter = state
            .transcription_state(TranscriptionSource::System)
            .session_id_counter;
        let suppress_transcription = state.suppress_transcription;
        drop(state);

        if suppress_transcription {
            return;
        }

        let slice = std::slice::from_raw_parts(samples, count as usize);
        if slice.is_empty() {
            return;
        }

        for &sample in slice {
            process_system_audio_sample_local(
                session,
                sample,
                app_handle,
                language.as_deref(),
                session_id_counter,
            );
        }
    }
}

fn process_system_audio_sample_local(
    session: &mut SystemAudioSession,
    sample: f32,
    app_handle: Option<&AppHandle>,
    language: Option<&str>,
    session_id_counter: u64,
) {
    session.session_samples += 1;
    session.vad_pending.push(sample);

    while session.vad_pending.len() >= VAD_CHUNK_SIZE {
        let chunk: Vec<f32> = session.vad_pending.drain(..VAD_CHUNK_SIZE).collect();
        let chunk_i16: Vec<i16> = chunk
            .iter()
            .map(|&s| (s * i16::MAX as f32) as i16)
            .collect();

        let probability = session.vad.predict(chunk_i16);

        if probability > session.vad_threshold {
            if !session.is_voice_active && !session.pre_buffer.is_empty() {
                session.session_audio.extend_from_slice(&session.pre_buffer);
                session.pre_buffer.clear();
            }
            session.session_audio.extend_from_slice(&chunk);
            session.post_buffer_remaining = VAD_POST_BUFFER_SAMPLES;
            session.last_voice_sample = Some(session.session_samples);
            session.is_voice_active = true;
        } else {
            if session.is_voice_active && session.post_buffer_remaining > 0 {
                session.session_audio.extend_from_slice(&chunk);
                session.post_buffer_remaining =
                    session.post_buffer_remaining.saturating_sub(chunk.len());
                if session.post_buffer_remaining == 0 {
                    session.is_voice_active = false;
                }
            } else {
                session.pre_buffer.extend_from_slice(&chunk);
                if session.pre_buffer.len() > VAD_PRE_BUFFER_SAMPLES {
                    let excess = session.pre_buffer.len() - VAD_PRE_BUFFER_SAMPLES;
                    session.pre_buffer.drain(0..excess);
                }
                session.is_voice_active = false;
            }
        }
    }

    // Run diarization periodically during an active system-audio session.
    // If we detect a confident speaker change, split the session so the UI
    // can render separate chat bubbles per speaker turn.
    #[cfg(feature = "diarization")]
    {
        const MIN_SAMPLES_FOR_DIARIZATION: usize = 32_000; // 2.0s @ 16kHz
        const DIARIZATION_RECHECK_INTERVAL_SAMPLES: usize = 16_000; // 1.0s @ 16kHz
        // The 3dspeaker eres2net model produces cosine similarities in the
        // 0.1–0.4 range for different speakers; 0.72 was unreachably high
        // and caused every speaker change to be silently ignored.
        const SPEAKER_CHANGE_MIN_CONFIDENCE: f32 = 0.20;
        // Only feed the most recent N seconds to the embedding extractor so
        // the vector represents the *current* speaker, not a blend of everyone
        // who has spoken during the session.
        const DIARIZATION_WINDOW_SAMPLES: usize = 48_000; // 3.0s @ 16kHz

        let enough_audio = session.session_audio.len() >= MIN_SAMPLES_FOR_DIARIZATION;
        let due_for_recheck = session.last_diarization_samples == 0
            || session
                .session_audio
                .len()
                .saturating_sub(session.last_diarization_samples)
                >= DIARIZATION_RECHECK_INTERVAL_SAMPLES;

        if enough_audio && due_for_recheck {
            session.last_diarization_samples = session.session_audio.len();

            // Use only the tail of the audio for embedding extraction so
            // we capture the current speaker rather than diluting across
            // the entire session.
            let audio_window = if session.session_audio.len() > DIARIZATION_WINDOW_SAMPLES {
                &session.session_audio[session.session_audio.len() - DIARIZATION_WINDOW_SAMPLES..]
            } else {
                &session.session_audio
            };

            let mut diarization_assignment: Option<(String, f32, bool)> = None;
            if let Some(manager) = crate::DIARIZATION_MANAGER.get() {
                let mut guard = manager.lock();
                let result = guard.process_utterance(audio_window, 16000);
                if let Some(sid) = result.speaker_id.clone() {
                    info!(
                        "Diarization assigned {} (confidence {:.3}, reliable={}, window={}, total={})",
                        sid,
                        result.confidence,
                        result.is_reliable,
                        audio_window.len(),
                        session.session_audio.len()
                    );
                    diarization_assignment = Some((sid, result.confidence, result.is_reliable));
                } else {
                    info!(
                        "Diarization produced no speaker (confidence {:.3}, reliable={}, window={}, total={})",
                        result.confidence,
                        result.is_reliable,
                        audio_window.len(),
                        session.session_audio.len()
                    );
                }
            }

            if let Some((sid, confidence, is_reliable)) = diarization_assignment {
                match session.current_session_speaker_id.as_deref() {
                    None => {
                        session.current_session_speaker_id = Some(sid);
                        session.awaiting_first_speaker = false;
                    }
                    Some(current_sid) if current_sid != sid => {
                        if is_reliable && confidence >= SPEAKER_CHANGE_MIN_CONFIDENCE {
                            let previous_sid = current_sid.to_string();
                            info!(
                                "Diarization speaker change: {} -> {} (confidence {:.3}, reliable={}) — splitting session",
                                previous_sid,
                                sid,
                                confidence,
                                is_reliable
                            );

                            finalize_system_audio_session(session, "speaker_change", app_handle, language);

                            // Seed the next session with the newly detected speaker so
                            // immediate partials after the split have a speaker label.
                            session.current_session_speaker_id = Some(sid);
                        } else {
                            info!(
                                "Diarization candidate speaker change ignored: {} -> {} (confidence {:.3}, reliable={})",
                                current_sid,
                                sid,
                                confidence,
                                is_reliable
                            );
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    // Emit periodic VAD voice activity events every 500ms
    if let Some(app) = app_handle {
        let now = std::time::Instant::now();
        if now.duration_since(session.last_vad_event_time).as_millis() >= 500 {
            super::emit_voice_activity_event(
                app,
                "system",
                session.is_voice_active,
                session_id_counter,
            );
            session.last_vad_event_time = now;
        }
    }

    if let Some(last_voice) = session.last_voice_sample {
        // Use dynamic silence timeout when diarization is active:
        // 3.0s for same speaker (natural pauses), 1.5s for different/unknown speaker
        #[cfg(feature = "diarization")]
        let timeout = {
            const DIARIZATION_SAME_SPEAKER_SILENCE_TIMEOUT: usize = 48_000; // 3.0s @ 16kHz
            let same_speaker = match (&session.current_session_speaker_id, &session.last_finalized_speaker_id) {
                (Some(current), Some(last)) => current == last,
                _ => false,
            };
            if same_speaker { DIARIZATION_SAME_SPEAKER_SILENCE_TIMEOUT } else { 24_000 }
        };
        #[cfg(not(feature = "diarization"))]
        let timeout = SILENCE_TIMEOUT_SAMPLES;

        if session.session_samples - last_voice >= timeout {
            finalize_system_audio_session(session, "silence_timeout", app_handle, language);
        }
    }

    if session.session_samples >= current_session_max_samples() {
        finalize_system_audio_session(session, "session_max_duration", app_handle, language);
    }

    if session.session_samples - session.last_partial_emit_samples
        >= session.partial_transcript_interval_samples
    {
        queue_system_audio_transcription(session, false, app_handle, language);
        session.last_partial_emit_samples = session.session_samples;
    }
}

fn queue_system_audio_transcription(
    session: &SystemAudioSession,
    is_final: bool,
    app_handle: Option<&AppHandle>,
    language: Option<&str>,
) {
    if session.session_audio.is_empty() {
        return;
    }
    // Suppress non-final partials until diarization assigns a speaker to avoid
    // emitting unlabeled "System" bubbles before the speaker is known.
    #[cfg(feature = "diarization")]
    if session.awaiting_first_speaker && !is_final {
        return;
    }
    unsafe {
        let state_ptr = addr_of!(RECORDING_STATE);
        let Some(state_arc) = (*state_ptr).as_ref() else {
            return;
        };
        let state_guard = state_arc.lock();
        if state_guard.suppress_transcription {
            return;
        }
        let Some(tx) = state_guard.transcription_tx.as_ref() else {
            error!("Transcription worker not running; cannot queue system transcription");
            return;
        };

        let audio = session.session_audio.clone();
        let language = language
            .map(|s| s.to_string())
            .or_else(|| state_guard.language.clone())
            .or_else(|| Some("en".to_string()));
        let session_id_counter = state_guard
            .transcription_state(TranscriptionSource::System)
            .session_id_counter;

        queue_transcription_with_source(
            audio,
            language,
            session_id_counter,
            TranscriptionSource::System,
            is_final,
            tx,
            session.current_session_speaker_id.clone(),
        );

        if let Some(app) = app_handle {
            drop(state_guard);
            super::emit_voice_activity_event(app, "system", session.is_voice_active, session_id_counter);
        }
    }
}

fn finalize_system_audio_session(
    session: &mut SystemAudioSession,
    reason: &str,
    app_handle: Option<&AppHandle>,
    language: Option<&str>,
) {
    if session.session_audio.is_empty() {
        reset_system_audio_session_tracking(session);
        return;
    }

    queue_system_audio_transcription(session, true, app_handle, language);

    unsafe {
        let state_ptr = addr_of!(RECORDING_STATE);
        if let Some(state_arc) = (*state_ptr).as_ref() {
            let mut state = state_arc.lock();
            let save_enabled = state.recording_save_enabled;
            let recording_dir = state.current_recording_dir.clone();
            let is_recording = state.is_recording;
            let session_id_counter = state
                .transcription_state(TranscriptionSource::System)
                .session_id_counter;

            // Eagerly advance the session counter so the next chunk of audio
            // (which may arrive before the worker processes the final above)
            // gets a new session_id and renders as a separate UI bubble.
            {
                let sys_state = state.transcription_state_mut(TranscriptionSource::System);
                sys_state.session_id_counter = sys_state.session_id_counter.wrapping_add(1);
                sys_state.message_id_counter = 0;
                sys_state.transcribed_samples = 0;
            }
            drop(state);

            crate::audio::finalize_session_common(
                &session.session_audio,
                session_id_counter,
                reason,
                "system",
                save_enabled,
                is_recording,
                recording_dir.as_deref(),
            );
        }
    }

    let prev_speaker = session.current_session_speaker_id.clone();
    reset_system_audio_session_tracking(session);
    session.last_finalized_speaker_id = prev_speaker;
    // Only gate partials when diarization is actually enabled at runtime
    #[cfg(feature = "diarization")]
    {
        session.awaiting_first_speaker = crate::DIARIZATION_MANAGER
            .get()
            .map(|m| m.lock().is_enabled())
            .unwrap_or(false);
    }
}

pub fn finalize_active_system_audio_session(reason: &str) {
    unsafe {
        let session_ptr = addr_of_mut!(SYSTEM_AUDIO_SESSION);
        let Some(session) = (*session_ptr).as_mut() else {
            return;
        };

        let app_handle_ptr = addr_of!(APP_HANDLE);
        let app_handle = (*app_handle_ptr).as_ref();

        let state_ptr = addr_of!(RECORDING_STATE);
        let language = (*state_ptr)
            .as_ref()
            .and_then(|state_arc| state_arc.lock().language.clone());

        finalize_system_audio_session(session, reason, app_handle, language.as_deref());
    }
}

pub fn start_system_audio_capture(
    state: Arc<ParkingMutex<RecordingState>>,
    app_handle: AppHandle,
) -> Result<(), String> {
    unsafe {
        let (vad_threshold, partial_interval) = {
            let mut state_guard = state.lock();

            ensure_transcription_worker(&mut state_guard, app_handle.clone());

            (
                state_guard.vad_threshold,
                state_guard.partial_transcript_interval_samples,
            )
        };

        let vad = VoiceActivityDetector::builder()
            .sample_rate(16000)
            .chunk_size(VAD_CHUNK_SIZE)
            .build()
            .map_err(|e| format!("Failed to initialize VAD: {:?}", e))?;

        SYSTEM_AUDIO_SESSION = Some(SystemAudioSession {
            session_audio: Vec::new(),
            vad,
            vad_pending: Vec::new(),
            pre_buffer: Vec::new(),
            post_buffer_remaining: 0,
            vad_threshold,
            session_samples: 0,
            last_voice_sample: None,
            last_partial_emit_samples: 0,
            partial_transcript_interval_samples: partial_interval,
            last_vad_event_time: std::time::Instant::now(),
            is_voice_active: false,
            current_session_speaker_id: None,
            last_diarization_samples: 0,
            last_finalized_speaker_id: None,
            awaiting_first_speaker: false,
        });

        APP_HANDLE = Some(app_handle);
        RECORDING_STATE = Some(state.clone());

        crate::ensure_diarization_initialized();

        let result = system_audio_start(audio_callback);

        if result == 0 {
            let mut state_guard = state.lock();
            state_guard.system_audio_enabled = true;

            info!("System audio capture started");

            Ok(())
        } else if result == -2 {
            Err("System audio capture requires macOS 12.3+".to_string())
        } else {
            Err(format_system_audio_error("Failed to start system audio capture"))
        }
    }
}

pub fn stop_system_audio_capture(state: Arc<ParkingMutex<RecordingState>>) -> Result<(), String> {
    unsafe {
        {
            let state_guard = state.lock();
            let session_ptr = addr_of!(SYSTEM_AUDIO_SESSION);
            let no_active_session = (*session_ptr).is_none();
            if !state_guard.system_audio_enabled && no_active_session {
                debug!("System audio capture already stopped");
                return Ok(());
            }
        }

        // Flush pending local/system session before tearing down globals.
        finalize_active_system_audio_session("system_audio_capture_stopped");

        let result = system_audio_stop();

        let mut state_guard = state.lock();
        state_guard.system_audio_enabled = false;

        SYSTEM_AUDIO_SESSION = None;
        APP_HANDLE = None;
        RECORDING_STATE = None;

        info!("System audio capture stopped");

        if result == 0 {
            Ok(())
        } else {
            Err(format_system_audio_error("Failed to stop system audio capture"))
        }
    }
}

pub fn update_language(language: Option<String>) -> Result<(), String> {
    unsafe {
        let state_ptr = addr_of!(RECORDING_STATE);
        if let Some(state_arc) = (*state_ptr).as_ref() {
            let mut state_guard = state_arc.lock();
            state_guard.language = language.clone();
            drop(state_guard);

            let lang_str = language.as_deref().unwrap_or("auto");
            info!("System Language updated to: {}", lang_str);
        }
    }

    Ok(())
}

pub fn set_transcription_suppressed(suppressed: bool) {
    if !suppressed {
        return;
    }
    unsafe {
        let session_ptr = addr_of_mut!(SYSTEM_AUDIO_SESSION);
        if let Some(session) = (*session_ptr).as_mut() {
            reset_system_audio_session_tracking(session);
        }
    }
}
