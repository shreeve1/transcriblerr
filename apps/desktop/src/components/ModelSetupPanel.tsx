import type {
  ModelInstallProgressEvent,
  RemoteModelStatus,
} from "../types";
import { formatInstallProgress, formatModelSize } from "../utils/transcript";

interface ModelSetupPanelProps {
  remoteModels: RemoteModelStatus[];
  modelOperations: Record<string, boolean>;
  modelInstallProgress: Record<string, ModelInstallProgressEvent>;
  isLoadingRemoteModels: boolean;
  onSelectModel: (path: string) => void;
  onInstallModel: (modelId: string) => void;
}

export function ModelSetupPanel({
  remoteModels,
  modelOperations,
  modelInstallProgress,
  isLoadingRemoteModels,
  onSelectModel,
  onInstallModel,
}: ModelSetupPanelProps) {
  return (
    <div className="max-w-3xl mx-auto border border-base-300 rounded-xl p-4 bg-base-200/50 space-y-4">
      <div>
        <p className="text-sm font-semibold">Install a Whisper model first</p>
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
                  <p className="text-xs opacity-70">{model.description}</p>
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
                      ? onSelectModel(model.path)
                      : onInstallModel(model.id)
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
  );
}
