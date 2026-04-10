import { describe, it, expect } from "vitest";
import {
  groupTranscriptions,
  SessionTranscription,
} from "./groupTranscriptions";

/** Helper to build a minimal SessionTranscription for testing. */
function makeSession(
  overrides: Partial<SessionTranscription> & { source: string; speaker: string },
): SessionTranscription {
  return {
    sessionKey: `key-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 1,
    messages: [
      {
        text: "hello",
        timestamp: Date.now(),
        sessionId: 1,
        messageId: 1,
        isFinal: true,
        source: overrides.source,
      },
    ],
    audioChunks: {},
    ...overrides,
  };
}

describe("groupTranscriptions", () => {
  it("returns empty array for empty input", () => {
    expect(groupTranscriptions([])).toEqual([]);
  });

  it("returns one group of one for a single session", () => {
    const s = makeSession({ source: "system", speaker: "Alice" });
    const result = groupTranscriptions([s]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([s]);
  });

  it("merges two consecutive same-speaker sessions", () => {
    const a = makeSession({
      source: "system",
      speaker: "Alice",
      speakerId: "spk-1",
    });
    const b = makeSession({
      source: "system",
      speaker: "Alice",
      speakerId: "spk-1",
    });
    const result = groupTranscriptions([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([a, b]);
  });

  it("separates two different-speaker sessions", () => {
    const a = makeSession({
      source: "system",
      speaker: "Alice",
      speakerId: "spk-1",
    });
    const b = makeSession({
      source: "system",
      speaker: "Bob",
      speakerId: "spk-2",
    });
    const result = groupTranscriptions([a, b]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([a]);
    expect(result[1]).toEqual([b]);
  });

  it("never groups sessions with different sources even if same speaker", () => {
    const a = makeSession({ source: "user", speaker: "Me" });
    const b = makeSession({ source: "system", speaker: "Me" });
    const result = groupTranscriptions([a, b]);
    expect(result).toHaveLength(2);
  });

  it("groups by speakerId when both sessions have it", () => {
    const a = makeSession({
      source: "system",
      speaker: "Speaker 1",
      speakerId: "spk-A",
    });
    const b = makeSession({
      source: "system",
      speaker: "Speaker 1 (renamed)",
      speakerId: "spk-A",
    });
    const result = groupTranscriptions([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([a, b]);
  });

  it("groups by display name when speakerId is absent", () => {
    const a = makeSession({ source: "system", speaker: "Bob" });
    const b = makeSession({ source: "system", speaker: "Bob" });
    const result = groupTranscriptions([a, b]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([a, b]);
  });

  it("does not merge across speaker changes (A-B-A produces three groups)", () => {
    const a1 = makeSession({
      source: "system",
      speaker: "Alice",
      speakerId: "spk-1",
    });
    const b = makeSession({
      source: "system",
      speaker: "Bob",
      speakerId: "spk-2",
    });
    const a2 = makeSession({
      source: "system",
      speaker: "Alice",
      speakerId: "spk-1",
    });
    const result = groupTranscriptions([a1, b, a2]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual([a1]);
    expect(result[1]).toEqual([b]);
    expect(result[2]).toEqual([a2]);
  });
});
