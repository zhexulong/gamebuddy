import {
  assertExactCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  summarizeSnapshot,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

/**
 * Native-local recovery-chain contract for Lane G「体力低下」(low stamina).
 *
 * This mode is deliberately NOT rejection-triggered. `loop-closure-contracts.md`
 * §1.2/§1.5 record that there is no `insufficient_stamina` reasonCode: stamina is a
 * continuous fact, the tool handlers always run, and every tool receipt carries
 * `stamina_before/stamina_after/stamina_delta/expected_stamina_cost`. So the
 * breakpoint here is a READING in the first receipt, not a `rejected` terminal.
 *
 * Chain on one journal, one session, against `native_stamina_recovery_v1` (a Hoe,
 * bare diggable soil, one edible Object, and stamina set low but safely above the
 * native pass-out floor):
 *
 *   1. breakpoint : equip the Hoe, `till_soil` succeeds, and its own receipt proves
 *                   stamina fell to the low band while staying above -15.
 *   2. recovery   : `use_item` eats the edible; its receipt proves stamina rose.
 *   3. resume     : `till_soil` on a DIFFERENT bare tile succeeds.
 *
 * The native pass-out threshold is `timeOfDay >= 2600 || player.stamina <= -15f`
 * (Game1.cs:6452-6460), so every assertion keeps stamina strictly above -15.
 *
 * Request/execution identity correlation is enforced upstream by the shared harness
 * (`executeFresh` validates each receipt against the exact request it submitted).
 *
 * Harness-only chain scenario; it grants no capability and changes no lifecycle.
 */
const SCENARIO = "native_stamina_recovery_v1";
const EXPECTED_ACTIONS = ["move_to_tile", "travel", "equip_tool", "till_soil", "use_item"];
const EXPECTED_CAPABILITIES = [
  "cancel_active_execution",
  "equip_tool",
  "inspect_self",
  "move_to_tile",
  "till_soil",
  "travel",
  "use_item",
].sort();

/** The native pass-out floor. Never assert a stamina value at or below this. */
const PASS_OUT_FLOOR = -15;
/** The low band the fixture's Given places the actor in, and the breakpoint must show. */
const LOW_STAMINA_THRESHOLD = 20;

const BREAKPOINT_REASON = "soil_tilled";
const RECOVERY_REASON = "item_used";
const RESUME_REASON = "soil_tilled";

/** Execute the low-stamina recovery chain against an already-connected bridge session. */
export async function runStaminaRecoveryChainSmoke(
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
    let snapshot = await observeStaminaActionable(client);
    assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);

    // The fixture's declared Given is low stamina. A chain whose breakpoint never
    // happened proves nothing, so refuse before submitting anything.
    if (!Number.isFinite(snapshot.stamina)) throw new Error("stamina_missing_from_snapshot");
    if (snapshot.stamina > LOW_STAMINA_THRESHOLD)
      throw new Error(`recovery_chain_breakpoint_unavailable_stamina_not_low:${snapshot.stamina}`);
    if (snapshot.stamina <= PASS_OUT_FLOOR)
      throw new Error(`recovery_chain_breakpoint_unavailable_below_pass_out_floor:${snapshot.stamina}`);

    const hasHoe = (snapshot.toolSlots ?? []).some(
      (entry) => typeof entry.label === "string" && entry.label.toLowerCase().includes("hoe"),
    );
    if (!hasHoe) throw new Error("hoe_not_found_in_live_tool_slots");

    const equipped = await execute("equip_hoe", "equip_tool", { tool: "hoe" }, snapshot, trace, client);
    const equipTerminal = await waitForTerminal(receipts, equipped, terminalTimeoutMs);
    if (
      equipTerminal.state !== "succeeded" ||
      (equipTerminal.reasonCode !== "tool_equipped" && equipTerminal.reasonCode !== "already_equipped")
    )
      throw new Error(`hoe_equip_failed:${equipTerminal.reasonCode}`);
    snapshot = await observeStaminaActionable(client);
    if (!snapshot.currentTool?.toLowerCase().includes("hoe")) throw new Error("hoe_postcondition_missing");

    if (snapshot.location !== "Farm")
      snapshot = await travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, travelTimeoutMs);
    snapshot = await moveToReachableSoil(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs);
    if (snapshot.actionable !== true || snapshot.activeExecution != null)
      throw new Error(
        `player_not_actionable_after_navigation:location=${snapshot.location};tile=${snapshot.tile?.x},${snapshot.tile?.y};active=${snapshot.activeExecution?.executionId ?? "none"}`,
      );

    // 1. Breakpoint: one real tool action whose receipt shows the stamina drop.
    const breakpointTarget = chooseReachableSoilTile(snapshot);
    if (breakpointTarget === null) throw new Error("no_adjacent_live_soil_tile");
    const breakpointAccepted = await execute("breakpoint_till", "till_soil", breakpointTarget, snapshot, trace, client);
    const breakpoint = await waitForTerminal(receipts, breakpointAccepted, terminalTimeoutMs);
    if (breakpoint.state !== "succeeded" || breakpoint.reasonCode !== BREAKPOINT_REASON)
      throw new Error(
        `recovery_chain_breakpoint_missing:expected=succeeded/${BREAKPOINT_REASON};actual=${breakpoint.state}/${breakpoint.reasonCode}`,
      );
    const breakpointEvidence = parseEvidence(breakpoint.evidence, [
      "after",
      "before",
      "expected_stamina_cost",
      "location",
      "stamina_after",
      "stamina_before",
      "stamina_delta",
      "target",
    ]);
    const staminaBefore = Number(breakpointEvidence.stamina_before);
    const staminaAfterBreakpoint = Number(breakpointEvidence.stamina_after);
    const staminaDropped =
      Number.isFinite(staminaBefore) &&
      Number.isFinite(staminaAfterBreakpoint) &&
      staminaBefore > staminaAfterBreakpoint &&
      staminaAfterBreakpoint <= LOW_STAMINA_THRESHOLD &&
      staminaAfterBreakpoint > PASS_OUT_FLOOR;
    if (!staminaDropped)
      throw new Error(
        `recovery_chain_breakpoint_stamina_not_low:before=${breakpointEvidence.stamina_before};after=${breakpointEvidence.stamina_after}`,
      );
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: breakpoint.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        latest.activeExecution == null &&
        Array.isArray(latest.soilTiles) &&
        !latest.soilTiles.some((entry) => entry?.x === breakpointTarget.x && entry?.y === breakpointTarget.y),
    });

    // 2. Recovery: eat a real edible. `use_item` runs a NATIVE async eating
    //    animation, so the success terminal arrives later, not immediately.
    const food = chooseEdibleSlot(snapshot);
    const recoveryAccepted = await execute(
      "recover_use_item",
      "use_item",
      { slot: food.slot, expectedQualifiedItemId: food.qualifiedItemId },
      snapshot,
      trace,
      client,
    );
    const recovery = await waitForTerminal(receipts, recoveryAccepted, terminalTimeoutMs);
    if (recovery.state !== "succeeded" || recovery.reasonCode !== RECOVERY_REASON)
      throw new Error(`recovery_use_item_failed:${recovery.reasonCode}`);
    const recoveryEvidence = parseEvidence(recovery.evidence, [
      "animation_complete",
      "drink",
      "edibility",
      "item",
      "slot",
      "stack_after",
      "stack_before",
      "stamina_after",
      "stamina_before",
    ]);
    const staminaBeforeEat = Number(recoveryEvidence.stamina_before);
    const staminaAfterEat = Number(recoveryEvidence.stamina_after);
    const stackBeforeEat = Number(recoveryEvidence.stack_before);
    const stackAfterEat = Number(recoveryEvidence.stack_after);
    const foodConsumed =
      recoveryEvidence.item === food.qualifiedItemId &&
      recoveryEvidence.slot === String(food.slot) &&
      recoveryEvidence.animation_complete === "true" &&
      Number.isFinite(stackBeforeEat) &&
      Number.isFinite(stackAfterEat) &&
      stackAfterEat < stackBeforeEat;
    const staminaRestored =
      Number.isFinite(staminaBeforeEat) && Number.isFinite(staminaAfterEat) && staminaAfterEat > staminaBeforeEat;
    if (!foodConsumed) throw new Error("recovery_use_item_not_consumed");
    if (!staminaRestored)
      throw new Error(
        `recovery_use_item_stamina_not_restored:before=${recoveryEvidence.stamina_before};after=${recoveryEvidence.stamina_after}`,
      );
    snapshot = await waitForFreshSnapshot(client, {
      minRevision: recovery.revision,
      timeoutMs: stabilizeTimeoutMs,
      requireActionable: true,
      check: (latest) => Number(latest.stamina) > staminaAfterBreakpoint,
    });

    // 3. Resume: a DIFFERENT bare tile, because the breakpoint tile is now tilled.
    const resumeTarget = chooseReachableSoilTile(snapshot);
    if (resumeTarget === null) throw new Error("no_adjacent_live_soil_tile_for_resume");
    if (resumeTarget.x === breakpointTarget.x && resumeTarget.y === breakpointTarget.y)
      throw new Error("resume_soil_tile_not_distinct_from_breakpoint_tile");
    const resumeAccepted = await execute("resume_till", "till_soil", resumeTarget, snapshot, trace, client);
    const resume = await waitForTerminal(receipts, resumeAccepted, terminalTimeoutMs);
    if (resume.state !== "succeeded" || resume.reasonCode !== RESUME_REASON)
      throw new Error(`resume_till_failed:${resume.reasonCode}`);
    const resumeEvidence = parseEvidence(resume.evidence, [
      "after",
      "before",
      "expected_stamina_cost",
      "location",
      "stamina_after",
      "stamina_before",
      "stamina_delta",
      "target",
    ]);
    const after = await waitForFreshSnapshot(client, {
      minRevision: resume.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
      check: (latest) =>
        latest.activeExecution == null &&
        Array.isArray(latest.soilTiles) &&
        !latest.soilTiles.some((entry) => entry?.x === resumeTarget.x && entry?.y === resumeTarget.y),
    });
    const resumeTargetGone = !after.soilTiles.some(
      (entry) => entry?.x === resumeTarget.x && entry?.y === resumeTarget.y,
    );
    const resumeEvidenceBound =
      resumeEvidence.before === "none" &&
      resumeEvidence.after === "HoeDirt" &&
      resumeEvidence.location === snapshot.location &&
      resumeEvidence.target === `${resumeTarget.x},${resumeTarget.y}`;
    const resumeStaminaStayedSafe = Number(resumeEvidence.stamina_after) > PASS_OUT_FLOOR;
    // Same-journal lineage: three terminals, strictly advancing revision, distinct
    // execution ids. Request identity is correlated by the shared harness.
    const sameJournalLineage =
      Number.isSafeInteger(breakpoint.revision) &&
      Number.isSafeInteger(recovery.revision) &&
      Number.isSafeInteger(resume.revision) &&
      breakpoint.revision < recovery.revision &&
      recovery.revision < resume.revision &&
      typeof breakpoint.executionId === "string" &&
      typeof recovery.executionId === "string" &&
      typeof resume.executionId === "string" &&
      breakpoint.executionId !== recovery.executionId &&
      recovery.executionId !== resume.executionId &&
      breakpoint.executionId !== resume.executionId;
    const passed =
      staminaDropped &&
      foodConsumed &&
      staminaRestored &&
      resumeEvidenceBound &&
      resumeTargetGone &&
      resumeStaminaStayedSafe &&
      sameJournalLineage;
    if (!passed) throw new Error("recovery_chain_postcondition_mismatch");
    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: RESUME_REASON,
      chain: {
        breakpoint: summarizeReceipt(breakpoint),
        recovery: summarizeReceipt(recovery),
        resume: summarizeReceipt(resume),
        contiguousJournal: sameJournalLineage,
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
        resumeReceipt: {
          requestId: resume.requestId,
          executionId: resume.executionId,
          state: resume.state,
          reasonCode: resume.reasonCode,
          revision: resume.revision,
        },
      },
      breakpointTarget,
      resumeTarget,
      food,
      receipt: summarizeReceipt(resume),
      breakpointEvidence,
      recoveryEvidence,
      resumeEvidence,
      staminaDropped,
      foodConsumed,
      staminaRestored,
      resumeTargetGone,
      sameJournalLineage,
      trace,
      before: summarizeStamina(snapshot),
      after: summarizeStamina(after),
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
  // This scenario is newer than the immutable production generation, so the live
  // client must come from the compiled test artifact carrying its protocol fields.
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runStaminaRecoveryChainSmoke(session.client, session.receipts, config);
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

async function travelToFarm(client, receipts, snapshot, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  let fresh = await observeStaminaActionable(client);
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
  const accepted = await execute("travel_to_farm", "travel", { x: warp.sourceX, y: warp.sourceY }, fresh, trace, client);
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

/**
 * Walk onto a bare soil tile. Anchored on the soil target itself rather than the
 * moving actor's tile: a ring re-centred on the actor after every step never
 * converges (a previous chain measured 152 waypoints that way).
 */
async function moveToReachableSoil(client, receipts, snapshot, trace, stabilizeTimeoutMs, moveTimeoutMs) {
  if (chooseReachableSoilTile(snapshot)) return snapshot;
  const first = await waitForSoilInDiscoveryRadius(client, snapshot, stabilizeTimeoutMs);
  if (chooseReachableSoilTile(first)) return first;
  const tile = discoveredSoilTiles(first)[0];
  if (tile === undefined) throw new Error("no_discovered_live_soil_tile");
  const candidates = [
    { x: tile.x, y: tile.y + 1 },
    { x: tile.x, y: tile.y - 1 },
    { x: tile.x + 1, y: tile.y },
    { x: tile.x - 1, y: tile.y },
  ];
  let current = first;
  for (const waypoint of candidates) {
    try {
      const moved = await moveToTile(
        client,
        receipts,
        current,
        waypoint,
        "move_to_native_stamina_fixture",
        trace,
        stabilizeTimeoutMs,
        moveTimeoutMs,
      );
      if (chooseReachableSoilTile(moved)) return moved;
      current = moved;
    } catch (error) {
      const reason = String(error instanceof Error ? error.message : error);
      if (!reason.endsWith("_not_accepted:no_native_path") && !reason.startsWith("navigation_failed:no_native_path"))
        throw error;
      current = await observeFresh(client);
      if (chooseReachableSoilTile(current)) return current;
    }
  }
  throw new Error("no_reachable_native_stamina_fixture_target");
}

async function moveToTile(client, receipts, snapshot, target, phase, trace, stabilizeTimeoutMs, terminalTimeoutMs) {
  const accepted = await execute(phase, "move_to_tile", target, snapshot, trace, client);
  if (accepted.state !== "accepted") throw new Error(`${phase}_not_accepted:${accepted.reasonCode}`);
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "target_reached")
    throw new Error(`${phase}_failed:${terminal.reasonCode}`);
  // `move_to_tile` reports `target_reached` on exact arrival OR on a cardinal
  // adjacent approach (StardewBodyController.cs:129-135), so accept both.
  return waitForFreshSnapshot(client, {
    minRevision: terminal.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) =>
      latest.activeExecution == null &&
      (sameTile(latest.tile, target) || cardinalAdjacent(latest.tile, target)),
  });
}

async function waitForSoilInDiscoveryRadius(client, snapshot, stabilizeTimeoutMs) {
  if (discoveredSoilTiles(snapshot).length > 0) return snapshot;
  return waitForFreshSnapshot(client, {
    minRevision: snapshot.revision,
    timeoutMs: stabilizeTimeoutMs,
    requireActionable: true,
    check: (latest) => discoveredSoilTiles(latest).length > 0 && latest.activeExecution == null,
  });
}

/** The Mod's advertised bare soil tiles, before the Chebyshev-1 action-range filter. */
function discoveredSoilTiles(snapshot) {
  return (snapshot.soilTiles ?? []).filter(
    (tile) => Number.isInteger(tile?.x) && Number.isInteger(tile?.y) && tile.x >= 0 && tile.y >= 0,
  );
}

/** A soil tile the actor can ACT on right now (`till_soil` requires Chebyshev-1). */
function chooseReachableSoilTile(snapshot) {
  return discoveredSoilTiles(snapshot).find((tile) => adjacent(snapshot.tile, tile)) ?? null;
}

/** The single edible Object slot the fixture supplies. The Mod advertises edibles
 * under `foodTargets` (with `edibility`/`isDrink`), not `inventoryItemFacts`. */
function chooseEdibleSlot(snapshot) {
  const candidates = (snapshot.foodTargets ?? []).filter(
    (entry) =>
      Number.isInteger(entry?.slot) &&
      typeof entry.qualifiedItemId === "string" &&
      entry.qualifiedItemId.length > 0 &&
      entry.isDrink === false &&
      Number.isFinite(Number(entry.edibility)) &&
      Number(entry.edibility) > 0,
  );
  if (candidates.length === 0) throw new Error("no_edible_item_in_live_food_targets");
  return { slot: candidates[0].slot, qualifiedItemId: candidates[0].qualifiedItemId };
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
          warp.sourceY >= 0,
      )
    : [];
  if (matches.length !== 1) throw new Error(matches.length ? "ambiguous_farm_warp" : "farm_warp_missing");
  return matches[0];
}

async function observeStaminaActionable(client) {
  const snapshot = await observeFresh(client, { actionable: true });
  assertExactCapabilities(snapshot, EXPECTED_CAPABILITIES);
  if (
    !Number.isInteger(snapshot.revision) ||
    typeof snapshot.location !== "string" ||
    !Number.isInteger(snapshot.tile?.x) ||
    !Number.isInteger(snapshot.tile?.y) ||
    !Array.isArray(snapshot.soilTiles) ||
    !Array.isArray(snapshot.toolSlots) ||
    !Array.isArray(snapshot.foodTargets)
  )
    throw new Error("native_local_stamina_snapshot_invalid");
  return snapshot;
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
    Number.isInteger(target?.x) &&
    Number.isInteger(target?.y) &&
    Math.max(Math.abs(tile.x - target.x), Math.abs(tile.y - target.y)) <= 1
  );
}

function cardinalAdjacent(tile, target) {
  if (!Number.isInteger(tile?.x) || !Number.isInteger(tile?.y)) return false;
  return Math.abs(tile.x - target.x) + Math.abs(tile.y - target.y) === 1;
}

function sameTile(left, right) {
  return Number.isInteger(left?.x) && Number.isInteger(left?.y) && left.x === right?.x && left.y === right?.y;
}

function summarizeStamina(snapshot) {
  return {
    ...summarizeSnapshot(snapshot),
    stamina: snapshot.stamina ?? null,
    soilTiles: snapshot.soilTiles?.length ?? 0,
  };
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
  if (value.ActionPolicyVersion !== 0 || JSON.stringify(value.EnabledActions) !== JSON.stringify(EXPECTED_ACTIONS))
    throw new Error("native_local_stamina_action_policy_invalid");
}

function validFixtureSlotRelationship(logicalName, observedSaveSlot) {
  return (
    typeof logicalName === "string" &&
    /^GameBuddyFixture[A-Za-z0-9]{0,64}$/.test(logicalName) &&
    typeof observedSaveSlot === "string" &&
    new RegExp(`^${logicalName}_[0-9]{1,32}$`).test(observedSaveSlot)
  );
}
