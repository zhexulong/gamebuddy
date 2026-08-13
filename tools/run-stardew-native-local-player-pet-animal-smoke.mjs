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

const SCENARIO = "native_pet_animal_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "pet_animal"];
const config = JSON.parse(await readFile(required("--client-config"), "utf8"));
validateNativeLocalConfig(config);
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
  const before = await observeActionable();
  requireExactCapabilities(before);
  const target = chooseOnlyPetTarget(before);
  if (target.friendship !== 0 || target.pettedToday !== false) throw new Error("pet_fixture_starting_state_mismatch");
  const accepted = await execute(target, before);
  if (accepted.state !== "accepted") throw new Error(`pet_animal_not_accepted:${accepted.reasonCode}`);
  const terminal = await terminalForRequest(accepted, 10_000);
  const after = await observeActionable();
  requireExactCapabilities(after);
  const evidence = parseEvidence(terminal.evidence);
  const targetGone = !validTargets(after).some((entry) => entry.targetId === target.targetId);
  const passed =
    terminal.executionId === accepted.executionId &&
    terminal.requestId === accepted.requestId &&
    terminal.state === "succeeded" &&
    terminal.reasonCode === "pet_completed" &&
    targetGone &&
    evidence.location === before.location &&
    evidence.target === target.targetId &&
    evidence.tile === `${target.x},${target.y}` &&
    evidence.pet_day === String(evidence.pet_day) &&
    evidence.friendship_before === "0" &&
    evidence.friendship_after === "12" &&
    evidence.day_recorded === "true" &&
    evidence.friendship_callback === "true";
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "pet_completed" : "pet_animal_postcondition_mismatch",
      target: targetSummary(target),
      receipt: receiptSummary(terminal),
      evidence,
      freshPostcondition: { targetGone },
      after: snapshotSummary(after),
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
      latestReceipt: receiptSummary(client.state.latestReceipt),
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function observeActionable() {
  const snapshot = await client.observe();
  if (!snapshot.actionable || snapshot.activeExecution != null)
    throw new Error("native_local_pet_animal_player_not_actionable");
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.capabilities) ||
    (snapshot.petTargets != null && !Array.isArray(snapshot.petTargets))
  )
    throw new Error("native_local_pet_animal_snapshot_invalid");
  if (snapshot.petTargets == null) snapshot.petTargets = [];
  return snapshot;
}
function requireExactCapabilities(snapshot) {
  if (JSON.stringify([...snapshot.capabilities].sort()) !== JSON.stringify([...EXPECTED_CAPABILITIES].sort()))
    throw new Error(`native_local_pet_animal_capability_not_isolated:${snapshot.capabilities.join(",")}`);
}
function validTargets(snapshot) {
  return snapshot.petTargets.filter(
    (target) =>
      typeof target?.targetId === "string" &&
      /^pet_[a-f0-9]{16}$/.test(target.targetId) &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      typeof target.petType === "string" &&
      target.petType.length > 0 &&
      Number.isInteger(target.friendship) &&
      target.friendship >= 0 &&
      target.friendship <= 1000 &&
      target.pettedToday === false &&
      adjacent(snapshot.tile, target),
  );
}
function chooseOnlyPetTarget(snapshot) {
  const targets = validTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_unpetted_pet_target" : "ambiguous_fresh_unpetted_pet_target");
  return targets[0];
}
async function execute(target, snapshot) {
  const requestId = `native_local_pet_animal_${Date.now()}`;
  return client.execute({
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: "pet_animal",
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
}
async function terminalForRequest(receipt, timeoutMs) {
  if (isTerminal(receipt?.state)) return requireReceiptIdentity(receipt, receipt.executionId, receipt.requestId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const terminal = receipts.find(
      (item) =>
        item?.executionId === receipt?.executionId && item?.requestId === receipt?.requestId && isTerminal(item.state),
    );
    if (terminal) return requireReceiptIdentity(terminal, receipt.executionId, receipt.requestId);
    await delay(100);
  }
  throw new Error(`terminal_timeout:${receipt?.executionId ?? "unknown"}`);
}
function requireReceiptIdentity(receipt, executionId, requestId) {
  if (
    typeof executionId !== "string" ||
    executionId.length === 0 ||
    typeof requestId !== "string" ||
    requestId.length === 0 ||
    receipt?.executionId !== executionId ||
    receipt?.requestId !== requestId
  )
    throw new Error("receipt_identity_mismatch");
  return receipt;
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_pet_animal_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_pet_animal_evidence");
    result[key] = value;
  }
  const expected = [
    "day_recorded",
    "friendship_after",
    "friendship_before",
    "friendship_callback",
    "location",
    "pet_day",
    "target",
    "tile",
  ];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected))
    throw new Error("invalid_pet_animal_evidence");
  return result;
}
function validateNativeLocalConfig(value) {
  const fixture = value.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
    typeof fixture.LogicalSaveName !== "string" ||
    !/^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(fixture.LogicalSaveName) ||
    typeof fixture.ObservedSaveSlot !== "string" ||
    !new RegExp(`^${fixture.LogicalSaveName}_[0-9]{1,32}$`).test(fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (
    value.ActionPolicyVersion !== 0 ||
    JSON.stringify(value.EnabledActions) !== JSON.stringify(["pet_animal"]) ||
    JSON.stringify(value.ExperimentalActions) !== JSON.stringify(["pet_animal"])
  )
    throw new Error("native_local_pet_animal_action_policy_invalid");
  if (
    ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    )
  )
    throw new Error("invalid_client_config");
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function isTerminal(state) {
  return ["succeeded", "failed", "invalidated", "cancelled", "expired", "uncertain", "rejected"].includes(state);
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function required(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}
function targetSummary(target) {
  return target
    ? {
        targetId: target.targetId,
        x: target.x,
        y: target.y,
        petType: target.petType,
        friendship: target.friendship,
        pettedToday: target.pettedToday,
      }
    : null;
}
function receiptSummary(receipt) {
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
function snapshotSummary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    petTargets: snapshot.petTargets?.map(targetSummary) ?? [],
    activeExecution: snapshot.activeExecution ?? null,
  };
}
