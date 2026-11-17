import assert from "node:assert/strict";
import test from "node:test";

import {
  createProgramProgressObserver,
  IDLE_WAIT_REASON,
  IDLE_WAIT_REASONS,
  type IdleWaitReason,
  idleWaitReading,
  IN_FLIGHT_READING_MAX_AGE_MS,
} from "./program-status-wait.js";

/**
 * `wait.idle` says WHICH wait it is, and the two answers come from the journal's own nodes.
 *
 * <p>
 * MEASURED 2026-11-17 (`round65`, the run's own account line): `turns opened 26` at a median interval of 35 s, all 26
 * opened by `adapter_ingress`, against `receipts 185 {programme 177}`. The bundle could say how often she decided and
 * could not say what the 35 s was: one word, `nothing_owed`, covered both "the world said nothing" and "our own executor
 * still had nodes to run". Those are the two halves of "the work is too little" that need different answers - one is the
 * world's clock and one is ours - and a run in which they are the same word cannot tell them apart.
 * </p>
 * <p>
 * WHAT THIS FILE DOES NOT CLAIM. It does not say a turn may open inside a node: it may not, and the pump's own
 * classification is the authority for that (`FACT_TURN_CONSEQUENCE`: `accepted`/`running`/`meaningful_progress` are
 * `progress`, and only a terminal receipt or a settlement is a `decision`). It says that when the pump does owe no turn,
 * the run records which of the two waits it was in.
 * </p>
 */

/** A journal snapshot in the shape `validateBodyProgramStatusResult` accepts (`actionId` is required per row). */
function journalStatus(
  programId: string,
  state: string,
  nodes: readonly Readonly<{ nodeId: string; actionId: string; state: string }>[],
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    code: "found",
    snapshot: Object.freeze({
      programId,
      state,
      catalogRevision: 3,
      stopEpoch: 0,
      eventHighWater: 7,
      nodes: Object.freeze(
        nodes.map((node) =>
          Object.freeze({
            nodeId: node.nodeId,
            state: node.state,
            nodeAttempt: 0,
            admissionAttempt: 0,
            actionId: node.actionId,
          }),
        ),
      ),
    }),
  });
}

test("an idle wait behind her own plan is the executor's, and one behind nothing is the world's", () => {
  const observer = createProgramProgressObserver();
  const empty = idleWaitReading(observer.inFlight(1_000));
  assert.deepEqual(
    { ...empty },
    { reason: IDLE_WAIT_REASON.nothingOwed, programmes: 0, remaining: 0 },
    "a ledger with no plan in it is the world's wait, and it still reports its population",
  );

  observer.observe(
    journalStatus("plan_idle", "active", [
      { nodeId: "n001", actionId: "water_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "water_crop", state: "running" },
      { nodeId: "n003", actionId: "harvest_crop", state: "pending" },
    ]),
    0,
  );
  const working = idleWaitReading(observer.inFlight(1_000));
  assert.deepEqual(
    { ...working },
    { reason: IDLE_WAIT_REASON.bodyStillWorking, programmes: 1, remaining: 2 },
    "two nodes have not happened, so the 35 s the pump owes nothing for is our executor's, and the run can say so",
  );
});

/**
 * The FALSIFIER for the reason above: a reading past its age is not evidence a plan is running.
 *
 * <p>
 * The settlement watch leaves its last read in the ledger when it ends (a drained runtime, an expired bound), so a
 * reading that kept answering `body_still_working` after the watch died would blame the executor for a silence nothing
 * is watching. Drop the freshness filter and this case reds: the same snapshot would still be counted 30 s later.
 * </p>
 */
test("a reading whose watch has gone quiet is not our executor's wait", () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_stale", "active", [{ nodeId: "n001", actionId: "water_crop", state: "running" }]),
    0,
  );
  const atTheBound = idleWaitReading(observer.inFlight(IN_FLIGHT_READING_MAX_AGE_MS));
  assert.equal(atTheBound.reason, IDLE_WAIT_REASON.bodyStillWorking, "at the bound the read is still evidence");
  const pastTheBound = idleWaitReading(observer.inFlight(IN_FLIGHT_READING_MAX_AGE_MS + 1));
  assert.deepEqual(
    { ...pastTheBound },
    { reason: IDLE_WAIT_REASON.nothingOwed, programmes: 0, remaining: 0 },
    "past the bound nothing is running as far as the Host can tell, so it must not blame the body",
  );
});

test("a plan whose last node has happened is the settlement's wait, not the executor's", () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_done", "active", [
      { nodeId: "n001", actionId: "water_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "water_crop", state: "succeeded" },
    ]),
    0,
  );
  const reading = idleWaitReading(observer.inFlight(1_000));
  assert.equal(reading.remaining, 0, "nothing is left for the body to run");
  assert.equal(
    reading.reason,
    IDLE_WAIT_REASON.nothingOwed,
    "what is left is the Mod's settlement answer, one watch interval away - the executor has nothing in front of it",
  );
});

/**
 * THE GATE: every reason the closed list declares is produced by some reading, and the population is derived from the
 * list rather than written here, so a member added without a case fails by name.
 *
 * <p>
 * Two reasons and two cases is the whole population, so a third member with no reading behind it would make this count
 * disagree - which is what `reachable` prints instead of a bare pass.
 * </p>
 */
test("every declared idle reason is reachable from a ledger reading, and none is reached by two", () => {
  const observer = createProgramProgressObserver();
  const readings = [idleWaitReading(observer.inFlight(0))];
  observer.observe(
    journalStatus("plan_gate", "active", [{ nodeId: "n001", actionId: "water_crop", state: "pending" }]),
    0,
  );
  readings.push(idleWaitReading(observer.inFlight(0)));

  const reached = new Map<IdleWaitReason, number>();
  for (const reading of readings) reached.set(reading.reason, (reached.get(reading.reason) ?? 0) + 1);
  const unreachable = IDLE_WAIT_REASONS.filter((reason) => (reached.get(reason) ?? 0) === 0);
  assert.equal(
    unreachable.length,
    0,
    `the closed list declares and no ledger reading produces: ${unreachable.join(", ")} (examined ${String(
      IDLE_WAIT_REASONS.length,
    )} · reached ${String(reached.size)})`,
  );
  assert.equal(reached.size, IDLE_WAIT_REASONS.length, "and no reading produces a reason outside the list");
});
