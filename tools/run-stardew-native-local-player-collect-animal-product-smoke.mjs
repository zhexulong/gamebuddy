// Stardew-local collect_animal_product smoke.
//
// The lifecycle - the fixture-config refusal, observe-fresh and the capability check, the requestId mint and the
// execute, the terminal wait and its identity, the evidence parse and the stale reread, the stale re-send, the
// bootstrap and the exit code - is `tools/lib/native-local-runner-scaffold.mjs`. What is left here is what is
// actually about milking or shearing one animal: which advertised target to take, what the receipt must say about
// it, and what the pack and the projection must look like afterwards.

import { defineSmokeScenario, runSmokeScenarioMain } from "./lib/native-local-runner-scaffold.mjs";

const ACTION = "collect_animal_product";
/** The action's own success word (`MachineActions.CollectAnimalProduct`: the animation finished and the produce moved). */
const SUCCESS_CODE = "animal_product_collected";
/** The one `NativeLocalPlayerFixture.FixtureScenario` this gate arms (gate descriptor `native_collect_animal_product_v1`). */
const FIXTURE_SCENARIO = "native_collect_animal_product_v1";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", ACTION, "inspect_self"];

const scenario = defineSmokeScenario({
  action: ACTION,
  fixtureScenario: FIXTURE_SCENARIO,
  successCode: SUCCESS_CODE,
  refusesConfig: true,
  requiredCapabilities: REQUIRED_CAPABILITIES,
  requiredActions: [ACTION],
  experimentalActions: [ACTION],
  projection: { collections: ["animalProductTargets", "inventoryItemFacts"] },

  /** The ready animal the fixture staged, and the pack's own count of its produce before the collect. */
  prepare: ({ snapshot }) => {
    const target = chooseTarget(snapshot);
    return {
      snapshot,
      plan: { target, inventoryBefore: countQualifiedInventory(snapshot, target.qualifiedProduceItemId) },
    };
  },

  describePlan: ({ target, inventoryBefore }) => ({
    target: target.targetId,
    tile: `${target.x},${target.y}`,
    produce: target.qualifiedProduceItemId,
    tool: target.toolKind,
    produceStack: target.produceStack,
    inventoryBefore,
  }),

  request: ({ target }) => ({
    args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
  }),

  /**
   * The negative case, declared to the template: the collect cleared the animal's produce, so the same target must be
   * refused (`animal_product_target_gone`, or `animal_product_target_changed` if the animal re-grew produce inside the
   * same run) and neither the projection nor the pack may move. Both words are the Mod's
   * (`FarmhandExecutionController.MachineActions`).
   */
  negative: {
    args: ({ target }) => ({ slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId }),
    refusedCodes: ["animal_product_target_gone", "animal_product_target_changed"],
    unchanged: ({ before, after }) => {
      const targets = (snapshot) =>
        (snapshot.animalProductTargets ?? []).map((entry) => `${entry?.targetId}@${entry?.x},${entry?.y}`).join("|");
      if (targets(before) !== targets(after)) return `animalProductTargets:${targets(before)}->${targets(after)}`;
      const pack = (snapshot) =>
        (snapshot.inventoryItemFacts ?? [])
          .map((entry) => `${entry?.slot}:${entry?.qualifiedItemId}:${entry?.stack}`)
          .sort()
          .join("|");
      return pack(before) === pack(after) ? null : `inventory:${pack(before)}->${pack(after)}`;
    },
  },

  /**
   * The receipt's fields against the world: the named animal left the projection, and the pack's own count of the
   * produce it names rose by exactly the stack it names. The pack read is the assertion the receipt cannot make for
   * itself - `inventory_gained=true` is the Mod's claim, and the count is the measurement.
   */
  async assertPostcondition({ evidence, plan, after }) {
    const { target, inventoryBefore } = plan;
    const failures = [];
    const check = (name, ok) => {
      if (!ok) failures.push(name);
    };
    check("receipt_names_the_target", evidence.target === target.targetId);
    check("receipt_names_the_produce", evidence.produce === target.qualifiedProduceItemId);
    check("receipt_names_the_tool", evidence.tool === target.toolKind);
    check("receipt_names_the_stack", evidence.produce_stack === String(target.produceStack));
    check("produce_cleared", evidence.produce_cleared === "true");
    check("inventory_gained", evidence.inventory_gained === "true");
    check("animation_complete", evidence.animation_complete === "true");

    if (!Array.isArray(after.animalProductTargets))
      throw new Error("native_local_collect_animal_product_targets_missing");
    if (!Array.isArray(after.inventoryItemFacts))
      throw new Error("native_local_collect_animal_product_inventory_facts_missing");
    const targetGone = !after.animalProductTargets.some((entry) => entry.targetId === target.targetId);
    if (!targetGone) failures.push(`target_still_advertised:${target.targetId}`);
    const inventoryAfter = countQualifiedInventory(after, target.qualifiedProduceItemId);
    if (inventoryAfter < inventoryBefore + target.produceStack)
      failures.push(`inventory_did_not_gain:${inventoryBefore}->${inventoryAfter}`);

    if (failures.length > 0) throw new Error(`collect_animal_product live contract failed: ${failures.join(",")}`);

    return {
      target,
      evidence,
      inventory: {
        qualifiedItemId: target.qualifiedProduceItemId,
        before: inventoryBefore,
        after: inventoryAfter,
        expectedDelta: target.produceStack,
        freshDeltaSatisfied: true,
      },
      after: {
        animalProductTargets: after.animalProductTargets.length,
        inventoryItemFacts: after.inventoryItemFacts.length,
      },
    };
  },
});

export const runCollectAnimalProductSmoke = (client, receipts, config, options) =>
  scenario.run(client, receipts, config, options);

if (import.meta.main) await runSmokeScenarioMain(scenario);

function countQualifiedInventory(snapshot, qualifiedItemId) {
  const facts = snapshot.inventoryItemFacts;
  if (!Array.isArray(facts)) throw new Error("native_local_collect_animal_product_inventory_facts_missing");
  return facts
    .filter((entry) => entry?.qualifiedItemId === qualifiedItemId && Number.isInteger(entry.stack) && entry.stack > 0)
    .reduce((total, entry) => total + entry.stack, 0);
}

function chooseTarget(snapshot) {
  const targets = (snapshot.animalProductTargets ?? []).filter(
    (entry) =>
      validId(entry?.targetId) &&
      Number.isInteger(entry.slot) &&
      validTile(entry.x) &&
      validTile(entry.y) &&
      typeof entry.qualifiedProduceItemId === "string" &&
      (entry.toolKind === "milk_pail" || entry.toolKind === "shears") &&
      (entry.produceStack === 1 || entry.produceStack === 2),
  );
  if (targets.length === 0) throw new Error("no_live_animal_product_target");
  // SetupBigFarm can lawfully expose several independent ready animals. Pick one fresh opaque target
  // deterministically; never synthesize or replace it.
  targets.sort((left, right) => left.y - right.y || left.x - right.x || left.targetId.localeCompare(right.targetId));
  return targets[0];
}

function validId(value) {
  return typeof value === "string" && value.length > 0;
}

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
