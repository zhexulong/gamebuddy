import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
  validateNativeLocalFixturePolicy,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "water_pet_bowl";
const SCENARIO = "native_water_pet_bowl_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "water_pet_bowl"];
const REQUIRED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
  "water_pet_bowl",
].sort();

/**
 * Execute the water-pet-bowl contract against an already-connected bridge session.
 *
 * The fixture establishes only the declared Given: a completed native Pet Bowl on
 * the Farm, one charged Watering Can, and the actor on a lawful adjacent tile. This
 * runner independently re-derives the opaque bowl target from the fresh production
 * snapshot, equips/moves only through typed production actions, and requires the
 * native postcondition (`PetBowl.watered` false -> true) plus a fresh reread before
 * it reports success. It never writes bowl state and never manufactures a receipt.
 */
export async function runWaterPetBowlSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalConfig(config);
  try {
    let snapshot = await observeActionable(client);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);

    const wateringCan = chooseWateringCan(snapshot);
    if (snapshot.currentTool !== wateringCan.label) {
      const equipped = await execute(client, trace, "equip_watering_can", "equip_tool", { tool: "watering_can" }, snapshot);
      const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
      if (
        equipTerminal.state !== "succeeded" ||
        (equipTerminal.reasonCode !== "tool_equipped" && equipTerminal.reasonCode !== "already_equipped")
      )
        throw new Error(`watering_can_equip_failed:${equipTerminal.reasonCode}`);
      const equipEvidence = parseEvidence(equipTerminal.evidence, ["after", "before", "expected", "tool"]);
      if (equipEvidence.expected !== wateringCan.label || equipEvidence.after !== wateringCan.label)
        throw new Error("watering_can_equip_evidence_mismatch");
      snapshot = await observeActionable(client);
      if (snapshot.currentTool !== wateringCan.label) throw new Error("watering_can_postcondition_missing");
      if (snapshot.location !== "Farm")
        snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    }

    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    snapshot = await moveToReachableBowl(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 3_000);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error("player_not_actionable_before_water_pet_bowl");

    const target = chooseOnlyReachableBowl(snapshot);
    const bowlTargetCountBefore = validBowlTargets(snapshot).length;
    if (bowlTargetCountBefore !== 1)
      throw new Error(`native_local_water_pet_bowl_fixture_target_count_before:${bowlTargetCountBefore}`);
    const accepted = await execute(
      client,
      trace,
      "water",
      ACTION,
      { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEvidence(terminal.evidence, [
      "after_watered",
      "before_watered",
      "expected_stamina_cost",
      "location",
      "native_menu_opened",
      "stamina_after",
      "stamina_before",
      "stamina_delta",
      "target",
      "tile",
      "water_after",
      "water_before",
      "water_consumed",
    ]);
    const after = await waitForStableRevision(client, {
      revision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) =>
        latest.actionable === true &&
        latest.activeExecution == null &&
        latest.location === snapshot.location &&
        sameTile(latest.tile, snapshot.tile) &&
        validBowlTargets(latest).every((entry) => entry.targetId !== target.targetId),
    });
    const sourceTargetGone = validBowlTargets(after).every((entry) => entry.targetId !== target.targetId);
    const waterBefore = Number(evidence.water_before);
    const waterAfter = Number(evidence.water_after);
    const preciseWaterDelta =
      Number.isSafeInteger(waterBefore) &&
      Number.isSafeInteger(waterAfter) &&
      waterBefore > 0 &&
      waterAfter === waterBefore - 1 &&
      evidence.water_consumed === "true";
    const evidenceBound =
      evidence.location === snapshot.location &&
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.before_watered === "false" &&
      evidence.after_watered === "true";
    const freshPostcondition =
      after.revision === terminal.revision &&
      after.actionable === true &&
      after.activeExecution == null &&
      after.location === snapshot.location &&
      sameTile(after.tile, snapshot.tile) &&
      sourceTargetGone;
    const passed =
      terminal.state === "succeeded" &&
      terminal.reasonCode === "pet_bowl_watered" &&
      evidence.native_menu_opened === "false" &&
      evidenceBound &&
      preciseWaterDelta &&
      freshPostcondition;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "pet_bowl_watered" : "water_pet_bowl_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      preciseWaterDelta,
      bowlTargetCountBefore,
      sourceTargetGone,
      freshPostcondition,
      trace,
      before: summarize(snapshot),
      after: summarize(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
      durationMs: Date.now() - startedAt,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  // This action is newer than the immutable production generation, so the live
  // client must come from the compiled test artifact that carries its protocol
  // fields. A published action whose wire shape already exists in production
  // does not need this.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runWaterPetBowlSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_water_pet_bowl_${phase}_${nonce}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, requestId, receipt: summarizeReceipt(receipt) });
  return receipt;
}

async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const warp = fresh.warps?.find((entry) => entry.targetLocation === "Farm");
  if (!warp) throw new Error("farm_warp_missing");
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await move(
      client,
      receipts,
      fresh,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      trace,
      stabilizeTimeoutMs,
      terminalTimeoutMs,
    );
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm" && latest.activeExecution == null,
  });
}

async function move(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, fresh);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.activeExecution == null && adjacent(latest.tile, target),
  });
}

async function moveToReachableBowl(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseOnlyReachableBowlOrNull(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++)
      for (let dy = -radius; dy <= radius; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius)
          candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
    for (const waypoint of candidates) {
      try {
        const moved = await move(
          client,
          receipts,
          snapshot,
          waypoint,
          "move_to_native_water_pet_bowl_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseOnlyReachableBowlOrNull(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (
          !reason.endsWith("_not_accepted:no_native_path") &&
          !reason.startsWith("navigation_failed:no_native_path") &&
          !reason.startsWith("move_to_native_water_pet_bowl_fixture_failed:no_native_path")
        )
          throw error;
        snapshot = await observeActionable(client);
        if (chooseOnlyReachableBowlOrNull(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_water_pet_bowl_fixture_target");
}

function chooseOnlyReachableBowl(snapshot) {
  const targets = validBowlTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_adjacent_live_bowl_target" : "ambiguous_adjacent_live_bowl_targets");
  return targets[0];
}

function chooseOnlyReachableBowlOrNull(snapshot) {
  const targets = validBowlTargets(snapshot);
  return targets.length === 1 ? targets[0] : null;
}

function validBowlTargets(snapshot) {
  return (snapshot.petBowlTargets ?? []).filter(
    (target) =>
      /^pet_bowl_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      adjacent(snapshot.tile, target),
  );
}

function chooseWateringCan(snapshot) {
  const cans = (snapshot.toolSlots ?? []).filter(
    (entry) => Number.isInteger(entry?.slot) && typeof entry.label === "string" && isWateringCanLabel(entry.label),
  );
  if (cans.length !== 1)
    throw new Error(
      cans.length === 0 ? "watering_can_not_found_in_live_tool_slots" : "ambiguous_live_watering_can_slots",
    );
  return cans[0];
}

function isWateringCanLabel(label) {
  return (
    typeof label === "string" &&
    label
      .replaceAll(/[^a-z0-9]/gi, "")
      .toLowerCase()
      .includes("wateringcan")
  );
}

async function observeActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.petBowlTargets) ||
    !Array.isArray(snapshot.warps)
  )
    throw new Error("native_local_water_pet_bowl_snapshot_invalid");
  return snapshot;
}

function validateNativeLocalConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_required");
  // The retired `EnabledActions` allowlist is gone: the surface is derived from
  // the Mod catalog with deny-by-exception, so the check that still means
  // something is that this config does not deny an action the run needs.
  validateNativeLocalFixturePolicy(config, { requiredActions: EXPECTED_ACTIONS });
  if (config?.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO)
    throw new Error("native_local_water_pet_bowl_scenario_invalid");
}

function parseEvidence(evidence, requiredKeys) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  const fields = Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
  for (const key of requiredKeys)
    if (typeof fields[key] !== "string") throw new Error(`native_local_evidence_missing_key:${key}`);
  return fields;
}

function adjacent(tile, target) {
  return (
    Number.isInteger(tile?.x) &&
    Number.isInteger(tile?.y) &&
    Math.max(Math.abs(tile.x - target.x), Math.abs(tile.y - target.y)) === 1
  );
}

function sameTile(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y;
}

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    currentTool: snapshot.currentTool,
    petBowlTargets: (snapshot.petBowlTargets ?? []).map((entry) => entry.targetId),
  };
}
