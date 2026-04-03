import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Mic,
  MicOff,
  Play,
  Square,
  Settings,
  Circle,
  StopCircle,
  Copy,
  Check,
  Trash2,
  Moon,
  Sun,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  X,
} from "lucide-react";
import { TypingDots } from "./components/TypingDots";
import "./App.css";

interface TranscriptionSegment {
  text: string;
  timestamp: number;
  audioData?: number[];
  sessionId: number;
  messageId: number;
  isFinal: boolean;
  source: string;
}

interface SessionTranscription {
  sessionKey: string;
  sessionId: number;
  source: string;
  speaker: string;
  messages: TranscriptionSegment[];
  audioChunks: Record<number, number[]>;
}

interface ModelInfo {
  name: string;
  path: string;
  size: number;
}

interface RemoteModelStatus {
  id: string;
  name: string;
  filename: string;
  size: number;
  description: string;
  installed: boolean;
  path?: string;
}

interface AudioDevice {
  name: string;
  is_default: boolean;
}

interface StreamingConfig {
  vadThreshold: number;
  partialIntervalSeconds: number;
}

interface VoiceActivityEvent {
  source: string;
  isActive: boolean;
  sessionId: number;
  timestamp: number;
}

type VoiceActivitySourceState = {
  isActive: boolean;
  sessionId: number | null;
};

type VoiceActivityState = Record<"user" | "system", VoiceActivitySourceState>;

interface WhisperParamsConfig {
  audioCtx: number;
  temperature: number;
}

type BackendMode = "local" | "openai";

interface TranscriptionBackendConfig {
  mode: string;
}

interface BackendErrorEvent {
  message: string;
  fallbackMode?: BackendMode;
}

interface SummarizationConfig {
  enabled: boolean;
  apiBaseUrl: string;
  model: string;
  hasApiKey: boolean;
  customSystemPrompt?: string;
}

interface SummarizationConfigUpdate {
  enabled: boolean;
  apiBaseUrl: string;
  model: string;
  customSystemPrompt?: string;
}

interface ModelInstallProgressEvent {
  modelId: string;
  filename: string;
  downloadedBytes: number;
  totalBytes: number;
  percent: number;
  status: "downloading" | "completed" | "error";
  message?: string;
}

const SUMMARY_STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "because",
  "been",
  "being",
  "could",
  "from",
  "have",
  "into",
  "just",
  "more",
  "most",
  "only",
  "other",
  "over",
  "some",
  "than",
  "that",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "very",
  "were",
  "what",
  "when",
  "where",
  "which",
  "while",
  "will",
  "with",
  "would",
]);

const sourceLabel = (source: string) => {
  if (source === "mic" || source === "user") return "You";
  if (source === "system") return "System";
  return source;
};

const normalizeMessageText = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F]+/g, " ")
    .trim();

const summarizeLocally = (messages: (TranscriptionSegment & { speaker: string })[]) => {
  const normalized = messages
    .map((message) => ({
      ...message,
      text: normalizeMessageText(message.text),
    }))
    .filter((message) => message.text.length > 0);

  const dedupeSet = new Set<string>();
  const uniqueMessages = normalized.filter((message) => {
    const key = `${message.source}:${message.text.toLowerCase()}`;
    if (dedupeSet.has(key)) {
      return false;
    }
    dedupeSet.add(key);
    return true;
  });

  if (uniqueMessages.length === 0) {
    return "";
  }

  const frequency = new Map<string, number>();
  for (const message of uniqueMessages) {
    const words = message.text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
    for (const word of words) {
      if (word.length <= 3 || SUMMARY_STOP_WORDS.has(word)) {
        continue;
      }
      frequency.set(word, (frequency.get(word) ?? 0) + 1);
    }
  }

  const topThemes = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  const rankedMessages = uniqueMessages
    .map((message) => {
      const words = message.text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
      const keywordScore = words.reduce(
        (total, word) => total + (frequency.get(word) ?? 0),
        0,
      );
      const lengthScore = Math.min(words.length, 30) / 30;
      return {
        ...message,
        score: keywordScore + lengthScore,
      };
    })
    .sort((a, b) => b.score - a.score || a.timestamp - b.timestamp);

  const highlights = rankedMessages.slice(0, Math.min(5, rankedMessages.length));
  const possibleNextSteps = uniqueMessages
    .filter((message) =>
      /\b(todo|next|follow\s?up|need to|should|plan|must|let's)\b/i.test(
        message.text,
      ),
    )
    .slice(0, 3);

  const lines: string[] = [];
  lines.push(`Conversation summary (${uniqueMessages.length} final messages)`);
  if (topThemes.length > 0) {
    lines.push(`Themes: ${topThemes.join(", ")}`);
  }
  lines.push("");
  lines.push("Highlights:");
  for (const message of highlights) {
    lines.push(`- ${message.speaker}: ${message.text}`);
  }

  if (possibleNextSteps.length > 0) {
    lines.push("");
    lines.push("Possible next steps:");
    for (const message of possibleNextSteps) {
      lines.push(`- ${message.speaker}: ${message.text}`);
    }
  }

  return lines.join("\n");
};

const LANGUAGE_LABELS: Record<string, string> = {
  auto: "Auto Detect",
  ja: "Japanese",
  en: "English",
  zh: "Chinese",
  ko: "Korean",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ru: "Russian",
};

const normalizeLanguageOptions = (
  languages: [string, string][],
): [string, string][] =>
  languages.map(([code, name]) => [code, LANGUAGE_LABELS[code] ?? name]);

const normalizeBackendMode = (mode: string): BackendMode =>
  mode === "local" || mode === "legacy_ws" ? "local" : "openai";

const summaryErrorCode = (message: string): string | null => {
  const match = message.match(/^(SUMMARY_[A-Z_]+):/);
  return match ? match[1] : null;
};

const isSilentSummaryFallback = (message: string): boolean => {
  const code = summaryErrorCode(message);
  return (
    code === "SUMMARY_UNCONFIGURED" ||
    code === "SUMMARY_TRANSIENT" ||
    code === "SUMMARY_PROVIDER"
  );
};

function SpeakerChip({
  speaker,
  participants,
  onChangeSpeaker,
  onAddParticipant,
}: {
  speaker: string;
  participants: string[];
  onChangeSpeaker: (name: string) => void;
  onAddParticipant: (name: string) => void;
}) {
  const [dropdownPos, setDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const chipRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isOpen = dropdownPos !== null;

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        chipRef.current &&
        !chipRef.current.contains(target) &&
        dropdownRef.current &&
        !dropdownRef.current.contains(target)
      ) {
        setDropdownPos(null);
        setIsAdding(false);
        setNewName("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const scrollContainer = document.querySelector("[data-chat-scroll]");
    const handleScroll = () => {
      setDropdownPos(null);
      setIsAdding(false);
      setNewName("");
    };
    scrollContainer?.addEventListener("scroll", handleScroll);
    return () => scrollContainer?.removeEventListener("scroll", handleScroll);
  }, [isOpen]);

  const handleToggle = () => {
    if (isOpen) {
      setDropdownPos(null);
      setIsAdding(false);
      setNewName("");
      return;
    }
    const rect = chipRef.current?.getBoundingClientRect();
    if (rect) {
      setDropdownPos({ top: rect.bottom + 4, left: rect.left });
    }
  };

  const handleSelect = (name: string) => {
    onChangeSpeaker(name);
    setDropdownPos(null);
    setIsAdding(false);
    setNewName("");
  };

  const handleAddNew = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onAddParticipant(trimmed);
    onChangeSpeaker(trimmed);
    setDropdownPos(null);
    setIsAdding(false);
    setNewName("");
  };

  return (
    <div className="inline-block" ref={chipRef}>
      <button
        className="badge badge-sm badge-outline cursor-pointer hover:badge-primary transition-colors"
        onClick={handleToggle}
        title="Change speaker"
      >
        {speaker}
      </button>
      {dropdownPos && createPortal(
        <div
          ref={dropdownRef}
          className="fixed z-[9999] bg-base-100 border border-base-300 rounded-lg shadow-xl min-w-[140px] py-1"
          style={{ top: dropdownPos.top, left: dropdownPos.left }}
        >
          {participants.map((name) => (
            <button
              key={name}
              className={`w-full text-left px-3 py-1 text-xs hover:bg-base-300 transition-colors ${name === speaker ? "font-semibold text-primary" : ""}`}
              onClick={() => handleSelect(name)}
            >
              {name}
            </button>
          ))}
          <div className="border-t border-base-300 mt-1 pt-1">
            {isAdding ? (
              <form
                className="px-2 flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleAddNew();
                }}
              >
                <input
                  type="text"
                  className="input input-xs input-bordered flex-1 min-w-0"
                  placeholder="Name..."
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  autoFocus
                />
                <button type="submit" className="btn btn-xs btn-primary">
                  +
                </button>
              </form>
            ) : (
              <button
                className="w-full text-left px-3 py-1 text-xs text-primary hover:bg-base-300 transition-colors"
                onClick={() => setIsAdding(true)}
              >
                + Add new…
              </button>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}

function App() {
  const [isMuted, setIsMuted] = useState(true);
  const [isInitialized, setIsInitialized] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [selectedModel, setSelectedModel] = useState<string>("");
  const [selectedLanguage, setSelectedLanguage] = useState<string>("en");
  const [availableLanguages, setAvailableLanguages] = useState<
    [string, string][]
  >([]);
  const [transcriptions, setTranscriptions] = useState<SessionTranscription[]>(
    [],
  );
  const [error, setError] = useState("");
  const [playingSessionKey, setPlayingSessionKey] = useState<string | null>(
    null,
  );
  const [copiedSessionKey, setCopiedSessionKey] = useState<string | null>(null);
  const [currentAudioSource, setCurrentAudioSource] =
    useState<AudioBufferSourceNode | null>(null);
  const [currentAudioContext, setCurrentAudioContext] =
    useState<AudioContext | null>(null);
  const [audioDevices, setAudioDevices] = useState<AudioDevice[]>([]);
  const [selectedAudioDevice, setSelectedAudioDevice] = useState<string>("");
  const [hasMicPermission, setHasMicPermission] = useState<boolean | null>(
    null,
  );
  const [showSettings, setShowSettings] = useState(false);
  const [remoteModels, setRemoteModels] = useState<RemoteModelStatus[]>([]);
  const [modelOperations, setModelOperations] = useState<
    Record<string, boolean>
  >({});
  const [modelInstallProgress, setModelInstallProgress] = useState<
    Record<string, ModelInstallProgressEvent>
  >({});
  const [isLoadingRemoteModels, setIsLoadingRemoteModels] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  const [streamingConfig, setStreamingConfig] = useState<StreamingConfig>({
    vadThreshold: 0.1,
    partialIntervalSeconds: 2,
  });
  const [isSavingStreamingConfig, setIsSavingStreamingConfig] = useState(false);
  const [whisperParams, setWhisperParams] = useState<WhisperParamsConfig>({
    audioCtx: 1500,
    temperature: 0,
  });
  const [isSavingWhisperParams, setIsSavingWhisperParams] = useState(false);
  const [recordingSaveEnabled, setRecordingSaveEnabled] = useState(false);
  const [recordingSavePath, setRecordingSavePath] = useState("");

  const [isRecordingActive, setIsRecordingActive] = useState(false);
  const [isRecordingBusy, setIsRecordingBusy] = useState(false);
  const [isMicBusy, setIsMicBusy] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [summaryPanelText, setSummaryPanelText] = useState<string | null>(null);
  const [isSummaryExpanded, setIsSummaryExpanded] = useState(true);
  const [summarySource, setSummarySource] = useState<"AI" | "Local" | null>(
    null,
  );
  const [summaryConfig, setSummaryConfig] = useState<SummarizationConfig>({
    enabled: false,
    apiBaseUrl: "http://localhost:8317/v1",
    model: "gpt-4o-mini",
    hasApiKey: false,
    customSystemPrompt: "",
  });
  const [isSavingSummaryConfig, setIsSavingSummaryConfig] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem("theme") || "light");
  const [transcriptionMode, setTranscriptionMode] =
    useState<BackendMode>("local");
  const [copiedAllHistory, setCopiedAllHistory] = useState(false);
  const [voiceActivity, setVoiceActivity] = useState<VoiceActivityState>({
    user: { isActive: false, sessionId: null },
    system: { isActive: false, sessionId: null },
  });
  const [newMessageCount, setNewMessageCount] = useState(0);
  const [isAutoScrollPaused, setIsAutoScrollPaused] = useState(false);
  const [participants, setParticipants] = useState<string[]>(["Me", "Remote"]);

  const sourceDefaultSpeakerRef = useRef<Record<string, string>>({
    user: "Me",
    system: "Remote",
  });
  const transcriptionSuppressedForPlaybackRef = useRef(false);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const copyAllFeedbackTimeoutRef = useRef<number | null>(null);
  const streamingAutosaveTimeoutRef = useRef<number | null>(null);
  const lastAppliedStreamingConfigRef = useRef<StreamingConfig | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const previousMessageCountRef = useRef(0);
  const previousScrollHeightRef = useRef(0);
  const selectedModelInfo = availableModels.find(
    (model) => model.path === selectedModel,
  );
  const selectedModelDisplayName =
    selectedModelInfo?.name?.trim() ||
    selectedModelInfo?.path ||
    selectedModel;
  const needsModelSetup =
    transcriptionMode === "local" && availableModels.length === 0;

  const upsertTranscriptionSegment = useCallback(
    (segment: TranscriptionSegment) => {
      setTranscriptions((prev) => {
        const sessionKey = `${segment.source}-${segment.sessionId}`;
        const sessions = [...prev];
        const sessionIndex = sessions.findIndex(
          (s) => s.sessionKey === sessionKey,
        );

        const upsertMessages = (
          existing: TranscriptionSegment[] | undefined,
        ) => {
          if (!existing) {
            return [segment];
          }
          const messages = [...existing];
          const messageIndex = messages.findIndex(
            (m) => m.messageId === segment.messageId,
          );
          if (messageIndex >= 0) {
            messages[messageIndex] = segment;
          } else {
            messages.push(segment);
          }
          messages.sort((a, b) => a.messageId - b.messageId);
          return messages;
        };

        const upsertAudioChunks = (
          existing: Record<number, number[]> | undefined,
        ) => {
          const chunks = { ...(existing || {}) };
          if (segment.audioData?.length) {
            chunks[segment.messageId] = segment.audioData;
          }
          return chunks;
        };

        if (sessionIndex >= 0) {
          const session = sessions[sessionIndex];
          sessions[sessionIndex] = {
            ...session,
            messages: upsertMessages(session.messages),
            audioChunks: upsertAudioChunks(session.audioChunks),
          };
        } else {
          sessions.push({
            sessionKey,
            sessionId: segment.sessionId,
            source: segment.source,
            speaker: sourceDefaultSpeakerRef.current[segment.source] ?? sourceLabel(segment.source),
            messages: [segment],
            audioChunks: segment.audioData?.length
              ? { [segment.messageId]: segment.audioData }
              : {},
          });
        }

        // Keep only the currently arriving segment in-progress.
        return sessions.map((session) => {
          if (session.source !== segment.source) {
            return session;
          }

          let changed = false;
          const nextMessages = session.messages.map((message) => {
            const isCurrentIncoming =
              session.sessionKey === sessionKey &&
              message.messageId === segment.messageId;
            if (!isCurrentIncoming && !message.isFinal) {
              changed = true;
              return { ...message, isFinal: true };
            }
            return message;
          });

          if (!changed) {
            return session;
          }
          return {
            ...session,
            messages: nextMessages,
          };
        });
      });
    },
    [],
  );

  const finalizeAllInProgressMessages = useCallback(() => {
    setTranscriptions((prev) =>
      prev.map((session) => {
        let changed = false;
        const messages = session.messages.map((message) => {
          if (message.isFinal) {
            return message;
          }
          changed = true;
          return { ...message, isFinal: true };
        });
        return changed ? { ...session, messages } : session;
      }),
    );
  }, []);

  const handleAddParticipant = useCallback((name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    setParticipants(prev => prev.includes(trimmed) ? prev : [...prev, trimmed]);
  }, []);

  const handleChangeSpeaker = useCallback((sessionKey: string, name: string) => {
    setTranscriptions(prev => {
      const target = prev.find(s => s.sessionKey === sessionKey);
      if (target) {
        sourceDefaultSpeakerRef.current = { ...sourceDefaultSpeakerRef.current, [target.source]: name };
      }
      return prev.map(s =>
        s.sessionKey === sessionKey ? { ...s, speaker: name } : s
      );
    });
  }, []);

  useEffect(() => {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const loadStreamingConfig = useCallback(async () => {
    try {
      const config = await invoke<StreamingConfig>("get_streaming_config");
      setStreamingConfig(config);
      lastAppliedStreamingConfigRef.current = config;
      localStorage.setItem("vadThreshold", config.vadThreshold.toString());
      localStorage.setItem(
        "partialIntervalSeconds",
        config.partialIntervalSeconds.toString(),
      );
    } catch (err) {
      console.error("Failed to load streaming config:", err);
    }
  }, []);

  const saveStreamingConfig = useCallback(
    async (config: StreamingConfig) => {
      setIsSavingStreamingConfig(true);
      try {
        await invoke("set_streaming_config", {
          config,
        });

        // Read back from backend so UI reflects the actual applied values.
        const appliedConfig = await invoke<StreamingConfig>("get_streaming_config");
        setStreamingConfig(appliedConfig);
        lastAppliedStreamingConfigRef.current = appliedConfig;

        localStorage.setItem("vadThreshold", appliedConfig.vadThreshold.toString());
        if (appliedConfig.partialIntervalSeconds) {
          localStorage.setItem(
            "partialIntervalSeconds",
            appliedConfig.partialIntervalSeconds.toString(),
          );
        }

      } catch (err) {
        console.error("Failed to save streaming config:", err);
        setError(
          `Streaming settings error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        setIsSavingStreamingConfig(false);
      }
    },
    [setError],
  );

  useEffect(() => {
    if (!showSettings || isSavingStreamingConfig) {
      return;
    }

    const lastApplied = lastAppliedStreamingConfigRef.current;
    if (!lastApplied) {
      return;
    }

    const hasChanged =
      Math.abs(streamingConfig.vadThreshold - lastApplied.vadThreshold) > 0.0001 ||
      Math.abs(
        streamingConfig.partialIntervalSeconds -
          lastApplied.partialIntervalSeconds,
      ) > 0.0001;

    if (!hasChanged) {
      return;
    }

    if (streamingAutosaveTimeoutRef.current) {
      window.clearTimeout(streamingAutosaveTimeoutRef.current);
    }

    streamingAutosaveTimeoutRef.current = window.setTimeout(() => {
      streamingAutosaveTimeoutRef.current = null;
      void saveStreamingConfig(streamingConfig);
    }, 500);

    return () => {
      if (streamingAutosaveTimeoutRef.current) {
        window.clearTimeout(streamingAutosaveTimeoutRef.current);
        streamingAutosaveTimeoutRef.current = null;
      }
    };
  }, [
    isSavingStreamingConfig,
    saveStreamingConfig,
    showSettings,
    streamingConfig,
  ]);

  const loadWhisperParams = useCallback(async () => {
    try {
      const params = await invoke<WhisperParamsConfig>("get_whisper_params");
      setWhisperParams(params);
      localStorage.setItem("whisperAudioCtx", params.audioCtx.toString());
      localStorage.setItem("whisperTemperature", params.temperature.toString());
    } catch (err) {
      console.error("Failed to load Whisper params:", err);
    }
  }, []);

  const saveWhisperParams = useCallback(
    async (params: WhisperParamsConfig) => {
      setIsSavingWhisperParams(true);
      try {
        await invoke("set_whisper_params", {
          config: params,
        });
        setWhisperParams(params);
        localStorage.setItem("whisperAudioCtx", params.audioCtx.toString());
        localStorage.setItem(
          "whisperTemperature",
          params.temperature.toString(),
        );
      } catch (err) {
        console.error("Failed to save Whisper params:", err);
        setError(
          `Whisper settings error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        setIsSavingWhisperParams(false);
      }
    },
    [setError],
  );

  const loadTranscriptionBackendConfig = useCallback(async () => {
    try {
      const config = await invoke<TranscriptionBackendConfig>(
        "get_transcription_backend_config",
      );
      setTranscriptionMode(normalizeBackendMode(config.mode));
    } catch (err) {
      console.error("Failed to load transcription backend config:", err);
    }
  }, []);

  const loadSummarizationConfig = useCallback(async () => {
    try {
      const config = await invoke<SummarizationConfig>(
        "get_summarization_config",
      );
      setSummaryConfig(config);
    } catch (err) {
      console.error("Failed to load summarization config:", err);
    }
  }, []);

  const saveSummarizationConfig = useCallback(async () => {
    setIsSavingSummaryConfig(true);
    try {
      const payload: SummarizationConfigUpdate = {
        enabled: summaryConfig.enabled,
        apiBaseUrl: summaryConfig.apiBaseUrl,
        model: summaryConfig.model,
        customSystemPrompt: summaryConfig.customSystemPrompt || undefined,
      };

      await invoke<SummarizationConfig>("set_summarization_config", {
        config: payload,
      });

      await loadSummarizationConfig();
      setError("");
    } catch (err) {
      console.error("Failed to save summarization config:", err);
      setError(
        `Summarization settings error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setIsSavingSummaryConfig(false);
    }
  }, [loadSummarizationConfig, summaryConfig, setError]);

  const saveTranscriptionBackendConfig = useCallback(
    async (mode: BackendMode) => {
      const backendMode = mode === "openai" ? "llm" : "local";
      try {
        await invoke("set_transcription_backend_config", {
          config: { mode: backendMode },
        });
        setTranscriptionMode(mode);
      } catch (err) {
        console.error("Failed to save transcription backend config:", err);
        setError(
          `Transcription backend settings error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    [setError],
  );

  const handleTranscriptionModeChange = async (nextMode: BackendMode) => {
    if (nextMode === transcriptionMode) {
      return;
    }

    finalizeAllInProgressMessages();
    await saveTranscriptionBackendConfig(nextMode);
  };

  const toggleRecording = async () => {
    if (isRecordingBusy) return;

    if (!isRecordingActive) {
      if (!recordingSaveEnabled || !recordingSavePath) {
        setError("Enable save transcript and set a destination folder.");
        return;
      }
      if (transcriptionMode === "local" && !isInitialized) {
        setError("Initialize a model before starting recording.");
        return;
      }

      // Preserve existing transcription history when starting system recording.
      setPlayingSessionKey(null);
      if (currentAudioSource) {
        currentAudioSource.stop();
        currentAudioSource.disconnect();
        setCurrentAudioSource(null);
      }
      if (currentAudioContext) {
        currentAudioContext.close();
        setCurrentAudioContext(null);
      }

      setIsRecordingBusy(true);
      let startedRecording = false;
      let startedSystemAudio = false;
      try {
        await invoke("start_recording", {
          language: selectedLanguage === "auto" ? null : selectedLanguage,
        });
        startedRecording = true;
        await invoke("start_system_audio");
        startedSystemAudio = true;
        setIsRecordingActive(true);
        setError("");
      } catch (err) {
        console.error("Failed to start recording session:", err);
        if (startedSystemAudio) {
          try {
            await invoke("stop_system_audio");
          } catch (stopErr) {
            console.error("Failed to rollback system audio:", stopErr);
          }
        }
        if (startedRecording) {
          try {
            await invoke("stop_recording");
          } catch (stopErr) {
            console.error("Failed to rollback recording session:", stopErr);
          }
        }
        setIsRecordingActive(false);
        setError(
          `Recording start error: ${err instanceof Error ? err.message : String(err)}`,
        );
      } finally {
        setIsRecordingBusy(false);
      }
      return;
    }

    setIsRecordingBusy(true);
    try {
      await invoke("stop_recording");
      await invoke("stop_system_audio");
      setIsRecordingActive(false);
      setError("");
    } catch (err) {
      console.error("Failed to stop recording session:", err);
      setError(
        `Recording stop error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsRecordingBusy(false);
    }
  };

  const loadRecordingSaveConfig = async () => {
    try {
      const [enabled, path] = await invoke<[boolean, string | null]>(
        "get_recording_save_config",
      );
      setRecordingSaveEnabled(enabled);
      setRecordingSavePath(path || "");
    } catch (err) {
      console.error("Failed to load recording save config:", err);
    }
  };

  const saveRecordingSaveConfig = async (enabled: boolean, path: string) => {
    try {
      await invoke("set_recording_save_config", {
        enabled,
        path: path || null,
      });
      setRecordingSaveEnabled(enabled);
      setRecordingSavePath(path);
      localStorage.setItem("recordingSaveEnabled", enabled.toString());
      localStorage.setItem("recordingSavePath", path);
    } catch (err) {
      console.error("Failed to save recording save config:", err);
      setError(
        `Save transcript settings error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  const loadSettingsFromLocalStorage = () => {
    try {
      const savedModelPath = localStorage.getItem("selectedModelPath");
      if (savedModelPath) {
        setSelectedModel(savedModelPath);
      }

      const savedLanguage = localStorage.getItem("selectedLanguage");
      if (savedLanguage) {
        setSelectedLanguage(savedLanguage);
      }

      const savedVadThreshold = localStorage.getItem("vadThreshold");
      const savedPartialInterval = localStorage.getItem(
        "partialIntervalSeconds",
      );
      if (savedVadThreshold || savedPartialInterval) {
        setStreamingConfig((prev) => ({
          vadThreshold: savedVadThreshold
            ? parseFloat(savedVadThreshold)
            : prev.vadThreshold,
          partialIntervalSeconds: savedPartialInterval
            ? parseFloat(savedPartialInterval)
            : prev.partialIntervalSeconds,
        }));
      }

      const savedAudioCtx = localStorage.getItem("whisperAudioCtx");
      const savedTemperature = localStorage.getItem("whisperTemperature");
      if (savedAudioCtx || savedTemperature) {
        setWhisperParams((prev) => {
          const updated = {
            audioCtx: savedAudioCtx
              ? parseInt(savedAudioCtx, 10)
              : prev.audioCtx,
            temperature: savedTemperature
              ? parseFloat(savedTemperature)
              : prev.temperature,
          };
          invoke("set_whisper_params", { config: updated }).catch((err) =>
            console.error("Failed to reapply Whisper params:", err),
          );
          return updated;
        });
      }

      const savedRecordingSaveEnabled = localStorage.getItem(
        "recordingSaveEnabled",
      );
      const savedRecordingSavePath = localStorage.getItem("recordingSavePath");
      if (savedRecordingSaveEnabled !== null) {
        const enabled = savedRecordingSaveEnabled === "true";
        const path = savedRecordingSavePath || "";
        setRecordingSaveEnabled(enabled);
        setRecordingSavePath(path);
        saveRecordingSaveConfig(enabled, path);
      }


    } catch (err) {
      console.error("Failed to load settings from localStorage:", err);
    }
  };



  useEffect(() => {
    const unlistenTranscription = listen<TranscriptionSegment>(
      "transcription-segment",
      (event) => {
        const segment = event.payload;

        upsertTranscriptionSegment(segment);
      },
    );

    const unlistenVoiceActivity = listen<VoiceActivityEvent>(
      "voice-activity",
      (event) => {
        const { source, isActive, sessionId } = event.payload;
        setVoiceActivity((prev) => {
          return {
            ...prev,
            [source]: {
              isActive,
              sessionId,
            },
          };
        });
      },
    );

    const unlistenBackendError = listen<BackendErrorEvent>(
      "backend-error",
      (event) => {
        const payload = event.payload;
        if (payload.message) {
          setError(payload.message);
        }
        if (payload.fallbackMode === "local") {
          finalizeAllInProgressMessages();
          setTranscriptionMode("local");
        }
      },
    );

    const unlistenModelInstallProgress = listen<ModelInstallProgressEvent>(
      "model-install-progress",
      (event) => {
        const progress = event.payload;
        setModelInstallProgress((prev) => ({
          ...prev,
          [progress.modelId]: progress,
        }));
      },
    );

    loadSettingsFromLocalStorage();
    refreshAllModels();
    loadLanguages();
    loadAudioDevices();
    checkMicPermission();
    loadStreamingConfig();
    loadWhisperParams();
    loadRecordingSaveConfig();

    loadTranscriptionBackendConfig();
    loadSummarizationConfig();

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenVoiceActivity.then((fn) => fn());
      unlistenBackendError.then((fn) => fn());
      unlistenModelInstallProgress.then((fn) => fn());
    };
  }, [
    finalizeAllInProgressMessages,
    loadStreamingConfig,
    loadWhisperParams,
    loadTranscriptionBackendConfig,
    loadSummarizationConfig,
    upsertTranscriptionSegment,
  ]);

  const getTotalMessageCount = useCallback(
    (sessions: SessionTranscription[]) =>
      sessions.reduce((total, session) => total + session.messages.length, 0),
    [],
  );

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  const handleScrollContainer = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      return;
    }

    const distanceFromBottom =
      container.scrollHeight - container.scrollTop - container.clientHeight;
    const shouldPauseAutoScroll = distanceFromBottom > container.clientHeight;

    setIsAutoScrollPaused(shouldPauseAutoScroll);

    if (!shouldPauseAutoScroll) {
      setNewMessageCount(0);
    }
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;
    const currentHeight = container?.scrollHeight ?? 0;
    const previousHeight = previousScrollHeightRef.current;
    const grewInHeight = currentHeight > previousHeight;
    previousScrollHeightRef.current = currentHeight;

    const currentCount = getTotalMessageCount(transcriptions);
    const previousCount = previousMessageCountRef.current;
    const incomingCount = Math.max(0, currentCount - previousCount);
    previousMessageCountRef.current = currentCount;

    if (incomingCount === 0 && !grewInHeight) {
      return;
    }

    if (isAutoScrollPaused) {
      setNewMessageCount(
        (prev) => prev + (incomingCount > 0 ? incomingCount : 1),
      );
      return;
    }

    scrollToBottom("smooth");
  }, [
    getTotalMessageCount,
    isAutoScrollPaused,
    scrollToBottom,
    transcriptions,
  ]);

  useEffect(() => {
    if (selectedModel) {
      localStorage.setItem("selectedModelPath", selectedModel);
    } else {
      localStorage.removeItem("selectedModelPath");
    }
  }, [selectedModel]);

  useEffect(() => {
    if (selectedModel) {
      setIsInitialized(false);
      initializeWhisper();
    }
  }, [selectedModel]);

  const scanForModels = async () => {
    try {
      const models = await invoke<ModelInfo[]>("scan_models");
      setAvailableModels(models);
      setSelectedModel((prev) => {
        if (prev && models.some((model) => model.path === prev)) {
          return prev;
        }
        return models[0]?.path ?? "";
      });
    } catch (err) {
      console.error("Model scan error:", err);
      setError(`Model scan error: ${err}`);
    }
  };

  const loadLanguages = async () => {
    try {
      const langs = await invoke<[string, string][]>("get_supported_languages");
      const normalizedLangs = normalizeLanguageOptions(langs);
      setAvailableLanguages(normalizedLangs);

      if (
        normalizedLangs.length > 0 &&
        !normalizedLangs.some(([code]) => code === selectedLanguage)
      ) {
        const fallbackLanguage = normalizedLangs.some(([code]) => code === "en")
          ? "en"
          : normalizedLangs[0][0];
        setSelectedLanguage(fallbackLanguage);
        localStorage.setItem("selectedLanguage", fallbackLanguage);
        await invoke("update_language", {
          language: fallbackLanguage === "auto" ? null : fallbackLanguage,
        });
      }
    } catch (err) {
      console.error("Failed to load languages:", err);
    }
  };

  const loadRemoteModels = async () => {
    try {
      setIsLoadingRemoteModels(true);
      const models = await invoke<RemoteModelStatus[]>("list_remote_models");
      setRemoteModels(models);
    } catch (err) {
      console.error("Failed to load remote models:", err);
      setError(`Remote model fetch error: ${err}`);
    } finally {
      setIsLoadingRemoteModels(false);
    }
  };

  const loadAudioDevices = async () => {
    try {
      const devices = await invoke<AudioDevice[]>("list_audio_devices");
      setAudioDevices(devices);
      const preferredDevice =
        devices.find((d) => d.is_default) ??
        (devices.length > 0 ? devices[0] : undefined);
      if (preferredDevice) {
        setSelectedAudioDevice(preferredDevice.name);
        await invoke("select_audio_device", {
          deviceName: preferredDevice.name,
        });
      }
    } catch (err) {
      console.error("Failed to load audio devices:", err);
      setError(`Microphone device fetch error: ${err}`);
    }
  };

  const checkMicPermission = async () => {
    try {
      const hasPermission = await invoke<boolean>(
        "check_microphone_permission",
      );
      setHasMicPermission(hasPermission);
    } catch (err) {
      console.error("Failed to check mic permission:", err);
      setHasMicPermission(false);
    }
  };

  const handleAudioDeviceChange = async (deviceName: string) => {
    try {
      await invoke("select_audio_device", { deviceName });
      setSelectedAudioDevice(deviceName);
    } catch (err) {
      console.error("Failed to select audio device:", err);
      setError(`Device selection error: ${err}`);
    }
  };

  const summarizeCurrentSession = async () => {
    if (isSummarizing) {
      return;
    }

    const allMessages = transcriptions
      .flatMap((session) =>
        session.messages.map((message) => ({ ...message, speaker: session.speaker }))
      )
      .filter((message) => message.isFinal && message.text.trim().length > 0)
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) {
          return a.timestamp - b.timestamp;
        }
        if (a.sessionId !== b.sessionId) {
          return a.sessionId - b.sessionId;
        }
        return a.messageId - b.messageId;
      });

    if (allMessages.length === 0) {
      setError("No conversation available to summarize.");
      return;
    }

    setIsSummarizing(true);
    try {
      const transcript = allMessages
        .map(
          (message) =>
            `[${message.speaker}] ${normalizeMessageText(message.text)}`,
        )
        .join("\n");

      let summary: string | null = null;
      let usedSource: "AI" | "Local" = "AI";

      try {
        summary = await invoke<string>("summarize_transcript", {
          transcript,
          language: selectedLanguage,
        });
        if (summary.trim()) {
          setSummarySource("AI");
          usedSource = "AI";
        }
      } catch (aiErr) {
        const aiMessage = aiErr instanceof Error ? aiErr.message : String(aiErr);
        const fallbackSummary = summarizeLocally(allMessages);
        if (!fallbackSummary.trim()) {
          throw new Error(aiMessage);
        }
        summary = fallbackSummary;
        setSummarySource("Local");
        usedSource = "Local";

        if (!isSilentSummaryFallback(aiMessage)) {
          setError(`Summary provider error: ${aiMessage}`);
        }
      }

      if (!summary?.trim()) {
        throw new Error("Unable to produce a summary");
      }

      setSummaryPanelText(summary.trim());
      setIsSummaryExpanded(true);
      if (usedSource !== "Local") {
        setError("");
      }
    } catch (err) {
      console.error("Failed to summarize conversation:", err);
      setError(
        `Summary error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsSummarizing(false);
    }
  };

  const refreshAllModels = async () => {
    await scanForModels();
    await loadRemoteModels();
  };

  const handleLanguageChange = async (language: string) => {
    setSelectedLanguage(language);
    localStorage.setItem("selectedLanguage", language);

    try {
      await invoke("update_language", {
        language: language === "auto" ? null : language,
      });
    } catch (err) {
      console.error("Failed to update language:", err);
      setError(
        `Language update error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleInstallModel = async (modelId: string) => {
    setModelOperations((prev) => ({ ...prev, [modelId]: true }));
    setModelInstallProgress((prev) => ({
      ...prev,
      [modelId]: {
        modelId,
        filename: "",
        downloadedBytes: 0,
        totalBytes: 1,
        percent: 0,
        status: "downloading",
      },
    }));
    try {
      await invoke<ModelInfo>("install_model", { modelId });
      await refreshAllModels();
    } catch (err) {
      console.error("Install model error:", err);
      setError(
        `Model install error: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    } finally {
      setModelOperations((prev) => ({ ...prev, [modelId]: false }));
    }
  };

  const handleDeleteModel = async (model: RemoteModelStatus) => {
    if (!model.path) return;
    setModelOperations((prev) => ({ ...prev, [model.id]: true }));
    try {
      await invoke("delete_model", { modelPath: model.path });
      setSelectedModel((prev) => (prev === model.path ? "" : prev));
      await refreshAllModels();
    } catch (err) {
      console.error("Delete model error:", err);
      setError(
        `Model delete error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setModelOperations((prev) => ({ ...prev, [model.id]: false }));
    }
  };

  const formatModelSize = (bytes: number) => {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const formatInstallProgress = (progress?: ModelInstallProgressEvent) => {
    if (!progress) {
      return "";
    }
    const total = progress.totalBytes > 0 ? progress.totalBytes : 1;
    const percent = Math.max(
      0,
      Math.min(100, Number.isFinite(progress.percent) ? progress.percent : 0),
    );
    return `${percent.toFixed(1)}% (${formatModelSize(progress.downloadedBytes)} / ${formatModelSize(total)})`;
  };

  const initializeWhisper = async () => {
    if (!selectedModel) return;

    try {
      setError("");
      await invoke("initialize_whisper", { modelPath: selectedModel });
      setIsInitialized(true);
    } catch (err) {
      setError(`Initialization error: ${err}`);
      setIsInitialized(false);
    }
  };

  const toggleMute = async () => {
    if (isMicBusy) {
      return;
    }

    if (isMuted) {
      await startMic();
    } else {
      await stopMic();
    }
  };

  const startMic = async () => {
    if (isMicBusy) {
      return;
    }

    setIsMicBusy(true);

    if (transcriptionMode === "local" && !isInitialized) {
      setError("Model is initializing...");
      setIsMicBusy(false);
      return;
    }

    try {
      await invoke("start_mic", {
        language: selectedLanguage === "auto" ? null : selectedLanguage,
      });
      setIsMuted(false);
      setError("");
    } catch (err) {
      console.error("Mic start error:", err);
      setError(
        `Microphone start error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsMicBusy(false);
    }
  };

  const stopMic = async () => {
    if (isMicBusy) {
      return;
    }

    setIsMicBusy(true);

    setIsMuted(true);

    try {
      await invoke("stop_mic");
    } catch (err) {
      console.error("Mic stop error:", err);
      setError(
        `Microphone stop error: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsMicBusy(false);
    }
  };

  const stopAudio = () => {
    if (currentAudioSource) {
      currentAudioSource.stop();
      currentAudioSource.disconnect();
      setCurrentAudioSource(null);
    }
    if (currentAudioContext) {
      currentAudioContext.close();
      setCurrentAudioContext(null);
    }
    setPlayingSessionKey(null);

    if (transcriptionSuppressedForPlaybackRef.current) {
      invoke("set_transcription_suppressed", { enabled: false })
        .then(() => {
          transcriptionSuppressedForPlaybackRef.current = false;
        })
        .catch((err) => {
          console.error("Failed to disable transcription suppression:", err);
          setError(
            `Resume transcription error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
    }
  };

  const clearAllMessages = async () => {
    try {
      await invoke("stop_system_audio");
    } catch (err) {
      console.debug("stop_system_audio during clear ignored:", err);
    }

    try {
      await invoke("stop_recording");
    } catch (err) {
      console.debug("stop_recording during clear ignored:", err);
    }

    setIsRecordingActive(false);
    stopAudio();
    setTranscriptions([]);
  };

  const handleCopySessionText = async (
    sessionKey: string,
    sessionText: string,
  ) => {
    try {
      await navigator.clipboard.writeText(sessionText);
      setCopiedSessionKey(sessionKey);
      if (copyFeedbackTimeoutRef.current) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
      copyFeedbackTimeoutRef.current = window.setTimeout(() => {
        setCopiedSessionKey(null);
        copyFeedbackTimeoutRef.current = null;
      }, 1500);
    } catch (err) {
      setError(
        `Copy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const formatSegmentTimestamp = (timestamp: number) => {
    const millis = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
    return new Date(millis).toLocaleString("en-US", {
      hour12: false,
    });
  };

  const handleCopyAllHistory = async () => {
    if (transcriptions.length === 0) {
      return;
    }

    const allMessages = transcriptions
      .flatMap((session) =>
        session.messages.map((message) => ({
          timestamp: message.timestamp,
          sender: session.speaker,
          text: message.text,
          sessionId: message.sessionId,
          messageId: message.messageId,
        })),
      )
      .sort((a, b) => {
        if (a.timestamp !== b.timestamp) {
          return a.timestamp - b.timestamp;
        }
        if (a.sessionId !== b.sessionId) {
          return a.sessionId - b.sessionId;
        }
        return a.messageId - b.messageId;
      });

    const exportText = allMessages
      .map(
        (message) =>
          `[${formatSegmentTimestamp(message.timestamp)}] ${message.sender}: ${message.text}`,
      )
      .join("\n");

    try {
      await navigator.clipboard.writeText(exportText);
      setCopiedAllHistory(true);
      if (copyAllFeedbackTimeoutRef.current) {
        window.clearTimeout(copyAllFeedbackTimeoutRef.current);
      }
      copyAllFeedbackTimeoutRef.current = window.setTimeout(() => {
        setCopiedAllHistory(false);
        copyAllFeedbackTimeoutRef.current = null;
      }, 1500);
    } catch (err) {
      setError(
        `History copy error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  useEffect(() => {
    return () => {
      if (copyFeedbackTimeoutRef.current) {
        window.clearTimeout(copyFeedbackTimeoutRef.current);
      }
      if (copyAllFeedbackTimeoutRef.current) {
        window.clearTimeout(copyAllFeedbackTimeoutRef.current);
      }
      if (streamingAutosaveTimeoutRef.current) {
        window.clearTimeout(streamingAutosaveTimeoutRef.current);
      }
    };
  }, []);

  const playSessionAudio = async (audioData: number[], sessionKey: string) => {
    if (audioData.length === 0) {
      return;
    }
    try {
      if (playingSessionKey === sessionKey) {
        stopAudio();
        return;
      }

      if (currentAudioSource || currentAudioContext) {
        stopAudio();
      }

      if (!transcriptionSuppressedForPlaybackRef.current) {
        try {
          await invoke("set_transcription_suppressed", { enabled: true });
          transcriptionSuppressedForPlaybackRef.current = true;
        } catch (err) {
          console.error("Failed to enable transcription suppression:", err);
          setError(
            `Pause transcription error: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      const audioContext = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = audioContext.createBuffer(1, audioData.length, 16000);
      const channelData = audioBuffer.getChannelData(0);

      for (let i = 0; i < audioData.length; i++) {
        channelData[i] = audioData[i];
      }

      const source = audioContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(audioContext.destination);

      setCurrentAudioSource(source);
      setCurrentAudioContext(audioContext);
      setPlayingSessionKey(sessionKey);

      source.onended = () => {
        audioContext.close();
        setCurrentAudioSource(null);
        setCurrentAudioContext(null);
        setPlayingSessionKey(null);
        if (transcriptionSuppressedForPlaybackRef.current) {
          invoke("set_transcription_suppressed", { enabled: false })
            .then(() => {
              transcriptionSuppressedForPlaybackRef.current = false;
            })
            .catch((err) => {
              console.error(
                "Failed to disable transcription suppression:",
                err,
              );
              setError(
                `Resume transcription error: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            });
        }
      };

      source.start(0);
    } catch (err) {
      console.error("Audio playback error:", err);
      setError(
        `Audio playback error: ${err instanceof Error ? err.message : String(err)}`,
      );
      setPlayingSessionKey(null);
      if (transcriptionSuppressedForPlaybackRef.current) {
        invoke("set_transcription_suppressed", { enabled: false })
          .then(() => {
            transcriptionSuppressedForPlaybackRef.current = false;
          })
          .catch((resumeErr) => {
            console.error(
              "Failed to disable transcription suppression:",
              resumeErr,
            );
          });
      }
    }
  };

  const showUserActivityIndicator =
    transcriptionMode === "local" &&
    voiceActivity.user.isActive &&
    !transcriptions.some(
      (session) =>
        session.source === "user" &&
        session.messages.some((message) => !message.isFinal),
    );
  const showSystemActivityIndicator =
    transcriptionMode === "local" &&
    voiceActivity.system.isActive &&
    !transcriptions.some(
      (session) =>
        session.source === "system" &&
        session.messages.some((message) => !message.isFinal),
    );

  return (
    <div className="flex flex-col h-screen w-screen bg-base-100">
      {/* Header */}
      <header
        data-tauri-drag-region
        className="app-header bg-base-100 border-b border-base-200 flex items-center py-1 px-4 gap-4"
      >
        <div className="shrink-0 flex items-center gap-1">
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={clearAllMessages}
            disabled={transcriptions.length === 0}
            title="Clear messages"
            aria-label="Clear messages"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={handleCopyAllHistory}
            disabled={transcriptions.length === 0}
            title={copiedAllHistory ? "History copied" : "Copy all history"}
            aria-label="Copy all history"
          >
            {copiedAllHistory ? (
              <Check className="w-4 h-4" />
            ) : (
              <Copy className="w-4 h-4" />
            )}
          </button>
        </div>

        <button
          className={`btn btn-ghost btn-sm ${isSummarizing ? "btn-disabled" : ""}`}
          onClick={summarizeCurrentSession}
          disabled={isSummarizing || transcriptions.length === 0}
          title="Summarize full conversation"
        >
          {isSummarizing ? "Summarizing..." : "Summarize"}
        </button>

        <div className="flex-1"></div>

        <div className="flex items-center gap-2 shrink-0">
          <select
            value={selectedLanguage}
            onChange={(e) => handleLanguageChange(e.target.value)}
            className="select select-bordered select-xs w-24 font-normal"
          >
            {availableLanguages.length === 0 ? (
              <option value="en">English</option>
            ) : (
              availableLanguages.map(([code, name]) => (
                <option key={code} value={code}>
                  {name}
                </option>
              ))
            )}
          </select>

          <div className="join">
            <button
              className={`join-item btn btn-sm ${
                transcriptionMode === "local" && !isInitialized
                  ? "btn-disabled"
                  : isMuted
                    ? "btn-ghost"
                    : "btn-primary"
              }`}
              onClick={toggleMute}
              disabled={
                isMicBusy || (transcriptionMode === "local" && !isInitialized)
              }
              title={
                isMicBusy
                  ? "Connecting..."
                  : isMuted
                    ? "Mic on"
                    : "Mic off"
              }
            >
              {isMicBusy ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : isMuted ? (
                <MicOff className="w-4 h-4" />
              ) : (
                <Mic className="w-4 h-4" />
              )}
            </button>

            <button
              className={`join-item btn btn-sm ${
                isRecordingActive ? "btn-error" : "btn-ghost"
              } ${isRecordingBusy ? "btn-disabled" : ""}`}
              onClick={toggleRecording}
              disabled={isRecordingBusy}
              title={isRecordingActive ? "Stop recording" : "Start recording"}
            >
              {isRecordingActive ? (
                <StopCircle className="w-4 h-4" />
              ) : (
                <Circle className="w-4 h-4" />
              )}
            </button>
          </div>

          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={() => setShowSettings(true)}
          >
            <Settings className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative flex-1 overflow-hidden p-4">
        {summaryPanelText && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 w-[calc(100%-2rem)] max-w-3xl z-20">
            <div className="bg-base-200 border border-base-300 rounded-xl shadow-sm">
              <div className="px-3 py-2 flex items-center justify-between">
                <span className="text-sm font-medium">Summary</span>
                {summarySource && (
                  <span className="badge badge-ghost badge-sm">{summarySource}</span>
                )}
                <div className="flex items-center gap-1">
                  <button
                    className="btn btn-ghost btn-xs btn-square"
                    onClick={() => setIsSummaryExpanded((prev) => !prev)}
                    title={isSummaryExpanded ? "Collapse" : "Expand"}
                    aria-label={isSummaryExpanded ? "Collapse" : "Expand"}
                  >
                    {isSummaryExpanded ? (
                      <ChevronUp className="w-4 h-4" />
                    ) : (
                      <ChevronDown className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    className="btn btn-ghost btn-xs btn-square"
                    onClick={() => setSummaryPanelText(null)}
                    title="Close"
                    aria-label="Close"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
              {isSummaryExpanded && (
                <div className="px-3 pb-3 text-sm whitespace-pre-wrap leading-relaxed border-t border-base-300/70 max-h-[60vh] overflow-y-auto">
                  {summaryPanelText}
                </div>
              )}
            </div>
          </div>
        )}

        <div
          ref={scrollContainerRef}
          onScroll={handleScrollContainer}
          data-chat-scroll
          className="h-full overflow-y-auto"
        >
          <div
            className={`max-w-3xl mx-auto space-y-3 ${
              summaryPanelText ? (isSummaryExpanded ? "pt-32" : "pt-16") : ""
            }`}
          >
            {error && (
              <div className="alert alert-error">
                <span className="text-sm">{error}</span>
              </div>
            )}

            {needsModelSetup ? (
              <div className="max-w-3xl mx-auto border border-base-300 rounded-xl p-4 bg-base-200/50 space-y-4">
                <div>
                  <p className="text-sm font-semibold">
                    Install a Whisper model first
                  </p>
                  <p className="text-xs opacity-70 mt-1">
                    In Local mode, microphone transcription cannot start without a model. Select one below and install it.
                  </p>
                </div>

                {isLoadingRemoteModels ? (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="loading loading-spinner loading-xs"></span>
                    Loading model list...
                  </div>
                ) : remoteModels.length === 0 ? (
                  <p className="text-sm opacity-70">
                    Failed to fetch available models. Reload from Settings (Model Settings).
                  </p>
                ) : (
                  <div className="space-y-3">
                    {remoteModels.map((model) => {
                      const progress = modelInstallProgress[model.id];
                      const isInstalling = modelOperations[model.id];
                      const showProgress =
                        isInstalling && progress?.status === "downloading";
                      return (
                        <div
                          key={model.id}
                          className="border border-base-300 rounded-xl p-3 flex items-start justify-between gap-3"
                        >
                          <div>
                            <p className="font-medium text-sm">{model.name}</p>
                            <p className="text-xs opacity-70">
                              {model.description}
                            </p>
                            <p className="text-xs opacity-60 mt-1">
                              {formatModelSize(model.size)}
                            </p>
                            {showProgress && (
                              <div className="mt-2 space-y-1">
                                <progress
                                  className="progress progress-primary w-40"
                                  value={Math.max(
                                    0,
                                    Math.min(
                                      100,
                                      Number.isFinite(progress.percent)
                                        ? progress.percent
                                        : 0,
                                    ),
                                  )}
                                  max={100}
                                />
                                <p className="text-[11px] opacity-70">
                                  {formatInstallProgress(progress)}
                                </p>
                              </div>
                            )}
                          </div>
                          <button
                            className={`btn btn-xs ${model.installed ? "btn-outline" : "btn-primary"}`}
                            onClick={() =>
                              model.installed && model.path
                                ? setSelectedModel(model.path)
                                : handleInstallModel(model.id)
                            }
                            disabled={isInstalling}
                          >
                            {isInstalling
                              ? progress?.status === "downloading"
                                ? "Downloading..."
                                : "Processing..."
                              : model.installed
                                ? "Use"
                                : "Install"}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : transcriptions.length === 0 &&
              !voiceActivity.user.isActive &&
              !voiceActivity.system.isActive ? (
              <div className="flex-1 flex flex-col items-center justify-center text-center text-base-content/30 min-h-[50vh]">
                <MessageSquare className="w-16 h-16 mb-4 opacity-20" />
                <p className="text-sm font-medium">
                  Turn on the mic to transcribe your voice.
                </p>
                <p className="text-sm font-medium">
                  Turn on recording to transcribe system audio.
                </p>
              </div>
            ) : (
              <div className="flex flex-col">
                {transcriptions.map((session) => {
                  const alignment =
                    session.source === "user" ? "chat-end" : "chat-start";
                  const bubbleColor =
                    session.source === "user"
                      ? "chat-bubble-primary"
                      : "chat-bubble-secondary";
                  const sessionText = session.messages
                    .map((message) => message.text.trim())
                    .filter((text) => text.length > 0)
                    .join(" ")
                    .replace(/\s+/g, " ")
                    .trim();
                  const sessionAudio = session.messages
                    .map(
                      (message) => session.audioChunks[message.messageId] || [],
                    )
                    .flat();
                  const hasInProgressMessage = session.messages.some(
                    (message) => !message.isFinal,
                  );

                  return (
                    <div
                      key={session.sessionKey}
                      className={`chat ${alignment}`}
                    >
                      <div className="chat-header text-xs opacity-70">
                        <SpeakerChip
                          speaker={session.speaker}
                          participants={participants}
                          onChangeSpeaker={(name) => handleChangeSpeaker(session.sessionKey, name)}
                          onAddParticipant={handleAddParticipant}
                        />
                      </div>
                      <div
                        className={`chat-bubble text-sm ${bubbleColor} ${
                          hasInProgressMessage ? "opacity-70" : ""
                        }`}
                      >
                        <span className="flex-1 text-left">
                          {sessionText}
                          {hasInProgressMessage && (
                            <TypingDots inline className="ml-1" />
                          )}
                        </span>
                      </div>
                      <div className="chat-footer opacity-50 flex justify-between items-center">
                        <button
                          onClick={() =>
                            handleCopySessionText(
                              session.sessionKey,
                              sessionText,
                            )
                          }
                          className="btn btn-ghost btn-xs btn-circle"
                          title={
                            copiedSessionKey === session.sessionKey
                              ? "Copied"
                              : "Copy"
                          }
                        >
                          {copiedSessionKey === session.sessionKey ? (
                            <Check className="w-3 h-3" />
                          ) : (
                            <Copy className="w-3 h-3" />
                          )}
                        </button>
                        {sessionAudio.length > 0 && (
                          <button
                            onClick={() =>
                              playSessionAudio(sessionAudio, session.sessionKey)
                            }
                            className="btn btn-ghost btn-xs btn-circle"
                          >
                            {playingSessionKey === session.sessionKey ? (
                              <Square className="w-3 h-3" />
                            ) : (
                              <Play className="w-3 h-3" />
                            )}
                          </button>
                        )}

                        <time className="text-[10px] opacity-60">
                          {new Date(
                            session.messages[0].timestamp,
                          ).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                      </div>
                    </div>
                  );
                })}
                {showUserActivityIndicator && (
                  <div className="chat chat-end">
                    <div className="chat-bubble chat-bubble-primary opacity-70 text-sm">
                      <TypingDots className="mx-auto" />
                    </div>
                  </div>
                )}
                {showSystemActivityIndicator && (
                  <div className="chat chat-start">
                    <div className="chat-bubble chat-bubble-secondary opacity-70 text-sm">
                      <TypingDots className="mx-auto" />
                    </div>
                  </div>
                )}
                <div ref={messagesEndRef} />
              </div>
            )}
          </div>
        </div>

        {newMessageCount > 0 && (
          <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30">
            <button
              className="btn btn-ghost btn-sm border border-base-300 bg-base-100/95 text-base-content shadow-md"
              onClick={() => {
                scrollToBottom("smooth");
                setNewMessageCount(0);
                setIsAutoScrollPaused(false);
              }}
            >
              New messages: {newMessageCount}
            </button>
          </div>
        )}
      </main>

      {/* Settings Modal */}
      {showSettings && (
        <dialog className="modal modal-open">
          <div className="modal-box">
            <h3 className="font-bold text-lg mb-4 flex items-center justify-between">
              <span>Settings</span>
              <label className="swap swap-rotate btn btn-ghost btn-circle btn-sm">
                <input
                  type="checkbox"
                  checked={theme === "dark"}
                  onChange={(e) =>
                    setTheme(e.target.checked ? "dark" : "light")
                  }
                />
                <Sun className="swap-off w-4 h-4" />
                <Moon className="swap-on w-4 h-4" />
              </label>
            </h3>

            <div className="space-y-3">
              <details
                className="collapse collapse-arrow bg-base-200/50 border border-base-300"
                open
              >
                <summary className="collapse-title text-sm font-semibold">
                  Model Settings
                </summary>
                <div className="collapse-content space-y-4">
                  <div className="form-control">
                    <label className="label">
                        <span className="label-text">Selected Model</span>
                    </label>
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      className="select select-bordered w-full"
                    >
                      {availableModels.map((model) => (
                        <option key={model.path} value={model.path}>
                          {model.name?.trim() || model.path}
                        </option>
                      ))}
                    </select>
                    {selectedModel && (
                      <p className="text-xs opacity-60 mt-2 break-all">
                        In use: {selectedModelDisplayName}
                      </p>
                    )}
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="label-text font-semibold">
                        Available Models
                      </span>
                      <button
                        className="btn btn-xs"
                        onClick={refreshAllModels}
                        disabled={isLoadingRemoteModels}
                      >
                        Refresh
                      </button>
                    </div>

                    <div className="space-y-3 max-h-80 overflow-y-auto pr-1">
                      {isLoadingRemoteModels ? (
                        <div className="flex items-center gap-2 text-sm">
                          <span className="loading loading-spinner loading-xs"></span>
                          Loading...
                        </div>
                      ) : remoteModels.length === 0 ? (
                        <p className="text-sm opacity-60">
                          No available models found
                        </p>
                      ) : (
                        remoteModels.map((model) => {
                          const progress = modelInstallProgress[model.id];
                          const isInstalling = modelOperations[model.id];
                          const showProgress =
                            isInstalling && progress?.status === "downloading";
                          return (
                            <div
                              key={model.id}
                              className="border border-base-300 rounded-xl p-3 flex flex-col gap-2"
                            >
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <p className="font-medium text-sm">
                                    {model.name}
                                  </p>
                                  <p className="text-xs opacity-70">
                                    {model.description}
                                  </p>
                                  <p className="text-xs opacity-60 mt-1">
                                    {formatModelSize(model.size)}
                                  </p>
                                  {showProgress && (
                                    <div className="mt-2 space-y-1">
                                      <progress
                                        className="progress progress-primary w-40"
                                        value={Math.max(
                                          0,
                                          Math.min(
                                            100,
                                            Number.isFinite(progress.percent)
                                              ? progress.percent
                                              : 0,
                                          ),
                                        )}
                                        max={100}
                                      />
                                      <p className="text-[11px] opacity-70">
                                        {formatInstallProgress(progress)}
                                      </p>
                                    </div>
                                  )}
                                  {model.installed && model.path && (
                                    <p className="text-[11px] opacity-50 mt-1 break-all">
                                      {model.path}
                                    </p>
                                  )}
                                </div>
                                <div className="flex flex-row flex-wrap gap-2 items-center justify-end">
                                  {model.installed ? (
                                    <>
                                      <button
                                        className="btn btn-xs btn-outline text-[11px]"
                                        disabled={
                                          selectedModel === model.path ||
                                          !model.path ||
                                          modelOperations[model.id]
                                        }
                                        onClick={() =>
                                          model.path &&
                                          setSelectedModel(model.path)
                                        }
                                      >
                                        {selectedModel === model.path
                                          ? "In use"
                                          : "Use"}
                                      </button>
                                      <button
                                        className="btn btn-xs btn-error text-[11px]"
                                        onClick={() => handleDeleteModel(model)}
                                        disabled={modelOperations[model.id]}
                                      >
                                        {modelOperations[model.id]
                                          ? "Deleting..."
                                          : "Delete"}
                                      </button>
                                    </>
                                  ) : (
                                    <button
                                      className="btn btn-xs btn-primary text-[11px]"
                                      onClick={() => handleInstallModel(model.id)}
                                      disabled={modelOperations[model.id]}
                                    >
                                      {modelOperations[model.id]
                                        ? progress?.status === "downloading"
                                          ? "Downloading..."
                                          : "Installing..."
                                        : "Install"}
                                    </button>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              </details>

              <details className="collapse collapse-arrow bg-base-200/50 border border-base-300">
                <summary className="collapse-title text-sm font-semibold">
                  Microphone Settings
                </summary>
                <div className="collapse-content">
                  <div className="space-y-4">
                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">Input Device</span>
                      </label>
                      <select
                        value={selectedAudioDevice}
                        onChange={(e) =>
                          handleAudioDeviceChange(e.target.value)
                        }
                        className="select select-bordered w-full"
                      >
                        {audioDevices.map((device) => (
                          <option key={device.name} value={device.name}>
                            {device.name}
                            {device.is_default ? " (default)" : ""}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">Transcription Backend</span>
                      </label>
                      <select
                        value={transcriptionMode}
                        onChange={(e) =>
                          void handleTranscriptionModeChange(
                            e.target.value as BackendMode,
                          )
                        }
                        className="select select-bordered w-full"
                      >
                        <option value="local">Local (offline Whisper)</option>
                        <option value="openai">OpenAI API</option>
                      </select>
                      <label className="label">
                        <span className="label-text-alt opacity-70">
                          Local mode needs an installed Whisper model. OpenAI mode uses LLM_* env vars.
                        </span>
                      </label>
                    </div>
                  </div>
                </div>
              </details>

              <details className="collapse collapse-arrow bg-base-200/50 border border-base-300">
                <summary className="collapse-title text-sm font-semibold">
                  Summarization Settings
                </summary>
                <div className="collapse-content space-y-4">
                  <div className="form-control">
                    <label className="label cursor-pointer">
                      <span className="label-text">Enable AI summarization</span>
                      <input
                        type="checkbox"
                        className="toggle toggle-primary"
                        checked={summaryConfig.enabled}
                        onChange={(e) =>
                          setSummaryConfig((prev) => ({
                            ...prev,
                            enabled: e.target.checked,
                          }))
                        }
                      />
                    </label>
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text">API Base URL</span>
                    </label>
                    <input
                      type="text"
                      className="input input-bordered w-full"
                      value={summaryConfig.apiBaseUrl}
                      onChange={(e) =>
                        setSummaryConfig((prev) => ({
                          ...prev,
                          apiBaseUrl: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text">Model</span>
                    </label>
                    <input
                      type="text"
                      className="input input-bordered w-full"
                      value={summaryConfig.model}
                      onChange={(e) =>
                        setSummaryConfig((prev) => ({
                          ...prev,
                          model: e.target.value,
                        }))
                      }
                    />
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text">API Key Source</span>
                      <span className="label-text-alt opacity-70">
                        {summaryConfig.hasApiKey
                          ? "Detected in environment"
                          : "Missing in environment"}
                      </span>
                    </label>
                    <div className="text-xs opacity-70 leading-relaxed">
                      Summarization uses <code>LLM_SUMMARY_API_KEY</code> (or
                      <code> LLM_API_KEY</code>) from your <code>.env</code>.
                    </div>
                  </div>

                  <div className="form-control">
                    <label className="label">
                      <span className="label-text">Custom System Prompt (optional)</span>
                    </label>
                    <textarea
                      className="textarea textarea-bordered w-full text-sm"
                      rows={4}
                      placeholder="You summarize spoken conversations. Return concise markdown with sections: Summary, Key Points, Action Items. Keep factual and avoid fabrication."
                      value={summaryConfig.customSystemPrompt || ""}
                      onChange={(e) =>
                        setSummaryConfig((prev) => ({
                          ...prev,
                          customSystemPrompt: e.target.value || undefined,
                        }))
                      }
                    />
                    <label className="label">
                      <span className="label-text-alt opacity-70">Leave empty to use the default prompt.</span>
                    </label>
                  </div>

                  <div className="flex justify-end">
                    <button
                      className={`btn btn-sm ${
                        isSavingSummaryConfig ? "btn-disabled" : "btn-primary"
                      }`}
                      onClick={saveSummarizationConfig}
                      disabled={isSavingSummaryConfig}
                    >
                      {isSavingSummaryConfig ? "Saving..." : "Save"}
                    </button>
                  </div>
                </div>
              </details>

              <details className="collapse collapse-arrow bg-base-200/50 border border-base-300">
                <summary className="collapse-title text-sm font-semibold">
                  Save Transcript Settings
                </summary>
                <div className="collapse-content space-y-4">
                  <div className="form-control">
                    <label className="label cursor-pointer">
                      <span className="label-text">Save transcript</span>
                      <input
                        type="checkbox"
                        className="toggle toggle-primary"
                        checked={recordingSaveEnabled}
                        onChange={(e) =>
                          saveRecordingSaveConfig(
                            e.target.checked,
                            recordingSavePath,
                          )
                        }
                      />
                    </label>
                  </div>
                  {recordingSaveEnabled && (
                    <div className="form-control">
                      <label className="label">
                        <span className="label-text">Destination Folder</span>
                      </label>
                      <input
                        type="text"
                        placeholder="/path/to/save/folder"
                        value={recordingSavePath}
                        onChange={(e) => setRecordingSavePath(e.target.value)}
                        onBlur={() =>
                          saveRecordingSaveConfig(
                            recordingSaveEnabled,
                            recordingSavePath,
                          )
                        }
                        className="input input-bordered w-full"
                      />
                      <label className="label">
                        <span className="label-text-alt opacity-70">
                          Saves session transcript text into the selected folder.
                        </span>
                      </label>
                    </div>
                  )}
                </div>
              </details>

              <details className="collapse collapse-arrow bg-base-200/50 border border-base-300">
                <summary className="collapse-title text-sm font-semibold">
                  Whisper Model Settings
                </summary>
                <div className="collapse-content space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="label-text font-semibold">
                      Whisper Model Settings
                    </span>
                    <button
                      className={`btn btn-xs ${
                        isSavingWhisperParams ? "btn-disabled" : "btn-primary"
                      }`}
                      onClick={() => saveWhisperParams(whisperParams)}
                      disabled={isSavingWhisperParams}
                    >
                      {isSavingWhisperParams ? "Saving..." : "Save"}
                    </button>
                  </div>

                  <div className="space-y-2">
                    <label className="label">
                      <span className="label-text">
                        Context Length (audio_ctx: {whisperParams.audioCtx})
                      </span>
                    </label>
                    <p className="text-xs opacity-60">
                      Larger values reference more past audio but increase compute and memory usage.
                    </p>
                    <input
                      type="range"
                      min="50"
                      max="1500"
                      step="50"
                      value={whisperParams.audioCtx}
                      onChange={(e) =>
                        setWhisperParams((prev) => ({
                          ...prev,
                          audioCtx:
                            parseInt(e.target.value, 10) || prev.audioCtx,
                        }))
                      }
                      className="range range-sm range-primary"
                    />
                    <input
                      type="number"
                      min="50"
                      max="1500"
                      step="50"
                      value={whisperParams.audioCtx}
                      onChange={(e) =>
                        setWhisperParams((prev) => ({
                          ...prev,
                          audioCtx:
                            parseInt(e.target.value, 10) || prev.audioCtx,
                        }))
                      }
                      className="input input-bordered input-sm w-32"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="label">
                      <span className="label-text">
                        Temperature (temperature:{" "}
                        {whisperParams.temperature.toFixed(2)})
                      </span>
                    </label>
                    <p className="text-xs opacity-60">
                      Higher values increase output diversity. Values close to 0 are more stable.
                    </p>
                    <input
                      type="range"
                      min="0"
                      max="1"
                      step="0.05"
                      value={whisperParams.temperature}
                      onChange={(e) =>
                        setWhisperParams((prev) => ({
                          ...prev,
                          temperature:
                            parseFloat(e.target.value) ?? prev.temperature,
                        }))
                      }
                      className="range range-sm range-primary"
                    />
                    <input
                      type="number"
                      min="0"
                      max="1"
                      step="0.05"
                      value={whisperParams.temperature}
                      onChange={(e) =>
                        setWhisperParams((prev) => ({
                          ...prev,
                          temperature:
                            parseFloat(e.target.value) ?? prev.temperature,
                        }))
                      }
                      className="input input-bordered input-sm w-32"
                    />
                  </div>
                </div>
              </details>

              <details className="collapse collapse-arrow bg-base-200/50 border border-base-300">
                <summary className="collapse-title text-sm font-semibold">
                  Streaming Settings
                </summary>
                <div className="collapse-content space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="label-text font-semibold">
                      Streaming Settings
                    </span>
                    <button
                      className={`btn btn-xs ${
                        isSavingStreamingConfig ? "btn-disabled" : "btn-primary"
                      }`}
                      onClick={() => saveStreamingConfig(streamingConfig)}
                      disabled={isSavingStreamingConfig}
                    >
                      {isSavingStreamingConfig ? "Saving..." : "Save"}
                    </button>
                  </div>

                  <div className="space-y-2">
                    <label className="label">
                      <span className="label-text">
                        VAD Threshold ({streamingConfig.vadThreshold.toFixed(3)})
                      </span>
                    </label>
                    <p className="text-xs opacity-60">
                      Lower values detect quieter speech more easily; higher values require louder sound.
                    </p>
                    <input
                      type="range"
                      min="0.01"
                      max="0.99"
                      step="0.01"
                      value={streamingConfig.vadThreshold}
                      onChange={(e) =>
                        setStreamingConfig((prev) => ({
                          ...prev,
                          vadThreshold: parseFloat(e.target.value),
                        }))
                      }
                      className="range range-sm range-primary"
                    />
                    <input
                      type="number"
                      min="0.01"
                      max="0.99"
                      step="0.01"
                      value={streamingConfig.vadThreshold}
                      onChange={(e) =>
                        setStreamingConfig((prev) => ({
                          ...prev,
                          vadThreshold: parseFloat(e.target.value) || 0.1,
                        }))
                      }
                      className="input input-bordered input-sm w-32"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="label">
                      <span className="label-text">Transcription Interval (sec)</span>
                    </label>
                    <p className="text-xs opacity-60">
                      Shorter intervals update more frequently; longer intervals return larger chunks.
                    </p>
                    <input
                      type="range"
                      min="0.5"
                      max="30"
                      step="0.5"
                      value={streamingConfig.partialIntervalSeconds}
                      onChange={(e) =>
                        setStreamingConfig((prev) => ({
                          ...prev,
                          partialIntervalSeconds: parseFloat(e.target.value),
                        }))
                      }
                      className="range range-sm range-primary"
                    />
                    <input
                      type="number"
                      min="0.5"
                      max="30"
                      step="0.5"
                      value={streamingConfig.partialIntervalSeconds}
                      onChange={(e) =>
                        setStreamingConfig((prev) => ({
                          ...prev,
                          partialIntervalSeconds:
                            parseFloat(e.target.value) || 4,
                        }))
                      }
                      className="input input-bordered input-sm w-32"
                    />
                  </div>
                </div>
              </details>

              {hasMicPermission === false && (
                <div className="alert alert-warning">
                  <span className="text-xs">⚠️ Microphone permission is required</span>
                </div>
              )}

              {!isInitialized && selectedModel && (
                <div className="alert alert-info">
                  <span className="text-xs">Initializing...</span>
                </div>
              )}
            </div>

            <div className="modal-action">
              <button className="btn" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
          </div>
          <form method="dialog" className="modal-backdrop">
            <button onClick={() => setShowSettings(false)}>close</button>
          </form>
        </dialog>
      )}
    </div>
  );
}

export default App;
