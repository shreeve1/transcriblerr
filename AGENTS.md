# AGENTS.md

Guidance for coding agents working in this repository.

## Project Summary

Transcriblerr is a Tauri 2 desktop app for Apple Silicon Macs. It captures microphone and system audio, transcribes locally with whisper.cpp via `whisper-rs`, and optionally uses OpenAI-compatible APIs for transcription and summarization.

## Repository Layout

- `apps/desktop/src/` - React/Vite frontend. Keep feature UI in `components/`, reusable state in `hooks/`, shared DTOs in `types.ts`, and frontend-only helpers in `utils/`.
- `apps/desktop/src-tauri/` - Tauri backend. `commands.rs` contains thin command wrappers; implementation lives in module functions, primarily `lib.rs` plus domain modules.
- `apps/desktop/src-tauri/src/audio/` - shared recording state, VAD processing, audio constants, and audio utilities.
- `apps/desktop/src-tauri/src/transcription/` - transcription worker and provider clients.
- `apps/desktop/src-tauri/src/summarization/` - OpenAI-compatible summary provider and persisted config.
- `apps/desktop/src-tauri/src/system_audio.rs` - macOS system audio capture bridge.
- `crates/asr-core/` - Rust whisper wrapper crate with no Tauri dependency.
- `vendor/whisper.cpp/` - git submodule required for local whisper builds.

## Setup And Commands

Run frontend commands from `apps/desktop/`:

```bash
pnpm install
pnpm dev
pnpm build
pnpm exec vitest run
pnpm tauri dev
pnpm tauri build
```

Run Rust commands from the repo root when the Rust toolchain is available:

```bash
cargo test
cargo check
cargo build
cargo build --features diarization
```

Initialize submodules before native builds:

```bash
git submodule update --init --recursive
```

## Implementation Conventions

- Keep frontend/backend communication through Tauri `invoke()` commands and backend-emitted events.
- Add new Tauri commands in `commands.rs` as thin wrappers only; put behavior in module-level `*_impl` functions.
- Keep backend state mutations behind the shared `RecordingState` mutex and avoid holding that lock while joining threads, blocking on I/O, or calling long-running work.
- Do not leak audio streams. Retain active streams in owned state and drop them deterministically on stop/replacement/shutdown.
- Treat the transcription worker as shared app infrastructure, not as mic-owned state.
- Do not reintroduce screen recording without wiring it end-to-end through Rust commands, Swift bridge status/error propagation, frontend controls, and tests/docs.
- Keep API keys backend-only. The frontend may receive booleans like `hasApiKey`, never raw secrets.
- Prefer small frontend components and hooks over growing `App.tsx`.
- Preserve the app’s current visual language unless explicitly asked for a redesign.

## Safety Notes

- `.env` files must remain untracked.
- `Cargo.lock` should be tracked for reproducible desktop app builds.
- Model files are large; do not commit downloaded Whisper models.
- `apps/desktop/src-tauri/tauri.conf.json` CSP should stay restrictive. Do not add broad permissions or plugins unless the frontend actually uses them.
- The app is macOS-focused. Be careful with cross-platform assumptions in CPAL, ScreenCaptureKit, and Swift bridge code.

## Verification

Before finishing changes, run:

```bash
cd apps/desktop && pnpm exec vitest run
cd apps/desktop && pnpm build
```

If available, also run:

```bash
cargo test
cargo check
```

If a required tool is not available, report the blocked check explicitly in the final response.
