//! Shared types for the diarization pipeline.

use serde::{Deserialize, Serialize};

/// Configuration for the diarization pipeline.
#[derive(Debug, Clone)]
pub struct DiarizationConfig {
    /// Cosine similarity threshold for speaker matching (0.0–1.0).
    pub similarity_threshold: f32,
    /// Maximum number of simultaneous speakers to track.
    pub max_speakers: usize,
    /// Minimum audio duration (seconds) required before extracting an embedding.
    pub min_audio_seconds: f32,
}

impl Default for DiarizationConfig {
    fn default() -> Self {
        Self {
            similarity_threshold: 0.70,
            max_speakers: 8,
            min_audio_seconds: 1.5,
        }
    }
}

/// Public information about a tracked speaker.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpeakerInfo {
    /// Internal immutable key, e.g. `"speaker_1"`.
    pub speaker_id: String,
    /// User-facing display name, e.g. `"Speaker 1"` or `"Alice"`.
    pub display_name: String,
    /// Number of utterances assigned to this speaker so far.
    pub utterance_count: u32,
}

/// Result of processing one utterance through the diarization pipeline.
#[derive(Debug, Clone, Serialize)]
pub struct DiarizationResult {
    /// Assigned speaker ID, or `None` if no confident match was found.
    pub speaker_id: Option<String>,
    /// Cosine similarity score of the best match (0.0–1.0).
    /// Meaningful only when `speaker_id` is `Some`.
    pub confidence: f32,
    /// `true` when the result meets the reliability threshold.
    pub is_reliable: bool,
}

impl Default for DiarizationResult {
    fn default() -> Self {
        Self {
            speaker_id: None,
            confidence: 0.0,
            is_reliable: false,
        }
    }
}