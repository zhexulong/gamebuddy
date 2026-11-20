import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  NOT_OWED,
  type PendingBatch,
  TURN_OPENING,
  type WorldFact,
} from "./event-pump.js";
import type { InFlightProgramme, InFlightProgrammeReading } from "./program-status-wait.js";
import type { Snapshot } from "./protocol.js";

/**
 * `a_plan_with_nodes_left_holds_the_fact:<case>` and `a_queued_lookahead_holds_nothing:<case>`.
 *
 * <p>
 * THE HOLD, AND WHAT IT IS NOT. While her own plan has nodes the journal has not seen settle, a fact that arrives is carried
 * into the batch that plan's answer opens: `follow_up` - the pump opening a turn after her own turn ended - went 9 -> 65
 * between `round42` and `round60` while a turn went from 8.2 model steps to 2.0, so "a fact arrived" became "there is a turn
 * to open" and the turn stopped being one unit of work. The reading is the journal's own `remaining`
 * (`InFlightProgramme.remaining`), and it is the whole rule.
 * </p>
 * <p>
 * WHAT THE HOLD IS NOT ANY MORE. Two units tried to time it - `PLAN_LOW_WATER_NODES = 2` (`8e8e625f`) and a time-aware
 * successor measured from this pump's own pace and turn - and `round84` retired both: no fact kind reaches the rule early
 * enough to matter (`WAKE_RULE` carries the measurement, `event-pump.wake-rule-reachability.test.ts` holds the property).
 * What is left is what the measurement supports: a plan that has nodes left holds, and a plan that has answered opens.
 * </p>
 * <p>
 * WHAT DOES NOT WAIT is declared rather than special-cased: the player's own word (`#opening` answers it first), a due wake
 * (`PUMP_MINTED_WAKE_KINDS`), a held world (`HELD_WORLD_DECLARATIONS`) and the plan's own settlement. The last two are the
 * cases below, because a rule that holds them too would be a rule that can deadlock.
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
      return { x: x ?? 0, y: y ?? 0, targetId: `rock_source_${x ?? 0}_${y ?? 0}`, health: 1 };
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

const PLAYER_INPUT = Object.freeze({
  source: "player_text" as const,
  inputId: "player_1",
  eventId: "player_source_1",
  text: "去把那排地浇了",
  locale: "zh-CN",
  timestampMs: 1_000,
});

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

/** A pump on the journal the case states, primed with the reading a turn will render. */
function primed(
  reading: InFlightProgrammeReading,
  tiles: readonly string[] = [],
): Readonly<{ pump: CompanionEventPump; turns: Delivery }> {
  const pump = new CompanionEventPump(() => reading);
  const turns = recorder();
  pump.enqueueFact(snapshotFact(7, tiles), FACT_PRODUCER.adapterIngress);
  return { pump, turns };
}

/** What one fact does at one journal reading: how many turns it opened, and the batch that proves it. */
async function turnsOpened(
  reading: InFlightProgrammeReading,
  fact: WorldFact,
): Promise<Readonly<{ opened: number; outcome: string; reason: string | undefined; delivered: number }>> {
  const { pump, turns } = primed(reading);
  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  const outcome = await pump.flush(turns.sink);
  return {
    opened: pump.turnAccount.opened,
    outcome: outcome.kind,
    reason: outcome.kind === "not_owed" ? outcome.reason : undefined,
    delivered: turns.batches.length,
  };
}

/**
 * `a_plan_with_nodes_left_holds_the_fact:five_cases` - the rule, driven at both ends.
 *
 * <p>
 * Every case is a real shape of a plan: three nodes left is not a tail, one node left is not an answer, no nodes left is the
 * plan answering, and a programme the journal still calls `Active` with nothing in it is waiting to be CLOSED rather than a
 * plan already asked for. A gate that only drove the middle number would pass on a rule that holds everything.
 * </p>
 */
test("a_plan_with_nodes_left_holds_the_fact: the hold, and what it does not hold", async () => {
  const cases: readonly Readonly<{
    name: string;
    reading: InFlightProgrammeReading;
    opens: boolean;
  }>[] = [
    { name: "three_nodes_left", reading: readingOf(programme("plan_a", 3)), opens: false },
    { name: "one_node_left", reading: readingOf(programme("plan_a", 1)), opens: false },
    {
      name: "a_second_programme_is_queued",
      reading: readingOf(programme("plan_a", 1), programme("plan_b", 3)),
      opens: false,
    },
    { name: "answered", reading: readingOf(), opens: true },
    {
      // A programme the journal still calls `active` with nothing left in it is a programme waiting to be CLOSED, not a
      // plan already asked for: holding on it would hold the next turn on an empty plan for ever.
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
      assert.equal(result.reason, NOT_OWED.planStillRunning, `${each.name}: and it names the plan (${String(result.reason)})`);
      assert.equal(result.delivered, 0, `${each.name}: and no batch was delivered`);
    }
  }
  assert.ok(opened > 0 && opened < cases.length, "an empty population, or one that always opens, is not a threshold");
  console.log(
    `a_plan_with_nodes_left_holds_the_fact: cases ${String(cases.length)} · opened ${String(opened)} · held ` +
      `${String(cases.length - opened)}`,
  );
});

/**
 * `a_queued_lookahead_holds_nothing:<case>` - a held world is never held behind a running plan.
 *
 * <p>
 * THE LIMIT, STATED RATHER THAN PAPERED OVER: nothing on this side can drop a queued programme's un-started nodes
 * (`program_stop` needs the STOP epoch and `abandon` is poisoned-programs-only), so the queued programme WILL run its nodes
 * when the first drains. What the pump controls is the TURN: a world that will not move until it is answered must never be
 * held behind work, or the queued nodes run against a world that moved. The Mod's own re-validation at admission is what
 * refuses a node the moved world no longer admits.
 * </p>
 */
test("a_queued_lookahead_holds_nothing: a held world is never held behind a running plan", async () => {
  const running = readingOf(programme("plan_a", 3));
  // DIRECTION ONE: an ordinary fact at the same reading waits, which is what makes the hold a real hold.
  const waiting = await turnsOpened(running, milestoneFact(1200));
  assert.equal(waiting.opened, 0, `an ordinary fact is held while her plan still has nodes (${waiting.outcome})`);

  // DIRECTION TWO: the world declaring it will not move opens its turn anyway.
  const held = await turnsOpened(running, heldWorldFact());
  assert.equal(held.opened, 1, `a held world opens its own turn (${held.outcome})`);
  assert.equal(held.outcome, "opened", "and it delivered a batch, rather than being answered as a debt");
  console.log(`a_queued_lookahead_holds_nothing: ordinary ${String(waiting.opened)} · held-world ${String(held.opened)}`);
});

/**
 * `a_queued_tile_is_not_offered_again:<site>` - the subtraction, read through the batch the model is actually handed.
 *
 * <p>
 * THE FIRST RISK OF ANY TURN OPENED BEHIND A RUNNING PLAN, and the reason waking earlier was never the whole fix: the turn is
 * composed from a snapshot read while the programme in flight was still working, so the rows it publishes are rows that
 * programme is about to take. A block that still offered them would invite the same tile twice, and `round82` contains
 * exactly that: `plan_895` submitted an `enter_exit` at `90:15` while `plan_894`'s own `enter_exit` at `90:15` was still
 * queued.
 * </p>
 * <p>
 * THE TURN HERE IS THE PLAYER'S WORD, because behind a running plan it is one of the three that still opens (`#opening`
 * answers a person first; a due wake and a held world are the other two). The block is composed by the same `takeBatch`, so
 * what it withholds is the same reading.
 * </p>
 */
test("a_queued_tile_is_not_offered_again: the state block withdraws the rows the journal says are being worked", async () => {
  const { pump, turns } = primed(readingOf(programme("plan_a", 2, ["40:9"])), ["40:9", "41:9"]);
  pump.enqueuePlayerInput(PLAYER_INPUT);
  const outcome = await pump.flush(turns.sink);
  assert.equal(outcome.kind, "opened", `the person's word opens the turn this block is composed for (${outcome.kind})`);
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

/**
 * `a_wake_that_cannot_beat_a_think_time_is_not_a_wake:<plan>` - SKIPPED, and the skip is the finding.
 *
 * <p>
 * THIS WAS THE TIME-AWARE SUCCESSOR TO `PLAN_LOW_WATER_NODES`, written and driven before `round84`'s account line was read.
 * It held a fact while the plan's tail was estimated, from this pump's own pace, to outlast a delivered turn, and woke it
 * while the tail still covered one - `round84`'s numbers support the arithmetic: a median turn of 10.12 s against programmes
 * that ran at 0.4-52 s per node, with 51 of 57 shorter than a single turn.
 * </p>
 * <p>
 * IT WAS RETIRED UNMEASURED, and that is why it is recorded rather than deleted. The rule it replaced opened **no turns in 34
 * minutes**, because a node's `execution_receipt` cannot present and the settlement arrives only once every node is terminal -
 * so neither the old threshold NOR this one has a fact kind that reaches it while the tail it measures still exists
 * (`WAKE_RULE`, `event-pump.wake-rule-reachability.test.ts`). A second measurement of a rule nothing can carry would have
 * been a second round spent on the wrong layer.
 * </p>
 * <p>
 * WHAT IS KEPT FROM IT: the reading, not the rule. `event-pump.turn-gap-round84.test.ts` reproduces the run's own numbers,
 * and the split between the queue wait (437.5 s) and the turn gap (1,265.2 s) is the part of that work that survives.
 * </p>
 */
test(
  "a_wake_that_cannot_beat_a_think_time_is_not_a_wake",
  { skip: "the rule cannot open a turn; retired pending a bell" },
  () => {
    // Intentionally empty: the replay is preserved in the doc above and in the round84 reading, and the rule it drove no
    // longer exists in the pump.
  },
);

assert.equal(TURN_OPENING.due, "due");
