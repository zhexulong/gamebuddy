import assert from "node:assert/strict";
import test from "node:test";

import { CompanionLoop } from "./companion-loop.js";
import {
  COMPANION_ARRIVAL_EVENT_ID,
  COMPANION_ARRIVAL_SEMANTIC_KIND,
  COMPANION_ARRIVAL_SOURCE,
  companionArrivalFact,
} from "./companion-arrival-fact.js";
import { FACT_PRODUCER, type WorldFact } from "./event-pump.js";
import { composeFactBrief } from "./fact-brief.js";
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
  presentationLocale: "zh-CN",
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

test("attach plus the first clock reading opens the arrival turn, and the fact carries no message of its own", () => {
  const harness = attachHarness();
  const service = new CompanionHostService(harness.loop as never, harness.events as never);
  try {
    service.acceptInitialFacts([]);
    harness.emit(snapshotFact(1));

    const arrivals = arrivalsIn(harness.facts);
    assert.equal(arrivals.length, 1, "attach plus one usable clock reading mints exactly one arrival fact");
    const arrival = arrivals[0]!;
    assert.equal(arrival.contextProjection, undefined, "the arrival hands the model no prose of its own");
    assert.deepEqual(
      arrival.payload,
      { kind: COMPANION_ARRIVAL_SEMANTIC_KIND },
      "the fact carries the EVENT: the clock, the date, the weather and the place are the snapshot's, and " +
        "<world-state> in the same batch prints them",
    );
    assert.equal(arrival.semanticKind, COMPANION_ARRIVAL_SEMANTIC_KIND);
    // The snapshot itself is not a turn: it follows the arrival, which is the fact that opens one.
    assert.deepEqual(
      harness.facts.map((fact) => fact.kind),
      ["world_fact", "snapshot"],
    );
  } finally {
    service.close();
  }
});

test("a second tick in the same session opens no second arrival turn", () => {
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
    assert.equal(
      arrivalsIn(harness.facts).length,
      1,
      "the first usable reading still speaks, because no arrival was made for the empty one",
    );
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
  loop.pump.enqueueFact(arrival!, FACT_PRODUCER.companionArrival);
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
  unlisted.pump.enqueueFact(
    {
      source: COMPANION_ARRIVAL_SOURCE,
      kind: "world_fact",
      eventId: "weather_changed_01",
      sourceEventId: "weather_changed_01",
      correlationId: "weather_changed_01",
      revision: 0,
      semanticKind: "weather_changed",
      payload: Object.freeze({ kind: "weather_changed" }),
    },
    FACT_PRODUCER.companionArrival,
  );
  await unlisted.flush();
  assert.equal(unlistedDelivered.length, 1);
  assert.deepEqual(unlistedOpened, [], "an unlisted world-fact kind does not open a turn");
});

// ---------------------------------------------------------------------------------------------------------------
// `arrival_fact_states_a_fact_the_block_already_states:<field>`
// ---------------------------------------------------------------------------------------------------------------

/**
 * The arrival and `<world-state>` arrive in ONE batch, and the block already prints every field the arrival could
 * state: `round63`'s own delivered text read `06:00（清晨）；1年第5天 春季；天气：晴天；位置: 农舍`.
 *
 * <p>
 * So the property is not "the arrival states facts rather than tone" - it is that the arrival states NO snapshot field
 * at all, because `<world-state>` states all of them for the same snapshot. Until 2026-11-22 the fact appended its own
 * sentence over the same five values, and the two renderings disagreed (`此刻在Farm` beside `位置: 农场`): one claim
 * with two writers, which `design/input-authority.md` § three makes a defect. The arrival owns the event; the block owns
 * the state.
 * </p>
 *
 * <p>
 * POPULATION FROM THE AUTHORITY, NOT FROM A LIST. The population is every snapshot field `<world-state>` is actually
 * sensitive to, derived by mutating one field of the delivered snapshot and asking whether the block changes. A field
 * the block states is a field the arrival must not state again. The probe is its own instrument check: if the block
 * side went silent the population would be empty and "no overlap" would be true of nothing, so an empty population
 * fails here rather than passing, and the fields the block states are printed.
 * </p>
 *
 * <p>
 * THE ARRIVAL'S SIDE is the part of the same delivered batch that exists only because of the fact: the batch composed
 * with it minus the batch composed without it. That is the text the model reads for this fact, and the only thing a
 * `contextProjection` could add to it.
 * </p>
 *
 * <p>
 * RED ON REAL HISTORY, not on an injected fixture: run this file against HEAD's own `companion-arrival-fact.ts` and
 * `fact-brief.ts` (`git show HEAD:host/src/...`) and the gate names `timeOfDay, dayOfMonth, seasonIndex, year, weather,
 * location` while the batch carries the paragraph beside the block that states the same five values twice. No synthetic
 * injection is shipped beside it: today's `fact-brief.ts` still forwards a `contextProjection.text` for this kind, so an
 * injection would be a reading of that renderer, and the lane that owns the file is deleting it.
 * </p>
 */
type StatedFields = Readonly<{
  /** The fields of this snapshot `<world-state>` states, in payload order. */
  population: readonly string[];
  /** The fields of those the arrival states as well: the finding, each named `<field>`. */
  overlaps: readonly string[];
  /** The `<world-state>` block of the batch, verbatim. */
  block: string;
  /** The arrival's own contribution to the batch, verbatim. */
  arrival: string;
}>;

/** The delivery locale the block and the fact are read in: the product's own default brief language. */
const ARRIVAL_PROBE_LOCALE = "zh-CN";

function deliveredBatch(
  snapshot: Readonly<Record<string, unknown>>,
  arrival: WorldFact | undefined,
): Readonly<{ block: string; arrival: string }> {
  const reading = { snapshot, revision: 1, ageTurns: 0, ageMs: 0 } as never;
  const block = composeFactBrief({ inputs: [], snapshot: reading, events: [], locale: ARRIVAL_PROBE_LOCALE });
  const whole = composeFactBrief({
    inputs: [],
    snapshot: reading,
    events: arrival === undefined ? [] : [arrival],
    locale: ARRIVAL_PROBE_LOCALE,
  });
  assert.ok(whole.startsWith(block), "the arrival's contribution is the tail of the batch after <world-state>");
  return { block, arrival: whole.slice(block.length) };
}

function statedFields(
  snapshot: Readonly<Record<string, unknown>>,
  arrivalOf: (snapshot: Readonly<Record<string, unknown>>) => WorldFact | undefined,
): StatedFields {
  const base = deliveredBatch(snapshot, arrivalOf(snapshot));
  const probed = Object.entries(snapshot).map(([field, value]) => {
    // A numeric field moves by one, a string field by a suffix: both stay the same KIND of value, so a renderer
    // that would reject the mutation outright cannot make a field look silent.
    const muted = Object.freeze({
      ...snapshot,
      [field]: typeof value === "number" ? value + 1 : `${String(value)}_probe`,
    });
    const next = deliveredBatch(muted, arrivalOf(muted));
    return { field, block: next.block !== base.block, arrival: next.arrival !== base.arrival };
  });
  return Object.freeze({
    population: Object.freeze(probed.filter((entry) => entry.block).map((entry) => entry.field)),
    overlaps: Object.freeze(probed.filter((entry) => entry.block && entry.arrival).map((entry) => entry.field)),
    block: base.block,
    arrival: base.arrival,
  });
}

test("the arrival states no field the block already states in the same batch", () => {
  const reading = statedFields(SNAPSHOT_PAYLOAD, (snapshot) => companionArrivalFact(snapshot));
  process.stdout.write(
    `\narrival_fact_states_a_fact_the_block_already_states: fields the block states ${reading.population.join(", ")} · ` +
      `stated twice ${reading.overlaps.join(", ") === "" ? "none" : reading.overlaps.join(", ")}\n` +
      `<batch>\n${reading.block}${reading.arrival}\n</batch>\n`,
  );
  assert.ok(
    reading.population.length > 0,
    "the probe found no snapshot field <world-state> states, so this check is about nothing: the block side of the " +
      "instrument is dead, not the arrival clean",
  );
  assert.notEqual(
    reading.arrival,
    "",
    "the arrival still contributes one <world-facts> line to the batch; an opener that composes to nothing opens no turn",
  );
  assert.deepEqual(
    reading.overlaps,
    [],
    `the arrival restates ${reading.overlaps.join(", ")}, and <world-state> already states those in the same batch: ` +
      "delete the sentence, do not rewrite it in another spelling",
  );
});
