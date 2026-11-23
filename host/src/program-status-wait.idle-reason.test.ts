import assert from "node:assert/strict";
import test from "node:test";
import { CompanionEventPump, FACT_PRODUCER } from "./event-pump.js";
import {
  createProgramProgressObserver,
  IDLE_WAIT_REASON,
  IDLE_WAIT_REASONS,
  type IdleCondition,
  type IdleWaitReason,
  IN_FLIGHT_READING_MAX_AGE_MS,
  idleWaitReading,
} from "./program-status-wait.js";

/**
 * `wait.idle` says WHICH wait it is, over the conditions an idle companion can be in.
 *
 * <p>
 * MEASURED 2026-11-21 (`round94`, one 535 s gap between two programmes): `wait.idle (reason: "nothing_owed")` read 509.7 s
 * of it - 171.1 s waiting for a fresh reading, 217.4 s waiting for the world's next fact, 121.2 s naming no wait at all -
 * and a task was unfinished throughout. The word had been computed from the journal's node count, so between two programmes
 * it said "no plan has a node left" and a reader took it for a statement about the task. Three different next steps were one
 * sentence.
 * </p>
 * <p>
 * WHAT THIS FILE OWNS IS THE MATRIX: the four members of the closed list, each produced by a reading that is a REAL SHAPE the
 * product can be in, and no reading producing one outside it. The falsifiers below are the two the old file proved for
 * `nothing_owed` - a ledger whose watch died, and a plan whose last node has happened - kept because both say what the
 * executor may NOT be blamed for.
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

const IDLE: IdleCondition = Object.freeze({ heldBody: false, runQuiet: false });
const HELD: IdleCondition = Object.freeze({ heldBody: true, runQuiet: false });
const QUIET: IdleCondition = Object.freeze({ heldBody: false, runQuiet: true });

test("an idle wait behind her own plan is the executor's, and one behind a held body waits for the game", () => {
  const observer = createProgramProgressObserver();
  const empty = idleWaitReading(IDLE, observer.inFlight(1_000));
  assert.deepEqual(
    { ...empty },
    { reason: IDLE_WAIT_REASON.freshReading, programmes: 0, remaining: 0 },
    "a ledger with no plan in it means the next plan needs a world that has been read again, and it still reports its population",
  );

  observer.observe(
    journalStatus("plan_idle", "active", [
      { nodeId: "n001", actionId: "water_crop", state: "succeeded" },
      { nodeId: "n002", actionId: "water_crop", state: "running" },
      { nodeId: "n003", actionId: "harvest_crop", state: "pending" },
    ]),
    0,
  );
  const working = idleWaitReading(IDLE, observer.inFlight(1_000));
  assert.deepEqual(
    { ...working },
    { reason: IDLE_WAIT_REASON.bodyStillWorking, programmes: 1, remaining: 2 },
    "two nodes have not happened, so the 35 s the pump owed nothing for is our executor's, and the run can say so",
  );

  // The plan is out of the way: the body is the engine's, and the wait is the fact that ends the hold.
  observer.observe(journalStatus("plan_idle", "settled", []), 0);
  assert.deepEqual(
    { ...idleWaitReading(HELD, observer.inFlight(1_000)) },
    { reason: IDLE_WAIT_REASON.heldBody, programmes: 0, remaining: 0 },
    "a body the engine holds is waited for on the native actionable fact, and the name says which wait that is",
  );
  assert.deepEqual(
    { ...idleWaitReading(QUIET, observer.inFlight(1_000)) },
    { reason: IDLE_WAIT_REASON.runQuiet, programmes: 0, remaining: 0 },
    "a run that has stopped by its own decision is not waiting for anything, and says so instead of naming a wait",
  );
});

/**
 * The FALSIFIER for `body_still_working`: a reading past its age is not evidence a plan is running.
 *
 * <p>
 * The settlement watch leaves its last read in the ledger when it ends (a drained runtime, an expired bound), so a reading
 * that kept answering `body_still_working` after the watch died would blame the executor for a silence nothing is watching.
 * Drop the freshness filter and this case reds: the same snapshot would still be counted 30 s later.
 * </p>
 */
test("a reading whose watch has gone quiet is not our executor's wait", () => {
  const observer = createProgramProgressObserver();
  observer.observe(
    journalStatus("plan_stale", "active", [{ nodeId: "n001", actionId: "water_crop", state: "running" }]),
    0,
  );
  const atTheBound = idleWaitReading(IDLE, observer.inFlight(IN_FLIGHT_READING_MAX_AGE_MS));
  assert.equal(atTheBound.reason, IDLE_WAIT_REASON.bodyStillWorking, "at the bound the read is still evidence");
  const pastTheBound = idleWaitReading(IDLE, observer.inFlight(IN_FLIGHT_READING_MAX_AGE_MS + 1));
  assert.deepEqual(
    { ...pastTheBound },
    { reason: IDLE_WAIT_REASON.freshReading, programmes: 0, remaining: 0 },
    "past the bound nothing is running as far as the Host can tell, so it must not blame the body - and the wait it names is a read",
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
  const reading = idleWaitReading(IDLE, observer.inFlight(1_000));
  assert.equal(reading.remaining, 0, "nothing is left for the body to run");
  assert.equal(
    reading.reason,
    IDLE_WAIT_REASON.freshReading,
    "what is left is the Mod's settlement answer, one watch interval away - the executor has nothing in front of it",
  );
});

/**
 * THE GATE: every reason the closed list declares is produced by some condition, and none is reached by two.
 *
 * <p>
 * The population is derived from the list rather than written here, so a member added without a case fails by name. The
 * cases are the product of the two conditions this module does not own (`heldBody`, `runQuiet`) and the journal reading it
 * does, so each member is reached by the shape a run would actually be in.
 * </p>
 */
test("every declared idle reason is reachable from a condition, and the list is the whole matrix", () => {
  const observer = createProgramProgressObserver();
  const noPlan = (): ReturnType<typeof observer.inFlight> => observer.inFlight(0);
  const reached = new Map<IdleWaitReason, number>();
  const note = (condition: IdleCondition): void => {
    const reason = idleWaitReading(condition, noPlan()).reason;
    reached.set(reason, (reached.get(reason) ?? 0) + 1);
  };

  note(QUIET);
  note(HELD);
  note(IDLE);
  observer.observe(
    journalStatus("plan_gate", "active", [{ nodeId: "n001", actionId: "water_crop", state: "pending" }]),
    0,
  );
  note(IDLE);

  const unreachable = IDLE_WAIT_REASONS.filter((reason) => (reached.get(reason) ?? 0) === 0);
  console.log(
    `idle_wait_reasons: examined ${String(IDLE_WAIT_REASONS.length)} · reached ${String(reached.size)} · ` +
      `${IDLE_WAIT_REASONS.map((reason) => `${reason}=${String(reached.get(reason) ?? 0)}`).join(" ")}`,
  );
  assert.deepEqual(
    unreachable,
    [],
    `the closed list declares and no condition produces: ${unreachable.join(", ")} (examined ${String(
      IDLE_WAIT_REASONS.length,
    )} · reached ${String(reached.size)})`,
  );
  assert.equal(reached.size, IDLE_WAIT_REASONS.length, "and no reading produces a reason outside the list");
});

/**
 * AND THE ONE FACT THE HOST CANNOT READ FOR ITSELF: a held body is the pump's reading, not a duration.
 *
 * <p>
 * The three sources are the Mod's own three statements - the engine's admission gate (`actionable: false`), a native
 * performance (`actorDispositionKind: "event"`), and a transition that has taken the body (`body_owned_by_*`). The pump is
 * driven with each of them and reads `bodyHeldByEngine`, which is what the idle decision is taken on; a fourth case says a
 * free body is not held, so the gate cannot pass by answering `true` to everything.
 * </p>
 */
test("a held body is the Mod's own statement, in the three shapes it makes it in", async () => {
  const reading = (payload: Readonly<Record<string, unknown>>): Parameters<CompanionEventPump["enqueueFact"]>[0] =>
    Object.freeze({
      source: "stardew_mod",
      kind: "snapshot" as const,
      correlationId: "snapshot_hold",
      revision: 4,
      occurredAtMs: 1,
      observedTick: 1,
      gameTime: "1220",
      payload: Object.freeze({ revision: 4, location: "Farm", gameTime: "1220", ...payload }),
    });
  const sink = { async deliver() {} };

  const cases: readonly Readonly<{ name: string; fact: ReturnType<typeof reading>; held: boolean }>[] = [
    {
      name: "admission_gate",
      fact: reading({ actionable: false }),
      held: true,
    },
    {
      name: "native_performance",
      fact: reading({ actionable: true, actorDispositionKind: "event" }),
      held: true,
    },
    {
      name: "free_body",
      fact: reading({ actionable: true, actorDispositionKind: "idle" }),
      held: false,
    },
  ];
  const findings: string[] = [];
  for (const entry of cases) {
    const pump = new CompanionEventPump(undefined, () => 1_000);
    pump.enqueueFact(entry.fact, FACT_PRODUCER.adapterIngress);
    await pump.flush(sink);
    if (pump.bodyHeldByEngine !== entry.held)
      findings.push(`${entry.name}: read \`${String(pump.bodyHeldByEngine)}\` rather than \`${String(entry.held)}\``);
  }

  // The third source is a transition, which is entered by the Mod's own hold code and ended by the fact that ends it.
  const transition = new CompanionEventPump(undefined, () => 1_000);
  transition.enqueueFact(
    Object.freeze({
      source: "stardew_mod",
      kind: "semantic_event" as const,
      eventId: "body_owned_by_day_advance_1",
      sourceEventId: "body_owned_by_day_advance_1",
      correlationId: "body_owned_by_day_advance_1",
      revision: 4,
      occurredAtMs: 1,
      semanticKind: "action_refused",
      payload: Object.freeze({ kind: "action_refused", reasonCode: "body_owned_by_day_advance" }),
    }),
    FACT_PRODUCER.adapterIngress,
  );
  if (transition.bodyHeldByEngine !== true) findings.push("transition: the body a warp owns is not read as held");

  console.log(
    `a_held_body_is_the_mod_s_own_statement: ${cases.length + 1} shapes · ` +
      `${cases.map((entry) => `${entry.name}=${String(entry.held)}`).join(" · ")} · transition=true`,
  );
  assert.deepEqual(findings, [], findings.join("; "));
  // THE OTHER SIDE: a body nobody is holding is the case the reading arm acts on, so it must not read as held by accident.
  assert.equal(cases.filter((entry) => !entry.held).length, 1, "one free-body case: the gate is not a constant");
});
