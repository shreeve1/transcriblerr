import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Mic,
  MicOff,
  Settings,
  Circle,
  StopCircle,
  Copy,
  Check,
  Trash2,
  MessageSquare,
  ChevronDown,
  ChevronUp,
  X,
  Save,
} from "lucide-react";
import { TranscriptList } from "./components/TranscriptList";
import { SettingsModal } from "./components/SettingsModal";
import { ModelSetupPanel } from "./components/ModelSetupPanel";
import { useTheme } from "./hooks/useTheme";
import { groupTranscriptions } from "./groupTranscriptions";
import type {
  ApiKeyStatus,
  AudioDevice,
  BackendErrorEvent,
  BackendMode,
  ModelInfo,
  ModelInstallProgressEvent,
  RemoteModelStatus,
  SessionTranscription,
  StreamingConfig,
  SummarizationConfig,
  SummarizationConfigUpdate,
  TranscriptionBackendConfig,
  TranscriptionSegment,
  VoiceActivityEvent,
  VoiceActivityState,
  WhisperParamsConfig,
} from "./types";
import {
  formatSegmentTimestamp,
  isSilentSummaryFallback,
  normalizeBackendMode,
  normalizeLanguageOptions,
  normalizeMessageText,
  sourceLabel,
  summarizeLocally,
} from "./utils/transcript";
import "./App.css";

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
  const groupedTranscriptions = useMemo(
    () => groupTranscriptions(transcriptions),
    [transcriptions],
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
    enabled: true,
    apiBaseUrl: "https://api.openai.com/v1",
    model: "gpt-4o",
    hasApiKey: false,
    customSystemPrompt: "",
    summarySavePath: "",
    autoSaveSummary: false,
  });
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus>({
    hasStoredKey: false,
    hasEnvKey: false,
    hasAnyKey: false,
  });
  const [isSavingSummaryConfig, setIsSavingSummaryConfig] = useState(false);
  const { theme, setTheme } = useTheme();
  const [transcriptionMode, setTranscriptionMode] =
    useState<BackendMode>("local");
  const [transcriptionModel, setTranscriptionModel] =
    useState("gpt-4o-transcribe");
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
  const speakerNameCacheRef = useRef<Record<string, string>>({});
  const transcriptionSuppressedForPlaybackRef = useRef(false);
  const copyFeedbackTimeoutRef = useRef<number | null>(null);
  const copyAllFeedbackTimeoutRef = useRef<number | null>(null);
  const streamingAutosaveTimeoutRef = useRef<number | null>(null);
  const lastAppliedStreamingConfigRef = useRef<StreamingConfig | null>(null);
  const didRunInitialBackendLoadRef = useRef(false);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const previousMessageCountRef = useRef(0);
  const previousScrollHeightRef = useRef(0);
  const speakerChipOpenCountRef = useRef(0);
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
        const speakerSuffix = segment.speakerId ? `-${segment.speakerId}` : "";
        const sessionKey = `${segment.source}-${segment.sessionId}${speakerSuffix}`;
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
          const shouldAttachSpeaker = !session.speakerId && !!segment.speakerId;
          const nextSpeakerId = session.speakerId ?? segment.speakerId ?? undefined;
          const nextSpeaker = shouldAttachSpeaker && segment.speakerId
            ? (speakerNameCacheRef.current[segment.speakerId] || segment.speakerId.replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase()))
            : session.speaker;

          sessions[sessionIndex] = {
            ...session,
            speakerId: nextSpeakerId,
            speaker: nextSpeaker,
            messages: upsertMessages(session.messages),
            audioChunks: upsertAudioChunks(session.audioChunks),
          };
        } else {
          const speakerLabel = segment.speakerId
            ? (speakerNameCacheRef.current[segment.speakerId] || segment.speakerId.replace("_", " ").replace(/^\w/, c => c.toUpperCase()))
            : (sourceDefaultSpeakerRef.current[segment.source] ?? sourceLabel(segment.source));

          sessions.push({
            sessionKey,
            sessionId: segment.sessionId,
            source: segment.source,
            speaker: speakerLabel,
            speakerId: segment.speakerId ?? undefined,
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
        // If this session has a backend speaker ID, rename via backend
        if (target.speakerId) {
          invoke("rename_speaker", { speakerId: target.speakerId, displayName: name }).catch(() => {});
        }
      }
      return prev.map(s =>
        s.sessionKey === sessionKey ? { ...s, speaker: name } : s
      );
    });
  }, []);

  const handleSpeakerChipOpenChange = useCallback((isOpen: boolean) => {
    speakerChipOpenCountRef.current += isOpen ? 1 : -1;
  }, []);

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
      setTranscriptionModel(config.model || "gpt-4o-transcribe");
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

  const loadApiKeyStatus = useCallback(async () => {
    try {
      const status = await invoke<ApiKeyStatus>("get_api_key_status");
      setApiKeyStatus(status);
    } catch (err) {
      console.error("Failed to load API key status:", err);
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
        summarySavePath: summaryConfig.summarySavePath || undefined,
        autoSaveSummary: summaryConfig.autoSaveSummary,
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

  const saveApiKey = useCallback(
    async (apiKey: string) => {
      const status = await invoke<ApiKeyStatus>("set_api_key", { apiKey });
      setApiKeyStatus(status);
      await loadSummarizationConfig();
      setError("");
      return "API key saved";
    },
    [loadSummarizationConfig, setError],
  );

  const deleteApiKey = useCallback(async () => {
    const status = await invoke<ApiKeyStatus>("delete_api_key");
    setApiKeyStatus(status);
    await loadSummarizationConfig();
    setError("");
    return "Saved API key deleted";
  }, [loadSummarizationConfig, setError]);

  const testApiKey = useCallback(async (apiKey?: string) => {
    return await invoke<string>("test_api_key", {
      apiKey: apiKey?.trim() ? apiKey : null,
    });
  }, []);

  const saveTranscriptionBackendConfig = useCallback(
    async (mode: BackendMode, model = transcriptionModel) => {
      const backendMode = mode === "openai" ? "llm" : "local";
      try {
        await invoke("set_transcription_backend_config", {
          config: { mode: backendMode, model },
        });
        setTranscriptionMode(mode);
        setTranscriptionModel(model);
      } catch (err) {
        console.error("Failed to save transcription backend config:", err);
        setError(
          `Transcription backend settings error: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    [setError, transcriptionModel],
  );

  const handleTranscriptionModeChange = async (nextMode: BackendMode) => {
    if (nextMode === transcriptionMode) {
      return;
    }

    finalizeAllInProgressMessages();
    await saveTranscriptionBackendConfig(nextMode);
  };

  const saveTranscriptionModelConfig = async (model: string) => {
    await saveTranscriptionBackendConfig(transcriptionMode, model);
  };

  const toggleRecording = async () => {
    if (isRecordingBusy) return;

    if (!isRecordingActive) {
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
        // Fetch known speakers for diarization display names
        try {
          const speakers = await invoke<Array<{ speaker_id: string; display_name: string; utterance_count: number }>>("get_speakers");
          const cache: Record<string, string> = {};
          const names: string[] = [];
          for (const s of speakers) {
            cache[s.speaker_id] = s.display_name;
            names.push(s.display_name);
          }
          speakerNameCacheRef.current = { ...speakerNameCacheRef.current, ...cache };
          if (names.length > 0) {
            setParticipants(prev => {
              const merged = new Set([...prev, ...names]);
              return Array.from(merged);
            });
          }
        } catch { /* diarization may not be enabled */ }
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
        if (payload.kind === "mic_device_unavailable") {
          setIsMuted(true);
          setIsMicBusy(false);
          setVoiceActivity((prev) => ({
            ...prev,
            user: {
              isActive: false,
              sessionId: prev.user.sessionId,
            },
          }));
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

    const unlistenSpeakerUpdated = listen<{ speakerId: string; displayName: string }>(
      "speaker-updated",
      (event) => {
        const { speakerId, displayName } = event.payload;
        // Update cache
        speakerNameCacheRef.current = { ...speakerNameCacheRef.current, [speakerId]: displayName };
        // Update all sessions with this speakerId
        setTranscriptions(prev =>
          prev.map(s =>
            s.speakerId === speakerId ? { ...s, speaker: displayName } : s
          )
        );
        // Update participants list
        setParticipants(prev => prev.includes(displayName) ? prev : [...prev, displayName]);
      },
    );

    return () => {
      unlistenTranscription.then((fn) => fn());
      unlistenVoiceActivity.then((fn) => fn());
      unlistenBackendError.then((fn) => fn());
      unlistenModelInstallProgress.then((fn) => fn());
      unlistenSpeakerUpdated.then((fn) => fn());
    };
  }, [
    finalizeAllInProgressMessages,
    loadStreamingConfig,
    loadWhisperParams,
    loadTranscriptionBackendConfig,
    loadSummarizationConfig,
    upsertTranscriptionSegment,
  ]);

  useEffect(() => {
    if (didRunInitialBackendLoadRef.current) {
      return;
    }
    didRunInitialBackendLoadRef.current = true;

    loadSettingsFromLocalStorage();
    void refreshAllModels();
    void loadLanguages();
    void loadAudioDevices();
    void checkMicPermission();
    void loadStreamingConfig();
    void loadWhisperParams();
    void loadRecordingSaveConfig();
    void loadTranscriptionBackendConfig();
    void loadSummarizationConfig();
    void loadApiKeyStatus();
  }, []);

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

    if (isAutoScrollPaused || speakerChipOpenCountRef.current > 0) {
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

  const [summarySaved, setSummarySaved] = useState(false);

  const saveSummaryToFile = useCallback(
    async (summary: string): Promise<boolean> => {
      const savePath = summaryConfig.summarySavePath?.trim();
      if (!savePath) {
        setError("No summary save path configured. Set one in Summarization Settings.");
        return false;
      }
      try {
        const now = new Date();
        const timestamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
        const normalizedPath = savePath.replace(/[/\\]+$/, "");
        const filePath = `${normalizedPath}/summary-${timestamp}.md`;
        await invoke<string>("save_summary_to_file", {
          path: filePath,
          content: summary,
        });
        setSummarySaved(true);
        setTimeout(() => setSummarySaved(false), 2000);
        return true;
      } catch (err) {
        console.error("Failed to save summary:", err);
        setError(
          `Failed to save summary: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      }
    },
    [summaryConfig.summarySavePath, setError],
  );

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

      const trimmedSummary = summary.trim();
      setSummaryPanelText(trimmedSummary);
      setIsSummaryExpanded(true);
      if (usedSource !== "Local") {
        setError("");
      }

      if (summaryConfig.autoSaveSummary && summaryConfig.summarySavePath?.trim()) {
        // Auto-save in background — don't let save failures affect the summary result
        saveSummaryToFile(trimmedSummary).catch(() => {});
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

        {summaryPanelText && summaryConfig.summarySavePath?.trim() && (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => saveSummaryToFile(summaryPanelText)}
            title="Save summary to file"
          >
            {summarySaved ? (
              <Check className="w-4 h-4" />
            ) : (
              <Save className="w-4 h-4" />
            )}
            {summarySaved ? "Saved" : "Save"}
          </button>
        )}

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
              <ModelSetupPanel
                remoteModels={remoteModels}
                modelOperations={modelOperations}
                modelInstallProgress={modelInstallProgress}
                isLoadingRemoteModels={isLoadingRemoteModels}
                onSelectModel={setSelectedModel}
                onInstallModel={handleInstallModel}
              />
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
              <TranscriptList
                groupedTranscriptions={groupedTranscriptions}
                participants={participants}
                copiedSessionKey={copiedSessionKey}
                playingSessionKey={playingSessionKey}
                showUserActivityIndicator={showUserActivityIndicator}
                showSystemActivityIndicator={showSystemActivityIndicator}
                messagesEndRef={messagesEndRef}
                onChangeSpeaker={handleChangeSpeaker}
                onAddParticipant={handleAddParticipant}
                onSpeakerChipOpenChange={handleSpeakerChipOpenChange}
                onCopySessionText={handleCopySessionText}
                onPlaySessionAudio={playSessionAudio}
              />
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

      {showSettings && (
        <SettingsModal
          theme={theme}
          setTheme={setTheme}
          selectedModel={selectedModel}
          setSelectedModel={setSelectedModel}
          availableModels={availableModels}
          selectedModelDisplayName={selectedModelDisplayName}
          remoteModels={remoteModels}
          modelOperations={modelOperations}
          modelInstallProgress={modelInstallProgress}
          isLoadingRemoteModels={isLoadingRemoteModels}
          refreshAllModels={refreshAllModels}
          handleInstallModel={handleInstallModel}
          handleDeleteModel={handleDeleteModel}
          selectedAudioDevice={selectedAudioDevice}
          audioDevices={audioDevices}
          handleAudioDeviceChange={handleAudioDeviceChange}
          transcriptionMode={transcriptionMode}
          handleTranscriptionModeChange={handleTranscriptionModeChange}
          transcriptionModel={transcriptionModel}
          setTranscriptionModel={setTranscriptionModel}
          saveTranscriptionModelConfig={saveTranscriptionModelConfig}
          apiKeyStatus={apiKeyStatus}
          saveApiKey={saveApiKey}
          deleteApiKey={deleteApiKey}
          testApiKey={testApiKey}
          summaryConfig={summaryConfig}
          setSummaryConfig={setSummaryConfig}
          isSavingSummaryConfig={isSavingSummaryConfig}
          saveSummarizationConfig={saveSummarizationConfig}
          recordingSaveEnabled={recordingSaveEnabled}
          recordingSavePath={recordingSavePath}
          setRecordingSavePath={setRecordingSavePath}
          saveRecordingSaveConfig={saveRecordingSaveConfig}
          whisperParams={whisperParams}
          setWhisperParams={setWhisperParams}
          isSavingWhisperParams={isSavingWhisperParams}
          saveWhisperParams={saveWhisperParams}
          streamingConfig={streamingConfig}
          setStreamingConfig={setStreamingConfig}
          isSavingStreamingConfig={isSavingStreamingConfig}
          saveStreamingConfig={saveStreamingConfig}
          hasMicPermission={hasMicPermission}
          isInitialized={isInitialized}
          onClose={() => setShowSettings(false)}
        />
      )}
    </div>
  );
}

export default App;
