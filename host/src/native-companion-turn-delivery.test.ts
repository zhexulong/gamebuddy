import assert from "node:assert/strict";
import test from "node:test";

import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import { MAX_COMPANION_PRESENTATION_TEXT_CHARS } from "./companion-presentation-transport.js";
import { CompanionLoop, NO_PRESENTATION_LEASE, SILENT_TERMINATOR, silentTerminatorReason } from "./companion-loop.js";
import { FACT_PRODUCER, TURN_OPENINGS } from "./event-pump.js";
import {
  attachNativeCompanionContent,
  CHAT_TRANSCRIPT_DELIVERY_UNIT,
  isSilenceOnly,
  NATIVE_BUBBLE_DELIVERY_UNIT,
  NATIVE_BUBBLE_SCAFFOLDING,
  NATIVE_BUBBLE_STAGE_DIRECTION,
  NATIVE_COMPANION_PART_SUPPRESSIONS,
  PUNCTUATION_ONLY,
  punctuationOnlyReason,
  SILENCE_MARKERS,
  TURN_WITHHELD,
  TURN_WITHHELD_REASONS,
  type NativeCompanionContentEvent,
  type NativeCompanionContentSinks,
  type NativeCompanionMessageText,
  type NativeCompanionTurnBubble,
  type NativeCompanionTurnDelivery,
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

/**
 * The bubble one delivery committed, or a failure that names what withheld it.
 *
 * Every case below goes through this rather than through a `null` check: a withholding is a named answer now, and a
test that read it as "no bubble" would be the same collapse this seam exists to remove.
 */
function deliveredBubble(delivery: NativeCompanionTurnDelivery): NativeCompanionTurnBubble {
  if (delivery.delivered === 0) assert.fail(`the turn withheld its one bubble: ${delivery.reason}`);
  return delivery.bubble;
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
  const bubble = deliveredBubble(observer.deliverTurn());
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
  assert.deepEqual(
    bubble,
    { delivered: 0, reason: TURN_WITHHELD.nothingToSay },
    "a turn that said nothing still ENDED, and its answer names that",
  );
  assert.deepEqual(recorded.messages, [{ textParts: 1, suppression: "empty_after_projection" }]);
});

test("a 108-character turn arrives whole: nothing below the transport is cut", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  // The first three messages of a real round46b turn, verbatim, with the middle one carried a clause further: 108
  // characters of speech inside one prompt turn. The delivery used to cut this at 80 (77 with the sound) and delete the
  // tail that the chat line keeps for scroll-back; the transport carries 4,000 and the bubble clamps itself on screen.
  const said = [
    "三格宽二十格长，种子还差五十八颗——先去把地方看明白，再盘算钱够不够跑一趟镇上。",
    "先从屋里出去，站到门口才能量出那条长垄的边，顺手看看门前那条水渠到底通不通。",
    "门前这片草和石头还横着呢，等脚踩上去才知道要从哪头下手。",
  ];
  const speech = said.join(" ");
  // The premise the case names, checked rather than assumed: this is the length the old ceiling could not carry.
  assert.equal(speech.length, 108, "this case is the 108-character turn; the fixture must still be one");
  said.forEach((part, index) =>
    streamMessage(fx, [part], assistant([text(part), toolCall], index === said.length - 1 ? "stop" : "toolUse")),
  );
  const bubble = deliveredBubble(observer.deliverTurn());
  await observer.close();

  const delivered = recorded.bubbles[0]!;
  assert.deepEqual(recorded.bubbles, [`${soundOf()} ${speech}`], "the turn reaches the line exactly as she said it");
  assert.equal(
    bubble.truncatedChars,
    0,
    "the bubble's own clamp is the Mod's, and it is not a loss this delivery took",
  );
  assert.equal(bubble.sentencesDropped, 0);
  assert.equal(bubble.chars, delivered.length);
  assert.ok(delivered.length <= MAX_COMPANION_PRESENTATION_TEXT_CHARS, "and it is inside what the wire carries");
});

test("a turn past the transport's ceiling is cut there, and the bubble's own record names the loss", async () => {
  const fx = fakeSession();
  const recorded = record();
  const observer = attachBubble(fx, recorded.sinks);
  // One sentence longer than the ceiling: no sentence boundary for the cut to stop at, so it lands on the character
  // ceiling itself. The bound is the transport's declaration, never a number typed here.
  const oneLongSentence = `${"这".repeat(MAX_COMPANION_PRESENTATION_TEXT_CHARS)}。`;
  streamMessage(fx, [oneLongSentence], assistant([text(oneLongSentence)], "stop"));
  const bubble = deliveredBubble(observer.deliverTurn());
  await observer.close();

  const sound = soundOf();
  const delivered = recorded.bubbles[0]!;
  assert.equal(delivered.length, MAX_COMPANION_PRESENTATION_TEXT_CHARS, "cut at the wire's own bound, not below it");
  assert.equal(
    bubble.truncatedChars,
    oneLongSentence.length - (MAX_COMPANION_PRESENTATION_TEXT_CHARS - sound.length - 1),
    "the characters the wire refused are counted on the record the caller reads",
  );
  assert.ok(bubble.truncatedChars > 0, "this case must actually truncate, or the naming is never exercised");
  assert.equal(bubble.sentencesDropped, 0, "no complete sentence fitted, so none was dropped whole");
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

  assert.equal(first.delivered, 1, "the turn's first and only bubble left");
  assert.deepEqual(
    second,
    { delivered: 0, reason: TURN_WITHHELD.alreadyDelivered },
    "the turn's one bubble was already delivered, and the answer says which way it ended",
  );
  assert.equal(recorded.bubbles.length, 1);

  const stopped = fakeSession();
  const stoppedRecord = record();
  const stoppedObserver = attachBubble(stopped, stoppedRecord.sinks);
  streamMessage(stopped, ["我回来了。"], assistant([text("我回来了。")], "stop"));
  stoppedObserver.revoke();
  const afterStop = stoppedObserver.deliverTurn();
  await stoppedObserver.close();

  assert.deepEqual(
    afterStop,
    { delivered: 0, reason: TURN_WITHHELD.stopped },
    "a revoked turn is not a turn that spoke",
  );
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
  assert.equal(bubble.delivered, 1);
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

/**
 * ONE DELIVERY ANSWER PER TURN, AND EVERY ANSWER NAMES WHERE IT WENT.
 *
 * <p>
 * The population is EVERY delivery result the pipeline can produce: each member of the projection's closed
 * withhold list (`TURN_WITHHELD_REASONS`), the loop's own `no_presentation_lease` - the case `round64` recorded as a
 * bubble the player never saw - and one ordinary turn that delivers. Each is driven through the real pipeline: the
 * observer for the projection's own answers, the loop and its pump for the two the pipeline composes.
 * </p>
 * <p>
 * The property is that a delivery RESULT, never an absence. A turn that ends with nothing to present has ended, and the
 * caller must be able to read that as a named answer. `deliverTurn` answered `null` for five different situations, and a
 * caller awaiting a bubble had nothing to switch on - the shape in which a turn withholds all its text and nobody can
 * tell it apart from a turn still waiting.
 * </p>
 * <p>
 * A reason the closed list grows without a case here is a failure too: the coverage assertion is derived from the list, so
 * a new member cannot arrive unexamined.
 * </p>
 */
type DeliveryObservation = Readonly<{
  site: string;
  /** The delivery answer as the pipeline produced it, untyped on purpose: this checker must not trust its shape. */
  answer: unknown;
  /** Did the turn itself settle? A delivery inside a turn that never ended is not a delivery. */
  settled: boolean;
  /** How many bubbles the presentation sink actually received, when the case can read it. */
  presented?: number;
}>;

/** The names a withheld delivery may carry: the projection's closed list, plus the loop's own no-lease member. */
const NAMED_WITHHOLDINGS: readonly string[] = Object.freeze([...TURN_WITHHELD_REASONS, NO_PRESENTATION_LEASE]);

function tallyDeliveries(observations: readonly DeliveryObservation[]): Readonly<{
  delivered: number;
  withheld: number;
  hung: number;
  findings: readonly string[];
  line: string;
}> {
  const findings: string[] = [];
  const examined: string[] = [];
  let delivered = 0;
  let withheld = 0;
  let hung = 0;
  for (const observation of observations) {
    if (!observation.settled) {
      hung += 1;
      findings.push(`turn_withheld_entirely_never_settles:${observation.site}:the_turn_never_settled`);
      continue;
    }
    const answer = observation.answer;
    const read = typeof answer === "object" && answer !== null ? (answer as Record<string, unknown>) : undefined;
    const count = read?.delivered;
    const reason = read?.reason;
    if (count === 1) {
      delivered += 1;
      continue;
    }
    if (count === 0 && typeof reason === "string" && NAMED_WITHHOLDINGS.includes(reason)) {
      withheld += 1;
      examined.push(reason);
      continue;
    }
    // Neither a bubble nor a name: the answer a caller cannot act on, which is the hang in its first form.
    hung += 1;
    findings.push(
      `turn_withheld_entirely_never_settles:${observation.site}:delivery_names_nothing:${JSON.stringify(answer)}`,
    );
  }
  return Object.freeze({
    delivered,
    withheld,
    hung,
    findings: Object.freeze(findings),
    line: `deliveries examined ${String(observations.length)} · delivered ${String(delivered)} · withheld-named ${String(withheld)} · hung ${String(hung)} · examined reasons {${[...new Set(examined)].sort().join(", ")}}`,
  });
}

/** One assistant message read the way Pi streams it: start, one text part per delta, then the message itself. */
function streamSaid(emit: (event: NativeCompanionContentEvent) => void, said: readonly string[]): void {
  const start = assistant([], "stop");
  emit({ type: "message_start", message: start });
  said.forEach((part, index) => {
    emit({
      type: "message_update",
      message: start,
      assistantMessageEvent: { type: "text_start", contentIndex: index, partial: start },
    });
    emit({
      type: "message_update",
      message: start,
      assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: part, partial: start },
    });
  });
  emit({
    type: "message_end",
    message: assistant(
      said.map((part) => text(part)),
      "stop",
    ),
  });
}

/** A session that consumes one batch, streams the exact text it was given, and settles - the loop's real seam. */
function turnSession(said: readonly string[]) {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    session: Object.freeze({
      async sendUserMessage(batch: string): Promise<void> {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
        streamSaid((event) => emit(event), said);
        emit({ type: "agent_settled", aborted: false });
      },
      async abort(): Promise<void> {},
      clearQueue(): void {},
      async waitForIdle(): Promise<void> {},
      subscribe(listener: (event: unknown) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    }),
  };
}

test("turn_withheld_entirely_never_settles: every delivery names what reached the player or why nothing did", async () => {
  const observations: DeliveryObservation[] = [];

  // THE PROJECTION'S OWN ANSWERS, each driven through the observer that produces it.
  const delivered = fakeSession();
  const deliveredRecord = record();
  const deliveredObserver = attachBubble(delivered, deliveredRecord.sinks);
  streamSaid(delivered.emit, ["我回来了。"]);
  const oneBubble = deliveredObserver.deliverTurn();
  const repeated = deliveredObserver.deliverTurn();
  await deliveredObserver.close();
  observations.push({ site: "one_paragraph", answer: oneBubble, settled: true });
  observations.push({ site: "already_delivered", answer: repeated, settled: true });

  const silent = fakeSession();
  const silentRecord = record();
  const silentObserver = attachBubble(silent, silentRecord.sinks);
  streamSaid(silent.emit, ["*转过身微笑*"]);
  const allWithheld = silentObserver.deliverTurn();
  await silentObserver.close();
  observations.push({ site: "nothing_to_say", answer: allWithheld, settled: true });

  const stopped = fakeSession();
  const stoppedRecord = record();
  const stoppedObserver = attachBubble(stopped, stoppedRecord.sinks);
  streamSaid(stopped.emit, ["我回来了。"]);
  stoppedObserver.revoke();
  const afterStop = stoppedObserver.deliverTurn();
  await stoppedObserver.close();
  observations.push({ site: "stopped", answer: afterStop, settled: true });

  // A surface whose unit is the message owes no turn bubble, and says so instead of answering nothing.
  const messageUnitSession = fakeSession();
  const messageUnitRecord = record();
  const messageUnitObserver = attachNativeCompanionContent(messageUnitSession.session, messageUnitRecord.sinks, {
    deliveryUnit: CHAT_TRANSCRIPT_DELIVERY_UNIT,
    stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,
    scaffolding: NATIVE_BUBBLE_SCAFFOLDING,
    pacing: GAME_DELIVERY_PACING,
    turn: { id: "player_source_1", locale: "zh-CN" },
  });
  messageUnitObserver.open();
  const messageUnitAnswer = messageUnitObserver.deliverTurn();
  await messageUnitObserver.close();
  observations.push({ site: "message_unit", answer: messageUnitAnswer, settled: true });

  // THE PIPELINE'S OWN ANSWERS: the loop composes the delivery for every turn it runs, and the pump must open the next
  // turn after a withheld one. A hang here is the defect: the first turn never settles, so no later turn is ever owed.
  const pumpAfter = async (
    site: "all_withheld" | "no_lease" | "spoken",
    said: readonly string[],
    opener: (loop: CompanionLoop) => void,
  ): Promise<DeliveryObservation> => {
    const presented: string[] = [];
    const loop = new CompanionLoop(turnSession(said).session as never, {
      beginPlayerBatch(): void {},
      endBatch(): void {},
      async presentNativeAssistantContent(content): Promise<void> {
        if (content.text.length > 0) presented.push(content.text);
      },
    });
    opener(loop);
    const settled = await Promise.race([
      loop.flush().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    const answer = loop.lastTurnDelivery;
    // THE NEXT TURN. A withheld delivery that leaves the pump holding the turn is the hang this gate exists for.
    loop.pump.enqueueFact(
      {
        source: "stardew_mod",
        kind: "semantic_event",
        eventId: "after_withheld",
        sourceEventId: "after_withheld",
        correlationId: "after_withheld",
        revision: 9,
        occurredAtMs: 9,
        payload: { kind: "day_started", day: 3 },
      },
      FACT_PRODUCER.adapterIngress,
    );
    const nextOpened = await Promise.race([
      loop.flush().then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000)),
    ]);
    assert.ok(nextOpened, "the turn after a withheld one must still be owed and delivered");
    return Object.freeze({ site: site, answer, settled, presented: presented.length });
  };
  observations.push(
    await pumpAfter("all_withheld", ["*转过身微笑*"], function player_input(loop) {
      loop.pump.enqueuePlayerInput({
        source: "player_text",
        inputId: "input_withheld",
        eventId: "player_source_withheld",
        locale: "zh-CN",
        text: "在吗？",
        timestampMs: 1,
      });
    }),
  );
  // A turn opened by a world fact that opens NO presentation lease - the shape `round64` recorded as a bubble nobody saw.
  // The loop has no projection to ask, so it is the loop that must name the withholding.
  observations.push(
    await pumpAfter("no_lease", ["我回来了。"], function world_fact(loop) {
      loop.pump.enqueueFact(
        {
          source: "stardew_mod",
          kind: "semantic_event",
          eventId: "no_lease_event",
          sourceEventId: "no_lease_event",
          correlationId: "no_lease_event",
          revision: 2,
          occurredAtMs: 2,
          payload: { kind: "warped" },
        },
        FACT_PRODUCER.adapterIngress,
      );
    }),
  );
  observations.push(
    await pumpAfter("spoken", ["我回来了。"], function player_input(loop) {
      loop.pump.enqueuePlayerInput({
        source: "player_text",
        inputId: "input_spoken",
        eventId: "player_source_spoken",
        locale: "zh-CN",
        text: "在吗？",
        timestampMs: 1,
      });
    }),
  );

  const tallied = tallyDeliveries(observations);
  process.stdout.write(`\n${tallied.line}\n`);
  // H FIRST, SO A FAILURE NAMES THE SITE THAT HUNG rather than only the coverage gap it left behind.
  assert.deepEqual(tallied.findings, [], `every delivery must settle and name its answer: ${tallied.line}`);
  assert.equal(tallied.hung, 0, tallied.line);
  // THE ANSWER AND THE SINK ARE READ TOGETHER: `delivered: 1` that never reached `onFinalText` would name something that
  // did not happen, and `delivered: 0` that still presented would be a bubble nobody accounted for.
  for (const observation of observations) {
    if (observation.presented === undefined) continue;
    const answer = typeof observation.answer === "object" && observation.answer !== null ? observation.answer : {};
    const counted = (answer as { delivered?: unknown }).delivered === 1 ? 1 : 0;
    assert.equal(
      observation.presented,
      counted,
      `${observation.site}: the delivery answer and the presentation sink disagree`,
    );
  }
  // THE POPULATION IS THE AUTHORITY: every member of the closed lists must have been driven, so this gate cannot pass by
  // examining a subset somebody remembered.
  const examined = new Set(
    observations
      .map((observation) => observation.answer)
      .filter(
        (answer): answer is { delivered: 0; reason: string } =>
          typeof answer === "object" && answer !== null && (answer as { reason?: unknown }).reason !== undefined,
      )
      .map((answer) => answer.reason),
  );
  assert.deepEqual(
    [...examined].sort(),
    [...NAMED_WITHHOLDINGS].sort(),
    "every name a withheld delivery can carry must be driven here, derived from the closed lists",
  );
  assert.ok(tallied.delivered >= 2, `${tallied.line}: a delivered turn must be in the population`);

  // THE FALSIFIER, run against the same checker: an answer with no name and an answer that never settled both read as
  // hung, which is what the pre-change `null` was.
  const falsifier = tallyDeliveries([
    { site: "synthetic_null", answer: null, settled: true },
    { site: "synthetic_unnamed", answer: { delivered: 0 }, settled: true },
    { site: "synthetic_hang", answer: { delivered: 0, reason: TURN_WITHHELD.nothingToSay }, settled: false },
  ]);
  assert.equal(falsifier.hung, 3, `the checker must call all three nameless answers hung: ${falsifier.line}`);
  assert.equal(falsifier.withheld, 0);
});

/**
 * A BUBBLE IS A THING SAID, and the two halves of that sentence are measured here together.
 *
 * <p>
 * MEASURED 2026-11-19 (`round79`): one turn carried one real line and THREE deliveries of `chars 5 / 5 / 2`, every one of
 * them ellipses - and the owner's reading of it was exact: "… is almost everything she says". The delivery had no way to
 * end a turn without speaking, so a model that wanted to be quiet typed dots, and the bubble presented them as speech. The
 * surface's answer is now a name (`punctuation_only:<chars>`) beside `blank_text`, and a turn with nothing to say delivers
 * no bubble at all.
 * </p>
 *
 * <p>
 * THE POPULATION IS EVERY NAME THE DELIVERY PATH CAN RECORD, derived from the code's own lists and never retyped here:
 * the projection's per-part names (`NATIVE_COMPANION_PART_SUPPRESSIONS`), the turn's own withholdings
 * (`TURN_WITHHELD_REASONS`), the family that carries a count (`PUNCTUATION_ONLY`), and the two this layer only names
 * (`NO_PRESENTATION_LEASE`, `SILENT_TERMINATOR`). `WITHHELD_CASES` is a `Record` over that union, so a member added to any
 * of those lists is a compile error here rather than a name nothing examines.
 * </p>
 *
 * <p>
 * THE PROPERTY: no delivered bubble is text with no word in it - `D > 0` fails naming the reason that produced it. The
 * silence markers are derived too (`SILENCE_MARKERS`), and the texts that must still be DELIVERED are the boundary that
 * makes the rule safe: `？` alone is an utterance, `…… 好吧` is a sentence with dots in it.
 * </p>
 */

/** What one driven turn recorded, from both channels the projection answers on. */
type BubbleObservation = Readonly<{
  site: string;
  /** The names the turn recorded: each message's part suppression, then the turn's own withholding. */
  names: readonly string[];
  /** What reached `onFinalText`: the player's whole delivery, sound and all. */
  bubbles: readonly string[];
}>;

/** The sinks' own ledger for one driven turn. `rejected` is a list because two cases end in a refusal by design. */
type GateRecord = {
  bubbles: string[];
  messages: NativeCompanionMessageText[];
  rejected: string[];
  incremental: string[];
};

/** One turn as the cases below need to shape it: the message it carried, and the frame around it. */
type DrivenTurn = Readonly<{
  site: string;
  /** The text parts of the turn's one assistant message, in order. */
  said: readonly string[];
  stopReason?: "stop" | "toolUse" | "error" | "aborted";
  /** Whether the text also arrived as deltas; `false` is the paragraph lane's `unstreamed_text` shape. */
  deltas?: boolean;
  /** How many `deliverTurn()` calls the turn gets: two is the `already_delivered` shape. */
  deliveries?: number;
  revoke?: boolean;
  unit?: "bubble" | "message";
  /** Whether this surface has the mid-message channel, which decides the message unit's intermediate branch. */
  incremental?: boolean;
}>;

/** One real turn, driven through the product's own observer with the surface's own pacing. */
async function driveTurn(turn: DrivenTurn): Promise<BubbleObservation> {
  const listeners = new Set<Listener>();
  const record: GateRecord = { bubbles: [], messages: [], rejected: [], incremental: [] };
  const sinks: NativeCompanionContentSinks = Object.freeze({
    onPreviewDelta: async () => undefined,
    onFinalText: async (value: string) => {
      record.bubbles.push(value);
    },
    onRejected: async (reason) => {
      record.rejected.push(reason);
    },
    onMessageText: async (outcome: NativeCompanionMessageText) => {
      record.messages.push(outcome);
    },
    ...(turn.incremental === true
      ? {
          onIncrementalText: async (value: string) => {
            record.incremental.push(value);
          },
        }
      : {}),
  });
  const observer = attachNativeCompanionContent(
    {
      subscribe(listener: Listener): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    sinks,
    {
      deliveryUnit: turn.unit === "message" ? CHAT_TRANSCRIPT_DELIVERY_UNIT : NATIVE_BUBBLE_DELIVERY_UNIT,
      stageDirection: NATIVE_BUBBLE_STAGE_DIRECTION,
      scaffolding: NATIVE_BUBBLE_SCAFFOLDING,
      pacing: GAME_DELIVERY_PACING,
      turn: { id: "player_source_1", locale: "zh-CN" },
    },
  );
  observer.open();
  if (turn.incremental === true) observer.openPreviews();
  const emit = (event: NativeCompanionContentEvent): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const start = assistant([], turn.stopReason === "toolUse" ? "toolUse" : "stop");
  emit({ type: "message_start", message: start });
  if (turn.deltas !== false)
    turn.said.forEach((part, index) => {
      emit({
        type: "message_update",
        message: start,
        assistantMessageEvent: { type: "text_start", contentIndex: index, partial: start },
      });
      emit({
        type: "message_update",
        message: start,
        assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: part, partial: start },
      });
    });
  emit({
    type: "message_end",
    message: Object.freeze({
      role: "assistant" as const,
      content: turn.said.map((part) => text(part)),
      stopReason: turn.stopReason ?? "stop",
      responseId: "response-1",
    }),
  });
  if (turn.revoke === true) observer.revoke();
  const answers: NativeCompanionTurnDelivery[] = [];
  for (let call = 0; call < (turn.deliveries ?? 1); call += 1) answers.push(observer.deliverTurn());
  await observer.close();
  const names = [
    ...record.messages.flatMap((message) => (message.suppression === null ? [] : [message.suppression])),
    ...answers.flatMap((answer) => (answer.delivered === 0 ? [answer.reason] : [])),
  ];
  return Object.freeze({ site: turn.site, names: Object.freeze(names), bubbles: Object.freeze([...record.bubbles]) });
}

/** Every name a turn's bubble can be withheld under, as KINDS - each list is the product's own declaration. */
const WITHHELD_KINDS = Object.freeze([
  ...NATIVE_COMPANION_PART_SUPPRESSIONS,
  ...TURN_WITHHELD_REASONS,
  PUNCTUATION_ONLY,
  NO_PRESENTATION_LEASE,
  SILENT_TERMINATOR,
] as const);

type WithheldKind = (typeof WITHHELD_KINDS)[number];

/**
 * One kind is either driven here, or named with the suite that drives it - never silently omitted.
 *
 * The two that are named elsewhere need a whole loop turn (a presentation lease, an expression-only tool result), and the
 * suites named are the ones that already build that frame.
 */
type KindCase = Readonly<{ drives: DrivenTurn | readonly DrivenTurn[] }> | Readonly<{ drivenElsewhere: string }>;

const WITHHELD_CASES: Record<WithheldKind, KindCase> = Object.freeze({
  // THE PROJECTION'S PER-PART NAMES.
  blank_text: { drives: { site: "blank_text", said: ["   "] } },
  empty_after_projection: { drives: { site: "empty_after_projection", said: ["*转过身微笑*"] } },
  undrawable_text: { drives: { site: "undrawable_text", said: ["嗯\u0007"] } },
  unstreamed_text: { drives: { site: "unstreamed_text", said: ["我回来了。"], deltas: false, unit: "message", incremental: true } },
  intermediate_message: { drives: { site: "intermediate_message", said: ["先出门。"], stopReason: "toolUse", unit: "message" } },
  provider_error: { drives: { site: "provider_error", said: ["我回来了。"], stopReason: "error" } },
  aborted: { drives: { site: "aborted", said: ["我回来了。"], stopReason: "aborted" } },
  // THE TURN'S OWN ANSWERS.
  nothing_to_say: { drives: { site: "nothing_to_say", said: ["*转过身微笑*"] } },
  already_delivered: { drives: { site: "already_delivered", said: ["我回来了。"], deliveries: 2 } },
  stopped: { drives: { site: "stopped", said: ["我回来了。"], revoke: true } },
  message_unit: { drives: { site: "message_unit", said: ["我回来了。"], unit: "message" } },
  // THE FAMILY THIS UNIT ADDED: `round79`'s own three deliveries, replayed.
  punctuation_only: {
    drives: [
      { site: "round79_line_1", said: ["…… ……"] },
      { site: "round79_line_2", said: ["…… ……"] },
      { site: "round79_line_3", said: ["……"] },
    ],
  },
  // THE TWO THAT NEED A WHOLE LOOP TURN, with the suite that builds it.
  no_presentation_lease: {
    drivenElsewhere:
      "`native-companion-turn-delivery.test.ts` `turn_withheld_entirely_never_settles` is the only case that reaches this " +
      "name, and it is RED for a reason upstream of this unit: measured 2026-11-19, `loop.pump.flush()` answers `not_owed " +
      "· no_surface_for` for the facts that case enqueues (`{kind:'warped'}`, `{kind:'day_started'}`), so no turn is ever " +
      "composed for the loop to name. The delivery layer still records this name (`companion-loop.ts`); what the pump no " +
      "longer does is invite a turn whose answer nothing could show",
  },
  silent_terminator: {
    drivenElsewhere: `\`companion-loop.silent-terminator.test.ts\` \`a_silent_terminator_does_not_speak\` drives both openers: ${TURN_OPENINGS.map(
      (opener) => silentTerminatorReason(opener),
    ).join(", ")}`,
  },
});

/** Every text made only of silence markers, derived from the register itself: each marker, doubled, and spaced. */
function markerOnlyTexts(): readonly string[] {
  return Object.freeze(
    [...SILENCE_MARKERS].flatMap((marker) => [marker, marker.repeat(2), `${marker} ${marker}`]),
  );
}

/**
 * The texts that must still be DELIVERED, because they carry something a player can read.
 *
 * `？` and `？？` are the boundary the rule is built around: a lone question mark is an utterance in Chinese chat, and a
 * rule that swallowed it would delete a real reply. `…… 好吧` is the dotted sentence the rule must not touch, `。嗯` is the
 * one full stop plus one word, and `嗯。` is the two-character answer `round79`'s owner wanted to hear instead of dots.
 */
const SPOKEN_TEXTS = Object.freeze(["嗯。", "？", "？？", "。嗯", "…… 好吧", "我回来了。"]);

/** The bubble's speech, with the turn's own opening sound removed: the sound is a word, so leaving it in hides the defect. */
function speechOf(bubble: string, sound: string): string {
  return bubble.startsWith(`${sound} `) ? bubble.slice(sound.length + 1) : bubble;
}

test("a bubble is a thing said: a turn of dots delivers nothing and says why, and a dotted sentence still speaks", async () => {
  // `round79`'s own three deliveries, replayed: `chars 5 / 5 / 2`, every one of them ellipses.
  const replayed = [];
  for (const said of ["…… ……", "…… ……", "……"]) replayed.push(await driveTurn({ site: `round79:${said}`, said: [said] }));

  for (const [index, turn] of replayed.entries()) {
    const said = ["…… ……", "…… ……", "……"][index]!;
    assert.deepEqual(turn.bubbles, [], `${turn.site}: a turn of nothing but ${JSON.stringify(said)} must not speak`);
    assert.equal(
      turn.names[0],
      punctuationOnlyReason(said.length),
      `${turn.site}: the withheld part is named, and the name carries the count the log recorded (${String(said.length)})`,
    );
    assert.equal(
      turn.names.at(-1),
      TURN_WITHHELD.nothingToSay,
      `${turn.site}: with every paragraph withheld, the turn itself answers \`nothing_to_say\``,
    );
  }

  // THE BOUNDARY, BOTH WAYS: every marker-only text is withheld by name, and every readable text still arrives.
  for (const marker of markerOnlyTexts()) {
    const turn = await driveTurn({ site: `marker:${marker}`, said: [marker] });
    assert.deepEqual(turn.bubbles, [], `${turn.site}: a bubble of silence markers reached the player`);
    assert.equal(turn.names[0], punctuationOnlyReason(marker.length), `${turn.site}: the silence is not named`);
  }
  for (const said of SPOKEN_TEXTS) {
    const turn = await driveTurn({ site: `spoken:${said}`, said: [said] });
    assert.equal(turn.bubbles.length, 1, `${turn.site}: a readable answer must still be delivered, and once`);
    assert.ok(turn.bubbles[0]!.includes(said), `${turn.site}: the bubble lost the words it was given`);
    assert.deepEqual(turn.names, [], `${turn.site}: nothing was withheld from a turn that spoke`);
  }

  // A DOTS-ONLY MESSAGE INSIDE A TURN THAT SPEAKS: the line arrives and the dots do not, which is `round79`'s shape.
  const mixed = fakeSession();
  const mixedRecord = record();
  const mixedObserver = attachBubble(mixed, mixedRecord.sinks);
  streamSaid(mixed.emit, ["……"]);
  streamSaid(mixed.emit, ["我回来了。"]);
  const mixedBubble = deliveredBubble(mixedObserver.deliverTurn());
  await mixedObserver.close();
  assert.deepEqual(mixedRecord.bubbles, [`${soundOf()} 我回来了。`], "the turn delivers its line and nothing else");
  assert.equal(mixedBubble.chars, mixedRecord.bubbles[0]!.length);
  assert.deepEqual(mixedRecord.messages, [
    { textParts: 1, suppression: punctuationOnlyReason(2) },
    { textParts: 1, suppression: null },
  ]);
});

test("a_bubble_is_a_thing_said: every withheld name is examined, and no delivered bubble lacks a word", async () => {
  const sound = soundOf();
  const observations: BubbleObservation[] = [];
  const findings: string[] = [];
  const examined: string[] = [];
  const elsewhere: string[] = [];
  let named = 0;
  let punctuationCaught = 0;

  for (const [kind, entry] of Object.entries(WITHHELD_CASES) as [WithheldKind, KindCase][]) {
    if ("drivenElsewhere" in entry) {
      elsewhere.push(`${kind}: ${entry.drivenElsewhere}`);
      continue;
    }
    examined.push(kind);
    const turns = Array.isArray(entry.drives) ? entry.drives : [entry.drives as DrivenTurn];
    const names: string[] = [];
    for (const turn of turns) {
      const observation = await driveTurn(turn);
      observations.push(observation);
      names.push(...observation.names);
      if (observation.names.some((name) => name === kind || name.startsWith(`${kind}:`))) named += 1;
      else findings.push(`reason_not_recorded:${kind}:${turn.site}:names=${JSON.stringify(observation.names)}`);
    }
    punctuationCaught += names.filter((name) => name.startsWith(`${PUNCTUATION_ONLY}:`)).length;
  }

  // THE POPULATION IS THE AUTHORITY. Every derived kind is either driven above or named with its suite, and the count of
  // the two must be the whole list - a member that drifted out of this table would otherwise pass as "not examined".
  const unaccounted = WITHHELD_KINDS.filter(
    (kind) => !examined.includes(kind) && !elsewhere.some((line) => line.startsWith(`${kind}:`)),
  );
  for (const kind of unaccounted) findings.push(`reason_not_examined:${kind}`);

  // THE SILENCE MARKERS, derived from the register: every one of them must be caught by name, and none may reach the player.
  let markersExamined = 0;
  for (const marker of markerOnlyTexts()) {
    markersExamined += 1;
    const observation = await driveTurn({ site: `marker:${marker}`, said: [marker] });
    observations.push(observation);
    const caught = observation.names.filter((name) => name.startsWith(`${PUNCTUATION_ONLY}:`));
    punctuationCaught += caught.length;
    if (caught.length !== 1)
      findings.push(`silence_marker_not_named:${JSON.stringify(marker)}:names=${JSON.stringify(observation.names)}`);
  }

  // AND THE TEXTS THAT ARE SPEECH: delivered, once, with the words in them.
  for (const said of SPOKEN_TEXTS) {
    const observation = await driveTurn({ site: `spoken:${said}`, said: [said] });
    observations.push(observation);
    if (observation.bubbles.length !== 1)
      findings.push(`speech_not_delivered:${JSON.stringify(said)}:bubbles=${String(observation.bubbles.length)}`);
    else if (!observation.bubbles[0]!.includes(said))
      findings.push(`speech_altered:${JSON.stringify(said)}:${JSON.stringify(observation.bubbles[0])}`);
  }

  // D, OVER EVERY DELIVERED BUBBLE THE RUNS ABOVE PRODUCED, named by the turn that produced it.
  let deliveredWithoutWords = 0;
  for (const observation of observations)
    for (const bubble of observation.bubbles)
      if (isSilenceOnly(speechOf(bubble, sound))) {
        deliveredWithoutWords += 1;
        findings.push(`a_bubble_is_a_thing_said:${observation.site}:${JSON.stringify(speechOf(bubble, sound))}`);
      }

  assert.ok(
    markersExamined > 0 && examined.length > 0 && SPOKEN_TEXTS.length > 0,
    "blocked: one of this gate's populations is empty, so its verdict is a statement about nothing",
  );
  // THE READERS ARE PROVEN LIVE, so a green line is not a blind detector's silence.
  assert.equal(isSilenceOnly("……"), true, "the silence reader does not fire on the text `round79` delivered");
  assert.equal(isSilenceOnly("？"), false, "the silence reader would swallow a lone question mark, which is speech");
  assert.ok(
    isSilenceOnly(speechOf(`${sound} ……`, sound)),
    "the bubble's own speech is not read: with the sound left in, a dots bubble would pass as a word",
  );

  process.stdout.write(
    `\na_bubble_is_a_thing_said: reasons examined ${String(WITHHELD_KINDS.length)} · named ${String(named)} · ` +
      `punctuation-caught ${String(punctuationCaught)} · delivered-without-words ${String(deliveredWithoutWords)}\n`,
  );
  for (const line of elsewhere) process.stdout.write(`  examined elsewhere ${line}\n`);
  assert.deepEqual(findings, [], "every bubble the delivery can withhold names itself, and none of them is silence");
});
