import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_collect_animal_product_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "collect_animal_product", "inspect_self"];

/** Execute the collect-animal-product contract against an already-connected bridge session. */
export async function runCollectAnimalProductSmoke(
  client,
  receipts,
  config,
  { terminalTimeoutMs = 40_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const startedAt = Date.now();
  validateConfig(config);
  try {
    const before = await observeFresh(client, { actionable: true });
    assertExactCapabilities(before, EXPECTED_CAPABILITIES);
    const target = chooseTarget(before);
    const inventoryBefore = countQualifiedInventory(before, target.qualifiedProduceItemId);
    const requestId = `native_local_collect_animal_product_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: "collect_animal_product",
      args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: before,
      timeoutMs: 30_000,
    });
    if (accepted.state !== "accepted")
      throw new Error(`collect_animal_product_not_accepted:${accepted.state}:${accepted.reasonCode}`);
    const receipt = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const after = await waitForFreshSnapshot(client, {
      minRevision: receipt.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (snapshot) => Array.isArray(snapshot.animalProductTargets) && Array.isArray(snapshot.inventoryItemFacts),
    });
    const evidence = parseEvidence(receipt.evidence);
    const targetGone = !(after.animalProductTargets ?? []).some((entry) => entry.targetId === target.targetId);
    const inventoryAfter = countQualifiedInventory(after, target.qualifiedProduceItemId);
    const inventoryGainedFresh = inventoryAfter >= inventoryBefore + target.produceStack;
    const passed =
      receipt.state === "succeeded" &&
      receipt.reasonCode === "animal_product_collected" &&
      after.revision >= receipt.revision &&
      evidence.target === target.targetId &&
      evidence.produce === target.qualifiedProduceItemId &&
      evidence.tool === target.toolKind &&
      evidence.produce_stack === String(target.produceStack) &&
      evidence.produce_cleared === "true" &&
      evidence.inventory_gained === "true" &&
      evidence.animation_complete === "true" &&
      targetGone &&
      inventoryGainedFresh;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "animal_product_collected" : "collect_animal_product_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(receipt),
      evidence,
      inventory: {
        qualifiedItemId: target.qualifiedProduceItemId,
        before: inventoryBefore,
        after: inventoryAfter,
        expectedDelta: target.produceStack,
        freshDeltaSatisfied: inventoryGainedFresh,
      },
      before: summary(before),
      after: summary(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runCollectAnimalProductSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, ["collect_animal_product"])
  )
    throw new Error("native_local_collect_animal_product_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_collect_animal_product_topology_invalid");
}
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
  // SetupBigFarm can lawfully expose several independent ready animals. Pick
  // one fresh opaque target deterministically; never synthesize or replace it.
  targets.sort((left, right) => left.y - right.y || left.x - right.x || left.targetId.localeCompare(right.targetId));
  return targets[0];
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail.split(";").flatMap((part) => {
      const index = part.indexOf("=");
      return index > 0 ? [[part.slice(0, index), part.slice(index + 1)]] : [];
    }),
  );
}
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function validId(value) {
  return typeof value === "string" && value.length > 0;
}
function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function summary(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    animalProductTargets: snapshot.animalProductTargets?.length ?? 0,
    inventoryItemFacts: snapshot.inventoryItemFacts?.length ?? 0,
  };
}
