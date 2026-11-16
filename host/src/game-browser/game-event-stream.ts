import { randomBytes } from "node:crypto";
import { GameBrowserValidatorsV1, type GameEventV1, type GameFactPatchV1 } from "../game-browser-contract/index.js";

const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/u;
/**
 * How many frames the replay window holds.
 *
 * The window exists for one job: a browser that dropped its connection reconnects with the cursor it last saw and
 * must not be forced to throw its projection away. It is not history - a miss is a resync to the `/game` snapshot,
 * which stays the authority - so the number only has to cover a reconnect, and it must be bounded because the ring
 * lives for the whole process.
 *
 * 64 is the Chat channel's number (`tavern/chat-event-stream.ts`) for exactly that property, and the Game's
 * producer is far slower than the Chat's: the Chat publishes a frame per turn event, while the Game publishes only
 * at the transitions of three facts (instance, attachment, selected world). 64 frames is therefore a far wider
 * margin here than there, and choosing a second number would mean reasoning about the same property twice.
 */
const DEFAULT_WINDOW = 64;

export type GameResyncReason = "gap" | "epoch_changed" | "ambiguous_cursor";
export type GameEventStreamCursor = Readonly<{ epoch: string; sequence: number }>;
export type GameEventStreamSubscription = Readonly<{ epoch: string; after: number }>;
export type GameEventStreamResult = Readonly<{
  kind: "replay" | "resync";
  events: readonly GameEventV1[];
  reason?: GameResyncReason;
}>;

/**
 * The Game surface's own push channel: per-process epoch, monotonic sequence, bounded replay window.
 *
 * It is deliberately volatile and deliberately separate from the Chat stream. Durable state - the coordinator's
 * own readers - remains the authority, `/game` remains the snapshot that reconciles, and a replay miss is a
 * resync. Nothing on this channel carries a Chat selection generation, so switching Chats cannot move a Game
 * cursor and a Chat failure cannot take the Game panel down with it.
 */
export type GameEventStream = Readonly<{
  readonly epoch: string;
  readonly cursor: string;
  publish(patch: GameFactPatchV1): GameEventV1;
  subscribe(subscription: GameEventStreamSubscription): GameEventStreamResult;
  listen(
    subscription: GameEventStreamSubscription,
    listener: (event: GameEventV1) => void,
  ): Readonly<{ result: GameEventStreamResult; close(): void }>;
  resync(reason: GameResyncReason): GameEventV1;
  encodeCursor(cursor: GameEventStreamCursor): string;
  decodeCursor(value: unknown): GameEventStreamCursor | null;
}>;

export function createGameEventStream(windowSize = DEFAULT_WINDOW): GameEventStream {
  if (!Number.isSafeInteger(windowSize) || windowSize < 1 || windowSize > 256)
    throw new Error("game_event_stream_window_invalid");
  const epoch = randomHandle();
  let sequence = 0;
  const events: GameEventV1[] = [];
  const listeners = new Set<(event: GameEventV1) => void>();

  const encodeCursor = (cursor: GameEventStreamCursor): string => {
    if (!isValidEpoch(cursor.epoch) || !isNonnegative(cursor.sequence))
      throw new Error("game_event_stream_cursor_invalid");
    return Buffer.from(JSON.stringify([cursor.epoch, cursor.sequence]), "utf8").toString("base64url");
  };
  const decodeCursor = (value: unknown): GameEventStreamCursor | null => {
    if (typeof value !== "string" || value.length < 1 || value.length > 128) return null;
    try {
      const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !isValidEpoch(parsed[0]) || !isNonnegative(parsed[1]))
        return null;
      return Object.freeze({ epoch: parsed[0], sequence: parsed[1] });
    } catch {
      return null;
    }
  };
  const resync = (reason: GameResyncReason): GameEventV1 => {
    // A resync frame answers the one connection that asked for it and never enters the ring, so it occupies a
    // sequence number the ring does not hold. That is safe because it carries no fact: a replay across it still
    // delivers every fact in order, and a caller that read the frame's own id as its cursor - which `EventSource`
    // does, because every frame here is written with an `id:` line - continues from exactly after it.
    sequence += 1;
    const event = Object.freeze({
      apiVersion: 1 as const,
      epoch,
      sequence,
      eventType: "game.stream_resync_required" as const,
      payload: Object.freeze({ reason }),
    });
    if (!GameBrowserValidatorsV1.GameEventV1Schema.Check(event)) throw new Error("game_event_stream_event_invalid");
    return event;
  };
  const subscribe = (subscription: GameEventStreamSubscription): GameEventStreamResult => {
    if (
      subscription === null ||
      typeof subscription !== "object" ||
      !isValidEpoch(subscription.epoch) ||
      !Number.isSafeInteger(subscription.after) ||
      subscription.after < 0
    )
      return Object.freeze({ kind: "resync", events: Object.freeze([]), reason: "ambiguous_cursor" });
    if (subscription.epoch !== epoch)
      return Object.freeze({ kind: "resync", events: Object.freeze([]), reason: "epoch_changed" });
    if (subscription.after > sequence)
      return Object.freeze({ kind: "resync", events: Object.freeze([]), reason: "ambiguous_cursor" });
    if (subscription.after === sequence) return Object.freeze({ kind: "replay", events: Object.freeze([]) });
    const first = events[0]?.sequence ?? sequence + 1;
    if (subscription.after < first - 1)
      return Object.freeze({ kind: "resync", events: Object.freeze([]), reason: "gap" });
    const replay = events.filter((event) => event.sequence > subscription.after);
    return Object.freeze({ kind: "replay", events: Object.freeze(replay) });
  };

  return Object.freeze({
    epoch,
    get cursor() {
      return encodeCursor({ epoch, sequence });
    },
    publish(patch) {
      if (patch === null || typeof patch !== "object" || Array.isArray(patch))
        throw new Error("game_event_stream_event_invalid");
      if (!GameBrowserValidatorsV1.GameFactPatchV1Schema.Check(patch))
        throw new Error("game_event_stream_event_invalid");
      sequence += 1;
      const event = Object.freeze({
        apiVersion: 1 as const,
        epoch,
        sequence,
        eventType: "game.fact_changed" as const,
        payload: patch,
      });
      if (!GameBrowserValidatorsV1.GameEventV1Schema.Check(event)) {
        sequence -= 1;
        throw new Error("game_event_stream_event_invalid");
      }
      events.push(event);
      while (events.length > windowSize) events.shift();
      for (const listener of [...listeners]) listener(event);
      return event;
    },
    subscribe,
    listen(subscription, listener) {
      if (typeof listener !== "function") throw new Error("game_event_stream_listener_invalid");
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
    resync,
    encodeCursor,
    decodeCursor,
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
