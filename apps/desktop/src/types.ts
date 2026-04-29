export interface TranscriptionSegment {
  text: string;
  timestamp: number;
  audioData?: number[];
  sessionId: number;
  messageId: number;
  isFinal: boolean;
  source: string;
  speakerId?: string;
}

export interface SessionTranscription {
  sessionKey: string;
  sessionId: number;
  source: string;
  speaker: string;
  speakerId?: string;
  messages: TranscriptionSegment[];
  audioChunks: Record<number, number[]>;
}

export interface ModelInfo {
  name: string;
  path: string;
  size: number;
}

export interface RemoteModelStatus {
  id: string;
  name: string;
  filename: string;
  size: number;
  description: string;
  installed: boolean;
  path?: string;
}

export interface AudioDevice {
  name: string;
  is_default: boolean;
}

export interface StreamingConfig {
  vadThreshold: number;
  partialIntervalSeconds: number;
}

export interface VoiceActivityEvent {
  source: string;
  isActive: boolean;
  sessionId: number;
  timestamp: number;
}

export type VoiceActivitySourceState = {
  isActive: boolean;
  sessionId: number | null;
};

export type VoiceActivityState = Record<"user" | "system", VoiceActivitySourceState>;

export interface WhisperParamsConfig {
  audioCtx: number;
  temperature: number;
}

export type BackendMode = "local" | "openai";

export interface TranscriptionBackendConfig {
  mode: string;
  model: string;
}

export interface ApiKeyStatus {
  hasStoredKey: boolean;
  hasEnvKey: boolean;
  hasAnyKey: boolean;
}

export type BackendErrorKind =
  | "mic_device_unavailable"
  | "llm_auth"
  | "generic";

export interface BackendErrorEvent {
  message: string;
  kind?: BackendErrorKind;
  fallbackMode?: BackendMode;
}

export interface SummarizationConfig {
  enabled: boolean;
  apiBaseUrl: string;
  model: string;
  hasApiKey: boolean;
  customSystemPrompt?: string;
  summarySavePath?: string;
  autoSaveSummary: boolean;
}

export interface SummarizationConfigUpdate {
  enabled: boolean;
  apiBaseUrl: string;
  model: string;
  customSystemPrompt?: string;
  summarySavePath?: string;
  autoSaveSummary: boolean;
}

export interface ModelInstallProgressEvent {
  modelId: string;
  filename: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  status: "downloading" | "completed" | "error";
  message?: string;
}
