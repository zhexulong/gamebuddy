import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  CLOSED_WITH_NOTHING_WAIT_FOR,
  CLOSED_WITH_NOTHING_WAIT_FORS,
  CompanionEventPump,
  FACT_PRODUCER,
  HOST_MINTED_FACT_SOURCE,
  MEASURED_TURN_CADENCE_MS,
  type PendingBatch,
  TURN_PRODUCTION,
  TURN_WITHOUT_ACTION_REASON,
  TURN_WITHOUT_ACTION_REASONS,
  turnWithoutActionShape,
  type TurnWithoutActionReason,
  type WorldFact,
} from "./event-pump.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * `a_turn_that_closed_with_nothing_names_when_it_looks_again:<condition>` - the wait after an empty turn is NAMED.
 *
 * <p>
 * THE MEASUREMENT (`round84`, 34 minutes, its own facts). `turns opened 82`, and its own account line counted
 * `turn_closed_without_action 26 {world_fact:world_stale 11, world_fact:body_held 7, world_fact:nothing_pending 5,
 * player_input:body_held 1, player_input:nothing_pending 1, due:world_stale 1}`. Five of those turns were then woken by
 * THE GAME'S CLOCK - `424f2a21` after **203.8 s** (`time_milestone_day_4_1200`), `b6c11ffb` after 84.6 s (`_1800`),
 * `98ad4ee5` after 129.9 s (`_2200`), `af2f030c` after 92.2 s (`day_5_1200`) and `9e4b7129` after 231.5 s
 * (`day_5_1800`): **741.9 s** of silence that a clock had to end. The Host's entire reading of those intervals was
 * `wait.idle (reason: "nothing_owed")`, which names nothing and implies nothing was waiting.
 * </p>
 *
 * <p>
 * THE CANONICAL CASE. `plan_14 -> plan_19`: she entered the coop, spent the settlement on one 41-character line
 * (「棚子里没人，饲料槽三个全是空的，一头牲口没有。我先把门开着，回头攒点钱买鸡再回来。」), submitted no plan, and the
 * next turn came 203.8 s later - 6 ms after the Mod's `time_milestone_day_4_1200` arrived. The pump answered every
 * question in that interval with "nothing owed", and nothing on the Host's side was due to look again.
 * </p>
 *
 * <p>
 * THE COST OF NOT NAMING IT. `world_state_stale` was published **zero** times in that run, while the aged-reading cure
 * spent its three asks seven times (`auto_observe_unavailable 7 {refresh_attempts_spent: 7}`, `aged readings 55`): eleven
 * of the twenty-six empty turns measured `world_stale` - a turn handed a picture it did not bring - and the pump had no
 * reading that said so. `nothing_owed` was true of the moment and false of the situation.
 * </p>
 *
 * <p>
 * THE RULE THIS GATE ENCODES: a turn that closed with nothing leaves a NAMED WAIT - which condition it measured, and when
 * the pump looks again - so a clock milestone is never the thing that had to wake her. The population is the closed list
 * `TURN_WITHOUT_ACTION_REASONS`, so a condition added there is driven here by name instead of quietly passing; the wait is
 * read off the pump that just delivered such a turn, so the reading cannot be a second account of what the pump decided.
 * </p>
 *
 * <p>
 * THE RUN IS THE FIXTURE, VERBATIM: `host/src/test-fixtures/round84-closed-turns.json` holds the run's own final account
 * line, and one entry per delivered batch that composed nothing and ran no tool (its window, what it presented, the
 * `wait.idle` spans that followed, and the fact that opened the next turn). Both artifacts are excerpted by
 * `scratch/round84-closed-turns.mjs` from `.live-runs/game-ladder/<run>/{result.json,run-trace.json}` and the runner log.
 * </p>
 */

type RecordedIdle = Readonly<{ reason: string; ms: number }>;

type RecordedTurn = Readonly<{
  batchId: string;
  presented: readonly string[];
  waitedMs: number;
  nextOpenedBy: string;
  idle: readonly RecordedIdle[];
}>;

type Round84Reading = Readonly<{
  source: string;
  run: string;
  account: Readonly<{
    turnsOpened: number;
    closedWithNothing: number;
    byShape: Readonly<Record<string, number>>;
  }>;
  traced: Readonly<{
    turns: number;
    closedWithNothing: number;
    closedWithNothingAndAWaitedTurn: number;
    idleReasons: readonly string[];
  }>;
  turns: readonly RecordedTurn[];
}>;

const ROUND84: Round84Reading = JSON.parse(
  readFileSync(join(ROOT, "host/src/test-fixtures/round84-closed-turns.json"), "utf8"),
) as Round84Reading;

/** The run's own instant, so a fixture fact and the pump's injected clock are on one timeline. */
const WINDOW_AT_MS = Date.UTC(2026, 10, 20, 13, 52, 51);

/** The body is free, standing on the farm: what a turn that ends on speech alone was handed. */
const BODY_FREE = Object.freeze({ location: "Farm", gameTime: "0740", actionable: true });

/**
 * The SAME body forty minutes later: a reading whose CONTENT moved, which is the only thing `#readingIsNews` reads.
 *
 * The clock is what moves here on purpose. The Mod's `revision` is its action-echo counter, and the pump compares reading
 * content (`readingContentIdentity`) - so two readings that differ only in `revision` are one reading she was shown, and a
 * fixture that bumped the number instead would build `world_stale` while naming `nothing_pending`.
 */
const READING_MOVED = Object.freeze({ ...BODY_FREE, gameTime: "0820" });

/** A sink that says the turn it was handed ended on speech and nothing else - the loop publishes exactly this. */
function speakingSink(pump: CompanionEventPump): { deliver(batch: PendingBatch): Promise<"completed"> } {
  return {
    async deliver() {
      pump.turnProduction = TURN_PRODUCTION.spoke;
      return "completed" as const;
    },
  };
}

/** One reading of the world, in the wire's own snapshot shape. */
function readingAt(revision: number, observedTick: number, payload: Readonly<Record<string, unknown>>): WorldFact {
  return {
    source: "stardew_mod",
    kind: "snapshot",
    correlationId: `snapshot_${String(observedTick)}`,
    observedTick,
    revision,
    occurredAtMs: WINDOW_AT_MS + observedTick,
    payload,
  };
}

/**
 * The settled-plan digest: the one fact that is presentable on its own and states an OUTCOME, so a turn can be opened on
 * it without the pump having to be handed a reading first (`round84`: 47 of 82 turns opened this way).
 */
function settlementFact(eventId: string, occurredAtMs: number): WorldFact {
  return {
    source: HOST_MINTED_FACT_SOURCE,
    kind: "world_fact",
    eventId,
    sourceEventId: eventId,
    correlationId: eventId,
    revision: 0,
    occurredAtMs,
    semanticKind: "program_settled",
    payload: {
      kind: "program_settled",
      programId: eventId,
      settledAtMs: occurredAtMs - 1,
      total: 1,
      counts: { succeeded: 1 },
      ok: true,
      reason: null,
      summary: "1/1 完成",
      nodes: [],
      omitted: 0,
    },
  };
}

/** The Mod's own clock mark: presentable, and the fact the run's five silent waits were ended by. */
function milestoneFact(index: number, occurredAtMs: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `time_milestone_${String(index)}`,
    sourceEventId: `time_milestone_${String(index)}`,
    correlationId: `time_milestone_${String(index)}`,
    revision: 1,
    occurredAtMs,
    semanticKind: "time_milestone",
    payload: { milestone: index },
  };
}

/** `<opener>:<reason>` - the shape's reason half, which is the half the wait is derived from. */
function reasonOf(shape: string): string {
  return shape.slice(shape.indexOf(":") + 1);
}

/**
 * A pump that has just DELIVERED a turn closing with `reason`.
 *
 * <p>
 * One case per member of the closed list, because the wait is derived from the condition the turn measured and a case
 * missing from here is a condition nobody proved can name itself. Every case asserts the pump's own classification of the
 * turn it just delivered, so this cannot build a state the pump would have called something else.
 * </p>
 */
async function pumpAfterEmptyTurn(
  reason: TurnWithoutActionReason,
  now: () => number = () => WINDOW_AT_MS,
): Promise<CompanionEventPump> {
  const pump = new CompanionEventPump(undefined, now);
  const sink = speakingSink(pump);
  const settlement = (name: string) => settlementFact(`program_settled_${name}`, WINDOW_AT_MS);

  // TURN ONE, in every case but `no_reading`: a reading arrives WITH the settlement, so it is delivered by the batch and
  // the pump holds a picture it has shown her.
  if (reason !== TURN_WITHOUT_ACTION_REASON.noReading) {
    pump.enqueueFact(readingAt(14, 0, BODY_FREE), FACT_PRODUCER.adapterIngress);
    pump.enqueueFact(settlement("plan_r84_reading"), FACT_PRODUCER.adapterIngress);
    await pump.flush(sink);
  }

  switch (reason) {
    case TURN_WITHOUT_ACTION_REASON.noReading:
      // Nothing has ever read the world: there is no picture to act on at all.
      pump.enqueueFact(settlement("plan_r84_no_reading"), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.worldStale:
      // A clock mark opens the turn and the reading it is handed is one it already showed her: `round84`'s largest member
      // (11 of 26) and the shape the aged-reading cure exists for.
      pump.enqueueFact(milestoneFact(600, WINDOW_AT_MS + 60_000), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.bodyHeld:
      pump.enqueueFact(
        readingAt(15, 1, { ...BODY_FREE, actionable: false, actorDispositionKind: "modal" }),
        FACT_PRODUCER.adapterIngress,
      );
      pump.enqueueFact(milestoneFact(610, WINDOW_AT_MS + 61_000), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.worldMovedSinceReading:
      // A NEW reading (which resets the change count) and then the world saying it moved after it: the picture was right
      // when it was read and is not any more.
      pump.enqueueFact(readingAt(15, 1, READING_MOVED), FACT_PRODUCER.adapterIngress);
      pump.enqueueFact(milestoneFact(620, WINDOW_AT_MS + 62_000), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
    case TURN_WITHOUT_ACTION_REASON.nothingPending:
      // A fresh reading, a free body and an unmoved world: she judged the turn finished. `round84`: 6 of 26.
      pump.enqueueFact(readingAt(15, 1, READING_MOVED), FACT_PRODUCER.adapterIngress);
      pump.enqueueFact(settlement("plan_r84_nothing_pending"), FACT_PRODUCER.adapterIngress);
      await pump.flush(sink);
      break;
  }

  const shape = pump.closedWithNothing.shape;
  assert.equal(
    reasonOf(shape ?? ""),
    reason,
    `the pump must have just delivered a turn closing with \`${reason}\` (its own reading is \`${String(shape)}\`)`,
  );
  return pump;
}

/** The fact that opened the recorded turn after this one, as the run recorded it: a clock, or one of the world's own. */
function openedByAClock(turn: RecordedTurn): boolean {
  return turn.nextOpenedBy.startsWith("time_milestone:") || turn.nextOpenedBy.startsWith("day_started:");
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

/**
 * `a_turn_that_closed_with_nothing_names_when_it_looks_again:the_named_wait` - THE GATE.
 *
 * <p>
 * Prints `turns T · closed-with-nothing C · opened-by-a-milestone M · named-wait W`. `M > 0` fails, naming the turn and the
 * milestone that had to wake it: a clock is not a plan.
 * </p>
 * <p>
 * `W` is counted in TURNS, off the run's own shape histogram: a turn closed under a condition the pump cannot name is a
 * silent wait, whichever turn it was. `M` is therefore the five clock-woken turns while any condition is unnamed - the
 * conservative direction, because the run does not record which turn measured which condition, and a gate must not claim
 * a turn was named by a name the pump does not have.
 * </p>
 */
test("a_turn_that_closed_with_nothing_names_when_it_looks_again: the wait is named, and the look has a moment", async () => {
  const conditions: Array<Readonly<{ reason: TurnWithoutActionReason; waitingFor: string; lookAgainInMs: number }>> =
    [];
  const unnamed: TurnWithoutActionReason[] = [];
  for (const reason of TURN_WITHOUT_ACTION_REASONS) {
    const pump = await pumpAfterEmptyTurn(reason);
    const wait = pump.closedWithNothing;
    if (wait.waitingFor === undefined || wait.lookAgainInMs === undefined) {
      unnamed.push(reason);
      continue;
    }
    conditions.push({ reason, waitingFor: wait.waitingFor, lookAgainInMs: wait.lookAgainInMs });
  }

  const namedReasons = new Set(conditions.map((entry) => entry.reason));
  const closedWithNothing = ROUND84.account.closedWithNothing;
  const namedWait = Object.entries(ROUND84.account.byShape)
    .filter(([shape]) => namedReasons.has(reasonOf(shape) as TurnWithoutActionReason))
    .reduce((total, [, count]) => total + count, 0);
  const clockWoken = ROUND84.turns.filter(openedByAClock);
  const openedByAMilestone = namedWait === closedWithNothing ? 0 : clockWoken.length;

  const line =
    `turns ${String(ROUND84.traced.turns)} · closed-with-nothing ${String(closedWithNothing)} · ` +
    `opened-by-a-milestone ${String(openedByAMilestone)} · named-wait ${String(namedWait)}`;
  console.log(
    `a_turn_that_closed_with_nothing_names_when_it_looks_again: ${line} · named ` +
      `{${conditions.map((entry) => `${entry.reason}→${entry.waitingFor} in ${seconds(entry.lookAgainInMs)}`).join(", ")}} · ` +
      `clock openers {${clockWoken
        .map((turn) => `${turn.batchId.slice(0, 8)} ${seconds(turn.waitedMs)} → ${turn.nextOpenedBy}`)
        .join(", ")}} · source ${ROUND84.run}`,
  );

  // THE POPULATION IS THE RUN'S, and both of its records have to agree about it before anything below means anything: the
  // trace (which can name each wait and what ended it) and the pump's own account line (which names each condition).
  assert.ok(ROUND84.traced.turns > 0 && closedWithNothing > 0, "the fixture did not load: an empty run names nothing");
  assert.equal(
    ROUND84.traced.closedWithNothingAndAWaitedTurn,
    closedWithNothing,
    "the trace and the pump's own account must count the same empty turns, or this gate is reading a different run",
  );
  assert.ok(
    clockWoken.length > 0,
    "no wait in this run was ended by a clock, so the gate would pass over an empty file",
  );

  assert.equal(
    openedByAMilestone,
    0,
    `${line}: a turn that closed with nothing waited for the game's own clock - ` +
      `${clockWoken
        .map(
          (turn) =>
            `${turn.batchId} waited ${seconds(turn.waitedMs)} and only ${turn.nextOpenedBy.replace(/^time_milestone:/u, "")} opened the next one`,
        )
        .join("; ")}`,
  );
  assert.deepEqual(
    unnamed,
    [],
    `${line}: these conditions a turn can close with leave NO named wait, so the run's own history cannot say ` +
      `what it was waiting for when one of them closed it (${CLOSED_WITH_NOTHING_WAIT_FOR.freshReading} / ` +
      `${CLOSED_WITH_NOTHING_WAIT_FOR.freeBody} / ${CLOSED_WITH_NOTHING_WAIT_FOR.nextWorldFact} are the names the pump has)`,
  );
});

/**
 * `a_turn_that_closed_with_nothing_names_when_it_looks_again:the_canonical_wait` - the falsifier, from the run's own file.
 *
 * <p>
 * `plan_14 -> plan_19` is the case the rule was written from, and it is pinned EXACTLY - which turn, which milestone, how
 * long, and the idle reading that named nothing - so a later change cannot make the gate green by describing a different
 * run. `round84` recorded one 41-character line in that turn (the coop), no plan, and 203.8 s of `nothing_owed` split
 * across five idle spans.
 * </p>
 */
test("a_turn_that_closed_with_nothing_names_when_it_looks_again: plan_14's settlement bought 203.8 s of silence", () => {
  const canonical = ROUND84.turns.find((turn) =>
    turn.presented.some((source) => source.endsWith("plan_14_bb0ef279f15a4ca4")),
  );
  assert.ok(canonical !== undefined, "the turn that presented plan_14's settlement is not in the fixture");
  assert.equal(
    canonical.nextOpenedBy,
    "time_milestone:time_milestone_day_4_1200",
    "the run's own record of what opened the next turn after plan_14",
  );
  assert.ok(
    canonical.waitedMs > 203_000 && canonical.waitedMs < 205_000,
    `the measured wait after plan_14 is 203.8 s, not ${seconds(canonical.waitedMs)}`,
  );
  assert.deepEqual(
    [...new Set(canonical.idle.map((wait) => wait.reason))],
    ["nothing_owed"],
    "the interval's whole reading was `nothing_owed` - the word this round is about",
  );
  assert.ok(
    canonical.waitedMs - canonical.idle.reduce((total, wait) => total + wait.ms, 0) >= 0 &&
      canonical.waitedMs - canonical.idle.reduce((total, wait) => total + wait.ms, 0) < 1_000,
    `the idle spans are the wait: a gap the trace cannot account for would make the ${seconds(canonical.waitedMs)} a guess ` +
      `(idle ${String(canonical.idle.reduce((total, wait) => total + wait.ms, 0))} ms)`,
  );
});

/**
 * `a_turn_that_closed_with_nothing_names_when_it_looks_again:the_wait_it_names` - what each condition waits FOR.
 *
 * <p>
 * The shape says why the turn closed; this says what the wait is, and the two are different readings of one moment. A
 * turn handed a reading it did not bring is waiting for a reading (the cure that asks for one exists:
 * `#beginAgedReadingAsk`); a turn the engine would not let act is waiting for the body; and a turn with a fresh picture
 * and a free body that still did nothing is waiting for the world's own next word, which is the only opener left.
 * </p>
 */
test("a_turn_that_closed_with_nothing_names_when_it_looks_again: the name is the condition, not a second guess", async () => {
  const named: Record<string, string> = {};
  for (const reason of TURN_WITHOUT_ACTION_REASONS) {
    const pump = await pumpAfterEmptyTurn(reason);
    named[reason] = pump.closedWithNothing.waitingFor ?? "unnamed";
  }
  // THE VOCABULARY IS THE DECLARED ONE: a name the pump invents is a word no reader of the run can look up.
  for (const [reason, waitingFor] of Object.entries(named))
    assert.ok(
      (CLOSED_WITH_NOTHING_WAIT_FORS as readonly string[]).includes(waitingFor),
      `\`${reason}\` waits for \`${waitingFor}\`, which is not one of ${CLOSED_WITH_NOTHING_WAIT_FORS.join(", ")}`,
    );
  assert.equal(
    named[TURN_WITHOUT_ACTION_REASON.noReading],
    CLOSED_WITH_NOTHING_WAIT_FOR.freshReading,
    "with no picture at all the wait is a reading",
  );
  assert.equal(
    named[TURN_WITHOUT_ACTION_REASON.worldStale],
    CLOSED_WITH_NOTHING_WAIT_FOR.freshReading,
    "a reading the turn did not bring is the shape `round84` closed 11 times: the wait is a fresh one",
  );
  assert.equal(
    named[TURN_WITHOUT_ACTION_REASON.worldMovedSinceReading],
    CLOSED_WITH_NOTHING_WAIT_FOR.freshReading,
    "the world moved after the reading, so the wait is the reading that catches it up",
  );
  assert.equal(
    named[TURN_WITHOUT_ACTION_REASON.bodyHeld],
    CLOSED_WITH_NOTHING_WAIT_FOR.freeBody,
    "the engine's own admission gate answered `actionable: false`: the wait is the body",
  );
  assert.equal(
    named[TURN_WITHOUT_ACTION_REASON.nothingPending],
    CLOSED_WITH_NOTHING_WAIT_FOR.nextWorldFact,
    "nothing stood in the way, so nothing on the pump's side is missing: the wait is the world's",
  );

  // AND THE LOOK HAS A MOMENT. The reading conditions have something to DO - the cure asks the world for a reading on the
  // next flush - so their look is `0`, which is "ask me now" and not a promise about the world. The world's wait is the
  // one with nothing to do, and it is asked at the cadence this product measured rather than at a number invented here.
  for (const reason of [
    TURN_WITHOUT_ACTION_REASON.noReading,
    TURN_WITHOUT_ACTION_REASON.worldStale,
    TURN_WITHOUT_ACTION_REASON.worldMovedSinceReading,
    TURN_WITHOUT_ACTION_REASON.bodyHeld,
  ] as const) {
    const pump = await pumpAfterEmptyTurn(reason);
    assert.equal(
      pump.closedWithNothing.lookAgainInMs,
      0,
      `${reason}: there is a reading to go and ask for, so the look is due now`,
    );
  }
  let nowMs = WINDOW_AT_MS;
  const pump = await pumpAfterEmptyTurn(TURN_WITHOUT_ACTION_REASON.nothingPending, () => nowMs);
  assert.equal(
    pump.closedWithNothing.lookAgainInMs,
    MEASURED_TURN_CADENCE_MS,
    "nothing is missing on the pump's side, so the look is one measured turn away",
  );
  nowMs += 20_000;
  assert.equal(
    pump.closedWithNothing.lookAgainInMs,
    MEASURED_TURN_CADENCE_MS - 20_000,
    "and it counts down rather than being restated: a look that never arrives is the silence this replaces",
  );
});

/**
 * `a_turn_that_closed_with_nothing_names_when_it_looks_again:cleared_by_work` - the falsifier for a stale name.
 *
 * <p>
 * The wait belongs to the LAST delivered turn. A pump that kept naming the wait after a turn that acted would report a
 * silence nobody is in - the same defect as `nothing_owed`, in the other direction - so this drives one empty turn and
 * then one that works, and asks again.
 * </p>
 */
test("a_turn_that_closed_with_nothing_names_when_it_looks_again: a turn that acted ends the wait", async () => {
  const pump = await pumpAfterEmptyTurn(TURN_WITHOUT_ACTION_REASON.nothingPending);
  assert.equal(
    pump.closedWithNothing.shape,
    turnWithoutActionShape("world_fact", TURN_WITHOUT_ACTION_REASON.nothingPending),
    "the empty turn is named by its opener and its condition",
  );
  assert.equal(
    pump.closedWithNothing.turn,
    pump.turnAccount.opened,
    "and the wait belongs to the turn that just settled: the unit a reader acts on once per (see `event-pump.ts`)",
  );

  const working = {
    async deliver(): Promise<"completed"> {
      pump.turnProduction = TURN_PRODUCTION.worked;
      return "completed" as const;
    },
  };
  pump.enqueueFact(
    settlementFact("program_settled_plan_r84_worked", WINDOW_AT_MS + 70_000),
    FACT_PRODUCER.adapterIngress,
  );
  const flushed = await pump.flush(working);
  assert.equal(flushed.kind, "opened", `the settlement opens the turn that ends the wait (${flushed.kind})`);
  assert.deepEqual(
    { ...pump.closedWithNothing },
    { shape: undefined, waitingFor: undefined, lookAgainInMs: undefined, turn: undefined },
    "a turn that acted leaves no wait to name",
  );
});

/**
 * `a_turn_that_closed_with_nothing_names_when_it_looks_again:the_zeroes` - the fixture's own arithmetic.
 *
 * <p>
 * Every printed number is read from one of the run's two records, and the fixture is the only copy of either. A file that
 * lost its turns would otherwise print `closed-with-nothing 0 · opened-by-a-milestone 0` and agree with itself.
 * </p>
 */
test("a_turn_that_closed_with_nothing_names_when_it_looks_again: the run's own arithmetic", () => {
  const shapes = Object.values(ROUND84.account.byShape).reduce((total, count) => total + count, 0);
  assert.ok(ROUND84.source.startsWith("round84"), "the fixture must say which run it was read from");
  assert.equal(
    shapes,
    ROUND84.account.closedWithNothing,
    "the run's shapes are its empty turns: a shape with no turn in it is a number that did not happen",
  );
  assert.equal(
    ROUND84.turns.length,
    ROUND84.traced.closedWithNothingAndAWaitedTurn,
    "every recorded turn in the fixture has the turn that follows it, or its wait is not a wait",
  );
  assert.ok(
    ROUND84.turns.some(openedByAClock),
    "no recorded wait was ended by a clock, so the falsifier would pass by absence",
  );
  assert.deepEqual(
    [...ROUND84.traced.idleReasons].sort(),
    ["body_still_working", "nothing_owed"],
    "the two words the Host had for the interval, neither of which names what it waited for",
  );
});
