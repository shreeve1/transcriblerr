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
