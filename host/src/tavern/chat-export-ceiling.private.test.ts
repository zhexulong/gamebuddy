/**
 * The export's ceiling, at the boundary and from the producer's own output.
 *
 * `ChatExportV1Schema.jsonl` is bounded by `CHAT_EXPORT_JSONL_MAX_LENGTH`, and the exporter that fills it
 * is bounded by the interchange's own limits: 256 bubbles of at most 4 000 UTF-8 bytes. Those two bounds
 * look like they agree - the constant's declaration says "256 bubbles of at most 4 000 bytes, plus their
 * JSON" - and for plain prose they do: 256 bubbles of ordinary text land a little under the ceiling.
 *
 * They do not agree for text the JSON encoding has to escape. A bubble is bounded by its own BYTES, while
 * the file is measured in the characters `JSON.stringify` produces: one `"` is one byte and two
 * characters, so 256 legal bubbles of quotation marks serialize to twice the text they came from and pass
 * the ceiling. That chat is legal, durable and ordinary - a companion quoting dialogue writes one - and the
 * export of it cannot be served at all, which `ChatExportV1Schema.Check` reported to the player as
 * `chat_management_service_unavailable`: a permanent condition wearing a transient outage's name.
 *
 * Both fixtures here come from the real exporter, never from a hand-written megabyte of text: the plain one
 * is the boundary that does NOT cross (so a refusal keyed on the bubble count would be wrong), and the
 * escaped one is the legal chat that does.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_EXPORT_JSONL_MAX_LENGTH } from "./browser-contract/index.js";
import { exportSafeChat, TAVERN_INTERCHANGE_LIMITS_V1 } from "./interchange.js";
import type { ChatThreadMessage } from "./chat-thread-store.js";
import { ChatExportTooLargeError, chatExportFitsWire } from "./chat-management/chat-management-service.js";

/**
 * Both fixtures are built from the interchange's OWN declared bounds - the bubble ceiling and the
 * per-bubble byte cap - so the maximal Chat this file exports is the one the interchange wrote, not a
 * second spelling of 256 bubbles of 4 000 bytes that agrees only until one of them moves.
 */
const BUBBLE_TEXT_MAX_BYTES = TAVERN_INTERCHANGE_LIMITS_V1.textBytes;
const BUBBLE_MAX = TAVERN_INTERCHANGE_LIMITS_V1.chatMessages;

const THREAD_ID = `chat-${"1".repeat(16)}`;
const NAMES = { userName: "A Player", characterName: "Mira" } as const;

function maximalChat(fill: string): readonly ChatThreadMessage[] {
  const text = fill.repeat(BUBBLE_TEXT_MAX_BYTES / Buffer.byteLength(fill, "utf8"));
  return Object.freeze(
    Array.from({ length: BUBBLE_MAX }, (_, index) =>
      Object.freeze({
        messageId: `message_${index}`,
        role: index % 2 === 0 ? ("player" as const) : ("companion" as const),
        kind: index === 0 ? ("opening" as const) : index % 2 === 0 ? ("player" as const) : ("response" as const),
        text,
        occurredAtMs: 1_700_000_000_000 + index,
        greetingSource: null,
      }),
    ),
  );
}

test("the largest chat of plain prose exports under the ceiling, so the refusal is not keyed on its size", () => {
  const exported = exportSafeChat(THREAD_ID, maximalChat("x"), NAMES);
  // Every bubble the interchange allows survived: this is the legal maximum, not a truncated list.
  assert.equal(exported.messages.length, BUBBLE_MAX);
  assert.equal(chatExportFitsWire(exported.jsonl.length), true);
});

test("a legal chat whose bubbles are quotation marks exports past the wire ceiling", () => {
  const exported = exportSafeChat(THREAD_ID, maximalChat('"'), NAMES);
  assert.equal(exported.messages.length, BUBBLE_MAX);
  assert.ok(
    exported.jsonl.length > CHAT_EXPORT_JSONL_MAX_LENGTH,
    `the same maximum chat, whose bubbles the JSON encoding doubles, produced ${exported.jsonl.length} characters - it must pass the wire ceiling (${CHAT_EXPORT_JSONL_MAX_LENGTH}) or this refusal guards nothing`,
  );
  assert.equal(chatExportFitsWire(exported.jsonl.length), false);
});

test("the export fits the wire up to and including the ceiling, and not one character past it", () => {
  assert.equal(chatExportFitsWire(CHAT_EXPORT_JSONL_MAX_LENGTH), true);
  assert.equal(chatExportFitsWire(CHAT_EXPORT_JSONL_MAX_LENGTH + 1), false);
});

test("the refusal carries both numbers, and names itself rather than the service", () => {
  const tooLong = CHAT_EXPORT_JSONL_MAX_LENGTH + 2;
  const refusal = new ChatExportTooLargeError(tooLong, CHAT_EXPORT_JSONL_MAX_LENGTH);
  // The message is the evidence a support path logs: how long the file was, and the ceiling it passed.
  assert.equal(refusal.message, `chat_export_too_large:${tooLong}:${CHAT_EXPORT_JSONL_MAX_LENGTH}`);
});
