import assert from "node:assert/strict";
import test from "node:test";

import { planActionsFromRegistrations, planShape } from "./body-program-script.js";

/**
 * A precondition the Mod enforces and never declares can only be learned by being refused.
 *
 * Measured 2026-10-25: the companion submitted a one-node program `enter_exit(3,12)` while it was in bed at
 * `FarmHouse(9,9)`. The Mod refused with `door_out_of_range` - correctly - and the companion added
 * `move_to_tile(3,11)` on its second attempt. One wasted round trip, and the precondition was knowable.
 *
 * `approachRequirement` is where that knowledge lives. These cases pin it: it is the Mod's declaration, its
 * absence is an explicit answer rather than an omission, and `plan_shape` surfaces it without the Host
 * inventing anything.
 *
 * The registration here is hand-built, which on its own proves only that this function reads the field. The half
 * that used to be missing - whether the Mod's declaration actually CLEARS the wire - is pinned end to end in
 * `approach-requirement-pipeline.test.ts`, which runs the Mod's own `hello_ack` serializer and feeds the result to
 * this same code.
 */

/**
 * The wire shape, exactly: `withinTiles` is present only when the Mod's relation states a distance, because the
 * Mod's serializer omits nulls. There is no `null` here to test - an earlier version of this file declared one,
 * which meant it pinned a registration the Mod cannot send.
 */
type ApproachDeclaration = Readonly<{ relation: string; withinTiles?: number }>;

const registrationWithApproach = (actionId: string, approach: ApproachDeclaration | undefined) => ({
  actionId,
  familyId: "movement_navigation",
  identityVersion: 1,
  lifecycle: "published" as const,
  kind: "execution" as const,
  descriptor: {
    arguments: [
      { name: "x", type: "integer" },
      { name: "y", type: "integer" },
    ],
    outputFacts: {},
    resourceTemplate: { claims: [] },
    effect: "write" as const,
    ...(approach === undefined ? {} : { approach }),
  },
});

test("a declared precondition reaches the published action verbatim", () => {
  const actions = planActionsFromRegistrations([
    registrationWithApproach("enter_exit", { relation: "adjacent", withinTiles: 1 }),
  ]);
  const action = actions.find((candidate) => candidate.actionId === "enter_exit");
  assert.ok(action);
  assert.deepEqual(action.approachRequirement, { declared: true, relation: "adjacent", withinTiles: 1 });
});

test("an action with no declaration says so, rather than implying 'stand anywhere'", () => {
  const actions = planActionsFromRegistrations([registrationWithApproach("till_soil", undefined)]);
  const action = actions.find((candidate) => candidate.actionId === "till_soil");
  assert.ok(action);
  assert.deepEqual(action.approachRequirement, {
    declared: false,
    reasonCode: "approach_requirement_undeclared",
  });
});

test("plan_shape surfaces the precondition, so the companion learns it before being refused", () => {
  const actions = planActionsFromRegistrations([
    registrationWithApproach("enter_exit", { relation: "adjacent", withinTiles: 1 }),
  ]);
  const shape = planShape(actions, { actionId: "enter_exit" });
  assert.equal(shape.ok, true);
  if (!shape.ok) return;
  assert.deepEqual(shape.actions[0]?.approachRequirement, { declared: true, relation: "adjacent", withinTiles: 1 });
});

test("a relation that states no distance stays null rather than becoming a guess", () => {
  // The Mod's serializer omits a null `withinTiles`, so ABSENT is what "no distance stated" looks like on the wire.
  // The published answer still names the field as null, because the companion may not have to distinguish "the
  // surface said nothing about distance" from "the surface did not declare an approach at all" - and it can: the
  // `declared` flag above already carries that distinction.
  const actions = planActionsFromRegistrations([registrationWithApproach("enter_exit", { relation: "adjacent" })]);
  const action = actions.find((candidate) => candidate.actionId === "enter_exit");
  assert.ok(action);
  assert.deepEqual(action.approachRequirement, { declared: true, relation: "adjacent", withinTiles: null });
});
