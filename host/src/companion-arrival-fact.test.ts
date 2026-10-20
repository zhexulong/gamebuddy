import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  COMPANION_ARRIVAL_EVENT_ID,
  COMPANION_ARRIVAL_SEMANTIC_KIND,
  COMPANION_ARRIVAL_SOURCE,
  companionArrivalAlreadySaid,
  companionArrivalFact,
} from "./companion-arrival-fact.js";
import type { WorldFact } from "./event-pump.js";
import { CompanionHostService } from "./host-service.js";

/** The attach boundary and the pump, reduced to what the arrival decision reads. */
function attachHarness() {
  const facts: WorldFact[] = [];
  let factListener: ((fact: WorldFact) => void) | undefined;
  return {
    loop: {
      pump: {
        pendingCount: 0,
        enqueueFact(fact: WorldFact) {
          facts.push(fact);
        },
        enqueuePlayerInput() {},
      },
      async flush() {},
    },
    events: {
      onFact(next: (fact: WorldFact) => void) {
        factListener = next;
        return () => {
          factListener = undefined;
        };
      },
      onLifecycle() {
        return () => {};
      },
    },
    facts,
    emit(fact: WorldFact) {
      factListener?.(fact);
    },
  };
}

/** A real Mod snapshot payload, read off the wire contract (see `protocol.ts`'s `Snapshot`). */
const SNAPSHOT_PAYLOAD = Object.freeze({
  revision: 1,
  presentationLocale: "en-US",
  timeOfDay: 610,
  dayOfMonth: 4,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
  location: "Farm",
});

const snapshotFact = (
  revision: number,
  payload: Readonly<Record<string, unknown>> = { ...SNAPSHOT_PAYLOAD, revision },
): WorldFact => ({
  source: "stardew_mod",
  kind: "snapshot",
  eventId: `snapshot_${revision}`,
  occurredAtMs: 1000 + revision,
  correlationId: `snapshot_${revision}`,
  revision,
  payload,
});

const arrivalsIn = (facts: readonly WorldFact[]): WorldFact[] =>
  facts.filter((fact) => fact.semanticKind === COMPANION_ARRIVAL_SEMANTIC_KIND);

/** A Pi session reduced to what `CompanionLoop` needs; it records the batch it was handed. */
function recordingSession(delivered: string[]) {
  return {
    async sendUserMessage(text: string) {
      delivered.push(text);
    },
    async abort() {},
    clearQueue() {},
    async waitForIdle() {},
  };
}

test("attach plus the first clock reading says she has arrived exactly once, with the day's own weather and time", () => {
  const harness = attachHarness();
  const service = new CompanionHostService(harness.loop as never, harness.events as never);
  try {
    service.acceptInitialFacts([]);
    harness.emit(snapshotFact(1));

    const arrivals = arrivalsIn(harness.facts);
    assert.equal(arrivals.length, 1, "attach plus one usable clock reading mints exactly one arrival fact");
    const arrival = arrivals[0]!;
    const projection = arrival.contextProjection as Readonly<Record<string, unknown>>;
    assert.equal(
      arrival.payload.timeOfDay,
      SNAPSHOT_PAYLOAD.timeOfDay,
      `the arrival carries the snapshot's own clock reading, rendered as "${String(projection.time)}"`,
    );
    assert.equal(
      arrival.payload.weather,
      SNAPSHOT_PAYLOAD.weather,
      `the arrival carries the day's own weather, rendered as "${String(projection.weather)}"`,
    );
    assert.equal(projection.time, "6:10 AM");
    assert.equal(projection.weather, "weather: sunny");
    assert.equal(projection.date, "Year 1, Day 4 of Spring");
    assert.match(String(projection.text), /^You have just arrived on this farm /);
    // The snapshot itself is not a turn: it follows the arrival, which is the fact that speaks.
    assert.deepEqual(
      harness.facts.map((fact) => fact.kind),
      ["world_fact", "snapshot"],
    );
  } finally {
    service.close();
  }
});

test("a second tick in the same session says nothing, and a transcript that already carries it stays silent", async () => {
  // The live switch: one mounted session cannot say it twice.
  const harness = attachHarness();
  const service = new CompanionHostService(harness.loop as never, harness.events as never);
  try {
    service.acceptInitialFacts([]);
    harness.emit(snapshotFact(1));
    service.acceptInitialFacts([]);
    harness.emit(snapshotFact(2));
    assert.equal(
      arrivalsIn(harness.facts).length,
      1,
      "a second attach and a second tick in the same session mint no further arrival fact",
    );
  } finally {
    service.close();
  }

  // The durable half: the Game session's own transcript already holds this fact's batch.
  const delivered: string[] = [];
  const loop = new CompanionLoop(recordingSession(delivered) as never);
  loop.pump.enqueueFact(companionArrivalFact(SNAPSHOT_PAYLOAD)!);
  await loop.flush();
  assert.equal(delivered.length, 1);
  assert.equal(
    companionArrivalAlreadySaid({
      getBranch: () => [
        { type: "message", message: { role: "user", content: [{ type: "text", text: delivered[0]! }] } },
      ],
    } as never),
    true,
    "the persisted arrival batch is what the transcript reports as already said",
  );
  assert.equal(
    companionArrivalAlreadySaid({
      getBranch: () => [
        { type: "message", message: { role: "user", content: [{ type: "text", text: "not the arrival" }] } },
      ],
    } as never),
    false,
    "a transcript without the arrival batch does not suppress it",
  );

  const replayHarness = attachHarness();
  const replay = new CompanionHostService(
    replayHarness.loop as never,
    replayHarness.events as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    { alreadySaid: () => true },
  );
  try {
    replay.acceptInitialFacts([]);
    replayHarness.emit(snapshotFact(1));
    assert.equal(
      arrivalsIn(replayHarness.facts).length,
      0,
      "a session whose transcript already carries the arrival mints nothing on a re-attach",
    );
  } finally {
    replay.close();
  }
});

test("a snapshot with no usable clock says nothing, and the first real reading still speaks", () => {
  const harness = attachHarness();
  const service = new CompanionHostService(harness.loop as never, harness.events as never);
  try {
    service.acceptInitialFacts([]);
    // A world that has not started its day publishes `timeOfDay: 0`.
    harness.emit(snapshotFact(1, { ...SNAPSHOT_PAYLOAD, revision: 1, timeOfDay: 0 }));
    assert.equal(arrivalsIn(harness.facts).length, 0, "attach alone says nothing while the clock has not ticked");

    harness.emit(snapshotFact(2));
    const arrivals = arrivalsIn(harness.facts);
    assert.equal(
      arrivals.length,
      1,
      "the first usable reading still speaks, because no greeting was made for the empty one",
    );
    assert.equal(arrivals[0]!.payload.timeOfDay, SNAPSHOT_PAYLOAD.timeOfDay);
  } finally {
    service.close();
  }
});

test("the arrival rides world_fact with semanticKind companion_arrival, and the loop's whitelist is what opens its turn", async () => {
  const arrival = companionArrivalFact(SNAPSHOT_PAYLOAD);
  assert.notEqual(arrival, undefined);
  assert.equal(arrival!.kind, "world_fact");
  assert.equal(arrival!.semanticKind, COMPANION_ARRIVAL_SEMANTIC_KIND);
  assert.equal(arrival!.eventId, COMPANION_ARRIVAL_EVENT_ID);
  assert.equal(arrival!.source, COMPANION_ARRIVAL_SOURCE);

  const opened: string[] = [];
  const delivered: string[] = [];
  const loop = new CompanionLoop(recordingSession(delivered) as never, {
    beginPlayerBatch(sourceEventId) {
      opened.push(sourceEventId);
    },
    endBatch() {},
  });
  loop.pump.enqueueFact(arrival!);
  await loop.flush();
  assert.equal(delivered.length, 1, "the arrival reaches Pi as one turn");
  assert.deepEqual(opened, [COMPANION_ARRIVAL_EVENT_ID], "the arrival opens its own presentation lease");

  // Any other new kind is delivered as a world fact but never opens a turn of its own: the
  // whitelist, not `world_fact` itself, is what grants that.
  const unlistedOpened: string[] = [];
  const unlistedDelivered: string[] = [];
  const unlisted = new CompanionLoop(recordingSession(unlistedDelivered) as never, {
    beginPlayerBatch(sourceEventId) {
      unlistedOpened.push(sourceEventId);
    },
    endBatch() {},
  });
  unlisted.pump.enqueueFact({
    source: COMPANION_ARRIVAL_SOURCE,
    kind: "world_fact",
    eventId: "weather_changed_01",
    sourceEventId: "weather_changed_01",
    correlationId: "weather_changed_01",
    revision: 0,
    semanticKind: "weather_changed",
    payload: Object.freeze({ kind: "weather_changed" }),
  });
  await unlisted.flush();
  assert.equal(unlistedDelivered.length, 1);
  assert.deepEqual(unlistedOpened, [], "an unlisted world-fact kind does not open a turn");
});
