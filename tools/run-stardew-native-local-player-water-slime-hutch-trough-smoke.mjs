import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForFreshSnapshot,
  waitForStableRevision,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "water_slime_hutch_trough";
const SCENARIO = "native_water_slime_hutch_trough_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "water_slime_hutch_trough"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
  "water_slime_hutch_trough",
].sort();

/**
 * Execute the water-slime-hutch-trough contract against an already-connected bridge session.
 *
 * The fixture establishes only the declared Given: a completed native Slime Hutch whose
 * interior the actor has entered, one charged Watering Can, and the actor on a lawful
 * adjacent tile. Unlike the Farm-based water_pet_bowl lane there is no travel-to-Farm
 * step: the trough exists only inside the hutch interior, and `SlimeHutch.performToolAction`
 * accepts a fixed interior column (`x == 16`, `y in 6..9`). This runner independently
 * re-derives the opaque trough target from the fresh production snapshot, equips/moves only
 * through typed production actions, and requires the native postcondition
 * (`waterSpots[y - 6]` false -> true) plus a fresh reread before it reports success.
 * It never writes trough state and never manufactures a receipt.
 */
export async function runWaterSlimeHutchTroughSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalConfig(config);
  try {
    // The fixture warps the actor into the hutch interior before bridge attachment,
    // but the native warp completes on a later tick. An observe taken mid-transition
    // is not yet actionable and still reports the previous location (the fixture host
    // begins in `FarmHouse`), and discovery only advertises trough tiles when the
    // actor is already inside a `SlimeHutch`. Settle through `waitForActionable`
    // BEFORE the strict first observe, so a mid-warp snapshot is polled through
    // rather than rejected.
    let snapshot = await waitForActionable(client, undefined, stabilizeTimeoutMs);
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: snapshot.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        typeof latest.location === "string" && /^Slime ?Hutch/i.test(latest.location),
    });
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);

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
      snapshot = await observeSlimeHutch(client);
      if (snapshot.currentTool !== wateringCan.label) throw new Error("watering_can_postcondition_missing");
    }

    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    snapshot = await moveToReachableTrough(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    snapshot = await waitForActionable(client, snapshot, 3_000);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error("player_not_actionable_before_water_slime_hutch_trough");

    const target = chooseReachableTrough(snapshot);
    const troughTargetCountBefore = validTroughTargets(snapshot).length;
    // More than one tile of the column can be in reach at once; the contract is
    // only that at least one lawful target exists before the request is sent.
    if (troughTargetCountBefore < 1)
      throw new Error("native_local_water_slime_hutch_trough_fixture_target_missing");
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
        validTroughTargets(latest).every((entry) => entry.targetId !== target.targetId),
    });
    const sourceTargetGone = validTroughTargets(after).every((entry) => entry.targetId !== target.targetId);
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
      terminal.reasonCode === "slime_hutch_trough_watered" &&
      evidence.native_menu_opened === "false" &&
      evidenceBound &&
      preciseWaterDelta &&
      freshPostcondition;
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "slime_hutch_trough_watered" : "water_slime_hutch_trough_postcondition_mismatch",
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      preciseWaterDelta,
      troughTargetCountBefore,
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
    const result = await runWaterSlimeHutchTroughSmoke(session.client, session.receipts, config);
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
  const requestId = `native_local_water_slime_hutch_trough_${phase}_${nonce}`;
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

async function move(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, fresh);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  // `move_to_tile` reports `target_reached` on exact arrival OR on a cardinal
  // adjacent warp approach (StardewBodyController.cs:129-135,163-171), so the
  // settled actor may stand on the waypoint or cardinally beside it. Accept both;
  // `validTroughTargets` independently decides whether the approach is in range.
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) =>
      latest.activeExecution == null &&
      (sameTile(latest.tile, target) || cardinalAdjacent(latest.tile, target)) === true,
  });
}

async function moveToReachableTrough(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (validTroughTargets(snapshot).length > 0) return snapshot;
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
          "move_to_native_water_slime_hutch_trough_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (validTroughTargets(moved).length > 0) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (
          !reason.endsWith("_not_accepted:no_native_path") &&
          !reason.startsWith("navigation_failed:no_native_path") &&
          !reason.startsWith("move_to_native_water_slime_hutch_trough_fixture_failed:no_native_path")
        )
          throw error;
        snapshot = await observeSlimeHutch(client);
        if (validTroughTargets(snapshot).length > 0) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_water_slime_hutch_trough_fixture_target");
}

function chooseReachableTrough(snapshot) {
  const targets = validTroughTargets(snapshot);
  if (targets.length === 0) throw new Error("no_adjacent_live_trough_target");
  // A trough is a COLUMN of up to four tiles, so a lawful standing tile is often
  // adjacent to more than one of them. Requiring exactly one (the single-waterable
  // -tile Pet Bowl rule) makes a reachable trough look unreachable and sends the
  // actor on a pointless map walk; any accepted tile is a valid target here.
  // Order is stable: discovery emits the column top-to-bottom.
  return targets[0];
}


function validTroughTargets(snapshot) {
  return (snapshot.slimeHutchTroughTargets ?? []).filter(
    (target) =>
      /^slime_hutch_trough_[a-f0-9]{16}$/.test(target?.targetId ?? "") &&
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

async function observeSlimeHutch(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.slimeHutchTroughTargets) ||
    !Array.isArray(snapshot.warps)
  )
    throw new Error("native_local_water_slime_hutch_trough_snapshot_invalid");
  return snapshot;
}

function validateNativeLocalConfig(config) {
  if (config?.NativeLocalPlayerFixture?.Enable !== true) throw new Error("native_local_fixture_required");
  const actions = config?.EnabledActions;
  if (!Array.isArray(actions) || actions.length !== EXPECTED_ACTIONS.length || !EXPECTED_ACTIONS.every((entry) => actions.includes(entry)))
    throw new Error("native_local_water_slime_hutch_trough_action_set_invalid");
  if (config?.NativeLocalPlayerFixture?.FixtureScenario !== SCENARIO)
    throw new Error("native_local_water_slime_hutch_trough_scenario_invalid");
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

function cardinalAdjacent(tile, target) {
  if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y)) return false;
  return Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y) === 1;
}

function summarize(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    currentTool: snapshot.currentTool,
    slimeHutchTroughTargets: (snapshot.slimeHutchTroughTargets ?? []).map((entry) => entry.targetId),
  };
}
