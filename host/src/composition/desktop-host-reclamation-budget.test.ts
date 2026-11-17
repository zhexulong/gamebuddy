import assert from "node:assert/strict";
import test from "node:test";

import {
  DESKTOP_HOST_DRAIN_DEADLINE_MS,
  DESKTOP_HOST_DRAIN_TIMEOUT_MS,
  DESKTOP_HOST_RECLAMATION_STEPS,
  type DesktopHostReclamationStep,
} from "./desktop-host-reclamation.js";
import { DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS } from "./stardew/stardew-guardian-platform.js";

/**
 * The gate over the exit reclamation's budget.
 *
 * The per-step drain detector is not a latency target, it is the point at which the exit
 * NAMES a step as failed - so it must sit above every operation a step can legitimately be
 * waiting on. A step whose own bounded operation is longer than the detector is therefore a
 * defect, not a slow exit: the reclamation abandons work the product still owns and the
 * launcher's whole-exit deadline is spent naming steps that never had a chance.
 *
 * That is what these checks hold, and why they are a gate rather than a comment. The
 * population comes from the step table itself, the numbers come from the modules that own
 * them, and a step added to the table cannot be added without answering what it waits on.
 */

/**
 * What one step can be waiting on, and the number its owner publishes for it. The Record is
 * total over the step union, so a new step is a type error here until it declares its own
 * operations; every number is imported from the module that owns it, never written here.
 */
const STEP_OWNED_OPERATIONS: Readonly<
  Record<DesktopHostReclamationStep, readonly Readonly<{ owner: string; ms: number }>[]>
> = Object.freeze({
  /** Releases the presentation listener's port: a close, with no operation budget of its own. */
  stop_admission: [],
  /** Settles in-flight Chat turns: bounded by the turns themselves, not by a declared budget. */
  drain_chat_runtime: [],
  /** Contains the AI role through its Job Object by driving the arm/contain operation. */
  drain_game_lifecycle: [
    Object.freeze({
      owner: "DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS (composition/stardew/stardew-guardian-platform.ts)",
      ms: DESKTOP_RUNTIME_OPERATION_WAIT_BUDGET_MS,
    }),
  ],
  /** Records the one reflection the runtime root is owed: one marker file, no operation to wait on. */
  reflect_session: [],
  /** Closes the durable semantic authority: a store close, with no operation budget of its own. */
  release_shared_authority: [],
  /** Closes the authenticated session's pipe: a socket close, with no operation budget of its own. */
  release_guardian_session: [],
  /** Closes the optional Voice client's socket: a socket close, with no operation budget of its own. */
  release_voice_client: [],
  /** Disposes this process's own termination watchers: no operation to wait on. */
  release_termination_watchers: [],
});

/**
 * Every step whose owned operation outlives the per-step detector, named with the owner
 * constant that publishes it. The population is cross-checked against the table that declares
 * it, because the table is total over the step union: a reading over a different number of
 * steps examined a population this file did not measure, and a gate that examined nothing has
 * not passed.
 */
function stepsOutlivingTheDrainBudget(
  steps: readonly DesktopHostReclamationStep[],
  drainTimeoutMs: number,
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
      if (operation.ms > drainTimeoutMs) {
        outliving.push(Object.freeze({ step, owner: operation.owner, ms: operation.ms }));
      }
    }
  }
  return Object.freeze(outliving);
}

test("the per-step drain detector covers every operation a reclamation step waits on", () => {
  const outliving = stepsOutlivingTheDrainBudget(
    DESKTOP_HOST_RECLAMATION_STEPS,
    DESKTOP_HOST_DRAIN_TIMEOUT_MS,
    STEP_OWNED_OPERATIONS,
  );
  assert.deepEqual(
    outliving,
    [],
    `these steps wait on an operation longer than the ${DESKTOP_HOST_DRAIN_TIMEOUT_MS} ms per-step detector, so the exit would abandon work it still owns: ` +
      `${outliving.map((entry) => `${entry.step} waits ${entry.ms} ms on ${entry.owner}`).join("; ")}. ` +
      "Raise DESKTOP_HOST_DRAIN_TIMEOUT_MS (composition/desktop-host-reclamation.ts) to the longest of them, or shorten that operation.",
  );
});

test("the gate is red for a detector below the operations the steps wait on", () => {
  // The proof that the check above can fail, over the same population and the same numbers:
  // a detector short enough to fire inside a step's own bounded operation is reported by name.
  const outliving = stepsOutlivingTheDrainBudget(DESKTOP_HOST_RECLAMATION_STEPS, 15_000, STEP_OWNED_OPERATIONS);
  assert.deepEqual(
    outliving.map((entry) => entry.step),
    ["drain_game_lifecycle"],
  );
});

test("the gate refuses to pass over zero steps", () => {
  assert.throws(
    () => stepsOutlivingTheDrainBudget([], DESKTOP_HOST_DRAIN_TIMEOUT_MS, STEP_OWNED_OPERATIONS),
    /examined 0/,
  );
});

test("the published exit deadline is the per-step detector times the declared steps", () => {
  // The launcher waits exactly this value, so it must be the same arithmetic that produced it:
  // a per-step number raised without the deadline moving (or the reverse) leaves one of the two
  // sides waiting for something the other never promised.
  assert.equal(DESKTOP_HOST_DRAIN_DEADLINE_MS, DESKTOP_HOST_DRAIN_TIMEOUT_MS * DESKTOP_HOST_RECLAMATION_STEPS.length);
  assert.ok(Number.isSafeInteger(DESKTOP_HOST_DRAIN_DEADLINE_MS));
});
