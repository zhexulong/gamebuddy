import { createHash } from "node:crypto";
import type { WorldBook } from "../worldbook.js";
import type { ChatThreadMessage } from "./chat-thread-store.js";

export const TAVERN_INTERCHANGE_VERSION = "tavern-interchange/v1" as const;
export const TAVERN_INTERCHANGE_LIMITS_V1 = Object.freeze({
  inputBytes: 262_144,
  chatMessages: 256,
  worldBookEntries: 128,
  textBytes: 4_000,
});
export type InterchangeDisposition = Readonly<{
  field: string;
  classification: "accepted_typed" | "dropped_unsupported" | "rejected_invalid";
  reason: string;
}>;

type SafeChatHeader = Readonly<{
  user_name: string;
  character_name: string;
  chat_metadata: Readonly<Record<string, never>>;
}>;
type SafeChatBubble = Readonly<{ name: string; is_user: boolean; is_system: false; send_date: number; mes: string }>;
/** A version-locked, inert ST Chat JSONL player-visible subset. */
export type SafeChatJsonl = Readonly<{
  format: typeof TAVERN_INTERCHANGE_VERSION;
  kind: "chat";
  header: SafeChatHeader;
  messages: readonly SafeChatBubble[];
  dispositions: readonly InterchangeDisposition[];
  canonicalHash: string;
  /** Exact JSONL suitable for a SillyTavern chat-file import. */
  jsonl: string;
}>;
export type SafeWorldBook = Readonly<{
  format: typeof TAVERN_INTERCHANGE_VERSION;
  kind: "worldbook";
  worldBookId: string;
  revision: number;
  entries: readonly Readonly<{
    entryId: string;
    title: string;
    content: string;
    scope: "companion" | "setting";
    tokenBudget: "small" | "medium";
  }>[];
  dispositions: readonly InterchangeDisposition[];
  canonicalHash: string;
}>;

export type SafeChatExportOptions = Readonly<{ userName?: string; characterName?: string }>;

/**
 * Produces ST-recognized header and bubble records only. `threadId` is retained
 * for call-site compatibility but is never serialized: ChatThread bindings and
 * all message/variant identifiers are deliberately outside this interchange.
 * Only the currently materialized/selected bubble is exported; variants are
 * not represented as ST swipes in v1.
 */
export function exportSafeChat(
  _threadId: string,
  messages: readonly ChatThreadMessage[],
  options: SafeChatExportOptions = {},
): SafeChatJsonl {
  const userName = options.userName ?? "User";
  const characterName = options.characterName ?? "Companion";
  if (!name(userName) || !name(characterName)) throw new Error("invalid_interchange_chat_header");
  const kept = messages
    .slice(0, TAVERN_INTERCHANGE_LIMITS_V1.chatMessages)
    .filter((message) => text(message.text))
    .map((message) =>
      Object.freeze({
        name: message.role === "player" ? userName : characterName,
        is_user: message.role === "player",
        is_system: false as const,
        send_date: message.occurredAtMs,
        mes: message.text,
      }),
    );
  const dispositions: InterchangeDisposition[] = [];
  if (kept.length !== messages.length)
    dispositions.push(disposition("messages", "dropped_unsupported", "invalid_or_over_limit_bubbles_excluded"));
  const droppedOpeningVariants = messages.some(
    (message) => message.kind === "opening" && message.greetingSource !== null,
  );
  if (droppedOpeningVariants)
    dispositions.push(disposition("swipes", "dropped_unsupported", "only_selected_message_variant_is_exported"));
  dispositions.push(disposition("message_ids", "dropped_unsupported", "Tavern_message_identifiers_are_not_exported"));
  const header = Object.freeze({
    user_name: userName,
    character_name: characterName,
    chat_metadata: Object.freeze({}),
  });
  return signedChat({
    format: TAVERN_INTERCHANGE_VERSION,
    kind: "chat",
    header,
    messages: Object.freeze(kept),
    dispositions: Object.freeze(deduplicateDispositions(dispositions)),
  });
}

/** Exports only public background entries. Runtime/world-scoped facts and always-on prompt text are never browser-exported. */
export function exportSafeWorldBook(book: WorldBook): SafeWorldBook {
  const entries = book.entries
    .filter(
      (entry): entry is typeof entry & Readonly<{ scope: "companion" | "setting" }> =>
        entry.scope === "companion" || entry.scope === "setting",
    )
    .slice(0, TAVERN_INTERCHANGE_LIMITS_V1.worldBookEntries)
    .map((entry) =>
      Object.freeze({
        entryId: entry.entryId,
        title: entry.title,
        content: entry.content,
        scope: entry.scope,
        tokenBudget: entry.tokenBudget,
      }),
    );
  const dispositions: InterchangeDisposition[] =
    book.entries.length === entries.length
      ? []
      : [disposition("entries", "dropped_unsupported", "runtime_or_world_scoped_entries_excluded")];
  return signed({
    format: TAVERN_INTERCHANGE_VERSION,
    kind: "worldbook",
    worldBookId: book.worldBookId,
    revision: book.revision,
    entries: Object.freeze(entries),
    dispositions: Object.freeze(dispositions),
  });
}

/** Strictly validates a JSONL file before it can be persisted as an inert import audit artifact. */
export function decodeSafeInterchange(input: string): SafeChatJsonl | SafeWorldBook {
  if (Buffer.byteLength(input, "utf8") > TAVERN_INTERCHANGE_LIMITS_V1.inputBytes)
    throw new Error("interchange_too_large");
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return decodeChatJsonl(input);
  }
  if (
    !record(value) ||
    value.format !== TAVERN_INTERCHANGE_VERSION ||
    (value.kind !== "chat" && value.kind !== "worldbook") ||
    !Array.isArray(value.dispositions) ||
    !value.dispositions.every(validDisposition) ||
    typeof value.canonicalHash !== "string"
  )
    throw new Error("invalid_interchange");
  if (value.kind === "chat") {
    if (
      !exactKeys(value, ["format", "kind", "header", "messages", "dispositions", "canonicalHash", "jsonl"]) ||
      typeof value.jsonl !== "string"
    )
      throw new Error("interchange_private_or_unknown_field");
    const unsigned = {
      format: value.format,
      kind: value.kind,
      header: value.header,
      messages: value.messages,
      dispositions: value.dispositions,
    };
    if (hash(JSON.stringify(unsigned)) !== value.canonicalHash) throw new Error("interchange_hash_mismatch");
    validateChat(unsigned);
    if (value.jsonl !== jsonl(value.header, value.messages)) throw new Error("interchange_jsonl_mismatch");
    return value as SafeChatJsonl;
  }
  if (!exactKeys(value, ["format", "kind", "worldBookId", "revision", "entries", "dispositions", "canonicalHash"]))
    throw new Error("interchange_private_or_unknown_field");
  const unsigned = { ...value };
  delete unsigned.canonicalHash;
  if (hash(JSON.stringify(unsigned)) !== value.canonicalHash) throw new Error("interchange_hash_mismatch");
  if (
    !id(value.worldBookId) ||
    !positive(value.revision) ||
    !Array.isArray(value.entries) ||
    value.entries.length > TAVERN_INTERCHANGE_LIMITS_V1.worldBookEntries ||
    !value.entries.every(
      (entry) =>
        record(entry) &&
        exactKeys(entry, ["entryId", "title", "content", "scope", "tokenBudget"]) &&
        id(entry.entryId) &&
        text(entry.title) &&
        text(entry.content) &&
        (entry.scope === "companion" || entry.scope === "setting") &&
        (entry.tokenBudget === "small" || entry.tokenBudget === "medium"),
    )
  )
    throw new Error("invalid_interchange_worldbook");
  return value as SafeWorldBook;
}

function decodeChatJsonl(input: string): SafeChatJsonl {
  const lines = input.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new Error("invalid_interchange_jsonl");
  let parsed: unknown[];
  try {
    parsed = lines.map((line) => JSON.parse(line));
  } catch {
    throw new Error("invalid_interchange_jsonl");
  }
  const header = parsed[0];
  if (
    !record(header) ||
    !exactKeys(header, ["user_name", "character_name", "chat_metadata"]) ||
    !name(header.user_name) ||
    !name(header.character_name) ||
    !emptyMetadata(header.chat_metadata)
  )
    throw new Error("invalid_interchange_chat_header");
  const messages = parsed.slice(1);
  if (messages.length > TAVERN_INTERCHANGE_LIMITS_V1.chatMessages || !messages.every(validBubble))
    throw new Error("invalid_interchange_chat");
  const dispositions: InterchangeDisposition[] = [
    disposition("chat_thread_binding", "dropped_unsupported", "inbound transcript remains inert and unbound"),
  ];
  return signedChat({
    format: TAVERN_INTERCHANGE_VERSION,
    kind: "chat",
    header: Object.freeze(header as SafeChatHeader),
    messages: Object.freeze(messages as SafeChatBubble[]),
    dispositions: Object.freeze(dispositions),
  });
}

function signedChat(value: Omit<SafeChatJsonl, "canonicalHash" | "jsonl">): SafeChatJsonl {
  const canonicalHash = hash(JSON.stringify(value));
  return Object.freeze({ ...value, canonicalHash, jsonl: jsonl(value.header, value.messages) });
}
function jsonl(header: SafeChatHeader, messages: readonly SafeChatBubble[]): string {
  return `${[header, ...messages].map((line) => JSON.stringify(line)).join("\n")}\n`;
}
function validateChat(value: Record<string, any>): void {
  if (
    !record(value.header) ||
    !exactKeys(value.header, ["user_name", "character_name", "chat_metadata"]) ||
    !name(value.header.user_name) ||
    !name(value.header.character_name) ||
    !emptyMetadata(value.header.chat_metadata) ||
    !Array.isArray(value.messages) ||
    value.messages.length > TAVERN_INTERCHANGE_LIMITS_V1.chatMessages ||
    !value.messages.every(validBubble)
  )
    throw new Error("invalid_interchange_chat");
}
function validBubble(value: unknown): value is SafeChatBubble {
  return (
    record(value) &&
    exactKeys(value, ["name", "is_user", "is_system", "send_date", "mes"]) &&
    name(value.name) &&
    typeof value.is_user === "boolean" &&
    value.is_system === false &&
    Number.isSafeInteger(value.send_date) &&
    value.send_date >= 0 &&
    text(value.mes)
  );
}
function emptyMetadata(value: unknown): value is Readonly<Record<string, never>> {
  return record(value) && Object.keys(value).length === 0;
}
function signed<T extends object>(value: T): T & Readonly<{ canonicalHash: string }> {
  return Object.freeze({ ...value, canonicalHash: hash(JSON.stringify(value)) });
}
function disposition(
  field: string,
  classification: InterchangeDisposition["classification"],
  reason: string,
): InterchangeDisposition {
  return Object.freeze({ field, classification, reason });
}
function deduplicateDispositions(values: readonly InterchangeDisposition[]): InterchangeDisposition[] {
  return values.filter((item, index) => values.findIndex((candidate) => candidate.field === item.field) === index);
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
function name(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function text(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > 0 &&
    Buffer.byteLength(value, "utf8") <= TAVERN_INTERCHANGE_LIMITS_V1.textBytes &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}
function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key)) && allowed.every((key) => key in value);
}
function validDisposition(value: unknown): value is InterchangeDisposition {
  return (
    record(value) &&
    exactKeys(value, ["field", "classification", "reason"]) &&
    id(value.field) &&
    (value.classification === "accepted_typed" ||
      value.classification === "dropped_unsupported" ||
      value.classification === "rejected_invalid") &&
    typeof value.reason === "string" &&
    value.reason.length > 0 &&
    value.reason.length <= 128
  );
}
