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

        Some(Self {
            extractor,
            config: DiarizationConfig::default(),
        })
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

        let stream = self.extractor.create_stream()?;
        stream.accept_waveform(16000, audio_16k_mono);

        if !self.extractor.is_ready(&stream) {
            warn!("SpeakerEmbeddingExtractor: stream not ready after feeding audio");
            return None;
        }

        self.extractor.compute(&stream)
    }
}
