import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_PACED_DELIVERY, GAME_DELIVERY_PACING, typingDurationMs } from "./companion-delivery-pacing.js";
import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_SCAFFOLDING,
  CHAT_TRANSCRIPT_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
  type NativeCompanionContentSinks,
} from "./native-companion-content.js";

/**
 * The FIRST piece of a turn has one job: end the silence. Content-proportional
 * typing time is right for the gaps BETWEEN messages - a long remark reads as
 * being typed for longer - but applying it to the first piece inverts the goal:
 * a long opening sentence would be spoken LATER than the flat beat it replaced.
 *
 * Measured before the fix, on the same 6 s turn: switch off spoke at 3011 ms,
 * switch on spoke at 5401 ms. Pacing made the silence longer. These cases pin
 * the bound so that cannot happen again.
 */

type Listener = (event: NativeCompanionContentEvent) => void;

function fakeSession() {
  const listeners = new Set<Listener>();
  return Object.freeze({
    session: Object.freeze({
      subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
    emit(event: NativeCompanionContentEvent): void {
      for (const listener of [...listeners]) listener(event);
    },
  });
}

const text = (value: string) => Object.freeze({ type: "text" as const, text: value });
const assistant = (content: readonly unknown[]) =>
  Object.freeze({ role: "assistant" as const, content, stopReason: "stop", responseId: "response-1" });

/** A long opening sentence: its own typing time would exceed the flat beat. */
const LONG_OPENING = "东边那片地今天翻完了，土也比昨天松，下午还得再耙一遍。";
const SHORT_OPENING = "嗯。";

async function firstPieceDelayMs(opening: string, pacing: typeof CHAT_PACED_DELIVERY): Promise<number | null> {
  const fx = fakeSession();
  const seen: Readonly<{ at: number; piece: string }>[] = [];
  const startedAt = Date.now();
  const pieces: { at: number; piece: string }[] = [];
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (piece: string) => {
      pieces.push({ at: Date.now() - startedAt, piece });
    },
    onFinalText: async () => undefined,
    onRejected: async () => undefined,
  });
  void seen;
  const observer = attachNativeCompanionContent(fx.session, sinks, {
    stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,
    scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,
    pacing,
    turn: { id: "turn_first_piece_bound", locale: "zh" },
  });
  observer.open();
  observer.openPreviews();
  const partial = assistant([text("")]);
  fx.emit({ type: "message_start", message: partial });
  fx.emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
  });
  fx.emit({
    type: "message_update",
    message: assistant([text(opening)]),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: opening, partial },
  });
  // Wait long enough to observe a bounded delay, but not the full typing time of
  // a long sentence: the assertion is about the bound, not about exact timing.
  await new Promise((resolve) => setTimeout(resolve, 3_600));
  fx.emit({ type: "message_end", message: assistant([text(opening)]) });
  for (let i = 0; i < 10; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  await observer.close();
  // The first piece is the sound; the opening sentence is the one that carries
  // the player's text, whatever its length.
  if (pieces.length < 2) return null;
  return pieces[1]!.at;
}

test("a long opening sentence is still spoken within the flat beat, not after its own typing time", async () => {
  const typingTime = typingDurationMs(LONG_OPENING, GAME_DELIVERY_PACING.typing!);
  assert.ok(
    typingTime > 3_000,
    `this case is only meaningful when typing time exceeds the flat beat (got ${typingTime}ms)`,
  );
  const delay = await firstPieceDelayMs(LONG_OPENING, CHAT_PACED_DELIVERY);
  assert.notEqual(delay, null, "the opening sentence must be spoken before the reply finishes");
  assert.ok(
    delay! <= 3_600,
    `the first piece waited ${delay}ms; the flat beat it replaced was 3000ms, so pacing must not exceed it`,
  );
});

test("a short opening is spoken sooner than the flat beat, which is the point of pacing", async () => {
  const delay = await firstPieceDelayMs(SHORT_OPENING, CHAT_PACED_DELIVERY);
  assert.notEqual(delay, null);
  assert.ok(delay! < 2_000, `a one-character opening should not wait the full flat beat, waited ${delay}ms`);
});
