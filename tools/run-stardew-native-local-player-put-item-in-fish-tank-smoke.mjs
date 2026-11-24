// Stardew-local put-item-in-fish-tank smoke: the production native client, the bounded scope, the
// revision-bound request, the exact receipt identity and the terminal wait all come from the shared
// harness. What stays here is this action's own contract - which published piece it acts on, what the
// receipt must have observed, and the fact the world must show afterwards.

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
import { parseEvidence } from "./lib/native-local-runner-primitives.mjs";

const ACTION = "put_item_in_fish_tank";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/** The one terminal this action mints when the tank's own `heldItems` grew by the deposited item. */
const RECEIPT = "fish_tank_item_deposited";
/** What a piece of furniture answers when it is not a tank - the answer every non-tank row in the room must give. */
const NOT_A_TANK = "fish_tank_target_is_not_a_tank";
/**
 * A well-formed but never-published id of the same shape `BuildPlacedFurnitureTargetId` mints
 * (`placed_furniture_` + 16 lowercase hex). The stale-id case below needs a value the wire accepts structurally and the
 * handler must then refuse, so it cannot be built from anything the observation published.
 */
const STALE_TARGET_ID = "placed_furniture_0000000000000000";

/**
 * put_item_in_fish_tank live contract.
 *
 * WHY THIS RUNNER WALKS THE PROJECTION INSTEAD OF NAMING THE TANK. A fish tank is a `Furniture` standing in
 * `location.furniture`, and the room the Given arms is a real farmhouse that already holds its own pieces. The published
 * `placed_furniture` row carries the piece's identity, its tile and its footprint, but NOTHING that distinguishes a tank
 * from a bed: `slot` is -1 for every piece, and a bed's footprint is as large as a tank's. Naming a tank id here would
 * therefore be this runner inventing a fact the projection does not publish, and it would be green only until the
 * fixture's own `RequireNativeLocalFixtureFishTank` (which asks the item registry, not a constant) picked a different
 * piece. So the contract is the engine's own: of the pieces the Mod publishes in this room, EXACTLY ONE accepts the
 * carried object and every OTHER piece refuses by name with `fish_tank_target_is_not_a_tank`. That is a stronger
 * statement than "this id worked", and it is one the world can actually prove.
 *
 * The Given arms one EMPTY tank, so the deposit is the only way `heldItems` can grow: the handler mints the receipt only
 * when `heldItems` grew by one with this item last AND the pack lost exactly one, and this runner re-reads that same pair
 * from the evidence - then re-reads the PACK from a fresh snapshot, which is the one world fact the wire publishes for
 * this action (the tank's own contents are not in any projection).
 */
export async function runPutItemInFishTankSmoke(
  client,
  receipts,
  _config,
  // The descriptor declares `self_walked`, so the terminal can arrive after the approach leg has run: the wait is
  // wider than the 5 s a standing-still action needs, and it is a bound on this RUNNER, not a product budget.
  { terminalTimeoutMs = 20_000 } = {},
) {
  const trace = [];
  try {
    const before = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(before, REQUIRED_CAPABILITIES);
    const pieces = publishedFurniture(before);
    const carried = chooseCarriedObject(before);
    const answers = [];
    let tank = null;
    let terminal = null;
    for (const piece of pieces) {
      // Re-observed per attempt: `executeFresh` binds the request to the revision it is handed, and the approach leg of
      // a refused request may still have advanced the world.
      const live = await observeFresh(client, { actionable: true });
      const requestId = `native_local_put_item_in_fish_tank_${piece.targetId}_${Date.now()}`;
      const accepted = await executeFresh(client, {
        requestId,
        idempotencyKey: `${requestId}_idem`,
        action: ACTION,
        args: {
          x: piece.x,
          y: piece.y,
          slot: carried.slot,
          expectedQualifiedItemId: carried.qualifiedItemId,
          expectedTargetId: piece.targetId,
        },
        snapshot: live,
      });
      const settled = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
      if (settled.requestId !== requestId || settled.executionId !== accepted.executionId)
        throw new Error(`put_item_in_fish_tank_terminal_identity_mismatch:${piece.targetId}`);
      answers.push({ target: piece.targetId, state: settled.state, reasonCode: settled.reasonCode });
      trace.push({
        step: "deposit",
        action: ACTION,
        target: piece.targetId,
        receipt: summarizeReceipt(settled),
      });
      if (settled.state === "succeeded" && settled.reasonCode === RECEIPT) {
        tank = piece;
        terminal = settled;
        break;
      }
      // The Given's own consequence: a piece that is not a tank refuses by name, and the next piece is tried. Any OTHER
      // answer is a different fact about this world (a rejected item, a busy tank, a refusal this contract does not
      // describe) and is failed by name rather than walked past.
      if (settled.state !== "rejected" || settled.reasonCode !== NOT_A_TANK)
        throw new Error(
          `put_item_in_fish_tank_unexpected_answer:${piece.targetId}:${settled.state}/${settled.reasonCode};item=${carried.qualifiedItemId};pieces=${describePieces(pieces)}`,
        );
    }
    if (tank === null || terminal === null)
      throw new Error(
        `put_item_in_fish_tank_no_tank_in_the_room:pieces=${pieces.length};answers=${answers
          .map((entry) => `${entry.target}=${entry.reasonCode}`)
          .join("|")};item=${carried.qualifiedItemId}`,
      );

    const evidence = parseEvidence(terminal.evidence, {
      requiredKeys: [
        "target",
        "tile",
        "item",
        "held_items_before",
        "held_items_after",
        "last_held",
        "carried_before",
        "carried_after",
        "native_answered",
      ],
    });
    assertEvidence(evidence, "target", tank.targetId);
    assertEvidence(evidence, "tile", `${tank.x},${tank.y}`);
    assertEvidence(evidence, "item", carried.qualifiedItemId);
    assertEvidence(evidence, "last_held", carried.qualifiedItemId);
    assertEvidence(evidence, "native_answered", "true");
    const heldBefore = Number(evidence.held_items_before);
    const heldAfter = Number(evidence.held_items_after);
    const carriedBefore = Number(evidence.carried_before);
    const carriedAfter = Number(evidence.carried_after);
    // The tank started EMPTY - that is the Given - so "grew by one" is the whole of the deposit's evidence, and it is
    // the pair the handler minted the receipt on.
    if (!Number.isSafeInteger(heldBefore) || heldBefore !== 0 || heldAfter !== heldBefore + 1)
      throw new Error(
        `put_item_in_fish_tank_tank_not_filled:${evidence.held_items_before}->${evidence.held_items_after};last_held=${evidence.last_held}`,
      );
    if (!Number.isSafeInteger(carriedBefore) || carriedAfter !== carriedBefore - 1)
      throw new Error(`put_item_in_fish_tank_pack_not_charged:${evidence.carried_before}->${evidence.carried_after}`);

    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const carriedAfterWorld = carriedQuantity(after, carried.qualifiedItemId);
    if (!(carriedAfterWorld < carriedBefore))
      throw new Error(
        `put_item_in_fish_tank_pack_unchanged_in_world:${carried.qualifiedItemId}:${carriedBefore}->${String(carriedAfterWorld)}`,
      );

    const staleRequestId = `native_local_put_item_in_fish_tank_stale_${Date.now()}`;
    const staleAccepted = await executeFresh(client, {
      requestId: staleRequestId,
      idempotencyKey: `${staleRequestId}_idem`,
      action: ACTION,
      args: {
        x: tank.x,
        y: tank.y,
        slot: carried.slot,
        expectedQualifiedItemId: carried.qualifiedItemId,
        expectedTargetId: STALE_TARGET_ID,
      },
      snapshot: after,
    });
    const staleTerminal = await waitForTerminal(receipts, staleAccepted, terminalTimeoutMs);
    trace.push({
      step: "deposit_stale_target",
      action: ACTION,
      target: STALE_TARGET_ID,
      receipt: summarizeReceipt(staleTerminal),
    });
    if (staleTerminal.state !== "rejected" || staleTerminal.reasonCode !== "fish_tank_target_changed")
      throw new Error(
        `put_item_in_fish_tank_stale_target_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode};tile=${tank.x},${tank.y}`,
      );

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: RECEIPT,
      target: tank.targetId,
      tile: { x: tank.x, y: tank.y },
      item: carried.qualifiedItemId,
      armed: { furniturePieces: pieces.length, carriedObjectSlots: 1 },
      found: answers,
      negative: { staleTarget: staleTerminal.reasonCode },
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

/**
 * Every furniture piece the Mod published in this room, in the order it published them.
 *
 * A room with NO piece is refused by name rather than iterated to the empty answer: an empty population would make
 * "exactly one piece accepted" vacuously satisfiable by nothing at all, which is the reading that lets a fixture that
 * never armed report a pass.
 */
function publishedFurniture(snapshot) {
  const rows = snapshot.worldObjectTargets;
  if (!Array.isArray(rows)) throw new Error("put_item_in_fish_tank_no_world_object_projection");
  const pieces = rows.filter(
    (entry) =>
      entry?.kind === "placed_furniture" &&
      typeof entry.targetId === "string" &&
      entry.targetId.length > 0 &&
      Number.isSafeInteger(entry.x) &&
      Number.isSafeInteger(entry.y),
  );
  if (pieces.length === 0)
    throw new Error(`put_item_in_fish_tank_no_furniture_published;found=${describePieces(rows)}`);
  return pieces;
}

/**
 * The ONE ordinary carried object, from the pack's own rows.
 *
 * The tank's acceptance rule is its own aquarium table (`CanBeDeposited` over `GetAquariumData`), so the runner cannot
 * restate which item it takes - it can only name the SHAPE of what the fixture arms: one ordinary `(O)` object, while
 * every other carried item in a starter pack is a `(T)` tool. A second copy of the fixture's item id here would go
 * stale the day that Given's item changed.
 */
function chooseCarriedObject(snapshot) {
  const rows = (snapshot.inventoryItemFacts ?? []).filter(
    (entry) =>
      typeof entry?.qualifiedItemId === "string" &&
      entry.qualifiedItemId.startsWith("(O)") &&
      Number.isSafeInteger(entry.slot) &&
      Number.isSafeInteger(entry.stack) &&
      entry.stack > 0,
  );
  if (rows.length !== 1)
    throw new Error(`put_item_in_fish_tank_carried_object_count:${rows.length};pack=${describePack(snapshot)}`);
  return rows[0];
}

function carriedQuantity(snapshot, qualifiedItemId) {
  let total = 0;
  for (const entry of snapshot.inventoryItemFacts ?? [])
    if (entry?.qualifiedItemId === qualifiedItemId && Number.isSafeInteger(entry.stack)) total += entry.stack;
  return total;
}

function describePieces(rows) {
  if (!Array.isArray(rows)) return "none";
  return (
    rows
      .filter((entry) => entry?.kind === "placed_furniture")
      .map(
        (entry) =>
          `${entry?.qualifiedItemId ?? "?"}@${entry?.x ?? "?"},${entry?.y ?? "?"}:${entry?.tilesWide ?? "?"}x${entry?.tilesHigh ?? "?"}`,
      )
      .join("|") || "empty"
  );
}

function describePack(snapshot) {
  const rows = snapshot.inventoryItemFacts;
  if (!Array.isArray(rows)) return "none";
  return (
    rows.map((entry) => `${entry?.slot ?? "?"}:${entry?.qualifiedItemId ?? "?"}x${entry?.stack ?? "?"}`).join("|") ||
    "empty"
  );
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`put_item_in_fish_tank_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runPutItemInFishTankSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
