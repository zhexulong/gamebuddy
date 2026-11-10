import assert from "node:assert/strict";
import test from "node:test";
import {
  CompanionEventPump,
  EXECUTION_STALL_BOUND_MS,
  EXECUTION_STALL_REARM_MULTIPLE,
  EXECUTION_STALL_SEMANTIC_KIND,
  MAX_STALL_UNMEASURED_SHOWN,
  MAX_WATCHED_EXECUTIONS,
  type WorldFact,
} from "./event-pump.js";

/**
 * An execution that stops making progress must become a fact.
 *
 * Measured 2026-11-08 (`round43`): the Mod owned an execution and published nothing for more than 180 s while the receipt
 * still said `running`, the companion's session record aged past three minutes, and nothing created a turn. Every fact
 * in this pump existed to be forwarded, and the one condition that matters when no fact arrives had no representation at
 * all - so the run audit could see the silence and the product could not.
 *
 * The watch is measured, not self-driving: the pump says WHEN the next stall fact is due (`stallWatch`) and mints that
 * fact on request (`takeStallFact`). Starting a turn stays the Host's job, which is why the last assertion here is
 * "this fact asks for a turn" rather than "a turn happened".
 */

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

/** The eventIds and triggers one flush carries, in delivery order. */
async function deliver(pump: CompanionEventPump): Promise<{ eventIds: string[]; triggers: string[] }> {
  let carried: { eventIds: string[]; triggers: string[] } = { eventIds: [], triggers: [] };
  await pump.flush({
    async deliver(text) {
      const batch = JSON.parse(text) as {
        triggerEventIds: string[];
        worldFacts: Array<{ eventId?: string }>;
      };
      carried = {
        eventIds: batch.worldFacts.flatMap((fact) => (fact.eventId === undefined ? [] : [fact.eventId])),
        triggers: batch.triggerEventIds,
      };
    },
  });
  return carried;
}

test("a silent execution mints one stall fact, and that fact asks for a turn", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_sleep"));
  assert.equal(
    pump.stallWatch.nextStallInMs,
    EXECUTION_STALL_BOUND_MS,
    "the bound is the answer the Host arms its timer from",
  );

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS - 1);
  assert.equal(pump.takeStallFact(), undefined, "one millisecond short of the bound is still an ordinary gap");

  t.mock.timers.tick(1);
  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "the bound is where the silence becomes news");
  assert.equal(fact.semanticKind, EXECUTION_STALL_SEMANTIC_KIND);
  assert.equal(fact.executionId, "exec_sleep");
  assert.equal(fact.payload.actionId, "sleep");
  assert.equal(fact.payload.elapsedMs, EXECUTION_STALL_BOUND_MS);
  assert.equal(fact.payload.lastFactKind, "execution_receipt:running");
  assert.equal(fact.payload.stallFactsSoFar, 1);

  pump.enqueueFact(fact);
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

test("a stall that lasts ten minutes is two facts, not seven", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_sleep"));

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  const first = pump.takeStallFact();
  assert.ok(first !== undefined, "the first stall lands on the bound");

  // Re-armed at a MULTIPLE of the bound, so the same silence is not re-read on every bound it lasts.
  assert.equal(pump.stallWatch.nextStallInMs, EXECUTION_STALL_BOUND_MS * (EXECUTION_STALL_REARM_MULTIPLE - 1));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS * (EXECUTION_STALL_REARM_MULTIPLE - 1));
  const second = pump.takeStallFact();
  assert.ok(second !== undefined, "the second stall lands when the re-arm expires");
  assert.equal(second.payload.elapsedMs, EXECUTION_STALL_BOUND_MS * EXECUTION_STALL_REARM_MULTIPLE);

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  assert.equal(pump.takeStallFact(), undefined, "600 s of stall is two facts, not an hour's worth compressed");
});

test("a stall fact does not reset the clock it was measured from", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_sleep"));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "the stall is due at the bound");
  pump.enqueueFact(fact);

  t.mock.timers.tick(30_000);
  const watched = pump.stallWatch.watched[0];
  assert.equal(
    watched?.elapsedMs,
    EXECUTION_STALL_BOUND_MS + 30_000,
    "the silence is counted from the last REAL fact, so the fact cannot silence the next stall",
  );
  assert.equal(watched?.lastFactKind, "execution_receipt:running", "and the stall fact is not progress by any reading");
});

test("an execution that settles normally publishes no stall fact at all", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_sleep"));
  t.mock.timers.tick(60_000);
  pump.enqueueFact(receipt("succeeded", "exec_sleep"));
  assert.equal(pump.stallWatch.nextStallInMs, undefined, "a settled execution leaves no deadline behind");

  t.mock.timers.tick(600_000);
  assert.equal(
    pump.takeStallFact(),
    undefined,
    "ten minutes after it finished, the settled execution is still not a stall",
  );
});

test("an execution the watch cannot date is not_measured, not silent", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: "nameless_running",
    correlationId: "nameless",
    revision: 1,
    payload: { state: "running" },
  });

  const reading = pump.stallWatch;
  assert.equal(reading.nextStallInMs, undefined, "there is no start to count from, so there is no deadline to arm");
  assert.deepEqual(
    reading.unmeasured,
    [{ reason: "execution_id_absent" }],
    "an execution the watch cannot time says so by name, because a silent zero reads as nothing is stuck",
  );
});

test("an execution the bound evicts while still running is named, not forgotten", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  for (let index = 0; index <= MAX_WATCHED_EXECUTIONS; index += 1)
    pump.enqueueFact(receipt("running", `exec_${index}`));

  const reading = pump.stallWatch;
  assert.equal(reading.watched.length, MAX_WATCHED_EXECUTIONS, "the record is bounded");
  assert.equal(reading.evicted, 1, "and the eviction is counted, so `watched N evicted K` can be stated");
  assert.deepEqual(reading.unmeasured, [{ executionId: "exec_0", reason: "stall_watch_evicted:exec_0" }]);
});

test("an execution the Mod BLOCKED is over: it leaves the watch, and no stall fact follows it", (t) => {
  // MEASURED 2026-11-09 (round44): two `navigate_to_destination` executions ended `destination_unreachable`
  // (`topology=unreachable`) at 11:34:45 and 11:35:58, and a stall fact at 12:01:58 reported `elapsedMs 1560015` for an
  // execution that had stopped 26 minutes earlier - `owner: null`, `endsWithin: null`, `evicted: 0`. `blocked` is a
  // terminal receipt, and the classification of "terminal" belongs to the ledger, not to a second list kept here.
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_navigate", { actionId: "navigate_to_destination" }));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  assert.ok(pump.takeStallFact() !== undefined, "the silence was real while it lasted");

  pump.enqueueFact(
    receipt("blocked", "exec_navigate", {
      actionId: "navigate_to_destination",
      reasonCode: "destination_unreachable",
      topology: "unreachable",
    }),
  );
  assert.deepEqual(pump.stallWatch.watched, [], "a terminal receipt of ANY state ends the watch entry");
  assert.equal(pump.stallWatch.nextStallInMs, undefined, "and leaves no deadline for the Host to arm");

  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS * 12);
  assert.equal(pump.takeStallFact(), undefined, "twenty-four minutes later, a blocked execution is still not a stall");
});

test("a still-open execution's elapsedMs is the silence since its last fact, not the age of the run", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_sleep"));
  t.mock.timers.tick(30_000);
  pump.enqueueFact(receipt("meaningful_progress", "exec_sleep"));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);

  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "one bound of silence after the last fact is where it is due");
  assert.equal(
    fact.payload.elapsedMs,
    EXECUTION_STALL_BOUND_MS,
    "the bound - not the 150 s this execution has existed for, and not a number that keeps growing",
  );
  assert.equal(fact.payload.lastFactKind, "execution_receipt:meaningful_progress");
  assert.equal(pump.takeStallFact(), undefined, "exactly one fact at the bound, never a second in the same instant");
});

test("a stall fact bounds the executions it cannot date, and counts what it omitted", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  const total = MAX_WATCHED_EXECUTIONS * 2 + 1;
  for (let index = 0; index < total; index += 1) pump.enqueueFact(receipt("running", `exec_${index}`));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);

  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined);
  const unmeasured = fact.payload.unmeasured as readonly unknown[];
  assert.equal(unmeasured.length, MAX_STALL_UNMEASURED_SHOWN, "the fact is model context, so the list is bounded");
  assert.equal(fact.payload.omitted, total - MAX_WATCHED_EXECUTIONS - MAX_STALL_UNMEASURED_SHOWN);
  assert.equal(
    pump.stallWatch.unmeasured.length,
    total - MAX_WATCHED_EXECUTIONS,
    "the pump's own reading still names every one of them",
  );
});

test("a stall with no body-owning transition says so instead of a bare null owner", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact(receipt("running", "exec_sleep"));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
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

test("a held body is carried on the stall fact, with what would release it", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  // The shape round43 measured: `sleep` refused with `body_owned_by_day_advance` and `owner_action=sleep`.
  pump.enqueueFact({
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
  });
  pump.enqueueFact(receipt("running", "exec_sleep"));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "the running execution stalls regardless of why");
  assert.equal(fact.payload.owner, "body_owned_by_day_advance");
  assert.equal(fact.payload.endsOwnershipWith, "sleep", "an answer that stops at 'stuck' is half an answer");
  assert.equal(
    "ownershipAbsentReason" in fact.payload,
    false,
    "a named owner needs no reason for an absence it does not have",
  );
});

test("with no owner_transition named, the release is the fact the guard itself clears on", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const pump = new CompanionEventPump();
  pump.enqueueFact({
    source: "stardew_mod",
    kind: "execution_receipt",
    eventId: "body_owned",
    correlationId: "exec_advance",
    executionId: "exec_advance",
    revision: 1,
    payload: { state: "failed", executionId: "exec_advance", rejectionCode: "body_owned_by_day_advance" },
  });
  pump.enqueueFact(receipt("running", "exec_sleep"));
  t.mock.timers.tick(EXECUTION_STALL_BOUND_MS);
  const fact = pump.takeStallFact();
  assert.ok(fact !== undefined, "the running execution stalls regardless of why");
  assert.equal(fact.payload.owner, "body_owned_by_day_advance");
  assert.equal(fact.payload.endsOwnershipWith, "day_started", "the transition guard's own leaving fact");
});
