//! Diarization module for offline speaker diarization on system audio.

mod extractor;
mod manager;
mod tracker;
mod types;

pub use manager::DiarizationManager;
pub use types::{DiarizationConfig, DiarizationResult, SpeakerInfo};