/**
 * Groups consecutive SessionTranscription entries that share the same
 * source AND speaker identity into display groups. This is a pure
 * rendering transform — the underlying data is unchanged.
 *
 * Speaker identity is matched by `speakerId` when present on both
 * sessions, falling back to the `speaker` display name otherwise.
 */

/** Minimal interface compatible with App.tsx SessionTranscription */
export interface SessionTranscription {
  sessionKey: string;
  sessionId: number;
  source: string;
  speaker: string;
  speakerId?: string;
  messages: Array<{
    text: string;
    timestamp: number;
    audioData?: number[];
    sessionId: number;
    messageId: number;
    isFinal: boolean;
    source: string;
    speakerId?: string;
  }>;
  audioChunks: Record<number, number[]>;
}

export function groupTranscriptions(
  sessions: SessionTranscription[],
): SessionTranscription[][] {
  if (sessions.length === 0) return [];

  const groups: SessionTranscription[][] = [];
  let currentGroup: SessionTranscription[] = [sessions[0]];

  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1];
    const curr = sessions[i];

    const sameSource = prev.source === curr.source;
    const sameSpeaker =
      prev.speakerId && curr.speakerId
        ? prev.speakerId === curr.speakerId
        : prev.speaker === curr.speaker;

    if (sameSource && sameSpeaker) {
      currentGroup.push(curr);
    } else {
      groups.push(currentGroup);
      currentGroup = [curr];
    }
  }

  groups.push(currentGroup);
  return groups;
}
