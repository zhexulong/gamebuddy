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
 */

type ApproachDeclaration = Readonly<{ relation: string; withinTiles: number | null }>;

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

test("a null distance stays null rather than becoming a guess", () => {
  const actions = planActionsFromRegistrations([
    registrationWithApproach("enter_exit", { relation: "adjacent", withinTiles: null }),
  ]);
  const action = actions.find((candidate) => candidate.actionId === "enter_exit");
  assert.ok(action);
  assert.deepEqual(action.approachRequirement, { declared: true, relation: "adjacent", withinTiles: null });
});
