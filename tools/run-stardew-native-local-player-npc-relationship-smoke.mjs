import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const SCENARIO = "native_npc_relationship_v1";
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "travel", "npc_relationship"];

/** Execute the npc_relationship contract against an already-connected bridge session. */
export async function runNpcRelationshipSmoke(
  client,
  receipts,
  config,
  {
    terminalTimeoutMs = 5_000,
    postconditionTimeoutMs = 5_000,
    stabilizeTimeoutMs = 10_000,
    moveTimeoutMs = 55_000,
    travelTimeoutMs = 20_000,
  } = {},
) {
  const trace = [];
  const startedAt = Date.now();
  validateNativeLocalConfig(config);
  try {
    let snapshot = await freshActionableSnapshot(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    if (snapshot.location !== "FarmHouse") throw new Error("npc_relationship_route_must_start_at_farmhouse");
    // The fixture establishes a bounded native villager target near the live
    // FarmHouse→Farm warp. Typed travel remains production-owned; no Town
    // schedule, NPC positioning, or relationship mutation occurs in the runner.
    snapshot = await travelFreshHop(
      client,
      receipts,
      trace,
      snapshot,
      "FarmHouse",
      "Farm",
      "farmhouse_to_farm",
      stabilizeTimeoutMs,
      travelTimeoutMs,
    );
    let target = chooseOnlyFreshFixtureTarget(snapshot);
    if (!adjacent(snapshot.tile, target)) {
      snapshot = await moveToLiveTarget(
        client,
        receipts,
        trace,
        target,
        "move_to_npc_relationship_fixture",
        stabilizeTimeoutMs,
        moveTimeoutMs,
      );
      target = chooseOnlyFreshFixtureTarget(snapshot);
    }
    if (!adjacent(snapshot.tile, target)) throw new Error("npc_relationship_fixture_target_unreachable");
    const accepted = await execute(
      "inspect_npc_relationship",
      "npc_relationship",
      {
        x: target.x,
        y: target.y,
        expectedTargetId: target.targetId,
      },
      snapshot,
      trace,
      client,
    );
    if (
      accepted.state !== "accepted" &&
      !(accepted.state === "succeeded" && accepted.reasonCode === "npc_relationship_inspected")
    )
      throw new Error(`npc_relationship_not_accepted:${accepted.reasonCode}`);
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    assertExactCapabilities(after, EXPECTED_CAPABILITIES);
    if (after.location !== "Farm") throw new Error("npc_relationship_postcondition_location_changed");
    const reread = chooseSameFreshTarget(after, target.targetId);
    const evidence = parseEvidence(terminal.evidence);
    const passed =
      terminal.executionId === accepted.executionId &&
      terminal.requestId === accepted.requestId &&
      terminal.state === "succeeded" &&
      terminal.reasonCode === "npc_relationship_inspected" &&
      after.revision >= terminal.revision &&
      evidenceMatchesTarget(evidence, target, "Farm") &&
      sameRelationshipFacts(target, reread);
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "npc_relationship_inspected" : "npc_relationship_postcondition_mismatch",
      target: targetSummary(target),
      receipt: summarizeReceipt(terminal),
      evidence,
      reread: targetSummary(reread),
      unchangedRelationshipFacts: sameRelationshipFacts(target, reread),
      trace,
      after: snapshotSummary(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
      topology: "native_local_player_fixture",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      latestReceipt: summarizeReceipt(client.state?.latestReceipt),
      trace,
    };
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runNpcRelationshipSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function travelFreshHop(
  client,
  receipts,
  trace,
  snapshot,
  expectedOrigin,
  expectedLocation,
  phase,
  stabilizeTimeoutMs,
  travelTimeoutMs,
) {
  if (snapshot.location !== expectedOrigin) throw new Error(`${phase}_origin_changed`);
  const travelled = await travelToLocation(client, receipts, trace, snapshot, expectedLocation, {
    phase,
    expectedOrigin,
    stabilizeTimeoutMs,
    terminalTimeoutMs: travelTimeoutMs,
    requireExactArrivalTile: true,
  });
  return travelled.snapshot;
}
async function moveToLiveTarget(client, receipts, trace, target, phase, stabilizeTimeoutMs, moveTimeoutMs) {
  const snapshot = await freshActionableSnapshot(client);
  const current = validTargets(snapshot).find((entry) => entry.targetId === target.targetId);
  if (!current) throw new Error(`${phase}_target_changed`);
  // An NPC owns its own tile. Request a bounded cardinal standing tile toward
  // the current Player instead of treating an occupied NPC coordinate as a
  // movement destination. The subsequent independent inspection still binds
  // the live NPC coordinate and opaque target ID.
  const approach = nearestCardinalApproach(snapshot.tile, current);
  await moveToTile(client, receipts, trace, snapshot, approach, {
    phase,
    stabilizeTimeoutMs,
    terminalTimeoutMs: moveTimeoutMs,
    check: (fresh) => adjacent(fresh.tile, current),
  });
  return freshActionableSnapshot(client);
}
async function freshActionableSnapshot(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  if (!Array.isArray(snapshot.warps) || !Array.isArray(snapshot.npcRelationshipTargets))
    throw new Error("native_local_npc_relationship_snapshot_invalid");
  return snapshot;
}
async function moveToTile(client, receipts, trace, snapshot, target, { phase, stabilizeTimeoutMs, terminalTimeoutMs, check } = {}) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(phase, "move_to_tile", target, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => (check === undefined ? adjacent(latest.tile, target) : check(latest)),
  });
}
async function travelToLocation(
  client,
  receipts,
  trace,
  snapshot,
  expectedLocation,
  { phase, expectedOrigin, stabilizeTimeoutMs, terminalTimeoutMs, requireExactArrivalTile = false } = {},
) {
  if (snapshot.location !== expectedOrigin) throw new Error(`${phase}_origin_changed`);
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  if (fresh.location !== expectedOrigin) throw new Error(`${phase}_fresh_origin_changed`);
  let warp = chooseNearestLiveWarp(fresh, expectedLocation, phase);
  if (!adjacent(fresh.tile, warpSource(warp))) {
    fresh = await moveToTile(client, receipts, trace, fresh, warpSource(warp), {
      phase,
      stabilizeTimeoutMs,
      terminalTimeoutMs,
    });
  }
  fresh = await waitForActionable(client, fresh, stabilizeTimeoutMs);
  if (fresh.location !== expectedOrigin) throw new Error(`${phase}_fresh_origin_changed`);
  warp = chooseNearestLiveWarp(fresh, expectedLocation, phase);
  if (!adjacent(fresh.tile, warpSource(warp))) throw new Error(`${phase}_fresh_warp_unavailable`);
  const accepted = await execute(`${phase}_travel`, "travel", warpSource(warp), fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`${phase}_travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`${phase}_travel_failed:${terminal.reasonCode}`);
  const after = await waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) =>
      latest.location === expectedLocation &&
      (!requireExactArrivalTile ||
        (Number.isInteger(latest.tile?.x) && latest.tile.x === warp.targetX && latest.tile.y === warp.targetY)),
  });
  return { snapshot: after };
}
function warpSource(warp) {
  return { x: warp.sourceX, y: warp.sourceY };
}
function validWarp(warp) {
  return (
    Number.isInteger(warp?.sourceX) &&
    Number.isInteger(warp?.sourceY) &&
    Number.isInteger(warp?.targetX) &&
    Number.isInteger(warp?.targetY) &&
    warp.sourceX >= 0 &&
    warp.sourceY >= 0 &&
    warp.targetX >= 0 &&
    warp.targetY >= 0 &&
    typeof warp.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
}
function chooseNearestUniqueLiveWarp(snapshot, warps) {
  if (warps.length === 1) return warps[0];
  const ranked = warps
    .map((warp) => ({
      warp,
      distance: Math.abs(snapshot.tile.x - warp.sourceX) + Math.abs(snapshot.tile.y - warp.sourceY),
    }))
    .sort((left, right) => left.distance - right.distance);
  return ranked.length > 1 && ranked[0].distance === ranked[1].distance ? null : ranked[0]?.warp ?? null;
}
function chooseNearestLiveWarp(snapshot, expectedLocation, phase) {
  const matches = snapshot.warps.filter((warp) => validWarp(warp) && warp.targetLocation === expectedLocation);
  const selected = chooseNearestUniqueLiveWarp(snapshot, matches);
  if (!selected) throw new Error(matches.length === 0 ? `${phase}_live_warp_missing` : `${phase}_live_warp_ambiguous`);
  return selected;
}
function adjacent(left, right) {
  return withinRadius(left, right, 1);
}
function validTargets(snapshot) {
  return snapshot.npcRelationshipTargets.filter(
    (target) =>
      typeof target?.targetId === "string" &&
      /^npc_relationship_[a-f0-9]{16}$/.test(target.targetId) &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      typeof target.npcName === "string" &&
      target.npcName.length > 0 &&
      Number.isInteger(target.friendshipPoints) &&
      typeof target.friendshipStatus === "string" &&
      target.friendshipStatus.length > 0 &&
      typeof target.talkedToToday === "boolean" &&
      Number.isInteger(target.giftsToday) &&
      Number.isInteger(target.giftsThisWeek) &&
      withinRadius(snapshot.tile, target, 6),
  );
}
function chooseOnlyFreshFixtureTarget(snapshot) {
  const targets = validTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(
      targets.length === 0
        ? "no_fresh_fixture_npc_relationship_target"
        : "ambiguous_fresh_fixture_npc_relationship_targets",
    );
  const target = targets[0];
  if (
    target.npcName !== "Robin" ||
    target.friendshipPoints !== 250 ||
    target.talkedToToday ||
    target.giftsToday !== 0 ||
    target.giftsThisWeek !== 0
  )
    throw new Error("npc_relationship_fixture_starting_state_mismatch");
  return target;
}
function chooseSameFreshTarget(snapshot, targetId) {
  const target = validTargets(snapshot).find((entry) => entry.targetId === targetId);
  if (!target) throw new Error("fresh_npc_relationship_target_missing");
  return target;
}
async function execute(phase, action, args, snapshot, trace, client) {
  const requestId = `native_local_npc_relationship_${phase}_${Date.now()}_${trace.length}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ phase, action, args, receipt: summarizeReceipt(receipt) });
  return receipt;
}
function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const field of detail.split(";")) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) throw new Error("invalid_npc_relationship_evidence");
    const key = field.slice(0, separator);
    const value = field.slice(separator + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
      throw new Error("invalid_npc_relationship_evidence");
    result[key] = value;
  }
  const expected = [
    "gifts_this_week",
    "gifts_today",
    "location",
    "npc",
    "points",
    "status",
    "talked_to_today",
    "target",
    "tile",
  ];
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify(expected))
    throw new Error("invalid_npc_relationship_evidence");
  return result;
}
function evidenceMatchesTarget(evidence, target, location) {
  return (
    evidence.location === location &&
    evidence.target === target.targetId &&
    evidence.tile === `${target.x},${target.y}` &&
    evidence.npc === target.npcName &&
    evidence.points === String(target.friendshipPoints) &&
    evidence.status === target.friendshipStatus &&
    evidence.talked_to_today === String(target.talkedToToday) &&
    evidence.gifts_today === String(target.giftsToday) &&
    evidence.gifts_this_week === String(target.giftsThisWeek)
  );
}
function sameRelationshipFacts(left, right) {
  return (
    left.targetId === right.targetId &&
    left.x === right.x &&
    left.y === right.y &&
    left.npcName === right.npcName &&
    left.friendshipPoints === right.friendshipPoints &&
    left.friendshipStatus === right.friendshipStatus &&
    left.talkedToToday === right.talkedToToday &&
    left.giftsToday === right.giftsToday &&
    left.giftsThisWeek === right.giftsThisWeek
  );
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
    JSON.stringify(value.EnabledActions) !== JSON.stringify(["move_to_tile", "travel", "npc_relationship"]) ||
    JSON.stringify(value.ExperimentalActions) !== JSON.stringify(["npc_relationship"])
  )
    throw new Error("native_local_npc_relationship_action_policy_invalid");
  if (
    ["SaveId", "WorldId", "PlayerId", "CompanionId", "PipeName", "BridgeToken"].some(
      (key) => typeof value[key] !== "string" || value[key].length === 0,
    )
  )
    throw new Error("invalid_client_config");
}
function nearestCardinalApproach(player, target) {
  const candidates = [
    { x: target.x - 1, y: target.y },
    { x: target.x + 1, y: target.y },
    { x: target.x, y: target.y - 1 },
    { x: target.x, y: target.y + 1 },
  ]
    .filter((candidate) => candidate.x >= 0 && candidate.y >= 0)
    .sort(
      (left, right) =>
        Math.abs(player.x - left.x) +
          Math.abs(player.y - left.y) -
          (Math.abs(player.x - right.x) + Math.abs(player.y - right.y)) ||
        left.y - right.y ||
        left.x - right.x,
    );
  if (candidates.length === 0) throw new Error("npc_relationship_fixture_approach_missing");
  return candidates[0];
}
function withinRadius(left, right, radius) {
  return Math.abs(left.x - right.x) <= radius && Math.abs(left.y - right.y) <= radius;
}
function targetSummary(target) {
  return target
    ? {
        targetId: target.targetId,
        x: target.x,
        y: target.y,
        npcName: target.npcName,
        friendshipPoints: target.friendshipPoints,
        friendshipStatus: target.friendshipStatus,
        talkedToToday: target.talkedToToday,
        giftsToday: target.giftsToday,
        giftsThisWeek: target.giftsThisWeek,
      }
    : null;
}
function snapshotSummary(snapshot) {
  return {
    revision: snapshot.revision,
    location: snapshot.location,
    tile: snapshot.tile,
    actionable: snapshot.actionable,
    npcRelationshipTargets: snapshot.npcRelationshipTargets?.map(targetSummary) ?? [],
    activeExecution: snapshot.activeExecution ?? null,
  };
}
