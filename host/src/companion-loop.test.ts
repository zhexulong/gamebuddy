import assert from "node:assert/strict";
import test from "node:test";
import { GAME_DELIVERY_PACING, selectReactionSound } from "./companion-delivery-pacing.js";
import { CompanionLoop } from "./companion-loop.js";
import { MAGIC_CONTEXT_REFUSED_TURN_ENTRY_TYPE } from "./companion-turn-refusal.js";
import { programSettledDigest } from "./program-settlement-digest.js";

/**
 * What the player receives for one Game turn: that turn's reaction sound, then the words.
 *
 * The sound is derived from the turn's own identity through the same authority that selects it at
 * delivery time, so this does not spell a second copy of the vocabulary; what the assertion below
 * pins is that the sound arrives FIRST and belongs to the same source event as the reply, not which
 * interjection a particular hash happens to pick.
 */
function presentedWithReaction(sourceEventId: string, locale: string, text: string): readonly unknown[] {
  const sound = selectReactionSound(sourceEventId, locale, GAME_DELIVERY_PACING.reaction!);
  assert.notEqual(sound, null, `${locale} must have a reaction vocabulary for this case to assert one`);
  return [
    { sourceEventId, text: sound },
    { sourceEventId, text },
  ];
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
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snapshot_01",
    revision: 3,
    payload: { location: "Farm" },
  });
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
  const batch = JSON.parse(received[0]?.text ?? "{}") as {
    disposition?: string;
    worldFacts?: unknown[];
    playerInputs?: unknown[];
  };
  assert.equal(batch.disposition, "steer");
  assert.equal(batch.worldFacts?.length, 1);
  assert.equal(batch.playerInputs?.length, 1);
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
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: "world_later",
    sourceEventId: "world_later",
    correlationId: "world",
    revision: 1,
    occurredAtMs: 3,
    payload: { kind: "warped" },
  });
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
  // for every Game presenter), so completed sentences present immediately.
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

test("CompanionLoop presents only the buffered residual when no sentence ever completed", async () => {
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
        // No boundary arrives before message_end: nothing presents
        // incrementally, and the whole stream commits once as the residual.
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
  assert.deepEqual(presented, presentedWithReaction("player_source_residual", "zh-CN", "我这就去"));
});

test("CompanionLoop presents incremental sentences as they arrive and the message_end residual last", async () => {
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
        // The stream completes two sentences inside one delta; each presents
        // immediately. The last sentence loses its boundary to message_end, so
        // it stays buffered and lands as the single residual final piece.
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
  // One finished reply, one presented piece: the buffered sentences and the
  // unbounded tail are joined instead of arriving as a burst of fragments.
  assert.deepEqual(
    presented,
    presentedWithReaction("player_source_chunk", "zh-CN", "我这就去南瓜地浇水。把杂草也一起拔了。然后把种子撒上"),
  );
});

test("CompanionLoop finalizes the voice job exactly once with identical incremental sentences and one residual", async () => {
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
        // Three identical sentences complete incrementally; the trailing "好"
        // without its boundary stays buffered as the message_end residual.
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
  // One paragraph piece, even though three identical sentences completed first.
  assert.deepEqual(presented, presentedWithReaction("player_source_dup", "zh-CN", "好。好。好。好"));
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
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    eventId: "snapshot",
    sourceEventId: "snapshot_source",
    correlationId: "snapshot",
    revision: 1,
    occurredAtMs: 1,
    payload: {},
  });
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: "progress",
    sourceEventId: "progress_source",
    correlationId: "progress",
    revision: 1,
    occurredAtMs: 2,
    payload: { state: "meaningful_progress" },
  });
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: "fallback_event",
    correlationId: "first",
    revision: 1,
    occurredAtMs: 3,
    payload: {},
  });
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "lifecycle",
    eventId: "lifecycle_event",
    sourceEventId: "world_canonical",
    correlationId: "last",
    revision: 1,
    occurredAtMs: 4,
    payload: {},
  });
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
  loop.pump.enqueueFact({
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
  });
  await loop.flush();
  // The Mod reads the NPC's own lines, so the typed fact reaches Pi's exact
  // context with its readable payload. But `npc_dialogue_presented` is
  // deliberately NOT in the isSalientSensoryKind allowlist: the companion turn
  // runs without a native presentation lineage, so the Agent can act on the
  // dialogue (e.g. answer_dialogue) but cannot voice a spoken reaction to it.
  assert.equal(received.length, 1);
  assert.deepEqual(lineage, []);
  const batch = JSON.parse(received[0] ?? "{}") as { worldFacts: Array<{ payload: { speaker?: string } }> };
  assert.equal(batch.worldFacts[0]?.payload.speaker, "Pierre");
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
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "day_started_day_3",
    sourceEventId: "day_started_day_3",
    correlationId: "day_started_day_3",
    revision: 2,
    occurredAtMs: 1,
    semanticKind: "day_started",
    payload: { day: 3 },
  });
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
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "warp",
    revision: 1,
    payload: { kind: "warped" },
  });
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
  const batchId = (JSON.parse(delivered ?? "{}") as { batchId?: string }).batchId;
  assert.equal(typeof batchId, "string");
  assert.equal(bound[0]?.turnId, batchId);
  assert.deepEqual(cleared, [batchId]);
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
    [sound, "先出门去农场。", "花椰菜给她了。"],
    "the beat-only message presents nothing, and every other message presents its whole text",
  );
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `no delivery account was printed; stderr was: ${printed}`);
  assert.deepEqual(JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)), {
    textParts: 3,
    presented: 2,
    suppressed: { empty_after_projection: 1 },
    unaccounted: 0,
    // Three pieces reached the player: this turn's reaction sound, its one working remark (the first paragraph, released
    // mid-message after a real silence), and the paragraph that committed at the end. The beat-only message is the
    // withheld part, so it contributes no piece at all.
    pieces: { text: 1, ahead: 2 },
  });
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
    loop.pump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      eventId: "receipt_harvest",
      sourceEventId: "receipt_harvest",
      correlationId: "receipt_harvest",
      revision: 7,
      executionId: "execution_harvest",
      payload: { state: "succeeded", actionId: "harvest_crop", reasonCode: "crop_harvested", revision: 7 },
    });
    assert.equal(await loop.flush(), "completed");
  } finally {
    process.stderr.write = stderrWrite;
  }
  // Nothing could show these words, and the account says so by name rather than leaving them in the
  // remainder: the sum invariant is `presented + Σsuppressed + unaccounted === textParts`, and the
  // remainder of a turn that was measured is zero.
  assert.deepEqual(presented, []);
  const line = printed.split("\n").find((entry) => entry.startsWith("NATIVE_COMPANION_TURN_DELIVERY "));
  assert.notEqual(line, undefined, `no delivery account was printed; stderr was: ${printed}`);
  assert.deepEqual(JSON.parse(line!.slice("NATIVE_COMPANION_TURN_DELIVERY ".length)), {
    textParts: 2,
    presented: 0,
    suppressed: { no_presentation_lease: 2 },
    unaccounted: 0,
    pieces: { text: 0, ahead: 0 },
  });
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
function settledDigest(programId: string, nodeState: "succeeded" | "failed") {
  const digest = programSettledDigest({
    programId,
    settledAtMs: 4_242,
    directiveId: null,
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
  // The pump already treats a settlement as news that opens a turn (`event-pump.ts:isHeldProgressFact`:
  // `program_settled` is deliberately not held). The presentation lease disagreed, so the companion was
  // asked to answer an outcome and the answer was counted as text nobody was shown - the exact shape
  // round40 lost 40 of its 79 parts to. The presenter below is the only thing that can report delivery,
  // so the lease and the delivery are two separate facts and both are asserted.
  const text = "程序跑完了，井也修好了。";
  const presented: { sourceEventId: string; text: string }[] = [];
  const loop = new CompanionLoop(sessionSaying(text) as never, {
    beginPlayerBatch() {},
    endBatch() {},
    async presentNativeAssistantContent(content) {
      presented.push(content as { sourceEventId: string; text: string });
    },
  });
  const digest = settledDigest("plan_41", "succeeded");
  loop.pump.enqueueFact(digest);
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
    unaccounted: 0,
    // One paragraph and no sound: a settlement batch carries no locale, so the reaction vocabulary has nothing to
    // speak and the surface correctly emits nothing ahead of the words.
    pieces: { text: 1, ahead: 0 },
  });
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
  loop.pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: "execution_settled_1",
    sourceEventId: "execution_settled_1",
    correlationId: "execution_settled_1",
    revision: 9,
    occurredAtMs: 5,
    payload: { kind: "execution_settled_succeeded", executionId: "execution_1" },
  });
  const account = await turnAccount(() => loop.flush());

  assert.deepEqual(presented, []);
  assert.deepEqual(account, {
    textParts: 1,
    presented: 0,
    suppressed: { no_presentation_lease: 1 },
    unaccounted: 0,
    pieces: { text: 0, ahead: 0 },
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
    [sound, text],
    "this turn presented two pieces: the sound, then the paragraph",
  );
  // The parts partition and the pieces stay two separate facts, both published: one message part was presented, and it
  // reached the player as one piece BEHIND the sound this turn opened with. `pieces.text + pieces.ahead` is what the
  // presentation port committed, which is the number a run's `presentation.pieceCount` adds up.
  assert.equal(account.textParts, 1, "the population the suppressor reasons count");
  assert.equal(account.presented, 1, "and how many of those parts the player was shown");
  assert.deepEqual(account.pieces, { text: 1, ahead: 1 }, "the pieces, named by where they came from");
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
    loop.pump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      eventId: "execution_settled_account",
      sourceEventId: "execution_settled_account",
      correlationId: "execution_settled_account",
      revision: 11,
      occurredAtMs: 5,
      payload: { kind: "execution_settled_succeeded", executionId: "execution_account" },
    });
    await loop.flush();
  });
  assert.deepEqual(account, {
    textParts: 1,
    presented: 0,
    suppressed: { no_presentation_lease: 1 },
    unaccounted: 0,
    pieces: { text: 0, ahead: 0 },
  });
});
