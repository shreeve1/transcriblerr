# Speaker Diarization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Track and label every unique voice in system audio with persistent speaker profiles across app restarts.

**Architecture:** Wire the existing `diarization/` module into the system audio → transcription worker pipeline. Speaker embeddings extracted on the worker thread (not audio callback). Profiles persisted to JSON in app config dir. Frontend uses backend-provided `speakerId` for labels.

**Tech Stack:** Rust (Tauri 2, sherpa-onnx, parking_lot), React 18, TypeScript

**Design doc:** `docs/plans/2026-04-08-speaker-diarization-design.md`

---

### Task 1: Clean up extractor.rs — strip dead code and fix precision

**Files:**
- Modify: `apps/desktop/src-tauri/src/diarization/extractor.rs`

**Step 1: Rewrite extractor.rs**

Replace the entire file with a cleaned-up version that:
- Removes `_manager` field and all wrapper methods (`search_speaker`, `add_speaker`, `num_speakers`, `get_all_speakers`, `contains_speaker`)
- Removes the broken sample-per-stream loop (old lines 66-82)
- Removes the i16 intermediate conversion — feeds f32 directly to `push_raw_samples`
- Feeds the entire audio buffer in a single `push_raw_samples` call (batch, not per-sample)
- Renames struct from `SpeakerExtractor` to `SpeakerEmbeddingExtractor` (matches the import in manager.rs)

```rust
//! Wrapper around sherpa-onnx SpeakerEmbeddingExtractor.

use crate::diarization::types::DiarizationConfig;
use log::{debug, info, warn};
use std::path::Path;

/// Pure embedding extractor — extracts speaker embeddings from audio.
/// Speaker matching/tracking is handled by `SpeakerTracker`.
pub struct SpeakerEmbeddingExtractor {
    extractor: sherpa_onnx::SpeakerEmbeddingExtractor,
    config: DiarizationConfig,
}

impl SpeakerEmbeddingExtractor {
    /// Create a new extractor from `model_path`. Returns `None` if the model
    /// cannot be loaded.
    pub fn new(model_path: &Path) -> Option<Self> {
        let model_str = model_path.to_str().map(|s| s.to_string());

        let extractor_cfg = sherpa_onnx::SpeakerEmbeddingExtractorConfig {
            model: model_str,
            num_threads: 1,
            debug: false,
            provider: Some("cpu".to_string()),
        };

        let extractor = sherpa_onnx::SpeakerEmbeddingExtractor::create(&extractor_cfg)?;
        let dim = extractor.dim();

        info!(
            "Speaker embedding extractor initialized (model={:?}, dim={})",
            model_path, dim
        );

        Some(Self { extractor, config: DiarizationConfig::default() })
    }

    /// Compute a speaker embedding from raw 16 kHz mono f32 audio.
    /// Returns `None` if the audio is too short or extraction fails.
    pub fn extract(&self, audio_16k_mono: &[f32]) -> Option<Vec<f32>> {
        let min_samples = (self.config.min_audio_seconds * 16_000.0) as usize;
        if audio_16k_mono.len() < min_samples {
            debug!(
                "Audio too short for embedding: {} samples < {} required",
                audio_16k_mono.len(),
                min_samples
            );
            return None;
        }

        let mut stream = self.extractor.create_stream()?;
        stream.push_raw_samples(audio_16k_mono);

        if !self.extractor.is_ready(&stream) {
            warn!("SpeakerEmbeddingExtractor: stream not ready after feeding audio");
            return None;
        }

        self.extractor.compute(&stream)
    }
}
```

**Step 2: Verify it compiles**

Run: `cargo check --features diarization -p local-whisper`
Expected: Compiles (may have warnings about unused imports — that's fine, we'll fix in later tasks)

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/diarization/extractor.rs
git commit -m "refactor: clean up speaker embedding extractor - remove dead code, fix precision"
```

---

### Task 2: Fix manager.rs type alignment

**Files:**
- Modify: `apps/desktop/src-tauri/src/diarization/manager.rs`

**Step 1: Update manager to use correct types**

Replace the file to align with the actual `SpeakerEmbeddingExtractor` API (returns `Option`, not `Result`):

```rust
use std::path::Path;

use crate::diarization::extractor::SpeakerEmbeddingExtractor;
use crate::diarization::tracker::SpeakerTracker;
use crate::diarization::types::{DiarizationConfig, DiarizationResult, SpeakerInfo};

pub struct DiarizationManager {
    extractor: Option<SpeakerEmbeddingExtractor>,
    tracker: SpeakerTracker,
    config: DiarizationConfig,
    enabled: bool,
}

impl DiarizationManager {
    pub fn new(model_path: &Path, config: DiarizationConfig) -> Result<Self, String> {
        let extractor = SpeakerEmbeddingExtractor::new(model_path)
            .ok_or_else(|| format!("Failed to load speaker embedding model: {:?}", model_path))?;

        let tracker = SpeakerTracker::new(config.max_speakers, config.similarity_threshold);

        Ok(Self {
            extractor: Some(extractor),
            tracker,
            config,
            enabled: true,
        })
    }

    pub fn new_disabled() -> Self {
        Self {
            extractor: None,
            tracker: SpeakerTracker::new(10, 0.55),
            config: DiarizationConfig::default(),
            enabled: false,
        }
    }

    pub fn process_utterance(
        &mut self,
        audio_samples: &[f32],
        sample_rate: u32,
    ) -> DiarizationResult {
        if !self.enabled {
            return DiarizationResult::default();
        }

        let extractor = match self.extractor.as_ref() {
            Some(e) => e,
            None => return DiarizationResult::default(),
        };

        let duration_seconds = audio_samples.len() as f32 / sample_rate as f32;
        let is_reliable = duration_seconds >= self.config.min_audio_seconds;

        let embedding = match extractor.extract(audio_samples) {
            Some(emb) => emb,
            None => return DiarizationResult::default(),
        };

        let (speaker_id, confidence, _is_new) = self.tracker.match_or_create(&embedding);

        DiarizationResult {
            speaker_id: Some(speaker_id),
            confidence,
            is_reliable,
        }
    }

    pub fn rename_speaker(&mut self, speaker_id: &str, new_name: &str) -> Result<(), String> {
        if self.tracker.rename(speaker_id, new_name) {
            Ok(())
        } else {
            Err(format!("Speaker '{}' not found", speaker_id))
        }
    }

    pub fn list_speakers(&self) -> Vec<SpeakerInfo> {
        self.tracker.list_speakers()
    }

    pub fn reset(&mut self) {
        self.tracker.reset();
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn get_display_name(&self, speaker_id: &str) -> Option<String> {
        self.tracker.get_display_name(speaker_id)
    }

    /// Access the tracker for persistence operations.
    pub fn tracker(&self) -> &SpeakerTracker {
        &self.tracker
    }

    /// Mutable access to tracker for loading persisted state.
    pub fn tracker_mut(&mut self) -> &mut SpeakerTracker {
        &mut self.tracker
    }
}
```

**Step 2: Verify it compiles**

Run: `cargo check --features diarization -p local-whisper`
Expected: Compiles

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/diarization/manager.rs
git commit -m "fix: align DiarizationManager types with SpeakerEmbeddingExtractor API"
```

---

### Task 3: Add persistence to SpeakerTracker

**Files:**
- Modify: `apps/desktop/src-tauri/src/diarization/tracker.rs`
- Modify: `apps/desktop/src-tauri/src/diarization/mod.rs`

**Step 1: Add Serialize/Deserialize to tracker types and save/load methods**

Add to `tracker.rs` — make `TrackedSpeaker` serializable and add `save_to_file` / `load_from_file` methods to `SpeakerTracker`:

```rust
use serde::{Deserialize, Serialize};
use crate::diarization::types::SpeakerInfo;
use log::{info, warn};
use std::path::Path;

#[derive(Serialize, Deserialize)]
pub struct TrackedSpeaker {
    pub speaker_id: String,
    pub display_name: String,
    pub centroid: Vec<f32>,
    pub utterance_count: u32,
}

#[derive(Serialize, Deserialize)]
struct SpeakerProfilesFile {
    speakers: Vec<TrackedSpeaker>,
    next_id: usize,
}

pub struct SpeakerTracker {
    speakers: Vec<TrackedSpeaker>,
    max_speakers: usize,
    similarity_threshold: f32,
    next_id: usize,
    dirty: bool,
}
```

Add these methods to `impl SpeakerTracker`:

```rust
    /// Mark tracker as needing persistence.
    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Clear the dirty flag after saving.
    pub fn clear_dirty(&mut self) {
        self.dirty = false;
    }

    pub fn save_to_file(&self, path: &Path) -> Result<(), String> {
        let data = SpeakerProfilesFile {
            speakers: self.speakers.iter().map(|s| TrackedSpeaker {
                speaker_id: s.speaker_id.clone(),
                display_name: s.display_name.clone(),
                centroid: s.centroid.clone(),
                utterance_count: s.utterance_count,
            }).collect(),
            next_id: self.next_id,
        };
        let json = serde_json::to_string_pretty(&data)
            .map_err(|e| format!("Failed to serialize speaker profiles: {}", e))?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create profile dir: {}", e))?;
        }
        std::fs::write(path, json)
            .map_err(|e| format!("Failed to write speaker profiles: {}", e))?;
        info!("Saved {} speaker profiles to {}", self.speakers.len(), path.display());
        Ok(())
    }

    pub fn load_from_file(&mut self, path: &Path) -> Result<(), String> {
        if !path.exists() {
            return Ok(());
        }
        let raw = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read speaker profiles: {}", e))?;
        let data: SpeakerProfilesFile = serde_json::from_str(&raw)
            .map_err(|e| {
                warn!("Corrupted speaker profiles at {}: {} — starting fresh", path.display(), e);
                format!("Corrupted speaker profiles: {}", e)
            })?;
        self.speakers = data.speakers;
        self.next_id = data.next_id;
        self.dirty = false;
        info!("Loaded {} speaker profiles from {}", self.speakers.len(), path.display());
        Ok(())
    }
```

Also update `match_or_create` and `rename` to set `self.dirty = true` when state changes, and update `reset` to set `self.dirty = true`. Update `new` to initialize `dirty: false`.

**Step 2: Update mod.rs exports**

No change needed — `DiarizationManager` already re-exports what's needed.

**Step 3: Verify it compiles**

Run: `cargo check --features diarization -p local-whisper`
Expected: Compiles

**Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/diarization/tracker.rs
git commit -m "feat: add speaker profile persistence to SpeakerTracker"
```

---

### Task 4: Write unit tests for SpeakerTracker

**Files:**
- Modify: `apps/desktop/src-tauri/src/diarization/tracker.rs` (add `#[cfg(test)]` module)

**Step 1: Write tests**

Add at the bottom of `tracker.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn make_embedding(seed: f32, dim: usize) -> Vec<f32> {
        (0..dim).map(|i| (seed + i as f32 * 0.1).sin()).collect()
    }

    #[test]
    fn test_new_speaker_created() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb = make_embedding(1.0, 192);
        let (id, _sim, is_new) = tracker.match_or_create(&emb);
        assert!(is_new);
        assert_eq!(id, "speaker_1");
        assert_eq!(tracker.list_speakers().len(), 1);
    }

    #[test]
    fn test_same_embedding_matches() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb = make_embedding(1.0, 192);
        let (id1, _, _) = tracker.match_or_create(&emb);
        let (id2, sim, is_new) = tracker.match_or_create(&emb);
        assert!(!is_new);
        assert_eq!(id1, id2);
        assert!(sim > 0.99);
    }

    #[test]
    fn test_different_embeddings_create_new_speakers() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb1 = make_embedding(1.0, 192);
        let emb2 = make_embedding(100.0, 192); // very different
        let (id1, _, _) = tracker.match_or_create(&emb1);
        let (id2, _, is_new) = tracker.match_or_create(&emb2);
        assert!(is_new);
        assert_ne!(id1, id2);
        assert_eq!(tracker.list_speakers().len(), 2);
    }

    #[test]
    fn test_max_speakers_assigns_to_nearest() {
        let mut tracker = SpeakerTracker::new(2, 0.55);
        let emb1 = make_embedding(1.0, 192);
        let emb2 = make_embedding(100.0, 192);
        let emb3 = make_embedding(1.1, 192); // close to emb1
        tracker.match_or_create(&emb1);
        tracker.match_or_create(&emb2);
        let (id3, _, is_new) = tracker.match_or_create(&emb3);
        assert!(!is_new); // should match existing, not create new
        assert_eq!(tracker.list_speakers().len(), 2);
        assert_eq!(id3, "speaker_1"); // closest to emb1
    }

    #[test]
    fn test_rename_existing_speaker() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb = make_embedding(1.0, 192);
        tracker.match_or_create(&emb);
        assert!(tracker.rename("speaker_1", "Alice"));
        assert_eq!(tracker.get_display_name("speaker_1"), Some("Alice".to_string()));
    }

    #[test]
    fn test_rename_nonexistent_returns_false() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        assert!(!tracker.rename("speaker_99", "Nobody"));
    }

    #[test]
    fn test_reset_clears_all() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb = make_embedding(1.0, 192);
        tracker.match_or_create(&emb);
        assert_eq!(tracker.list_speakers().len(), 1);
        tracker.reset();
        assert_eq!(tracker.list_speakers().len(), 0);
        // Next speaker should be speaker_1 again
        let (id, _, _) = tracker.match_or_create(&emb);
        assert_eq!(id, "speaker_1");
    }

    #[test]
    fn test_centroid_update() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb1 = make_embedding(1.0, 192);
        tracker.match_or_create(&emb1);
        let speakers = tracker.list_speakers();
        assert_eq!(speakers[0].utterance_count, 1);
        // Feed same embedding again
        tracker.match_or_create(&emb1);
        let speakers = tracker.list_speakers();
        assert_eq!(speakers[0].utterance_count, 2);
    }

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![0.0, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn test_dirty_flag() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        assert!(!tracker.is_dirty());
        let emb = make_embedding(1.0, 192);
        tracker.match_or_create(&emb);
        assert!(tracker.is_dirty());
        tracker.clear_dirty();
        assert!(!tracker.is_dirty());
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let dir = std::env::temp_dir().join("local-whisper-test-profiles");
        let path = dir.join("speaker-profiles.json");
        let _ = std::fs::remove_file(&path);

        let mut tracker = SpeakerTracker::new(10, 0.55);
        let emb1 = make_embedding(1.0, 192);
        let emb2 = make_embedding(100.0, 192);
        tracker.match_or_create(&emb1);
        tracker.match_or_create(&emb2);
        tracker.rename("speaker_1", "Alice");
        tracker.save_to_file(&path).unwrap();

        let mut tracker2 = SpeakerTracker::new(10, 0.55);
        tracker2.load_from_file(&path).unwrap();
        assert_eq!(tracker2.list_speakers().len(), 2);
        assert_eq!(tracker2.get_display_name("speaker_1"), Some("Alice".to_string()));
        assert_eq!(tracker2.get_display_name("speaker_2"), Some("Speaker 2".to_string()));

        // New speaker should get id 3
        let emb3 = make_embedding(200.0, 192);
        let (id, _, _) = tracker2.match_or_create(&emb3);
        assert_eq!(id, "speaker_3");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_load_missing_file_is_ok() {
        let mut tracker = SpeakerTracker::new(10, 0.55);
        let result = tracker.load_from_file(&PathBuf::from("/nonexistent/path.json"));
        assert!(result.is_ok());
        assert_eq!(tracker.list_speakers().len(), 0);
    }

    #[test]
    fn test_load_corrupted_file_returns_error() {
        let dir = std::env::temp_dir().join("local-whisper-test-corrupted");
        let path = dir.join("speaker-profiles.json");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(&path, "not valid json {{{").unwrap();

        let mut tracker = SpeakerTracker::new(10, 0.55);
        let result = tracker.load_from_file(&path);
        assert!(result.is_err());
        assert_eq!(tracker.list_speakers().len(), 0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
```

**Step 2: Run the tests**

Run: `cargo test --features diarization -p local-whisper -- diarization::tracker::tests`
Expected: All 13 tests pass

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/diarization/tracker.rs
git commit -m "test: add unit tests for SpeakerTracker and profile persistence"
```

---

### Task 5: Add speaker_id to TranscriptionCommand and thread through worker

**Files:**
- Modify: `apps/desktop/src-tauri/src/transcription/mod.rs`
- Modify: `apps/desktop/src-tauri/src/transcription/worker.rs`

**Step 1: Add speaker_id to TranscriptionCommand**

In `transcription/mod.rs`, add `speaker_id` field to the `Run` variant:

```rust
#[derive(Debug, Clone)]
pub enum TranscriptionCommand {
    Run {
        audio: Vec<f32>,
        language: Option<String>,
        source: TranscriptionSource,
        session_id_counter: u64,
        is_final: bool,
        speaker_id: Option<String>,
    },
    Stop,
}
```

**Step 2: Update worker.rs to thread speaker_id through**

In `worker.rs`:
- Update `spawn_transcription_worker` — all destructures of `TranscriptionCommand::Run` need to include `speaker_id`
- Update `all_commands` tuple to include `speaker_id`
- Pass `speaker_id` through to `transcribe_and_emit`
- Update `transcribe_and_emit` to accept and forward `speaker_id`
- Update `transcribe_and_emit_common` to accept and forward `speaker_id` to `emit_transcription_segment`

Key change in `transcribe_and_emit_common` — replace the `None` in `emit_transcription_segment`:

```rust
emit_transcription_segment(
    app_handle,
    text,
    Some(audio_to_transcribe.to_vec()),
    session_id_counter,
    next_message_id,
    is_final,
    source.to_string(),
    speaker_id.clone(),  // was: None
)?;
```

Also update `queue_transcription_with_source` to accept `speaker_id: Option<String>` and include it in the `TranscriptionCommand::Run`.

Update `queue_transcription` (mic path) to pass `speaker_id: None`.

**Step 3: Verify it compiles**

Run: `cargo check --features diarization -p local-whisper`
Expected: Compiles (system_audio.rs may need updating too — that's Task 6)

**Step 4: Commit**

```bash
git add apps/desktop/src-tauri/src/transcription/mod.rs apps/desktop/src-tauri/src/transcription/worker.rs
git commit -m "feat: thread speaker_id through TranscriptionCommand to emit"
```

---

### Task 6: Initialize diarization manager and wire into system audio

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs`
- Modify: `apps/desktop/src-tauri/src/system_audio.rs`
- Modify: `apps/desktop/src-tauri/src/commands.rs`

**Step 1: Add model auto-download and DIARIZATION_MANAGER initialization**

In `lib.rs`, add a function to initialize diarization (called from `start_system_audio_capture`):

```rust
#[cfg(feature = "diarization")]
fn speaker_profiles_path() -> Result<std::path::PathBuf, String> {
    let app_handle = APP_HANDLE.get().ok_or("App not initialized")?;
    let mut dir = app_handle
        .path()
        .app_config_dir()
        .map_err(|e| format!("Failed to resolve app config dir: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create app config dir: {e}"))?;
    dir.push("speaker-profiles.json");
    Ok(dir)
}

#[cfg(feature = "diarization")]
fn ensure_diarization_initialized() {
    use crate::diarization::{DiarizationConfig, DiarizationManager};

    if DIARIZATION_MANAGER.get().is_some() {
        return;
    }

    // Try to find or download the speaker embedding model
    let model_dir = match speaker_embedding_model_dir() {
        Ok(d) => d,
        Err(e) => {
            warn!("Cannot resolve speaker embedding model dir: {}", e);
            let _ = DIARIZATION_MANAGER.set(Arc::new(ParkingMutex::new(DiarizationManager::new_disabled())));
            return;
        }
    };

    let model_filename = "3dspeaker_speech_eres2net_base_sv_zh-cn_3dspeaker_16k.onnx";
    let model_path = model_dir.join(model_filename);

    if !model_path.exists() {
        info!("Speaker embedding model not found, attempting download...");
        // Download synchronously (runs on worker thread context)
        match download_speaker_model_blocking(&model_dir, model_filename) {
            Ok(_) => info!("Speaker embedding model downloaded"),
            Err(e) => {
                warn!("Failed to download speaker embedding model: {}", e);
                let _ = DIARIZATION_MANAGER.set(Arc::new(ParkingMutex::new(DiarizationManager::new_disabled())));
                return;
            }
        }
    }

    let config = DiarizationConfig::default();
    match DiarizationManager::new(&model_path, config) {
        Ok(mut manager) => {
            // Load persisted speaker profiles
            if let Ok(profiles_path) = speaker_profiles_path() {
                if let Err(e) = manager.tracker_mut().load_from_file(&profiles_path) {
                    warn!("Failed to load speaker profiles: {}", e);
                }
            }
            let _ = DIARIZATION_MANAGER.set(Arc::new(ParkingMutex::new(manager)));
            info!("Diarization manager initialized");
        }
        Err(e) => {
            warn!("Failed to initialize diarization: {}", e);
            let _ = DIARIZATION_MANAGER.set(Arc::new(ParkingMutex::new(DiarizationManager::new_disabled())));
        }
    }
}

#[cfg(feature = "diarization")]
fn speaker_embedding_model_dir() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME")
        .map_err(|_| "Failed to resolve HOME".to_string())?;
    let dir = std::path::PathBuf::from(home)
        .join("Library/Application Support/local-whisper/models/speaker-embedding");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create speaker embedding model dir: {}", e))?;
    Ok(dir)
}

#[cfg(feature = "diarization")]
fn download_speaker_model_blocking(
    model_dir: &std::path::Path,
    filename: &str,
) -> Result<(), String> {
    let url = format!(
        "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/{}",
        filename
    );
    let target_path = model_dir.join(filename);
    let tmp_path = target_path.with_extension("download");

    let response = reqwest::blocking::get(&url)
        .map_err(|e| format!("Download failed: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Download failed with status {}", response.status()));
    }

    let bytes = response.bytes()
        .map_err(|e| format!("Failed to read response: {}", e))?;

    std::fs::write(&tmp_path, &bytes)
        .map_err(|e| format!("Failed to write model file: {}", e))?;

    std::fs::rename(&tmp_path, &target_path)
        .map_err(|e| format!("Failed to move model file: {}", e))?;

    Ok(())
}
```

**Step 2: Wire diarization into system audio pipeline**

In `system_audio.rs`, update `start_system_audio_capture` to call `ensure_diarization_initialized()`.

Add a `current_session_speaker_id` field to `SystemAudioSession`:
```rust
current_session_speaker_id: Option<String>,
```

In `process_system_audio_sample_local`, when VAD detects voice becoming active and enough audio accumulates (~1.5s = 24000 samples), run diarization to get the speaker ID for this session. Store it in `session.current_session_speaker_id`.

In `queue_system_audio_transcription`, pass `session.current_session_speaker_id.clone()` to `queue_transcription_with_source`.

In `reset_system_audio_session_tracking`, reset `current_session_speaker_id` to `None`.

**Step 3: Update commands.rs — rename_speaker triggers persist + event**

In `commands.rs`, update `rename_speaker` to persist and emit event:

```rust
#[tauri::command]
fn rename_speaker(speaker_id: String, display_name: String) -> Result<(), String> {
    let manager = crate::DIARIZATION_MANAGER
        .get()
        .ok_or("Diarization not initialized")?;
    let mut guard = manager.lock();
    guard.rename_speaker(&speaker_id, &display_name)?;

    // Persist profiles
    #[cfg(feature = "diarization")]
    if let Ok(path) = crate::speaker_profiles_path() {
        if let Err(e) = guard.tracker().save_to_file(&path) {
            log::warn!("Failed to persist speaker profiles after rename: {}", e);
        }
    }

    // Emit event so frontend updates all sessions with this speaker
    if let Some(app) = crate::APP_HANDLE.get() {
        let _ = app.emit("speaker-updated", serde_json::json!({
            "speakerId": speaker_id,
            "displayName": display_name,
        }));
    }

    Ok(())
}
```

Also update `reset_speakers` to delete the profiles file:

```rust
#[tauri::command]
fn reset_speakers() -> Result<(), String> {
    let manager = crate::DIARIZATION_MANAGER
        .get()
        .ok_or("Diarization not initialized")?;
    manager.lock().reset();

    #[cfg(feature = "diarization")]
    if let Ok(path) = crate::speaker_profiles_path() {
        let _ = std::fs::remove_file(&path);
    }

    Ok(())
}
```

**Step 4: Verify it compiles**

Run: `cargo check --features diarization -p local-whisper`
Expected: Compiles

**Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/system_audio.rs apps/desktop/src-tauri/src/commands.rs
git commit -m "feat: wire diarization into system audio pipeline with auto-download and persistence"
```

---

### Task 7: Debounced profile persistence on centroid updates

**Files:**
- Modify: `apps/desktop/src-tauri/src/transcription/worker.rs`

**Step 1: Add debounced save after diarization updates**

In the transcription worker, after processing a system audio transcription that ran diarization (when `speaker_id.is_some()`), check if the tracker is dirty and save if more than 5 seconds have elapsed since last save.

Add a `last_profile_save: Instant` to the worker thread's local state, and after each system source transcription:

```rust
#[cfg(feature = "diarization")]
{
    if speaker_id.is_some() && last_profile_save.elapsed().as_secs() >= 5 {
        if let Some(manager) = crate::DIARIZATION_MANAGER.get() {
            let mut guard = manager.lock();
            if guard.tracker().is_dirty() {
                if let Ok(path) = crate::speaker_profiles_path() {
                    if let Err(e) = guard.tracker().save_to_file(&path) {
                        log::warn!("Failed to persist speaker profiles: {}", e);
                    }
                    guard.tracker_mut().clear_dirty();
                }
            }
        }
        last_profile_save = std::time::Instant::now();
    }
}
```

**Step 2: Verify it compiles**

Run: `cargo check --features diarization -p local-whisper`
Expected: Compiles

**Step 3: Commit**

```bash
git add apps/desktop/src-tauri/src/transcription/worker.rs
git commit -m "feat: add debounced speaker profile persistence on centroid updates"
```

---

### Task 8: Frontend — use speakerId from backend

**Files:**
- Modify: `apps/desktop/src/App.tsx`

**Step 1: Update session creation to use speakerId**

In the `transcription-segment` event handler (around line 576-594), when creating a new session, check if the segment has a `speakerId`. If so, fetch the display name:

```typescript
// When a new session is created with a speakerId, use the display name
const getSpeakerLabel = async (segment: TranscriptionSegment): Promise<string> => {
  if (segment.source === "user") return "You";
  if (segment.speakerId) {
    try {
      const speakers = await invoke<Array<{ speaker_id: string; display_name: string }>>("get_speakers");
      const match = speakers.find(s => s.speaker_id === segment.speakerId);
      if (match) return match.display_name;
    } catch { /* fall through */ }
  }
  return sourceDefaultSpeakerRef.current[segment.source] ?? sourceLabel(segment.source);
};
```

Update the `SessionTranscription` interface to track `speakerId`:

```typescript
interface SessionTranscription {
  sessionKey: string;
  sessionId: number;
  source: string;
  speaker: string;
  speakerId?: string;  // NEW — backend speaker ID for rename wiring
  messages: TranscriptionSegment[];
  audioChunks: Record<number, number[]>;
}
```

When creating a new session, store `speakerId` from the segment and use the display name for the `speaker` field.

**Step 2: Listen for speaker-updated event**

Add a listener for `speaker-updated` that updates all sessions matching the `speakerId`:

```typescript
useEffect(() => {
  const unlisten = listen<{ speakerId: string; displayName: string }>("speaker-updated", (event) => {
    setTranscriptions(prev =>
      prev.map(s =>
        s.speakerId === event.payload.speakerId
          ? { ...s, speaker: event.payload.displayName }
          : s
      )
    );
  });
  return () => { unlisten.then(fn => fn()); };
}, []);
```

**Step 3: Wire SpeakerChip rename to backend**

Update `handleChangeSpeaker` to call `rename_speaker` when the session has a `speakerId`:

```typescript
const handleChangeSpeaker = useCallback(async (sessionKey: string, name: string) => {
  setTranscriptions(prev => {
    const target = prev.find(s => s.sessionKey === sessionKey);
    if (target) {
      sourceDefaultSpeakerRef.current = { ...sourceDefaultSpeakerRef.current, [target.source]: name };

      // If this session has a backend speaker ID, rename via backend
      if (target.speakerId) {
        invoke("rename_speaker", { speakerId: target.speakerId, displayName: name }).catch(() => {});
      }
    }
    return prev.map(s =>
      s.sessionKey === sessionKey ? { ...s, speaker: name } : s
    );
  });
}, []);
```

**Step 4: Auto-populate participants from detected speakers**

When system audio starts, fetch the speaker list:

```typescript
// In the system audio start handler
const speakers = await invoke<Array<{ speaker_id: string; display_name: string }>>("get_speakers");
const names = speakers.map(s => s.display_name);
setParticipants(prev => {
  const merged = new Set([...prev, ...names]);
  return Array.from(merged);
});
```

**Step 5: Test manually**

Run: `cd apps/desktop && pnpm tauri dev` (with `--features diarization` in Cargo.toml or tauri.conf.json)

Verify:
1. Start system audio → speakers appear as "Speaker 1", "Speaker 2"
2. Click a speaker label → rename to "Alice" → all sessions update
3. Restart app → "Alice" is still recognized

**Step 6: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "feat: wire frontend speaker labels to backend diarization"
```

---

### Task 9: Final integration test and cleanup

**Files:**
- Verify all files compile and tests pass

**Step 1: Run all tests**

Run: `cargo test --features diarization -p local-whisper`
Expected: All tests pass

**Step 2: Run without diarization feature to ensure no breakage**

Run: `cargo check -p local-whisper`
Expected: Compiles without the feature flag (diarization code is gated)

**Step 3: Run frontend build**

Run: `cd apps/desktop && pnpm build`
Expected: TypeScript compiles without errors

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: speaker diarization integration complete"
```
