# Speaker Diarization Design

## Goal

Track and label every unique voice in system audio. Once a speaker is labeled (e.g., "Alice"), that voice is automatically recognized and labeled in all future utterances, persisting across app restarts.

## Requirements

- Speaker diarization on **system audio only** (mic always = "You")
- Voices auto-tracked as "Speaker 1", "Speaker 2", etc.
- Click-to-rename: user labels a speaker, all future utterances from that voice use the label
- **Persistent across restarts**: voice profiles (embeddings + labels) saved to disk
- Speaker embedding model **auto-downloaded** on first use
- All behind `--features diarization` feature flag

## Approach

Wire up the existing `diarization/` module (sherpa-onnx speaker embeddings + cosine-similarity tracker). The backend code is ~80% built; the work is connecting it to the system audio pipeline, adding persistence, and updating the frontend to use backend-provided speaker IDs.

## Design

### 1. Model Auto-Download & Initialization

**Model:** `3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx` (~25MB) from sherpa-onnx release assets.

**Download logic:**
- Check `{app_data_dir}/models/speaker-embedding/` for the model file
- If missing, download from GitHub releases (same pattern as whisper model downloads in `whisper.rs`)
- If download fails or `diarization` feature not enabled, `DiarizationManager` initializes as disabled — app works normally without diarization

**When to initialize:** During `start_system_audio_capture()`, not at app startup. Avoids loading the model when user only uses mic.

### 2. Wiring Diarization into System Audio Pipeline

**Hook point:** When a system audio session is finalized (`finalize_system_audio_session()`):

1. Takes the completed `session_audio` buffer
2. Passes to `DIARIZATION_MANAGER.process_utterance(audio, 16000)`
3. Gets back `DiarizationResult` with `speaker_id` (e.g., `"speaker_1"`)
4. `speaker_id` threaded through `TranscriptionCommand` -> `transcribe_and_emit` -> `emit_transcription_segment`

**`TranscriptionCommand` change:**
```rust
TranscriptionCommand::Run {
    audio: Vec<f32>,
    language: Option<String>,
    source: TranscriptionSource,
    session_id_counter: u64,
    is_final: bool,
    speaker_id: Option<String>,  // NEW
}
```

**Partial transcripts:** Run diarization once at session start (when ~1.5s of audio accumulates). Reuse that `speaker_id` for all partials in the same session.

**Mic source:** Always `speaker_id: None`.

### 3. Persistence — Speaker Profiles

**Storage:** `{app_config_dir}/speaker-profiles.json`

```json
{
  "speakers": [
    {
      "speaker_id": "speaker_1",
      "display_name": "Alice",
      "centroid": [0.12, -0.34, ...],
      "utterance_count": 47
    }
  ],
  "next_id": 4
}
```

**Save triggers:**
- On `rename_speaker` (user labels someone)
- On session finalize when a new speaker is created or centroid updated
- Debounced: save at most once per 5 seconds

**Load:** When `DiarizationManager` initializes during first system audio capture start. Populates `SpeakerTracker` with stored centroids + display names.

**Reset:** `reset_speakers` command clears in-memory state AND deletes the persisted file.

### 4. Frontend — Speaker Labels from Backend

**Event flow changes:**
- `transcription-segment` events with `speakerId` set: use the speaker's `display_name` instead of generic "System"
- `speakerId` null + source "system": falls back to "System" (diarization disabled or insufficient audio)
- Source "user": always "You"

**Rename flow:**
1. User clicks "Speaker 2", types "Bob"
2. Frontend calls `invoke("rename_speaker", { speakerId: "speaker_2", displayName: "Bob" })`
3. Backend updates tracker + persists to disk
4. Backend emits `speaker-updated` event
5. Frontend updates all sessions sharing that `speakerId` to show "Bob"
6. Future utterances from that voice automatically arrive labeled "Bob"

**Participants list:** Auto-populated from detected speakers via `get_speakers` command. Called on system audio start and after new speakers detected.

## Changes Summary

| Area | Change |
|------|--------|
| Model download | Auto-download speaker embedding ONNX model |
| `DIARIZATION_MANAGER` init | Initialize in `start_system_audio_capture()` |
| `system_audio.rs` | Run diarization at session finalize, attach `speaker_id` |
| `TranscriptionCommand` | Add `speaker_id: Option<String>` |
| `worker.rs` | Thread `speaker_id` through to `emit_transcription_segment` |
| `extractor.rs` | Clean up sample-feeding logic |
| Persistence | `speaker-profiles.json` save/load, debounced writes |
| `commands.rs` | `rename_speaker` triggers persist + `speaker-updated` event |
| Frontend `App.tsx` | Use `speakerId` from segments, listen for `speaker-updated`, populate participants from `get_speakers`, wire rename to backend |

## Unchanged

- Mic path (always "You")
- `SpeakerChip` UI component (same click-to-rename UX)
- `SpeakerTracker` core algorithm (cosine similarity + running centroid)
- `DiarizationConfig` defaults (0.55 threshold, 10 max speakers, 1.5s min audio)
- Feature flag gating (`--features diarization`)

## Eng Review Findings (2026-04-08)

### Architecture Decisions
1. **Strip sherpa-onnx SpeakerEmbeddingManager** — `extractor.rs` becomes a pure embedding extractor. Remove `_manager` field and all wrapper methods (`search_speaker`, `add_speaker`, etc.). `SpeakerTracker` is the sole matching engine.
2. **Run diarization off the audio callback thread** — Embedding extraction (~50-200ms) runs on the transcription worker thread, not the unsafe C audio callback. Flow: callback queues audio → worker extracts embedding → matches speaker → transcribes → emits with `speaker_id`.

### Code Quality Fixes
3. **Fix extractor.rs dead loop + precision loss** — Remove broken sample-per-stream loop (lines 66-82). Feed f32 audio directly to `stream.push_raw_samples(&audio_f32)` in a single batch call (not per-sample). Eliminates dead code, f32→i16→f32 precision loss, and 24K unnecessary FFI crossings.
4. **Align manager.rs types with extractor** — Fix `DiarizationManager` to use `SpeakerExtractor` (correct struct name) and handle `Option` returns from `extract()` instead of `Result`.

### Test Requirements
5. **Unit tests for SpeakerTracker** — `match_or_create` (match above threshold, new speaker, at max capacity), `rename` (existing/non-existent), `reset`, `cosine_similarity`, centroid update correctness.
6. **Unit tests for persistence** — Save/load round-trip, corrupted JSON graceful fallback, reset deletes file.

### Performance
7. **Batch audio feed** — Single `push_raw_samples(&audio_f32)` call instead of per-sample feeding.

### Data Flow Diagram

```
System Audio Callback (fast, unsafe C)
  │
  ├── VAD filtering
  ├── Session audio accumulation
  └── finalize → queue_system_audio_transcription(audio)
                    │
                    ▼
        Transcription Worker Thread (heavy work)
          │
          ├── Extract speaker embedding (ONNX, ~100ms)
          ├── Match/create speaker via SpeakerTracker
          ├── Transcribe via whisper/LLM
          └── emit_transcription_segment(text, speaker_id)
                    │
                    ▼
              Frontend (App.tsx)
                ├── Display with speaker label
                └── SpeakerChip → rename_speaker → persist
```

### NOT In Scope
- Speaker diarization on mic input (system audio only)
- Real-time speaker change detection mid-utterance
- Speaker verification (confirm identity)
- Frontend speaker management panel (click-to-rename only)
- Cross-session speaker merging
- E2E/integration tests (require hardware + model downloads)

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR (PLAN) | 5 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |

**VERDICT:** ENG CLEARED — all issues resolved, 0 critical gaps, 19 test paths planned.
