import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveProductionEntry } from "../host/scripts/production-artifact.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../host");
const productionArtifact = await resolveProductionEntry({
  hostRoot,
  outputRoot: resolve(hostRoot, "dist"),
  entry: "main.js",
});
const { LocalStardewBridgeClient } = await import(
  pathToFileURL(resolve(productionArtifact.artifactRoot, "local-stardew-bridge.js")).href
);

const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateConfig(config);
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  const before = await actionableSnapshot();
  requireCapabilities(before);
  const target = chooseTarget(before);
  const inventoryBefore = countQualifiedInventory(before, target.qualifiedProduceItemId);
  const requestId = `native_local_collect_animal_product_${Date.now()}`;
  const accepted = await client.execute({
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: "collect_animal_product",
    args: { slot: target.slot, x: target.x, y: target.y, expectedTargetId: target.targetId },
    expectedRevision: before.revision,
    deadlineMs: Date.now() + 30_000,
  });
  if (accepted.state !== "accepted" || accepted.requestId !== requestId || !validId(accepted.executionId)) {
    throw new Error(`collect_animal_product_not_accepted:${accepted.state}:${accepted.reasonCode}`);
  }
  const receipt = await waitForTerminal(accepted, 40_000);
  const after = await actionableSnapshot();
  const evidence = parseEvidence(receipt.evidence);
  const targetGone = !(after.animalProductTargets ?? []).some((entry) => entry.targetId === target.targetId);
  const inventoryAfter = countQualifiedInventory(after, target.qualifiedProduceItemId);
  const inventoryGainedFresh = inventoryAfter >= inventoryBefore + target.produceStack;
  const passed =
    receipt.state === "succeeded" &&
    receipt.reasonCode === "animal_product_collected" &&
    evidence.target === target.targetId &&
    evidence.produce === target.qualifiedProduceItemId &&
    evidence.tool === target.toolKind &&
    evidence.produce_stack === String(target.produceStack) &&
    evidence.produce_cleared === "true" &&
    evidence.inventory_gained === "true" &&
    evidence.animation_complete === "true" &&
    targetGone &&
    inventoryGainedFresh;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "animal_product_collected" : "collect_animal_product_postcondition_mismatch",
      target,
      receipt: summaryReceipt(receipt),
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
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summaryReceipt(client.state.latestReceipt),
      durationMs: Date.now() - startedAt,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

function validateConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== "native_collect_animal_product_v1" ||
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
function requireCapabilities(snapshot) {
  if (
    !same(
      [...(snapshot.capabilities ?? [])].sort(),
      ["cancel_active_execution", "collect_animal_product", "inspect_self"].sort(),
    )
  )
    throw new Error("native_local_collect_animal_product_capability_not_isolated");
}
async function actionableSnapshot() {
  const snapshot = await client.observe();
  if (!snapshot.actionable || snapshot.activeExecution != null || !Number.isInteger(snapshot.revision))
    throw new Error("native_local_collect_animal_product_snapshot_not_actionable");
  return snapshot;
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
async function waitForTerminal(accepted, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = receipts.find(
      (entry) =>
        entry.executionId === accepted.executionId && entry.requestId === accepted.requestId && terminal(entry.state),
    );
    if (receipt) return receipt;
    await delay(100);
  }
  throw new Error(`collect_animal_product_terminal_timeout:${accepted.executionId}`);
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
function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
function terminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function validId(value) {
  return typeof value === "string" && value.length > 0;
}
function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function summary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    activeExecution: snapshot.activeExecution ?? null,
    animalProductTargets: snapshot.animalProductTargets?.length ?? 0,
    inventoryItemFacts: snapshot.inventoryItemFacts?.length ?? 0,
  };
}
function summaryReceipt(receipt) {
  return receipt
    ? {
        executionId: receipt.executionId,
        requestId: receipt.requestId,
        state: receipt.state,
        reasonCode: receipt.reasonCode,
        revision: receipt.revision,
        evidence: receipt.evidence ?? null,
      }
    : null;
}
