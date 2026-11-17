import assert from "node:assert/strict";
import test from "node:test";
import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import { CompanionLoop } from "./companion-loop.js";
import { MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE } from "./companion-turn-refusal.js";
import { programSettledDigest } from "./program-settlement-digest.js";
import {
  ASSISTANT_TURNS_EXAMINED,
  ASSISTANT_TURNS_TOOL_ONLY,
  ASSISTANT_TURNS_WITH_TEXT,
  assistantTurnsToolOnly,
  assistantTurnsWithText,
  FACT_PRODUCER,
  PER_DELIVERED_BATCH,
  TURN_OPENING,
  TURN_PRODUCTION,
  TURN_SETTLED_SILENT,
  NOT_OWED,
  turnAccountLine,
} from "./event-pump.js";

/**
 * What the player receives for one Game turn: ONE bubble - the turn's reaction sound at its head, then the words.
 *
 * The sound is derived from the turn's own identity through the same authority that selects it at delivery time, so this
 * does not spell a second copy of the vocabulary; what the assertions below pin is that the sound arrives as the HEAD of
 * the same bubble as the reply and belongs to the same source event, not which interjection a particular hash picks.
 */
function presentedWithReaction(sourceEventId: string, locale: string, text: string): readonly unknown[] {
  const sound = selectReactionSound(sourceEventId, locale, GAME_DELIVERY_PACING.reaction!);
  assert.notEqual(sound, null, `${locale} must have a reaction vocabulary for this case to assert one`);
  return [{ sourceEventId, text: `${sound} ${text}` }];
}

type SessionEvent = {
  type: string;
  messages?: readonly unknown[];
  message?: unknown;
  assistantMessageEvent?: unknown;
  aborted?: boolean;
  entry?: unknown;
};

function settledSession(
  handler: (text: string, options?: { deliverAs?: string }) => Promise<void> | void = async () => {},
  settled: { aborted?: boolean } = {},
  eventsBeforeSettle: readonly SessionEvent[] = [],
) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const emit = (event: SessionEvent) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(text: string, options?: { deliverAs?: string }) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      await handler(text, options);
      // Events a turn produces between its own consumption and its settlement (a refusal entry, below).
      for (const event of eventsBeforeSettle) emit(event);
      emit({ type: "agent_settled", aborted: settled.aborted === true });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: SessionEvent) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

test("CompanionLoop explicitly steers player input and includes the latest snapshot", async () => {
  const received: Array<{ text: string; deliverAs?: string | undefined }> = [];
  const loop = new CompanionLoop(
    settledSession(async (text, options) => {
      received.push({ text, deliverAs: options?.deliverAs });
    }) as never,
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "snapshot",
      correlationId: "snapshot_01",
      revision: 3,
      payload: { location: "Farm" },
    },
    FACT_PRODUCER.adapterIngress,
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_01",
    eventId: "player_source_01",
    text: "我们去哪里？",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.equal(received.length, 1);
  assert.equal(received[0]?.deliverAs, "steer");
  const text = received[0]?.text ?? "";
  // The message is the composed prose, not an envelope: it OPENS with the player's own words, unlabelled, and the
  // reading follows as a block. What this test owns is that the loop delivers the input as speech rather than as a
  // labelled section of the machine's report - the first content of the turn is the person speaking.
  assert.ok(
    text.startsWith("我们去哪里？"),
    `the turn must open with the words the player typed: ${JSON.stringify(text.slice(0, 60))}`,
  );
  assert.equal(text.split("我们去哪里？").length - 1, 1, `the words appear once: ${text}`);
  assert.match(text, /<world-state>\n世界（revision 3，刚刚更新）/u);
});

test("CompanionLoop chooses the deterministic final player trigger as presentation lineage", async () => {
  const observed: string[] = [];
  const loop = new CompanionLoop(settledSession() as never, {
    beginPlayerBatch(sourceEventId) {
      observed.push(`begin:${sourceEventId}`);
    },
    endBatch() {
      observed.push("end");
    },
    async presentNativeAssistantContent() {},
  });
  // Input enqueue order intentionally differs from deterministic timestamp
  // order; the real serialized event order is the authority.
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "source_late",
    eventId: "player_late",
    text: "late",
    locale: "en-US",
    timestampMs: 2,
  });
  loop.pump.enqueuePlayerInput({
    source: "voice_final",
    inputId: "source_early",
    eventId: "voice_early",
    text: "early",
    locale: "en-US",
    timestampMs: 1,
  });
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "semantic_event",
      eventId: "world_later",
      sourceEventId: "world_later",
      correlationId: "world",
      revision: 1,
      occurredAtMs: 3,
      payload: { kind: "warped" },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await loop.flush();
  assert.deepEqual(observed, ["begin:player_late", "end"]);
});

test("CompanionLoop forwards only final native assistant content from an exact consumed player batch", async () => {
  const lifecycle: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_1", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_1",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        // The full reply arrives inside one delta without a sentence boundary;
        // it buffers and the residual presents once through the final path.
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "I am here.", partial: trackedPartial },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_1",
            role: "assistant",
            content: [{ type: "text", text: "I am here." }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {
        lifecycle.push("begin");
      },
      endBatch() {
        lifecycle.push("end");
      },
      async presentNativeAssistantContent(content) {
        assert.deepEqual(lifecycle, ["begin"]);
        presented.push(content);
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_1",
    eventId: "player_source_1",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(presented, presentedWithReaction("player_source_1", "en-US", "I am here."));
  assert.deepEqual(lifecycle, ["begin", "end"]);
});

test("CompanionLoop streams companion speech deltas to the voice sink and finalizes on the residual final text", async () => {
  const lifecycle: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const voiceOps: string[] = [];
  const appended: string[] = [];
  const voiceSink = {
    begin: async (turnId: string) => voiceOps.push(`begin:${turnId}`),
    append: async (delta: string) => {
      voiceOps.push("append");
      appended.push(delta);
    },
    finalize: async () => voiceOps.push("finalize"),
    cancel: async () => voiceOps.push("cancel"),
  };
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_voice", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_voice",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: { ...trackedPartial, content: [{ type: "text", text: "早" }] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "早", partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: { ...trackedPartial, content: [{ type: "text", text: "早安" }] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "安", partial: trackedPartial },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_voice",
            role: "assistant",
            // No boundary: the deltas buffered above form the residual that
            // commits through the final path, so voice still finalizes once.
            content: [{ type: "text", text: "早安" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {
        lifecycle.push("begin");
      },
      endBatch() {
        lifecycle.push("end");
      },
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
    undefined,
    voiceSink as never,
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_voice",
    eventId: "player_source_voice",
    text: "早上好",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(lifecycle, ["begin", "end"]);
  assert.deepEqual(appended, ["早", "安"]);
  assert.deepEqual(
    voiceOps
      .filter((op) => op.startsWith("begin") || op === "finalize")
      .map((op) => (op.startsWith("begin") ? "begin" : op)),
    ["begin", "finalize"],
  );
  assert.deepEqual(presented, presentedWithReaction("player_source_voice", "zh-CN", "早安"));
});

test("CompanionLoop cancels the voice job when a consumed batch never produces final text", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const voiceOps: string[] = [];
  const voiceSink = {
    begin: async (turnId: string) => voiceOps.push(`begin:${turnId}`),
    append: async () => voiceOps.push("append"),
    finalize: async () => voiceOps.push("finalize"),
    cancel: async () => voiceOps.push("cancel"),
  };
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_aborted", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        // No message_end: the turn aborts before final content.
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent() {},
    },
    undefined,
    voiceSink as never,
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_voice_abort",
    eventId: "player_source_voice_abort",
    text: "等一下",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  // The voice job opened with the batch but never finalized; cleanup cancels it.
  assert.ok(voiceOps.some((op) => op.startsWith("begin:")));
  assert.ok(voiceOps.includes("cancel"));
  assert.ok(!voiceOps.includes("finalize"));
});

test("CompanionLoop presents incremental sentences without any voice sink", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const presented: unknown[] = [];
  // No voiceSink argument: the delta lane still opens (previews are unlocked
  // for every Game presenter), and it feeds the voice job when one exists; the
  // bubble itself is the turn's, so it arrives once at the end.
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_incr", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_incr",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        for (const delta of ["早", "安!", "今天", "下雨。"]) {
          emit({
            type: "message_update",
            message: trackedPartial,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: trackedPartial },
          });
        }
        emit({
          type: "message_end",
          message: {
            id: "assistant_incr",
            role: "assistant",
            content: [{ type: "text", text: "早安!今天下雨。" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_incr",
    eventId: "player_source_incr",
    text: "在哪里",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(presented, presentedWithReaction("player_source_incr", "zh-CN", "早安!今天下雨。"));
});

test("CompanionLoop delivers a message whose deltas never carried a boundary in full, not just its buffered head", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_residual", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_residual",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        // No boundary arrives before message_end, so nothing could have been spoken mid-message. The bubble is built
        // from the MESSAGE, so the boundary-less head is not mistaken for the whole reply.
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "我这就去", partial: trackedPartial },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_residual",
            role: "assistant",
            content: [{ type: "text", text: "我这就去。把草拔了。" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_residual",
    eventId: "player_source_residual",
    text: "去吧",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(presented, presentedWithReaction("player_source_residual", "zh-CN", "我这就去。把草拔了。"));
});

test("CompanionLoop presents a multi-sentence message as ONE bubble holding every sentence", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_chunk", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_chunk",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        // Three sentences complete inside one delta: nothing about that makes them three bubbles, because the unit is
        // the turn and this turn has one message.
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "我这就去南瓜地浇水。把杂草也一起拔了。然后把种子撒上",
            partial: trackedPartial,
          },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_chunk",
            role: "assistant",
            content: [{ type: "text", text: "我这就去南瓜地浇水。把杂草也一起拔了。然后把种子撒上。" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_chunk",
    eventId: "player_source_chunk",
    text: "帮帮我",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(
    presented,
    presentedWithReaction("player_source_chunk", "zh-CN", "我这就去南瓜地浇水。把杂草也一起拔了。然后把种子撒上。"),
  );
});

test("CompanionLoop finalizes the voice job exactly once and repeats no sentence inside the bubble", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const voiceOps: string[] = [];
  const voiceSink = {
    begin: async (turnId: string) => voiceOps.push(`begin:${turnId}`),
    append: async () => voiceOps.push("append"),
    finalize: async () => voiceOps.push("finalize"),
    cancel: async () => voiceOps.push("cancel"),
  };
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_dup", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_dup",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        // Four identical sentences stream in: the bubble must carry each one once, because it is built from the
        // message rather than accumulated from the stream.
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好。", partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好。", partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好。", partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "好", partial: trackedPartial },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_dup",
            role: "assistant",
            content: [{ type: "text", text: "好。好。好。好。" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
    undefined, // liveSourceEvidence: kept empty for this test
    voiceSink as never,
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_dup",
    eventId: "player_source_dup",
    text: "在吗",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  // One bubble, each sentence once, even though four identical sentences streamed in.
  assert.deepEqual(presented, presentedWithReaction("player_source_dup", "zh-CN", "好。好。好。好。"));
  // The voice job must open once and finalize exactly once, never twice.
  assert.equal(voiceOps.filter((op) => op === "finalize").length, 1);
  assert.equal(voiceOps.filter((op) => op.startsWith("begin:")).length, 1);
  assert.ok(!voiceOps.includes("cancel"));
});

test("CompanionLoop suppresses foreign, aborted, and post-STOP native content", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const presented: unknown[] = [];
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        await turn;
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => listeners.delete(next);
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_suppressed",
    eventId: "player_source_suppressed",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  const flushing = loop.flush();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const current = { id: "current", role: "assistant", content: [], stopReason: "stop" };
  const foreign = { id: "foreign", role: "assistant", content: [], stopReason: "stop" };
  // Binding begins at the actual assistant start. A different final snapshot
  // cannot replace it, and STOP then revokes the bound observer before its own
  // delayed final snapshot arrives.
  emit({ type: "message_start", message: current });
  emit({ type: "message_end", message: { ...foreign, content: [{ type: "text", text: "foreign" }] } });
  const stopping = loop.abortAndClear();
  emit({
    type: "message_end",
    message: { id: "late", role: "assistant", content: [{ type: "text", text: "late" }], stopReason: "stop" },
  });
  releaseTurn();
  await stopping;
  await flushing;
  assert.deepEqual(presented, []);
});

test("CompanionLoop permits a consumed player turn with no native content projection", async () => {
  const lifecycle: string[] = [];
  const loop = new CompanionLoop(settledSession() as never, {
    beginPlayerBatch() {
      lifecycle.push("begin");
    },
    endBatch() {
      lifecycle.push("end");
    },
    async presentNativeAssistantContent() {
      assert.fail("a tool-only or empty assistant turn must not manufacture dialogue");
    },
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_no_text",
    eventId: "player_source_no_text",
    text: "do it",
    locale: "en-US",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(lifecycle, ["begin", "end"]);
});

test("CompanionLoop chooses an authenticated world source for fact-only follow-up and rejects held facts", async () => {
  const observed: string[] = [];
  const loop = new CompanionLoop(settledSession() as never, {
    beginPlayerBatch(sourceEventId) {
      observed.push(`begin:${sourceEventId}`);
    },
    endBatch() {
      observed.push("end");
    },
  });
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "snapshot",
      eventId: "snapshot",
      sourceEventId: "snapshot_source",
      correlationId: "snapshot",
      revision: 1,
      occurredAtMs: 1,
      payload: {},
    },
    FACT_PRODUCER.adapterIngress,
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "execution_receipt",
      eventId: "progress",
      sourceEventId: "progress_source",
      correlationId: "progress",
      revision: 1,
      occurredAtMs: 2,
      payload: { state: "meaningful_progress" },
    },
    FACT_PRODUCER.adapterIngress,
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "semantic_event",
      eventId: "fallback_event",
      correlationId: "first",
      revision: 1,
      occurredAtMs: 3,
      payload: {},
    },
    FACT_PRODUCER.adapterIngress,
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "lifecycle",
      eventId: "lifecycle_event",
      sourceEventId: "world_canonical",
      correlationId: "last",
      revision: 1,
      occurredAtMs: 4,
      payload: {},
    },
    FACT_PRODUCER.adapterIngress,
  );
  await loop.flush();
  // Non-salient world-trigger batches deliberately cannot mint a native
  // player-chat presentation lineage; only Pi-consumed authenticated player
  // input or a white-listed salient sensory kind may.
  assert.deepEqual(observed, []);
});

test("CompanionLoop delivers an npc_dialogue_presented fact to Pi without minting a presentation lineage", async () => {
  const received: string[] = [];
  const lineage: string[] = [];
  const loop = new CompanionLoop(
    settledSession(async (text) => {
      received.push(text);
    }) as never,
    {
      beginPlayerBatch(sourceEventId) {
        lineage.push(`begin:${sourceEventId}`);
      },
      endBatch() {
        lineage.push("end");
      },
      async presentNativeAssistantContent() {
        assert.fail("a dialogue-only batch must not project native assistant content");
      },
    },
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "world_fact",
      eventId: "npc_dialogue_pierre_3",
      sourceEventId: "npc_dialogue_pierre_3",
      correlationId: "npc_dialogue_pierre_3",
      revision: 1,
      occurredAtMs: 1,
      observedTick: 900,
      semanticKind: "npc_dialogue_presented",
      payload: { speaker: "Pierre", pages: ["欢迎光临！"], isQuestion: false, choices: [] },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await loop.flush();
  // The Mod reads the NPC's own lines, so the typed fact reaches Pi's exact
  // context with its readable payload. But `npc_dialogue_presented` is
  // deliberately NOT in the isSalientSensoryKind allowlist: the companion turn
  // runs without a native presentation lineage, so the Agent can act on the
  // dialogue (e.g. answer_dialogue) but cannot voice a spoken reaction to it.
  assert.equal(received.length, 1);
  assert.deepEqual(lineage, []);
  assert.match(received[0] ?? "", /Pierre说：「欢迎光临！」/u);
});

test("CompanionLoop grants a bounded presentation lease to salient sensory world facts", async () => {
  const lifecycle: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_salient_1", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_salient_1",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        // Both sentences complete inside one delta: each presents immediately
        // and the empty residual never produces a duplicate final piece.
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "早安!今天也要加油。",
            partial: trackedPartial,
          },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_salient_1",
            role: "assistant",
            content: [{ type: "text", text: "早安!今天也要加油。" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {
        lifecycle.push("begin");
      },
      endBatch() {
        lifecycle.push("end");
      },
      async presentNativeAssistantContent(content) {
        presented.push(content);
      },
    },
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "world_fact",
      eventId: "day_started_day_3",
      sourceEventId: "day_started_day_3",
      correlationId: "day_started_day_3",
      revision: 2,
      occurredAtMs: 1,
      semanticKind: "day_started",
      payload: { day: 3 },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await loop.flush();
  assert.deepEqual(lifecycle, ["begin", "end"]);
  assert.deepEqual(presented, [{ sourceEventId: "day_started_day_3", text: "早安!今天也要加油。" }]);
});

test("CompanionLoop steers a busy Pi session without aborting it", async () => {
  const received: Array<{ deliverAs?: string | undefined }> = [];
  let aborts = 0;
  const session = settledSession(async (_text, options) => {
    received.push({ deliverAs: options?.deliverAs });
  });
  const originalAbort = session.abort;
  session.abort = async () => {
    aborts++;
    await originalAbort();
  };
  const loop = new CompanionLoop(session as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "busy_input",
    eventId: "busy_source",
    text: "改去镇上",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(received, [{ deliverAs: "steer" }]);
  assert.equal(aborts, 0);
});

test("CompanionLoop refuses presentation lineage for legacy player correlation without an authenticated event identity", async () => {
  const observed: string[] = [];
  const loop = new CompanionLoop(settledSession() as never, {
    beginPlayerBatch(sourceEventId) {
      observed.push(sourceEventId);
    },
    endBatch() {},
    async presentNativeAssistantContent() {},
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "legacy_correlation",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(observed, []);
});

test("CompanionLoop reports an aborted settlement as aborted, not completed", async () => {
  // Pi 1.1.0 added `aborted` to agent_settled. Before this, an aborted run that produced no final
  // message left no recorded outcome and the turn reported `completed` - a cancelled turn claimed as
  // an answer, which is exactly what a settled-batch witness exists to prevent.
  const loop = new CompanionLoop(settledSession(async () => {}, { aborted: true }) as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_01",
    eventId: "source_01",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  assert.equal(await loop.flush(), "aborted");
});

test("CompanionLoop records a Magic Context refusal as refused, not as the abort the refusal caused", async () => {
  // Upstream v0.48.0 refuses a turn rather than sending it unmanaged: the guard appends a display-only
  // `magic-context-turn-refused` entry and then calls `ctx.abort()`, so Pi settles the run as aborted.
  // Reading that abort as the ending reports a refusal as the player's own STOP.
  const loop = new CompanionLoop(settledSession(async () => {}, { aborted: true }, [refusalEvent()]) as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_01",
    eventId: "source_01",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  assert.equal(await loop.flush(), "refused");
});

test("CompanionLoop never reports a refused turn as completed", async () => {
  const loop = new CompanionLoop(settledSession(async () => {}, {}, [refusalEvent()]) as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_01",
    eventId: "source_01",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  assert.equal(await loop.flush(), "refused");
});

test("CompanionLoop does not read another extension's appended entry as a refusal", async () => {
  const loop = new CompanionLoop(
    settledSession(async () => {}, { aborted: true }, [
      { type: "entry_appended", entry: { type: "custom", customType: "codemode-store", data: {} } },
    ]) as never,
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_01",
    eventId: "source_01",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  assert.equal(await loop.flush(), "aborted");
});

/** Pi's own `entry_appended` shape for Magic Context's refusal (upstream v0.48.0). */
function refusalEvent(): SessionEvent {
  return {
    type: "entry_appended",
    entry: {
      type: "custom",
      customType: MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE,
      data: { message: "Magic Context could not safely prepare this turn; send your message again." },
    },
  };
}

test("CompanionLoop binds acceptance and settlement to one Pi-runtime settled batch", async () => {
  const evidence: Array<unknown> = [];
  const loop = new CompanionLoop(settledSession() as never, undefined, {
    nativePlayerInputObserved() {},
    nativeStopAllObserved() {},
    piTurnAccepted: (value) => evidence.push({ kind: "accepted", ...value }),
    piTurnSettled: (value) => evidence.push({ kind: "settled", ...value }),
    stopSealed() {},
    stopSettled() {},
    stopUncertain() {},
    oldEpochQuiet() {},
    bodySettled() {},
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_01",
    eventId: "source_01",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  await loop.flush();
  assert.equal(evidence.length, 2);
  const [accepted, settled] = evidence as Array<{
    kind: string;
    batchId: string;
    sourceEventId: string;
    disposition: string;
  }>;
  assert.deepEqual(accepted, {
    kind: "accepted",
    batchId: accepted!.batchId,
    sourceEventId: "source_01",
    disposition: "steer",
  });
  assert.deepEqual(settled, {
    kind: "settled",
    batchId: accepted!.batchId,
    sourceEventId: "source_01",
    disposition: "steer",
  });
});

test("CompanionLoop preserves Pi delivery when source evidence transport throws", async () => {
  const evidence: string[] = [];
  const loop = new CompanionLoop(settledSession() as never, undefined, {
    nativePlayerInputObserved() {},
    nativeStopAllObserved() {},
    piTurnAccepted() {
      throw new Error("attestation_delivery_failed");
    },
    piTurnSettled() {
      evidence.push("settled");
      throw new Error("attestation_delivery_failed");
    },
    stopSealed() {},
    stopSettled() {},
    stopUncertain() {},
    oldEpochQuiet() {},
    bodySettled() {},
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_evidence_failure",
    eventId: "source_evidence_failure",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(evidence, ["settled"]);
});

test("CompanionLoop does not mark a Pi turn settled before Pi reports agent_settled", async () => {
  let listener: ((event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) | undefined;
  const evidence: string[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        listener?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as never,
    undefined,
    {
      nativePlayerInputObserved() {},
      nativeStopAllObserved() {},
      piTurnAccepted: () => evidence.push("accepted"),
      piTurnSettled: () => evidence.push("settled"),
      stopSealed() {},
      stopSettled() {},
      stopUncertain() {},
      oldEpochQuiet() {},
      bodySettled() {},
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_02",
    eventId: "source_02",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  const flushing = loop.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(evidence, ["accepted"]);
  listener?.({ type: "agent_settled" });
  await flushing;
  assert.deepEqual(evidence, ["accepted", "settled"]);
});

test("CompanionLoop rejects a pre-consumption Pi delivery failure and retains the exact batch for retry", async () => {
  const loop = new CompanionLoop({
    async sendUserMessage() {
      throw new Error("pi_delivery_rejected");
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe() {
      return () => {};
    },
  } as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_rejected",
    eventId: "source_rejected",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  await assert.rejects(loop.flush(), /pi_delivery_rejected/);
  assert.equal(loop.pump.hasPendingDelivery, true);
  assert.equal(loop.pump.pendingCount, 1);
});

test("CompanionLoop fails closed when Pi settles before it actually starts the accepted batch", async () => {
  let listener: ((event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) | undefined;
  const loop = new CompanionLoop({
    async sendUserMessage() {
      listener?.({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_early_settle",
    eventId: "source_early_settle",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  const outcome = await Promise.race([
    loop.flush().then(
      () => "settled",
      (error) => `failed:${error instanceof Error ? error.message : String(error)}`,
    ),
    new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 20)),
  ]);
  assert.equal(outcome, "timeout");
});

test("CompanionLoop rejects a Pi message that only contains the expected batch as one part", async () => {
  let listener: ((event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) | undefined;
  const evidence: string[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        listener?.({
          type: "message_start",
          message: {
            role: "user",
            content: [
              { type: "text", text },
              { type: "text", text: "unattested_tail" },
            ],
          },
        });
        listener?.({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as never,
    undefined,
    {
      nativePlayerInputObserved() {},
      nativeStopAllObserved() {},
      piTurnAccepted: () => evidence.push("accepted"),
      piTurnSettled: () => evidence.push("settled"),
      stopSealed() {},
      stopSettled() {},
      stopUncertain() {},
      oldEpochQuiet() {},
      bodySettled() {},
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_extra_part",
    eventId: "source_extra_part",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  const flushing = loop.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(evidence, []);
  await Promise.race([flushing, new Promise<void>((resolve) => setTimeout(resolve, 20))]);
  assert.deepEqual(evidence, []);
});

test("CompanionLoop refuses an unrelated Pi message-start as source consumption", async () => {
  let listener: ((event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) | undefined;
  const evidence: string[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage() {
        listener?.({
          type: "message_start",
          message: { role: "user", content: [{ type: "text", text: "other_batch" }] },
        });
        listener?.({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
    } as never,
    undefined,
    {
      nativePlayerInputObserved() {},
      nativeStopAllObserved() {},
      piTurnAccepted: () => evidence.push("accepted"),
      piTurnSettled: () => evidence.push("settled"),
      stopSealed() {},
      stopSettled() {},
      stopUncertain() {},
      oldEpochQuiet() {},
      bodySettled() {},
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_other",
    eventId: "source_other",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  const flushing = loop.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(evidence, []);
  await Promise.race([flushing, new Promise<void>((resolve) => setTimeout(resolve, 20))]);
  assert.deepEqual(evidence, []);
});

test("CompanionLoop does not mint live evidence from a reduced session without Pi events", async () => {
  const evidence: string[] = [];
  const loop = new CompanionLoop({ async sendUserMessage() {} } as never, undefined, {
    nativePlayerInputObserved() {},
    nativeStopAllObserved() {},
    piTurnAccepted: () => {
      evidence.push("accepted");
    },
    piTurnSettled: () => {
      evidence.push("settled");
    },
    stopSealed() {},
    stopSettled() {},
    stopUncertain() {},
    oldEpochQuiet() {},
    bodySettled() {},
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_reduced",
    eventId: "source_reduced",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  await loop.flush();
  assert.deepEqual(evidence, []);
});

test("CompanionLoop STOP waits for in-flight Pi delivery and Pi idle", async () => {
  let listener: ((event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) | undefined;
  let releaseTurn!: () => void;
  let releaseIdle!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const idle = new Promise<void>((resolve) => {
    releaseIdle = resolve;
  });
  const calls: string[] = [];
  const loop = new CompanionLoop({
    async sendUserMessage(text: string) {
      listener?.({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      await turn;
      listener?.({ type: "agent_settled" });
    },
    async abort() {
      calls.push("abort");
    },
    clearQueue() {
      calls.push("clear");
    },
    async waitForIdle() {
      calls.push("idle");
      await idle;
    },
    subscribe(next: (event: { type: string; messages?: readonly unknown[]; message?: unknown }) => void) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  } as never);
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_03",
    eventId: "source_03",
    text: "hello",
    locale: "en-US",
    timestampMs: 1,
  });
  const flushing = loop.flush();
  await new Promise<void>((resolve) => setImmediate(resolve));
  let stopped = false;
  const stopping = loop.abortAndClear().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);
  assert.deepEqual(calls, ["clear", "abort"]);
  releaseTurn();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["clear", "abort", "idle"]);
  assert.equal(stopped, false);
  releaseIdle();
  await Promise.all([flushing, stopping]);
  assert.equal(stopped, true);
});

test("CompanionLoop explicitly follows up an ordinary fact-only batch", async () => {
  const received: Array<{ deliverAs?: string | undefined }> = [];
  const loop = new CompanionLoop(
    settledSession(async (_text, options) => {
      received.push({ deliverAs: options?.deliverAs });
    }) as never,
  );
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: "warp",
      revision: 1,
      payload: { kind: "warped" },
    },
    FACT_PRODUCER.adapterIngress,
  );
  await loop.flush();
  assert.deepEqual(received, [{ deliverAs: "followUp" }]);
});

test("CompanionLoop downgrades a stale final presentation after the turn settled (tail delivery, not a turn failure)", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const lifecycle: string[] = [];
  const presented: unknown[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_tail", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_tail",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: { ...trackedPartial, content: [{ type: "text", text: "收好" }] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "收好", partial: trackedPartial },
        });
        // The reply arrives as one final text (no deltas before message_end).
        emit({
          type: "message_end",
          message: {
            id: "assistant_tail",
            role: "assistant",
            content: [{ type: "text", text: "收好啦。" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {
        lifecycle.push("begin");
      },
      endBatch() {
        lifecycle.push("end");
      },
      async presentNativeAssistantContent(content) {
        presented.push(content);
        // The runtime epoch was revoked (STOP/teardown) after the turn settled;
        // the pre-write epoch assert fails exactly like the real adapter does.
        throw new Error("stale_interruption_admission");
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_tail",
    eventId: "player_source_tail",
    text: "把草莓收了吧",
    locale: "zh-CN",
    timestampMs: 1,
  });
  // flush must NOT reject: the presentation is a settled-turn tail delivery.
  await loop.flush();
  assert.deepEqual(lifecycle, ["begin", "end"]);
  assert.equal(presented.length, 1);
});

test("CompanionLoop still propagates a non-presentation drain error", async () => {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        const partial = { id: "assistant_drain_err", role: "assistant", content: [], stopReason: "stop" };
        emit({ type: "message_start", message: partial });
        const trackedPartial = {
          id: "assistant_drain_err",
          role: "assistant",
          content: [{ type: "text", text: "" }],
          stopReason: "stop",
        };
        emit({
          type: "message_update",
          message: trackedPartial,
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: trackedPartial },
        });
        emit({
          type: "message_update",
          message: { ...trackedPartial, content: [{ type: "text", text: "x" }] },
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial: trackedPartial },
        });
        emit({
          type: "message_end",
          message: {
            id: "assistant_drain_err",
            role: "assistant",
            content: [{ type: "text", text: "x" }],
            stopReason: "stop",
          },
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent() {
        throw new Error("unexpected_drain_failure");
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_drain_err",
    eventId: "player_source_drain_err",
    text: "hi",
    locale: "en-US",
    timestampMs: 1,
  });
  await assert.rejects(() => loop.flush(), /unexpected_drain_failure/);
});

test("a turn whose provider stream failed resolves as error, never as a completed answer", async () => {
  // The exact shape measured in a real ladder-6 run: the final assistant message carried
  // `stopReason: "error"` and zero usage. Pi already classified it; this loop used to throw that away
  // (`onRejected: () => undefined`), so the caller saw an ordinary accepted turn and the run's own verdict
  // said the companion had chosen not to speak.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown): void => {
    for (const listener of [...listeners]) listener(event);
  };
  const session = {
    async sendUserMessage(text: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", stopReason: "error", content: [] } });
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: unknown) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
  const loop = new CompanionLoop(
    session as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent() {},
    } as never,
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_failed_turn",
    eventId: "player_failed_turn",
    text: "hello",
    locale: "en-US",
    timestampMs: Date.now(),
  });
  assert.equal(await loop.flush(), "error");

  // And the same transport classification as an abort.
  const aborting = {
    ...session,
    async sendUserMessage(text: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emit({ type: "message_end", message: { role: "assistant", stopReason: "aborted", content: [] } });
      emit({ type: "agent_settled" });
    },
  };
  const abortingLoop = new CompanionLoop(
    aborting as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent() {},
    } as never,
  );
  abortingLoop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_aborted_turn",
    eventId: "player_aborted_turn",
    text: "hello",
    locale: "en-US",
    timestampMs: Date.now(),
  });
  assert.equal(await abortingLoop.flush(), "aborted");

  // A turn that answered normally is still `completed`: the outcome must not turn every reply into a failure.
  const answering = {
    ...session,
    async sendUserMessage(text: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emit({
        type: "message_end",
        message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "我在这儿。" }] },
      });
      emit({ type: "agent_settled" });
    },
  };
  const answeringLoop = new CompanionLoop(
    answering as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent() {},
    } as never,
  );
  answeringLoop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_answered_turn",
    eventId: "player_answered_turn",
    text: "hello",
    locale: "en-US",
    timestampMs: Date.now(),
  });
  assert.equal(await answeringLoop.flush(), "completed");
});

test("CompanionLoop binds the turn's volatile authored context to the delivered batch and releases it when the turn settles", async () => {
  const order: string[] = [];
  let delivered: string | undefined;
  const bound: Array<{ turnId: string; text: string }> = [];
  const cleared: string[] = [];
  const loop = new CompanionLoop(
    settledSession(async (text) => {
      order.push("deliver");
      delivered = text;
    }) as never,
    undefined,
    undefined,
    undefined,
    {
      bind(turnId, text) {
        order.push("bind");
        bound.push({ turnId, text });
      },
      clear(turnId) {
        order.push("clear");
        cleared.push(turnId);
      },
    },
  );
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_volatile_turn",
    eventId: "player_volatile_turn",
    text: "今天下雨了",
    locale: "zh-CN",
    timestampMs: 1,
  });
  assert.equal(await loop.flush(), "completed");
  // The selection is bound to the EXACT batch Pi consumes, before delivery, and released once the
  // turn settled - so a later turn can never inherit an earlier turn's selection.
  assert.deepEqual(order, ["bind", "deliver", "clear"]);
  assert.equal(bound.length, 1);
  assert.equal(bound[0]?.text, delivered);
  const turnId = bound[0]?.turnId;
  assert.equal(typeof turnId, "string");
  assert.equal(turnId?.length !== 0, true, "the turn is bound to the batch identity the pump minted");
  assert.deepEqual(cleared, [turnId]);
});

test("a failing volatile bind is a degraded turn, never a failed one", async () => {
  const loop = new CompanionLoop(settledSession() as never, undefined, undefined, undefined, {
    bind() {
      throw new Error("gamebuddy_authored_context_cross_turn");
    },
    clear() {
      throw new Error("gamebuddy_authored_context_cross_turn");
    },
  });
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "player_volatile_failure",
    eventId: "player_volatile_failure",
    text: "今天下雨了",
    locale: "zh-CN",
    timestampMs: 1,
  });
  // The companion's own turn outranks one turn of extra background.
  assert.equal(await loop.flush(), "completed");
});

test("CompanionLoop prints one delivery account per turn: the parts it had, the parts it showed, and why the rest were withheld", async () => {
  // The rule this measures: a piece the projection withholds must be COUNTED, and text that never
  // reached the projection at all must not read as a companion who chose silence. MEASURED
  // 2026-11-09 (round40, 34 minutes): 60 assistant text parts, 31 presented pieces, and nothing in
  // any artifact that said 47 of the 60 had been lost on the way.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const toolCall = { type: "toolCall", id: "tool_1", name: "action", arguments: {} };
  const presented: { text: string }[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        for (const [id, parts, stopReason] of [
          ["assistant_1", ["先出门去农场。"], "toolUse"],
          // A stage beat is the surface's own withholding: it cannot draw `*...*`.
          ["assistant_2", ["*转过身微笑*"], "toolUse"],
          ["assistant_3", ["花椰菜给她了。"], "stop"],
        ] as const) {
          const snapshot = { id, role: "assistant", content: [], stopReason: "pending" };
          emit({ type: "message_start", message: snapshot });
          parts.forEach((value, index) => {
            emit({
              type: "message_update",
              message: snapshot,
              assistantMessageEvent: { type: "text_start", contentIndex: index, partial: snapshot },
            });
            emit({
              type: "message_update",
              message: snapshot,
              assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: value, partial: snapshot },
            });
          });
          emit({
            type: "message_end",
            message: {
              id,
              role: "assistant",
              content: [
                ...parts.map((value) => ({ type: "text", text: value })),
                ...(stopReason === "stop" ? [] : [toolCall]),
              ],
              stopReason,
            },
          });
        }
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content as { text: string });
      },
    },
  );
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "input_delivery",
      eventId: "player_source_delivery",
      text: "去把菜收了",
      locale: "zh-CN",
      timestampMs: 1,
    });
    await loop.flush();
  } finally {
    process.stderr.write = stderrWrite;
  }

  const sound = selectReactionSound("player_source_delivery", "zh-CN", GAME_DELIVERY_PACING.reaction!);
  assert.deepEqual(
    presented.map((entry) => entry.text),
    [`${sound} 先出门去农场。 花椰菜给她了。`],
    "three messages answered this turn and the player got ONE bubble: the sound, then every message in order",
  );
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `no delivery account was printed; stderr was: ${printed}`);
  assert.deepEqual(JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)), {
    textParts: 3,
    presented: 2,
    suppressed: { empty_after_projection: 1 },
    // ONE bubble, and the roll-up that produced it: three messages carried text and the beat-only one was withheld, so
    // two delivered messages became the turn's single bubble. `suppressedBubbles` is empty BECAUSE the bubble arrived:
    // the two counts are the same event in the two units, and an empty map is a statement about the turn, not a silence.
    bubbles: 1,
    suppressedBubbles: {},
    messages: { count: 3, ids: ["assistant_1", "assistant_2", "assistant_3"] },
    bubble: { chars: `${sound} 先出门去农场。 花椰菜给她了。`.length, truncatedChars: 0, sentencesDropped: 0 },
    // The turn's own reason beside its delivery answer: the player's words are what admitted this turn, and the batch
    // carried no fact at all, so `carried` is empty rather than a list this test invented.
    lease: { admitted: true },
    carried: [],
  });
  // The three populations add up, so the turn states no mismatch: 2 presented + 1 withheld is 3 produced.
  assert.doesNotMatch(printed, /delivery_mismatch:/u);
  // And this bubble fitted, so no speech was deleted: the notice is a fact about a cut, never a line printed per turn.
  assert.doesNotMatch(printed, /speech_truncated:/u);
});

test("a turn past the transport's ceiling prints the loss it could not deliver", async () => {
  // MEASURED 2026-11-16 (`round62`, one session, 90 turns that carried text): 18 turns were cut and 533 characters were
  // deleted before the player saw them - at a ceiling of 80 that described no surface. The cut that remains is the
  // presentation transport's own (4,000 characters, `MAX_COMPANION_PRESENTATION_TEXT_CHARS`), and what this case pins is
  // that the loss is COUNTED on the account and named in the notice, one authority for both numbers.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const toolCall = { type: "toolCall", id: "tool_1", name: "action", arguments: {} };
  // Two sentences whose sum is past the ceiling and whose first one is not: the cut therefore lands on a real sentence
  // end and drops the second whole, which is the shape `sentencesDropped` counts.
  const said = Object.freeze([`${"这".repeat(2_000)}。`, `${"那".repeat(2_100)}。`]);
  const presented: { text: string }[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        said.forEach((value, index) => {
          const snapshot = { id: `assistant_${String(index)}`, role: "assistant", content: [], stopReason: "pending" };
          emit({ type: "message_start", message: snapshot });
          emit({
            type: "message_update",
            message: snapshot,
            assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
          });
          emit({
            type: "message_update",
            message: snapshot,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: value, partial: snapshot },
          });
          const last = index === said.length - 1;
          emit({
            type: "message_end",
            message: {
              id: `assistant_${String(index)}`,
              role: "assistant",
              content: [...[{ type: "text", text: value }], ...(last ? [] : [toolCall])],
              stopReason: last ? "stop" : "toolUse",
            },
          });
        });
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content as { text: string });
      },
    },
  );
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "input_truncation",
      eventId: "player_source_truncation",
      text: "去把菜收了",
      locale: "zh-CN",
      timestampMs: 1,
    });
    await loop.flush();
  } finally {
    process.stderr.write = stderrWrite;
  }

  const account =
    printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY ")) ??
    assert.fail(`no account; ${printed}`);
  const bubble = (
    JSON.parse(account.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)) as {
      bubble: { chars: number; truncatedChars: number; sentencesDropped: number };
    }
  ).bubble;
  // The loss is real before anything is asserted about the notice: her speech does not fit, the player got less.
  assert.ok(bubble.truncatedChars > 0, `this case must actually truncate; it dropped ${String(bubble.truncatedChars)}`);
  assert.ok(
    presented[0]!.text.length < said.join(" ").length,
    "the delivered bubble is shorter than what she said, which is the loss this notice is about",
  );

  const line = printed.split("\n").find((entry) => entry.startsWith("speech_truncated:"));
  assert.notEqual(line, undefined, `a cut turn printed no truncation notice; stderr was: ${printed}`);
  const [code, turn, chars, sentences] = line!.split(":");
  assert.equal(code, "speech_truncated");
  assert.equal(turn, "player_source_truncation", "the notice names the turn the player was short of speech on");
  // One authority for the numbers: the delivery account and the notice are the same measurement, so neither can drift.
  assert.equal(Number(chars), bubble.truncatedChars);
  assert.equal(Number(sentences), bubble.sentencesDropped);
  assert.ok(bubble.sentencesDropped > 0, "whole sentences were dropped, and the notice says how many");
});

test("a turn with no presentation source accounts for its text instead of leaving it in the remainder", async () => {
  // MEASURED 2026-11-09 (round40 `multiday_routine`, 40 minutes): 75 turns printed a delivery account,
  // 79 assistant text parts, 39 presented, and every one of the other 40 sat in `unaccounted` with
  // `suppressed` empty. They were not withheld by the projection: their turns carried no presentation
  // source at all (`canonicalPresentationSource` grants one only to a player input or a salient sensory
  // world fact), so no projection was ever attached and nothing else could report them. This is that
  // turn: a settlement-driven one, which is what most of that run's turns were.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const toolCall = { type: "toolCall", id: "tool_1", name: "action", arguments: {} };
  const presented: { text: string }[] = [];
  const loop = new CompanionLoop(
    {
      async sendUserMessage(text: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
        for (const [id, parts, stopReason] of [
          ["assistant_1", ["先出门去农场。"], "toolUse"],
          ["assistant_2", ["花椰菜给她了。"], "stop"],
        ] as const) {
          const snapshot = { id, role: "assistant", content: [], stopReason: "pending" };
          emit({ type: "message_start", message: snapshot });
          parts.forEach((value, index) => {
            emit({
              type: "message_update",
              message: snapshot,
              assistantMessageEvent: { type: "text_start", contentIndex: index, partial: snapshot },
            });
            emit({
              type: "message_update",
              message: snapshot,
              assistantMessageEvent: { type: "text_delta", contentIndex: index, delta: value, partial: snapshot },
            });
          });
          emit({
            type: "message_end",
            message: {
              id,
              role: "assistant",
              content: [
                ...parts.map((value) => ({ type: "text", text: value })),
                ...(stopReason === "stop" ? [] : [toolCall]),
              ],
              stopReason,
            },
          });
        }
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content as { text: string });
      },
    },
  );
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    loop.pump.enqueueFact(
      {
        source: "stardew_mod",
        kind: "execution_receipt",
        eventId: "receipt_harvest",
        sourceEventId: "receipt_harvest",
        correlationId: "receipt_harvest",
        revision: 7,
        executionId: "execution_harvest",
        payload: { state: "succeeded", actionId: "harvest_crop", reasonCode: "crop_harvested", revision: 7 },
      },
      FACT_PRODUCER.adapterIngress,
    );
    assert.equal(await loop.flush(), "completed");
  } finally {
    process.stderr.write = stderrWrite;
  }
  // Nothing could show these words, and the account says so by name rather than leaving them unstated: two parts
  // produced, none presented, both withheld by the one reason that explains them.
  assert.deepEqual(presented, []);
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `no delivery account was printed; stderr was: ${printed}`);
  assert.deepEqual(JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)), {
    textParts: 2,
    presented: 0,
    suppressed: { no_presentation_lease: 2 },
    bubbles: 0,
    // AND THE BUBBLE HAS ITS OWN REASON, which `bubbles: 0` could not state: the turn owed one bubble and the layer that
    // kept it is named beside the count, so this zero is a measured loss rather than an indistinguishable silence.
    suppressedBubbles: { no_presentation_lease: 1 },
    messages: { count: 2, ids: ["assistant_1", "assistant_2"] },
    // THE BUBBLE'S ANSWER, not an absence: no lease means no projection, and the turn says which way it ended.
    withheld: "no_presentation_lease",
    // `carried` names what the turn was made of: a receipt with nothing beside it, which is the class that has no lease.
    lease: { admitted: false },
    carried: ["execution_receipt"],
  });
  assert.doesNotMatch(printed, /delivery_mismatch:/u);
});

test("a part no layer could account for fails the turn's delivery identity, by name", async () => {
  // The identity is `presented + suppressed === produced`, checked against three independently measured populations
  // instead of being balanced by a residual. Here the projection never received the second message's
  // `message_start`, so it had no message to report: two parts were produced, one was presented, none was withheld.
  // The lost part is named where the account is printed rather than absorbed by a difference nobody reads.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  const loop = new CompanionLoop(
    {
      async sendUserMessage(batch: string) {
        emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
        for (const [id, text, withStart] of [
          ["assistant_1", "先出门去农场。", true],
          ["assistant_2", "花椰菜给她了。", false],
        ] as const) {
          const snapshot = { id, role: "assistant", content: [], stopReason: "pending" };
          if (withStart) {
            emit({ type: "message_start", message: snapshot });
            emit({
              type: "message_update",
              message: snapshot,
              assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
            });
            emit({
              type: "message_update",
              message: snapshot,
              assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: snapshot },
            });
          }
          emit({
            type: "message_end",
            message: { id, role: "assistant", content: [{ type: "text", text }], stopReason: "stop" },
          });
        }
        emit({ type: "agent_settled" });
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent() {},
    },
  );
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "input_mismatch",
      eventId: "player_source_mismatch",
      text: "去把菜收了",
      locale: "zh-CN",
      timestampMs: 1,
    });
    assert.equal(await loop.flush(), "completed");
  } finally {
    process.stderr.write = stderrWrite;
  }

  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `no delivery account was printed; stderr was: ${printed}`);
  assert.deepEqual(JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)), {
    textParts: 2,
    presented: 1,
    suppressed: {},
    bubbles: 1,
    suppressedBubbles: {},
    messages: { count: 2, ids: ["assistant_1", "assistant_2"] },
    bubble: {
      chars: `${selectReactionSound("player_source_mismatch", "zh-CN", GAME_DELIVERY_PACING.reaction!)} 先出门去农场。`
        .length,
      truncatedChars: 0,
      sentencesDropped: 0,
    },
    // The turn's own reason beside its answer: the player's words admitted it, and it carried no fact.
    lease: { admitted: true },
    carried: [],
  });
  assert.match(printed, /^delivery_mismatch:produced=2;presented=1;suppressed=0;missing=1$/mu);
});

/** A Pi session that answers whatever batch it is given with one assistant message saying `text`. */
function sessionSaying(text: string) {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(batch: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
      const snapshot = { id: "assistant_settlement", role: "assistant", content: [], stopReason: "pending" };
      emit({ type: "message_start", message: snapshot });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
      });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: snapshot },
      });
      emit({
        type: "message_end",
        message: {
          id: "assistant_settlement",
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
        },
      });
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: unknown) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

/** The delivery account one turn printed, captured around that turn's own flush. */
async function turnAccount(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = stderrWrite;
  }
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `no delivery account was printed; stderr was: ${printed}`);
  return JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)) as Record<string, unknown>;
}

/** The settled digest for one program, minted by the module that owns it rather than spelled here. */
function settledDigest(programId: string, nodeState: "succeeded" | "failed" | "rejected") {
  const digest = programSettledDigest({
    programId,
    settledAtMs: 4_242,
    compiled: [
      {
        nodeId: "n01",
        actionId: "move_to_tile",
        arguments: { x: { type: "integer", canonicalValue: "5" }, y: { type: "integer", canonicalValue: "8" } },
      },
    ],
    status: {
      code: "found",
      snapshot: {
        programId,
        state: nodeState,
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 90,
        nodes: [{ nodeId: "n01", state: nodeState }],
      },
    },
    nowMs: 7,
  });
  assert.notEqual(digest, undefined, "the settled digest must exist for this case to mean anything");
  return digest!;
}

test("a settled program opens a presentation lease, because an outcome nobody was told about does not exist", async () => {
  // BOTH OUTCOMES OPEN THEIR TURN NOW, so the refusal is no longer the only one that can host a lease: a successful
  // settlement opens one too (`event-pump.ts`, `SETTLED_PROGRAM_OUTCOMES`). The fixture keeps `rejected` because what this
  // test proves is the LEASE on the turn the answer opens, not the verdict inside it - that is the next test's subject.
  //
  // The lesson this test was written for still holds: a settlement batch must be granted a presentation lease rather than
  // the companion answering an outcome whose answer is counted as text nobody was shown - the shape round40 lost 40 of its
  // 79 parts to. That `program_settled` is in the lease allowlist is what the assertion below proves; that a SUCCESSFUL
  // settlement still reaches the player is the next test.
  const text = "程序跑完了，井也修好了。";
  const presented: { sourceEventId: string; text: string }[] = [];
  const loop = new CompanionLoop(sessionSaying(text) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content as { sourceEventId: string; text: string });
    },
  });
  const digest = settledDigest("plan_41", "rejected");
  loop.pump.enqueueFact(digest, FACT_PRODUCER.adapterIngress);
  const account = await turnAccount(() => loop.flush());

  assert.deepEqual(
    presented.map((entry) => entry.sourceEventId),
    [digest.sourceEventId],
    "the settlement's own identity is the lease the turn presents under",
  );
  assert.equal(presented.map((entry) => entry.text).join(""), text, "and the answer reaches the player");
  assert.deepEqual(account, {
    textParts: 1,
    presented: 1,
    suppressed: {},
    // One bubble, and no sound: a settlement batch carries no locale, so the reaction vocabulary has nothing to speak
    // and the bubble is her words alone. `suppressedBubbles` is empty because it arrived.
    bubbles: 1,
    suppressedBubbles: {},
    messages: { count: 1, ids: ["assistant_settlement"] },
    bubble: { chars: text.length, truncatedChars: 0, sentencesDropped: 0 },
    lease: { admitted: true },
    carried: ["world_fact"],
  });
});

test("a succeeded settlement is the programme's answer: one turn, its own lease, and the counts in the text", async () => {
  // THE RULING, IN THE HALF THAT USED TO BE SILENT. One call, one answer, and the answer is only an answer if she can read
  // it when it arrives (`design/fact-authority.md` §1c). A programme that did what it was told used to open nothing and wait
  // for some later decision to carry it; the verdict and its evidence now travel in the turn the settlement itself opens.
  // That is not `round57` again: it counted a turn per finished NODE, and those receipts are the programme's own rows in
  // `<execution-result>` now.
  const text = "都浇完了，回头再看一眼。";
  const presented: { sourceEventId: string; text: string }[] = [];
  const batches: string[] = [];
  const session = sessionSaying(text);
  const loop = new CompanionLoop(
    {
      ...session,
      async sendUserMessage(batch: string) {
        batches.push(batch);
        await session.sendUserMessage(batch);
      },
    } as never,
    {
      beginPlayerBatch() {},
      endBatch() {},
      async presentNativeAssistantContent(content) {
        presented.push(content as { sourceEventId: string; text: string });
      },
    },
  );
  const digest = settledDigest("plan_42", "succeeded");
  loop.pump.enqueueFact(digest, FACT_PRODUCER.adapterIngress);
  await loop.flush();

  assert.equal(loop.pump.turnAccount.opened, 1, "the programme's one answer opens exactly one turn");
  assert.equal(batches.length, 1, "and that turn is where Pi is asked, immediately - not some later decision's turn");
  assert.match(batches[0]!, /<execution-result>\n/u, "carrying the settlement's outcome, not a summary of it");
  assert.match(batches[0]!, /1\/1 步做成了/u, "in the producer's own counts");
  assert.deepEqual(
    presented.map((entry) => entry.sourceEventId),
    [digest.sourceEventId],
    "and the answer reaches the player under the settlement's OWN lease identity",
  );
  assert.equal(
    loop.pump.turnAccount.notOwed[NOT_OWED.progress],
    0,
    `nothing about this turn is counted as progress: ${turnAccountLine(loop.pump.turnAccount)}`,
  );
});

test("an ordinary execution outcome still opens no lease, so volume cannot creep", async () => {
  // The one kind added is the settlement. Every other outcome keeps today's silence: the account names
  // it, and nothing is presented - a lease granted to `execution_settled_succeeded` would put a bubble
  // on every harvested crop, which is the volume this allowlist exists to bound.
  const presented: unknown[] = [];
  const loop = new CompanionLoop(sessionSaying("草割完了。") as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content);
    },
  });
  loop.pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "semantic_event",
      eventId: "execution_settled_1",
      sourceEventId: "execution_settled_1",
      correlationId: "execution_settled_1",
      revision: 9,
      occurredAtMs: 5,
      payload: { kind: "execution_settled_succeeded", executionId: "execution_1" },
    },
    FACT_PRODUCER.adapterIngress,
  );
  const account = await turnAccount(() => loop.flush());

  assert.deepEqual(presented, []);
  assert.deepEqual(account, {
    textParts: 1,
    presented: 0,
    suppressed: { no_presentation_lease: 1 },
    bubbles: 0,
    // The bubble this turn owed, and the layer that kept it: `bubbles: 0` alone said only that nothing was drawn.
    suppressedBubbles: { no_presentation_lease: 1 },
    messages: { count: 1, ids: ["assistant_settlement"] },
    withheld: "no_presentation_lease",
    // The turn's own reason, beside the loss: a semantic event is not a presentation source, so this turn carried only
    // the verdict and had no surface to speak into - which is what the model is now told before it answers.
    lease: { admitted: false },
    carried: ["semantic_event"],
  });
});

test("the account names every piece the player was shown, not only the message parts behind them", async () => {
  // MEASURED 2026-11-09 (round41 `multiday_routine`): `presentation.pieceCount` 59, `AGENT_PRESENTATION_PIECE` 59 lines,
  // `sessionTurns[].spokenLines` 59 - and 13 `NATIVE_COMPANION_TURN_DELIVERY` records accounting `textParts` 46,
  // `presented` 46, `unaccounted` 0. The account's population was the message PARTS and the run's population was the
  // committed PIECES: the 59 were 11 reaction sounds (one per paced turn, `companion-delivery-pacing.ts`
  // `GAME_DELIVERY_PACING.reaction` -> `native-companion-content.ts` `emitReaction`), 46 paragraphs, and 2 extra pieces
  // from a paragraph the length budget split. A reader comparing the two numbers could only conclude that thirteen
  // pieces - a whole turn's worth - had no record at all, which is how this was reported. The pieces belong in the
  // account that claims to be a partition.
  const text = "先出门去农场。";
  const presented: { text: string }[] = [];
  const loop = new CompanionLoop(sessionSaying(text) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content as { text: string });
    },
  });
  const account = await turnAccount(async () => {
    loop.pump.enqueuePlayerInput({
      source: "player_text",
      inputId: "input_piece_account",
      eventId: "player_source_piece_account",
      text: "去把菜收了",
      locale: "zh-CN",
      timestampMs: 1,
    });
    await loop.flush();
  });

  const sound = selectReactionSound("player_source_piece_account", "zh-CN", GAME_DELIVERY_PACING.reaction!);
  assert.deepEqual(
    presented.map((entry) => entry.text),
    [`${sound} ${text}`],
    "this turn presented ONE bubble: the sound at the head of her words, not a bubble of its own",
  );
  // The parts partition and the bubbles stay two separate facts, both published: one message part was presented, and it
  // reached the player inside the turn's single bubble. `bubbles` is what the presentation port committed, which is the
  // number a run's `presentation.pieceCount` adds up.
  assert.equal(account.textParts, 1, "the population the suppressor reasons count");
  assert.equal(account.presented, 1, "and how many of those parts the player was shown");
  assert.equal(account.bubbles, 1, "one prompt turn, one bubble");
});

test("a turn that ran with no projection is named, so its text is never an unexplained remainder", async () => {
  // The other half of the same requirement: a turn the observer never attached to must carry its own reason word rather
  // than vanish from the log. `no_presentation_lease` is that word, and this pins that a turn with NO presentation
  // source still prints an account - the alternative reading of round41 was "a turn produced text and no record", which
  // would be indistinguishable from a lost turn.
  const loop = new CompanionLoop(sessionSaying("草割完了。") as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent() {},
  });
  const account = await turnAccount(async () => {
    loop.pump.enqueueFact(
      {
        source: "stardew_mod",
        kind: "semantic_event",
        eventId: "execution_settled_account",
        sourceEventId: "execution_settled_account",
        correlationId: "execution_settled_account",
        revision: 11,
        occurredAtMs: 5,
        payload: { kind: "execution_settled_succeeded", executionId: "execution_account" },
      },
      FACT_PRODUCER.adapterIngress,
    );
    await loop.flush();
  });
  assert.deepEqual(account, {
    textParts: 1,
    presented: 0,
    suppressed: { no_presentation_lease: 1 },
    bubbles: 0,
    // The bubble this turn owed, and the layer that kept it: `bubbles: 0` alone said only that nothing was drawn.
    suppressedBubbles: { no_presentation_lease: 1 },
    messages: { count: 1, ids: ["assistant_settlement"] },
    withheld: "no_presentation_lease",
    // The turn's own reason, beside the loss: a semantic event is not a presentation source, so this turn carried only
    // the verdict and had no surface to speak into - which is what the model is now told before it answers.
    lease: { admitted: false },
    carried: ["semantic_event"],
  });
});

/**
 * A Pi turn that DOES something and says nothing: the tool call fires, the message asks for it, and no atom of text.
 *
 * <p>
 * The shape is the one `round58` produced 21 of, one per opened turn: `NATIVE_COMPANION_TURN_DELIVERY {"textParts":1,
 * "presented":1,"bubbles":1}` on every one of them, so the run had no way to tell a turn spent working from a turn spent
 * talking. Nothing in the loop refuses this shape - `PROVIDER_EMPTY_COMPLETION` excludes a message that asked for a tool -
 * so what this fixture pins is only what the turn is COUNTED as.
 * </p>
 */
function sessionActingWithoutSpeech() {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(batch: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
      const snapshot = { id: "assistant_silent_work", role: "assistant", content: [], stopReason: "pending" };
      emit({ type: "message_start", message: snapshot });
      emit({ type: "tool_execution_start", toolCallId: "call_silent", toolName: "stardew_plan_work" });
      emit({ type: "tool_execution_end", toolCallId: "call_silent", toolName: "stardew_plan_work" });
      emit({
        type: "message_end",
        message: {
          id: "assistant_silent_work",
          role: "assistant",
          content: [{ type: "toolCall", id: "call_silent", name: "stardew_plan_work", arguments: {} }],
          stopReason: "toolUse",
        },
      });
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: unknown) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

test("acting_turn_settled_silent_is_unreachable: a turn that acted and said nothing settles as silence, not as a bubble", async () => {
  // MEASURED 2026-11-15 (`round58`): 21 turns opened, 21 bubbles, 145 flushes, `turn_closed_without_action` 0 and
  // `turn_settled_silent` 0 - every turn both acted and spoke, and the account had one counter for the speak-without-act
  // shape and none for the act-without-speaking shape. A turn that acts and chooses not to narrate it landed nowhere: it
  // was not an empty turn (`worked` outranks `spoke` in the loop's own publication), not a silent one (that counter read
  // `said_nothing`, a state no completed turn can reach), and not a suppression.
  const presented: unknown[] = [];
  const loop = new CompanionLoop(sessionActingWithoutSpeech() as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content);
    },
  });
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    // A REFUSED settlement, because this test is about the TURN and not about the verdict inside it: either outcome opens
    // one now, and the refusal is the shape whose text the assertion below reads most plainly (a `rejected` row is named
    // where a `succeeded` one is only counted).
    loop.pump.enqueueFact(settledDigest("plan_58", "rejected"), FACT_PRODUCER.adapterIngress);
    await loop.flush();
  } finally {
    process.stderr.write = stderrWrite;
  }

  assert.deepEqual(presented, [], "she said nothing, so the player is shown nothing: silence is not a bubble");
  assert.equal(
    printed.includes("NATIVE_COMPANION_TURN_DELIVERY"),
    false,
    `a turn with no speech has no delivery to account for: ${printed}`,
  );
  const account = loop.pump.turnAccount;
  assert.equal(account.opened, 1, "the settlement opened a turn, so the silence happened inside one");
  assert.equal(account.emptyTurns.total, 0, "she acted: this is not the turn she spent on speech");
  assert.equal(
    account.silentSettled.total,
    1,
    `the acting-and-silent turn is counted as silence: ${turnAccountLine(account)}`,
  );
  assert.equal(account.silentSettled.byOpener[TURN_OPENING.worldFact], 1, "and under the opener that owed the turn");
  assert.ok(
    turnAccountLine(account).includes(`· ${TURN_SETTLED_SILENT} 1 {world_fact: 1,`),
    `the run's own account line can say it: ${turnAccountLine(account)}`,
  );
});

/**
 * A batch carrying TWO assistant records: it says one line, then runs a tool and says nothing about it.
 *
 * This is `round60`'s 85 `tool_use` records in miniature: 49 of them carried a line and 36 did not, and the batch that
 * held them was `worked` either way. The record order is Pi's own - a message ends, its tool runs, the next message follows
 * - so the silence is the SECOND record, inside a turn that spoke earlier.
 */
function sessionSpeakingThenWorkingSilently(text: string) {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(batch: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
      const spoken = { id: "assistant_said_a_line", role: "assistant", content: [], stopReason: "pending" };
      emit({ type: "message_start", message: spoken });
      emit({
        type: "message_update",
        message: spoken,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: spoken },
      });
      emit({
        type: "message_update",
        message: spoken,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: spoken },
      });
      emit({
        type: "message_end",
        message: {
          id: "assistant_said_a_line",
          role: "assistant",
          content: [{ type: "text", text }],
          stopReason: "stop",
        },
      });
      emit({ type: "tool_execution_start", toolCallId: "call_after_the_line", toolName: "stardew_plan_work" });
      emit({ type: "tool_execution_end", toolCallId: "call_after_the_line", toolName: "stardew_plan_work" });
      emit({
        type: "message_end",
        message: {
          id: "assistant_worked_silently",
          role: "assistant",
          content: [{ type: "toolCall", id: "call_after_the_line", name: "stardew_plan_work", arguments: {} }],
          stopReason: "toolUse",
        },
      });
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: unknown) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

/**
 * THE DEFECT THIS UNIT EXISTS FOR, end to end through the real loop: one batch, two assistant records, one silence.
 *
 * <p>
 * MEASURED 2026-11-15 (`round60`): 169 assistant turns, 133 with text, 36 tool-only - and the account printed
 * `turn_settled_silent 0`, because the pump re-segmented the same run into 86 delivered batches and every one of those 36
 * sat inside a batch that also carried a line. Through the BATCH this fixture is `worked` (any text in it speaks for all
 * of it), which is the reading that made the silence invisible; per assistant record it is one `spoke` and one
 * `worked_silently`.
 * </p>
 */
test("assistant turns: a batch that speaks and then works silently reads as with text 1 · tool-only 1", async () => {
  const text = "先把这片浇了。";
  const loop = new CompanionLoop(sessionSpeakingThenWorkingSilently(text) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent() {},
  });
  const stderrWrite = process.stderr.write;
  let printed = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    printed += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    // A refused settlement, for the same reason as the pair above: either outcome opens its own turn now, and this
    // fixture is about what a TURN's two records are.
    loop.pump.enqueueFact(settledDigest("plan_60_two_records", "rejected"), FACT_PRODUCER.adapterIngress);
    await loop.flush();
  } finally {
    process.stderr.write = stderrWrite;
  }

  const account = loop.pump.turnAccount;
  assert.equal(account.opened, 1, "the premise: ONE delivered batch carried both records");
  assert.equal(
    loop.pump.turnProduction,
    TURN_PRODUCTION.worked,
    "and in the batch's unit it is `worked` - it said something, so no batch-shaped counter can call it silence",
  );
  assert.deepEqual(
    account.assistantTurns.byProduction,
    {
      [TURN_PRODUCTION.worked]: 0,
      [TURN_PRODUCTION.workedSilently]: 1,
      [TURN_PRODUCTION.spoke]: 1,
      [TURN_PRODUCTION.saidNothing]: 0,
    },
    `each assistant record is one turn: ${turnAccountLine(account)}`,
  );
  assert.equal(account.assistantTurns.examined, 2, "two records, one batch: the two numbers are not the same fact");
  assert.equal(assistantTurnsWithText(account.assistantTurns), 1);
  assert.equal(assistantTurnsToolOnly(account.assistantTurns), 1);
  assert.equal(
    account.silentSettled.total,
    0,
    "and the batch counter still reads 0 - which is why it could never have answered this question",
  );
  assert.ok(
    printed.includes(
      `${ASSISTANT_TURNS_EXAMINED} 2 {worked: 0, worked_silently: 1, spoke: 1, said_nothing: 0} · ${ASSISTANT_TURNS_WITH_TEXT} 1 · ${ASSISTANT_TURNS_TOOL_ONLY} 1`,
    ),
    `the run's own account line states it, in its own unit: ${printed}`,
  );
  assert.ok(
    printed.includes(`${PER_DELIVERED_BATCH} turns opened 1 {`),
    `and the batch group that follows is named as batches: ${printed}`,
  );
});

/**
 * The same turn with one word in it: the act stays, the silence goes. It exists to make the gate above falsifiable - a
 * counter that fired on every acting turn would pass there and fail here.
 */
function sessionActingAndSpeaking(text: string) {
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(batch: string) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text: batch }] } });
      const snapshot = { id: "assistant_spoken_work", role: "assistant", content: [], stopReason: "pending" };
      emit({ type: "message_start", message: snapshot });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: snapshot },
      });
      emit({
        type: "message_update",
        message: snapshot,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: snapshot },
      });
      emit({ type: "tool_execution_start", toolCallId: "call_spoken", toolName: "stardew_plan_work" });
      emit({ type: "tool_execution_end", toolCallId: "call_spoken", toolName: "stardew_plan_work" });
      emit({
        type: "message_end",
        message: {
          id: "assistant_spoken_work",
          role: "assistant",
          content: [
            { type: "text", text },
            { type: "toolCall", id: "call_spoken", name: "stardew_plan_work", arguments: {} },
          ],
          stopReason: "toolUse",
        },
      });
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: unknown) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

test("acting_turn_settled_silent_is_unreachable: the same act WITH a word is not silence, and it is not a different turn", async () => {
  // THE FALSIFIER for the gate above, on the same fixture with exactly one thing changed: she says a line while she works.
  // If the counter fired on acting turns rather than on silent ones, the assertion in the gate would be the one that broke;
  // if the loop published `workedSilently` for a turn that carried text, this is the case that says so.
  const presented: { text: string }[] = [];
  const text = "先把这片浇了。";
  const loop = new CompanionLoop(sessionActingAndSpeaking(text) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content as { text: string });
    },
  });
  const account = await turnAccount(async () => {
    // A refused settlement, for the same reason as its gate above: either outcome opens its own turn now, and this pair
    // is about what a TURN settles as.
    loop.pump.enqueueFact(settledDigest("plan_58_spoken", "rejected"), FACT_PRODUCER.adapterIngress);
    await loop.flush();
  });

  assert.equal(account.bubbles, 1, "one turn, one bubble - the shape round58 measured 21 of");
  assert.equal(presented.length, 1, "and the player saw the line she said while working");
  assert.equal(
    loop.pump.turnAccount.silentSettled.total,
    0,
    `a turn that acted AND spoke is not silence: ${turnAccountLine(loop.pump.turnAccount)}`,
  );
  assert.equal(loop.pump.turnAccount.emptyTurns.total, 0, "and it is not a turn spent on speech instead of work");
  assert.equal(
    loop.pump.turnAccount.assistantTurns.byProduction[TURN_PRODUCTION.worked],
    1,
    "the per-assistant-turn tally agrees with the batch counter exactly where the batch COULD see the turn",
  );
});
