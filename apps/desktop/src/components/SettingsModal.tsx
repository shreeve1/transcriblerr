import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Eye, EyeOff, KeyRound, Moon, Sun } from "lucide-react";
import type {
  ApiKeyStatus,
  AudioDevice,
  BackendMode,
  ModelInstallProgressEvent,
  ModelInfo,
  RemoteModelStatus,
  StreamingConfig,
  SummarizationConfig,
  WhisperParamsConfig,
} from "../types";
import { formatInstallProgress, formatModelSize } from "../utils/transcript";

interface SettingsModalProps {
  theme: string;
  setTheme: Dispatch<SetStateAction<string>>;
  selectedModel: string;
  setSelectedModel: Dispatch<SetStateAction<string>>;
  availableModels: ModelInfo[];
  selectedModelDisplayName: string;
  remoteModels: RemoteModelStatus[];
  modelOperations: Record<string, boolean>;
  modelInstallProgress: Record<string, ModelInstallProgressEvent>;
  isLoadingRemoteModels: boolean;
  refreshAllModels: () => void;
  handleInstallModel: (modelId: string) => void;
  handleDeleteModel: (model: RemoteModelStatus) => void;
  selectedAudioDevice: string;
  audioDevices: AudioDevice[];
  handleAudioDeviceChange: (deviceName: string) => void;
  transcriptionMode: BackendMode;
  handleTranscriptionModeChange: (mode: BackendMode) => void;
  transcriptionModel: string;
  setTranscriptionModel: Dispatch<SetStateAction<string>>;
  saveTranscriptionModelConfig: (model: string) => Promise<void>;
  apiKeyStatus: ApiKeyStatus;
  saveApiKey: (apiKey: string) => Promise<string>;
  deleteApiKey: () => Promise<string>;
  testApiKey: (apiKey?: string) => Promise<string>;
  summaryConfig: SummarizationConfig;
  setSummaryConfig: Dispatch<SetStateAction<SummarizationConfig>>;
  isSavingSummaryConfig: boolean;
  saveSummarizationConfig: () => void;
  recordingSaveEnabled: boolean;
  recordingSavePath: string;
  setRecordingSavePath: Dispatch<SetStateAction<string>>;
  saveRecordingSaveConfig: (enabled: boolean, path: string) => void;
  whisperParams: WhisperParamsConfig;
  setWhisperParams: Dispatch<SetStateAction<WhisperParamsConfig>>;
  isSavingWhisperParams: boolean;
  saveWhisperParams: (params: WhisperParamsConfig) => void;
  streamingConfig: StreamingConfig;
  setStreamingConfig: Dispatch<SetStateAction<StreamingConfig>>;
  isSavingStreamingConfig: boolean;
  saveStreamingConfig: (config: StreamingConfig) => void;
  hasMicPermission: boolean | null;
  isInitialized: boolean;
  onClose: () => void;
}

export function SettingsModal({
  theme,
  setTheme,
  selectedModel,
  setSelectedModel,
  availableModels,
  selectedModelDisplayName,
  remoteModels,
  modelOperations,
  modelInstallProgress,
  isLoadingRemoteModels,
  refreshAllModels,
  handleInstallModel,
  handleDeleteModel,
  selectedAudioDevice,
  audioDevices,
  handleAudioDeviceChange,
  transcriptionMode,
  handleTranscriptionModeChange,
  transcriptionModel,
  setTranscriptionModel,
  saveTranscriptionModelConfig,
  apiKeyStatus,
  saveApiKey,
  deleteApiKey,
  testApiKey,
  summaryConfig,
  setSummaryConfig,
  isSavingSummaryConfig,
  saveSummarizationConfig,
  recordingSaveEnabled,
  recordingSavePath,
  setRecordingSavePath,
  saveRecordingSaveConfig,
  whisperParams,
  setWhisperParams,
  isSavingWhisperParams,
  saveWhisperParams,
  streamingConfig,
  setStreamingConfig,
  isSavingStreamingConfig,
  saveStreamingConfig,
  hasMicPermission,
  isInitialized,
  onClose,
}: SettingsModalProps) {
  const apiKeyInputRef = useRef<HTMLInputElement | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKeyMessage, setApiKeyMessage] = useState("");
  const [isSavingApiKey, setIsSavingApiKey] = useState(false);
  const [isDeletingApiKey, setIsDeletingApiKey] = useState(false);
  const [isTestingApiKey, setIsTestingApiKey] = useState(false);
  const [isSavingTranscriptionModel, setIsSavingTranscriptionModel] =
    useState(false);
  const [transcriptionModelMessage, setTranscriptionModelMessage] =
    useState("");

  const apiKeyStatusText = apiKeyStatus.hasStoredKey
    ? "Saved in Keychain"
    : apiKeyStatus.hasEnvKey
      ? "Using environment key"
      : "No API key configured";

  const currentApiKeyInput = () => apiKeyInputRef.current?.value.trim() ?? "";

  const clearApiKeyInput = () => {
    if (apiKeyInputRef.current) {
      apiKeyInputRef.current.value = "";
    }
  };

  const handleSaveApiKey = async () => {
    const apiKey = currentApiKeyInput();
    if (!apiKey) {
      setApiKeyMessage("Enter an API key before saving.");
      return;
    }

    setIsSavingApiKey(true);
    setApiKeyMessage("");
    try {
      const message = await saveApiKey(apiKey);
      clearApiKeyInput();
      setApiKeyMessage(message);
    } catch (err) {
      setApiKeyMessage(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsSavingApiKey(false);
    }
  };

  const handleDeleteApiKey = async () => {
    setIsDeletingApiKey(true);
    setApiKeyMessage("");
    try {
      const message = await deleteApiKey();
      clearApiKeyInput();
      setApiKeyMessage(message);
    } catch (err) {
      setApiKeyMessage(
        `Delete failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsDeletingApiKey(false);
    }
  };

  const handleTestApiKey = async () => {
    const apiKey = currentApiKeyInput();
    setIsTestingApiKey(true);
    setApiKeyMessage("");
    try {
      const message = await testApiKey(apiKey || undefined);
      setApiKeyMessage(message);
    } catch (err) {
      setApiKeyMessage(
        `Test failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsTestingApiKey(false);
    }
  };

  const handleSaveTranscriptionModel = async () => {
    const model = transcriptionModel.trim();
    if (!model) {
      setTranscriptionModelMessage("Enter a transcription model before saving.");
      return;
    }

    setIsSavingTranscriptionModel(true);
    setTranscriptionModelMessage("");
    try {
      await saveTranscriptionModelConfig(model);
      setTranscriptionModelMessage("Transcription model saved");
    } catch (err) {
      setTranscriptionModelMessage(
        `Save failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setIsSavingTranscriptionModel(false);
    }
  };

  return (
    <dialog className="modal modal-open">
      <div className="modal-box">
        <h3 className="font-bold text-lg mb-4 flex items-center justify-between">
          <span>Settings</span>
          <label className="swap swap-rotate btn btn-ghost btn-circle btn-sm">
            <input
              type="checkbox"
              checked={theme === "dark"}
              onChange={(e) => setTheme(e.target.checked ? "dark" : "light")}
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
                    <p className="text-sm opacity-60">No available models found</p>
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
                                      model.path && setSelectedModel(model.path)
                                    }
                                  >
                                    {selectedModel === model.path ? "In use" : "Use"}
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
                    onChange={(e) => handleAudioDeviceChange(e.target.value)}
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
                      Local mode needs an installed Whisper model. OpenAI mode uses the API key configured below.
                    </span>
                  </label>
                </div>

                <div className="form-control">
                  <label className="label">
                    <span className="label-text">OpenAI Transcription Model</span>
                  </label>
                  <div className="join w-full">
                    <input
                      type="text"
                      className="input input-bordered join-item w-full"
                      value={transcriptionModel}
                      onChange={(e) => setTranscriptionModel(e.target.value)}
                      placeholder="gpt-4o-transcribe"
                    />
                    <button
                      type="button"
                      className="btn btn-primary join-item"
                      onClick={handleSaveTranscriptionModel}
                      disabled={isSavingTranscriptionModel}
                    >
                      {isSavingTranscriptionModel ? "Saving..." : "Save"}
                    </button>
                  </div>
                  <label className="label">
                    <span className="label-text-alt opacity-70">
                      Used only when Transcription Backend is OpenAI API.
                    </span>
                  </label>
                  {transcriptionModelMessage && (
                    <p className="text-xs opacity-80">{transcriptionModelMessage}</p>
                  )}
                </div>
              </div>
            </div>
          </details>

          <details className="collapse collapse-arrow bg-base-200/50 border border-base-300">
            <summary className="collapse-title text-sm font-semibold">
              OpenAI API
            </summary>
            <div className="collapse-content space-y-4">
              <div className="form-control">
                <label className="label">
                  <span className="label-text">API Key</span>
                  <span className="label-text-alt opacity-70">
                    {apiKeyStatusText}
                  </span>
                </label>
                <div className="join w-full">
                  <input
                    ref={apiKeyInputRef}
                    type={showApiKey ? "text" : "password"}
                    className="input input-bordered join-item w-full"
                    placeholder={
                      apiKeyStatus.hasStoredKey
                        ? "Enter a new key to replace the saved key"
                        : "Paste API key"
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="btn join-item"
                    onClick={() => setShowApiKey((value) => !value)}
                    title={showApiKey ? "Hide API key" : "Show API key"}
                    aria-label={showApiKey ? "Hide API key" : "Show API key"}
                  >
                    {showApiKey ? (
                      <EyeOff className="w-4 h-4" />
                    ) : (
                      <Eye className="w-4 h-4" />
                    )}
                  </button>
                </div>
                <label className="label">
                  <span className="label-text-alt opacity-70">
                    Saved keys are stored in macOS Keychain. Environment keys remain available as an advanced fallback.
                  </span>
                </label>
              </div>

              <div className="flex flex-wrap gap-2 justify-end">
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={handleTestApiKey}
                  disabled={isTestingApiKey}
                >
                  <KeyRound className="w-4 h-4" />
                  {isTestingApiKey ? "Testing..." : "Test"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={handleSaveApiKey}
                  disabled={isSavingApiKey}
                >
                  {isSavingApiKey ? "Saving..." : "Save"}
                </button>
                <button
                  type="button"
                  className="btn btn-sm btn-outline btn-error"
                  onClick={handleDeleteApiKey}
                  disabled={isDeletingApiKey || !apiKeyStatus.hasStoredKey}
                >
                  {isDeletingApiKey ? "Deleting..." : "Delete"}
                </button>
              </div>

              {apiKeyMessage && (
                <p className="text-xs opacity-80">{apiKeyMessage}</p>
              )}
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
                    {summaryConfig.hasApiKey ? "Configured" : "Missing"}
                  </span>
                </label>
                <div className="text-xs opacity-70 leading-relaxed">
                  Summarization uses the API key saved above. Environment keys are used only as an advanced fallback.
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
                  <span className="label-text-alt opacity-70">
                    Leave empty to use the default prompt.
                  </span>
                </label>
              </div>

              <div className="form-control">
                <label className="label">
                  <span className="label-text">Summary Save Location</span>
                </label>
                <input
                  type="text"
                  className="input input-bordered w-full"
                  placeholder="/path/to/summaries"
                  value={summaryConfig.summarySavePath || ""}
                  onChange={(e) =>
                    setSummaryConfig((prev) => ({
                      ...prev,
                      summarySavePath: e.target.value || undefined,
                    }))
                  }
                />
                <label className="label">
                  <span className="label-text-alt opacity-70">
                    Directory where summary files will be saved as timestamped markdown.
                  </span>
                </label>
              </div>

              <div className="form-control">
                <label className="label cursor-pointer">
                  <span className="label-text">Auto-save summaries to file</span>
                  <input
                    type="checkbox"
                    className="toggle toggle-primary"
                    checked={summaryConfig.autoSaveSummary}
                    onChange={(e) =>
                      setSummaryConfig((prev) => ({
                        ...prev,
                        autoSaveSummary: e.target.checked,
                      }))
                    }
                  />
                </label>
                <label className="label">
                  <span className="label-text-alt opacity-70">
                    When enabled, summaries are automatically saved when the Summarize button is pressed.
                  </span>
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
                      saveRecordingSaveConfig(e.target.checked, recordingSavePath)
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
                      saveRecordingSaveConfig(recordingSaveEnabled, recordingSavePath)
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
                      audioCtx: parseInt(e.target.value, 10) || prev.audioCtx,
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
                      audioCtx: parseInt(e.target.value, 10) || prev.audioCtx,
                    }))
                  }
                  className="input input-bordered input-sm w-32"
                />
              </div>

              <div className="space-y-2">
                <label className="label">
                  <span className="label-text">
                    Temperature (temperature: {whisperParams.temperature.toFixed(2)})
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
                      temperature: parseFloat(e.target.value) ?? prev.temperature,
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
                      temperature: parseFloat(e.target.value) ?? prev.temperature,
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
                <span className="label-text font-semibold">Streaming Settings</span>
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
                      partialIntervalSeconds: parseFloat(e.target.value) || 4,
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
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button onClick={onClose}>close</button>
      </form>
    </dialog>
  );
}
