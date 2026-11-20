import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  lookaheadIneligibility,
  MODAL_CLEARING_PLAN_ACTION_IDS,
  WORLD_LIFECYCLE_PLAN_ACTION_IDS,
} from "./body-program-script.js";
import { ROOT } from "./wire-declaration.test-support.js";

/**
 * `a_lookahead_eligibility_is_derived_from_the_declaration:<member>`.
 *
 * <p>
 * THE POPULATION IS THE MOD'S OWN PUBLICATION. `action-handler-groups.v1.json` is generated from the Mod's registrations
 * (`FarmhandActionHandlerGroup`), one row per action, and it is the only statement anywhere that says which actions belong
 * to `world_lifecycle` or `modal` - the wire descriptor carries arguments, output facts, resource claims, effect,
 * postcondition, scene binding, approach and target family, and NO group. So the Host's two lists are a PROJECTION, and
 * this file holds each to the artifact member by member, naming the drifting action in both directions.
 * </p>
 * <p>
 * WHAT THE RULE IS FOR. A plan composed while another programme has nodes left runs at least one node later than the
 * snapshot it was written from. Being one node stale is harmless for a chop - the Mod re-validates the target on the game
 * thread - and not harmless for an action whose whole subject is a day, a menu, or a scene somebody read. The failure
 * directions are deliberately asymmetric: an action wrongly excluded is planned one turn later; an action wrongly included
 * is planned THROUGH a day.
 * </p>
 * <p>
 * THE RESIDUAL IS PRINTED, not implied. `movement` legs declare no scene binding, so `travel` / `enter_exit` / a minecart
 * ride stay eligible - the four actions this rule cannot name, and the reason the block also subtracts the tiles a queued
 * node is working (`lookahead-re-ask.test.ts`): the movement case is caught there, by tile, not here by declaration.
 * </p>
 */

type HandlerGroupRow = Readonly<{ actionId: string; handlerGroup: string }>;

const HANDLER_GROUPS: readonly HandlerGroupRow[] = (
  JSON.parse(
    readFileSync(
      join(ROOT, "integrations/stardew/action-development/contracts/generated/action-handler-groups.v1.json"),
      "utf8",
    ),
  ) as { actions: readonly HandlerGroupRow[] }
).actions;

const groupMembers = (group: string): readonly string[] =>
  HANDLER_GROUPS.filter((row) => row.handlerGroup === group)
    .map((row) => row.actionId)
    .sort();

test("a_lookahead_eligibility_is_derived_from_the_declaration: the two projected groups match the Mod's artifact", () => {
  assert.ok(HANDLER_GROUPS.length > 50, `parsed only ${HANDLER_GROUPS.length} actions, so the artifact did not load`);

  const worldLifecycle = groupMembers("world_lifecycle");
  const modal = groupMembers("modal");
  assert.ok(worldLifecycle.length > 0 && modal.length > 0, "both groups must have members, or the gate is empty");

  assert.deepEqual(
    [...WORLD_LIFECYCLE_PLAN_ACTION_IDS].sort(),
    worldLifecycle,
    "WORLD_LIFECYCLE_PLAN_ACTION_IDS and the Mod's `world_lifecycle` group disagree - rename the drifting action on " +
      "the side that is wrong (`world_lifecycle:<actionId>:<host-only|artifact-only>`)",
  );
  assert.deepEqual(
    [...MODAL_CLEARING_PLAN_ACTION_IDS].sort(),
    modal,
    "MODAL_CLEARING_PLAN_ACTION_IDS and the Mod's `modal` group disagree - the compiler inserts the first member as a " +
      "dismissal step, so a member missing here is a plan refused with no legal remedy",
  );
});

test("a_lookahead_eligibility_is_derived_from_the_declaration: every action is classified by its own declaration", () => {
  let ineligible = 0;
  let eligible = 0;
  const drift: string[] = [];
  const residual: string[] = [];
  for (const row of HANDLER_GROUPS) {
    const verdict = lookaheadIneligibility({ actionId: row.actionId });
    if (row.handlerGroup === "world_lifecycle" && verdict !== "world_lifecycle")
      drift.push(`${row.actionId}: expected world_lifecycle, got ${String(verdict)}`);
    else if (row.handlerGroup === "modal" && verdict !== "modal")
      drift.push(`${row.actionId}: expected modal, got ${String(verdict)}`);
    else if (row.handlerGroup !== "world_lifecycle" && row.handlerGroup !== "modal" && verdict !== undefined)
      drift.push(`${row.actionId}: ${row.handlerGroup} is not a lookahead-blocking group, got ${verdict}`);
    if (verdict === undefined) {
      eligible += 1;
      if (row.handlerGroup === "movement") residual.push(row.actionId);
    } else ineligible += 1;
  }
  assert.deepEqual(drift, [], `an action is classified against its own group and disagrees: ${drift.join("; ")}`);
  assert.ok(
    ineligible > 0 && eligible > ineligible,
    `examined ${HANDLER_GROUPS.length}: a rule that excludes everything or nothing is not a classification`,
  );
  console.log(
    `a_lookahead_eligibility_is_derived_from_the_declaration: examined ${String(HANDLER_GROUPS.length)} · ` +
      `ineligible ${String(ineligible)} · eligible ${String(eligible)} · ` +
      `eligibility residual: movement legs with no scene binding (${residual.sort().join(", ")})`,
  );
});

test("a_lookahead_eligibility_is_derived_from_the_declaration: a declared scene binding excludes the action", () => {
  const sceneBound = {
    actionId: "pickup_forage",
    descriptor: {
      sceneTarget: { type: "identity", version: 1, required: true, requiredProperties: ["targetId"] },
    },
  };
  assert.equal(
    lookaheadIneligibility(sceneBound),
    "scene_target",
    "an action that binds to a scene read is not composed from a slightly older one",
  );
  assert.equal(
    lookaheadIneligibility({ actionId: "pickup_forage" }),
    undefined,
    "and without the declaration it is eligible - the rule reads the declaration, not an id list",
  );
  assert.equal(
    lookaheadIneligibility({ actionId: "travel", descriptor: { effect: "write", targetFamily: "warps" } }),
    undefined,
    "a movement leg declares no scene binding, which is the residual this rule names rather than pretends to cover",
  );
});
