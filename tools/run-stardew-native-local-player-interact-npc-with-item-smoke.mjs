import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";

const ACTION = "interact_npc_with_item";
const SCENARIO = "native_interact_npc_with_item_v1";
const GIFT_ITEM_ID = "(O)190";
const DELIVERY_QUEST_NUMBER = 1;
const DELIVERY_FRIENDSHIP_AMOUNT = 255;
const REQUIRED_CAPABILITIES = [
  "cancel_active_execution",
  "inspect_self",
  "move_to_tile",
  "travel",
  ACTION,
];

/**
 * Execute the interact_npc_with_item contract against an already-connected
 * bridge session.
 *
 * The fixture's declared Given includes one active native ItemDeliveryQuest
 * binding Jodi to the carried item, and the native ingress offers the item to
 * pending delivery quests before any gift handling. The successful terminal is
 * therefore the delivery (quest_item_delivered), not the ordinary gift path.
 */
export async function runInteractNpcWithItemSmoke(
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
  try {
    let snapshot = await freshActionableSnapshot(client, undefined, stabilizeTimeoutMs);
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (snapshot.location !== "FarmHouse") throw new Error("npc_offer_route_must_start_at_farmhouse");
    snapshot = await travelFreshHop(client, receipts, trace, snapshot, "FarmHouse", "Farm", "farmhouse_to_farm", stabilizeTimeoutMs, travelTimeoutMs);
    let target = chooseOnlyNpcTarget(snapshot);
    if (!adjacent(snapshot.tile, target)) {
      snapshot = await moveToLiveTarget(client, receipts, trace, target, "move_to_npc_gift_fixture", stabilizeTimeoutMs, moveTimeoutMs);
      target = chooseOnlyNpcTarget(snapshot);
    }
    if (!adjacent(snapshot.tile, target)) throw new Error("npc_offer_fixture_target_unreachable");
    const slot = chooseGiftSlot(snapshot);

    const requestId = `native_local_npc_offer_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        slot,
        x: target.x,
        y: target.y,
        expectedQualifiedItemId: GIFT_ITEM_ID,
        expectedTargetId: target.targetId,
      },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ action: ACTION, target: target.targetId, receipt: summarizeReceipt(accepted) });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.executionId !== accepted.executionId || terminal.requestId !== requestId)
      throw new Error("npc_offer_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "quest_item_delivered")
      throw new Error(`npc_offer_failed:${terminal.state}:${terminal.reasonCode}`);
    const evidence = parseStrictEvidence(terminal.evidence);
    const after = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: postconditionTimeoutMs,
      requireActionable: true,
    });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    // questComplete keeps a rewarded quest in the log and removes an unrewarded
    // one (Quest.decompiled.cs:622-629), so the completed-entry delta follows the
    // receipt's stays-in-log report while the quest's own completed flag is the
    // completion proof. The fixture quest is unrewarded and is removed.
    const staysInLog = evidence.quest_stays_in_log === "true";
    const completedEntryDeltaOk =
      Number(evidence.completed_quests_after) === Number(evidence.completed_quests_before) + (staysInLog ? 1 : 0);
    const passed =
      evidence.target === target.targetId &&
      evidence.item === GIFT_ITEM_ID &&
      evidence.quest_target === "Jodi" &&
      evidence.quest_item === GIFT_ITEM_ID &&
      evidence.quest_number === String(DELIVERY_QUEST_NUMBER) &&
      evidence.quest_daily === "false" &&
      evidence.quest_completed_before === "false" &&
      evidence.quest_completed_after === "true" &&
      evidence.friendship_amount === String(DELIVERY_FRIENDSHIP_AMOUNT) &&
      completedEntryDeltaOk &&
      Number(evidence.stack_after) === Number(evidence.stack_before) - DELIVERY_QUEST_NUMBER &&
      Number(evidence.points_after) === Number(evidence.points_before) + DELIVERY_FRIENDSHIP_AMOUNT &&
      evidence.showed_response === "false" &&
      evidence.menu_open_after === "false" &&
      evidence.dialogue_open_after === "false";
    return {
      state: passed ? "passed" : "blocked",
      topology: "native_local_player_fixture",
      reasonCode: passed ? "quest_item_delivered" : "npc_offer_postcondition_mismatch",
      target: { targetId: target.targetId, x: target.x, y: target.y, npcName: target.npcName, slot },
      receipt: summarizeReceipt(terminal),
      evidence,
      trace,
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

async function travelFreshHop(client, receipts, trace, snapshot, expectedOrigin, expectedLocation, phase, stabilizeTimeoutMs, travelTimeoutMs) {
  if (snapshot.location !== expectedOrigin) throw new Error(`${phase}_origin_changed`);
  const travelled = await travelToLocation(client, receipts, trace, snapshot, expectedLocation, {
    phase,
    expectedOrigin,
    stabilizeTimeoutMs,
    terminalTimeoutMs: travelTimeoutMs,
  });
  return travelled.snapshot;
}

async function travelToLocation(client, receipts, trace, snapshot, expectedLocation, { phase, expectedOrigin, stabilizeTimeoutMs, terminalTimeoutMs } = {}) {
  if (snapshot.location !== expectedOrigin) throw new Error(`${phase}_origin_changed`);
  let fresh = await waitForActionable(client, snapshot, stabilizeTimeoutMs);
  let warp = chooseNearestLiveWarp(fresh, expectedLocation, phase);
  if (!adjacent(fresh.tile, warpSource(warp))) {
    fresh = await moveToTile(client, receipts, trace, fresh, warpSource(warp), { phase, stabilizeTimeoutMs, terminalTimeoutMs });
  }
  fresh = await waitForActionable(client, fresh, stabilizeTimeoutMs);
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
    check: (latest) => latest.location === expectedLocation,
  });
  return { snapshot: after };
}

async function moveToLiveTarget(client, receipts, trace, target, phase, stabilizeTimeoutMs, moveTimeoutMs) {
  const snapshot = await freshActionableSnapshot(client, undefined, stabilizeTimeoutMs);
  const current = validNpcTargets(snapshot).find((entry) => entry.targetId === target.targetId);
  if (!current) throw new Error(`${phase}_target_changed`);
  const approach = nearestCardinalApproach(snapshot.tile, current);
  await moveToTile(client, receipts, trace, snapshot, approach, {
    phase,
    stabilizeTimeoutMs,
    terminalTimeoutMs: moveTimeoutMs,
    check: (fresh) => adjacent(fresh.tile, current),
  });
  return freshActionableSnapshot(client, undefined, stabilizeTimeoutMs);
}

async function freshActionableSnapshot(client, seed, stabilizeTimeoutMs) {
  // A solicited observe whose snapshot repeats the admitted revision is
  // rejected by design (stale-duplicate guard), and travel/move receipts can
  // leave the cached revision current. Use the harness's tolerant actionable
  // wait instead of a strict one-shot observe, exactly like the sibling
  // native-local runners.
  const snapshot = await waitForActionable(client, seed ?? client.state?.snapshot, stabilizeTimeoutMs);
  if (!Array.isArray(snapshot.warps) || !Array.isArray(snapshot.npcRelationshipTargets))
    throw new Error("native_local_npc_offer_snapshot_invalid");
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

async function execute(phase, action, args, snapshot, trace, client) {
  const requestId = `${phase}_${Date.now()}`;
  const receipt = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ action, receipt: summarizeReceipt(receipt) });
  return receipt;
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
    typeof warp.targetLocation === "string" &&
    warp.targetLocation.length > 0
  );
}

function chooseNearestLiveWarp(snapshot, expectedLocation, phase) {
  const matches = snapshot.warps.filter((warp) => validWarp(warp) && warp.targetLocation === expectedLocation);
  if (matches.length === 0) throw new Error(`${phase}_live_warp_missing`);
  if (matches.length === 1) return matches[0];
  const ranked = matches
    .map((warp) => ({ warp, distance: Math.abs(snapshot.tile.x - warp.sourceX) + Math.abs(snapshot.tile.y - warp.sourceY) }))
    .sort((left, right) => left.distance - right.distance);
  if (ranked[0].distance === ranked[1].distance) throw new Error(`${phase}_live_warp_ambiguous`);
  return ranked[0].warp;
}

function validNpcTargets(snapshot) {
  return snapshot.npcRelationshipTargets.filter(
    (target) =>
      typeof target?.targetId === "string" &&
      /^npc_relationship_[a-f0-9]{16}$/.test(target.targetId) &&
      Number.isInteger(target.x) &&
      Number.isInteger(target.y) &&
      typeof target.npcName === "string" &&
      target.npcName.length > 0,
  );
}

function chooseOnlyNpcTarget(snapshot) {
  const targets = validNpcTargets(snapshot);
  if (targets.length !== 1)
    throw new Error(targets.length === 0 ? "no_fresh_npc_offer_target" : "ambiguous_fresh_npc_offer_targets");
  const target = targets[0];
  if (target.npcName !== "Jodi" || target.giftsToday !== 0 || target.giftsThisWeek !== 0)
    throw new Error("npc_offer_fixture_starting_state_mismatch");
  return target;
}

function chooseGiftSlot(snapshot) {
  const matches = (snapshot.inventoryItemFacts ?? []).filter((fact) => fact?.qualifiedItemId === GIFT_ITEM_ID && fact.stack >= 1);
  if (matches.length !== 1) throw new Error(`npc_offer_item_slot_expected_1_got_${matches.length}`);
  return matches[0].slot;
}

function nearestCardinalApproach(tile, target) {
  const candidates = [
    { x: target.x, y: target.y + 1 },
    { x: target.x, y: target.y - 1 },
    { x: target.x - 1, y: target.y },
    { x: target.x + 1, y: target.y },
  ];
  const ranked = candidates
    .map((candidate) => ({ candidate, distance: Math.abs(tile.x - candidate.x) + Math.abs(tile.y - candidate.y) }))
    .sort((left, right) => left.distance - right.distance);
  return ranked[0].candidate;
}

function adjacent(left, right) {
  return Math.max(Math.abs(left.x - right.x), Math.abs(left.y - right.y)) <= 1;
}

function parseStrictEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(
    detail
      .split(";")
      .map((pair) => {
        const index = pair.indexOf("=");
        return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
      })
      .filter(Boolean),
  );
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config);
  try {
    const result = await runInteractNpcWithItemSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}

export { ACTION as INTERACT_NPC_WITH_ITEM_ACTION, SCENARIO as INTERACT_NPC_WITH_ITEM_FIXTURE_SCENARIO };
