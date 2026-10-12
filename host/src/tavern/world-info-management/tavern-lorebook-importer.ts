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
 * Block-level break tags that become a newline when unwrapped.
 */
const BLOCK_BREAK_NAMES = new Set(["br", "hr", "p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

/**
 * Elements whose entire content is dropped, not just unwrapped.
 */
const ELEMENT_DROP_NAMES = new Set(["script", "style"]);

/**
 * Strips markup with a single forward pass instead of regexes over HTML.
 *
 * Why not regexes: tag matching cannot be written as a regular language - a crafted
 * string such as `<scr<script>ipt>` or an unterminated quote recombines fragments across
 * replacement boundaries (each `replace` re-scans the previous output). A single pass
 * that consumes each verified `<...>`/`<!--...-->` region exactly once cannot be bypassed.
 *
 * Guarantees on the returned text:
 *  - every region that starts at a `<` tag/comment marker is consumed until its matching
 *    `>`/`-->` (quoted attribute values cannot close a tag, so `title=">"` cannot leak);
 *  - `script`/`style` elements drop their whole content (a closing `</script >` with
 *    whitespace still closes, and an element left unclosed drops the rest of the text
 *    fail-closed);
 *  - block break tags (`<br>`, `</p>`, ...) become a newline;
 *  - every other tag is unwrapped to its bare text;
 *  - a `<` that does not open a tag (e.g. `x < y`) or that opens an unterminated tag
 *    region is dropped, so no surviving `<` can pair with a later `>` to re-form a tag,
 *    and stray `>` is inert on its own.
 */
function stripMarkup(value: string): string {
  const isTagStart = (char: string | undefined): boolean =>
    char !== undefined && /[A-Za-z/!?]/.test(char);

  /** Normalizes a raw tag body (` div class=...`, `/p`, `script `) to its name + closer flag. */
  const tagName = (raw: string): { name: string; closing: boolean } => {
    const trimmed = raw.trim();
    const closing = trimmed.startsWith("/");
    const body = closing ? trimmed.slice(1) : trimmed;
    const match = /^[A-Za-z][A-Za-z0-9]*/.exec(body);
    return { name: (match?.[0] ?? "").toLowerCase(), closing };
  };

  let out = "";
  let at = 0;
  while (at < value.length) {
    if (value[at] !== "<") {
      out += value[at];
      at += 1;
      continue;
    }
    if (value.startsWith("<!--", at)) {
      const end = value.indexOf("-->", at + 4);
      if (end === -1) return out; // Unterminated comment: drop the rest of the text fail-closed.
      at = end + 3;
      continue;
    }
    if (!isTagStart(value[at + 1])) {
      at += 1; // A `<` that cannot open a tag is dropped: it must never survive to pair with a `>`.
      continue;
    }
    // Scan the tag region; quoted attribute values cannot close it.
    let quote: string | null = null;
    let close = at + 1;
    for (; close < value.length; close += 1) {
      const char = value[close];
      if (quote !== null) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (close >= value.length) {
      at += 1; // Unterminated tag: drop the bare `<`, keep the remaining characters as literal text.
      continue;
    }
    const rawTag = value.slice(at + 1, close);
    const { name, closing } = tagName(rawTag);
    if (ELEMENT_DROP_NAMES.has(name)) {
      const closer = name === "script" ? /<\/script\s*>/gi : /<\/style\s*>/gi;
      closer.lastIndex = close + 1;
      const matched = closer.exec(value);
      if (!matched) return out; // Unclosed script/style: drop the rest of the text fail-closed.
      at = matched.index + matched[0].length;
      continue;
    }
    if (BLOCK_BREAK_NAMES.has(name)) {
      if (name === "br" || name === "hr" || closing) out += "\n";
    }
    at = close + 1;
  }
  return out;
}

/**
 * Sanitizes lorebook text by stripping markup, normalizing line endings to Unix newlines (\n),
 * and removing non-printable control characters.
 */
export function cleanLorebookText(value: unknown, maxLen = MAX_SUMMARY): string {
  if (typeof value !== "string") return "";
  let text = stripMarkup(value.normalize("NFC"));

  // Normalize Windows/Mac line endings to standard Unix newlines
  text = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Remove non-printable control characters while preserving \t (9) and \n (10)
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");

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
  key?: readonly string[] | string;
  keys?: readonly string[];
  keysecondary?: readonly string[] | string;
  secondary_keys?: readonly string[] | string;
  secondaryKeys?: readonly string[] | string;
  selectiveLogic?: number;
  constant?: boolean;
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
        if ("publicTitle" in obj && "publicTitle" in first) {
          return false;
        }
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
      // GameBuddy authored worldbook entries carry their own `title` field
      // (schemaVersion 1 of the managed repository), distinct from the
      // SillyTavern/Chub comment/name conventions imported below.
      rawEntry.title ??
      (Array.isArray(rawEntry.keys) && rawEntry.keys[0]) ??
      (Array.isArray(rawEntry.key) && rawEntry.key[0]) ??
      (typeof rawEntry.key === "string" && rawEntry.key.split(",")[0]) ??
      `Location ${adaptedEntries.length + 1}`;

    const entryTitle = cleanLorebookText(titleCandidate, MAX_TITLE);
    if (!entryTitle) continue;

    const contentCandidate = rawEntry.content ?? rawEntry.summary ?? "";
    const entrySummary = cleanLorebookText(contentCandidate, MAX_SUMMARY);
    if (!entrySummary) continue;

    const scope: "companion" | "setting" = rawEntry.scope === "companion" ? "companion" : "setting";
    const rawKeys = Array.isArray(rawEntry.keys) ? rawEntry.keys : rawEntry.key;
    const keys = (Array.isArray(rawKeys) ? rawKeys : typeof rawKeys === "string" ? rawKeys.split(",") : [])
      .map((key) => cleanLorebookText(key, 128))
      .filter((key) => key.length > 0)
      .slice(0, 128);
    const constant = rawEntry.constant === true;

    const rawSecondary =
      Array.isArray(rawEntry.secondary_keys) || typeof rawEntry.secondary_keys === "string"
        ? rawEntry.secondary_keys
        : Array.isArray(rawEntry.keysecondary) || typeof rawEntry.keysecondary === "string"
          ? rawEntry.keysecondary
          : Array.isArray(rawEntry.secondaryKeys) || typeof rawEntry.secondaryKeys === "string"
            ? rawEntry.secondaryKeys
            : undefined;
    const secondaryKeys = (
      Array.isArray(rawSecondary) ? rawSecondary : typeof rawSecondary === "string" ? rawSecondary.split(",") : []
    )
      .map((key) => cleanLorebookText(key, 128))
      .filter((key) => key.length > 0)
      .slice(0, 128);

    const selectiveLogic =
      typeof rawEntry.selectiveLogic === "number" &&
      ([0, 1, 2, 3] as readonly number[]).includes(rawEntry.selectiveLogic)
        ? (rawEntry.selectiveLogic as 0 | 1 | 2 | 3)
        : undefined;

    adaptedEntries.push(
      Object.freeze({
        scope,
        publicTitle: entryTitle,
        summary: entrySummary,
        ...(keys.length === 0 ? {} : { keys: Object.freeze(keys) }),
        ...(secondaryKeys.length === 0 ? {} : { secondaryKeys: Object.freeze(secondaryKeys) }),
        ...(selectiveLogic !== undefined ? { selectiveLogic } : {}),
        ...(constant ? { constant: true } : {}),
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
