import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  MAX_PENDING_RECEIPTS,
  MAX_PENDING_SEMANTIC_EVENTS,
  MAX_PENDING_WORLD_FACTS,
  type PendingBatch,
  type WorldFact,
} from "./event-pump.js";

/** One distinct world observation: the kind the Mod mints per event, with nothing repeating it. */
function worldFact(eventId: string, observedTick: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    observedTick,
    revision: 1,
    payload: { kind: "time_milestone", text: `第 ${String(observedTick)} 次时间里程碑` },
  };
}

/** The world-fact event ids one flush carries, in delivery order. */
async function deliverWorldFactIds(pump: CompanionEventPump): Promise<string[]> {
  const delivered: string[] = [];
  await pump.flush({
    async deliver(batch) {
      for (const fact of batch.facts) {
        if (fact.eventId !== undefined) delivered.push(fact.eventId);
      }
    },
  });
  return delivered;
}

test("a settled programme is news: the digest alone asks for a turn", async () => {
  // The defect this pins, measured on a real run: `program_settled` was classified as held progress, so after a plan
  // was submitted the settlement sat in the pump without asking for a turn. The companion went quiet for 816.5 s until
  // the player typed something. A held fact is one whose LATEST state is all that matters (`route_progress`); a
  // settlement is an OUTCOME, and an outcome the model is never told about is a plan whose result does not exist.
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "host_game_session",
    kind: "world_fact",
    eventId: "program_settled_plan_1",
    sourceEventId: "program_settled_plan_1",
    correlationId: "plan_1",
    observedTick: 12,
    revision: 1,
    semanticKind: "program_settled",
    payload: { programId: "plan_1", settled: true },
  });

  assert.equal(
    pump.hasPendingDelivery,
    true,
    "a settlement the model has not been told about must be able to start a turn on its own",
  );
  const delivered = await deliverWorldFactIds(pump);
  assert.deepEqual(delivered, ["program_settled_plan_1"]);
  assert.equal(pump.hasPendingDelivery, false, "and it is delivered once, not re-requested forever");
});

test("event pump steers player input and attaches the latest snapshot", async () => {
  const pump = new CompanionEventPump();
  const delivered: PendingBatch[] = [];
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "s1",
    revision: 1,
    payload: { location: "Farm" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "s2",
    revision: 2,
    payload: { location: "Town" },
  });
  pump.enqueuePlayerInput({
    source: "voice_final",
    inputId: "voice_1",
    text: "去镇上",
    locale: "zh-CN",
    timestampMs: 1,
  });
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.equal(delivered[0]?.disposition, "steer");
  const batch = delivered[0]!;
  assert.deepEqual(batch.triggerEventIds, ["voice_1"]);
  assert.deepEqual(
    batch.inputs.map((input) => input.text),
    ["去镇上"],
  );
  assert.deepEqual(
    batch.facts.map((fact) => fact.revision),
    [2],
  );
  assert.equal(pump.pendingCount, 0);
});

test("event pump delivers a bounded context projection without replacing authoritative fact payload", async () => {
  const pump = new CompanionEventPump();
  const authoritativePayload = { revision: 7, activeExecution: { requestId: "request_secret" } };
  const contextProjection = Object.freeze({
    schema: "gamebuddy-game-snapshot-projection/v1",
    available: true,
    snapshotRevision: 7,
    text: "bounded",
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snapshot",
    revision: 7,
    payload: authoritativePayload,
    contextProjection,
  });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input", text: "继续", locale: "zh-CN", timestampMs: 1 });

  const delivered: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });

  const batch = delivered[0]!;
  assert.deepEqual(batch.facts[0]?.payload, contextProjection);
  assert.deepEqual(batch.events.find((event) => event.payload?.schema !== undefined)?.payload, contextProjection);
  assert.equal(batch.text.includes("request_secret"), false, "the model-facing text never carries the raw payload");
  assert.equal("contextProjection" in (batch.facts[0] ?? {}), false);
});

test("event pump holds snapshot and meaningful progress until an ordinary trigger arrives", async () => {
  const pump = new CompanionEventPump();
  const delivered: PendingBatch[] = [];
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snapshot",
    revision: 4,
    payload: { location: "Farm" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution",
    revision: 4,
    payload: { state: "running" },
  });
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.equal(delivered.length, 0);

  pump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    eventId: "event_1",
    correlationId: "event",
    revision: 5,
    payload: { kind: "location_changed" },
  });
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.equal(delivered[0]?.disposition, "follow_up");
  const batch = delivered[0]!;
  assert.deepEqual(batch.triggerEventIds, ["event_1"]);
  assert.deepEqual(
    batch.facts.map((fact) => [fact.kind, fact.payload.state ?? "", fact.revision]),
    [
      ["snapshot", "", 4],
      ["execution_receipt", "running", 4],
      ["semantic_event", "", 5],
    ],
  );
});

test("event pump follows up ordinary facts and preserves an exact failed batch retry", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution_a",
    revision: 1,
    payload: { state: "failed" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "execution_b",
    revision: 2,
    payload: { state: "succeeded" },
  });
  await assert.rejects(
    () =>
      pump.flush({
        async deliver() {
          throw new Error("sink_down");
        },
      }),
    /sink_down/,
  );
  const delivered: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.equal(delivered[0]?.disposition, "follow_up");
  assert.deepEqual(
    delivered[0]?.facts.map((item) => item.correlationId),
    ["execution_a", "execution_b"],
  );
});

test("only a delivery a turn accepted ages the state the Host re-states", async () => {
  // This count is the age a re-stated block reports, so a batch the sink rejected must not advance it: the model
  // never read that batch, and counting it would claim the reading is older than the turn it was actually shown in.
  const pump = new CompanionEventPump();
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 1, payload: {} });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input", text: "继续", locale: "zh-CN", timestampMs: 1 });
  assert.equal(pump.deliveredBatches, 0);

  await assert.rejects(
    () =>
      pump.flush({
        async deliver() {
          throw new Error("sink_down");
        },
      }),
    /sink_down/,
  );
  assert.equal(pump.deliveredBatches, 0, "a rejected batch was never read by a turn");

  await pump.flush({ async deliver() {} });
  assert.equal(pump.deliveredBatches, 1);
  // A flush with nothing to deliver composes no turn, so it ages nothing either.
  await pump.flush({ async deliver() {} });
  assert.equal(pump.deliveredBatches, 1);
});

test("event pump retries the exact composed text without replaying a newer or mutated payload", async () => {
  const pump = new CompanionEventPump();
  const payload = { nested: { value: "original" } };
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 1, payload });
  pump.enqueuePlayerInput({ source: "player_text", inputId: "input", text: "继续", locale: "zh-CN", timestampMs: 1 });
  let firstFrame = "";
  await assert.rejects(
    () =>
      pump.flush({
        async deliver(batch) {
          firstFrame = batch.text;
          payload.nested.value = "mutated";
          throw new Error("down");
        },
      }),
    /down/,
  );
  pump.enqueueFact({ source: "stardew_mod", kind: "snapshot", correlationId: "s", revision: 2, payload: {} });
  const delivered: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.equal(delivered[0]?.text, firstFrame);
  // A later held snapshot must wait for a new trigger; it must not be replayed
  // into the frozen retry batch nor manufacture a Pi turn by itself.
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "next_input",
    text: "接着做",
    locale: "zh-CN",
    timestampMs: 2,
  });
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.deepEqual(
    delivered.map((batch) => batch.facts.map((fact) => fact.revision)),
    [[1], [2]],
  );
  assert.equal(
    delivered[0]?.text,
    firstFrame,
    "the retried message is the exact text composed before the caller mutated its own payload object",
  );
});

test("event pump clear revokes an in-flight rejected delivery without retrying it", async () => {
  const pump = new CompanionEventPump();
  pump.enqueuePlayerInput({ source: "player_text", inputId: "stale", text: "旧消息", locale: "zh-CN", timestampMs: 1 });
  let rejectDelivery: ((reason?: unknown) => void) | undefined;
  let deliveries = 0;
  const inFlight = pump.flush({
    async deliver() {
      deliveries++;
      await new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      });
    },
  });
  await Promise.resolve();
  pump.clear();
  rejectDelivery?.(new Error("sink_down"));
  await assert.rejects(() => inFlight, /sink_down/);
  assert.equal(pump.pendingCount, 0);
  await pump.flush({
    async deliver() {
      deliveries++;
    },
  });
  assert.equal(deliveries, 1);

  // A post-clear admission is a distinct generation and is the only batch
  // eligible for delivery after the revoked in-flight frame.
  pump.enqueuePlayerInput({ source: "player_text", inputId: "fresh", text: "新消息", locale: "zh-CN", timestampMs: 2 });
  await pump.flush({
    async deliver() {
      deliveries++;
    },
  });
  assert.equal(deliveries, 2);
});

test("event pump clear revokes an in-flight rejected fact delivery and preserves only the new generation", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "stale_event",
    correlationId: "stale_delivery",
    revision: 1,
    observedTick: 10,
    payload: { value: "stale" },
  });

  let rejectDelivery: ((reason?: unknown) => void) | undefined;
  let deliveries = 0;
  const inFlight = pump.flush({
    async deliver() {
      deliveries++;
      await new Promise<void>((_resolve, reject) => {
        rejectDelivery = reject;
      });
    },
  });
  await Promise.resolve();

  pump.clear();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fresh_event",
    correlationId: "fresh_delivery",
    revision: 2,
    observedTick: 11,
    payload: { value: "fresh" },
  });
  rejectDelivery?.(new Error("sink_down"));
  await assert.rejects(() => inFlight, /sink_down/);

  const delivered: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      deliveries++;
      delivered.push(batch);
    },
  });

  assert.equal(deliveries, 2);
  const batch = delivered[0]!;
  assert.deepEqual(
    batch.facts.map((fact) => [fact.eventId, fact.payload.value]),
    [["fresh_event", "fresh"]],
  );
  assert.equal(pump.pendingCount, 0);
});

test("event pump holds every nonterminal progress receipt state", async () => {
  for (const state of ["accepted", "running", "meaningful_progress"]) {
    const pump = new CompanionEventPump();
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: state,
      revision: 1,
      payload: { state },
    });
    let deliveries = 0;
    await pump.flush({
      async deliver() {
        deliveries++;
      },
    });
    assert.equal(deliveries, 0, state);
  }
});

test("event pump follows up a blocked terminal receipt without waiting for an unrelated trigger", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "blocked_execution",
    revision: 1,
    payload: { state: "blocked", reasonCode: "precondition_failed" },
  });
  const delivered: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.disposition, "follow_up");
  assert.deepEqual(
    delivered[0]?.facts.map((fact) => fact.payload.state),
    ["blocked"],
  );
});

test("event pump classifies terminal receipt overflow separately from all nonterminal overflow classes", () => {
  const terminalPump = new CompanionEventPump();
  for (let index = 0; index < MAX_PENDING_RECEIPTS; index++) {
    terminalPump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `progress_${index}`,
      revision: 1,
      payload: { state: "meaningful_progress" },
    });
  }
  // A TERMINAL receipt arriving at a window full of NON-terminal receipts evicts the oldest of those instead of
  // closing the bridge, and counts it: the terminal is the authority for its execution, the progress it replaces is not.
  terminalPump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "terminal_overflow",
    revision: 1,
    payload: { state: "failed" },
  });
  assert.equal(terminalPump.droppedFacts, 1);
  assert.equal(terminalPump.pendingCount, MAX_PENDING_RECEIPTS);

  // Facts a later fact SUPERSEDES are the ones that may be dropped: a non-terminal receipt (its terminal is still to
  // come) and a lifecycle notice. Measured 2026-10-19 (`g97cross`): 870 facts in one run, 470 of them receipts,
  // arriving while a turn was in flight - and closing the whole bridge over them ended that run short of its night.
  for (const [kind, payload, bound] of [
    ["execution_receipt", { state: "meaningful_progress" }, MAX_PENDING_RECEIPTS],
    ["lifecycle", { state: "adapter_notice" }, 128],
  ] as const) {
    const pump = new CompanionEventPump();
    for (let index = 0; index < bound; index++) {
      pump.enqueueFact({ source: "stardew_mod", kind, correlationId: `${kind}_${index}`, revision: 1, payload });
    }
    pump.enqueueFact({ source: "stardew_mod", kind, correlationId: `${kind}_overflow`, revision: 1, payload });
    assert.equal(pump.droppedFacts, 1, kind);
    assert.equal(pump.pendingCount, bound, kind);
  }

  // A semantic event that is NOT progress still fails closed: `warped` says something no later fact repeats, so a
  // window full of them holds nothing that may be evicted and the bridge refuses rather than losing one.
  const eventPump = new CompanionEventPump();
  for (let index = 0; index < MAX_PENDING_SEMANTIC_EVENTS; index++) {
    eventPump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `semantic_${index}`,
      revision: 1,
      payload: { kind: "warped" },
    });
  }
  assert.throws(
    () =>
      eventPump.enqueueFact({
        source: "stardew_mod",
        kind: "semantic_event",
        correlationId: "semantic_overflow",
        revision: 1,
        payload: { kind: "warped" },
      }),
    /event_pump_event_overflow/,
  );

  // A TERMINAL receipt arriving at a full window still never closes the bridge over a NON-terminal entry: it evicts the
  // oldest of those instead, and counts that. Terminals are the authority for their execution, so losing one would leave
  // a request that never settles - the shape fail-closed exists for.
  const mixedPump = new CompanionEventPump();
  mixedPump.enqueueFact({
    source: "stardew_mod",
    kind: "semantic_event",
    correlationId: "progress-filler",
    revision: 1,
    payload: { kind: "warped" },
  });
  // Filled to the limit with PROGRESS receipts, which is what makes an eviction possible: a terminal is the
  // authority for its execution and may never be dropped, so an all-terminal window has nothing to evict and
  // must seal (the case below).
  for (let index = 0; index < MAX_PENDING_RECEIPTS; index++) {
    mixedPump.enqueueFact({
      source: "stardew_mod",
      kind: "execution_receipt",
      correlationId: `progress_${index}`,
      revision: 1,
      payload: { state: "meaningful_progress" },
    });
  }
  mixedPump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "terminal_after_full",
    revision: 1,
    payload: { state: "failed" },
  });
  assert.equal(mixedPump.droppedFacts, 1);
  // The bound is per destination, and this pump also holds the warped semantic event from above - so the
  // total is one more than the receipts window, and saying so is what keeps this assertion about the window.
  assert.equal(mixedPump.pendingCount, MAX_PENDING_RECEIPTS + 1);
});

test("a full world-fact window sheds its OLDEST observation instead of closing the bridge", async () => {
  // A world fact is one OBSERVATION of the world (a day started, a clock milestone, a native
  // notice) and no later fact repeats it, so a window full of them holds nothing the drop rule
  // can evict - and the pump used to throw, which host-service turns into a bridge close: every
  // held fact and the whole session, spent to avoid losing one. A turn here thinks for 60+ s, so
  // that window is reachable in ordinary play.
  //
  // The bridge must survive. The ARRIVAL is what has to reach the model, and the OLDEST
  // observation is what a consumer already 60 s behind can no longer act on - the same
  // oldest-first rule `takeBatch` applies to a batch that is too large. The shed fact is counted,
  // so the loss is named rather than silent.
  const pump = new CompanionEventPump();
  for (let index = 0; index < MAX_PENDING_WORLD_FACTS; index++) {
    pump.enqueueFact(worldFact(`world_fact_${String(index)}`, index));
  }
  assert.equal(pump.pendingCount, MAX_PENDING_WORLD_FACTS);

  pump.enqueueFact(worldFact("world_fact_arrival", MAX_PENDING_WORLD_FACTS));

  assert.equal(pump.droppedFacts, 1, "the shed observation is counted, never silent");
  assert.equal(pump.pendingCount, MAX_PENDING_WORLD_FACTS, "the window stays bounded");
  const delivered = await deliverWorldFactIds(pump);
  assert.equal(delivered.length, MAX_PENDING_WORLD_FACTS);
  assert.equal(delivered.includes("world_fact_0"), false, "the oldest observation is the one shed");
  assert.equal(delivered.includes("world_fact_arrival"), true, "the arrival always survives");
});

test("event pump keeps a long run's PROGRESS observations from filling the pending window", () => {
  // Measured 2026-10-17 on a real multi-day run: one agent turn (70 assistant messages, ~350s) made the Mod
  // publish 129 per-tile observations, each with its OWN correlationId, and they filled the 128-entry window -
  // so the pump threw and the bridge closed mid-run. The receipt half of the same traffic is already
  // latest-only, so the semantic half must be too.
  const pump = new CompanionEventPump();
  for (let index = 0; index < 500; index++) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `route_progress_${index}`,
      executionId: "exec-one",
      revision: index + 1,
      payload: { kind: "route_progress" },
    });
  }
  // Thousands of observations of ONE execution are one slot, so nothing overflowed.
  assert.equal(pump.pendingCount, 1);

  // The actor-level kind has no execution to key on, so it collapses onto its own kind.
  for (let index = 0; index < 200; index++) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `body_idle_${index}`,
      revision: index + 1,
      payload: { kind: "body_idle" },
    });
  }
  assert.equal(pump.pendingCount, 2);

  // An OUTCOME semantic event is NOT progress: dropping one would hide an execution that already ended, so it
  // keeps its own slot and can still report an overflow honestly. It gets a pump of its own because the two
  // progress slots above are already held in this one, and this block is about the outcome class alone: 128
  // outcomes fill the window exactly, and the 129th is the honest overflow.
  const outcomePump = new CompanionEventPump();
  for (let index = 0; index < MAX_PENDING_SEMANTIC_EVENTS; index++) {
    outcomePump.enqueueFact({
      source: "stardew_mod",
      kind: "semantic_event",
      correlationId: `settled_${index}`,
      executionId: `exec-${index}`,
      revision: 1,
      payload: { kind: "execution_settled_succeeded" },
    });
  }
  assert.throws(
    () =>
      outcomePump.enqueueFact({
        source: "stardew_mod",
        kind: "semantic_event",
        correlationId: "settled_overflow",
        executionId: "exec-overflow",
        revision: 1,
        payload: { kind: "execution_settled_succeeded" },
      }),
    /event_pump_event_overflow/,
  );
});

test("event pump rejects Host-local data that attempts to impersonate Mod authority", () => {
  const pump = new CompanionEventPump();
  assert.throws(
    () =>
      pump.enqueueFact({
        source: "host_local_transport",
        kind: "snapshot",
        correlationId: "fake",
        revision: 0,
        payload: {},
      } as never),
    /invalid_local_transport_fact/,
  );
});

test("event pump delivers an npc_dialogue_presented world fact to the Agent's context as readable text", async () => {
  const pump = new CompanionEventPump();
  const payload = Object.freeze({
    speaker: "Marnie",
    pages: ["早安，今天也要加油哦。", "你这阵子都没来看我。"],
    isQuestion: false,
    choices: [],
  });
  const fact = {
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "npc_dialogue_marnie_7",
    sourceEventId: "npc_dialogue_marnie_7",
    correlationId: "npc_dialogue_marnie_7",
    revision: 1,
    observedTick: 4242,
    semanticKind: "npc_dialogue_presented",
    payload,
  };
  pump.enqueueFact(fact);
  // Same dialogue identity (identical Mod eventId) re-emitted on a new transport
  // correlation is still one fact; only the Host's world-fact key decides identity.
  pump.enqueueFact({ ...fact, correlationId: "transport_retry" });

  const delivered: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      delivered.push(batch);
    },
  });

  assert.equal(delivered.length, 1);
  const batch = delivered[0]!;
  assert.deepEqual(batch.triggerEventIds, ["npc_dialogue_marnie_7"]);
  // The Mod's payload IS the model-facing content: the Host keeps the readable
  // speaker/pages/isQuestion/choices verbatim and adds no reinterpretation, so
  // these assertions are on agent-visible content, not on an internal code.
  const worldFact = batch.facts.find((candidate) => candidate.semanticKind === "npc_dialogue_presented");
  assert.deepEqual(worldFact?.payload, payload);
  assert.equal("contextProjection" in (worldFact ?? {}), false);
  assert.match(batch.text, /Marnie说：「早安，今天也要加油哦。 你这阵子都没来看我。」/u);
  const event = batch.events.find((candidate) => candidate.semanticKind === "npc_dialogue_presented");
  assert.equal(event?.kind, "world_fact");
  assert.equal(event?.payload?.speaker, "Marnie");
  assert.deepEqual(event?.payload?.pages, ["早安，今天也要加油哦。", "你这阵子都没来看我。"]);
});

test("a body owned by a world transition holds the facts until the day starts", async () => {
  // Measured on a real run (day 5, 22:00): the companion ran `sleep()`, the Mod answered `body_owned_by_day_advance`, and
  // the pump kept delivering - 23:40, a 24:10 full snapshot, then the engine's own `night_ended_pass_out_day_5` at 26:00 -
  // to a character who was asleep. She said "睡到系统替我关灯了", which is the machinery showing through the stage.
  const pump = new CompanionEventPump();
  const receipt = (state: string, extra: Record<string, unknown> = {}) => ({
    source: "stardew_mod" as const,
    kind: "execution_receipt" as const,
    eventId: `receipt_${state}_${String(extra.failureCode ?? "")}`,
    sourceEventId: `receipt_${state}`,
    correlationId: `receipt_${state}`,
    revision: 1,
    observedTick: 100,
    payload: Object.freeze({ state, ...extra }),
  });
  const delivered: string[] = [];
  const sink = {
    async deliver(batch: PendingBatch) {
      delivered.push(batch.text);
    },
  };

  pump.enqueueFact(receipt("rejected", { failureCode: "body_owned_by_day_advance" }) as never);
  assert.equal(pump.isWorldTransition, true, "the Mod saying the body is not ours starts the hold");

  // Facts keep arriving while she is in bed - they must QUEUE, not wake her.
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "night_ended_pass_out_day_5",
    sourceEventId: "night_ended_pass_out_day_5",
    correlationId: "night_ended_pass_out_day_5",
    revision: 1,
    observedTick: 2600,
    semanticKind: "night_ended_pass_out",
    payload: Object.freeze({ kind: "night_ended_pass_out" }),
  } as never);
  assert.equal(await pump.flush(sink), undefined, "a delivery during the hold is refused, not dropped");
  assert.equal(delivered.length, 0, "and nothing reached the companion while she was asleep");

  pump.enqueueFact({
    source: "stardew_mod",
    kind: "lifecycle",
    eventId: "day_started_6",
    sourceEventId: "day_started_6",
    correlationId: "day_started_6",
    revision: 1,
    observedTick: 101,
    payload: Object.freeze({ kind: "day_started" }),
  } as never);
  assert.equal(pump.isWorldTransition, false, "the day starting ends the hold");

  await pump.flush(sink);
  assert.equal(delivered.length, 1, "everything she missed arrives together, with the fact that explains the new day");
  assert.match(delivered[0] ?? "", /夜里没撑住/u, "including the pass-out she was never awake for");
  assert.match(delivered[0] ?? "", /day_started/u, "and the new day");
});

test("a time milestone steers into a running turn while flush is blocked by it", async () => {
  const pump = new CompanionEventPump();
  const milestone = (minute: string) => ({
    source: "stardew_mod" as const,
    kind: "world_fact" as const,
    eventId: `time_milestone_day_5_${minute}`,
    sourceEventId: `time_milestone_day_5_${minute}`,
    correlationId: `time_milestone_day_5_${minute}`,
    revision: 1,
    observedTick: 900,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: minute }),
  });

  // A turn is genuinely running: the first delivery does not resolve until released.
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: "receipt_before_milestone",
    sourceEventId: "receipt_before_milestone",
    correlationId: "receipt_before_milestone",
    revision: 1,
    observedTick: 899,
    payload: Object.freeze({ state: "succeeded" }),
  } as never);

  const delivered: Array<{ disposition: string; kinds: string[] }> = [];
  let releaseFirst: () => void = () => undefined;
  const runningTurn = pump.flush({
    async deliver(batch) {
      delivered.push({ disposition: batch.disposition, kinds: batch.facts.map((fact) => fact.semanticKind ?? "?") });
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
    },
  });
  await Promise.resolve();
  await Promise.resolve();

  // The milestone arrives mid-turn. `flush` cannot carry it - it is already delivering - so `steer` does.
  pump.enqueueFact(milestone("1200"));
  const steered = await pump.steer({
    async deliver(batch) {
      delivered.push({ disposition: batch.disposition, kinds: batch.facts.map((fact) => fact.semanticKind ?? "?") });
    },
  });

  assert.equal(steered, true, "the milestone must be handed to the running turn");
  assert.equal(delivered.length, 2, "and it must arrive while that turn is still running");
  assert.equal(delivered[1]?.disposition, "steer");
  assert.deepEqual(delivered[1]?.kinds, ["time_milestone"]);

  releaseFirst();
  await runningTurn;
});

test("flush never steers, whatever is pending: a steer is not a turn", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "time_milestone_day_5_1800",
    sourceEventId: "time_milestone_day_5_1800",
    correlationId: "time_milestone_day_5_1800",
    revision: 1,
    observedTick: 901,
    semanticKind: "time_milestone",
    payload: Object.freeze({ milestone: "1800" }),
  });

  const dispositions: string[] = [];
  await pump.flush({
    async deliver(batch) {
      dispositions.push(batch.disposition);
    },
  });

  // The batch's disposition may be `steer` (the caller asked for it), but it is delivered as a TURN by `flush`.
  // What must not happen is `flush` injecting into a turn it does not own, which is why the running-turn test above
  // uses `steer()` and this one asserts the ordinary path is untouched.
  assert.equal(dispositions.length, 1, "a pending milestone still forms one ordinary delivery");
});

test("an ordinary fact is never steered, because a receipt does not expire", async () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: "receipt_alone",
    sourceEventId: "receipt_alone",
    correlationId: "receipt_alone",
    revision: 2,
    observedTick: 902,
    payload: Object.freeze({ state: "succeeded" }),
  } as never);

  assert.equal(pump.hasExpiringFact, false, "a terminal receipt must not be treated as expiring");
  const steered = await pump.steer({
    async deliver() {
      throw new Error("nothing should be steered");
    },
  });
  assert.equal(steered, false, "there was nothing expiring to hand over");
});
