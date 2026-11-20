import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  NOT_OWED,
  PLAN_LOW_WATER_NODES,
  type PendingBatch,
  type WorldFact,
} from "./event-pump.js";
import type { InFlightProgramme, InFlightProgrammeReading } from "./program-status-wait.js";
import type { Snapshot } from "./protocol.js";

/**
 * `a_plan_at_low_water_opens_the_next_turn:<case>` and `a_queued_lookahead_holds_nothing:<case>`.
 *
 * <p>
 * THE MEASUREMENT THIS EXISTS FOR, from `round82`'s own `result.json`: **102 programme switches with 4 overlaps**, and
 * **992.3 s of the run's 1,626 s spent between programmes** - 61% of the wall clock. The rule before this unit
 * (`#workLeftToPlan() > 0`) held every fact until the journal showed ZERO nodes left, so her next plan could not be
 * composed until the previous one had settled, and the body stood still for the model round-trip in between.
 * </p>
 * <p>
 * WHAT CHANGED AND WHAT DID NOT. The journal's own `remaining` is still the reading; the THRESHOLD moved to
 * `PLAN_LOW_WATER_NODES`, and a second `Active` programme counts as a plan already asked for. Everything the old rule was
 * written against is still true one node higher: three nodes left is not a tail, a plan that has answered opens its own
 * turn, and a due wake or the player's own word never waits.
 * </p>
 */

/** A snapshot fact carrying one rock row per tile, so the state block has something to offer or withhold. */
function snapshotFact(revision: number, tiles: readonly string[]): WorldFact {
  const payload = {
    revision,
    location: "Farm",
    tile: { x: 40, y: 10 },
    stamina: 254,
    health: 100,
    actionable: true,
    capabilities: [],
    catalogRevision: 3,
    enabledActionIds: [],
    presentationLocale: "zh-CN",
    exhausted: false,
    timeOfDay: 900,
    dayOfMonth: 5,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    inventoryItemFacts: [],
    toolSlots: [],
    rockSourceTargets: tiles.map((tile) => {
      const [x, y] = tile.split(":").map(Number);
      return { x, y, targetId: `rock_source_${x ?? 0}_${y ?? 0}`, health: 1 };
    }),
  } as unknown as Snapshot;
  return Object.freeze({
    source: "stardew_mod",
    kind: "snapshot" as const,
    correlationId: `snapshot_${String(revision)}`,
    observedTick: revision,
    revision,
    occurredAtMs: 1_790_000_000_000 + revision,
    payload: payload as never,
  });
}

/** A clock mark: presentable (`time_milestone` is on the lease list), so it is a fact that would otherwise open a turn. */
function milestoneFact(milestone: number): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: `time_milestone_${String(milestone)}`,
    sourceEventId: `time_milestone_${String(milestone)}`,
    correlationId: `time_milestone_${String(milestone)}`,
    revision: milestone,
    occurredAtMs: milestone,
    semanticKind: "time_milestone",
    payload: { milestone } as never,
  });
}

/** The world saying it will not move until it is answered: `HELD_WORLD_DECLARATIONS`'s own two keys. */
function heldWorldFact(): WorldFact {
  return Object.freeze({
    source: "stardew_mod",
    kind: "world_fact" as const,
    eventId: "modal_presented_1",
    sourceEventId: "modal_presented_1",
    correlationId: "modal_presented_1",
    revision: 9,
    occurredAtMs: 9,
    semanticKind: "modal_presented",
    payload: { isQuestion: true, blocksTimePass: true, responseKeys: ["Yes", "No"] } as never,
  });
}

/** One programme of the journal's own reading: `remaining` nodes left, `tiles` of them un-settled on those tiles. */
function programme(programId: string, remaining: number, tiles: readonly string[] = []): InFlightProgramme {
  return {
    programId,
    total: remaining,
    settled: 0,
    remaining,
    readAgeMs: 200,
    nodes: [],
    omitted: 0,
    unsettledTiles: tiles,
  };
}

const readingOf = (...programmes: readonly InFlightProgramme[]): InFlightProgrammeReading =>
  Object.freeze({ programmes: Object.freeze([...programmes]), omittedProgrammes: 0 });

type Delivery = Readonly<{ batches: PendingBatch[]; sink: { deliver(batch: PendingBatch): Promise<void> } }>;

function recorder(): Delivery {
  const batches: PendingBatch[] = [];
  return {
    batches,
    sink: {
      async deliver(batch) {
        batches.push(batch);
      },
    },
  };
}

/** A pump whose journal reading is the one the case states, primed with the snapshot the turn will read. */
async function primed(
  reading: InFlightProgrammeReading,
  tiles: readonly string[] = [],
): Promise<Readonly<{ pump: CompanionEventPump; turns: Delivery }>> {
  const pump = new CompanionEventPump(() => reading);
  const turns = recorder();
  pump.enqueueFact(snapshotFact(7, tiles), FACT_PRODUCER.adapterIngress);
  return { pump, turns };
}

/** How many turns a fact opens once the snapshot is already in hand. */
async function turnsOpened(
  reading: InFlightProgrammeReading,
  fact: WorldFact,
): Promise<Readonly<{ opened: number; outcome: string; batches: readonly PendingBatch[] }>> {
  const { pump, turns } = await primed(reading);
  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  const outcome = await pump.flush(turns.sink);
  return { opened: pump.turnAccount.opened, outcome: outcome.kind, batches: turns.batches };
}

/**
 * `a_plan_at_low_water_opens_the_next_turn:four_cases` - the threshold, driven at the boundary in both directions.
 *
 * <p>
 * THE READINGS ARE THE JOURNAL'S OWN (`InFlightProgramme.remaining`), and every case is a real shape of a plan: a plan with
 * three nodes left is not a tail, two is the low-water mark, one is a tail with one step in it, and two programmes is the
 * lookahead already asked for. A gate that only drove the middle number would pass on a rule that opens EVERY turn.
 * </p>
 */
test("a_plan_at_low_water_opens_the_next_turn: the threshold, and the queue that holds it", async () => {
  assert.equal(PLAN_LOW_WATER_NODES, 2, "the low-water mark this suite is written against");
  const cases: readonly Readonly<{
    name: string;
    reading: InFlightProgrammeReading;
    opens: boolean;
  }>[] = [
    { name: "three_nodes_left", reading: readingOf(programme("plan_a", 3)), opens: false },
    { name: "two_nodes_left", reading: readingOf(programme("plan_a", 2)), opens: true },
    { name: "one_node_left", reading: readingOf(programme("plan_a", 1)), opens: true },
    { name: "answered", reading: readingOf(), opens: true },
    {
      name: "low_water_but_a_second_programme_is_queued",
      reading: readingOf(programme("plan_a", 1), programme("plan_b", 3)),
      opens: false,
    },
    {
      // A programme the journal still calls `active` with nothing left in it is a programme waiting to be CLOSED, not a
      // plan already asked for: counting it as a queue would hold the next turn on an empty plan for ever.
      name: "two_programmes_with_nothing_left",
      reading: readingOf(programme("plan_a", 0), programme("plan_b", 0)),
      opens: true,
    },
  ];
  let opened = 0;
  for (const each of cases) {
    const result = await turnsOpened(each.reading, milestoneFact(600));
    if (each.opens) opened += 1;
    assert.equal(
      result.opened,
      each.opens ? 1 : 0,
      `${each.name}: the journal says ${each.reading.programmes.map((p) => p.remaining).join("+") || "0"} nodes left, ` +
        `so this fact must ${each.opens ? "" : "not "}open a turn (got ${result.outcome})`,
    );
    if (!each.opens) {
      assert.equal(result.outcome, "not_owed", `${each.name}: the refusal is a debt answer (${result.outcome})`);
      assert.equal(result.batches.length, 0, `${each.name}: and no batch was delivered`);
    }
  }
  assert.ok(opened > 0 && opened < cases.length, "an empty population, or one that always opens, is not a threshold");
  console.log(
    `a_plan_at_low_water_opens_the_next_turn: cases ${cases.length} · opened ${opened} · held ${cases.length - opened} · ` +
      `low-water ${PLAN_LOW_WATER_NODES}`,
  );
});

/**
 * `a_queued_lookahead_holds_nothing:<case>` - what a held world does to the queue.
 *
 * <p>
 * THE LIMIT, STATED RATHER THAN PAPERED OVER: nothing on this side can drop a queued programme's un-started nodes
 * (`program_stop` needs the STOP epoch and `abandon` is poisoned-programs-only), so the queued programme WILL run its nodes
 * when the first drains. What the pump controls is the TURN: a world that will not move until it is answered must never be
 * held behind a queue, or the queued work runs against a world that moved. The Mod's own re-validation at admission is what
 * refuses a node the moved world no longer admits.
 * </p>
 * <p>
 * THE PLAYER'S STEER IS THE SAME CASE one opener over, and it never came through this rule at all (`#opening` answers the
 * player first) - which is why the mutation below can only reach the fact-driven half.
 * </p>
 */
test("a_queued_lookahead_holds_nothing: a held world is never held behind a queue", async () => {
  const queued = readingOf(programme("plan_a", 1), programme("plan_b", 3));
  // DIRECTION ONE: an ordinary fact at the same reading waits, which is what makes the queue a real hold.
  const waiting = await turnsOpened(queued, milestoneFact(1200));
  assert.equal(waiting.opened, 0, `an ordinary fact is held behind the queue (${waiting.outcome})`);

  // DIRECTION TWO: the world declaring it will not move opens its turn anyway.
  const held = await turnsOpened(queued, heldWorldFact());
  assert.equal(held.opened, 1, `a held world opens its own turn behind the same queue (${held.outcome})`);
  assert.equal(held.outcome, "opened", "and it delivered a batch, rather than being answered as a debt");
  console.log(`a_queued_lookahead_holds_nothing: ordinary ${waiting.opened} · held-world ${held.opened}`);
});

/**
 * `a_queued_tile_is_not_offered_again:<site>` - the subtraction, read through the batch the model is actually handed.
 *
 * <p>
 * THE FIRST RISK OF ANY LOOKAHEAD, and the reason it is not enough to wake earlier: the turn is composed from a snapshot read
 * while the plan in flight was still working, so the rows it publishes are rows that programme is about to take. A block that
 * still offered them is an invitation to plan the same tile twice, and `round82` contains exactly that: `plan_895` submitted
 * `enter_exit` at `90:15` while `plan_894`'s own `enter_exit` at `90:15` was still queued.
 * </p>
 */
test("a_queued_tile_is_not_offered_again: the state block withdraws the rows the journal says are being worked", async () => {
  const reading = readingOf(programme("plan_a", 2, ["40:9"]));
  const { pump, turns } = await primed(reading, ["40:9", "41:9"]);
  pump.enqueueFact(milestoneFact(600), FACT_PRODUCER.adapterIngress);
  const outcome = await pump.flush(turns.sink);
  assert.equal(outcome.kind, "opened", `the low-water turn is the one this block is composed for (${outcome.kind})`);
  const batch = turns.batches.at(-1);
  assert.ok(batch !== undefined, "a batch was delivered to the model");
  const block = worldStateBlock(batch.text);
  assert.doesNotMatch(block, /\(40,9\)/u, `the queued tile is not offered again: ${block}`);
  assert.match(block, /\(41,9\)/u, `a tile nothing has queued is still offered: ${block}`);
  assert.match(block, /已经在做了/u, `and the line says why one row left: ${block}`);
  console.log(`a_queued_tile_is_not_offered_again: queued 40:9 · offered 41:9 · block chars ${String(block.length)}`);
});

/** The `<world-state>` block of one delivery, so an assertion about a tile cannot be satisfied by a receipt line. */
function worldStateBlock(text: string): string {
  const open = text.indexOf("<world-state>");
  const close = text.indexOf("</world-state>");
  return open < 0 || close < 0 ? "" : text.slice(open, close);
}

/** The refusal reason the old rule answered with is still the reason a plan's tail buys - named, not re-spelled here. */
assert.equal(NOT_OWED.planStillRunning, "plan_still_running");
