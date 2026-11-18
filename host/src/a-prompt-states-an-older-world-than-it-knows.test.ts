/**
 * GATE `a_prompt_states_an_older_world_than_it_knows:<site>`.
 *
 * <p>
 * HER PROMPT WENT BACKWARDS IN TIME, and the audit has the revision numbers. Measured 2026-11-18 (`round76`, her own
 * session): `15:02:20.870` her `stardew_observe` answered `revision 325` at `(3,11)` inside the farmhouse, and
 * `15:02:20.872` - two milliseconds later, in the same turn - a steer handed her `revision 321` at `(63,15)` out on the
 * farm, `本轮无新观察`. She then reasoned about a floor she had already walked onto. The same shape appears at
 * `14:43:31.700/.704` (`126` then `46`) and `14:57:20.817/.825` (`258` then `252`).
 * </p>
 *
 * <p>
 * TWO DEFECTS WEAR THAT ONE SYMPTOM, and this file holds both:
 * </p>
 * <ol>
 *   <li><b>an equal-revision reading with OLDER content replaced the newer one.</b> `revision` is the Mod's
 *       action-transaction counter, so two observations an hour apart both carry `revision 46`; the pump's guard
 *       compared that counter only, so `世界（revision 46，刚刚更新）` printed four times from 07:20 while the clock walked
 *       to 08:20. The comparison is now made in the reading's OWN currency (`readingClockOrdinal`).</li>
 *   <li><b>a steer re-stated a reading the running turn already had.</b> A steer is composed in the microtask after a
 *       preempting receipt and lands 2-8 ms later - after her own observation's answer, which reads the same bridge. So a
 *       steer whose reading has not moved now states no block at all, and the delivery counts say so by name.</li>
 * </ol>
 *
 * <p>
 * THE POPULATION IS THE COMPOSER SITES, read from the production sources rather than listed here: a fourth place that
 * composes a world-state block for a prompt fails this file until it is measured. Each site is driven with the readings
 * the session recorded, and `older` counts the deliveries whose stated revision was below the newest reading the pump
 * held at that moment.
 * </p>
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CompanionEventPump,
  FACT_PRODUCER,
  type PendingBatch,
  type WorldFact,
  readingClockOrdinal,
  readingIsOlderThan,
} from "./event-pump.js";
import { composeFactBrief } from "./fact-brief.js";
import type { Snapshot } from "./protocol.js";

const SOURCE_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

/** The world of `round76` line 197/198, as the two readings that arrived 2 ms apart. */
function farmhouseReading(revision: number, timeOfDay: number): Snapshot {
  return {
    revision,
    location: "FarmHouse",
    tile: { x: 3, y: 11 },
    stamina: 196,
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
    toolSlots: [{ slot: 0, label: "(T)Axe", category: "axe", upgradeLevel: 0 }],
    inventoryItemFacts: [],
  } as unknown as Snapshot;
}

function farmReading(revision: number, timeOfDay: number, day = 6): Snapshot {
  return {
    ...(farmhouseReading(revision, timeOfDay) as unknown as Record<string, unknown>),
    location: "Farm",
    tile: { x: 63, y: 15 },
    dayOfMonth: day,
  } as unknown as Snapshot;
}

function snapshotFact(snapshot: Snapshot, eventId: string): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    eventId,
    correlationId: eventId,
    revision: snapshot.revision,
    payload: snapshot as never,
  });
}

/** The Mod's own clock mark: presentable, and the one opener that is not a receipt. */
function clockMark(timeOfDay: number): WorldFact {
  const eventId = `time_milestone_${String(timeOfDay)}`;
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 1,
    observedTick: timeOfDay,
    semanticKind: "time_milestone",
    payload: Object.freeze({ kind: "time_milestone", milestone: timeOfDay }),
  });
}

/** A receipt the pump classifies as preempting: terminal and unproved, so a steer carries it into the running turn. */
function refusalReceipt(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "execution_receipt" as const,
    eventId: "exec_refusal_1",
    correlationId: "exec_refusal_1",
    revision: 324,
    executionId: "exec_refusal_1",
    requestId: "request_refusal_1",
    payload: Object.freeze({
      executionId: "exec_refusal_1",
      requestId: "request_refusal_1",
      action: "enter_exit",
      state: "failed",
      reasonCode: "door_out_of_range",
      evidence: null,
      revision: 324,
    }),
  }) as WorldFact;
}

/** The block a batch's text carries, or `undefined` when it carries none. */
function worldStateOf(batch: PendingBatch | undefined): string | undefined {
  return /<world-state>\n([\s\S]*?)\n<\/world-state>/u.exec(batch?.text ?? "")?.[1];
}

/** The revision a block states, or `undefined` for a batch that states no world at all. */
function statedRevision(batch: PendingBatch | undefined): number | undefined {
  const block = worldStateOf(batch);
  if (block === undefined) return undefined;
  const matched = /世界（revision (\d+)/u.exec(block);
  assert.ok(matched !== null, `a world block always names its reading: ${block}`);
  return Number(matched[1]);
}

/** Every production file under `host/src`, which is the population the composer sites are read from. */
function productionSources(): readonly string[] {
  return readdirSync(SOURCE_ROOT, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .filter((entry) => !entry.startsWith("test-support") && !entry.startsWith("test-fixtures"))
    .map((entry) => entry.split(path.sep).join("/"));
}

/**
 * Every place that composes a world-state block for a prompt, read from the sources.
 *
 * The two composers are `composeFactBrief` (the delivery) and `composeWorldState` (the one block on its own);
 * `fact-brief.ts` itself is the definition rather than a call site.
 */
function composerSites(): readonly Readonly<{ file: string; composer: string }>[] {
  const sites: { file: string; composer: string }[] = [];
  for (const file of productionSources()) {
    if (file === "fact-brief.ts") continue;
    const text = readFileSync(path.join(SOURCE_ROOT, file), "utf8");
    for (const composer of ["composeFactBrief(", "composeWorldState("])
      for (let at = text.indexOf(composer); at >= 0; at = text.indexOf(composer, at + 1))
        sites.push({ file, composer: composer.slice(0, -1) });
  }
  return Object.freeze(sites);
}

test("a_prompt_states_an_older_world_than_it_knows: the reading's own clock decides which picture is older", async () => {
  // THE FALSIFIER FOR THE GUARD THIS REPLACES: the Mod's counter is EQUAL for both readings, so the shipped expression
  // could not tell them apart and the older one won the slot.
  const laterSameCounter = snapshotFact(farmReading(46, 720), "later"); // day 6, 07:20 - the clock walked on
  const earlierSameCounter = snapshotFact(farmReading(46, 710), "earlier"); // day 6, 07:10, the SAME counter
  assert.equal(
    earlierSameCounter.revision < laterSameCounter.revision,
    false,
    "the counter is the same number for two observations an hour apart: it cannot order them",
  );
  assert.equal(readingIsOlderThan(earlierSameCounter, laterSameCounter), true, "the older picture must lose the slot");
  assert.equal(readingIsOlderThan(laterSameCounter, earlierSameCounter), false, "and the newer one must win it");

  // A DAY ONLY EVER ADVANCES, even though the clock restarts: 25:00 on day 5 is before 06:00 on day 6.
  const lateNight = snapshotFact(farmReading(46, 2500, 5), "late");  const nextMorning = snapshotFact(farmReading(47, 600, 6), "morning");
  assert.equal(readingIsOlderThan(nextMorning, lateNight), false, "a day boundary is forward, whatever the clock says");
  assert.equal(readingIsOlderThan(lateNight, nextMorning), true, "and the night before it is behind");

  // NO CLAIM, NO REFUSAL: a world-not-ready payload publishes zeroes, and a currency that read 0 as "older than
  // everything" would refuse the reading that says the world is gone.
  assert.equal(readingClockOrdinal({ timeOfDay: 0, dayOfMonth: 0, seasonIndex: 0, year: 0 }), undefined);
  const notReady = snapshotFact({ revision: 48, location: "Farm", tile: { x: 0, y: 0 }, payload: {} } as never, "nr");
  assert.equal(readingIsOlderThan(notReady, nextMorning), false, "a reading with no clock falls back to the counter");

  // AND THE SLOT ITSELF: an equal-counter, older-clock reading that arrives later must not replace what is held.
  const pump = new CompanionEventPump();
  pump.enqueueFact(laterSameCounter, FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(earlierSameCounter, FACT_PRODUCER.adapterIngress);
  assert.equal(pump.worldStateDelivery.newest, 46, "the held revision");
  pump.enqueueFact(clockMark(720), FACT_PRODUCER.adapterIngress);
  let held: PendingBatch | undefined;
  await pump.flush({
    async deliver(batch: PendingBatch) {
      held = batch;
    },
  });
  assert.equal(statedRevision(held), 46);
  assert.match(worldStateOf(held) ?? "", /07:20/u, `the block must state the NEWER picture: ${worldStateOf(held)}`);
});

test("a_prompt_states_an_older_world_than_it_knows: a steer never re-states the world the turn already has", async () => {
  const pump = new CompanionEventPump();
  const delivered: PendingBatch[] = [];
  const sink = {
    async deliver(batch: PendingBatch) {
      delivered.push(batch);
    },
  };
  pump.enqueueFact(snapshotFact(farmReading(321, 1210), "reading_321"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(clockMark(1210), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  assert.equal(delivered.length, 1, "the clock mark opens the turn this replay needs");
  assert.equal(statedRevision(delivered[0]), 321, "the turn's own block states the reading it opened with");

  // WHAT THE PRE-FIX STEER SAID, composed from the same reading: this is the text that landed two milliseconds after her
  // observation of revision 325 and put her back outside the farmhouse.
  const preFix = composeFactBrief({
    inputs: [],
    snapshot: { snapshot: farmReading(321, 1210), revision: 321, ageTurns: 1, ageMs: 0, contentAgeMs: 0 },
    events: [],
    locale: "zh-CN",
  });
  assert.match(preFix, /revision 321/u, `the old steer re-stated the older reading: ${preFix}`);

  pump.enqueueFact(refusalReceipt(), FACT_PRODUCER.adapterIngress);
  let steered: PendingBatch | undefined;
  const took = await pump.steer({
    async deliver(batch: PendingBatch) {
      steered = batch;
    },
  });
  assert.equal(took, true, "the refusal is steerable, or this replay never reaches the steer");
  assert.equal(statedRevision(steered), undefined, `the steer states no world: ${steered?.text ?? ""}`);
  assert.match(steered?.text ?? "", /door_out_of_range/u, "and the refusal itself still reaches her");
  assert.equal(pump.worldStateDelivery.withheld.restated, 1, "the withheld block is counted by name, never dropped");

  // THE OTHER DIRECTION, so the withhold is a rule and not a blanket silence: a steer whose reading has MOVED is news
  // and is stated in full.
  const moved = new CompanionEventPump();
  const movedSink = {
    async deliver(batch: PendingBatch) {
      delivered.push(batch);
    },
  };
  moved.enqueueFact(snapshotFact(farmReading(321, 1210), "reading_321"), FACT_PRODUCER.adapterIngress);
  moved.enqueueFact(clockMark(1210), FACT_PRODUCER.adapterIngress);
  await moved.flush(movedSink);
  moved.enqueueFact(snapshotFact(farmhouseReading(325, 1220), "reading_325"), FACT_PRODUCER.adapterIngress);
  moved.enqueueFact(refusalReceipt(), FACT_PRODUCER.adapterIngress);
  let movedSteer: PendingBatch | undefined;
  await moved.steer({
    async deliver(batch: PendingBatch) {
      movedSteer = batch;
    },
  });
  assert.equal(statedRevision(movedSteer), 325, `a moved reading is stated, and it is the newer one: ${movedSteer?.text}`);
  assert.equal(moved.worldStateDelivery.withheld.restated, 0, "nothing was withheld where the world had moved");
});

test("a_prompt_states_an_older_world_than_it_knows: every composer site states the newest reading it holds", async () => {
  const sites = composerSites();
  const examined = sites.length;
  const delivered: PendingBatch[] = [];
  const atDelivery: number[] = [];
  const pump = new CompanionEventPump();
  const sink = {
    async deliver(batch: PendingBatch) {
      delivered.push(batch);
      atDelivery.push(pump.worldStateDelivery.newest ?? -1);
    },
  };
  pump.enqueueFact(snapshotFact(farmReading(321, 1210), "reading_321"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(clockMark(1210), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);
  pump.enqueueFact(snapshotFact(farmhouseReading(325, 1220), "reading_325"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(clockMark(1220), FACT_PRODUCER.adapterIngress);
  await pump.flush(sink);

  const stated = delivered.map((batch) => statedRevision(batch));
  // ONE COMPARISON PER DELIVERY: the revision the block states against the newest reading the pump held when that batch
  // was handed over. `older` is a stated revision below it - the exact inversion the audit found.
  const older = stated.filter((revision, index) => revision !== undefined && revision < (atDelivery[index] ?? -1)).length;
  console.log(
    `a_prompt_states_an_older_world_than_it_knows · sites examined ${String(examined)} · current ${String(
      examined - older,
    )} · older ${String(older)}`,
  );
  assert.ok(examined > 0, "zero composer sites is blocked, never green: the population is the sources' own call sites");
  assert.deepEqual(
    sites.map((site) => `${site.file}:${site.composer}`).sort(),
    [
      "event-pump.ts:composeFactBrief",
      "event-pump.ts:composeFactBrief",
      "game-tools.ts:composeWorldState",
    ],
    "a NEW place composes a world-state block for a prompt; measure it here before it ships",
  );
  assert.deepEqual(stated, [321, 325], `each delivery states the newest reading the pump held then: ${String(stated)}`);
  assert.equal(older, 0, "a prompt stated a world older than the newest reading the Host held when it was delivered");
});
