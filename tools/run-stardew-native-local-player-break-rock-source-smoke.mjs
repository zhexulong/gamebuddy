// Stardew-local break-rock smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned
// teardown all come from the shared harness. Action-specific logic (one-hit
// rock/pickaxe target selection, travel/move prerequisites, evidence and
// postcondition validation) stays in this runner.

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
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_break_rock_source_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "break_rock_source"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "move_to_tile",
  "travel",
  "break_rock_source",
];

/** Execute the break-rock-source contract against an already-connected bridge session. */
export async function runBreakRockSourceSmoke(
  client,
  receipts,
  config,
  {
    actionableTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 15_000,
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateConfig(config);
  try {
    let snapshot = await waitForActionable(client, await observeFresh(client), actionableTimeoutMs);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    if (snapshot.location !== "FarmHouse") throw new Error("break_rock_source_route_must_start_at_farmhouse");

    snapshot = await travelToFarm(
      client,
      receipts,
      trace,
      snapshot,
      stabilizeTimeoutMs,
      moveTimeoutMs,
      travelTimeoutMs,
    );
    snapshot = await waitForActionable(client, snapshot, actionableTimeoutMs);
    snapshot = await moveToReachableRock(
      client,
      receipts,
      trace,
      snapshot,
      actionableTimeoutMs,
      stabilizeTimeoutMs,
      moveTimeoutMs,
    );
    snapshot = await waitForActionable(client, snapshot, actionableTimeoutMs);

    const target = chooseRock(snapshot);
    const pickaxe = choosePickaxe(snapshot);
    const equipped = await execute(client, trace, "equip_pickaxe", "equip_tool", { slot: pickaxe.slot }, snapshot);
    if (equipped.state !== "succeeded" || equipped.reasonCode !== "tool_selected") {
      throw new Error(`pickaxe_equip_failed:${equipped.reasonCode}`);
    }

    snapshot = await waitForActionable(client, await observeFresh(client), actionableTimeoutMs);
    const freshTarget = findSameRock(snapshot, target);
    if (!freshTarget || freshTarget.health !== 1) throw new Error("rock_target_changed_after_equip");
    const accepted = await execute(
      client,
      trace,
      "break_rock_source",
      "break_rock_source",
      {
        slot: pickaxe.slot,
        x: freshTarget.x,
        y: freshTarget.y,
        expectedTargetId: freshTarget.targetId,
      },
      snapshot,
    );
    if (accepted.state !== "succeeded" || accepted.reasonCode !== "rock_source_broken") {
      throw new Error(`break_rock_source_failed:${accepted.reasonCode}`);
    }
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) => Array.isArray(latest.rockSourceTargets),
    });
    const reread = findSameRock(after, freshTarget);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      after.revision >= terminal.revision &&
      evidence.target === freshTarget.targetId &&
      evidence.tool === "pickaxe" &&
      evidence.slot === String(pickaxe.slot) &&
      evidence.qualified_item_id === "(O)2" &&
      evidence.durability_before === "1" &&
      evidence.durability_after === "removed" &&
      evidence.removed === "true" &&
      reread === undefined;

    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "break_rock_source" : "break_rock_source_postcondition_mismatch",
      target: summarizeRock(freshTarget),
      receipt: summarizeReceipt(terminal),
      evidence,
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
    const result = await runBreakRockSourceSmoke(session.client, session.receipts, config);
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
    fixture?.Bootstrap?.Enable === true ||
    fixture?.FixtureScenario !== SCENARIO
  ) {
    throw new Error("native_local_break_rock_source_fixture_config_invalid");
  }
  if (
    value.Portfolio?.Enable === true ||
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true ||
    value.ActionPolicyVersion !== 0 ||
    !same(value.EnabledActions, EXPECTED_ACTIONS)
  ) {
    throw new Error("native_local_break_rock_source_action_policy_invalid");
  }
}

async function execute(client, trace, phase, action, args, snapshot) {
  const nonce = `${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId: `native_local_break_rock_source_${phase}_${nonce}`,
    idempotencyKey: `native_local_break_rock_source_${phase}_idem_${nonce}`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}

async function travelToFarm(client, receipts, trace, snapshot, stabilizeTimeoutMs, moveTimeoutMs, travelTimeoutMs) {
  const warps = (snapshot.warps ?? []).filter(
    (entry) => entry?.targetLocation === "Farm" && validTile(entry.sourceX) && validTile(entry.sourceY),
  );
  if (warps.length !== 1) throw new Error(warps.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  const warp = warps[0];
  if (!adjacent(snapshot.tile, { x: warp.sourceX, y: warp.sourceY }))
    snapshot = await move(
      client,
      receipts,
      trace,
      snapshot,
      { x: warp.sourceX, y: warp.sourceY },
      "move_to_farm_warp",
      stabilizeTimeoutMs,
      moveTimeoutMs,
    );
  const accepted = await execute(client, trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, snapshot);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, travelTimeoutMs);
  if (terminal.state !== "succeeded") throw new Error(`travel_failed:${terminal.reasonCode}`);
  const completion = await waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
  recordTerminalReceipt(trace, "travel", "travel", { x: warp.sourceX, y: warp.sourceY }, terminal);
  return completion;
}

async function moveToReachableRock(
  client,
  receipts,
  trace,
  snapshot,
  actionableTimeoutMs,
  stabilizeTimeoutMs,
  moveTimeoutMs,
) {
  if (rockCandidates(snapshot).length === 1) return snapshot;
  for (let radius = 1; radius <= 12; radius++) {
    const waypoints = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) === radius)
          waypoints.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    }
    for (const waypoint of waypoints) {
      if (!validTile(waypoint.x) || !validTile(waypoint.y)) continue;
      try {
        const moved = await move(
          client,
          receipts,
          trace,
          snapshot,
          waypoint,
          "move_to_rock_fixture",
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (rockCandidates(moved).length === 1) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.endsWith("_failed:no_native_path"))
          throw error;
        snapshot = await waitForActionable(client, await observeFresh(client), actionableTimeoutMs);
        if (rockCandidates(snapshot).length === 1) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_unique_native_rock_target");
}

async function move(client, receipts, trace, snapshot, target, phase, stabilizeTimeoutMs, moveTimeoutMs) {
  snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, snapshot);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, moveTimeoutMs);
  if (terminal.state !== "succeeded") throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  const completion = await waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
  recordTerminalReceipt(trace, phase, "move_to_tile", target, terminal);
  return completion;
}

function recordTerminalReceipt(trace, phase, action, args, receipt) {
  trace.push({ phase: `${phase}_terminal`, action, args, receipt: summarizeReceipt(receipt) });
}

function rockCandidates(snapshot) {
  return (snapshot.rockSourceTargets ?? []).filter(validRock);
}

function chooseRock(snapshot) {
  const targets = rockCandidates(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length ? "ambiguous_live_one_hit_rock_target" : "no_live_one_hit_rock_target");
  return targets[0];
}

function findSameRock(snapshot, target) {
  return (snapshot.rockSourceTargets ?? []).find(
    (entry) => entry?.targetId === target.targetId && entry.x === target.x && entry.y === target.y && validRock(entry),
  );
}

function choosePickaxe(snapshot) {
  const pickaxes = (snapshot.toolSlots ?? []).filter(
    (entry) => Number.isInteger(entry?.slot) && entry.label === "(T)Pickaxe",
  );
  if (pickaxes.length !== 1) throw new Error(pickaxes.length ? "ambiguous_live_pickaxe_slot" : "no_live_pickaxe_slot");
  return pickaxes[0];
}

function validRock(entry) {
  return (
    typeof entry?.targetId === "string" &&
    entry.targetId.length > 0 &&
    validTile(entry.x) &&
    validTile(entry.y) &&
    typeof entry.location === "string" &&
    entry.location.length > 0 &&
    Number.isFinite(entry.health) &&
    entry.qualifiedItemId === "(O)2" &&
    entry.health === 1
  );
}

function validTile(value) {
  return Number.isInteger(value) && value >= 0 && value <= 1000;
}

function adjacent(left, right) {
  return Math.abs(left.x - right.x) <= 1 && Math.abs(left.y - right.y) <= 1;
}

function same(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return Object.fromEntries(
    detail
      .split(";")
      .map((part) => {
        const index = part.indexOf("=");
        return index > 0 ? [part.slice(0, index), part.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

function summarize(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    rockSourceTargets: snapshot.rockSourceTargets?.length ?? 0,
  };
}

function summarizeRock(rock) {
  return rock
    ? {
        targetId: rock.targetId,
        x: rock.x,
        y: rock.y,
        location: rock.location,
        health: rock.health,
        qualifiedItemId: rock.qualifiedItemId,
      }
    : null;
}
