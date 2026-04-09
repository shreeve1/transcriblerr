use crate::diarization::types::SpeakerInfo;
use log::{info, warn};
use serde::{Deserialize, Serialize};
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

impl SpeakerTracker {
    pub fn new(max_speakers: usize, similarity_threshold: f32) -> Self {
        Self {
            speakers: Vec::new(),
            max_speakers,
            similarity_threshold,
            next_id: 1,
            dirty: false,
        }
    }

    pub fn match_or_create(&mut self, embedding: &[f32]) -> (String, f32, bool) {
        let (best_idx, best_sim) = self.find_best_match(embedding);

        if let Some(idx) = best_idx {
            if best_sim >= self.similarity_threshold {
                // Update centroid with running average
                let speaker = &mut self.speakers[idx];
                let count = speaker.utterance_count as f32;
                for (c, e) in speaker.centroid.iter_mut().zip(embedding.iter()) {
                    *c = (*c * count + *e) / (count + 1.0);
                }
                speaker.utterance_count += 1;
                self.dirty = true;
                return (speaker.speaker_id.clone(), best_sim, false);
            }
        }

        // No match found — create new speaker if under max
        if self.speakers.len() >= self.max_speakers {
            // At max, assign to nearest existing speaker
            if let Some(idx) = best_idx {
                let speaker = &mut self.speakers[idx];
                speaker.utterance_count += 1;
                self.dirty = true;
                return (speaker.speaker_id.clone(), best_sim, false);
            }
        }

        // Create new speaker
        let speaker_id = format!("speaker_{}", self.next_id);
        let display_name = format!("Speaker {}", self.next_id);
        self.next_id += 1;

        self.speakers.push(TrackedSpeaker {
            speaker_id: speaker_id.clone(),
            display_name,
            centroid: embedding.to_vec(),
            utterance_count: 1,
        });

        self.dirty = true;
        (speaker_id, best_sim, true)
    }

    pub fn rename(&mut self, speaker_id: &str, new_name: &str) -> bool {
        if let Some(speaker) = self.speakers.iter_mut().find(|s| s.speaker_id == speaker_id) {
            speaker.display_name = new_name.to_string();
            self.dirty = true;
            true
        } else {
            false
        }
    }

    pub fn list_speakers(&self) -> Vec<SpeakerInfo> {
        self.speakers
            .iter()
            .map(|s| SpeakerInfo {
                speaker_id: s.speaker_id.clone(),
                display_name: s.display_name.clone(),
                utterance_count: s.utterance_count,
            })
            .collect()
    }

    pub fn reset(&mut self) {
        self.speakers.clear();
        self.next_id = 1;
        self.dirty = true;
    }

    pub fn get_display_name(&self, speaker_id: &str) -> Option<String> {
        self.speakers
            .iter()
            .find(|s| s.speaker_id == speaker_id)
            .map(|s| s.display_name.clone())
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

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

    fn find_best_match(&self, embedding: &[f32]) -> (Option<usize>, f32) {
        let mut best_idx: Option<usize> = None;
        let mut best_sim: f32 = -1.0;

        for (idx, speaker) in self.speakers.iter().enumerate() {
            let sim = cosine_similarity(embedding, &speaker.centroid);
            if sim > best_sim {
                best_sim = sim;
                best_idx = Some(idx);
            }
        }

        (best_idx, best_sim)
    }
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let norm_a: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let norm_b: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (norm_a * norm_b + 1e-12)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn make_embedding(seed: f32, dim: usize) -> Vec<f32> {
        (0..dim).map(|i| (seed + i as f32 * 0.1).sin()).collect()
    }

    #[test]
    fn test_new_speaker_created() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb = make_embedding(1.0, 128);
        let (id, _sim, is_new) = tracker.match_or_create(&emb);
        assert!(is_new);
        assert_eq!(id, "speaker_1");
    }

    #[test]
    fn test_same_embedding_matches() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb = make_embedding(1.0, 128);
        let (id1, _, _) = tracker.match_or_create(&emb);
        let (id2, sim, is_new) = tracker.match_or_create(&emb);
        assert!(!is_new);
        assert_eq!(id1, id2);
        assert!(sim > 0.99);
    }

    #[test]
    fn test_different_embeddings_create_new_speakers() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb1 = make_embedding(1.0, 128);
        let emb2 = make_embedding(100.0, 128);
        let (id1, _, is_new1) = tracker.match_or_create(&emb1);
        let (id2, _, is_new2) = tracker.match_or_create(&emb2);
        assert!(is_new1);
        assert!(is_new2);
        assert_ne!(id1, id2);
    }

    #[test]
    fn test_max_speakers_assigns_to_nearest() {
        let mut tracker = SpeakerTracker::new(2, 0.8);
        let emb1 = make_embedding(1.0, 128);
        let emb2 = make_embedding(100.0, 128);
        let (id1, _, _) = tracker.match_or_create(&emb1);
        let (_id2, _, _) = tracker.match_or_create(&emb2);
        // Third embedding similar to first
        let emb3 = make_embedding(1.01, 128);
        let (id3, _, is_new) = tracker.match_or_create(&emb3);
        assert!(!is_new);
        assert_eq!(id3, id1);
    }

    #[test]
    fn test_rename_existing_speaker() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb = make_embedding(1.0, 128);
        tracker.match_or_create(&emb);
        assert!(tracker.rename("speaker_1", "Alice"));
        assert_eq!(tracker.get_display_name("speaker_1"), Some("Alice".to_string()));
    }

    #[test]
    fn test_rename_nonexistent_returns_false() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        assert!(!tracker.rename("speaker_99", "Ghost"));
    }

    #[test]
    fn test_reset_clears_all() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb = make_embedding(1.0, 128);
        tracker.match_or_create(&emb);
        tracker.reset();
        assert!(tracker.list_speakers().is_empty());
        let (id, _, is_new) = tracker.match_or_create(&emb);
        assert!(is_new);
        assert_eq!(id, "speaker_1");
    }

    #[test]
    fn test_centroid_update() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb = make_embedding(1.0, 128);
        tracker.match_or_create(&emb);
        tracker.match_or_create(&emb);
        let speakers = tracker.list_speakers();
        assert_eq!(speakers.len(), 1);
        assert_eq!(speakers[0].utterance_count, 2);
    }

    #[test]
    fn test_cosine_similarity_identical() {
        let a = vec![1.0_f32, 0.0, 0.0];
        let b = vec![1.0_f32, 0.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!((sim - 1.0).abs() < 1e-6);
    }

    #[test]
    fn test_cosine_similarity_orthogonal() {
        let a = vec![1.0_f32, 0.0, 0.0];
        let b = vec![0.0_f32, 1.0, 0.0];
        let sim = cosine_similarity(&a, &b);
        assert!(sim.abs() < 1e-6);
    }

    #[test]
    fn test_dirty_flag() {
        let mut tracker = SpeakerTracker::new(5, 0.8);
        assert!(!tracker.is_dirty());
        let emb = make_embedding(1.0, 128);
        tracker.match_or_create(&emb);
        assert!(tracker.is_dirty());
        tracker.clear_dirty();
        assert!(!tracker.is_dirty());
    }

    #[test]
    fn test_save_and_load_roundtrip() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let path = dir.path().join("profiles.json");

        let mut tracker = SpeakerTracker::new(5, 0.8);
        let emb1 = make_embedding(1.0, 128);
        let emb2 = make_embedding(100.0, 128);
        tracker.match_or_create(&emb1);
        tracker.match_or_create(&emb2);
        tracker.rename("speaker_1", "Alice");
        tracker.save_to_file(&path).expect("save failed");

        let mut tracker2 = SpeakerTracker::new(5, 0.8);
        tracker2.load_from_file(&path).expect("load failed");
        assert_eq!(tracker2.list_speakers().len(), 2);
        assert_eq!(tracker2.get_display_name("speaker_1"), Some("Alice".to_string()));
        assert_eq!(tracker2.get_display_name("speaker_2"), Some("Speaker 2".to_string()));
        assert!(!tracker2.is_dirty());
    }

    #[test]
    fn test_load_missing_file_is_ok() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let path = dir.path().join("nonexistent.json");

        let mut tracker = SpeakerTracker::new(5, 0.8);
        let result = tracker.load_from_file(&path);
        assert!(result.is_ok());
        assert!(tracker.list_speakers().is_empty());
    }

    #[test]
    fn test_load_corrupted_file_returns_error() {
        let dir = tempfile::tempdir().expect("Failed to create temp dir");
        let path = dir.path().join("bad.json");

        let mut f = std::fs::File::create(&path).expect("create failed");
        f.write_all(b"not valid json {{{").expect("write failed");
        drop(f);

        let mut tracker = SpeakerTracker::new(5, 0.8);
        let result = tracker.load_from_file(&path);
        assert!(result.is_err());
    }
}