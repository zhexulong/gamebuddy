import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  DESKTOP_HOST_DRAIN_DEADLINE_MS,
  DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS,
  DESKTOP_HOST_RECLAMATION_STEPS,
  DESKTOP_HOST_STEP_HANG_DEADLINE_MS,
  type DesktopHostReclamationStep,
  type DesktopHostReclamationStepBounds,
} from "./desktop-host-reclamation.js";
import { DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS } from "./stardew/stardew-guardian-platform.js";
import {
  STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
  STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS,
  STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS,
  stardewFarmhandJoinBudgetMs,
} from "../stardew-production-lifecycle-coordinator.internal.js";

/**
 * The gate over the exit reclamation's arithmetic.
 *
 * A step's bound is not a latency target: it is the point at which the exit NAMES that step as
 * failed, so it must sit above the ceiling of every operation the step can be waiting on. A step
 * whose own bounded operation is longer than its bound is therefore a defect, not a slow exit -
 * the reclamation abandons work the product still owns and the player reads a failure that never
 * happened.
 *
 * The population comes from the step table itself, the numbers come from the modules that own
 * them (or from the measurement that closed them), and the table is total over the step union: a
 * new step is a type error here until it answers what it waits on.
 */

/**
 * The one await no cancel epoch can reach: the create's cabin handoff admission.
 *
 * It is read from the module that owns it (`confirmAndAdmit` bounds the wait with
 * `Math.min(60_000, Math.max(1, facts.expiresAtMs - readClock()))`) rather than imported,
 * because that module is a private core with exactly three permitted importers - and a number
 * this table could not see is exactly how the step's bound drifted below its own operations
 * before. If the composer's number moves, this reading moves with it, or the gate names the line
 * it could not find instead of passing over an unexamined operation.
 */
const MANIFEST_HANDOFF_ADMISSION_WAIT_BUDGET_MS = readManifestHandoffAdmissionWaitBudgetMs();

function readManifestHandoffAdmissionWaitBudgetMs(): number {
  // Same depth in `src/` and in `dist-test/`, so the reading works from either artifact.
  const sourcePath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "games",
    "stardew",
    "lifecycle",
    "stardew-private-bootstrap-composer.core.internal.ts",
  );
  const source = readFileSync(sourcePath, "utf8");
  const match = /Math\.min\(([\d_]+),\s*Math\.max\(1,\s*facts\.expiresAtMs - readClock\(\)\)\)/u.exec(source);
  if (match === null)
    throw new Error(
      `${sourcePath} no longer bounds its handoff admission wait in the shape this gate reads ` +
        "(Math.min(<ms>, Math.max(1, facts.expiresAtMs - readClock()))): the create's own await must be named " +
        "here, or this reading measured nothing",
    );
  const ms = Number(match[1]!.replaceAll("_", ""));
  if (!Number.isSafeInteger(ms) || ms <= 0)
    throw new Error(`the handoff admission wait ${match[1]!} is not a positive whole number of milliseconds`);
  return ms;
}

/**
 * What a reclamation step can be waiting on, and the number its owner publishes for it.
 *
 * Every entry is an operation the step's close awaits - not an operation of some other surface it
 * merely coexists with - so the shape of this table is the answer to "what must the bound cover".
 * A step that grows a call has to add it here, because the gate reads this table rather than the
 * step's implementation.
 */
const STEP_OWNED_OPERATIONS: Readonly<
  Record<DesktopHostReclamationStep, readonly Readonly<{ owner: string; ms: number }>[]>
> = Object.freeze({
  /** Releases the presentation listener's port: a close with no operation budget of its own. */
  stop_admission: [],
  /** Ends the turn it was generating and releases the mounted lane: no operation budget of its own. */
  drain_chat_runtime: [],
  /**
   * The only step that waits on budgeted operations. Each is a number its owner publishes; none of
   * them is written here.
   *
   * The JOIN used to be in this table, and it was the reason the step's bound was 600 s: an ordinary
   * close awaited an in-flight `game.create`/`game.resume` to the end of its join. The exit now asks
   * both attempts to stop before it joins them, so what is left is the ONE await each of them can
   * still be inside - which is what this table holds, and why the bound is 60 s.
   */
  drain_game_lifecycle: [
    Object.freeze({
      owner: "DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS (composition/stardew/stardew-guardian-platform.ts)",
      ms: DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS,
    }),
    Object.freeze({
      owner:
        "STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS (stardew-production-lifecycle-coordinator.internal.ts)",
      ms: STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS,
    }),
    Object.freeze({
      owner: "STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS (stardew-production-lifecycle-coordinator.internal.ts)",
      ms: STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
    }),
    Object.freeze({
      owner:
        "the cabin handoff admission wait (games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts)",
      ms: MANIFEST_HANDOFF_ADMISSION_WAIT_BUDGET_MS,
    }),
  ],
  /** Records the one reflection the runtime root is owed: one marker file, no operation to wait on. */
  reflect_session: [],
  /** Closes the durable semantic authority: a store close, with no operation budget of its own. */
  release_shared_authority: [],
  /** Destroys the authenticated Guardian socket: a socket destroy, with no operation budget of its own. */
  release_guardian_session: [],
  /** Destroys the optional Voice client's socket: a socket destroy, with no operation budget of its own. */
  release_voice_client: [],
  /** Disposes this process's own termination watchers: nothing to wait on. */
  release_termination_watchers: [],
});

/**
 * The closes measured on a real exit for the steps whose operations publish no budget.
 *
 * These are readings, not targets: each is the largest of five samples of the same physical close
 * the step performs (`.tmp/measure-exit-closes.mjs`), except the two taken from a real exit by the
 * commits that made those steps cheap. They are a floor the declared bound must clear, so they
 * cannot flake - a close that is faster than it was measured stays under any bound that cleared
 * the reading.
 */
const MEASURED_ORDINARY_CLOSES: readonly Readonly<{ step: DesktopHostReclamationStep; ms: number }>[] = Object.freeze([
  Object.freeze({ step: "stop_admission", ms: 0.401 }),
  Object.freeze({ step: "drain_chat_runtime", ms: 90 }),
  Object.freeze({ step: "reflect_session", ms: 3 }),
  Object.freeze({ step: "release_shared_authority", ms: 1.248 }),
  Object.freeze({ step: "release_guardian_session", ms: 0.098 }),
  Object.freeze({ step: "release_voice_client", ms: 0.684 }),
  Object.freeze({ step: "release_termination_watchers", ms: 0.029 }),
]);

/**
 * Every step whose bound does not cover one of its owned operations, named with the owner of the
 * number that exposed it.
 *
 * The population is cross-checked against the table that declares it, because that table is total
 * over the step union: a reading over a different number of steps examined a population this file
 * did not measure, and a gate that examined nothing has not passed.
 */
function stepsOutlivingTheirBound(
  steps: readonly DesktopHostReclamationStep[],
  bounds: DesktopHostReclamationStepBounds,
  owned: Readonly<Record<DesktopHostReclamationStep, readonly Readonly<{ owner: string; ms: number }>[]>>,
): readonly Readonly<{ step: DesktopHostReclamationStep; owner: string; ms: number }>[] {
  const declared = Object.keys(owned).length;
  if (steps.length !== declared)
    throw new Error(
      `examined ${steps.length} of the ${declared} reclamation steps the owned-operations table declares: ` +
        "every step is checked against its own operations, or this reading measured nothing",
    );
  const outliving: { step: DesktopHostReclamationStep; owner: string; ms: number }[] = [];
  for (const step of steps) {
    for (const operation of owned[step]) {
      if (operation.ms > bounds[step]) {
        outliving.push(Object.freeze({ step, owner: operation.owner, ms: operation.ms }));
      }
    }
  }
  return Object.freeze(outliving);
}

const DESCRIBE_OUTLIVING = (
  outliving: readonly Readonly<{ step: DesktopHostReclamationStep; owner: string; ms: number }>[],
  bounds: DesktopHostReclamationStepBounds,
): string =>
  outliving
    .map((entry) => `${entry.step} waits ${entry.ms} ms on ${entry.owner} but may only spend ${bounds[entry.step]} ms`)
    .join("; ");

test("every step's bound covers every operation that step can be waiting on", () => {
  const outliving = stepsOutlivingTheirBound(
    DESKTOP_HOST_RECLAMATION_STEPS,
    DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS,
    STEP_OWNED_OPERATIONS,
  );
  assert.deepEqual(
    outliving,
    [],
    `these steps wait on an operation their own bound does not cover, so the exit would abandon work it still owns ` +
      `and name a step that never failed: ${DESCRIBE_OUTLIVING(outliving, DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS)}. ` +
      "Raise that step's entry in DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS (composition/desktop-host-reclamation.ts) " +
      "to the longest of them, or shorten that operation.",
  );
});

test("the gate is red at a bound below the operations a step waits on, and it names the step and the owner", () => {
  // The proof that the check above can fail, over the same population and the same numbers.
  const ordinaryBound = Math.min(
    ...DESKTOP_HOST_RECLAMATION_STEPS.map((step) => DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS[step]),
  );
  const uniform = (ms: number): DesktopHostReclamationStepBounds =>
    Object.freeze(
      Object.fromEntries(DESKTOP_HOST_RECLAMATION_STEPS.map((step) => [step, ms])) as Record<
        DesktopHostReclamationStep,
        number
      >,
    );

  // The ordinary bound fires inside every operation the game step owns.
  const atTheOrdinaryBound = stepsOutlivingTheirBound(
    DESKTOP_HOST_RECLAMATION_STEPS,
    uniform(ordinaryBound),
    STEP_OWNED_OPERATIONS,
  );
  assert.deepEqual([...new Set(atTheOrdinaryBound.map((entry) => entry.step))], ["drain_game_lifecycle"]);
  assert.deepEqual(
    atTheOrdinaryBound.map((entry) => entry.ms),
    [
      DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS,
      STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS,
      STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS,
      MANIFEST_HANDOFF_ADMISSION_WAIT_BUDGET_MS,
    ],
  );

  // Lowered BELOW the connect budget: the three 60 s operations are named and the 45 s connect is
  // not, so the gate still fails when a bound sits under an operation the step owns - and it names
  // which one.
  const atTheConnectBudget = stepsOutlivingTheirBound(
    DESKTOP_HOST_RECLAMATION_STEPS,
    uniform(STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS),
    STEP_OWNED_OPERATIONS,
  );
  assert.deepEqual([...new Set(atTheConnectBudget.map((entry) => entry.step))], ["drain_game_lifecycle"]);
  assert.deepEqual(
    atTheConnectBudget.map((entry) => entry.owner),
    [
      "DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS (composition/stardew/stardew-guardian-platform.ts)",
      "STARDEW_PLAYER_HOST_ROLE_LAUNCH_OPERATION_BUDGET_MS (stardew-production-lifecycle-coordinator.internal.ts)",
      "the cabin handoff admission wait (games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.ts)",
    ],
  );
  assert.match(
    DESCRIBE_OUTLIVING(atTheConnectBudget, uniform(STARDEW_FARMHAND_BRIDGE_CONNECT_BUDGET_MS)),
    /cabin handoff admission/,
  );
});

test("the exit no longer waits a join, so no bound has to cover one", () => {
  // The number this replaced: 600 s, the ceiling of the join an ordinary close used to await. The
  // declared bound must now be BELOW the smallest join a world can have, because the exit cancels
  // both attempts before it joins them - a bound that still covered a join would mean the cancel
  // stopped reaching the wait it was added for.
  const smallestJoinMs = Math.min(600_000, stardewFarmhandJoinBudgetMs(0));
  assert.equal(smallestJoinMs, STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS);
  assert.ok(
    DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS.drain_game_lifecycle < smallestJoinMs,
    `drain_game_lifecycle still spends ${DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS.drain_game_lifecycle} ms, which only a join needs`,
  );
  // And it is exactly the largest operation the step still owns, so it is not merely small.
  const ownedMs = STEP_OWNED_OPERATIONS.drain_game_lifecycle.map((operation) => operation.ms);
  assert.equal(DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS.drain_game_lifecycle, Math.max(...ownedMs));
});

test("the gate refuses to pass over zero steps", () => {
  assert.throws(
    () => stepsOutlivingTheirBound([], DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS, STEP_OWNED_OPERATIONS),
    /examined 0/,
  );
});

test("the ordinary steps' bound clears every close measured on a real exit, with the multiple stated once", () => {
  const game = DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS.drain_game_lifecycle;
  const ordinary = DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS.stop_admission;
  assert.ok(Number.isSafeInteger(game) && Number.isSafeInteger(ordinary));

  // The seven steps that own no budgeted operation share one bound, and it is derived from the
  // largest close measured on a real exit rather than chosen: the Chat drain's 90 ms, doubled.
  for (const step of DESKTOP_HOST_RECLAMATION_STEPS) {
    if (step === "drain_game_lifecycle") continue;
    assert.equal(DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS[step], ordinary, `${step} must share the ordinary bound`);
  }
  const largest = MEASURED_ORDINARY_CLOSES.reduce((left, right) => (right.ms > left.ms ? right : left));
  assert.equal(largest.step, "drain_chat_runtime");
  assert.ok(
    ordinary >= largest.ms * 2,
    `the ordinary bound ${ordinary} ms must be at least twice the largest measured close (${largest.ms} ms, ${largest.step})`,
  );
  for (const measured of MEASURED_ORDINARY_CLOSES) {
    assert.ok(
      ordinary >= measured.ms,
      `${measured.step}'s measured ${measured.ms} ms close must fit inside the ordinary bound ${ordinary} ms`,
    );
  }
});

test("the published exit deadline is the sum of the declared per-step bounds", () => {
  // The launcher waits exactly this value, so it must be the same arithmetic that produced it. A
  // step's ceiling counted once is what the sequence can cost: every step runs once, and a step
  // that outlives its own bound is abandoned and named there rather than spending the next step's.
  const sum = DESKTOP_HOST_RECLAMATION_STEPS.reduce(
    (total, step) => total + DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS[step],
    0,
  );
  assert.equal(DESKTOP_HOST_DRAIN_DEADLINE_MS, sum);
  assert.ok(Number.isSafeInteger(DESKTOP_HOST_DRAIN_DEADLINE_MS));
  assert.ok(
    DESKTOP_HOST_DRAIN_DEADLINE_MS < DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS.drain_game_lifecycle * 2,
    "the deadline must not spend the game step's ceiling twice",
  );
});

test("the published step-hang number is the first point at which the Host has named a step stuck", () => {
  // The Desktop's second closing copy starts here, so it must be the smallest declared bound: the
  // point at which an ordinary step would already have been named.
  const smallest = Math.min(
    ...DESKTOP_HOST_RECLAMATION_STEPS.map((step) => DESKTOP_HOST_RECLAMATION_STEP_BOUND_MS[step]),
  );
  assert.equal(DESKTOP_HOST_STEP_HANG_DEADLINE_MS, smallest);
  assert.ok(DESKTOP_HOST_STEP_HANG_DEADLINE_MS <= DESKTOP_HOST_DRAIN_DEADLINE_MS);
});
