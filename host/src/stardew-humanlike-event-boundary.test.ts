import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump } from "./event-pump.js";
import {
  type BridgeMessage,
  type Envelope,
  MAX_WORLD_FACT_PAYLOAD_JSON_BYTES,
  newEnvelope,
  type Scope,
  validateBridgeMessage,
  isWorldFactMessage,
  isWorldFactPayload,
} from "./protocol.js";
import { toWorldFact } from "./stardew-integration-launcher-body-program.internal.js";
import type { LocalStardewBridgeFact } from "./local-stardew-bridge.js";

const scope: Scope = Object.freeze({
  integrationId: "stardew",
  saveId: "save_farm",
  worldId: "world_farm",
  playerId: "farmhand_01",
  companionId: "companion_01",
});

const baseTimestampMs = 1_700_000_000_000;

function createWorldFactMessage(
  payloadOverrides: Partial<{
    eventId: string;
    sourceEventId: string;
    kind: string;
    observedTick: number;
    gameTime: string | null;
    revision: number;
    deduplicationKey?: string;
    payload?: Record<string, unknown>;
    payloadJson?: string;
  }> = {},
  envelopeOverrides: Partial<Envelope<"world_fact", unknown>> = {},
): BridgeMessage {
  const payload = {
    eventId: "day_started_day_1",
    sourceEventId: "day_started_day_1",
    kind: "day_started",
    observedTick: 100,
    gameTime: "0600",
    revision: 1,
    deduplicationKey: "day_started_day_1",
    payload: { day: 1 },
    ...payloadOverrides,
  };
  const env = newEnvelope("world_fact", scope, payload as never, "corr_wf_1", baseTimestampMs);
  return { ...env, ...envelopeOverrides } as BridgeMessage;
}

test("protocol validator accepts well-formed world_fact message", () => {
  const message = createWorldFactMessage();
  assert.equal(validateBridgeMessage(message, scope, baseTimestampMs), null);
  assert.equal(isWorldFactMessage(message), true);
  assert.equal(isWorldFactPayload(message.payload), true);
});

test("protocol validator rejects malformed world_fact messages", () => {
  // Missing eventId
  const missingEventId = createWorldFactMessage({ eventId: undefined as never });
  assert.equal(validateBridgeMessage(missingEventId, scope, baseTimestampMs), "invalid_world_fact");

  // Invalid eventId characters
  const invalidEventId = createWorldFactMessage({ eventId: "invalid space!" });
  assert.equal(validateBridgeMessage(invalidEventId, scope, baseTimestampMs), "invalid_world_fact");

  // Missing sourceEventId
  const missingSourceEventId = createWorldFactMessage({ sourceEventId: undefined as never });
  assert.equal(validateBridgeMessage(missingSourceEventId, scope, baseTimestampMs), "invalid_world_fact");

  // Negative observedTick
  const negativeTick = createWorldFactMessage({ observedTick: -1 });
  assert.equal(validateBridgeMessage(negativeTick, scope, baseTimestampMs), "invalid_world_fact");

  // Non-integer observedTick
  const floatTick = createWorldFactMessage({ observedTick: 1.5 });
  assert.equal(validateBridgeMessage(floatTick, scope, baseTimestampMs), "invalid_world_fact");

  // Negative revision
  const negativeRev = createWorldFactMessage({ revision: -1 });
  assert.equal(validateBridgeMessage(negativeRev, scope, baseTimestampMs), "invalid_world_fact");

  // Invalid deduplicationKey
  const badDedup = createWorldFactMessage({ deduplicationKey: "bad key with spaces!" });
  assert.equal(validateBridgeMessage(badDedup, scope, baseTimestampMs), "invalid_world_fact");

  // Unknown extra property in payload
  const extraProps = createWorldFactMessage();
  (extraProps.payload as Record<string, unknown>).extraField = "forbidden";
  assert.equal(validateBridgeMessage(extraProps, scope, baseTimestampMs), "invalid_world_fact");
});

test("world_fact boundary requires exactly one payload representation", () => {
  // Neither the structured object nor the JSON string representation is present.
  const missingBoth = createWorldFactMessage({ payload: undefined, payloadJson: undefined });
  assert.equal(validateBridgeMessage(missingBoth, scope, baseTimestampMs), "invalid_world_fact");

  // Both representations are present; only one bounded shape may cross the boundary.
  const bothPresent = createWorldFactMessage({ payload: { day: 1 }, payloadJson: JSON.stringify({ day: 1 }) });
  assert.equal(validateBridgeMessage(bothPresent, scope, baseTimestampMs), "invalid_world_fact");

  // The JSON string representation must parse into an object, never an array or scalar.
  const malformedJson = createWorldFactMessage({ payload: undefined, payloadJson: "{not json" });
  assert.equal(validateBridgeMessage(malformedJson, scope, baseTimestampMs), "invalid_world_fact");

  const arrayJson = createWorldFactMessage({ payload: undefined, payloadJson: JSON.stringify([1, 2, 3]) });
  assert.equal(validateBridgeMessage(arrayJson, scope, baseTimestampMs), "invalid_world_fact");

  const scalarJson = createWorldFactMessage({ payload: undefined, payloadJson: JSON.stringify("day") });
  assert.equal(validateBridgeMessage(scalarJson, scope, baseTimestampMs), "invalid_world_fact");

  // The structured object representation must be a plain record, never an array.
  const arrayPayload = createWorldFactMessage({ payload: [1, 2, 3] as never });
  assert.equal(validateBridgeMessage(arrayPayload, scope, baseTimestampMs), "invalid_world_fact");

  // A single parsed object via either representation is accepted.
  assert.equal(validateBridgeMessage(createWorldFactMessage(), scope, baseTimestampMs), null);
  const jsonOnly = createWorldFactMessage({ payload: undefined, payloadJson: JSON.stringify({ day: 5 }) });
  assert.equal(validateBridgeMessage(jsonOnly, scope, baseTimestampMs), null);
  assert.equal(isWorldFactMessage(jsonOnly), true);
});

test("world_fact JSON payload representation is bounded below the frame limit", () => {
  const objectEnvelopeBytes = Buffer.byteLength(JSON.stringify({ padding: "" }), "utf8");
  const atBound = createWorldFactMessage({
    payload: undefined,
    payloadJson: JSON.stringify({ padding: "x".repeat(MAX_WORLD_FACT_PAYLOAD_JSON_BYTES - objectEnvelopeBytes) }),
  });
  assert.equal(
    Buffer.byteLength((atBound.payload as Record<string, unknown>).payloadJson as string, "utf8"),
    MAX_WORLD_FACT_PAYLOAD_JSON_BYTES,
  );
  assert.equal(validateBridgeMessage(atBound, scope, baseTimestampMs), null);

  const overBound = createWorldFactMessage({
    payload: undefined,
    payloadJson: JSON.stringify({ padding: "x".repeat(MAX_WORLD_FACT_PAYLOAD_JSON_BYTES - objectEnvelopeBytes + 1) }),
  });
  assert.equal(validateBridgeMessage(overBound, scope, baseTimestampMs), "invalid_world_fact");
});

test("toWorldFact preserves stable Mod event ID and properties without replacing with bridge messageId", () => {
  const message = createWorldFactMessage({
    eventId: "time_milestone_day_2_1200",
    sourceEventId: "time_milestone_day_2_1200",
    kind: "time_milestone",
    observedTick: 2500,
    gameTime: "1200",
    revision: 3,
    payload: { milestone: "1200" },
  }) as LocalStardewBridgeFact;

  const fact = toWorldFact(message);

  assert.equal(fact.source, "stardew_mod");
  assert.equal(fact.kind, "world_fact");
  assert.equal(fact.eventId, "time_milestone_day_2_1200");
  assert.equal(fact.sourceEventId, "time_milestone_day_2_1200");
  assert.equal(fact.correlationId, "time_milestone_day_2_1200");
  assert.notEqual(fact.eventId, message.messageId);
  assert.notEqual(fact.correlationId, message.correlationId);
  assert.equal(fact.observedTick, 2500);
  assert.equal(fact.gameTime, "1200");
  assert.equal(fact.revision, 3);
  assert.deepEqual(fact.payload, { milestone: "1200" });
  assert.equal(fact.occurredAtMs, baseTimestampMs);
});

test("toWorldFact parses payloadJson when structured payload object is absent", () => {
  const message = createWorldFactMessage({
    eventId: "day_started_day_5",
    sourceEventId: "day_started_day_5",
    kind: "day_started",
    observedTick: 500,
    revision: 1,
    payload: undefined,
    payloadJson: JSON.stringify({ day: 5, season: "spring" }),
  }) as LocalStardewBridgeFact;

  const fact = toWorldFact(message);
  assert.deepEqual(fact.payload, { day: 5, season: "spring" });
});

test("toWorldFact fails closed on missing eventId or sourceEventId", () => {
  assert.throws(
    () =>
      toWorldFact({
        type: "world_fact",
        messageId: "m1",
        correlationId: "c1",
        protocolVersion: 1,
        timestampMs: baseTimestampMs,
        scope,
        payload: {
          eventId: "",
          sourceEventId: "s1",
          kind: "day_started",
          observedTick: 1,
          revision: 1,
        },
      } as never),
    /invalid_world_fact_event_id/,
  );

  assert.throws(
    () =>
      toWorldFact({
        type: "world_fact",
        messageId: "m1",
        correlationId: "c1",
        protocolVersion: 1,
        timestampMs: baseTimestampMs,
        scope,
        payload: {
          eventId: "e1",
          sourceEventId: "",
          kind: "day_started",
          observedTick: 1,
          revision: 1,
        },
      } as never),
    /invalid_world_fact_source_event_id/,
  );
});

test("event pump keeps one world fact per stable eventId even when the transport correlationId changes", async () => {
  const pump = new CompanionEventPump();
  const eventId = "time_milestone_day_1_0600";

  // First transport frame carries correlationId from the old pipe generation.
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: "transport_a",
    observedTick: 100,
    revision: 1,
    payload: { milestone: "0600" },
  });
  // Reconnect rewrites the transport correlationId, but the Mod eventId is the stable identity.
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: "transport_b",
    observedTick: 100,
    revision: 2,
    payload: { milestone: "0600", updated: true },
  });
  assert.equal(pump.pendingCount, 1);

  const delivered: Array<{ text: string }> = [];
  await pump.flush({
    async deliver(text) {
      delivered.push({ text });
    },
  });
  const batch = JSON.parse(delivered[0]?.text ?? "{}") as {
    worldFacts: Array<{ eventId: string; revision: number }>;
    events: Array<{ eventId: string; revision: number }>;
  };
  assert.equal(batch.worldFacts.length, 1);
  assert.equal(batch.worldFacts[0]?.eventId, eventId);
  assert.equal(batch.worldFacts[0]?.revision, 2);
  assert.deepEqual(batch.events.map((entry) => entry.eventId), [eventId]);
});

test("event pump preserves stable event ID across repeated frames and reconnects", () => {
  const pump = new CompanionEventPump();
  const eventId = "time_milestone_day_1_0600";

  // Initial delivery
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    observedTick: 100,
    revision: 1,
    payload: { milestone: "0600" },
  });
  assert.equal(pump.pendingCount, 1);

  // Redelivery after reconnect with same correlationId & revision
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    observedTick: 100,
    revision: 1,
    payload: { milestone: "0600" },
  });
  assert.equal(pump.pendingCount, 1);

  // Redelivery with higher revision replaces pending fact
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    observedTick: 100,
    revision: 2,
    payload: { milestone: "0600", updated: true },
  });
  assert.equal(pump.pendingCount, 1);
});

test("event pump enforces bounded queue limit of 32 for world facts and handles overflow", () => {
  const pump = new CompanionEventPump();

  // Enqueue 32 distinct world facts
  for (let i = 0; i < 32; i++) {
    pump.enqueueFact({
      source: "stardew_mod",
      kind: "world_fact",
      eventId: `fact_${i}`,
      correlationId: `fact_${i}`,
      observedTick: i * 10,
      revision: 1,
      payload: { index: i },
    });
  }
  assert.equal(pump.pendingCount, 32);

  // Enqueueing an existing correlationId does not overflow
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_0",
    correlationId: "fact_0",
    observedTick: 0,
    revision: 2,
    payload: { index: 0, replaced: true },
  });
  assert.equal(pump.pendingCount, 32);

  // Enqueueing a 33rd distinct fact throws overflow
  assert.throws(
    () =>
      pump.enqueueFact({
        source: "stardew_mod",
        kind: "world_fact",
        eventId: "fact_32",
        correlationId: "fact_32",
        observedTick: 320,
        revision: 1,
        payload: { index: 32 },
      }),
    /event_pump_event_overflow/,
  );
});

test("event pump sorts world facts deterministically by observedTick -> revision -> eventId regardless of transport wall clock", async () => {
  const pump = new CompanionEventPump();

  // Enqueue out of order with respect to observedTick, and give misleading occurredAtMs (wall clock)
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_c",
    correlationId: "c",
    observedTick: 300,
    revision: 1,
    occurredAtMs: 100, // Earlier transport time, but later tick
    payload: { name: "c" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_a",
    correlationId: "a",
    observedTick: 100,
    revision: 1,
    occurredAtMs: 500, // Later transport time, but earlier tick
    payload: { name: "a" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_b_rev2",
    correlationId: "b2",
    observedTick: 200,
    revision: 2,
    occurredAtMs: 300,
    payload: { name: "b_rev2" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_b_rev1",
    correlationId: "b1",
    observedTick: 200,
    revision: 1,
    occurredAtMs: 300,
    payload: { name: "b_rev1" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_d_2",
    correlationId: "d2",
    observedTick: 400,
    revision: 1,
    occurredAtMs: 400,
    payload: { name: "d2" },
  });
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "fact_d_1",
    correlationId: "d1",
    observedTick: 400,
    revision: 1,
    occurredAtMs: 400,
    payload: { name: "d1" },
  });

  const delivered: Array<{ text: string; disposition: string }> = [];
  await pump.flush({
    async deliver(text, disposition) {
      delivered.push({ text, disposition });
    },
  });

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0]?.disposition, "follow_up");

  const batch = JSON.parse(delivered[0]?.text ?? "{}") as {
    worldFacts: Array<{ eventId: string; observedTick: number; revision: number }>;
    events: Array<{ eventId: string; observedTick?: number; revision: number }>;
  };

  const expectedEventIds = [
    "fact_a",      // tick 100
    "fact_b_rev1", // tick 200, rev 1
    "fact_b_rev2", // tick 200, rev 2
    "fact_c",      // tick 300
    "fact_d_1",    // tick 400, rev 1, eventId d_1
    "fact_d_2",    // tick 400, rev 1, eventId d_2
  ];

  assert.deepEqual(
    batch.worldFacts.map((f) => f.eventId),
    expectedEventIds,
  );
  assert.deepEqual(
    batch.events.map((e) => e.eventId),
    expectedEventIds,
  );
});

test("world-only fact triggers follow_up disposition and held snapshot/progress facts attach without holding", async () => {
  const pump = new CompanionEventPump();

  // Snapshot is held
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: "snap_1",
    revision: 10,
    payload: { location: "Farm" },
  });

  // Meaningful progress receipt is held
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    correlationId: "exec_1",
    revision: 1,
    payload: { state: "meaningful_progress" },
  });

  // Verify that held facts alone do not trigger delivery
  let flushed = false;
  await pump.flush({
    async deliver() {
      flushed = true;
    },
  });
  assert.equal(flushed, false);
  assert.equal(pump.hasPendingDelivery, false);

  // Now enqueue a world fact: it is an active trigger
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "day_started_day_1",
    correlationId: "day_started_day_1",
    observedTick: 1,
    revision: 1,
    payload: { day: 1 },
  });
  assert.equal(pump.hasPendingDelivery, true);

  const deliveries: Array<{ text: string; disposition: string }> = [];
  await pump.flush({
    async deliver(text, disposition) {
      deliveries.push({ text, disposition });
    },
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.disposition, "follow_up");

  const batch = JSON.parse(deliveries[0]?.text ?? "{}") as {
    triggerEventIds: string[];
    worldFacts: Array<{ kind: string }>;
  };

  assert.deepEqual(batch.triggerEventIds, ["day_started_day_1"]);
  assert.deepEqual(
    batch.worldFacts.map((f) => f.kind),
    ["snapshot", "execution_receipt", "world_fact"],
  );
  assert.equal(pump.pendingCount, 0);
});

test("player input elevates batch disposition to steer with world facts present", async () => {
  const pump = new CompanionEventPump();

  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "day_started_day_2",
    correlationId: "day_started_day_2",
    observedTick: 10,
    revision: 1,
    payload: { day: 2 },
  });

  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_hello",
    text: "早上好",
    locale: "zh-CN",
    timestampMs: baseTimestampMs,
  });

  const deliveries: Array<{ text: string; disposition: string }> = [];
  await pump.flush({
    async deliver(text, disposition) {
      deliveries.push({ text, disposition });
    },
  });

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0]?.disposition, "steer");
});

test("pump clear flushes all pending world facts", () => {
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "world_fact",
    eventId: "wf_1",
    correlationId: "wf_1",
    observedTick: 1,
    revision: 1,
    payload: {},
  });
  assert.equal(pump.pendingCount, 1);
  assert.equal(pump.hasPendingDelivery, true);

  pump.clear();
  assert.equal(pump.pendingCount, 0);
  assert.equal(pump.hasPendingDelivery, false);
});
