import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimePaths } from "./runtime.js";
import { withPathLock } from "./path-lock.js";

export const CHAT_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
/** Bound durable player-visible history; older original content stays in Pi/Magic Context, never in this browser artifact. */
export const MAX_CHAT_TRANSCRIPT_ENTRIES = 2_000;
export type ChatTranscriptEntry = Readonly<{
  entryId: string;
  role: "player" | "companion";
  text: string;
  occurredAtMs: number;
  /** Player id or explicit companion_text tool call only; never a raw Pi entry. */
  sourceEventId: string;
}>;
export type ChatTranscript = Readonly<{
  schemaVersion: typeof CHAT_TRANSCRIPT_SCHEMA_VERSION;
  surfaceSessionId: string;
  entries: readonly ChatTranscriptEntry[];
}>;

export function chatTranscriptPath(paths: RuntimePaths): string {
  if (paths.surfaceSessionId === undefined) throw new Error("chat_surface_session_required");
  return join(paths.runtimeCwd, "surface-sessions", paths.surfaceSessionId, "player-visible-chat.json");
}

/**
 * This is deliberately not a projection of Pi JSONL. It is the small,
 * player-visible record produced at the same boundary as browser input and
 * explicit companion_text. Thinking, raw agent output, tools, receipts, and
 * Magic Context data never enter it.
 */
export async function readChatTranscript(path: string, surfaceSessionId: string): Promise<ChatTranscript> {
  try {
    return validateTranscript(JSON.parse(await readFile(path, "utf8")) as unknown, surfaceSessionId);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT")
      return Object.freeze({
        schemaVersion: CHAT_TRANSCRIPT_SCHEMA_VERSION,
        surfaceSessionId,
        entries: Object.freeze([]),
      });
    throw error;
  }
}
export async function appendChatTranscript(
  path: string,
  surfaceSessionId: string,
  entry: ChatTranscriptEntry,
): Promise<ChatTranscript> {
  return withPathLock(path, async () => {
    const current = await readChatTranscript(path, surfaceSessionId);
    if (current.entries.some((item) => item.entryId === entry.entryId)) return current;
    const next = Object.freeze({
      ...current,
      entries: Object.freeze([...current.entries, validateEntry(entry)].slice(-MAX_CHAT_TRANSCRIPT_ENTRIES)),
    });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(next, null, 2), "utf8");
    await rename(temporary, path);
    return next;
  });
}

function validateTranscript(value: unknown, surfaceSessionId: string): ChatTranscript {
  if (
    !isRecord(value) ||
    value.schemaVersion !== CHAT_TRANSCRIPT_SCHEMA_VERSION ||
    value.surfaceSessionId !== surfaceSessionId ||
    !Array.isArray(value.entries) ||
    value.entries.length > MAX_CHAT_TRANSCRIPT_ENTRIES
  )
    throw new Error("invalid_chat_transcript");
  return Object.freeze({
    schemaVersion: CHAT_TRANSCRIPT_SCHEMA_VERSION,
    surfaceSessionId,
    entries: Object.freeze(value.entries.map(validateEntry)),
  });
}
function validateEntry(value: unknown): ChatTranscriptEntry {
  if (
    !isRecord(value) ||
    !isId(value.entryId) ||
    (value.role !== "player" && value.role !== "companion") ||
    !isText(value.text) ||
    !isTimestamp(value.occurredAtMs) ||
    !isId(value.sourceEventId)
  )
    throw new Error("invalid_chat_transcript");
  return Object.freeze({
    entryId: value.entryId,
    role: value.role,
    text: value.text,
    occurredAtMs: value.occurredAtMs,
    sourceEventId: value.sourceEventId,
  });
}
function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
function isText(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 4_000 && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
