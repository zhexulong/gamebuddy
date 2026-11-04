// Stardew-local move-placed-furniture smoke: production native client, bounded scope,
// revision-bound requests, exact receipt identity, terminal wait and owned teardown all come
// from the shared harness. Action-specific logic (which published piece, what the receipt must
// have observed, and what the fresh world must say) stays here.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFreshAfterReobserve,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "move_placed_furniture";
/** The Mod's own `worldObjectTargets` kind for a piece standing in `location.furniture`. */
const FURNITURE_KIND = "placed_furniture";
const TERMINAL_REASON = "placed_furniture_picked_up";
const INVENTORY_FULL_REASON = "move_placed_furniture_inventory_full";
/**
 * The identity `BuildPlacedFurnitureTargetId` mints: a fixed prefix and the first 16 lowercase hex
 * characters of a SHA-256 over location, tile and item.
 */
const FURNITURE_TARGET_ID = /^placed_furniture_[0-9a-f]{16}$/u;
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * move_placed_furniture live contract.
 *
 * The receipt is not the proof. Four things are observed directly:
 *   1. the piece comes from the Mod's own `worldObjectTargets` projection with kind
 *      `placed_furniture`, so this runner never invents a tile;
 *   2. its id carries `BuildPlacedFurnitureTargetId`'s own grammar, and the Mod re-derives that id
 *      on the game thread before it lifts anything - an id from anywhere else is refused there by
 *      name (`move_placed_furniture_target_changed`), so a succeeded receipt IS the agreement of
 *      the published id and the live one;
 *   3. the piece is GONE from `location.furniture` in a FRESH snapshot, not merely reported gone;
 *   4. the backpack GAINED that exact qualified item id, read from the receipt's postcondition -
 *      `carried` plus the `inventory_before`/`inventory_after` count the Mod takes by re-reading the
 *      pack after the native call. A full pack is a refusal (`..._inventory_full`) and fails this
 *      slice; it is never a pass.
 */
export async function runMovePlacedFurnitureSmoke(client, receipts, { terminalTimeoutMs = 30_000 } = {}) {
  const trace = [];
  try {
    const opening = await observeFresh(client);
    assertRequiredCapabilities(opening, REQUIRED_CAPABILITIES);
    // A just-loaded save settles the actor into a body before the world is actionable, and the pickup
    // admission refuses a non-actionable actor; waiting here is the difference between "not yet" and a
    // blocker that names the world instead of the action.
    const before = await waitForActionable(client, opening, 30_000);
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const target = choosePublishedPiece(before);

    const requestId = `native_local_move_placed_furniture_${Date.now()}`;
    const accepted = await executeFreshAfterReobserve(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      timeoutMs: 30_000,
    });
    // The pickup is synchronous: the Mod answers with the TERMINAL receipt in the same response, so the
    // immediate state is already `succeeded` (or a named refusal) and there is no `accepted` leg to require.
    trace.push({
      step: "move_placed_furniture",
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      receipt: summarizeReceipt(accepted),
    });

    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    trace.push({ step: "terminal", receipt: summarizeReceipt(terminal) });
    const evidence = parseEvidence(terminal.evidence);
    if (terminal.reasonCode === INVENTORY_FULL_REASON)
      throw new Error(
        `move_placed_furniture_inventory_full_is_not_a_pass:target=${target.targetId};item=${target.qualifiedItemId};` +
          `restored=${evidence.restored ?? "missing"};inventory_slots=${evidence.inventory_slots ?? "missing"}`,
      );
    if (terminal.state !== "succeeded" || terminal.reasonCode !== TERMINAL_REASON)
      throw new Error(
        `move_placed_furniture_failed:${terminal.state}/${terminal.reasonCode};target=${target.targetId};` +
          `tile=${target.x},${target.y};item=${target.qualifiedItemId}`,
      );

    assertEvidence(evidence, "target", target.targetId);
    assertEvidence(evidence, "item", target.qualifiedItemId);
    assertEvidence(evidence, "tile", `${target.x},${target.y}`);
    assertEvidence(evidence, "native_stored", "true");
    assertEvidence(evidence, "removed_from_furniture", "true");
    assertEvidence(evidence, "carried", "true");
    const carriedBefore = Number(evidence.inventory_before);
    const carriedAfter = Number(evidence.inventory_after);
    if (
      !Number.isSafeInteger(carriedBefore) ||
      !Number.isSafeInteger(carriedAfter) ||
      carriedAfter !== carriedBefore + 1
    )
      throw new Error(
        `move_placed_furniture_backpack_delta:${evidence.inventory_before ?? "missing"}->${evidence.inventory_after ?? "missing"};item=${target.qualifiedItemId}`,
      );

    // The world change, re-read after the terminal: the piece is gone from that tile.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    if (after.location !== before.location)
      throw new Error(`move_placed_furniture_location_changed:${before.location}->${after.location}`);
    const stillThere = furnitureAt(after, target.x, target.y);
    if (stillThere !== null)
      throw new Error(`move_placed_furniture_world_unchanged:${stillThere.targetId};tile=${target.x},${target.y}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: TERMINAL_REASON,
      target: {
        targetId: target.targetId,
        kind: target.kind,
        location: target.location,
        x: target.x,
        y: target.y,
        qualifiedItemId: target.qualifiedItemId,
        displayName: target.displayName,
      },
      item: target.qualifiedItemId,
      backpack: { before: carriedBefore, after: carriedAfter },
      furnitureInLocationAfter: evidence.furniture_in_location ?? null,
      evidence,
      receipt: summarizeReceipt(terminal),
      observations: {
        before: { revision: before.revision, location: before.location, tile: before.tile ?? null },
        after: { revision: after.revision, location: after.location, tile: after.tile ?? null },
      },
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

/**
 * The nearest piece the Mod published as `placed_furniture`, or a named failure.
 *
 * "Nearest" is the only choice this runner makes: the pickup's reach is the game's own furniture
 * predicate on the game thread (`Furniture.IsCloseEnoughToFarmer`), so a tile distance here is
 * selection, not a second spelling of the reach check - an out-of-reach piece comes back as the
 * Mod's own `move_placed_furniture_out_of_range` refusal.
 */
function choosePublishedPiece(snapshot) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null)
    throw new Error(
      `move_placed_furniture_no_world_object_projection:location=${snapshot.location ?? "unknown"};` +
        `capabilities=${Array.isArray(snapshot.capabilities) ? snapshot.capabilities.length : "missing"}`,
    );
  if (!Array.isArray(entries)) throw new Error("move_placed_furniture_world_object_projection_malformed");
  const pieces = entries.filter(isFurnitureRow);
  if (pieces.length === 0)
    throw new Error(
      `move_placed_furniture_no_published_furniture:location=${snapshot.location ?? "unknown"};` +
        `tile=${describeTile(snapshot.tile)};rows=${describeCandidates(snapshot)}`,
    );
  if (!Number.isSafeInteger(snapshot.tile?.x) || !Number.isSafeInteger(snapshot.tile?.y))
    throw new Error(`move_placed_furniture_actor_tile_missing:rows=${pieces.length}`);
  const nearest = pieces.reduce((best, candidate) =>
    chebyshev(candidate, snapshot.tile) < chebyshev(best, snapshot.tile) ? candidate : best,
  );
  if (!FURNITURE_TARGET_ID.test(nearest.targetId))
    throw new Error(`move_placed_furniture_target_id_not_the_mod_builder:${nearest.targetId}`);
  return nearest;
}

/** A published row that a furniture pickup could name: the kind, a tile, an id and an item. */
function isFurnitureRow(entry) {
  return (
    entry != null &&
    entry.kind === FURNITURE_KIND &&
    typeof entry.targetId === "string" &&
    entry.targetId.length > 0 &&
    Number.isSafeInteger(entry.x) &&
    Number.isSafeInteger(entry.y) &&
    typeof entry.qualifiedItemId === "string" &&
    entry.qualifiedItemId.length > 0
  );
}

function furnitureAt(snapshot, x, y) {
  if (!Array.isArray(snapshot.worldObjectTargets)) return null;
  return snapshot.worldObjectTargets.find((entry) => isFurnitureRow(entry) && entry.x === x && entry.y === y) ?? null;
}

function chebyshev(entry, tile) {
  return Math.max(Math.abs(entry.x - tile.x), Math.abs(entry.y - tile.y));
}

function describeTile(tile) {
  return Number.isSafeInteger(tile?.x) && Number.isSafeInteger(tile?.y) ? `${tile.x},${tile.y}` : "missing";
}

function describeCandidates(snapshot) {
  const entries = snapshot.worldObjectTargets;
  if (entries == null) return "none";
  if (!Array.isArray(entries)) return "malformed";
  return (
    entries
      .map((entry) => `${entry?.kind ?? "?"}:${entry?.qualifiedItemId ?? "?"}@${entry?.x ?? "?"},${entry?.y ?? "?"}`)
      .join("|") || "empty"
  );
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`move_placed_furniture_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
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
    const result = await runMovePlacedFurnitureSmoke(session.client, session.receipts);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
