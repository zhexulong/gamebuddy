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
 * The pacing mechanisms only matter if they reach the text a player actually
 * sees. These cases drive the real observer through a real assistant message
 * lifecycle - the same event shape `native-companion-content.test.ts` uses,
 * including the `partial` lineage Pi carries on each streaming update - and
 * assert what lands in the sinks.
 *
 * The off case is the promise that turning the switch off changes nothing, so it
 * is asserted as strictly as the on case.
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

function assistant(content: readonly unknown[], responseId = "response-1") {
  return Object.freeze({
    role: "assistant" as const,
    content,
    stopReason: "stop",
    responseId,
  });
}

async function drain(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Collects every piece the player would see, in order, plus the committed reply. */
function recordingSinks() {
  const pieces: string[] = [];
  const finals: string[] = [];
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    onIncrementalText: async (value: string) => {
      pieces.push(value);
    },
    onFinalText: async (value: string) => {
      finals.push(value);
    },
    onRejected: async () => undefined,
  });
  return { sinks, pieces, finals };
}

/**
 * Streams one reply through the observer the way Pi does: a start snapshot, a
 * `text_start` announcing the block, one `text_delta` carrying the text, then
 * the final message.
 */
async function streamReply(
  fx: ReturnType<typeof fakeSession>,
  reply: string,
  options: Readonly<{
    pacing?: typeof CHAT_PACED_DELIVERY | null;
    turn?: Readonly<{ id: string; locale: string }>;
  }>,
): Promise<Readonly<{ pieces: readonly string[]; finals: readonly string[] }>> {
  const { sinks, pieces, finals } = recordingSinks();
  const observer = attachNativeCompanionContent(fx.session, sinks, {
    stageDirection: CHAT_TRANSCRIPT_STAGE_DIRECTION,
    scaffolding: CHAT_TRANSCRIPT_SCAFFOLDING,
    ...options,
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
  return Object.freeze({ pieces, finals });
}

test("with pacing off, the whole reply arrives once and no piece is emitted early", async () => {
  const { pieces, finals } = await streamReply(fakeSession(), "种子买好了。地也松了。", {});
  assert.deepEqual(pieces, []);
  assert.deepEqual(finals, ["种子买好了。地也松了。"]);
});

test("with pacing on, a short sound is heard before the words it introduces", async () => {
  const { pieces, finals } = await streamReply(fakeSession(), "我先去看看东边那片。", {
    pacing: CHAT_PACED_DELIVERY,
    turn: { id: "turn_source_event_01", locale: "zh" },
  });
  assert.ok(pieces.length > 0, "a paced surface emits at least one incremental piece");
  const sound = pieces[0]!;
  assert.ok(sound.length <= 4, `first piece ${JSON.stringify(sound)} is a sound, not a sentence`);
  for (const claim of ["好", "完成", "搞定", "done", "ok"]) assert.ok(!sound.toLowerCase().includes(claim));
  assert.ok(finals.length === 1);
});

test("pacing loses no text: the pieces plus the committed reply carry the whole answer", async () => {
  const reply = "东边那片翻完了。西边还剩两畦。我下午接着干。";
  const { pieces, finals } = await streamReply(fakeSession(), reply, {
    pacing: CHAT_PACED_DELIVERY,
    turn: { id: "turn_source_event_03", locale: "zh" },
  });
  const spoken = [...pieces, ...finals].join("").replace(/[\s\n\r]/gu, "");
  const expected = reply.replace(/[\s\n\r]/gu, "");
  // At most a sound may precede it; nothing may be dropped.
  const soundPrefix = spoken.endsWith(expected) ? spoken.slice(0, spoken.length - expected.length) : spoken;
  assert.ok(spoken.includes(expected), `text lost: pieces=${JSON.stringify(pieces)} finals=${JSON.stringify(finals)}`);
  assert.ok(soundPrefix.length <= 4, `only a sound may precede the reply, saw ${JSON.stringify(soundPrefix)}`);
});

test("a language with no reaction vocabulary says nothing, and the reply still arrives", async () => {
  const { pieces, finals } = await streamReply(fakeSession(), "水浇完了。", {
    pacing: GAME_DELIVERY_PACING,
    turn: { id: "turn_source_event_02", locale: "xx" },
  });
  assert.equal(finals.length, 1);
  assert.ok(!pieces.some((piece) => piece.length <= 4 && /[。！]/u.test(piece)), "no sound for an unknown language");
});
