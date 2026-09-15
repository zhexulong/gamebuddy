import type { CreateWorldInfoRequest, PublicWorldInfoEntry } from "./world-info-management.js";

const MAX_TITLE = 128;
const MAX_SUMMARY = 4_000;

/**
 * Derives retrieval keys from a title by tokenizing on common delimiters.
 * Ensures entries without an explicit key list can still be matched in conversations.
 */
export function keysFromTitle(title: string): readonly string[] {
  const trimmed = title.trim();
  if (!trimmed) return Object.freeze([]);
  const segments = trimmed
    .split(/[\s·•,，、/|｜\-—_()（）[\]【】]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 1);
  const result: string[] = [trimmed];
  for (const seg of segments) {
    if (seg !== trimmed && !result.some((existing) => existing.toLowerCase() === seg.toLowerCase())) {
      result.push(seg);
    }
  }
  return Object.freeze(result.slice(0, 8));
}

/**
 * Sanitizes lorebook text by stripping script/style blocks, unwrapping HTML formatting tags,
 * normalizing line endings to Unix newlines (\n), and removing non-printable control characters.
 */
export function cleanLorebookText(value: unknown, maxLen = MAX_SUMMARY): string {
  if (typeof value !== "string") return "";
  let text = value.normalize("NFC");

  // Remove script and style elements
  text = text.replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, "");

  // Remove HTML comments
  text = text.replace(/<!--[\s\S]*?-->/g, "");

  // Convert block break tags to newlines
  text = text.replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|hr)\s*\/?>/gi, "\n");

  // Strip remaining HTML tags
  text = text.replace(/<[^>]+>/g, "");

  // Normalize Windows/Mac line endings to standard Unix newlines
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove non-printable control characters while preserving \t (9) and \n (10)
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

  // Clean redundant whitespace per line
  text = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length > maxLen) {
    text = text.slice(0, maxLen).trim();
  }
  return text;
}

export type RawLoreEntry = Readonly<{
  comment?: string;
  name?: string;
  publicTitle?: string;
  content?: string;
  summary?: string;
  key?: readonly string[];
  keys?: readonly string[];
  disable?: boolean;
  enabled?: boolean;
  scope?: "companion" | "setting";
  [key: string]: unknown;
}>;

export type RawLorebookContainer = Readonly<{
  name?: string;
  title?: string;
  publicTitle?: string;
  description?: string;
  summary?: string;
  entries?: Record<string, RawLoreEntry> | readonly RawLoreEntry[];
  [key: string]: unknown;
}>;

export type RawLorebook = Readonly<
  RawLorebookContainer & {
    character_book?: RawLorebookContainer;
  }
>;

export type TavernLorebookImportOptions = Readonly<{
  fallbackTitle?: string;
  fallbackSummary?: string;
  maxEntries?: number;
  filterDisabled?: boolean;
}>;

/**
 * Detects whether an arbitrary payload represents an external SillyTavern,
 * Chub, or character_book lorebook format rather than a native CreateWorldInfoRequest.
 */
export function isRawTavernLorebook(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const obj = value as Record<string, unknown>;
  if ("character_book" in obj && typeof obj.character_book === "object" && obj.character_book !== null) {
    return true;
  }
  if ("entries" in obj) {
    if (typeof obj.entries === "object" && obj.entries !== null && !Array.isArray(obj.entries)) {
      return true;
    }
    if (Array.isArray(obj.entries) && obj.entries.length > 0) {
      const first = obj.entries[0];
      if (typeof first === "object" && first !== null) {
        if ("comment" in first || "keys" in first || "key" in first || "uid" in first || "content" in first) {
          return true;
        }
      }
    }
  }
  if ("name" in obj && !("publicTitle" in obj)) {
    return true;
  }
  return false;
}

/**
 * Transforms external SillyTavern, Chub, or character_book lorebook payloads
 * into compliant GameBuddy CreateWorldInfoRequest objects.
 */
export function importTavernLorebook(
  raw: unknown,
  options: TavernLorebookImportOptions = {},
): CreateWorldInfoRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("invalid_tavern_lorebook: root must be a non-null object");
  }

  const lorebook = raw as RawLorebook;
  const container = lorebook.character_book ?? lorebook;

  const rawTitle =
    container.name ??
    container.title ??
    container.publicTitle ??
    lorebook.name ??
    lorebook.title ??
    options.fallbackTitle ??
    "Tavern World Info";
  const publicTitle = cleanLorebookText(rawTitle, MAX_TITLE) || "Tavern World Info";

  const rawSummary =
    container.description ??
    container.summary ??
    lorebook.description ??
    lorebook.summary ??
    options.fallbackSummary ??
    `World lore: ${publicTitle}`;
  const summary = cleanLorebookText(rawSummary, MAX_SUMMARY) || `World lore: ${publicTitle}`;

  let rawList: RawLoreEntry[] = [];
  const entriesField = container.entries;
  if (Array.isArray(entriesField)) {
    rawList = entriesField.filter((item): item is RawLoreEntry => Boolean(item && typeof item === "object"));
  } else if (entriesField && typeof entriesField === "object") {
    rawList = Object.values(entriesField).filter((item): item is RawLoreEntry => Boolean(item && typeof item === "object"));
  }

  const maxEntries = options.maxEntries ?? Number.POSITIVE_INFINITY;
  const adaptedEntries: PublicWorldInfoEntry[] = [];

  for (const rawEntry of rawList) {
    if (adaptedEntries.length >= maxEntries) break;

    const isDisabled = rawEntry.disable === true || rawEntry.enabled === false;
    if (options.filterDisabled && isDisabled) continue;

    const titleCandidate =
      rawEntry.comment ??
      rawEntry.name ??
      rawEntry.publicTitle ??
      (Array.isArray(rawEntry.keys) && rawEntry.keys[0]) ??
      (Array.isArray(rawEntry.key) && rawEntry.key[0]) ??
      `Location ${adaptedEntries.length + 1}`;

    const entryTitle = cleanLorebookText(titleCandidate, MAX_TITLE);
    if (!entryTitle) continue;

    const contentCandidate = rawEntry.content ?? rawEntry.summary ?? "";
    const entrySummary = cleanLorebookText(contentCandidate, MAX_SUMMARY);
    if (!entrySummary) continue;

    const scope: "companion" | "setting" = rawEntry.scope === "companion" ? "companion" : "setting";

    adaptedEntries.push(
      Object.freeze({
        scope,
        publicTitle: entryTitle,
        summary: entrySummary,
      }),
    );
  }

  if (adaptedEntries.length === 0) {
    adaptedEntries.push(
      Object.freeze({
        scope: "setting",
        publicTitle: "Overview",
        summary,
      }),
    );
  }

  return Object.freeze({
    publicTitle,
    summary,
    entries: Object.freeze(adaptedEntries),
  });
}
