# Transcriblerr

Transcriblerr is a high-accuracy, low-latency transcription app for Apple Silicon Macs (M1/M2/M3).
It captures both microphone input and system audio (e.g., web meetings, YouTube), with offline local transcription and optional OpenAI-compatible transcription/summarization.



## Highlights

- 🔒 **Offline-first local mode** – Keep sensitive audio on your machine with whisper.cpp.
- ⚡ **Optimized for low latency** – Built on whisper.cpp to make the most of Apple Silicon’s CPU/GPU.
- 🎧 **Flexible sources** – Switch between microphone input and system audio with one tap.
- 🔊 **System audio capture** – Capture meeting or media audio and transcribe it immediately.
- 🗣️ **English-first experience** – Defaults to English transcription while still allowing other supported languages when needed.
- 🪄 **UI-selectable models** – Choose between base / small / medium / large v3 turbo directly from the interface.
- ☁️ **Optional OpenAI-compatible APIs** – Use OpenAI for transcription and AI summaries when configured.

## Requirements

- Apple Silicon Mac (macOS 13+ recommended)
- Rust 1.70 or later
- Node.js 18 or later
- pnpm
- A C++ compiler (for building whisper.cpp)

## Setup

1. **Clone the repository**

   ```bash
   git clone <repository-url>
   cd transcriblerr
   git submodule update --init --recursive
   ```

2. **Install dependencies**

   ```bash
   cd apps/desktop
   pnpm install
   ```

3. **Optional: configure OpenAI-compatible APIs**

   ```bash
   cp .env.example .env
   ```

   Then set your API key in `apps/desktop/.env`:

   ```env
   LLM_API_BASE_URL=https://api.openai.com/v1
   LLM_API_KEY=sk-...
   LLM_TRANSCRIPTION_MODEL=whisper-1

   LLM_SUMMARY_ENABLED=true
   LLM_SUMMARY_API_BASE_URL=https://api.openai.com/v1
   LLM_SUMMARY_MODEL=gpt-4o
   LLM_SUMMARY_API_KEY=
   ```

   `LLM_SUMMARY_API_KEY` is optional. If empty, summaries use `LLM_API_KEY`. Do not commit `.env`; it is ignored by git. Restart the app after changing `.env`.

4. **Run in development mode**
   ```bash
   pnpm tauri dev
   ```
   Need a packaged build? Run `pnpm tauri build`.

## Model selection tips

| Model          | Characteristics                   | Suggested use case                                              |
| -------------- | --------------------------------- | --------------------------------------------------------------- |
| base           | Balanced default                  | Everyday meetings, casual videos                                |
| small          | Higher accuracy than base         | Long meeting notes                                              |
| medium         | Even higher accuracy              | Fields that require fewer transcription errors (legal, medical) |
| large v3 turbo | Highest accuracy while still fast | Subtitle generation, archival transcripts                       |

Switch models from the in-app dropdown at any time.
Pick `medium` or `large v3 turbo` when accuracy matters most; choose `base` for faster turnaround.

## How to use

1. Start the app with `pnpm tauri dev`.
2. Choose a transcription backend in **Settings → Microphone Settings → Transcription Backend**:
   - **Local (offline Whisper)** uses an installed local model.
   - **OpenAI API** uses the `LLM_*` values from `.env`.
3. Select the input source (**Microphone** or **System Audio**).
4. Hit **Start** to begin live transcription, and **Stop** when finished.
5. Copy results instantly, save transcripts, or summarize the conversation.

## Troubleshooting

- **No audio detected**: Check macOS “System Settings → Privacy & Security → Microphone” and allow access for the app.
- **Slow performance**: Temporarily switch to a lighter model or close other CPU/GPU-intensive applications.
- **OpenAI requests return 404**: Make sure `LLM_API_BASE_URL` and `LLM_SUMMARY_API_BASE_URL` are base URLs like `https://api.openai.com/v1`, not full endpoint URLs.

## OpenAI-compatible transcription and summarization

Transcriblerr defaults API URLs to OpenAI-compatible endpoints for new installs:

- Transcription base URL: `https://api.openai.com/v1`
- Transcription model: `whisper-1`
- Summary base URL: `https://api.openai.com/v1`
- Summary model: `gpt-4o`

Configuration lives in `apps/desktop/.env` and follows `apps/desktop/.env.example`. Use only the base URL, not the full endpoint path; the app appends `/audio/transcriptions` and `/chat/completions` internally.

- OpenAI transcription is selected in **Settings → Microphone Settings → Transcription Backend**.
- AI summaries are configured in **Settings → Summarization Settings**.
- Leaving **Custom System Prompt** empty uses the built-in default summary prompt.
- Summarization uses `LLM_SUMMARY_API_KEY` first, then falls back to `LLM_API_KEY`.
- API keys are never returned to the frontend; the UI only receives `hasApiKey`.
- Existing saved settings may keep older local URLs until updated in settings or reset.

## Credits

- [whisper.cpp](https://github.com/ggerganov/whisper.cpp)
- [OpenAI Whisper](https://github.com/openai/whisper)
- [Tauri](https://tauri.app/)

## License

Distributed under the [MIT License](./LICENSE).
