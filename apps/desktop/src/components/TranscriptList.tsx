import type { RefObject } from "react";
import { Check, Copy, Play, Square } from "lucide-react";
import { TypingDots } from "./TypingDots";
import { SpeakerChip } from "./SpeakerChip";
import type { SessionTranscription } from "../types";

interface TranscriptListProps {
  groupedTranscriptions: SessionTranscription[][];
  participants: string[];
  copiedSessionKey: string | null;
  playingSessionKey: string | null;
  showUserActivityIndicator: boolean;
  showSystemActivityIndicator: boolean;
  messagesEndRef: RefObject<HTMLDivElement>;
  onChangeSpeaker: (sessionKey: string, name: string) => void;
  onAddParticipant: (name: string) => void;
  onSpeakerChipOpenChange: (isOpen: boolean) => void;
  onCopySessionText: (sessionKey: string, sessionText: string) => void;
  onPlaySessionAudio: (audioData: number[], sessionKey: string) => void;
}

export function TranscriptList({
  groupedTranscriptions,
  participants,
  copiedSessionKey,
  playingSessionKey,
  showUserActivityIndicator,
  showSystemActivityIndicator,
  messagesEndRef,
  onChangeSpeaker,
  onAddParticipant,
  onSpeakerChipOpenChange,
  onCopySessionText,
  onPlaySessionAudio,
}: TranscriptListProps) {
  return (
    <div className="flex flex-col">
      {groupedTranscriptions.map((group) => {
        const rep = group[0];
        const alignment = rep.source === "user" ? "chat-end" : "chat-start";
        const bubbleColor =
          rep.source === "user" ? "chat-bubble-primary" : "chat-bubble-secondary";
        const groupText = group
          .flatMap((s) => s.messages)
          .map((m) => m.text.trim())
          .filter((t) => t.length > 0)
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        const groupAudio = group.flatMap((s) =>
          s.messages.flatMap((m) => s.audioChunks[m.messageId] || []),
        );
        const hasInProgress = group.some((s) =>
          s.messages.some((m) => !m.isFinal),
        );

        return (
          <div key={rep.sessionKey} className={`chat ${alignment}`}>
            <div className="chat-header text-xs opacity-70">
              <SpeakerChip
                speaker={rep.speaker}
                participants={participants}
                onChangeSpeaker={(name) => onChangeSpeaker(rep.sessionKey, name)}
                onAddParticipant={onAddParticipant}
                onOpenChange={onSpeakerChipOpenChange}
              />
            </div>
            <div
              className={`chat-bubble text-sm ${bubbleColor} ${
                hasInProgress ? "opacity-70" : ""
              }`}
            >
              <span className="flex-1 text-left">
                {groupText}
                {hasInProgress && <TypingDots inline className="ml-1" />}
              </span>
            </div>
            <div className="chat-footer opacity-50 flex justify-between items-center">
              <button
                onClick={() => onCopySessionText(rep.sessionKey, groupText)}
                className="btn btn-ghost btn-xs btn-circle"
                title={copiedSessionKey === rep.sessionKey ? "Copied" : "Copy"}
              >
                {copiedSessionKey === rep.sessionKey ? (
                  <Check className="w-3 h-3" />
                ) : (
                  <Copy className="w-3 h-3" />
                )}
              </button>
              {groupAudio.length > 0 && (
                <button
                  onClick={() => onPlaySessionAudio(groupAudio, rep.sessionKey)}
                  className="btn btn-ghost btn-xs btn-circle"
                >
                  {playingSessionKey === rep.sessionKey ? (
                    <Square className="w-3 h-3" />
                  ) : (
                    <Play className="w-3 h-3" />
                  )}
                </button>
              )}

              <time className="text-[10px] opacity-60">
                {new Date(rep.messages[0].timestamp).toLocaleTimeString([], {
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
  );
}
