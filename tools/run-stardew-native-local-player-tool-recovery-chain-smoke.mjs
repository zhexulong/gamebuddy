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

/**
 * Native-local recovery-chain contract for Lane G「工具缺手」.
 *
 * Drives one full Agent recovery loop inside a single game session against the
 * identical `native_till_soil_v1` fixture (a Hoe in inventory, bare diggable
 * soil, default non-Hoe tool):
 *
 *   1. breakpoint : till_soil without equipping the Hoe
 *                   -> terminal `rejected/hoe_not_equipped` (deterministic,
 *                      no native mutation; the fixture defaults to a non-Hoe
 *                      current tool).
 *   2. recovery   : equip_tool { tool: "hoe" } -> `succeeded/tool_equipped`
 *   3. retry      : till_soil on the SAME target -> `succeeded/soil_tilled`
 *                   (same-execution evidence + fresh target-gone postcondition)
 *
 * All three receipts come from the same journal (same connect session), each
 * with its own requestId/executionId and monotonically advancing revision.
 * Prerequisite travel/movement receipts are separate and never attributed to
 * the action under evaluation.
 *
 * This is a harness-only chain scenario; it grants no capability and does not
 * change any action lifecycle.
 */
const SCENARIO = "native_till_soil_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "till_soil"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "travel",
  "till_soil",
].sort();

const BREAKPOINT_REASON = "hoe_not_equipped";
const RECOVERY_ACTION = "equip_tool";
const RECOVERY_REASON = "tool_equipped";
const RETRY_REASON = "soil_tilled";

/** Execute the tool-recovery chain against an already-connected bridge session. */
export async function runToolRecoveryChainSmoke(
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
    let snapshot = await observeFresh(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
    const hasHoe = (snapshot.toolSlots ?? []).some(
      (entry) => typeof entry.label === "string" && entry.label.toLowerCase().includes("hoe"),
    );
    if (!hasHoe) throw new Error("hoe_not_found_in_live_tool_slots");
    const currentNormalized = String(snapshot.currentTool ?? "").toLowerCase();
    // The fixture's documented default current tool is not the Hoe, so the
    // breakpoint below is deterministic. Fail closed on template drift rather
    // than silently producing a chain with no rejection.
    if (currentNormalized.includes("hoe"))
      throw new Error("recovery_chain_breakpoint_unavailable_hoe_already_equipped");
    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await moveToReachableSoil(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error(
        `player_not_actionable_after_navigation:location=${snapshot.location};tile=${snapshot.tile?.x},${snapshot.tile?.y};active=${snapshot.activeExecution?.state ?? "none"}`,
      );
    const target = chooseReachableSoilTile(snapshot);
    if (target === null) throw new Error("no_adjacent_live_soil_tile");
    if (
      snapshot.location !== "Farm" ||
      !snapshot.soilTiles.some((entry) => entry.x === target.x && entry.y === target.y)
    )
      throw new Error("till_before_snapshot_target_not_bound");

    // 1. Breakpoint: till_soil before equipping the Hoe -> deterministic
    //    rejection before any native ingress.
    const breakpointAccepted = await execute(
      "breakpoint_till",
      "till_soil",
      target,
      snapshot,
      trace,
      client,
    );
    const breakpoint = await waitForTerminal(receipts, breakpointAccepted, terminalTimeoutMs);
    if (breakpoint.state !== "rejected" || breakpoint.reasonCode !== BREAKPOINT_REASON)
      throw new Error(
        `recovery_chain_breakpoint_missing:expected=rejected/${BREAKPOINT_REASON};actual=${breakpoint.state}/${breakpoint.reasonCode}`,
      );
    // The rejection is a side-effect-free terminal at `breakpoint.revision`; the
    // pre-rejection snapshot is stale by definition. Re-observe at or past that
    // revision before any recovery request, never reuse the old snapshot.
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: breakpoint.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => String(latest.currentTool ?? "").toLowerCase().includes("hoe") === false,
    });

    // 2. Recovery: equip the Hoe. Same journal, its own identity.
    const recoveryAccepted = await execute("recover_tool", RECOVERY_ACTION, { tool: "hoe" }, snapshot, trace, client);
    const recovery = await waitForTerminal(receipts, recoveryAccepted, terminalTimeoutMs);
    if (recovery.state !== "succeeded" || (recovery.reasonCode !== "tool_equipped" && recovery.reasonCode !== "already_equipped"))
      throw new Error(`recovery_equip_failed:${recovery.reasonCode}`);
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: recovery.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => String(latest.currentTool ?? "").toLowerCase().includes("hoe"),
    });

    // 3. Retry the same target -> authoritative succeeded receipt.
    const retryAccepted = await execute("retry_till", "till_soil", target, snapshot, trace, client);
    const retry = await waitForTerminal(receipts, retryAccepted, terminalTimeoutMs);
    if (retry.state !== "succeeded" || retry.reasonCode !== RETRY_REASON)
      throw new Error(`retry_till_failed:${retry.reasonCode}`);
    const evidence = parseStrictEvidence(retry.evidence);
    const after = await waitForStableRevision(client, {
      revision: retry.revision,
      timeoutMs: postconditionTimeoutMs,
      check: (latest) =>
        latest.actionable === true &&
        latest.activeExecution == null &&
        latest.location === snapshot.location &&
        sameTile(latest.tile, snapshot.tile) &&
        Array.isArray(latest.soilTiles),
    });
    const evidenceTarget = parseTargetCoordinates(evidence.target);
    const freshTargetGone =
      Array.isArray(after.soilTiles) &&
      !after.soilTiles.some((entry) => entry?.x === target.x && entry?.y === target.y);
    const passed =
      evidence.location === snapshot.location &&
      evidenceTarget.x === target.x &&
      evidenceTarget.y === target.y &&
      evidence.before === "none" &&
      evidence.after === "HoeDirt" &&
      after.revision === retry.revision &&
      after.actionable === true &&
      after.activeExecution == null &&
      after.location === snapshot.location &&
      sameTile(after.tile, snapshot.tile) &&
      freshTargetGone &&
      // Same-journal lineage: the three chain receipts share the session; the
      // reject (side-effect free) and the two mutations each advance revision.
      Number.isSafeInteger(breakpoint.revision) &&
      Number.isSafeInteger(recovery.revision) &&
      Number.isSafeInteger(retry.revision) &&
      breakpoint.revision < recovery.revision &&
      recovery.revision < retry.revision &&
      breakpoint.executionId !== recovery.executionId &&
      recovery.executionId !== retry.executionId;
    if (!passed) throw new Error("recovery_chain_postcondition_mismatch");
    return {
      state: "passed",
      reasonCode: RETRY_REASON,
      chain: {
        breakpoint: summarizeReceipt(breakpoint),
        recovery: summarizeReceipt(recovery),
        retry: summarizeReceipt(retry),
        contiguousJournal: true,
        breakpointReceipt: {
          requestId: breakpoint.requestId,
          executionId: breakpoint.executionId,
          state: breakpoint.state,
          reasonCode: breakpoint.reasonCode,
          revision: breakpoint.revision,
        },
        recoveryReceipt: {
          requestId: recovery.requestId,
          executionId: recovery.executionId,
          state: recovery.state,
          reasonCode: recovery.reasonCode,
          revision: recovery.revision,
        },
        retryReceipt: {
          requestId: retry.requestId,
          executionId: retry.executionId,
          state: retry.state,
          reasonCode: retry.reasonCode,
          revision: retry.revision,
        },
      },
      target,
      receipt: summarizeReceipt(retry),
      evidence,
      evidenceTarget,
      freshTargetGone,
      trace,
      before: summarizeWithSoil(snapshot),
      after: summarizeWithSoil(after),
      durationMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      state: "blocked",
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
    const result = await runToolRecoveryChainSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

async function execute(phase, action, args, snapshot, trace, client) {
  if (snapshot.actionable !== true || snapshot.activeExecution != null)
    throw new Error(`${phase}_player_not_actionable`);
  const nonce = `${Date.now()}_${trace.length}`;
  const requestId = `native_local_chain_${phase}_${nonce}`;
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
async function moveToReachableSoil(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseReachableSoilTile(snapshot)) return snapshot;
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
          "move_to_native_till_fixture_ground",
          trace,
          stabilizeTimeoutMs,
          moveTimeoutMs,
        );
        if (chooseReachableSoilTile(moved)) return moved;
        snapshot = moved;
      } catch (error) {
        const reason = String(error instanceof Error ? error.message : error);
        if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
          throw error;
        snapshot = await observeFresh(client);
        if (chooseReachableSoilTile(snapshot)) return snapshot;
      }
    }
  }
  throw new Error("no_reachable_native_till_fixture_ground");
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
  const accepted = await execute("travel", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh, trace, client);
  if (accepted.state !== "accepted") throw new Error(`travel_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "travel_completed")
    throw new Error(`travel_failed:${terminal.reasonCode}`);
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => latest.location === "Farm",
  });
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
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
    check: (latest) => adjacent(latest.tile, target),
  });
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

function sameTile(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y;
}

function chooseReachableSoilTile(snapshot) {
  return (
    snapshot.soilTiles?.find(
      (tile) => Number.isInteger(tile.x) && Number.isInteger(tile.y) && adjacent(snapshot.tile, tile),
    ) ?? null
  );
}
function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  const expected = ["location", "target", "before", "after", "stamina_before", "stamina_after", "stamina_delta", "expected_stamina_cost"];
  const result = {};
  for (const part of detail.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0 || index === part.length - 1) return {};
    const key = part.slice(0, index);
    if (Object.hasOwn(result, key)) return {};
    result[key] = part.slice(index + 1);
  }
  return Object.keys(result).length === expected.length && expected.every((key) => Object.hasOwn(result, key))
    ? result
    : {};
}
function parseTargetCoordinates(value) {
  const match = typeof value === "string" ? value.match(/^(\d+),(\d+)$/) : null;
  if (!match) return { x: null, y: null };
  return { x: Number(match[1]), y: Number(match[2]) };
}
function summarizeWithSoil(snapshot) {
  return { ...summarizeSnapshot(snapshot), soilTiles: snapshot.soilTiles?.length ?? 0 };
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
  // Isolation matches the Mod's own runtime check (`ModEntry.OnGameLaunched`,
  // which validates only the three Mod-owned topology keys). `Portfolio` is not
  // a C# `ModConfig` property, so a Mod `WriteConfig` legitimately drops it;
  // judging it mandatory would reject a fresh game read for a reason the action
  // cannot fix. Presence with a truthy Enable still fails closed.
  if (
    value.HostAutomation?.Enable === true ||
    value.HostFarmhandProvisioning?.Enable === true ||
    value.FarmhandProvisioner?.Enable === true ||
    (value.Portfolio?.Enable === true)
  )
    throw new Error(
      `native_local_fixture_topology_not_isolated:${JSON.stringify({
        portfolio: value.Portfolio?.Enable,
        hostAutomation: value.HostAutomation?.Enable,
        hostFarmhand: value.HostFarmhandProvisioning?.Enable,
        farmhandProvisioner: value.FarmhandProvisioner?.Enable,
        apiVersion: value.ActionPolicyVersion,
      })}`,
    );
  if (
    value.ActionPolicyVersion !== 0 ||
    JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS) ||
    JSON.stringify(value.ExperimentalActions ?? []) !== JSON.stringify([])
  )
    throw new Error("native_local_till_soil_action_policy_invalid");
}
function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}