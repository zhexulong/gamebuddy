import assert from "node:assert/strict";
import test from "node:test";
import { CompanionLoop } from "./companion-loop.js";

function settledSession(
  handler: (text: string, options?: { deliverAs?: string }) => Promise<void> | void = async () => {},
) {
  const listeners = new Set<(event: { type: string; messages?: readonly unknown[]; message?: unknown; assistantMessageEvent?: unknown }) => void>();
  const emit = (event: { type: string; messages?: readonly unknown[]; message?: unknown; assistantMessageEvent?: unknown }) => {
    for (const listener of [...listeners]) listener(event);
  };
  return {
    async sendUserMessage(text: string, options?: { deliverAs?: string }) {
      emit({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
      await handler(text, options);
      emit({ type: "agent_settled" });
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
    subscribe(next: (event: { type: string; messages?: readonly unknown[]; message?: unknown; assistantMessageEvent?: unknown }) => void) {
      listeners.add(next);
      return () => {
        listeners.delete(next);
      };
    },
  };
}

test("CompanionLoop explicitly steers player input and includes the latest snapshot", async () => {
  const received: Array<{ text: string; deliverAs?: string }> = [];
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
        const trackedPartial = { id: "assistant_1", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
          message: { id: "assistant_1", role: "assistant", content: [{ type: "text", text: "I am here." }], stopReason: "stop" },
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
  assert.deepEqual(presented, [{ sourceEventId: "player_source_1", text: "I am here." }]);
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
        const trackedPartial = { id: "assistant_voice", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
  assert.deepEqual(presented, [{ sourceEventId: "player_source_voice", text: "早安" }]);
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
        const trackedPartial = { id: "assistant_incr", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
  assert.deepEqual(presented, [
    { sourceEventId: "player_source_incr", text: "早安!" },
    { sourceEventId: "player_source_incr", text: "今天下雨。" },
  ]);
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
        const trackedPartial = { id: "assistant_residual", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
  assert.deepEqual(presented, [{ sourceEventId: "player_source_residual", text: "我这就去" }]);
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
        const trackedPartial = { id: "assistant_chunk", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
  // Two incremental presentations, then the buffered residual as the last piece.
  assert.deepEqual(presented, [
    { sourceEventId: "player_source_chunk", text: "我这就去南瓜地浇水。" },
    { sourceEventId: "player_source_chunk", text: "把杂草也一起拔了。" },
    { sourceEventId: "player_source_chunk", text: "然后把种子撒上" },
  ]);
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
        const trackedPartial = { id: "assistant_dup", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
  // Three identical incremental sentences plus one residual piece, in order.
  assert.deepEqual(presented, [
    { sourceEventId: "player_source_dup", text: "好。" },
    { sourceEventId: "player_source_dup", text: "好。" },
    { sourceEventId: "player_source_dup", text: "好。" },
    { sourceEventId: "player_source_dup", text: "好" },
  ]);
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
        const trackedPartial = { id: "assistant_salient_1", role: "assistant", content: [{ type: "text", text: "" }], stopReason: "stop" };
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
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "早安!今天也要加油。", partial: trackedPartial },
        });
        emit({
          type: "message_end",
          message: { id: "assistant_salient_1", role: "assistant", content: [{ type: "text", text: "早安!今天也要加油。" }], stopReason: "stop" },
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
  assert.deepEqual(presented, [
    { sourceEventId: "day_started_day_3", text: "早安!" },
    { sourceEventId: "day_started_day_3", text: "今天也要加油。" },
  ]);
});

test("CompanionLoop steers a busy Pi session without aborting it", async () => {
  const received: Array<{ deliverAs?: string }> = [];
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
  const received: Array<{ deliverAs?: string }> = [];
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
