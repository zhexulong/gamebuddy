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

const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "move_to_tile",
  "plant_seed",
  "travel",
].sort();
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "plant_seed"];
const EXPECTED_EVIDENCE_KEYS = ["crop", "inventory_after", "inventory_before", "item", "location", "target", "tile"];
const TERMINAL_STATES = new Set([
  "succeeded",
  "failed",
  "invalidated",
  "cancelled",
  "expired",
  "uncertain",
  "rejected",
]);

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing_${name.slice(2)}`);
  return process.argv[index + 1];
}

const config = JSON.parse(await readFile(option("--client-config"), "utf8"));
assertNativeLocalFixtureConfig(config);
const required = ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"];
if (required.some((key) => typeof config[key] !== "string" || config[key].length === 0))
  throw new Error("invalid_client_config");
const scope = {
  integrationId: "stardew",
  saveId: config.SaveId,
  worldId: config.WorldId,
  playerId: config.PlayerId,
  companionId: config.CompanionId,
};
const client = await LocalStardewBridgeClient.connect(scope, config.PipeName, config.BridgeToken);
const receipts = [];
const trace = [];
const startedAt = Date.now();
const unsubscribe = client.onFact((fact) => {
  if (fact.type === "execution_receipt") receipts.push(fact.payload);
});

try {
  let snapshot = await client.observe();
  requireExactCapabilities(client.state.capabilities, "hello");
  requireExactCapabilities(snapshot.capabilities, "snapshot");
  snapshot = await waitForActionable(snapshot, 5_000);
  if (snapshot.location !== "Farm") snapshot = await travelToFarm(snapshot);
  snapshot = await waitForActionable(snapshot, 5_000);
  snapshot = await moveToReachableSeedTarget(snapshot);
  snapshot = await waitForActionable(snapshot, 3_000);
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error("player_not_actionable_before_plant");

  const target = chooseReachableSeedTarget(snapshot);
  if (!target) throw new Error("no_adjacent_live_seed_target");
  const requestId = `native_local_plant_seed_plant_${Date.now()}`;
  const idempotencyKey = `native_local_plant_seed_plant_idem_${Date.now()}`;
  const receipt = await execute(
    "plant",
    "plant_seed",
    {
      slot: target.slot,
      x: target.x,
      y: target.y,
      expectedQualifiedItemId: target.qualifiedItemId,
      expectedTargetId: target.targetId,
    },
    snapshot,
    requestId,
    idempotencyKey,
  );
  const terminal = await requireExactTerminalReceipt(receipt, requestId, "plant");
  const evidence = parseEvidence(terminal.evidence);
  const after = await waitForPlantPostcondition(terminal, target, evidence, snapshot, 5_000);
  const sourceDisappeared =
    Array.isArray(after.seedTargets) &&
    after.seedTargets.every(
      (entry) => entry.targetId !== target.targetId && (entry.x !== target.x || entry.y !== target.y),
    );
  const inventoryDeltaProven =
    Number.isSafeInteger(Number(evidence.inventory_before)) &&
    Number.isSafeInteger(Number(evidence.inventory_after)) &&
    Number(evidence.inventory_after) === Number(evidence.inventory_before) - 1;
  const evidenceBound =
    evidence.location === snapshot.location &&
    evidence.target === target.targetId &&
    evidence.tile === `${target.x},${target.y}` &&
    evidence.item === target.qualifiedItemId &&
    typeof evidence.crop === "string" &&
    evidence.crop.length > 0 &&
    evidence.crop !== "none";
  const freshPostcondition =
    Number.isInteger(after.revision) &&
    after.revision === terminal.revision &&
    after.location === snapshot.location &&
    sameTile(after.tile, snapshot.tile) &&
    after.actionable === true &&
    after.activeExecution == null &&
    sourceDisappeared;
  const passed =
    terminal.state === "succeeded" &&
    terminal.reasonCode === "seed_planted" &&
    evidenceBound &&
    inventoryDeltaProven &&
    freshPostcondition;
  console.log(
    JSON.stringify({
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "seed_planted" : terminal.reasonCode,
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      sourceDisappeared,
      inventoryDeltaProven,
      freshPostcondition,
      trace,
      before: summarize(snapshot),
      after: summarize(after),
      durationMs: Date.now() - startedAt,
    }),
  );
  if (!passed) process.exitCode = 2;
} catch (error) {
  console.error(
    JSON.stringify({
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state.latestReceipt),
      trace,
    }),
  );
  process.exitCode = 2;
} finally {
  unsubscribe();
  client.close();
}

async function execute(
  phase,
  action,
  args,
  snapshot,
  requestId = `native_local_plant_seed_${phase}_${Date.now()}`,
  idempotencyKey = `native_local_plant_seed_${phase}_idem_${Date.now()}`,
) {
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const receipt = await client.execute({
    requestId,
    idempotencyKey,
    action,
    args,
    expectedRevision: snapshot.revision,
    deadlineMs: Date.now() + 30_000,
  });
  if (
    !receipts.some(
      (entry) =>
        entry.executionId === receipt.executionId &&
        entry.requestId === receipt.requestId &&
        entry.state === receipt.state,
    )
  )
    receipts.push(receipt);
  trace.push({ phase, requestId, idempotencyKey, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}
async function travelToFarm(snapshot) {
  const warp = snapshot.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(snapshot, { x: warp.sourceX, y: warp.sourceY }, "move_to_farm_warp");
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(
    accepted.executionId,
    accepted.requestId,
    (latest) => latest.location === "Farm" && latest.activeExecution == null,
    15_000,
  );
}
async function move(snapshot, target, phase) {
  snapshot = await waitForActionable(snapshot, 10_000);
  if (!snapshot.actionable || snapshot.activeExecution != null) throw new Error(`${phase}_player_not_actionable`);
  const accepted = await execute(phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  return waitForReceiptAndSnapshot(
    accepted.executionId,
    accepted.requestId,
    (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
    55_000,
  );
}
async function moveToReachableSeedTarget(snapshot) {
  if (chooseReachableSeedTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius)
          candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
    for (const waypoint of candidates) {
      try {
        const moved = await move(snapshot, waypoint, "move_to_native_plant_seed_fixture");
        if (chooseReachableSeedTarget(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
          throw error;
        snapshot = await client.observe();
        if (chooseReachableSeedTarget(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_plant_seed_fixture_target");
}
function chooseReachableSeedTarget(snapshot) {
  return (
    snapshot.seedTargets?.find(
      (target) =>
        Number.isInteger(target.slot) &&
        Number.isInteger(target.x) &&
        Number.isInteger(target.y) &&
        typeof target.targetId === "string" &&
        target.targetId.length > 0 &&
        typeof target.qualifiedItemId === "string" &&
        target.qualifiedItemId.length > 0 &&
        adjacent(snapshot.tile, target),
    ) ?? null
  );
}
async function waitForActionable(snapshot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = snapshot;
  while (Date.now() < deadline) {
    if (latest.actionable && latest.activeExecution == null) return latest;
    await delay(250);
    latest = await client.observe();
  }
  return latest;
}
async function waitForReceiptAndSnapshot(executionId, requestId, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    const terminal = findTerminalReceipt(executionId, requestId);
    if (terminal && terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
    if (terminal?.state === "succeeded" && predicate(latest)) return latest;
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`navigation_timeout:${executionId}`);
}
async function waitForPlantPostcondition(receipt, target, evidence, before, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = await client.observe();
  while (Date.now() < deadline) {
    // cropTargets is a capability-gated water_crop input collection, not a
    // generic crop-result projection. This isolated plant-only profile must
    // not enable water_crop merely to observe the planted crop. Same-execution
    // production evidence binds crop creation; fresh state proves the exact
    // seed source is no longer actionable.
    const fresh =
      Number.isInteger(latest.revision) &&
      latest.revision === receipt.revision &&
      latest.location === before.location &&
      sameTile(latest.tile, before.tile) &&
      latest.actionable === true &&
      latest.activeExecution == null &&
      Array.isArray(latest.seedTargets) &&
      latest.seedTargets.every(
        (entry) => entry.targetId !== target.targetId && (entry.x !== target.x || entry.y !== target.y),
      );
    if (fresh) return latest;
    await delay(200);
    latest = await client.observe();
  }
  throw new Error(`plant_postcondition_timeout:${receipt.executionId}`);
}
function findTerminalReceipt(executionId, requestId) {
  return receipts.find(
    (receipt) =>
      receipt.executionId === executionId && receipt.requestId === requestId && TERMINAL_STATES.has(receipt.state),
  );
}
async function requireExactTerminalReceipt(receipt, requestId, phase) {
  if (typeof receipt?.executionId !== "string" || receipt.executionId.length === 0 || receipt.requestId !== requestId)
    throw new Error(`${phase}_receipt_identity_mismatch`);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const terminal = findTerminalReceipt(receipt.executionId, requestId);
    if (terminal && terminal.executionId === receipt.executionId && terminal.requestId === requestId) return terminal;
    await delay(100);
  }
  throw new Error(`${phase}_terminal_receipt_missing`);
}
function requireExactCapabilities(actual, source) {
  if (!Array.isArray(actual) || JSON.stringify([...actual].sort()) !== JSON.stringify(EXPECTED_CAPABILITIES))
    throw new Error(`native_local_plant_seed_${source}_capability_not_isolated`);
}
function assertNativeLocalFixtureConfig(value) {
  const fixture = value.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== "native_plant_seed_v1" ||
    !validFixtureSlotRelationship(fixture.LogicalSaveName, fixture.ObservedSaveSlot)
  )
    throw new Error("native_local_fixture_config_invalid");
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true
  )
    throw new Error("native_local_fixture_topology_not_isolated");
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS))
    throw new Error("native_local_fixture_action_policy_invalid");
}
function validFixtureSlotRelationship(logicalName, observedSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSlot)
  );
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    const key = index > 0 ? part.slice(0, index) : "";
    const value = index > 0 ? part.slice(index + 1) : "";
    if (
      index <= 0 ||
      index === part.length - 1 ||
      !/^[a-z][a-z0-9_]{0,63}$/.test(key) ||
      value.length > 512 ||
      Object.hasOwn(result, key)
    )
      throw new Error("invalid_plant_seed_evidence");
    result[key] = value;
  }
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(EXPECTED_EVIDENCE_KEYS))
    throw new Error("plant_seed_evidence_keys_mismatch");
  return result;
}
function sameTile(left, right) {
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    left.x === right.x &&
    left.y === right.y
  );
}
function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}
function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    seedTargets: snapshot.seedTargets?.length ?? 0,
    activeExecution: snapshot.activeExecution ?? null,
  };
}
function summarizeReceipt(receipt) {
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
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
