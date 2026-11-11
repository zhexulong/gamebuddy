import assert from "node:assert/strict";
import test from "node:test";

import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import {
  attachNativeCompanionContent,
  NATIVE_BUBBLE_DELIVERY_UNIT,
  NATIVE_BUBBLE_SCAFFOLDING,
  NATIVE_BUBBLE_STAGE_DIRECTION,
  type NativeCompanionContentEvent,
  type NativeCompanionContentSinks,
  type NativeCompanionMessageText,
  type NativeCompanionTurnBubble,
} from "./native-companion-content.js";

/**
 * ONE PROMPT TURN IS ONE BUBBLE, and every assistant text part of that turn is inside it.
 *
 * <p>
 * MEASURED 2026-11-11 (round46b, 15 minutes): 27 prompt turns produced 55 assistant messages and 49 bubbles - one
 * bubble every 13 seconds, 2.04 messages per turn - because every assistant message was presented as a reply of its
 * own. The floor asks for one spoken line per reply, and a reply is one prompt turn, so the two spellings of "reply"
 * were the defect. These cases pin the unit and the property that makes it lossless: the delivered bubble contains
 * every contributing message's text, in the order she said it.
 * </p>
 *
 * <p>
 * MEASURED 2026-11-09 (round40 `multiday_routine`, 34 minutes) is the reason a tool-use message's text is in the
 * bubble at all: 41 of that turn's 60 assistant text parts sat in a message that also carried a tool call and 2 of
 * them reached presentation, while 11 of the 19 that ended a turn did - a companion silent exactly while she works.
 * Delivery is a property of the turn's text parts, never of a message's stop reason.
 * </p>
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
const toolCall = Object.freeze({ type: "toolCall" as const, id: "tool_01", name: "action", arguments: {} });
const assistant = (content: readonly unknown[], stopReason: "stop" | "toolUse") =>
  Object.freeze({ role: "assistant" as const, content, stopReason, responseId: "response-1" });

/** What the player was shown, and what the surface reported about each message's text parts. */
type Recorded = Readonly<{
  sinks: NativeCompanionContentSinks;
  bubbles: readonly string[];
  messages: readonly NativeCompanionMessageText[];
}>;

/**
 * The Game bubble's own sinks: no `onIncrementalText`, because a surface whose unit is the turn has no mid-turn
 * channel to feed - the bubble is the only thing it presents.
 */
function record(): Recorded {
  const bubbles: string[] = [];
  const messages: NativeCompanionMessageText[] = [];
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    onFinalText: async (value: string) => {
      bubbles.push(value);
    },
    onRejected: async (reason) => assert.fail(`unexpected rejection: ${reason}`),
    onMessageText: async (outcome: NativeCompanionMessageText) => {
      messages.push(outcome);
    },
  });
  return { sinks, bubbles, messages };
}

function attachBubble(fx: ReturnType<typeof fakeSession>, sinks: NativeCompanionContentSinks) {
  const observer = attachNativeCompanionContent(fx.session, sinks, {
    deliveryUnit: NATIVE_BUBBLE_DELIVERY_UNIT,
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
 * One assistant message exactly as Pi streams it: a start snapshot, one `text_start` per text part followed by that
 * part's delta, and the message itself at the end. Tool-call parts are what the message carries, never events of
 * their own on this seam.
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

/** The turn's own opening sound, read from the same authority the delivery reads it from. */
function soundOf(turnId = "player_source_1"): string {
  const sound = selectReactionSound(turnId, "zh-CN", GAME_DELIVERY_PACING.reaction!);
  assert.notEqual(sound, null, "this case states the sound as the bubble's head, so it must exist");
  return sound!;
}

test("a turn that also calls tools says everything it said in ONE bubble, in order", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  const sound = soundOf();

  // Three assistant messages: the first two speak and then act (the shape a live run lost), the last one is the
  // answer. One prompt turn produced all three, so the player gets one bubble.
  streamMessage(fx, ["先出门去农场。"], assistant([text("先出门去农场。"), toolCall], "toolUse"));
  streamMessage(
    fx,
    ["种子得先去买。", "回头再浇水。"],
    assistant([text("种子得先去买。"), toolCall, text("回头再浇水。")], "toolUse"),
  );
  streamMessage(fx, ["都弄好了。"], assistant([text("都弄好了。")], "stop"));
  const bubble = observer.deliverTurn();
  await observer.close();

  assert.deepEqual(
    recorded.bubbles,
    [`${sound} 先出门去农场。 种子得先去买。回头再浇水。 都弄好了。`],
    "one delivery, the sound at its head and every message in arrival order",
  );
  // THE PROPERTY, not the string: the bubble contains each contributing message's own text. Keeping only the last
  // message would satisfy a delivery-equals-one-bubble check and fail this one.
  for (const said of ["先出门去农场。", "种子得先去买。", "回头再浇水。", "都弄好了。"])
    assert.ok(recorded.bubbles[0]!.includes(said), `the bubble lost ${JSON.stringify(said)}`);
  assert.deepEqual(bubble, { chars: recorded.bubbles[0]!.length, truncatedChars: 0, sentencesDropped: 0 });
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: null },
    { textParts: 2, suppression: null },
    { textParts: 1, suppression: null },
  ]);
});

test("a turn that answers and then speaks again says both in the same bubble", async () => {
  // MEASURED 2026-11-09 (round44): 5 of 102 turns reported `textParts 2 / presented 1 / suppressed {} / unaccounted 1`,
  // and the lost sentences were ordinary speech - "剧情还在走，等它放完，我再下矿。", "进屋了，靴子一脱就睡…". One observer
  // covers one prompt turn and Pi may end one message with `stopReason: "stop"` and still produce another; a latch set at
  // the first answer silenced every later message.
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);

  streamMessage(
    fx,
    ["剧情还在走，等它放完，我再下矿。"],
    assistant([text("剧情还在走，等它放完，我再下矿。")], "stop"),
  );
  streamMessage(fx, ["进屋了，靴子一脱就睡…"], assistant([text("进屋了，靴子一脱就睡…")], "stop"));
  observer.deliverTurn();
  await observer.close();

  assert.equal(recorded.bubbles.length, 1, `a turn is one bubble; got ${JSON.stringify(recorded.bubbles)}`);
  assert.ok(recorded.bubbles[0]!.includes("剧情还在走，等它放完，我再下矿。"));
  assert.ok(recorded.bubbles[0]!.includes("进屋了，靴子一脱就睡…"));
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: null },
    { textParts: 1, suppression: null },
  ]);
});

test("a part the surface deliberately withholds is named with a countable reason, and is not in the bubble", async () => {
  // `*转过身微笑*` is a stage beat: the bubble cannot draw it, so it dehydrates to nothing. That is a deliberate
  // suppression and it must say so, or the same silence reads as a delivery failure.
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);

  streamMessage(fx, ["   "], assistant([text("   "), toolCall], "toolUse"));
  streamMessage(fx, ["*转过身微笑*"], assistant([text("*转过身微笑*"), toolCall], "toolUse"));
  streamMessage(fx, ["我回来了。"], assistant([text("我回来了。")], "stop"));
  observer.deliverTurn();
  await observer.close();

  assert.deepEqual(recorded.bubbles, [`${soundOf()} 我回来了。`]);
  assert.deepEqual(recorded.messages, [
    { textParts: 1, suppression: "blank_text" },
    { textParts: 1, suppression: "empty_after_projection" },
    { textParts: 1, suppression: null },
  ]);
});

test("a turn that said nothing delivers nothing at all", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);

  streamMessage(fx, ["*转过身微笑*"], assistant([text("*转过身微笑*")], "stop"));
  const bubble = observer.deliverTurn();
  await observer.close();

  assert.deepEqual(recorded.bubbles, [], "a turn with no speakable text has no bubble: absent, never empty");
  assert.equal(bubble, null);
  assert.deepEqual(recorded.messages, [{ textParts: 1, suppression: "empty_after_projection" }]);
});

test("the bubble stops at the last complete sentence that fits, and says what that cost", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  // The first three messages of a real round46b turn, verbatim: 89 characters of speech inside one prompt turn, which
  // one bubble cannot hold.
  const said = [
    "三格宽二十格长，种子还差五十八颗——先去把地方看明白，再盘算钱够不够跑一趟镇上。",
    "先从屋里出去，站到门口才能量出那条长垄的边。",
    "门前这片草和石头还横着呢，等脚踩上去才知道要从哪头下手。",
  ];
  said.forEach((part, index) =>
    streamMessage(fx, [part], assistant([text(part), toolCall], index === said.length - 1 ? "stop" : "toolUse")),
  );
  const bubble = observer.deliverTurn();
  await observer.close();

  const speech = said.join(" ");
  const sound = soundOf();
  const delivered = recorded.bubbles[0]!;
  assert.ok(bubble !== null);
  assert.ok(delivered.length <= GAME_DELIVERY_PACING.lengthBudget!.maxChars, "never wider than the bubble");
  assert.ok(delivered.startsWith(`${sound} `), "the sound is the head of the bubble, spent from the same ceiling");
  const spoken = delivered.slice(sound.length + 1);
  assert.ok(speech.startsWith(spoken), `the bubble is the head of the turn's speech: ${JSON.stringify(delivered)}`);
  assert.ok(spoken.length < speech.length, "this case must actually truncate");
  assert.ok(spoken.endsWith("。"), "the cut lands on a sentence end, never inside one");
  assert.equal(bubble!.truncatedChars, speech.length - spoken.length);
  assert.equal(bubble!.sentencesDropped, said.length - said.filter((part) => spoken.includes(part)).length);
  assert.ok(bubble!.sentencesDropped > 0, "the sentences that did not fit are counted");
});

test("one sentence longer than the ceiling is cut at the ceiling, and the count says no sentence fitted", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  const oneLongSentence = `${"这是一句很长很长的自言自语".repeat(8)}。`;
  streamMessage(fx, [oneLongSentence], assistant([text(oneLongSentence)], "stop"));
  const bubble = observer.deliverTurn();
  await observer.close();

  const sound = soundOf();
  const delivered = recorded.bubbles[0]!;
  assert.ok(bubble !== null);
  assert.equal(delivered.length, GAME_DELIVERY_PACING.lengthBudget!.maxChars);
  assert.equal(
    bubble!.truncatedChars,
    oneLongSentence.length - (GAME_DELIVERY_PACING.lengthBudget!.maxChars - sound.length - 1),
  );
  assert.equal(bubble!.sentencesDropped, 0, "no complete sentence fitted, so none was dropped whole");
  assert.ok(delivered.startsWith(`${sound} `));
});

test("a revoked turn speaks nothing, and one turn cannot deliver twice", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  streamMessage(fx, ["我回来了。"], assistant([text("我回来了。")], "stop"));

  const first = observer.deliverTurn();
  const second = observer.deliverTurn();
  await observer.close();

  assert.notEqual(first, null);
  assert.equal(second, null, "the turn's one bubble was already delivered");
  assert.equal(recorded.bubbles.length, 1);

  const stopped = fakeSession();
  const stoppedRecord = record();
  const stoppedObserver = attachBubble(stopped, stoppedRecord.sinks);
  streamMessage(stopped, ["我回来了。"], assistant([text("我回来了。")], "stop"));
  stoppedObserver.revoke();
  const afterStop = stoppedObserver.deliverTurn();
  await stoppedObserver.close();

  assert.equal(afterStop, null, "a revoked turn is not a turn that spoke");
  assert.deepEqual(stoppedRecord.bubbles, [], "nothing is presented after STOP");
});

test("a provider refusal is a refusal, not a bubble", async () => {
  const fx = fakeSession();
  const recorded = record();
  const rejections: string[] = [];
  const observer = attachBubble(fx, {
    ...recorded.sinks,
    onRejected: async (reason) => {
      rejections.push(reason);
    },
  });
  streamMessage(fx, ["先出门去农场。"], assistant([text("先出门去农场。"), toolCall], "toolUse"));
  const failing = Object.freeze({
    role: "assistant" as const,
    content: [] as unknown[],
    stopReason: "error",
    responseId: "response-1",
    errorMessage: "401: invalid api key",
  });
  fx.emit({ type: "message_start", message: failing });
  fx.emit({ type: "message_end", message: failing });
  const bubble = observer.deliverTurn();
  await observer.close();

  assert.deepEqual(rejections, ["error"]);
  // The refusal withheld the failing message; the turn's earlier sentence is still speech the player has not heard,
  // so the bubble carries it rather than dropping the whole turn on the provider's refusal.
  assert.deepEqual(recorded.bubbles, [`${soundOf()} 先出门去农场。`]);
  assert.notEqual(bubble, null);
});

test("the bubble's parts report stays per message, because the delivery account is measured there", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  streamMessage(fx, ["一。", "二。"], assistant([text("一。"), text("二。")], "stop"));
  observer.deliverTurn();
  await observer.close();

  assert.deepEqual(recorded.messages, [{ textParts: 2, suppression: null }]);
  assert.equal(recorded.bubbles.length, 1);
  assert.deepEqual(recorded.bubbles[0], `${soundOf()} 一。二。`);
});

/** The type this file also pins: `deliverTurn` reports the bubble, and nothing else. */
const bubbleType: NativeCompanionTurnBubble = Object.freeze({ chars: 0, truncatedChars: 0, sentencesDropped: 0 });
assert.equal(bubbleType.chars, 0);
