/**
 * One node's outcome, said once: the state, and the reason the Mod recorded for it.
 *
 * The measured defect (2026-11-08): a bundle's 154 node outcomes were `{ nodeId, state }` and nothing else, so 31
 * `recovery_required` and 9 `failed` nodes were unresearchable while the same run's settlement digest named the action,
 * the reason and the tile for each of them. These cases pin the projection's own rules at the seam where both artifacts
 * read: the reason comes from the Mod's rows (never invented), and the action and tile come from the candidate the Host
 * submitted, joined on `nodeId`.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { programNodeOutcomes } from "./program-node-outcomes.mjs";

/** The candidate's node, in the wire shape `program_submit` carries: an action id and typed runtime arguments. */
function compiledNode(nodeId, actionId, args = {}) {
  return { nodeId, actionId, arguments: args };
}

/** A status snapshot's node row, in the wire shape `BodyProgramNodeStatus` carries. */
function statusRow(nodeId, state, extra = {}) {
  return { nodeId, state, nodeAttempt: 1, admissionAttempt: 1, ...extra };
}

test("a rejected node carries the veto the Mod recorded, the action it named and the tile it acted on", () => {
  const rows = programNodeOutcomes(
    [
      compiledNode("n01", "till_soil", {
        x: { type: "integer", canonicalValue: "12" },
        y: { type: "integer", canonicalValue: "8" },
      }),
    ],
    [statusRow("n01", "rejected", { rejectionCode: "actor_held_by_modal" })],
  );
  assert.deepEqual(rows, [
    {
      nodeId: "n01",
      actionId: "till_soil",
      state: "rejected",
      reasonCode: "actor_held_by_modal",
      tile: { x: 12, y: 8 },
    },
  ]);
});

test("a dispatched failure carries its own code and the hint beside it, and a success explains nothing", () => {
  const rows = programNodeOutcomes(
    [compiledNode("n01", "harvest_crop"), compiledNode("n02", "water_crop")],
    [
      statusRow("n01", "failed", { failureCode: "no_native_path", hint: "closest=49,14" }),
      statusRow("n02", "succeeded"),
    ],
  );
  assert.deepEqual(rows, [
    {
      nodeId: "n01",
      actionId: "harvest_crop",
      state: "failed",
      reasonCode: "no_native_path",
      hint: "closest=49,14",
    },
    { nodeId: "n02", actionId: "water_crop", state: "succeeded" },
  ]);
});

test("a node the journal does not list reads unknown, and no reason is invented for it", () => {
  // The falsifier for the whole projection: `recovery_required` is a state the Mod's own persistence FORBIDS a reason
  // code on (`BodyProgramJournalPersistence.cs:241`), and a node the journal never reached has no row at all. Both must
  // come out as a state with NO `reasonCode` key - absent, not null and not a placeholder - so "the Mod did not say" and
  // "the Mod said this" cannot be read as the same fact.
  const rows = programNodeOutcomes(
    [compiledNode("n01", "plant_seed"), compiledNode("n02", "till_soil")],
    [statusRow("n01", "recovery_required")],
  );
  assert.deepEqual(rows, [
    { nodeId: "n01", actionId: "plant_seed", state: "recovery_required" },
    { nodeId: "n02", actionId: "till_soil", state: "unknown" },
  ]);
  for (const row of rows) assert.equal(Object.hasOwn(row, "reasonCode"), false);
});

test("a node with no integer tile, no action id and no candidate at all is reported as it is, not guessed", () => {
  // Three absences, each its own answer: `seed` names arguments that are not a tile, a candidate node may name no
  // action, and a program whose candidate was not recorded contributes no row rather than a fabricated one.
  const rows = programNodeOutcomes(
    [
      compiledNode("n01", "plant_seed", {
        seedItemId: { type: "string", canonicalValue: "(O)472" },
        x: { type: "string", canonicalValue: "12" },
      }),
      { nodeId: "n02", arguments: {} },
    ],
    [statusRow("n01", "succeeded"), statusRow("n02", "cancelled")],
  );
  assert.deepEqual(rows, [
    { nodeId: "n01", actionId: "plant_seed", state: "succeeded" },
    { nodeId: "n02", actionId: null, state: "cancelled" },
  ]);
  assert.deepEqual(programNodeOutcomes([], [statusRow("n01", "succeeded")]), []);
});

test("the journal row's own state name wins over the position, so a reordered snapshot cannot misattribute", () => {
  // The join is `nodeId` on both sides: the candidate's order is the population's order, and the Mod's rows may arrive
  // in any order at all. A projection that read the two lists by position would hand n02's reason to n01.
  const rows = programNodeOutcomes(
    [compiledNode("n01", "till_soil"), compiledNode("n02", "plant_seed")],
    [statusRow("n02", "rejected", { rejectionCode: "policy_denied" }), statusRow("n01", "succeeded")],
  );
  assert.deepEqual(rows, [
    { nodeId: "n01", actionId: "till_soil", state: "succeeded" },
    { nodeId: "n02", actionId: "plant_seed", state: "rejected", reasonCode: "policy_denied" },
  ]);
});
