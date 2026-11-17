import assert from "node:assert/strict";
import test from "node:test";

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
   * The join is the one that used to be missing from this table: an ordinary close must not tear
   * the world down under an in-flight `game.create`/`game.resume`, so it awaits the attempt, whose
   * deadline is the Farmhand join budget for the world it attaches to. The workload term is per
   * player Mod, so the gate sweeps counts instead of picking one.
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
 * Player-Mod counts the join must cover: the empty Mods folder, a handful, the count where the
 * workload term alone reaches the admission-expiry ceiling, and counts past it.
 */
const JOIN_MOD_COUNTS = Object.freeze([0, 1, 10, 100, 450, 1_000]);

/**
 * The ceiling the coordinator's own admission lease puts on any attempt the close can join: the
 * lease expiry is capped at ten minutes (`stardew-production-lifecycle-coordinator.internal.ts`),
 * so a join never outlives it, whatever the world's Mod count.
 */
const JOIN_CEILING_MS = 600_000;

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
  // The joins are the operation no single owner constant can state, so they are checked over the
  // counts a world can report rather than over one number.
  for (const count of JOIN_MOD_COUNTS) {
    const ms = Math.min(JOIN_CEILING_MS, stardewFarmhandJoinBudgetMs(count));
    if (ms > bounds.drain_game_lifecycle) {
      outliving.push(
        Object.freeze({
          step: "drain_game_lifecycle" as const,
          owner: `the in-flight game.create/game.resume join (${STARDEW_FARMHAND_JOIN_BASE_BUDGET_MS} ms + ${count} player Mods)`,
          ms,
        }),
      );
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
  // The proof that the check above can fail, over the same population and the same numbers. The
  // ordinary bound is short enough to fire inside the game step's own operation, and the 60 s
  // ceiling this table used to declare for EVERY step is short enough that even a world with no
  // player Mods outlives it - which is the false failure the table now prevents.
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
      ...JOIN_MOD_COUNTS.map((count) => Math.min(JOIN_CEILING_MS, stardewFarmhandJoinBudgetMs(count))),
    ],
  );

  // The old ceiling: the two budgeted operations fit inside it, and only the join does not - which
  // is exactly the operation the table could not see before.
  const atTheOldCeiling = stepsOutlivingTheirBound(
    DESKTOP_HOST_RECLAMATION_STEPS,
    uniform(60_000),
    STEP_OWNED_OPERATIONS,
  );
  assert.equal(atTheOldCeiling.length, JOIN_MOD_COUNTS.length);
  assert.deepEqual([...new Set(atTheOldCeiling.map((entry) => entry.step))], ["drain_game_lifecycle"]);
  assert.match(DESCRIBE_OUTLIVING(atTheOldCeiling, uniform(60_000)), /in-flight game\.create\/game\.resume join/);
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
