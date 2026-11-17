import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  FACT_PRODUCER,
  HOST_MINTED_FACT_SOURCE,
  NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
  NOT_OWED,
  type PendingBatch,
  TURN_OPENING,
  TURN_OPENINGS,
  type TurnOpening,
  type WorldFact,
} from "./event-pump.js";
import { programSettledDigest } from "./program-settlement-digest.js";
import type { InFlightProgramme, InFlightProgrammeReading, PlanAnswerNode } from "./program-status-wait.js";

/**
 * `follow_up_tracks_work_not_traffic:<case>` and `a_turn_opens_while_she_is_still_composing:<site>`.
 *
 * <p>
 * THE SHAPE THIS EXISTS FOR, measured over a session's own records: a turn in `round42` (2026-11-10) did **8.2** model steps
 * and carried text on one of them; a turn in `round60` (2026-11-15) does **2.0** and carries text on both, while
 * `follow_up` - the pump opening a turn after her own turn ended - went 9 -> 65. Her bubbles did not get longer (23-125
 * chars in both eras); speaking came to occupy four fifths of the steps instead of one eighth, because the turn kept
 * ENDING and being reopened. The commit in that gap, `d09ae2f1` (2026-11-10 17:53), taught the Host to mint a fact from
 * silence so that "an execution that stops making progress becomes a fact" - and with it every arrival after a turn
 * ended acquired the right to open the next one. `r43` 19.2 steps/turn -> `r44` 2.4.
 * </p>
 * <p>
 * THE UNIT IS THE TRIGGER. `follow_up` was gated on "a fact arrived". It is gated on "there is something to plan" from
 * here on, and that is a FACT the pump already reads: the journal's own statement of what her plan still has to get
 * through (`readInFlightProgrammes().programmes[].remaining`, `InFlightProgramme.remaining`). While a plan has nodes
 * left, a fact that arrives is CARRIED into the batch her plan's answer opens; the answer itself, a due wake and the
 * player's own word open their turns regardless.
 * </p>
 * <p>
 * NOTHING IS SUPPRESSED. `#owesTurn` is untouched - the fact still rides the model-facing text of the next batch
 * (`promptFacts` filters on it), the window still holds it, and `CarryTicket` proves where it went. What changed is only
 * the answer to "is the model woken for this". `tools/check-fact-authority.mjs` check 3 is about the other thing (a fact
 * discarded because a programme is in flight); its own words are "「有程序在飞」是对轮次的判断" - a judgement about TURNS.
 * </p>
 */

/** A plan with nodes left: the journal's own reading, as `readInFlightProgrammes` answers it while it is running. */
function running(remaining: number, total: number = 3): InFlightProgrammeReading {
  const programme: InFlightProgramme = {
    programId: "plan_water_row",
    total,
    settled: total - remaining,
    remaining,
    readAgeMs: 400,
    nodes: [],
    omitted: 0,
  };
  return { programmes: [programme], omittedProgrammes: 0 };
}

/** The plan has answered (or the reading expired): nothing is left to wait for, so nothing is "still working". */
const ANSWERED: InFlightProgrammeReading = Object.freeze({ programmes: Object.freeze([]), omittedProgrammes: 0 });

/** The Mod's own clock mark: presentable (`time_milestone` is on the lease list) and news every time it is stated. */
function milestoneFact(milestone: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `time_milestone_${String(milestone)}`,
    sourceEventId: `time_milestone_${String(milestone)}`,
    correlationId: `time_milestone_${String(milestone)}`,
    revision: milestone,
    occurredAtMs: milestone,
    semanticKind: "time_milestone",
    payload: { milestone },
  };
}

/** A HUD line the game showed: presentable, and news she has not been told. */
function noticeFact(revision: number): WorldFact {
  return {
    source: "stardew_mod",
    kind: "world_fact",
    eventId: `native_notice_${String(revision)}`,
    sourceEventId: `native_notice_${String(revision)}`,
    correlationId: `native_notice_${String(revision)}`,
    revision,
    occurredAtMs: revision,
    semanticKind: "native_notice",
    payload: { notice: `notice ${String(revision)}` },
  };
}

/** A Host-minted wake (`PUMP_MINTED_WAKE_KINDS`): the `due` opener, whose whole purpose is to make her look. */
function dueFact(): WorldFact {
  return {
    source: HOST_MINTED_FACT_SOURCE,
    kind: "world_fact",
    eventId: "narration_without_work_3",
    sourceEventId: "narration_without_work_3",
    correlationId: "narration_without_work_3",
    revision: 3,
    occurredAtMs: 3,
    semanticKind: NARRATION_WITHOUT_WORK_SEMANTIC_KIND,
    payload: { kind: NARRATION_WITHOUT_WORK_SEMANTIC_KIND, turns: 3 },
  };
}

function planNode(nodeId: string): PlanAnswerNode {
  return {
    nodeId,
    actionId: "water_crop",
    arguments: { x: { type: "integer", canonicalValue: "60" }, y: { type: "integer", canonicalValue: "10" } },
  };
}

/** The plan's ONE answer, built by its producer, so what the pump classifies is what the digest actually mints. */
function settledFact(): WorldFact {
  const rows = [0, 1, 2].map((index) => ({ nodeId: `n${String(index)}`, state: "succeeded" }));
  const fact = programSettledDigest({
    programId: "plan_water_row",
    settledAtMs: 4_242,
    compiled: rows.map((row) => planNode(row.nodeId)),
    status: {
      code: "found",
      snapshot: {
        programId: "plan_water_row",
        state: "succeeded",
        catalogRevision: 3,
        stopEpoch: 0,
        eventHighWater: 90,
        nodes: rows,
      },
    },
    nowMs: 9,
  });
  assert.ok(fact !== undefined, "the producer must state a settled plan of three nodes");
  return fact;
}

const PLAYER_INPUT = Object.freeze({
  source: "player_text" as const,
  inputId: "player_1",
  eventId: "player_source_1",
  text: "去把那排地浇了",
  locale: "zh-CN",
  timestampMs: 1_000,
});

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

/**
 * `follow_up_tracks_work_not_traffic:three_facts_behind_one_plan` - the falsifier the brief names.
 *
 * <p>
 * A three-node plan is running and three facts arrive. The measurement before this rule: FOUR turns - the one she
 * dispatched the plan in, plus one per arrival, each of them a `follow_up` prompt she had nothing to plan in. What the
 * property says: ONE turn while the plan runs, and ONE more when it answers, carrying everything.
 * </p>
 */
test("follow_up_tracks_work_not_traffic: three facts behind a running plan are one turn, then one answer", async () => {
  let reading = running(3);
  const pump = new CompanionEventPump(() => reading);
  const turns = recorder();

  // Turn 1: the player speaks, she dispatches the three-node plan in that turn.
  pump.enqueuePlayerInput(PLAYER_INPUT);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.opened, 1, "the person's word opens the one turn");

  // Three facts arrive while the plan is still running - and the Host flushes on each arrival, which is what it does.
  const arrivals: WorldFact[] = [milestoneFact(600), noticeFact(1), milestoneFact(1200)];
  const tickets: Array<Readonly<{ ticketId: string; facts: readonly string[] }>> = [];
  for (const fact of arrivals) {
    pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
    const outcome = await pump.flush(turns.sink);
    assert.equal(
      outcome.kind,
      "not_owed",
      `a fact that arrives while her plan still has nodes must not open a turn (${fact.eventId ?? "?"}): ${outcome.kind}`,
    );
    if (outcome.kind !== "not_owed") return;
    assert.equal(
      outcome.reason,
      NOT_OWED.planStillRunning,
      `and the refusal names the plan, not something else: ${outcome.reason}`,
    );
    tickets.push(outcome.carry);
  }
  assert.equal(
    pump.turnAccount.opened,
    1,
    `three facts behind a running plan opened ${String(pump.turnAccount.opened - 1)} extra turns: a plan in flight is not ` +
      "three reasons to speak",
  );
  assert.equal(pump.pendingCount, 3, "and all three facts are still waiting, none dropped");

  // The plan answers. That is the batch which carries them, and it says so.
  reading = ANSWERED;
  pump.enqueueFact(settledFact(), FACT_PRODUCER.programSettlement);
  await pump.flush(turns.sink);
  assert.equal(pump.turnAccount.opened, 2, "the plan's answer is exactly one more turn");
  const answer = turns.batches.at(-1);
  assert.ok(answer !== undefined, "and one batch was delivered for it");
  for (const ticket of tickets)
    assert.equal(
      pump.carriedInto(ticket),
      answer.batchId,
      "every carried fact resolves to the batch the answer opened - the ticket is a measurement, not a promise",
    );
  const stated = answer.text;
  assert.match(stated, /600/u, "the answer's batch states the clock mark that arrived mid-plan");
  assert.match(stated, /1200/u, "and the second one");
  assert.match(stated, /notice 1/u, "and the notice the game showed");
  // THE LEDGER IS READ WHOLE: the population is the three facts, all three arrived in the answer's batch, and the loss is
  // the reading that must stay zero - a fact that was consumed is not a loss.
  const carry = pump.turnAccount.carry;
  assert.equal(carry.carried, 3, "three facts were ticketed while the plan ran");
  assert.equal(carry.consumed, 3, "and all three arrived in the answer's batch");
  assert.equal(carry.lostTotal, 0, "so nothing was lost");
  assert.equal(carry.held, 0, "and nothing is still waiting");
  console.log(
    `follow_up_tracks_work_not_traffic: arrive-during-plan ${String(arrivals.length)} · turns-while-running ` +
      `${String(1)} · turns-with-answer ${String(pump.turnAccount.opened - 1)} · carried ${String(carry.carried)} · ` +
      `consumed ${String(carry.consumed)} · lost ${String(carry.lostTotal)} · held ${String(carry.held)}`,
  );
});

/**
 * `a_turn_opens_while_she_is_still_composing:<site>` - the gate.
 *
 * <p>
 * THE POPULATION IS THE CLOSED LIST of things that can open a turn (`TURN_OPENINGS`), not a set written here: an opener
 * added to the pump fails this gate by name until it is classified with a reason, and each member is driven TWICE - once
 * with nothing in flight, to prove the fact really is that opener's trigger, and once with a plan running, to read what
 * it does then. A gate that only drove the second direction would stay green by driving a fact that opens no turn at all.
 * </p>
 * <p>
 * `F > 0` FAILS, NAMING THE OPENER: a turn opened by a fact that arrived while her plan still had nodes. `W` is the
 * work-left reading the pump took (`InFlightProgramme.remaining`), printed so "no turn" cannot be confused with "no
 * work".
 * </p>
 */
const STILL_COMPOSING_OPENER: Readonly<Record<TurnOpening, Readonly<{ answer: "opens" | "waits"; why: string }>>> =
  Object.freeze({
    [TURN_OPENING.playerInput]: Object.freeze({
      answer: "opens",
      why: "a person's word is not a fact that can wait for a plan: they are owed an answer while she is still working",
    }),
    [TURN_OPENING.worldFact]: Object.freeze({
      answer: "waits",
      why: "a presentable fact is carried into the batch her plan's answer opens, instead of buying a prompt of its own",
    }),
    [TURN_OPENING.due]: Object.freeze({
      answer: "opens",
      why: "a due wake is the one declared liveness exception: its whole purpose is that she looks again",
    }),
  });

/** How each opener is driven, and what its trigger is. */
const OPENER_DRIVER: Readonly<
  Record<TurnOpening, Readonly<{ drive: (pump: CompanionEventPump) => void; missing?: never }>>
> = Object.freeze({
  [TURN_OPENING.playerInput]: { drive: (pump) => pump.enqueuePlayerInput(PLAYER_INPUT) },
  [TURN_OPENING.worldFact]: { drive: (pump) => pump.enqueueFact(milestoneFact(1200), FACT_PRODUCER.adapterIngress) },
  [TURN_OPENING.due]: { drive: (pump) => pump.enqueueFact(dueFact(), FACT_PRODUCER.narrationWithoutWork) },
});

test("a_turn_opens_while_she_is_still_composing: every opener is classified, and the classified shape waits", async () => {
  assert.deepEqual(
    [...Object.keys(STILL_COMPOSING_OPENER)].sort(),
    [...TURN_OPENINGS].sort(),
    "every way a turn can open must be classified here - an opener added to `TURN_OPENINGS` and not to this table is a " +
      "trigger nobody decided about",
  );
  const workLeft = running(3).programmes.reduce((total, programme) => total + programme.remaining, 0);
  let openers = 0;
  let factArrived = 0;
  const drifting: string[] = [];

  for (const opener of TURN_OPENINGS) {
    const verdict = STILL_COMPOSING_OPENER[opener];
    assert.ok(verdict.why.trim().length > 30, `opener "${opener}" must say WHY it answers the way it does`);
    const driver = OPENER_DRIVER[opener];
    openers += 1;

    // DIRECTION ONE, with nothing in flight: the fact really is this opener's trigger.
    const idle = new CompanionEventPump(() => ANSWERED);
    const idleTurns = recorder();
    driver.drive(idle);
    await idle.flush(idleTurns.sink);
    assert.equal(
      idle.turnAccount.byReason[opener],
      1,
      `opener "${opener}" did not fire with nothing in flight, so this gate would be measuring a fact that opens no turn ` +
        "at all rather than the work-left rule",
    );

    // DIRECTION TWO, with her plan still working through its nodes.
    const working = new CompanionEventPump(() => running(3));
    const workingTurns = recorder();
    driver.drive(working);
    const outcome = await working.flush(workingTurns.sink);
    const openedHere = working.turnAccount.opened;
    if (verdict.answer === "waits") {
      factArrived += openedHere;
      if (openedHere !== 0) drifting.push(`${opener}: opened ${String(openedHere)}`);
      assert.equal(outcome.kind, "not_owed", `opener "${opener}" is classified as waiting: ${outcome.kind}`);
      if (outcome.kind === "not_owed")
        assert.equal(outcome.reason, NOT_OWED.planStillRunning, `and its reason is the plan (${opener})`);
      assert.equal(
        working.pendingCount,
        1,
        `opener "${opener}" must be carried, not dropped: ${String(working.pendingCount)} facts are waiting`,
      );
    } else {
      assert.equal(
        openedHere,
        1,
        `opener "${opener}" is classified as opening (${verdict.why}), and it opened ${String(openedHere)} turns`,
      );
      assert.equal(outcome.kind, "opened", `and it delivered a batch (${opener})`);
    }
  }

  assert.deepEqual(drifting, [], `a turn opened while she was still composing: ${drifting.join("; ")}`);
  assert.ok(openers > 0 && workLeft > 0, "an empty population agrees with itself; this gate refuses to pass on zero");
  console.log(
    `a_turn_opens_while_she_is_still_composing: openers examined ${String(openers)} · work-left ${String(workLeft)} · ` +
      `fact-arrived ${String(factArrived)}`,
  );
});
