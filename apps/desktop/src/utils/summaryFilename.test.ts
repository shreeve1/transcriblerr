import { describe, expect, it } from "vitest";
import {
  buildSummaryFilename,
  extractMeetingTitle,
  sanitizeFilename,
} from "./transcript";

describe("extractMeetingTitle", () => {
  it("extracts title from standard AI format", () => {
    const summary = `# 1. Meeting Title\n\nWeekly Standup Planning\n\n## 2. Summary\nSome text`;
    expect(extractMeetingTitle(summary)).toBe("Weekly Standup Planning");
  });

  it("extracts title from markdown header format", () => {
    const summary = `# Meeting Title\n\nBudget Review Q2\n\n## Summary\nSome text`;
    expect(extractMeetingTitle(summary)).toBe("Budget Review Q2");
  });

  it("extracts title from numbered format", () => {
    const summary = `1. Meeting Title\nSprint Retrospective\n\n2. Summary\nSome text`;
    expect(extractMeetingTitle(summary)).toBe("Sprint Retrospective");
  });

  it("extracts inline title on same line as header", () => {
    const summary = `1. Meeting Title: Weekly Standup\n\n2. Summary\nSome text`;
    expect(extractMeetingTitle(summary)).toBe("Weekly Standup");
  });

  it("extracts title from bold format header", () => {
    const summary = `**Meeting Title**\nProduct Review\n\n**Summary**\nSome text`;
    expect(extractMeetingTitle(summary)).toBe("Product Review");
  });

  it("returns null when section is missing", () => {
    expect(extractMeetingTitle("Just some text")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractMeetingTitle("")).toBeNull();
  });

  it("returns null for local summary format", () => {
    const summary = `Conversation summary (5 final messages)\nThemes: project, deadline\n\nHighlights:\n- Alice: Let's ship it`;
    expect(extractMeetingTitle(summary)).toBeNull();
  });

  it("preserves special characters in title", () => {
    const summary = `1. Meeting Title\nQ&A Session: Product & Engineering Sync\n\n2. Summary\nText`;
    expect(extractMeetingTitle(summary)).toBe(
      "Q&A Session: Product & Engineering Sync",
    );
  });

  it("returns null when next section header follows without title text", () => {
    const summary = `1. Meeting Title\n\n2. Meeting Summary\nSome summary text`;
    expect(extractMeetingTitle(summary)).toBeNull();
  });

  it("strips markdown formatting from title", () => {
    const summary = `# Meeting Title\n\n**Weekly Standup**\n\n## Summary\nText`;
    expect(extractMeetingTitle(summary)).toBe("Weekly Standup");
  });

  it("extracts title from mixed format with bold and colon", () => {
    const summary = `# **1. Meeting Title:**\nQ&A Session\n\n## Summary\nText`;
    expect(extractMeetingTitle(summary)).toBe("Q&A Session");
  });

  it("returns null when bold section header has no body text", () => {
    const summary = `**Meeting Title**\n\n**Summary**\nSome summary text`;
    expect(extractMeetingTitle(summary)).toBeNull();
  });
});

describe("sanitizeFilename", () => {
  it("passes safe characters through unchanged", () => {
    expect(sanitizeFilename("Weekly Standup")).toBe("Weekly-Standup");
  });

  it("replaces unsafe characters with dashes", () => {
    expect(sanitizeFilename('Test: File "Name" <OK>')).toBe("Test-File-Name-OK");
  });

  it("strips path separators and NUL without replacing", () => {
    expect(sanitizeFilename("foo/bar\\baz\x00qux")).toBe("foobarbazqux");
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("hello\x01\x02\x1Fworld")).toBe("helloworld");
  });

  it("collapses consecutive dashes", () => {
    expect(sanitizeFilename("A --- B ::: C")).toBe("A-B-C");
  });

  it("truncates long ASCII title by byte budget", () => {
    const longTitle = "A".repeat(200);
    const result = sanitizeFilename(longTitle);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(180);
    expect(result.length).toBe(180);
  });

  it("truncates CJK title by byte budget not char count", () => {
    const cjkTitle = "日".repeat(100);
    const result = sanitizeFilename(cjkTitle);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(180);
    expect(result.length).toBe(60);
  });

  it("truncates emoji title by byte budget", () => {
    const emojiTitle = "😀".repeat(50);
    const result = sanitizeFilename(emojiTitle);
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(180);
    expect(Array.from(result).length).toBe(45);
  });

  it("does not corrupt emoji on truncation", () => {
    const result = sanitizeFilename("Team 😀".repeat(30));
    const encoded = new TextEncoder().encode(result);
    expect(encoded.byteLength).toBeLessThanOrEqual(180);
    expect(result).not.toContain("\uFFFD");
    const decoded = new TextDecoder().decode(encoded);
    expect(decoded).toBe(result);
  });

  it("returns empty string for all-unsafe input", () => {
    expect(sanitizeFilename(':::*??"""<<<>>>|||')).toBe("");
  });

  it("strips leading and trailing dashes", () => {
    expect(sanitizeFilename("---Test Name---")).toBe("Test-Name");
  });

  it("strips leading and trailing dots", () => {
    expect(sanitizeFilename("...Hidden File...")).toBe("Hidden-File");
  });
});

describe("buildSummaryFilename", () => {
  const ts = "2026-04-24_10-59-58";

  it("produces titled filename from summary with meeting title", () => {
    const summary = `1. Meeting Title\nWeekly Standup\n\n2. Summary\nText`;
    expect(buildSummaryFilename(summary, ts)).toBe(
      "Weekly-Standup - 2026-04-24_10-59-58.md",
    );
  });

  it("produces exact fallback for no-title summary", () => {
    expect(buildSummaryFilename("Just some text", ts)).toBe(
      "summary-2026-04-24_10-59-58.md",
    );
  });

  it("produces fallback when sanitization yields empty", () => {
    const summary = `1. Meeting Title\n:::*???"<<>>|||\n\n2. Summary\nText`;
    expect(buildSummaryFilename(summary, ts)).toBe(
      "summary-2026-04-24_10-59-58.md",
    );
  });

  it("produces fallback for local summary format", () => {
    const summary = `Conversation summary (5 final messages)\nThemes: project`;
    expect(buildSummaryFilename(summary, ts)).toBe(
      "summary-2026-04-24_10-59-58.md",
    );
  });
});
