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

const SCENARIO = "native_plant_seed_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "plant_seed"];
const EXPECTED_CAPABILITIES = ["cancel_active_execution", "inspect_self", "move_to_tile", "plant_seed", "travel"];
const EXPECTED_EVIDENCE_KEYS = ["crop", "inventory_after", "inventory_before", "item", "location", "target", "tile"];

/** Execute the plant-seed contract against an already-connected bridge session. */
export async function runPlantSeedSmoke(
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
  validateNativeLocalFixtureConfig(config);
  try {
    requireExactCapabilities(client.state?.capabilities, "hello");
    let snapshot = await observeFresh(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    snapshot = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await moveToReachableSeedTarget(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error("player_not_actionable_before_plant");

    // The opaque target comes from the fresh snapshot immediately preceding
    // the request; fixture coordinates never authorize which seed to plant.
    const target = chooseReachableSeedTarget(snapshot);
    if (!target) throw new Error("no_adjacent_live_seed_target");
    const accepted = await execute(
      client,
      trace,
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
    );
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    const evidence = parseEvidence(terminal.evidence);
    const after = await waitForStableRevision(client, {
      revision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      // cropTargets is a capability-gated water_crop input collection, not a
      // generic crop-result projection. This isolated plant-only profile must
      // not enable water_crop merely to observe the planted crop. Same-execution
      // production evidence binds crop creation; fresh state proves the exact
      // seed source is no longer actionable.
      check: (latest) =>
        latest.actionable === true &&
        latest.activeExecution == null &&
        latest.location === snapshot.location &&
        sameTile(latest.tile, snapshot.tile) &&
        Array.isArray(latest.seedTargets) &&
        latest.seedTargets.every(
          (entry) => entry.targetId !== target.targetId && (entry.x !== target.x || entry.y !== target.y),
        ),
    });
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
    return {
      state: passed ? "passed" : "blocked",
      reasonCode: passed ? "seed_planted" : terminal.reasonCode,
      target,
      receipt: summarizeReceipt(terminal),
      evidence,
      sourceDisappeared,
      inventoryDeltaProven,
      freshPostcondition,
      trace,
      before: summarizeWithSeed(snapshot),
      after: summarizeWithSeed(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
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
    const result = await runPlantSeedSmoke(session.client, session.receipts, config);
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
  const requestId = `native_local_plant_seed_${phase}_${nonce}`;
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
  const warp = resolveFarmWarp(fresh);
  if (!adjacent(fresh.tile, { x: warp.sourceX, y: warp.sourceY }))
    fresh = await moveToTile(
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
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  trace.push({ phase: "travel_terminal", receipt: summarizeReceipt(terminal) });
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  const accepted = await execute(client, trace, phase, "move_to_tile", target, fresh);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded") throw new Error(`navigation_failed:${terminal.reasonCode}`);
  trace.push({ phase: "prerequisite_terminal", receipt: summarizeReceipt(terminal) });
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => adjacent(latest.tile, target),
  });
}

async function moveToReachableSeedTarget(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseReachableSeedTarget(snapshot)) return snapshot;
  for (let radius = 2; radius <= 12; radius++) {
    const candidates = [];
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        candidates.push({ x: snapshot.tile.x + dx, y: snapshot.tile.y + dy });
      }
    }
    for (const waypoint of candidates) {
      try {
        const moved = await moveToTile(
          client,
          receipts,
          snapshot,
          waypoint,
          "move_to_native_plant_seed_fixture",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseReachableSeedTarget(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
          throw error;
        snapshot = await observeFresh(client);
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

function requireExactCapabilities(actual, source) {
  if (
    JSON.stringify([...(Array.isArray(actual) ? actual : [])].sort()) !==
    JSON.stringify([...EXPECTED_CAPABILITIES].sort())
  )
    throw new Error(`native_local_plant_seed_${source}_capability_not_isolated`);
}

function validateNativeLocalFixtureConfig(value) {
  const fixture = value?.NativeLocalPlayerFixture;
  if (
    fixture?.Enable !== true ||
    fixture.Bootstrap?.Enable === true ||
    fixture.FixtureScenario !== SCENARIO ||
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
    throw new Error("native_local_plant_seed_action_policy_invalid");
}

function validFixtureSlotRelationship(logicalName, observedSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSlot)
  );
}

function resolveFarmWarp(snapshot) {
  const matches = Array.isArray(snapshot.warps)
    ? snapshot.warps.filter(
        (warp) =>
          warp?.targetLocation === "Farm" &&
          Number.isInteger(warp.sourceX) &&
          Number.isInteger(warp.sourceY) &&
          Number.isInteger(warp.targetX) &&
          Number.isInteger(warp.targetY) &&
          warp.sourceX >= 0 &&
          warp.sourceY >= 0 &&
          warp.targetX >= 0 &&
          warp.targetY >= 0,
      )
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) throw new Error("invalid_plant_seed_evidence");
    const key = part.slice(0, index);
    const value = part.slice(index + 1);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(key) || value.length > 512 || Object.hasOwn(result, key))
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
  return (
    Number.isInteger(left?.x) &&
    Number.isInteger(left?.y) &&
    Number.isInteger(right?.x) &&
    Number.isInteger(right?.y) &&
    Math.abs(left.x - right.x) <= 1 &&
    Math.abs(left.y - right.y) <= 1
  );
}

function summarizeWithSeed(snapshot) {
  return { ...summarizeSnapshot(snapshot), seedTargets: snapshot.seedTargets?.length ?? 0 };
}
