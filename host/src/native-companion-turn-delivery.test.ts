import assert from "node:assert/strict";
import test from "node:test";

import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import {
  attachNativeCompanionContent,
  NATIVE_BUBBLE_SCAFFOLDING,
  NATIVE_BUBBLE_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
  type NativeCompanionContentSinks,
  type NativeCompanionMessageText,
} from "./native-companion-content.js";

/**
 * Every assistant text part of a turn reaches the player, in arrival order.
 *
 * MEASURED 2026-11-09 (round40 `multiday_routine`, 34 minutes): the session recorded 60 assistant
 * text parts (1 943 chars) and the runner recorded 31 presented pieces (716 chars). 41 of the 60
 * parts sat in a message that also carried a tool call and 2 of those reached presentation, while
 * 11 of the 19 that ended a turn did - a companion who is silent exactly while she works. The rule
 * that produced it is named in `native-companion-content.ts`: a tool-use message released at most
 * ONE working remark per turn, taken from its first sentence only.
 *
 * These cases pin delivery as a property of the turn's own text parts, not of the message's stop
 * reason: what the player hears may not depend on whether the companion was also acting.
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
/** Two microtask turns: `dispatch` serializes the sink callbacks on a promise chain. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}
const toolCall = Object.freeze({ type: "toolCall" as const, id: "tool_01", name: "action", arguments: {} });
const assistant = (content: readonly unknown[], stopReason: "stop" | "toolUse") =>
  Object.freeze({ role: "assistant" as const, content, stopReason, responseId: "response-1" });

/** What the player was shown, and what the surface reported about each message's text parts. */
type Recorded = Readonly<{
  sinks: NativeCompanionContentSinks;
  pieces: readonly { at: number; piece: string }[];
  messages: readonly NativeCompanionMessageText[];
}>;

function record({ incremental }: Readonly<{ incremental: boolean }>): Recorded {
  const pieces: { at: number; piece: string }[] = [];
  const messages: NativeCompanionMessageText[] = [];
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    ...(incremental
      ? {
          onIncrementalText: async (piece: string) => {
            pieces.push({ at: Date.now(), piece });
          },
        }
      : {}),
    onFinalText: async (value: string) => {
      pieces.push({ at: Date.now(), piece: value });
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
    onMessageText: async (outcome: NativeCompanionMessageText) => {
      messages.push(outcome);
    },
  });
  return { sinks, pieces, messages };
}

function attachGame(fx: ReturnType<typeof fakeSession>, sinks: NativeCompanionContentSinks) {
  const observer = attachNativeCompanionContent(fx.session, sinks, {
    stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,
    scaffolding: NATIVE_BUBBLE_SCAFFOLDING,
    pacing: GAME_DELIVERY_PACING,
    turn: { id: "player_source_1", locale: "zh-CN" },
  });
  observer.open();
  observer.openPreviews();
  return observer;
}

/**
 * One assistant message exactly as Pi streams it: a start snapshot, one `text_start` per text part
 * followed by that part's delta, and the message itself at the end. Tool-call parts are what the
 * message carries, never events of their own on this seam.
 */
function streamMessage(
  fx: ReturnType<typeof fakeSession>,
  parts: readonly string[],
  final: ReturnType<typeof assistant>,
): void {
  const start = assistant([], final.stopReason === "stop" ? "stop" : "toolUse");
  fx.emit({ type: "message_start", message: start });
  parts.forEach((part, index) => {
    fx.emit({
      type: "message_update",
      message: start,
      assistantMessageEvent: { type: "text_start", contentIndex: index, partial: start },
    });
    fx.emit({
      type: "message_update",
      message: start,
      assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: part, partial: start },
    });
  });
  fx.emit({ type: "message_end", message: final });
}

/**
 * The words, without the turn's opening interjection. The sound comes from the same authority the
 * delivery uses, so this filters by identity instead of spelling the vocabulary again.
 */
function words(pieces: Readonly<{ piece: string }[]>): readonly string[] {
  const sound = selectReactionSound("player_source_1", "zh-CN", GAME_DELIVERY_PACING.reaction!);
  return pieces.map((entry) => entry.piece).filter((piece) => piece !== sound);
}

test("a turn that also calls tools delivers every one of its text parts, in order", async () => {
  const fx = fakeSession();
  const recorded = record({ incremental: true });
  const observer = attachGame(fx, recorded.sinks);

  // Three assistant messages: the first two speak and then act (the shape the live run lost), the
  // last one is the answer.
  streamMessage(fx, ["先出门去农场。"], assistant([text("先出门去农场。"), toolCall], "toolUse"));
  streamMessage(
    fx,
    ["种子得先去买。", "回头再浇水。"],
    assistant([text("种子得先去买。"), toolCall, text("回头再浇水。")], "toolUse"),
  );
  streamMessage(fx, ["都弄好了。"], assistant([text("都弄好了。")], "stop"));
  await observer.close();

  const spoken = words(recorded.pieces);
  // Every part of every message, in the order she said it. The two parts of the middle message are
  // one utterance, because a message's parts are one message's speech.
  assert.deepEqual(spoken, ["先出门去农场。", "种子得先去买。回头再浇水。", "都弄好了。"]);
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: null },
    { textParts: 2, suppression: null },
    { textParts: 1, suppression: null },
  ]);
});

test("a turn that answers and then speaks again delivers both messages, not only the first", async () => {
  // MEASURED 2026-11-09 (round44): 5 of 102 turns reported `textParts 2 / presented 1 / suppressed {} /
  // unaccounted 1`, and the lost sentences were ordinary speech - "剧情还在走，等它放完，我再下矿。",
  // "进屋了，靴子一脱就睡…". One observer covers one prompt turn and Pi may end one message with
  // `stopReason: "stop"` and still produce another; a latch set at the first answer silenced every later
  // message while `companion-loop.ts` kept counting its parts as produced.
  const fx = fakeSession();
  const recorded = record({ incremental: true });
  const observer = attachGame(fx, recorded.sinks);

  streamMessage(
    fx,
    ["剧情还在走，等它放完，我再下矿。"],
    assistant([text("剧情还在走，等它放完，我再下矿。")], "stop"),
  );
  streamMessage(fx, ["进屋了，靴子一脱就睡…"], assistant([text("进屋了，靴子一脱就睡…")], "stop"));
  await observer.close();

  assert.deepEqual(words(recorded.pieces), ["剧情还在走，等它放完，我再下矿。", "进屋了，靴子一脱就睡…"]);
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: null },
    { textParts: 1, suppression: null },
  ]);
});

test("a message whose only sentence already left as the working remark still reports its part as presented", async (t) => {
  // The delivery identity is `presented + suppressed === produced`, so a part that reached the player must be counted
  // as presented even when nothing is left to commit at `message_end`. The remark IS that message's text: reporting
  // nothing here would file a spoken part under no population and fail the turn for a sentence the player heard.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fx = fakeSession();
  const recorded = record({ incremental: true });
  const observer = attachGame(fx, recorded.sinks);
  const start = assistant([], "toolUse");
  fx.emit({ type: "message_start", message: start });
  fx.emit({
    type: "message_update",
    message: start,
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: start },
  });
  fx.emit({
    type: "message_update",
    message: start,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "先出门去农场。", partial: start },
  });
  t.mock.timers.tick(3_000);
  await flushMicrotasks();
  fx.emit({ type: "message_end", message: assistant([text("先出门去农场。"), toolCall], "toolUse") });
  await observer.close();

  assert.deepEqual(words(recorded.pieces), ["先出门去农场。"]);
  assert.deepEqual(recorded.messages, [{ textParts: 1, suppression: null }]);
});

test("a turn that only speaks still delivers its text (the case that works must not regress)", async () => {
  const fx = fakeSession();
  const recorded = record({ incremental: true });
  const observer = attachGame(fx, recorded.sinks);
  streamMessage(fx, ["今天先把东头清了。"], assistant([text("今天先把东头清了。")], "stop"));
  await observer.close();

  assert.deepEqual(words(recorded.pieces), ["今天先把东头清了。"]);
  assert.deepEqual(recorded.messages, [{ textParts: 1, suppression: null }]);
});

test("a part the surface deliberately withholds is named with a countable reason", async (t) => {
  // `*转过身微笑*` is a stage beat: the bubble cannot draw it, so it dehydrates to nothing. That is
  // a deliberate suppression and it must say so, or the same silence reads as a delivery failure.
  const fx = fakeSession();
  const recorded = record({ incremental: true });
  const observer = attachGame(fx, recorded.sinks);
  streamMessage(fx, ["   "], assistant([text("   "), toolCall], "toolUse"));
  streamMessage(fx, ["*转过身微笑*"], assistant([text("*转过身微笑*"), toolCall], "toolUse"));
  streamMessage(fx, ["我回来了。"], assistant([text("我回来了。")], "stop"));
  await observer.close();

  assert.deepEqual(words(recorded.pieces), ["我回来了。"]);
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: "blank_text" },
    { textParts: 1, suppression: "empty_after_projection" },
    { textParts: 1, suppression: null },
  ]);
  t.diagnostic(
    `examined 3 text parts, delivered 1, suppressed ${JSON.stringify(recorded.messages.filter((m) => m.suppression !== null))}`,
  );
});

test("a message whose text never streamed is named, not silently replaced by nothing", async (t) => {
  // The paragraph is built from the delta stream. A provider message that carries text but streams
  // no delta therefore reaches no piece; naming that is the difference between a measured loss and
  // a silence nobody can account for.
  const fx = fakeSession();
  const recorded = record({ incremental: true });
  const observer = attachGame(fx, recorded.sinks);
  const start = assistant([], "toolUse");
  fx.emit({ type: "message_start", message: start });
  fx.emit({ type: "message_end", message: assistant([text("我在门口了。"), toolCall], "toolUse") });
  await observer.close();

  assert.deepEqual(words(recorded.pieces), []);
  assert.deepEqual(recorded.messages, [{ textParts: 1, suppression: "unstreamed_text" }]);
  t.diagnostic(`examined 1 text part, delivered 0, suppressed ${JSON.stringify(recorded.messages)}`);
});

test("the Chat lane names the intermediate message it cannot show through its single-shot contract", async () => {
  // Chat's observer has no mid-message channel and its durable row is written elsewhere, so an
  // intermediate message stays out of the transcript's presentation. It is still a withheld part
  // and it is still named.
  const fx = fakeSession();
  const recorded = record({ incremental: false });
  const observer = attachGame(fx, recorded.sinks);
  streamMessage(fx, ["先出门去农场。"], assistant([text("先出门去农场。"), toolCall], "toolUse"));
  streamMessage(fx, ["都弄好了。"], assistant([text("都弄好了。")], "stop"));
  await observer.close();

  assert.deepEqual(words(recorded.pieces), ["都弄好了。"]);
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: "intermediate_message" },
    { textParts: 1, suppression: null },
  ]);
});
