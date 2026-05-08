# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Transcriblerr is an offline speech-to-text desktop app for Apple Silicon Macs. It uses whisper.cpp (via whisper-rs) for local transcription, captures both microphone and system audio, and runs as a Tauri 2 desktop application with a React frontend.

## Build & Dev Commands

```bash
# Install frontend dependencies (from apps/desktop/)
cd apps/desktop && pnpm install

# Run in development mode (from apps/desktop/)
pnpm tauri dev

# Production build (from apps/desktop/)
pnpm tauri build

# Build just the Rust backend (from repo root)
cargo build

# Build with speaker diarization support
cargo build --features diarization

# Check Rust code compiles
cargo check

# Frontend type-check
cd apps/desktop && pnpm build  # runs tsc && vite build
```

Git submodules are required (`vendor/whisper.cpp`):
```bash
git submodule update --init --recursive
```

## Architecture

### Workspace Layout

- **`crates/asr-core/`** — Core whisper.cpp wrapper crate. Provides `WhisperContext` for transcription with Metal GPU acceleration. Has no Tauri dependency — pure audio-in, text-out.
- **`apps/desktop/src-tauri/`** — Tauri 2 backend (Rust). All application logic: audio capture, VAD, transcription orchestration, system audio, summarization, diarization.
- **`apps/desktop/src/`** — React frontend (single-file `App.tsx` + CSS). Communicates with backend exclusively via Tauri `invoke()` commands and event listeners.
- **`vendor/whisper.cpp`** — Git submodule, built by `asr-core`'s `build.rs`.

### Backend Modules (`apps/desktop/src-tauri/src/`)

- **`lib.rs`** — App entry point, Tauri setup, all `*_impl()` functions that commands delegate to. Global statics (`APP_HANDLE`, `RECORDING_SAVE_PATH`, `DIARIZATION_MANAGER`).
- **`commands.rs`** — Thin `#[tauri::command]` wrappers that call `*_impl()` functions from `lib.rs`. All commands registered in `register()`.
- **`audio/`** — Audio pipeline: `state.rs` (shared `RecordingState` behind `parking_lot::Mutex`), `processing.rs` (VAD + session management), `constants.rs`, `utils.rs`.
- **`transcription/`** — Two backends: `worker.rs` (local whisper via `asr-core`), `llm_client.rs` (OpenAI-compatible API). `websocket_client.rs` for legacy WS mode. Mode selected at runtime via `transcription_mode` ("local" or "llm").
- **`summarization/`** — AI summarization via OpenAI-compatible API with local fallback. Config persisted to Tauri app config dir.
- **`diarization/`** — Speaker diarization (optional, behind `diarization` feature flag using `sherpa-onnx`).
- **`system_audio.rs`** — macOS system audio capture (loopback).
- **`whisper.rs`** — Model management (scan, download, delete models).

### Frontend ↔ Backend Communication

The frontend calls Tauri commands via `invoke()` (e.g., `invoke("start_recording")`). The backend emits events to the frontend: `transcription-segment`, `voice-activity`, `backend-error`. All state lives in the Rust backend.

### Key Patterns

- **Recording state**: Single `RecordingState` struct behind `parking_lot::Mutex`, accessed via `recording_state()` / `try_recording_state()`.
- **Runtime config persistence**: Audio settings (VAD threshold, transcription mode, partial interval) saved to `audio-runtime-config.json` in the Tauri app config directory.
- **Environment variables**: Backend loads `.env` via `dotenvy`. See `apps/desktop/.env.example` for LLM transcription and summarization config (`LLM_API_BASE_URL`, `LLM_SUMMARY_*`).
- **Transcription modes**: "local" (whisper.cpp via asr-core) or "llm" (OpenAI-compatible API). Aliases: "legacy_ws"→local, "api"/"openai"→llm.

## macOS TCC Permissions

The app requires Screen Recording and Microphone TCC permissions for system audio capture. When reinstalling or after a fresh build, macOS may not re-prompt if stale entries exist. Reset with:

```bash
tccutil reset ScreenCapture com.transcriblerr.app
tccutil reset Microphone com.transcriblerr.app
```

Then relaunch the app to get fresh permission prompts. If `tccutil` alone doesn't work, also manually remove the app from **System Settings → Privacy & Security → Screen Recording / Microphone** before relaunching.

When doing a full uninstall, remove these locations to clean all app state:

```bash
rm -rf ~/Library/Application\ Support/com.transcriblerr.app
rm -rf ~/Library/Application\ Support/local-whisper
rm -rf ~/Library/Application\ Support/transcriblerr
rm -rf ~/Library/Caches/com.transcriblerr.app
rm -rf ~/Library/Saved\ Application\ State/transcriblerr.app.*
rm -rf /Applications/transcriblerr.app
security delete-generic-password -s "com.transcriblerr.app" -a "llm-api-key"
tccutil reset ScreenCapture com.transcriblerr.app
tccutil reset Microphone com.transcriblerr.app
```

## Requirements

- Apple Silicon Mac (macOS 13+)
- Rust 1.70+, Node.js 18+, pnpm
- C++ compiler (for whisper.cpp native build)
