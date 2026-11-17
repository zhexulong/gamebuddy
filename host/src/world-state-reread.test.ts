/**
 * GATE `a_world_reread_is_not_a_world_aged` - and the pair of ages that keeps the two claims apart.
 *
 * <p>
 * MEASURED 2026-11-21 (`round66`, `round67`): the Mod answered an `observe_request` every thirty seconds for the whole
 * run - nine `GAME_CLOCK_READ` lines walking the clock 06:10 -> 08:10 - while the Host's own stale accounting advanced as
 * if nobody had looked. One field was doing two jobs: `#lastSnapshotArrivedAtMs` advanced only when a reading said
 * something DIFFERENT, so a world re-read and confirmed identical kept ageing, and the block the model was handed could
 * say its picture was minutes old when the Mod had answered seconds ago. The model then decides on that belief, which is
 * why this is a product path and not a log annotation.
 * </p>
 *
 * <p>
 * THE TWO AGES ARE TWO FACTS, and the gate asks for both in one reading:
 * </p>
 * <ul>
 *   <li>`ageMs` - how long since the world was READ, by any caller, whatever it said. A re-read restarts it.</li>
 *   <li>`contentAgeMs` - how old the PICTURE is: the number `world_state_stale` invalidates, restarted only by a reading
 *       that says something else.</li>
 * </ul>
 *
 * <p>
 * The clock is injected, so "thirty seconds later" is arithmetic rather than a sleep, and the two windows below differ in
 * ONE thing - how long before the world's contradiction the last read happened - so the two ages cannot be satisfied by
 * one number. The falsifier runs the other way in the same test: a reading that says something ELSE restarts both.
 * </p>
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CompanionEventPump,
  FACT_PRODUCER,
  type PendingBatch,
  WORLD_STATE_STALE_SEMANTIC_KIND,
  type WorldFact,
} from "./event-pump.js";
import { WORLD_STATE_STALE_TURNS, worldStateStaleCode } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";

/** The world as the Mod admitted it, at `timeOfDay`: one reading, whose clock can be moved to make content differ. */
function reading(timeOfDay: number, revision = 352): Snapshot {
  return {
    revision,
    location: "FarmHouse",
    tile: { x: 9, y: 9 },
    stamina: 270,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay,
    dayOfMonth: 6,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    currentTool: "(T)Axe",
    currentToolSlot: 0,
    toolSlots: [],
    inventoryItemFacts: [],
    cropTargets: [],
    harvestTargets: [],
  } as unknown as Snapshot;
}

function snapshotFact(at: Snapshot, index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId: `snapshot_${String(index)}`,
    correlationId: `observe_${String(index)}`,
    revision: at.revision,
    payload: at as never,
  });
}

/** The world's own statement that it moved, which is what makes a stale notice due at all. */
function clockFact(index: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 352,
    observedTick: index,
    gameTime: "1200",
    semanticKind: "time_milestone",
    payload: Object.freeze({ kind: "time_milestone", revision: 352 }),
  });
}

/** A reading alone opens no turn (`TURN_OPENING`): the player speaking is what opens one, and what re-states the block. */
async function turn(pump: CompanionEventPump, index: number): Promise<PendingBatch | undefined> {
  pump.enqueuePlayerInput({
    source: "player_text",
    inputId: `input_${String(index)}`,
    text: "接着做。",
    locale: "zh-CN",
    timestampMs: 1_790_000_000_000 + index,
  });
  const batches: PendingBatch[] = [];
  await pump.flush({
    async deliver(batch) {
      batches.push(batch);
    },
  });
  return batches.at(0);
}

/** The `<world-state>` block a delivered turn actually carried, which is what the model reads. */
function worldStateOf(batch: PendingBatch | undefined): string {
  const text = batch?.text ?? "";
  const open = text.indexOf("<world-state>");
  if (open < 0) return "";
  const close = text.indexOf("</world-state>", open);
  return close < 0 ? text.slice(open) : text.slice(open, close);
}

/**
 * One window: six turns of ONE unchanged reading, thirty seconds apart, then the world's own statement that it moved.
 *
 * `idleMs` is the only difference between the two windows the gate compares - how long after the last read the world
 * contradicts the picture - so `ageMs` and `contentAgeMs` cannot both be satisfied by one number.
 */
async function windowAfterRereads({ idleMs }: Readonly<{ idleMs: number }>) {
  let nowMs = 1_000_000;
  const pump = new CompanionEventPump(undefined, () => nowMs);
  pump.enqueueFact(snapshotFact(reading(600), 1), FACT_PRODUCER.adapterIngress);
  let last: PendingBatch | undefined = await turn(pump, 1);
  for (let index = 2; index <= WORLD_STATE_STALE_TURNS + 1; index += 1) {
    nowMs += 30_000;
    // THE SAME WORLD, read again: a new object with the same content, which is what the Mod answers with when nothing
    // has moved. Content identity is what the pump compares, so a bumped revision could not fake this either.
    pump.enqueueFact(snapshotFact(reading(600), index), FACT_PRODUCER.adapterIngress);
    last = await turn(pump, index);
  }
  assert.equal(
    pump.takeWorldStateStaleFact(),
    undefined,
    "a world re-read and never contradicted is not stale: age alone is not evidence",
  );
  nowMs += idleMs;
  pump.enqueueFact(clockFact(1), FACT_PRODUCER.adapterIngress);
  const stale = pump.takeWorldStateStaleFact();
  if (stale === undefined)
    throw new Error("the world's own statement must make the picture due, or the window measures nothing");
  pump.enqueueFact(stale, FACT_PRODUCER.adapterIngress);
  const carrying = await turn(pump, 99);
  return { stale, carrying, lastText: last?.text ?? "" };
}

test("a world re-read and unchanged restarts the reading's age and leaves the picture's age running", async () => {
  // THE MEASURED SHAPE: the last read is the turn the world contradicts in, so the reading is ZERO seconds old and the
  // picture is the whole window old. The old accounting published the second number twice, which is what "nobody has
  // looked at this world for 150 s" said about a world read a moment ago.
  const fresh = await windowAfterRereads({ idleMs: 0 });
  assert.equal(
    fresh.stale.payload.ageMs,
    0,
    "the world was read in this very turn, so the READING is zero milliseconds old - the defect this gate names",
  );
  assert.equal(
    fresh.stale.payload.contentAgeMs,
    WORLD_STATE_STALE_TURNS * 30_000,
    "and the PICTURE is as old as the window of unchanged re-reads, which is the number a stale notice is about",
  );

  // THE OTHER HALF, one variable apart: nobody has looked for five minutes, so now the two numbers are different AGAIN -
  // and this time the reading really is old. One field cannot answer both windows.
  const idle = await windowAfterRereads({ idleMs: 300_000 });
  assert.equal(idle.stale.payload.ageMs, 300_000, "five minutes without a read is a five-minute-old READING");
  assert.equal(
    idle.stale.payload.contentAgeMs,
    WORLD_STATE_STALE_TURNS * 30_000 + 300_000,
    "and the picture is older still by exactly the same five minutes, because the content never changed",
  );
  assert.notEqual(
    idle.stale.payload.ageMs,
    fresh.stale.payload.ageMs,
    "the reading's age must separate the two windows, or it is not measuring the read at all",
  );
});

test("the stale notice the model reads carries the picture's age, not the re-read's", async () => {
  const { stale, carrying } = await windowAfterRereads({ idleMs: 0 });
  assert.equal(stale.semanticKind, WORLD_STATE_STALE_SEMANTIC_KIND);
  const code = worldStateStaleCode({
    ageTurns: Number(stale.payload.turns),
    revision: 352,
    contentAgeMs: WORLD_STATE_STALE_TURNS * 30_000,
  });
  assert.equal(stale.payload.code, code, "one spelling of the token: the payload, the block and the fact line agree");
  assert.match(
    String(stale.payload.code),
    /^world_state_stale:\d+;352;150000$/u,
    "the token's third member is how old the PICTURE is - a token keyed on the re-read would have published 0 here",
  );
  const worldState = worldStateOf(carrying);
  assert.ok(
    worldState.includes(code),
    `the block the model reads must carry the same token the fact published; it carried: ${worldState}`,
  );

  // AND THE FALSIFIER, in the other direction: a reading that says something ELSE restarts BOTH ages, because then the
  // window really did stop describing this world.
  let nowMs = 2_000_000;
  const pump = new CompanionEventPump(undefined, () => nowMs);
  pump.enqueueFact(snapshotFact(reading(600), 1), FACT_PRODUCER.adapterIngress);
  await turn(pump, 1);
  for (let index = 2; index <= WORLD_STATE_STALE_TURNS + 1; index += 1) {
    nowMs += 30_000;
    pump.enqueueFact(snapshotFact(reading(600), index), FACT_PRODUCER.adapterIngress);
    await turn(pump, index);
  }
  nowMs += 30_000;
  pump.enqueueFact(snapshotFact(reading(640), 97), FACT_PRODUCER.adapterIngress);
  await turn(pump, 97);
  nowMs += 1;
  pump.enqueueFact(clockFact(2), FACT_PRODUCER.adapterIngress);
  const moved = pump.takeWorldStateStaleFact();
  assert.equal(
    moved,
    undefined,
    "a world that moved a second ago has nothing stale to say, whatever the window before it was",
  );
  console.log(
    `a_world_reread_is_not_a_world_aged: reading ${String(stale.payload.ageMs)} ms · picture ${String(stale.payload.contentAgeMs)} ms · ${String(stale.payload.code)}`,
  );
});
