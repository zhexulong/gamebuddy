import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_water_crop_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "water_crop"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
  "water_crop",
].sort();

/** Execute the water-crop contract against an already-connected bridge session. */
export async function runWaterCropSmoke(
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
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);

    const wateringCan = chooseWateringCan(snapshot);
    const equipped = await execute(
      client,
      trace,
      "equip_watering_can",
      "equip_tool",
      { slot: wateringCan.slot },
      snapshot,
    );
    const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
    if (equipTerminal.state !== "succeeded" || equipTerminal.reasonCode !== "tool_selected")
      throw new Error(`watering_can_equip_failed:${equipTerminal.reasonCode}`);
    const equipEvidence = parseEvidence(equipTerminal.evidence, ["after", "before", "expected", "slot"]);
    if (equipEvidence.expected !== wateringCan.label || equipEvidence.after !== wateringCan.label)
      throw new Error("watering_can_equip_evidence_mismatch");

    snapshot = await observeActionable(client);
    if (snapshot.currentTool !== wateringCan.label) throw new Error("watering_can_postcondition_missing");
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    snapshot = await moveToReachableCrop(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 3_000);
    if (!snapshot.actionable || snapshot.activeExecution != null)
      throw new Error("player_not_actionable_before_water_crop");

    // Bind the opaque target from the fresh snapshot immediately preceding the
    // request. The fixture does not provide a coordinate or target ID to this
    // runner, and the Mod revalidates this binding on the game thread.
    const target = chooseOnlyReachableCrop(snapshot);
    const cropTargetCountBefore = snapshot.cropTargets.length;
    if (cropTargetCountBefore !== 1)
      throw new Error(`native_local_water_crop_fixture_target_count_before:${cropTargetCountBefore}`);
    const accepted = await execute(
      client,
      trace,
      "water",
      "water_crop",
      { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEvidence(terminal.evidence, [
      "after_watered",
      "before_watered",
      "location",
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
        latest.cropTargets.every(
          (entry) => entry?.targetId !== target.targetId && (entry?.x !== target.x || entry?.y !== target.y),
        ),
    });
    const cropTargetCountAfter = Array.isArray(after.cropTargets) ? after.cropTargets.length : -1;
    const sourceTargetGone =
      cropTargetCountAfter === 0 &&
      after.cropTargets.every(
        (entry) => entry?.targetId !== target.targetId && (entry?.x !== target.x || entry?.y !== target.y),
      );
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
      terminal.reasonCode === "crop_watered" &&
      evidenceBound &&
      preciseWaterDelta &&
      freshPostcondition;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "crop_watered" : "water_crop_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      preciseWaterDelta,
      cropTargetCountBefore,
      cropTargetCountAfter,
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
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runWaterCropSmoke(session.client, session.receipts, config);
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
  const requestId = `native_local_water_crop_${phase}_${nonce}`;
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

async function moveToReachableCrop(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseOnlyReachableCropOrNull(snapshot)) return snapshot;
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
          "move_to_native_water_crop_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseOnlyReachableCropOrNull(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (
          !reason.endsWith("_not_accepted:no_native_path") &&
          !reason.startsWith("navigation_failed:no_native_path") &&
          !reason.startsWith("move_to_native_water_crop_fixture_failed:no_native_path")
        )
          throw error;
        snapshot = await observeActionable(client);
        if (chooseOnlyReachableCropOrNull(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_water_crop_fixture_target");
}

function chooseOnlyReachableCrop(snapshot) {
  const targets = validCropTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_adjacent_live_crop_target" : "ambiguous_adjacent_live_crop_targets");
  return targets[0];
}

function chooseOnlyReachableCropOrNull(snapshot) {
  const targets = validCropTargets(snapshot);
  return targets.length === 1 ? targets[0] : null;
}

function validCropTargets(snapshot) {
  return (snapshot.cropTargets ?? []).filter(
    (target) =>
      /^crop_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      target.x >= 0 &&
      target.y >= 0 &&
      typeof target.cropId === "string" &&
      target.cropId.length > 0 &&
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
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.cropTargets) ||
    !Array.isArray(snapshot.warps)
  )
    throw new Error("native_local_water_crop_snapshot_invalid");
  return snapshot;
}

function parseEvidence(evidence, expectedKeys) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) throw new Error("invalid_water_crop_evidence");
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_water_crop_evidence");
    result[key] = value;
  }
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...expectedKeys].sort()))
    throw new Error("water_crop_evidence_keys_mismatch");
  return result;
}

function validateNativeLocalConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
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
    JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS) ||
    (value.ExperimentalActions?.length ?? 0) !== 0
  )
    throw new Error("native_local_water_crop_action_policy_invalid");
  if (
    ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    )
  )
    throw new Error("invalid_client_config");
}

function sameTile(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y;
}

function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}

function summarize(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    currentTool: snapshot.currentTool ?? null,
    cropTargets: snapshot.cropTargets?.length ?? 0,
  };
}
