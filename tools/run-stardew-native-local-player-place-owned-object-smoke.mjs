// Stardew-local place-owned-object smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait, and owned teardown
// all come from the shared harness. Action-specific logic (which published target,
// what the receipt must have observed, and the negative cases) stays in this runner.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "place_owned_object";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/** The fixture's placeable bigCraftable: a tapper, i.e. the absorbed `place_tapper` case. */
const PLACEABLE_ITEM_ID = "(BC)105";

/**
 * place_owned_object live contract.
 *
 * The receipt is not the proof. Four things are observed directly:
 *   1. the target tile and the item come from the Mod's own `worldObjectTargets`
 *      projection, never from this runner;
 *   2. the tile is a TREE tile and the native tapper branch ran: the receipt's
 *      `terrain_feature=Tree` + `terrain_feature_tapped=true` are the observed effect of
 *      `Object.placementAction`'s tapper branch, which is the only branch that flips a
 *      tree's `tapped` flag. A tile that cannot be placed on is never advertised, so a
 *      published `placement_candidate` for a tapper can only be a tappable tree;
 *   3. the object EXISTS on the tile afterwards, re-read from a fresh snapshot (not from
 *      the receipt);
 *   4. resubmitting the SAME target is REFUSED and the world does not move — the tile
 *      is occupied now, and the native branch would either add nothing (same item id) or
 *      destroy the object that is there (different item id). A second success, or a
 *      silent no-op reported as success, fails the run.
 *
 * The negative cases are the two failure modes a caller can actually produce here: a
 * stale target against an occupied tile, and a request naming a slot that does not hold
 * the item it claims.
 */
export async function runPlaceOwnedObjectSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 5_000, postconditionTimeoutMs = 5_000 } = {},
) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    if (!Number.isSafeInteger(snapshot.inventorySlots) || snapshot.inventorySlots < 2)
      throw new Error(`place_owned_object_inventory_too_small:${snapshot.inventorySlots ?? "missing"}`);
    const target = choosePlacementTarget(snapshot, PLACEABLE_ITEM_ID);

    const requestId = `native_local_place_owned_object_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        x: target.x,
        y: target.y,
        slot: target.slot,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot,
      timeoutMs: 30_000,
    });
    // The native work can settle inside the request, in which case the response IS the
    // terminal; `waitForTerminal` accepts either shape and always asserts the identity.
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    trace.push({ step: "place", action: ACTION, target: target.targetId, receipt: summarizeReceipt(terminal) });
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "owned_object_placed")
      throw new Error(
        `place_owned_object_failed:${terminal.state}/${terminal.reasonCode};tile=${target.x},${target.y};slot=${target.slot};item=${target.qualifiedItemId};candidates=${describeCandidates(snapshot)}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "terrain_feature", "Tree");
    assertEvidence(evidence, "terrain_feature_tapped", "true");
    assertEvidence(evidence, "object_present", "true");
    assertEvidence(evidence, "native_placement", "true");
    assertEvidence(evidence, "placed_qualified_item_id", target.qualifiedItemId);
    const inventoryBefore = Number(evidence.inventory_before);
    const inventoryAfter = Number(evidence.inventory_after);
    if (!Number.isSafeInteger(inventoryBefore) || inventoryAfter !== inventoryBefore - 1)
      throw new Error(`place_owned_object_inventory_not_consumed:${inventoryBefore}->${inventoryAfter}`);

    // The world change, re-read after the terminal: the tile now holds an object with the
    // expected identity, and the placement candidate that named it is gone.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const placed = existingObjectAt(after, target.x, target.y);
    if (placed.qualifiedItemId !== target.qualifiedItemId)
      throw new Error(`place_owned_object_world_identity_wrong:${placed.qualifiedItemId}:${target.qualifiedItemId}`);
    if (placementCandidateAt(after, target.x, target.y, PLACEABLE_ITEM_ID) != null)
      throw new Error(`place_owned_object_stale_candidate_republished:${target.x},${target.y}`);

    // Negative 1: the same target against a tile that now holds the object. The native
    // branch would add nothing (same item id) or destroy what is there (different item
    // id), so this must be a named refusal with the world unchanged.
    const staleRequestId = `native_local_place_owned_object_stale_${Date.now()}`;
    const staleAccepted = await executeFresh(client, {
      requestId: staleRequestId,
      idempotencyKey: `${staleRequestId}_idem`,
      action: ACTION,
      args: {
        x: target.x,
        y: target.y,
        slot: target.slot,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot: after,
      timeoutMs: 30_000,
    });
    const staleTerminal = await waitForTerminal(receipts, staleAccepted, terminalTimeoutMs);
    trace.push({ step: "place_occupied_tile", action: ACTION, target: target.targetId, receipt: summarizeReceipt(staleTerminal) });
    if (staleTerminal.state !== "rejected" || staleTerminal.reasonCode !== "place_owned_object_tile_occupied")
      throw new Error(
        `place_owned_object_occupied_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode};tile=${target.x},${target.y};slot=${target.slot}`,
      );

    const unchanged = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(unchanged, REQUIRED_CAPABILITIES);
    const stillPlaced = existingObjectAt(unchanged, target.x, target.y);
    if (stillPlaced.targetId !== placed.targetId)
      throw new Error(`place_owned_object_occupied_moved_world:${stillPlaced.targetId}:${placed.targetId}`);

    // Negative 2: the same target named through a slot that does not hold that item. The
    // identity alone cannot save this request — the Mod refuses the value it can see.
    const wrongSlot = target.slot === 0 ? 1 : 0;
    const wrongSlotRequestId = `native_local_place_owned_object_wrong_slot_${Date.now()}`;
    const wrongSlotAccepted = await executeFresh(client, {
      requestId: wrongSlotRequestId,
      idempotencyKey: `${wrongSlotRequestId}_idem`,
      action: ACTION,
      args: {
        x: target.x,
        y: target.y,
        slot: wrongSlot,
        expectedQualifiedItemId: target.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot: unchanged,
      timeoutMs: 30_000,
    });
    const wrongSlotTerminal = await waitForTerminal(receipts, wrongSlotAccepted, terminalTimeoutMs);
    trace.push({ step: "place_wrong_slot", action: ACTION, slot: wrongSlot, receipt: summarizeReceipt(wrongSlotTerminal) });
    if (wrongSlotTerminal.state !== "rejected" || wrongSlotTerminal.reasonCode !== "place_owned_object_not_owned_in_slot")
      throw new Error(
        `place_owned_object_wrong_slot_not_refused:${wrongSlotTerminal.state}/${wrongSlotTerminal.reasonCode};slot=${wrongSlot};item=${target.qualifiedItemId}`,
      );

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "owned_object_placed",
      target: target.targetId,
      tile: { x: target.x, y: target.y },
      item: target.qualifiedItemId,
      placed: placed.targetId,
      negative: {
        occupied: staleTerminal.reasonCode,
        wrongSlot: wrongSlotTerminal.reasonCode,
      },
      evidence,
      receipt: summarizeReceipt(terminal),
      trace,
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

/** The fixture's placeable-item candidate, from the Mod's own projection. */
function choosePlacementTarget(snapshot, qualifiedItemId) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null) throw new Error("place_owned_object_no_world_object_projection");
  if (!Array.isArray(entries)) throw new Error("place_owned_object_world_object_projection_malformed");
  const candidates = entries.filter((entry) => isProjectionEntry(entry) && entry.kind === "placement_candidate" && entry.qualifiedItemId === qualifiedItemId);
  if (candidates.length === 0)
    throw new Error(`place_owned_object_declared_given_absent:item=${qualifiedItemId};candidates=${describeCandidates(snapshot)}`);
  const target = candidates[0];
  if (!Number.isSafeInteger(target.slot) || target.slot < 0)
    throw new Error(`place_owned_object_candidate_slot_missing:${target.targetId};slot=${target.slot}`);
  return target;
}

function placementCandidateAt(snapshot, x, y, qualifiedItemId) {
  return (snapshot.worldObjectTargets ?? []).find(
    (entry) => isProjectionEntry(entry) && entry.kind === "placement_candidate" && entry.x === x && entry.y === y && entry.qualifiedItemId === qualifiedItemId,
  );
}

/** The object the world now reports on that tile, or a named failure. */
function existingObjectAt(snapshot, x, y) {
  const entry = (snapshot.worldObjectTargets ?? []).find(
    (candidate) => isProjectionEntry(candidate) && candidate.kind !== "placement_candidate" && candidate.x === x && candidate.y === y,
  );
  if (entry == null) throw new Error(`place_owned_object_world_object_missing:${x},${y};candidates=${describeCandidates(snapshot)}`);
  return entry;
}

/** Loose optional-member rule: the Mod omits null members, so absent means absent, not null. */
function isProjectionEntry(entry) {
  return (
    entry != null &&
    typeof entry.targetId === "string" &&
    entry.targetId.length > 0 &&
    Number.isSafeInteger(entry.x) &&
    Number.isSafeInteger(entry.y) &&
    typeof entry.kind === "string" &&
    typeof entry.qualifiedItemId === "string" &&
    Number.isSafeInteger(entry.slot)
  );
}

function describeCandidates(snapshot) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null) return "none";
  if (!Array.isArray(entries)) return "malformed";
  return entries.map((entry) => `${entry?.kind ?? "?"}:${entry?.qualifiedItemId ?? "?"}@${entry?.x ?? "?"},${entry?.y ?? "?"}`).join("|") || "empty";
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`place_owned_object_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function parseEvidence(evidence) {
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
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runPlaceOwnedObjectSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
