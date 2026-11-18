import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  EXECUTION_STALL_SEMANTIC_KIND,
  FACT_PRODUCER,
  MOD_STALL_VERDICT_CODE,
  STARDEW_TICKS_PER_SECOND,
  turnAccountLine,
  type WorldFact,
} from "./event-pump.js";
import type { InFlightProgramme, InFlightProgrammeReading } from "./program-status-wait.js";

/**
 * Is an execution alive? The answer comes from two authorities, and this suite is what says so.
 *
 * <p>
 * THE DEFECT THIS REPLACES. Liveness was `Date.now() - lastFactAtMs` compared to a bound: a wall-clock scalar answering a
 * question with four answers - running, waiting for the engine, stalled, gone. Measured 2026-11-17, the Mod stopped
 * emitting body traces, so the traffic that re-armed that bound thinned out; the same bound that used to read silence as
 * "stalled" then read ordinary work as "stalled" on its next re-arm. The product had not changed - the authority had
 * never been right.
 * </p>
 * <p>
 * THE TWO FALSIFIERS hold this suite up, and both are forced by driving the pump's real inputs:
 * </p>
 * <ol>
 *   <li>a long action that is GENUINELY STILL RUNNING produces 0 stall facts, whatever the clock says (it used to produce
 *       one per bound of silence);</li>
 *   <li>a GENUINELY STALLED one produces exactly 1, carrying the Mod's `reason` and its `waitedMs`, and it opens a turn.
 *       </li>
 * </ol>
 * <p>
 * HOW THE STALL IS FORCED: by the Mod's own verdict - the receipt the body controller publishes when its watchdog sees no
 * progress (`transition(Running, "stalled_waiting", "reason=entity_block;...;stalled_ticks=N")`,
 * `StardewBodyController.cs:1174`), with a journal that still shows the programme in flight. No assertion below says "a
 * field was set": each one says which authority was fed and what the product then did with it.
 * </p>
 */

/** One programme the journal still shows in flight: the state authority's answer to "is anything alive". */
function programme(programId = "plan_sleep"): InFlightProgramme {
  return Object.freeze({
    programId,
    total: 1,
    settled: 0,
    remaining: 1,
    readAgeMs: 12,
    nodes: Object.freeze([
      Object.freeze({ index: 0, nodeId: "n001", actionId: "sleep", state: "running", observedInStateMs: 4_000 }),
    ]),
    omitted: 0,
  });
}

function livenessReading(programmes: readonly InFlightProgramme[]): InFlightProgrammeReading {
  return Object.freeze({ programmes: Object.freeze([...programmes]), omittedProgrammes: 0 });
}

/** A pump whose programme state is exactly these programmes: the journal authority, handed in. */
function pumpWith(programmes: readonly InFlightProgramme[]): CompanionEventPump {
  return new CompanionEventPump(() => livenessReading(programmes));
}

function receipt(state: string, executionId: string, extra: Readonly<Record<string, unknown>> = {}): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: `${executionId}_${state}_${JSON.stringify(extra)}`,
    sourceEventId: `${executionId}_${state}`,
    correlationId: executionId,
    executionId,
    revision: 1,
    payload: { state, executionId, actionId: "sleep", ...extra },
  };
}

/**
 * The Mod's stall verdict, exactly as the body controller writes it: a `running` receipt whose reason is
 * `stalled_waiting` and whose evidence detail carries the why and the wait in the engine's own ticks.
 */
function verdict(
  executionId: string,
  { reason = "entity_block", ticks = 180, eventId }: { reason?: string; ticks?: number; eventId?: string } = {},
): WorldFact {
  return {
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: eventId ?? `${executionId}_${MOD_STALL_VERDICT_CODE}_${String(ticks)}`,
    sourceEventId: `${executionId}_running`,
    correlationId: executionId,
    executionId,
    revision: 2,
    payload: {
      state: "running",
      executionId,
      actionId: "sleep",
      reasonCode: MOD_STALL_VERDICT_CODE,
      evidence: { detail: `reason=${reason};tile=40,5;target=44,5;stalled_ticks=${String(ticks)};wait_ticks=60` },
    },
  };
}

/** The eventIds and triggers one flush carries, in delivery order. */
async function deliver(pump: CompanionEventPump): Promise<{ eventIds: string[]; triggers: string[] }> {
  let carried: { eventIds: string[]; triggers: string[] } = { eventIds: [], triggers: [] };
  await pump.flush({
    async deliver(batch) {
      carried = {
        eventIds: batch.facts.flatMap((fact) => (fact.eventId === undefined ? [] : [fact.eventId])),
        triggers: [...batch.triggerEventIds],
      };
    },
  });
  return carried;
}

/* ---------------------------------------------------------------------------------------------------------------- */
/* Falsifier ①: traffic no longer decides.                                                                             */
/* ---------------------------------------------------------------------------------------------------------------- */

test("falsifier① a long action that is genuinely still running produces 0 stall facts", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([programme()]);
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);

  // Ten minutes of a live programme and not one further fact: the shape the retired bound called a stall at 120 s.
  for (let minute = 0; minute < 10; minute += 1) {
    t.mock.timers.tick(60_000);
    assert.equal(
      pump.takeStallFact(),
      undefined,
      `minute ${String(minute + 1)}: time passing is not a stall - the programme's own state says the work is running`,
    );
  }
  assert.deepEqual(pump.executionLiveness.verdicts, [], "no Mod verdict was stated, so there is none to announce");
  assert.equal(pump.executionLiveness.programmesInFlight, 1, "and the reason is the journal's own answer, not a clock");
  assert.equal(pump.turnAccount.stalled.total, 0, "the account says no stall fact was minted");
});

test("falsifier① a settled execution leaves nothing behind that time can turn into a stall", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([]);
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(verdict("exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(receipt("succeeded", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  t.mock.timers.tick(600_000);

  assert.deepEqual(
    pump.executionLiveness.verdicts,
    [],
    "a terminal receipt drains the verdict the execution had standing",
  );
  assert.equal(pump.takeStallFact(), undefined, "and ten minutes later there is still nothing to announce");
});

test("a verdict that arrives after its execution settled is recorded, named, and not announced", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([]);
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(receipt("succeeded", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  // A transport that replayed, or a verdict that overtook its own terminal.
  pump.enqueueFact(verdict("exec_sleep"), FACT_PRODUCER.adapterIngress);

  assert.equal(
    pump.executionLiveness.verdicts.length,
    1,
    "the statement is on the record - a dropped fact is one nobody can audit",
  );
  assert.deepEqual(
    pump.executionLiveness.unmeasured,
    [{ executionId: "exec_sleep", reason: "verdict_without_programme_in_flight" }],
    "and it is named as unmeasured rather than silently believed or silently lost",
  );
  assert.equal(pump.takeStallFact(), undefined, "with no programme in flight there is nothing to be stalled");
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* Falsifier ②: the Mod's verdict is announced once, with its reason and its wait, and it opens a turn.               */
/* ---------------------------------------------------------------------------------------------------------------- */

test("falsifier② a genuinely stalled execution produces exactly 1 fact, carrying reason and waitedMs", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([programme()]);
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  // The stall is forced by the body controller's own verdict: no progress for 180 engine ticks, blocked by an entity.
  pump.enqueueFact(verdict("exec_sleep", { reason: "entity_block", ticks: 180 }), FACT_PRODUCER.adapterIngress);

  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "the Mod says the body is waiting, and the journal says the work is still running");
  assert.equal(fact.semanticKind, EXECUTION_STALL_SEMANTIC_KIND);
  assert.equal(fact.executionId, "exec_sleep");
  assert.equal(fact.payload.actionId, "sleep");
  assert.equal(fact.payload.reason, "entity_block", "the Mod's own word for why, verbatim");
  assert.equal(
    fact.payload.waitedMs,
    (180 * 1000) / STARDEW_TICKS_PER_SECOND,
    "and its own wait, converted once at the engine's own step - never the Host's distance since a fact",
  );
  assert.equal(fact.payload.programmesInFlight, 1, "the fact says which authority carried the verdict");

  assert.equal(pump.takeStallFact(), undefined, "ONE fact per verdict: the announcement is not re-armed by a clock");

  pump.enqueueFact(fact, FACT_PRODUCER.adapterIngress);
  assert.equal(
    pump.hasPendingDelivery,
    true,
    "the stall fact must be able to start a turn on its own: a held kind with no wake source is the round39 defect",
  );
  assert.deepEqual(
    (await deliver(pump)).triggers,
    [fact.eventId],
    "and it is the batch's TRIGGER - the running receipt it replaces in this batch could not start a turn",
  );
});

test("falsifier② the same verdict re-admitted is one episode, and a later verdict is a second", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([programme()]);
  pump.enqueueFact(receipt("running", "exec_pickup"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(verdict("exec_pickup", { ticks: 180, eventId: "verdict_once" }), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(verdict("exec_pickup", { ticks: 180, eventId: "verdict_once" }), FACT_PRODUCER.adapterIngress);
  assert.ok(pump.takeStallFact() !== undefined, "the first statement is announced");
  assert.equal(pump.takeStallFact(), undefined, "the same fact arriving twice is not a second stall");

  // The entity cleared, the body moved, and it is blocked again: the Mod says so with a longer wait, which is new news.
  pump.enqueueFact(verdict("exec_pickup", { ticks: 240, eventId: "verdict_again" }), FACT_PRODUCER.adapterIngress);
  const second = pump.takeStallFact();
  assert.ok(second !== undefined, "a second episode is a second fact");
  assert.equal(second.payload.waitedMs, (240 * 1000) / STARDEW_TICKS_PER_SECOND, "and it carries its own wait");
  assert.equal(pump.turnAccount.stalled.total, 2, "the account counts announcements, not elapsed bounds");
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The state authority's half: a verdict with no programme in flight is named, not announced.                          */
/* ---------------------------------------------------------------------------------------------------------------- */

test("a verdict the journal cannot place is not_measured, never silence and never a stall", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const programmes: InFlightProgramme[] = [];
  const pump = new CompanionEventPump(() => livenessReading(programmes));
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(verdict("exec_sleep"), FACT_PRODUCER.adapterIngress);

  const reading = pump.executionLiveness;
  assert.equal(reading.due, false, "nothing in flight means nothing the Host can call stalled");
  assert.deepEqual(
    reading.unmeasured,
    [{ executionId: "exec_sleep", reason: "verdict_without_programme_in_flight" }],
    "the verdict is named with its reason rather than dropped: a silent zero reads as nothing is stuck",
  );
  assert.equal(pump.takeStallFact(), undefined, "and it mints nothing");

  // The journal catches up - the read that placed the work arrives - and the same verdict becomes announceable.
  programmes.push(programme());
  const announced = pump.takeStallFact();
  assert.ok(announced !== undefined, "the same verdict is announced once the programme's state agrees work is alive");
  assert.equal(pump.executionLiveness.unmeasured.length, 0, "and nothing is left unmeasured");
});

test("a verdict that carries no wait is not a measured stall, and says so by being absent", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([programme()]);
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "execution_receipt",
      eventId: "verdict_without_ticks",
      correlationId: "exec_sleep",
      executionId: "exec_sleep",
      revision: 2,
      payload: {
        state: "running",
        executionId: "exec_sleep",
        actionId: "sleep",
        reasonCode: MOD_STALL_VERDICT_CODE,
        evidence: null,
      },
    },
    FACT_PRODUCER.adapterIngress,
  );

  assert.deepEqual(pump.executionLiveness.verdicts, [], "a verdict with no tick count measured nothing");
  assert.equal(pump.takeStallFact(), undefined, "so the Host announces no duration it does not have");
  assert.equal(pump.turnAccount.stalled.total, 0);
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The body the verdict found waiting, carried on the fact.                                                           */
/* ---------------------------------------------------------------------------------------------------------------- */

test("a held body is carried on the stall fact, with what would release it", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([programme()]);
  // The shape round43 measured: `sleep` refused with `body_owned_by_day_advance` and `owner_action=sleep`.
  pump.enqueueFact(
    {
      source: "stardew_mod",
      kind: "execution_receipt",
      eventId: "sleep_refused",
      correlationId: "exec_advance",
      executionId: "exec_advance",
      revision: 1,
      payload: {
        state: "failed",
        executionId: "exec_advance",
        actionId: "sleep",
        failureCode: "body_owned_by_day_advance",
        owner_action: "sleep",
      },
    },
    FACT_PRODUCER.adapterIngress,
  );
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(verdict("exec_sleep"), FACT_PRODUCER.adapterIngress);
  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "the running execution is waiting regardless of why");
  assert.equal(fact.payload.owner, "body_owned_by_day_advance");
  assert.equal(fact.payload.endsOwnershipWith, "sleep", "an answer that stops at 'stuck' is half an answer");
  assert.equal(
    "ownershipAbsentReason" in fact.payload,
    false,
    "a named owner needs no reason for an absence it does not have",
  );
});

test("a stall with no body-owning transition says so instead of a bare null owner", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = pumpWith([programme()]);
  pump.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  pump.enqueueFact(verdict("exec_sleep"), FACT_PRODUCER.adapterIngress);
  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined);
  assert.equal(fact.payload.owner, null);
  assert.equal(fact.payload.endsOwnershipWith, null);
  assert.equal(
    fact.payload.ownershipAbsentReason,
    "no_body_owning_transition_in_progress",
    "null alone reads as 'nobody holds the body', which is not what this fact knows",
  );
});

/* ---------------------------------------------------------------------------------------------------------------- */
/* The account: `stalled N {reason: count}`, and an empty field is never printed.                                      */
/* ---------------------------------------------------------------------------------------------------------------- */

test("the account prints stall announcements by the Mod's reason, and no empty braces", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const quiet = pumpWith([programme()]);
  const quietLine = turnAccountLine(quiet.turnAccount);
  assert.match(quietLine, /· stalled 0 ·/u, `a run where no authority said so prints the zero: ${quietLine}`);
  assert.doesNotMatch(quietLine, /stalled 0 \{/u, "and it never prints an empty reason field");

  const stalled = pumpWith([programme()]);
  stalled.enqueueFact(receipt("running", "exec_sleep"), FACT_PRODUCER.adapterIngress);
  stalled.enqueueFact(verdict("exec_sleep", { reason: "entity_block" }), FACT_PRODUCER.adapterIngress);
  stalled.enqueueFact(receipt("running", "exec_pickup"), FACT_PRODUCER.adapterIngress);
  stalled.enqueueFact(verdict("exec_pickup", { reason: "entity_block" }), FACT_PRODUCER.adapterIngress);
  assert.ok(stalled.takeStallFact() !== undefined);
  assert.ok(stalled.takeStallFact() !== undefined);
  assert.match(
    turnAccountLine(stalled.turnAccount),
    /stalled 2 \{entity_block: 2\}/u,
    "two announcements, and the braces name the reason both carried",
  );
});
