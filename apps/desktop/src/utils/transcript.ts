import type {
  BackendMode,
  ModelInstallProgressEvent,
  TranscriptionSegment,
} from "../types";

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

export const LANGUAGE_LABELS: Record<string, string> = {
  auto: "Auto Detect",
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

export const sourceLabel = (source: string) => {
  if (source === "mic" || source === "user") return "You";
  if (source === "system") return "System";
  return source;
};

export const normalizeMessageText = (value: string) =>
  value
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001F]+/g, " ")
    .trim();

export const summarizeLocally = (
  messages: (TranscriptionSegment & { speaker: string })[],
) => {
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

export const normalizeLanguageOptions = (
  languages: [string, string][],
): [string, string][] =>
  languages.map(([code, name]) => [code, LANGUAGE_LABELS[code] ?? name]);

export const normalizeBackendMode = (mode: string): BackendMode =>
  mode === "local" || mode === "legacy_ws" ? "local" : "openai";

export const summaryErrorCode = (message: string): string | null => {
  const match = message.match(/^(SUMMARY_[A-Z_]+):/);
  return match ? match[1] : null;
};

export const isSilentSummaryFallback = (message: string): boolean => {
  const code = summaryErrorCode(message);
  return (
    code === "SUMMARY_UNCONFIGURED" ||
    code === "SUMMARY_TRANSIENT" ||
    code === "SUMMARY_PROVIDER"
  );
};

export const formatModelSize = (bytes: number) =>
  `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

export const formatInstallProgress = (
  progress?: ModelInstallProgressEvent,
) => {
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

export const formatSegmentTimestamp = (timestamp: number) => {
  const millis = timestamp < 1_000_000_000_000 ? timestamp * 1000 : timestamp;
  return new Date(millis).toLocaleString("en-US", {
    hour12: false,
  });
};
