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
  // World-trigger batches deliberately cannot mint a native player-chat
  // presentation lineage; only Pi-consumed authenticated player input can.
  assert.deepEqual(observed, []);
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
