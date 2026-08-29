import assert from "node:assert/strict";
import test from "node:test";
import { createCompanionInterruption } from "./companion-interruption.js";
import { CompanionLoop } from "./companion-loop.js";
import type { WorldFact } from "./event-pump.js";
import {
  CompanionHostService,
  createGamePresentationAdmissionProvider,
  GameTurnLineageTracker,
} from "./host-service.js";

function reducedSession(sendUserMessage: (text: string) => Promise<void> | void) {
  return { sendUserMessage, async abort() {}, clearQueue() {}, async waitForIdle() {} };
}

function eventHarness() {
  let factListener: ((fact: WorldFact) => void) | undefined;
  let lifecycleListener: ((event: { state: "disconnected"; reasonCode: string }) => void) | undefined;
  return {
    events: {
      onFact(next: (fact: WorldFact) => void) {
        factListener = next;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle(next: (event: { state: "disconnected"; reasonCode: string }) => void) {
        lifecycleListener = next;
        return () => {
          lifecycleListener = undefined;
        };
      },
    },
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
    disconnect(reasonCode = "adapter_closed") {
      lifecycleListener?.({ state: "disconnected", reasonCode });
    },
  };
}

function fakeLoop() {
  const facts: unknown[] = [];
  const inputs: unknown[] = [];
  let flushes = 0;
  return {
    loop: {
      pump: {
        pendingCount: 0,
        enqueueFact(fact: unknown) {
          facts.push(fact);
        },
        enqueuePlayerInput(input: unknown) {
          inputs.push(input);
        },
      },
      async flush() {
        flushes++;
      },
    },
    facts,
    inputs,
    get flushes() {
      return flushes;
    },
  };
}

const snapshot = (revision: number): WorldFact => ({
  source: "arcade_adapter",
  kind: "snapshot",
  eventId: `snapshot_${revision}`,
  occurredAtMs: Date.now(),
  correlationId: `snapshot_${revision}`,
  revision,
  payload: { revision, zone: "alpha" },
});

test("Stardew authenticated typed player input and stop facts map to Host ingress", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const loop = { ...harness.loop, async abortAndClear() {} };
  const interruption = createCompanionInterruption();
  const service = new CompanionHostService(
    loop as never,
    adapter.events,
    undefined,
    interruption,
    async () => undefined,
    async () => undefined,
  );
  service.attachVoiceStopper(async () => undefined);
  adapter.emit({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "input_fact",
    revision: 1,
    payload: {
      kind: "player_input",
      playerControl: {
        kind: "player_input",
        controlId: "input_1",
        sourceEventId: "source_1",
        text: "Go mine.",
        locale: "en-US",
        issuerPlayerId: "host",
      },
    },
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(harness.inputs.length, 1);
  adapter.emit({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "stop_fact",
    revision: 2,
    payload: {
      kind: "stop_all",
      playerControl: {
        kind: "stop_all",
        controlId: "stop_1",
        sourceEventId: "source_2",
        locale: "en-US",
        issuerPlayerId: "host",
      },
    },
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(harness.inputs.length, 1);
  service.close();
});

test("authenticated Stardew STOP presents fixed locale-aware system copy after cancellation settles", async () => {
  const adapter = eventHarness();
  const loop = { ...fakeLoop().loop, async abortAndClear() {} };
  const service = new CompanionHostService(
    loop as never,
    adapter.events,
    undefined,
    createCompanionInterruption(),
    async () => undefined,
    async () => undefined,
  );
  const notices: unknown[] = [];
  service.attachVoiceStopper(async () => undefined);
  service.attachStopSystemNoticePresenter(async (notice, noticeId) => {
    notices.push({ notice, noticeId });
  });
  adapter.emit({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "stop_notice_active",
    revision: 1,
    payload: {
      kind: "stop_all",
      playerControl: {
        kind: "stop_all",
        controlId: "stop_notice_active",
        sourceEventId: "source_notice_active",
        locale: "zh-CN",
        issuerPlayerId: "host",
      },
    },
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(notices, [
    {
      noticeId: "stop_notice_active",
      notice: {
        key: "system.stop.no_active_turn",
        locale: "zh-CN",
        text: "当前没有正在生成的回复。",
      },
    },
  ]);
  service.close();
});

test("STOP presents the active outcome and isolates a failed native notice presenter", async () => {
  const createService = () => {
    const adapter = eventHarness();
    const service = new CompanionHostService(
      { ...fakeLoop().loop, async abortAndClear() {} } as never,
      adapter.events,
      undefined,
      createCompanionInterruption(),
      async () => undefined,
      async () => undefined,
    );
    service.attachVoiceStopper(async () => undefined);
    return service;
  };

  const active = createService();
  const activeNotices: unknown[] = [];
  active.attachStopSystemNoticePresenter(async (notice, noticeId) => {
    activeNotices.push({ notice, noticeId });
  });
  active.beginPlayerBatch("source_active_notice", "batch_active_notice");
  const activeStop = active.stopAll({
    stopId: "stop_active_notice",
    sourceEventId: "source_active_notice",
    reasonCode: "player_stop_all",
    locale: "en-US",
  });
  assert.equal(activeStop.outcome, "active_turn_cancelled");
  await activeStop.settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(activeNotices, [
    {
      noticeId: "stop_active_notice",
      notice: {
        key: "system.stop.active_turn_cancelled",
        locale: "en-US",
        text: "Generation stopped.",
      },
    },
  ]);
  active.close();

  const idle = createService();
  idle.attachStopSystemNoticePresenter(async () => {
    throw new Error("native_notice_unavailable");
  });
  const idleStop = idle.stopAll({
    stopId: "stop_idle_notice",
    sourceEventId: "source_idle_notice",
    reasonCode: "player_stop_all",
    locale: "en-US",
  });
  assert.equal(idleStop.outcome, "no_active_turn");
  await idleStop.settled;
  await new Promise<void>((resolve) => setImmediate(resolve));
  idle.close();
});

test("Stardew native player input admits Chinese text without changing its typed ingress", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  adapter.emit({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "input_fact_zh",
    revision: 1,
    payload: {
      kind: "player_input",
      playerControl: {
        kind: "player_input",
        controlId: "input_zh_1",
        sourceEventId: "source_zh_1",
        text: "你好",
        locale: "zh-CN",
        issuerPlayerId: "host",
      },
    },
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.inputs, [
    {
      source: "player_text",
      inputId: "source_zh_1",
      eventId: "source_zh_1",
      text: "你好",
      locale: "zh-CN",
      timestampMs:
        harness.inputs[0] && typeof harness.inputs[0] === "object"
          ? (harness.inputs[0] as { timestampMs: unknown }).timestampMs
          : undefined,
    },
  ]);
  service.close();
});

test("Stardew control facts cannot throw from an adapter callback before STOP authority mounts", () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  new CompanionHostService(harness.loop as never, adapter.events);
  assert.doesNotThrow(() =>
    adapter.emit({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: "stop_before_mount",
      revision: 1,
      payload: {
        kind: "player_control",
        playerControl: { kind: "stop", controlId: "stop_1", sourceEventId: "source_1", locale: "en-US" },
      },
    }),
  );
});

test("Host service forwards adapter-labelled facts as ordinary coalesced Agent turns", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  adapter.emit(snapshot(7));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(harness.facts.length, 1);
  assert.equal(harness.flushes, 1);
  service.close();
  adapter.emit(snapshot(8));
  assert.equal(harness.facts.length, 1);
});

test("Host service does not microtask-spin on a held snapshot after its initial coalescing flush", async () => {
  const adapter = eventHarness();
  let flushes = 0;
  const loop = new CompanionLoop(reducedSession(async () => undefined) as never);
  const originalFlush = loop.flush.bind(loop);
  loop.flush = async () => {
    flushes++;
    await originalFlush();
  };
  const service = new CompanionHostService(loop, adapter.events);
  adapter.emit(snapshot(7));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(flushes, 1);
  assert.equal(loop.pump.hasPendingDelivery, false);
  service.close();
});

test("Host service schedules a second turn for a triggering fact received during an in-flight turn", async () => {
  const adapter = eventHarness();
  let releaseFirst: (() => void) | undefined;
  let flushes = 0;
  let pending = 0;
  const facts: unknown[] = [];
  const loop = {
    pump: {
      get pendingCount() {
        return pending;
      },
      get hasPendingDelivery() {
        return pending > 0;
      },
      enqueueFact(fact: unknown) {
        facts.push(fact);
        pending++;
      },
      enqueuePlayerInput() {},
    },
    async flush() {
      flushes++;
      pending--;
      if (flushes === 1)
        await new Promise<void>((resolvePromise) => {
          releaseFirst = resolvePromise;
        });
    },
  };
  const service = new CompanionHostService(loop as never, adapter.events);
  adapter.emit({ ...snapshot(7), kind: "semantic_event", correlationId: "trigger_7" });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  adapter.emit({ ...snapshot(8), kind: "semantic_event", correlationId: "trigger_8" });
  releaseFirst?.();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(facts.length, 2);
  assert.equal(flushes, 2);
  service.close();
});

test("Host service backs off failed adapter delivery instead of recursively retrying", async () => {
  const adapter = eventHarness();
  let flushes = 0;
  let pending = 0;
  const loop = {
    pump: {
      get pendingCount() {
        return pending;
      },
      enqueueFact() {
        pending++;
      },
      enqueuePlayerInput() {},
    },
    async flush() {
      flushes++;
      throw new Error("provider_down");
    },
  };
  const service = new CompanionHostService(loop as never, adapter.events);
  adapter.emit(snapshot(7));
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(flushes, 1);
  service.close();
});

test("Host service fail-closes every event-pump overflow class before any further admission", () => {
  for (const overflow of ["event_pump_terminal_overflow", "event_pump_event_overflow"]) {
    const adapter = eventHarness();
    const calls: string[] = [];
    const loop = {
      pump: {
        pendingCount: 0,
        enqueueFact() {
          throw new Error(overflow);
        },
        enqueuePlayerInput() {},
        clear() {
          calls.push("clear");
        },
      },
      async flush() {},
    };
    const service = new CompanionHostService(loop as never, adapter.events, (reasonCode) =>
      calls.push(`revoke:${reasonCode}`),
    );
    adapter.emit({
      source: "arcade_adapter",
      kind: "semantic_event",
      correlationId: overflow,
      revision: 1,
      payload: { kind: "overflow_test" },
    });
    assert.deepEqual(calls, ["revoke:event_overflow", "clear"], overflow);
    adapter.emit(snapshot(2));
    assert.deepEqual(calls, ["revoke:event_overflow", "clear"], `${overflow} remains sealed`);
    service.close();
  }
});

test("Host service preserves an ordinary event overflow revoke error after clearing exactly once", () => {
  const adapter = eventHarness();
  const calls: string[] = [];
  const loop = {
    pump: {
      pendingCount: 0,
      enqueueFact() {
        throw new Error("event_pump_event_overflow");
      },
      enqueuePlayerInput() {},
      clear() {
        calls.push("clear");
      },
    },
    async flush() {},
  };
  const service = new CompanionHostService(loop as never, adapter.events, () => {
    calls.push("revoke:event_overflow");
    throw new Error("disconnect_failed");
  });
  assert.throws(
    () =>
      adapter.emit({
        source: "arcade_adapter",
        kind: "semantic_event",
        correlationId: "ordinary_event",
        revision: 1,
        payload: { kind: "warped" },
      }),
    /disconnect_failed/,
  );
  assert.deepEqual(calls, ["revoke:event_overflow", "clear"]);
  adapter.emit(snapshot(2));
  assert.deepEqual(calls, ["revoke:event_overflow", "clear"]);
  service.close();
});

test("Host service seals integration ingress when snapshot tool refresh fails", async () => {
  const adapter = eventHarness();
  const admitted: string[] = [];
  const disconnects: string[] = [];
  let clears = 0;
  let refreshes = 0;
  const loop = {
    pump: {
      pendingCount: 0,
      enqueueFact(fact: WorldFact) {
        admitted.push(fact.correlationId);
      },
      enqueuePlayerInput() {},
      clear() {
        clears += 1;
      },
    },
    async flush() {},
  };
  const service = new CompanionHostService(
    loop as never,
    adapter.events,
    (reasonCode) => disconnects.push(reasonCode),
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    async () => {
      refreshes += 1;
      throw new Error("tool_refresh_failed");
    },
  );

  adapter.emit(snapshot(1));
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(refreshes, 1);
  assert.deepEqual(disconnects, ["event_overflow"]);
  assert.equal(clears, 1);
  assert.deepEqual(admitted, ["snapshot_1"]);

  adapter.emit(snapshot(2));
  assert.equal(refreshes, 1);
  assert.deepEqual(admitted, ["snapshot_1"]);
  service.close();
});

test("Host service overflow during an in-flight rejected delivery cannot retry or resurrect the pump", async () => {
  const adapter = eventHarness();
  let pending = 0;
  let admitted = 0;
  let flushes = 0;
  let beginDelivery: (() => void) | undefined;
  let rejectDelivery: ((reason?: unknown) => void) | undefined;
  let deliveryFinished: (() => void) | undefined;
  const deliveryStarted = new Promise<void>((resolve) => {
    beginDelivery = resolve;
  });
  const deliverySettled = new Promise<void>((resolve) => {
    deliveryFinished = resolve;
  });
  const loop = {
    pump: {
      get pendingCount() {
        return pending;
      },
      enqueueFact(fact: WorldFact) {
        admitted++;
        if (fact.correlationId === "overflow") throw new Error("event_pump_event_overflow");
        pending++;
      },
      enqueuePlayerInput() {},
      clear() {
        pending = 0;
      },
    },
    async flush() {
      flushes++;
      beginDelivery?.();
      try {
        await new Promise<void>((_resolve, reject) => {
          rejectDelivery = reject;
        });
      } finally {
        deliveryFinished?.();
      }
    },
  };
  const service = new CompanionHostService(loop as never, adapter.events);
  adapter.emit({
    source: "arcade_adapter",
    kind: "semantic_event",
    correlationId: "in_flight",
    revision: 1,
    payload: { kind: "warped" },
  });
  await deliveryStarted;
  adapter.emit({
    source: "arcade_adapter",
    kind: "semantic_event",
    correlationId: "overflow",
    revision: 1,
    payload: { kind: "warped" },
  });
  adapter.emit(snapshot(2));
  rejectDelivery?.(new Error("provider_down"));
  await deliverySettled;
  await Promise.resolve();
  assert.equal(flushes, 1);
  assert.equal(pending, 0);
  assert.equal(admitted, 2);
  adapter.emit(snapshot(3));
  assert.equal(admitted, 2);
  assert.equal(flushes, 1);
  service.close();
});

test("Host service overflow cancels a scheduled delivery and seals subsequent adapter facts", async () => {
  const adapter = eventHarness();
  const delivered: string[] = [];
  const loop = new CompanionLoop(
    reducedSession(async (text: string) => {
      delivered.push(text);
    }) as never,
  );
  const service = new CompanionHostService(loop, adapter.events);
  for (let index = 0; index < 128; index++) {
    adapter.emit({
      source: "arcade_adapter",
      kind: "semantic_event",
      correlationId: `event_${index}`,
      revision: 1,
      payload: {},
    });
  }
  adapter.emit({
    source: "arcade_adapter",
    kind: "semantic_event",
    correlationId: "overflow",
    revision: 1,
    payload: {},
  });
  adapter.emit({
    source: "arcade_adapter",
    kind: "semantic_event",
    correlationId: "after_overflow",
    revision: 1,
    payload: {},
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(delivered, []);
  assert.equal(loop.pump.pendingCount, 0);
  service.close();
});

test("Host service seals real terminal-receipt overflow before disconnect callback reentry", async () => {
  const adapter = eventHarness();
  const delivered: string[] = [];
  const loop = new CompanionLoop(
    reducedSession(async (text: string) => {
      delivered.push(text);
    }) as never,
  );
  let service: CompanionHostService;
  let callbackSawPending = -1;
  const reentered = { fact: false, player: false };
  service = new CompanionHostService(loop, adapter.events, () => {
    callbackSawPending = loop.pump.pendingCount;
    adapter.emit({
      source: "arcade_adapter",
      kind: "semantic_event",
      correlationId: "reentrant_fact",
      revision: 2,
      payload: {},
    });
    void service
      .acceptPlayerInput({ sourceEventId: "reentrant_player", text: "after overflow", locale: "en-US" })
      .then(() => {
        reentered.player = true;
      });
    reentered.fact = loop.pump.pendingCount === callbackSawPending;
  });

  for (let index = 0; index < 128; index++) {
    adapter.emit({
      source: "arcade_adapter",
      kind: "execution_receipt",
      correlationId: `progress_${index}`,
      revision: 1,
      payload: { state: "meaningful_progress" },
    });
  }
  adapter.emit({
    source: "arcade_adapter",
    kind: "execution_receipt",
    correlationId: "terminal_overflow",
    revision: 2,
    payload: { state: "failed" },
  });

  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.equal(callbackSawPending, 128);
  assert.equal(reentered.fact, true);
  assert.equal(reentered.player, true);
  assert.equal(loop.pump.pendingCount, 0);
  assert.deepEqual(delivered, []);
  adapter.emit({
    source: "arcade_adapter",
    kind: "semantic_event",
    correlationId: "after_overflow",
    revision: 3,
    payload: {},
  });
  await service.acceptPlayerInput({ sourceEventId: "after_overflow", text: "still sealed", locale: "en-US" });
  assert.equal(loop.pump.pendingCount, 0);
  assert.deepEqual(delivered, []);
  service.close();
});

test("presentation lineage exists only during the real Pi-consumed authenticated batch", async () => {
  const adapter = eventHarness();
  let release: (() => void) | undefined;
  const delivered = new Promise<void>((resolve) => {
    release = resolve;
  });
  let service: CompanionHostService;
  const loop = new CompanionLoop(
    reducedSession(async () => {
      await delivered;
    }) as never,
  );
  service = new CompanionHostService(loop, adapter.events);
  loop.attachTurnObserver(service);
  const input = service.acceptPlayerInput({ sourceEventId: "source_01", text: "hello", locale: "en-US" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const captured = service.capturePresentationAdmission();
  assert.equal(captured.sourceEventId, "source_01");
  captured.admission.assertHostCurrent(captured.admission.hostBinding);
  release?.();
  await input;
  assert.throws(() => service.capturePresentationAdmission(), /presentation_lineage_unavailable/);
  service.close();
});

test("presentation admission is also revoked by a direct interruption epoch closure", () => {
  const interruption = createCompanionInterruption();
  const tracker = new GameTurnLineageTracker();
  const provider = createGamePresentationAdmissionProvider(tracker, interruption);
  tracker.beginPlayerBatch("source_epoch_01");
  const captured = provider.capture();
  captured.admission.assertHostCurrent(captured.admission.hostBinding);
  interruption.close("runtime_closed");
  assert.throws(
    () => captured.admission.assertHostCurrent(captured.admission.hostBinding),
    /stale_interruption_admission/,
  );
  tracker.endBatch();
});

test("STOP rejects before any cancellation when voice STOP authority is absent", () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const interruption = createCompanionInterruption();
  const service = new CompanionHostService(
    { ...harness.loop, async abortAndClear() {} } as never,
    adapter.events,
    undefined,
    interruption,
    async () => undefined,
    async () => undefined,
  );
  assert.throws(
    () => service.stopAll({ stopId: "stop_00", sourceEventId: "source_00", reasonCode: "player_stop_all" }),
    /product_stop_unavailable/,
  );
  assert.equal(interruption.capture().open, true);
  service.close();
});

test("native STOP remains live and reopens admission when source attestation delivery throws", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const interruption = createCompanionInterruption();
  const calls: string[] = [];
  const evidence = {
    nativePlayerInputObserved() {},
    nativeStopAllObserved() {
      throw new Error("attestation_delivery_failed");
    },
    piTurnAccepted() {},
    piTurnSettled() {},
    stopSealed() {
      throw new Error("attestation_delivery_failed");
    },
    stopSettled() {
      throw new Error("attestation_delivery_failed");
    },
    stopUncertain() {},
    oldEpochQuiet() {},
    bodySettled() {},
  };
  const service = new CompanionHostService(
    {
      ...harness.loop,
      async abortAndClear() {
        calls.push("pi_clear");
      },
    } as never,
    adapter.events,
    undefined,
    interruption,
    async () => {
      calls.push("ledger");
    },
    async () => {
      calls.push("worker");
    },
    new GameTurnLineageTracker(),
    undefined,
    evidence,
  );
  service.attachVoiceStopper(async () => {
    calls.push("voice");
  });
  adapter.emit({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "stop_attestation_failure",
    revision: 1,
    payload: {
      kind: "stop_all",
      playerControl: { kind: "stop_all", controlId: "stop_1", sourceEventId: "source_1", locale: "en-US" },
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["ledger", "worker", "voice", "pi_clear"]);
  assert.equal(interruption.capture().open, true);
  service.close();
});

test("STOP keeps ingress and old epoch sealed when ledger cancellation fails", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const interruption = createCompanionInterruption();
  const service = new CompanionHostService(
    { ...harness.loop, async abortAndClear() {} } as never,
    adapter.events,
    undefined,
    interruption,
    async () => {
      throw new Error("ledger_cancel_failed");
    },
    async () => undefined,
  );
  service.attachVoiceStopper(async () => undefined);
  const stopped = service.stopAll({ stopId: "stop_01", sourceEventId: "source_01", reasonCode: "player_stop_all" });
  await assert.rejects(stopped.settled, /ledger_cancel_failed/);
  assert.equal(interruption.capture().open, false);
  await service.acceptPlayerInput({ sourceEventId: "source_02", text: "must remain sealed", locale: "en-US" });
  assert.deepEqual(harness.inputs, []);
  service.close();
});

test("late integration receipt remains bound after STOP and triggers exact cancellation", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const interruption = createCompanionInterruption();
  const calls: string[] = [];
  let releaseCancel!: () => void;
  const cancel = new Promise<void>((resolve) => {
    releaseCancel = resolve;
  });
  const service = new CompanionHostService(
    { ...harness.loop, async abortAndClear() {} } as never,
    adapter.events,
    undefined,
    interruption,
    async () => {
      await cancel;
    },
    async () => undefined,
    new GameTurnLineageTracker(),
    (receipt) => {
      calls.push(`receipt:${receipt.executionId}`);
    },
  );
  service.attachVoiceStopper(async () => undefined);
  const stopped = service.stopAll({ stopId: "stop_late", sourceEventId: "source_late", reasonCode: "player_stop_all" });
  adapter.emit({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution_late",
    revision: 1,
    payload: {
      requestId: "request_late",
      executionId: "execution_late",
      state: "running",
      reasonCode: "accepted",
      revision: 1,
      evidence: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["receipt:execution_late"]);
  let completed = false;
  void stopped.settled.then(() => {
    completed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  releaseCancel();
  await stopped.settled;
  service.close();
});

test("STOP revokes an active presentation lineage before external cancellation settles", async () => {
  const adapter = eventHarness();
  let release: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loop = new CompanionLoop(
    reducedSession(async () => {
      await entered;
    }) as never,
  );
  const interruption = createCompanionInterruption();
  const service = new CompanionHostService(
    loop,
    adapter.events,
    undefined,
    interruption,
    async () => undefined,
    async () => undefined,
  );
  loop.attachTurnObserver(service);
  service.attachVoiceStopper(async () => undefined);
  const input = service.acceptPlayerInput({ sourceEventId: "source_04", text: "hello", locale: "en-US" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const captured = service.capturePresentationAdmission();
  const stopped = service.stopAll({ stopId: "stop_03", sourceEventId: "source_04", reasonCode: "player_stop_all" });
  assert.throws(
    () => captured.admission.assertHostCurrent(captured.admission.hostBinding),
    /stale_presentation_lineage/,
  );
  release?.();
  await input;
  await stopped.settled;
  service.close();
});

test("STOP distinguishes an active Pi batch from a queued authenticated player turn", async () => {
  const createService = () => {
    const adapter = eventHarness();
    const interruption = createCompanionInterruption();
    const service = new CompanionHostService(
      { ...fakeLoop().loop, async abortAndClear() {} } as never,
      adapter.events,
      undefined,
      interruption,
      async () => undefined,
      async () => undefined,
    );
    service.attachVoiceStopper(async () => undefined);
    return service;
  };

  const active = createService();
  active.beginPlayerBatch("source_active", "batch_active");
  const activeStop = active.stopAll({
    stopId: "stop_active",
    sourceEventId: "source_stop_active",
    reasonCode: "player_stop_all",
  });
  assert.equal(activeStop.outcome, "active_turn_cancelled");
  await activeStop.settled;
  active.close();

  const queuedAdapter = eventHarness();
  const queuedLoop = {
    ...fakeLoop().loop,
    get hasQueuedPlayerDelivery() {
      return true;
    },
    async abortAndClear() {},
  };
  const queued = new CompanionHostService(
    queuedLoop as never,
    queuedAdapter.events,
    undefined,
    createCompanionInterruption(),
    async () => undefined,
    async () => undefined,
  );
  queued.attachVoiceStopper(async () => undefined);
  const queuedStop = queued.stopAll({
    stopId: "stop_queued",
    sourceEventId: "source_stop_queued",
    reasonCode: "player_stop_all",
  });
  assert.equal(queuedStop.outcome, "queued_turn_cancelled");
  await queuedStop.settled;
  queued.close();

  const idle = createService();
  const idleStop = idle.stopAll({
    stopId: "stop_idle",
    sourceEventId: "source_stop_idle",
    reasonCode: "player_stop_all",
  });
  assert.equal(idleStop.outcome, "no_active_turn");
  await idleStop.settled;
  idle.close();
});

test("queued STOP cannot mint an active Pi batch for STOP proof", async () => {
  const adapter = eventHarness();
  const seen: Array<{ batchId: string | null }> = [];
  const service = new CompanionHostService(
    {
      ...fakeLoop().loop,
      get hasQueuedPlayerDelivery() {
        return true;
      },
      async abortAndClear() {},
    } as never,
    adapter.events,
    undefined,
    createCompanionInterruption(),
    async () => undefined,
    async () => undefined,
    undefined,
    undefined,
    {
      stopSealed: (event: { batchId: string | null }) => seen.push({ batchId: event.batchId }),
    } as never,
  );
  service.attachVoiceStopper(async () => undefined);
  const stopped = service.stopAll({
    stopId: "stop_queued_proof",
    sourceEventId: "source_queued_proof",
    reasonCode: "player_stop_all",
  });
  assert.equal(stopped.outcome, "queued_turn_cancelled");
  await stopped.settled;
  assert.deepEqual(seen, [{ batchId: null }]);
  service.close();
});

test("STOP awaits ledger, worker, voice, and Pi clear before reopening ingress", async () => {
  const adapter = eventHarness();
  const calls: string[] = [];
  const interruption = createCompanionInterruption();
  const loop = {
    pump: { pendingCount: 0, enqueueFact() {}, enqueuePlayerInput() {} },
    async flush() {},
    async abortAndClear() {
      calls.push("pi_clear");
    },
  };
  const service = new CompanionHostService(
    loop as never,
    adapter.events,
    undefined,
    interruption,
    async () => {
      calls.push("ledger");
    },
    async () => {
      calls.push("worker");
    },
  );
  service.attachVoiceStopper(async () => {
    calls.push("voice");
  });
  const stopped = service.stopAll({ stopId: "stop_02", sourceEventId: "source_03", reasonCode: "player_stop_all" });
  assert.equal(interruption.capture().open, false);
  await stopped.settled;
  assert.deepEqual(calls, ["ledger", "worker", "voice", "pi_clear"]);
  assert.equal(interruption.capture().open, true);
  service.close();
});

test("successful STOP reopens only after its old epoch settles so the next player input is admitted", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const interruption = createCompanionInterruption();
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  const service = new CompanionHostService(
    { ...harness.loop, async abortAndClear() {} } as never,
    adapter.events,
    undefined,
    interruption,
    async () => cancellation,
    async () => undefined,
  );
  service.attachVoiceStopper(async () => undefined);
  const stopped = service.stopAll({
    stopId: "stop_reopen",
    sourceEventId: "source_stop",
    reasonCode: "player_stop_all",
  });
  await service.acceptPlayerInput({ sourceEventId: "during_stop", text: "must remain sealed", locale: "en-US" });
  assert.deepEqual(harness.inputs, []);
  assert.equal(interruption.capture().open, false);

  releaseCancellation();
  await stopped.settled;
  assert.equal(interruption.capture().open, true);
  await service.acceptPlayerInput({
    sourceEventId: "after_stop",
    text: "must be admitted",
    locale: "en-US",
    timestampMs: 1,
  });
  assert.deepEqual(harness.inputs, [
    {
      source: "player_text",
      inputId: "after_stop",
      eventId: "after_stop",
      text: "must be admitted",
      locale: "en-US",
      timestampMs: 1,
    },
  ]);
  service.close();
});

test("an older STOP cannot reopen admission after a newer STOP takes over", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const interruption = createCompanionInterruption();
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const firstCancellation = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const secondCancellation = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const service = new CompanionHostService(
    { ...harness.loop, async abortAndClear() {} } as never,
    adapter.events,
    undefined,
    interruption,
    async (epoch) => (epoch === 0 ? firstCancellation : secondCancellation),
    async () => undefined,
  );
  service.attachVoiceStopper(async () => undefined);
  const first = service.stopAll({ stopId: "stop_first", sourceEventId: "source_first", reasonCode: "player_stop_all" });
  const second = service.stopAll({
    stopId: "stop_second",
    sourceEventId: "source_second",
    reasonCode: "player_stop_all",
  });

  releaseFirst();
  await first.settled;
  assert.equal(interruption.capture().open, false);
  await service.acceptPlayerInput({ sourceEventId: "between_stops", text: "must remain sealed", locale: "en-US" });
  assert.deepEqual(harness.inputs, []);

  releaseSecond();
  await second.settled;
  assert.equal(interruption.capture().open, true);
  await service.acceptPlayerInput({ sourceEventId: "after_latest_stop", text: "must be admitted", locale: "en-US" });
  assert.equal(harness.inputs.length, 1);
  service.close();
});

test("Host service rejects player text after overflow or close without delivering it", async () => {
  const overflowAdapter = eventHarness();
  const overflowHarness = fakeLoop();
  const overflowLoop = {
    pump: {
      ...overflowHarness.loop.pump,
      enqueueFact() {
        throw new Error("event_pump_event_overflow");
      },
      clear() {},
    },
    flush: overflowHarness.loop.flush,
  };
  const overflowService = new CompanionHostService(overflowLoop as never, overflowAdapter.events);
  overflowAdapter.emit(snapshot(1));
  await overflowService.acceptPlayerText("after overflow", "en-US", 1);
  assert.deepEqual(overflowHarness.inputs, []);
  assert.equal(overflowHarness.flushes, 0);
  overflowService.close();

  const closedAdapter = eventHarness();
  const closedHarness = fakeLoop();
  const closedService = new CompanionHostService(closedHarness.loop as never, closedAdapter.events);
  closedService.close();
  await closedService.acceptPlayerText("after close", "en-US", 2);
  assert.deepEqual(closedHarness.inputs, []);
  assert.equal(closedHarness.flushes, 0);
});

test("Host service seals lifecycle overflow before an external callback can reenter", async () => {
  const adapter = eventHarness();
  const calls: string[] = [];
  const facts: unknown[] = [];
  const inputs: unknown[] = [];
  const loop = {
    pump: {
      pendingCount: 0,
      enqueueFact(fact: WorldFact) {
        calls.push(`fact:${fact.kind}`);
        if (fact.kind === "lifecycle") throw new Error("event_pump_terminal_overflow");
        facts.push(fact);
      },
      enqueuePlayerInput(input: unknown) {
        inputs.push(input);
      },
      clear() {
        calls.push("clear");
      },
    },
    async flush() {
      calls.push("flush");
    },
  };
  let service: CompanionHostService;
  service = new CompanionHostService(loop as never, adapter.events, () => {
    calls.push("callback");
    adapter.emit(snapshot(2));
    void service.acceptPlayerText("reentrant", "en-US", 3);
  });
  adapter.disconnect("transport_lost");
  await Promise.resolve();
  assert.deepEqual(calls, ["fact:lifecycle", "callback", "clear"]);
  assert.deepEqual(facts, []);
  assert.deepEqual(inputs, []);
  service.close();
});

test("Host service invokes the normal lifecycle callback once and flushes its lifecycle fact", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const callbacks: string[] = [];
  const service = new CompanionHostService(harness.loop as never, adapter.events, (reasonCode) =>
    callbacks.push(reasonCode),
  );
  adapter.disconnect("adapter_closed");
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(callbacks, ["adapter_closed"]);
  assert.equal(harness.facts.length, 1);
  assert.equal(harness.flushes, 1);
  service.close();
});

test("Host service rejects an adapter attempt to impersonate local transport", () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  assert.throws(
    () => adapter.emit({ ...snapshot(1), source: "host_local_transport" }),
    /adapter_transport_source_reserved/,
  );
  service.close();
});

test("Host service reports adapter disconnect without inventing a game-world event", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  adapter.disconnect();
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.facts, [
    {
      source: "host_local_transport",
      kind: "lifecycle",
      correlationId: "transport_disconnected",
      revision: 0,
      payload: { state: "disconnected", reasonCode: "adapter_closed" },
    },
  ]);
  service.close();
});

test("Host service admits only final voice text and does not project ordinary output", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  await service.acceptFinalVoice({
    sessionId: "session_01",
    sourceEventId: "voice_source_01",
    inputId: "input_01",
    text: "看看农场",
    locale: "zh-CN",
    providerId: "fake",
    modelRevision: "v1",
    timestampMs: 1,
    actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
  });
  assert.deepEqual(harness.inputs, [
    {
      source: "voice_final",
      inputId: "input_01",
      eventId: "voice_source_01",
      text: "看看农场",
      locale: "zh-CN",
      timestampMs: 1,
    },
  ]);
  service.close();
});

test("Host service receives only final transcripts from an attached Voice Gateway source", async () => {
  const adapter = eventHarness();
  const harness = fakeLoop();
  let listener:
    | ((input: {
        sessionId: string;
        sourceEventId: string;
        inputId: string;
        text: string;
        locale: string;
        providerId: string;
        modelRevision: string;
        timestampMs: number;
        actualFormat: { sampleRate: number; channels: number; encoding: "pcm_s16le" };
      }) => void)
    | undefined;
  const service = new CompanionHostService(harness.loop as never, adapter.events);
  const detach = service.attachFinalVoiceSource({
    onFinalTranscript(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
  });
  listener?.({
    sessionId: "session_01",
    sourceEventId: "voice_source_gateway_01",
    inputId: "input_gateway_01",
    text: "走到门口",
    locale: "zh-CN",
    providerId: "fake-asr",
    modelRevision: "v1",
    timestampMs: 2,
    actualFormat: { sampleRate: 16_000, channels: 1, encoding: "pcm_s16le" },
  });
  await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
  assert.deepEqual(harness.inputs, [
    {
      source: "voice_final",
      inputId: "input_gateway_01",
      eventId: "voice_source_gateway_01",
      text: "走到门口",
      locale: "zh-CN",
      timestampMs: 2,
    },
  ]);
  await detach();
  service.close();
  assert.equal(listener, undefined);
});


function stopSettlementFact(input: Readonly<{
  stopId: string;
  sourceEventId: string;
  epoch: number;
  revision: number;
}>): WorldFact {
  return {
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: `body_settled_${input.stopId}_${input.revision}`,
    revision: input.revision,
    payload: {
      kind: "body_settled",
      revision: input.revision,
      activeExecution: null,
      reasonCode: "stop_body_settled",
      stopObservation: {
        kind: "body_settled",
        stopId: input.stopId,
        sourceEventId: input.sourceEventId,
        epoch: input.epoch,
      },
    },
  };
}

function stopSettlementObserverHarness() {
  const adapter = eventHarness();
  const harness = fakeLoop();
  const service = new CompanionHostService(
    { ...harness.loop, async abortAndClear() {} } as never,
    adapter.events,
    undefined,
    createCompanionInterruption(),
    async () => undefined,
    async () => undefined,
  );
  service.attachVoiceStopper(async () => undefined);
  return { adapter, service };
}

test("Host STOP settlement observer emits once for an exact body_settled match and consumes duplicates", async () => {
  const { adapter, service } = stopSettlementObserverHarness();
  const observed: unknown[] = [];
  service.onStopSettled((payload) => observed.push(payload));
  const stopped = service.stopAll({
    stopId: "stop_observer_exact",
    sourceEventId: "source_observer_exact",
    reasonCode: "player_stop_all",
  });
  await stopped.settled;

  const fact = stopSettlementFact({
    stopId: stopped.admission.stopId,
    sourceEventId: stopped.admission.sourceEventId,
    epoch: stopped.admission.epoch,
    revision: 7,
  });
  adapter.emit(fact);
  adapter.emit(fact);

  assert.deepEqual(observed, [
    {
      stopId: "stop_observer_exact",
      sourceEventId: "source_observer_exact",
      batchId: null,
      epoch: 1,
      observationRevision: 7,
    },
  ]);
  service.close();
});

test("Host STOP settlement observer rejects mismatched stopId, sourceEventId, and epoch", async () => {
  const mismatches = [
    { label: "stopId", stopId: "stop_observer_other", sourceEventId: "source_observer_mismatch", epoch: 1 },
    { label: "sourceEventId", stopId: "stop_observer_mismatch", sourceEventId: "source_observer_other", epoch: 1 },
    { label: "epoch", stopId: "stop_observer_mismatch", sourceEventId: "source_observer_mismatch", epoch: 2 },
  ] as const;

  for (const mismatch of mismatches) {
    const { adapter, service } = stopSettlementObserverHarness();
    const observed: unknown[] = [];
    service.onStopSettled((payload) => observed.push(payload));
    const stopped = service.stopAll({
      stopId: "stop_observer_mismatch",
      sourceEventId: "source_observer_mismatch",
      reasonCode: "player_stop_all",
    });
    await stopped.settled;

    adapter.emit(
      stopSettlementFact({
        stopId: mismatch.stopId,
        sourceEventId: mismatch.sourceEventId,
        epoch: mismatch.epoch,
        revision: 8,
      }),
    );

    assert.deepEqual(observed, [], `${mismatch.label} mismatch must not notify observers`);
    service.close();
  }
});

test("Host STOP settlement observer snapshots listeners before delivery", async () => {
  const { adapter, service } = stopSettlementObserverHarness();
  const observed: string[] = [];
  service.onStopSettled(() => {
    observed.push("first");
    service.onStopSettled(() => observed.push("late"));
  });
  const stopped = service.stopAll({
    stopId: "stop_observer_snapshot",
    sourceEventId: "source_observer_snapshot",
    reasonCode: "player_stop_all",
  });
  await stopped.settled;
  adapter.emit(stopSettlementFact({
    stopId: stopped.admission.stopId,
    sourceEventId: stopped.admission.sourceEventId,
    epoch: stopped.admission.epoch,
    revision: 9,
  }));
  assert.deepEqual(observed, ["first"]);
  service.close();
});

test("Host STOP settlement observer unsubscribe and close make subscription and delivery inert", async () => {
  const { adapter, service } = stopSettlementObserverHarness();
  const observed: unknown[] = [];
  const unsubscribe = service.onStopSettled((payload) => observed.push(payload));
  unsubscribe();
  const stopped = service.stopAll({
    stopId: "stop_observer_unsubscribed",
    sourceEventId: "source_observer_unsubscribed",
    reasonCode: "player_stop_all",
  });
  await stopped.settled;
  adapter.emit(
    stopSettlementFact({
      stopId: stopped.admission.stopId,
      sourceEventId: stopped.admission.sourceEventId,
      epoch: stopped.admission.epoch,
      revision: 9,
    }),
  );
  assert.deepEqual(observed, []);

  const closedObserved: unknown[] = [];
  service.onStopSettled((payload) => closedObserved.push(payload));
  service.close();
  const closedUnsubscribe = service.onStopSettled((payload) => closedObserved.push(payload));
  closedUnsubscribe();
  service.acceptInitialFacts([
    stopSettlementFact({
      stopId: stopped.admission.stopId,
      sourceEventId: stopped.admission.sourceEventId,
      epoch: stopped.admission.epoch,
      revision: 10,
    }),
  ]);
  assert.deepEqual(closedObserved, []);
});
