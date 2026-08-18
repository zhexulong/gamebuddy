import { randomBytes } from "node:crypto";
import { TavernBrowserValidatorsV1, type BrowserEventV1 } from "./browser-contract/index.js";

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
const DEFAULT_WINDOW = 64;

export type ResyncReason = "gap" | "epoch_changed" | "restart" | "ambiguous_cursor";
export type ChatEventStreamCursor = Readonly<{ epoch: string; sequence: number }>;
export type ChatEventStreamSubscription = Readonly<{
  epoch: string;
  after: number;
  generation: number;
}>;
export type ChatEventStreamResult = Readonly<{
  kind: "replay" | "resync";
  events: readonly BrowserEventV1[];
  reason?: ResyncReason;
}>;
type BrowserEventInput = BrowserEventV1 extends infer Event
  ? Event extends { apiVersion: 1; epoch: string; sequence: number }
    ? Omit<Event, "apiVersion" | "epoch" | "sequence">
    : never
  : never;

export type ChatEventStream = Readonly<{
  readonly epoch: string;
  readonly cursor: string;
  publish(event: BrowserEventInput): BrowserEventV1;
  subscribe(subscription: ChatEventStreamSubscription): ChatEventStreamResult;
  listen(
    subscription: ChatEventStreamSubscription,
    listener: (event: BrowserEventV1) => void,
  ): Readonly<{ result: ChatEventStreamResult; close(): void }>;
  resync(reason: ResyncReason, generation: number): BrowserEventV1;
  encodeCursor(cursor: ChatEventStreamCursor): string;
  decodeCursor(value: unknown): ChatEventStreamCursor | null;
}>;

/**
 * Per-process, bounded live projection stream. It is intentionally volatile:
 * durable repositories remain the source of truth and a replay miss requires
 * the browser to replace state from /state.
 */
export function createChatEventStream(windowSize = DEFAULT_WINDOW): ChatEventStream {
  if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > 256)
    throw new Error("chat_event_stream_window_invalid");
  const epoch = randomHandle();
  let sequence = 0;
  const events: BrowserEventV1[] = [];
  const listeners = new Set<(event: BrowserEventV1) => void>();

  const encodeCursor = (cursor: ChatEventStreamCursor): string => {
    if (!isValidEpoch(cursor.epoch) || !isNonnegative(cursor.sequence))
      throw new Error("chat_event_stream_cursor_invalid");
    return Buffer.from(JSON.stringify([cursor.epoch, cursor.sequence]), "utf8").toString("base64url");
  };
  const decodeCursor = (value: unknown): ChatEventStreamCursor | null => {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !isValidEpoch(parsed[0]) || !isNonnegative(parsed[1])) return null;
      return Object.freeze({ epoch: parsed[0], sequence: parsed[1] });
    } catch {
      return null;
    }
  };
  const resync = (reason: ResyncReason): ChatEventStreamResult =>
    Object.freeze({ kind: "resync", events: Object.freeze([]), reason });
  const subscribe = (subscription: ChatEventStreamSubscription): ChatEventStreamResult => {
    if (
      subscription === null ||
      typeof subscription !== "object" ||
      !isValidEpoch(subscription.epoch) ||
      !Number.isSafeInteger(subscription.after) ||
      subscription.after < 0 ||
      !Number.isSafeInteger(subscription.generation) ||
      subscription.generation < 1
    ) return resync("ambiguous_cursor");
    if (subscription.epoch !== epoch) return resync("epoch_changed");
    if (subscription.after > sequence) return resync("ambiguous_cursor");
    if (subscription.after === sequence) return Object.freeze({ kind: "replay", events: Object.freeze([]) });
    const first = events[0]?.sequence ?? sequence + 1;
    if (subscription.after < first - 1) return resync("gap");
    const replay = events.filter((event) => event.sequence > subscription.after && event.selectionGeneration === subscription.generation);
    if (replay.length !== events.filter((event) => event.sequence > subscription.after).length)
      return resync("epoch_changed");
    return Object.freeze({ kind: "replay", events: Object.freeze(replay) });
  };

  return Object.freeze({
    epoch,
    get cursor() {
      return encodeCursor({ epoch, sequence });
    },
    encodeCursor,
    decodeCursor,
    publish(input) {
      if (input === null || typeof input !== "object" || Array.isArray(input))
        throw new Error("chat_event_stream_event_invalid");
      if (
        Object.hasOwn(input, "apiVersion") ||
        Object.hasOwn(input, "epoch") ||
        Object.hasOwn(input, "sequence")
      )
        // Stream-owned fields are minted here and must never be overridable
        // by caller input; a forged-but-schema-valid epoch/sequence would
        // otherwise corrupt the monotonic cursor of every subscriber.
        throw new Error("chat_event_stream_event_invalid");
      sequence += 1;
      const event = Object.freeze({ apiVersion: 1 as const, epoch, sequence, ...input });
      if (!TavernBrowserValidatorsV1.BrowserEventV1Schema.Check(event)) {
        sequence -= 1;
        throw new Error("chat_event_stream_event_invalid");
      }
      events.push(event);
      while (events.length > windowSize) events.shift();
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    subscribe,
    listen(subscription, listener) {
      if (typeof listener !== "function") throw new Error("chat_event_stream_listener_invalid");
      listeners.add(listener);
      const result = subscribe(subscription);
      if (result.kind === "resync") listeners.delete(listener);
      let closed = false;
      return Object.freeze({
        result,
        close() {
          if (closed) return;
          closed = true;
          listeners.delete(listener);
        },
      });
    },
    resync(reason, generation) {
      if (!Number.isSafeInteger(generation) || generation < 1)
        throw new Error("chat_event_stream_generation_invalid");
      sequence += 1;
      const event = Object.freeze({
        apiVersion: 1 as const,
        epoch,
        sequence,
        selectionGeneration: generation,
        eventType: "stream.resync_required" as const,
        payload: { reason },
      });
      if (!TavernBrowserValidatorsV1.BrowserEventV1Schema.Check(event))
        throw new Error("chat_event_stream_event_invalid");
      return event;
    },
  });
}

function randomHandle(): string {
  return randomBytes(32).toString("base64url");
}
function isValidEpoch(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value);
}
function isNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
