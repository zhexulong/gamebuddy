// Stardew-local bait_crab_pot smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about baiting one owned pot.
//
// The receipt is not the proof. The pot's own published rows are: after the call the advertised BAITABLE target must
// be gone, and the RESULT projection must name the same opaque target carrying the bait the receipt says it used,
// the pot item, the slot and the owner. A receipt that reports `bait_after` while the result projection is silent is
// a bait nobody can see.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "bait_crab_pot";
/** The action's own success word (`ExecuteBaitCrabPot`: the pot took the bait and its row was reprojected). */
const SUCCESS_CODE = "crab_pot_baited";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_bait_crab_pot_v1`). */
const FIXTURE_SCENARIO = "native_bait_crab_pot_v1";
const BAIT_QUALIFIED_ITEM_ID = "(O)685";
const POT_QUALIFIED_ITEM_ID = "(O)710";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", ACTION];

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  requiredActions: [ACTION],
  experimentalActions: [ACTION],
  projection: { collections: ["baitCrabPotTargets", "baitCrabPotResultTargets"] },

  /** The one adjacent unbaited pot the fixture staged, with exactly one Bait for it. */
  prepare: ({ snapshot }) => ({ snapshot, plan: { target: chooseAdjacentUnbaitedPot(snapshot) } }),

  describePlan: ({ target }) => ({
    target: target.targetId,
    tile: `${target.x},${target.y}`,
    slot: target.slot,
    bait: target.baitQualifiedItemId,
    baitStack: target.baitStack,
  }),

  request: ({ target }) => ({
    args: {
      slot: target.slot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: BAIT_QUALIFIED_ITEM_ID,
      expectedTargetId: target.targetId,
    },
  }),

  /**
   * The negative case, declared to the template: the single Bait was spent and the pot now carries it, so the same
   * request names a target the projection no longer offers (`bait_crab_pot_target_unavailable`) or a slot that no
   * longer holds the bait (`bait_not_owned_in_slot`). Both words are the Mod's
   * (`FarmhandExecutionController.FarmingConstructionActions`).
   */
  negative: {
    args: ({ target }) => ({
      slot: target.slot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: BAIT_QUALIFIED_ITEM_ID,
      expectedTargetId: target.targetId,
    }),
    refusedCodes: ["bait_crab_pot_target_unavailable", "bait_not_owned_in_slot"],
    unchanged: ({ before, after }) => {
      const bailable = (snapshot) =>
        (snapshot.baitCrabPotTargets ?? []).map((entry) => `${entry?.targetId}@${entry?.x},${entry?.y}`).join("|");
      if (bailable(before) !== bailable(after)) return `baitCrabPotTargets:${bailable(before)}->${bailable(after)}`;
      const results = (snapshot) =>
        (snapshot.baitCrabPotResultTargets ?? [])
          .map((entry) => `${entry?.targetId}:${entry?.baitQualifiedItemId}:${entry?.baitStack}`)
          .join("|");
      return results(before) === results(after)
        ? null
        : `baitCrabPotResultTargets:${results(before)}->${results(after)}`;
    },
  },

  /**
   * The receipt's fields against the two published rows.
   *
   * The result row is the point: it is what a later `crab_pot_collect_output` and the pot's own menu read, so a bait
   * only the receipt knows about is a bait nobody can use.
   */
  async assertPostcondition({ evidence, plan, after }) {
    const { target } = plan;
    if (!Array.isArray(after.baitCrabPotTargets)) throw new Error("bait_crab_pot_targets_not_published");
    if (!Array.isArray(after.baitCrabPotResultTargets)) throw new Error("bait_crab_pot_result_targets_not_published");
    const result = after.baitCrabPotResultTargets.find((entry) => entry?.targetId === target.targetId);

    const failures = [];
    const check = (name, ok) => {
      if (!ok) failures.push(name);
    };
    check("bait_matches_evidence", evidence.source === BAIT_QUALIFIED_ITEM_ID);
    check("pot_matches_evidence", evidence.pot === POT_QUALIFIED_ITEM_ID);
    check("pot_was_unbaited", evidence.bait_before === "none");
    check("pot_now_baited", evidence.bait_after === BAIT_QUALIFIED_ITEM_ID);
    check("tile_matches_request", Number(evidence.x) === target.x && Number(evidence.y) === target.y);
    check("target_matches_request", evidence.target === target.targetId);
    check("slot_matches_request", Number(evidence.slot) === target.slot);
    check("one_bait_carried_before", Number(evidence.inventory_before) === 1);
    check("bait_consumed", Number(evidence.inventory_after) === 0);
    check("owner_matches_request", evidence.owner === target.ownerId);
    check("result_row_published", result !== undefined);
    check("result_names_the_same_tile", result?.x === target.x && result?.y === target.y);
    check("result_names_the_same_slot", result?.slot === target.slot);
    check("result_names_the_pot", result?.qualifiedItemId === POT_QUALIFIED_ITEM_ID);
    check("result_names_the_bait", result?.baitQualifiedItemId === BAIT_QUALIFIED_ITEM_ID);
    check("result_names_the_owner", result?.ownerId === target.ownerId);
    check("result_names_the_stack", result?.baitStack === 1);
    check("baitable_target_gone", !after.baitCrabPotTargets.some((entry) => entry?.targetId === target.targetId));

    if (failures.length > 0)
      throw new Error(`bait_crab_pot live contract failed: ${failures.join(",")};evidence=${JSON.stringify(evidence)}`);

    return { target, evidence, result, after: { baitCrabPotTargets: after.baitCrabPotTargets.length } };
  },
});

export const runBaitCrabPotSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

/** The one adjacent unbaited pot that is exactly a Bait away from being baited. */
function chooseAdjacentUnbaitedPot(snapshot) {
  const target = (snapshot.baitCrabPotTargets ?? []).find(
    (entry) =>
      entry !== undefined &&
      Math.abs(entry.x - snapshot.tile.x) <= 1 &&
      Math.abs(entry.y - snapshot.tile.y) <= 1 &&
      entry.baitQualifiedItemId === BAIT_QUALIFIED_ITEM_ID &&
      entry.qualifiedItemId === POT_QUALIFIED_ITEM_ID &&
      entry.baitStack === 1,
  );
  if (target === undefined) throw new Error("no_adjacent_unbaited_crab_pot_target");
  return target;
}
