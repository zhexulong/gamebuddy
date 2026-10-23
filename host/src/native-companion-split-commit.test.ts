import assert from "node:assert/strict";
import test from "node:test";

import { CHAT_PACED_DELIVERY, GAME_DELIVERY_PACING } from "./companion-delivery-pacing.js";
import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_SCAFFOLDING,
  CHAT_TRANSCRIPT_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
  type NativeCompanionContentSinks,
} from "./native-companion-content.js";

/**
 * The Chat transcript commits ONCE, in `onFinalText` - that callback is the
 * durable row. The length budget exists to keep a glanceable bubble short, and
 * it delivers a split reply by handing the earlier pieces to
 * `onIncrementalText` (volatile, order only) and the LAST piece to
 * `onFinalText`. On a surface whose final text IS the record, that makes the
 * durable row the last piece and silently truncates everything before it.
 *
 * A game bubble is a separate item each time, so split pieces there are
 * coherent. A transcript row is one message, so a length budget on Chat can only
 * lose text. That is why the Chat policy carries no budget, and this file proves
 * the consequence: a long Chat reply commits whole.
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

async function drain(times = 10): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** 142 characters: longer than any per-bubble budget, short enough to read in the failure message. */
const LONG_REPLY = [
  "东边那片地今天翻完了，土也比昨天松。",
  "西边的两畦还湿着，得等日头再晒一晒，别急着踩。",
  "种子我数过了，够撒三行还有余，剩下的收进谷仓的木箱里。",
  "稻草人歪了，下午顺手扶一下，不然鸟来得更勤。",
  "篱笆东头有根桩子松了，改天钉一钉，免得牛羊钻进来。",
  "你要是累了就先回去歇着，烧壶水，这点活我自己收尾就行。",
].join("");

async function deliver(
  pacing: typeof CHAT_PACED_DELIVERY | typeof GAME_DELIVERY_PACING,
  reply: string,
): Promise<Readonly<{ pieces: readonly string[]; committed: readonly string[] }>> {
  const fx = fakeSession();
  const pieces: string[] = [];
  const committed: string[] = [];
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value: string) => {
      pieces.push(value);
    },
    onFinalText: async (value: string) => {
      committed.push(value);
    },
    onRejected: async (reason: string) => {
      committed.push(`REJECTED:${reason}`);
    },
  });
  const observer = attachNativeCompanionContent(fx.session, sinks, {
    stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,
    scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,
    pacing,
    turn: { id: "turn_split_commit_01", locale: "zh" },
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
    message: assistant([text(reply)]),
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply, partial },
  });
  await drain();
  fx.emit({ type: "message_end", message: assistant([text(reply)]) });
  await drain();
  await observer.close();
  return Object.freeze({ pieces, committed });
}

const squash = (value: string) => value.replace(/[\s\n\r]/gu, "");

test("a long Chat reply commits whole, not just its tail", async () => {
  const { committed } = await deliver(CHAT_PACED_DELIVERY, LONG_REPLY);
  assert.equal(
    committed.length,
    1,
    `the durable commit happens exactly once, saw ${JSON.stringify(committed).slice(0, 120)}`,
  );
  const row = squash(committed[0]!);
  assert.ok(
    row.includes(squash(LONG_REPLY)),
    `the durable row must hold the whole reply (${squash(LONG_REPLY).length} chars), it held ${row.length}`,
  );
});

test("the Chat policy carries no length budget, because one row is one message", () => {
  assert.equal(CHAT_PACED_DELIVERY.lengthBudget, null);
  assert.notEqual(GAME_DELIVERY_PACING.lengthBudget, null, "a bubble still gets a budget");
});

test("a paced Chat turn still emits its sound, so removing the budget did not remove the pacing", async () => {
  const { pieces } = await deliver(CHAT_PACED_DELIVERY, LONG_REPLY);
  assert.ok(pieces.length > 0, "a paced turn says something before it finishes");
  assert.ok(pieces[0]!.length <= 4, `the first piece is a sound: ${JSON.stringify(pieces[0])}`);
});
