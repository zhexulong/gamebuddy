// Stardew-local place-item-on-pedestal smoke: the production native client, the bounded scope, the
// revision-bound request, the exact receipt identity and the terminal wait all come from the shared
// harness. What stays here is this action's own contract - which published target it acts on, what the
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

const ACTION = "place_item_on_pedestal";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/** The one terminal this action mints when the pedestal's own `heldObject` became the deposited item. */
const RECEIPT = "pedestal_item_placed";
/**
 * A well-formed but never-published id of the same shape `BuildPedestalDepositTargetId` mints
 * (`pedestal_deposit_` + 16 lowercase hex). The stale-id case below needs a value the wire accepts structurally and
 * the handler must then refuse, so it cannot be built from anything the observation published.
 */
const STALE_TARGET_ID = "pedestal_deposit_0000000000000000";

/**
 * place_item_on_pedestal live contract.
 *
 * The receipt is not the proof. Three things are checked beside it:
 *   1. the target and the item come from the Mod's own projections - `worldObjectTargets`'
 *      `empty_pedestal` row and the pack's `inventoryItemFacts` rows - never from this runner;
 *   2. `held` in the evidence is the deposited item's identity and the pack lost exactly one of it, which is the
 *      pair `ExecutePlaceItemOnPedestal` itself mints the receipt on (`holdsIt && leftThePack`);
 *   3. the world, re-read from a FRESH snapshot after the terminal: the `empty_pedestal` row the request named is
 *      GONE, because the Mod publishes that row only while `heldObject.Value is null` (farmhandtargetdiscovery.cs).
 *      A pedestal that answered a receipt and is still advertised as empty is the defect this catches.
 *
 * The negative case is the STALE ID and nothing pack-dependent: the pedestal's id is content-keyed on
 * (location, tile, item) and deliberately excludes what its own use changes, so the same tile addressed by an id
 * that was never published must be refused `pedestal_target_changed` rather than place into whatever stands there.
 */
export async function runPlaceItemOnPedestalSmoke(
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
    const target = chooseEmptyPedestal(before);
    const carried = chooseCarriedObject(before);
    const requestId = `native_local_place_item_on_pedestal_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: {
        x: target.x,
        y: target.y,
        slot: carried.slot,
        expectedQualifiedItemId: carried.qualifiedItemId,
        expectedTargetId: target.targetId,
      },
      snapshot: before,
    });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    trace.push({ step: "place", action: ACTION, target: target.targetId, receipt: summarizeReceipt(terminal) });
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("place_item_on_pedestal_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== RECEIPT)
      throw new Error(
        `place_item_on_pedestal_failed:${terminal.state}/${terminal.reasonCode};tile=${target.x},${target.y};slot=${carried.slot};item=${carried.qualifiedItemId}`,
      );

    const evidence = parseEvidence(terminal.evidence, {
      requiredKeys: ["target", "tile", "item", "held", "native_answered", "carried_before", "carried_after"],
    });
    assertEvidence(evidence, "target", target.targetId);
    assertEvidence(evidence, "tile", `${target.x},${target.y}`);
    assertEvidence(evidence, "item", carried.qualifiedItemId);
    assertEvidence(evidence, "held", carried.qualifiedItemId);
    assertEvidence(evidence, "native_answered", "true");
    const carriedBefore = Number(evidence.carried_before);
    const carriedAfter = Number(evidence.carried_after);
    if (!Number.isSafeInteger(carriedBefore) || carriedAfter !== carriedBefore - 1)
      throw new Error(`place_item_on_pedestal_pack_not_charged:${evidence.carried_before}->${evidence.carried_after}`);

    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    if (emptyPedestalAt(after, target.targetId) !== undefined)
      throw new Error(`place_item_on_pedestal_pedestal_still_advertised_empty:${target.targetId}`);
    const carriedAfterWorld = carriedQuantity(after, carried.qualifiedItemId);
    if (!(carriedAfterWorld < carriedBefore))
      throw new Error(
        `place_item_on_pedestal_pack_unchanged_in_world:${carried.qualifiedItemId}:${carriedBefore}->${String(carriedAfterWorld)}`,
      );

    const staleRequestId = `native_local_place_item_on_pedestal_stale_${Date.now()}`;
    const staleAccepted = await executeFresh(client, {
      requestId: staleRequestId,
      idempotencyKey: `${staleRequestId}_idem`,
      action: ACTION,
      args: {
        x: target.x,
        y: target.y,
        slot: carried.slot,
        expectedQualifiedItemId: carried.qualifiedItemId,
        expectedTargetId: STALE_TARGET_ID,
      },
      snapshot: after,
    });
    const staleTerminal = await waitForTerminal(receipts, staleAccepted, terminalTimeoutMs);
    trace.push({
      step: "place_stale_target",
      action: ACTION,
      target: STALE_TARGET_ID,
      receipt: summarizeReceipt(staleTerminal),
    });
    if (staleTerminal.state !== "rejected" || staleTerminal.reasonCode !== "pedestal_target_changed")
      throw new Error(
        `place_item_on_pedestal_stale_target_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode};tile=${target.x},${target.y}`,
      );
    const unchanged = await observeFresh(client, { actionable: true });
    if (emptyPedestalAt(unchanged, target.targetId) !== undefined)
      throw new Error(`place_item_on_pedestal_stale_target_moved_the_world:${target.targetId}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: RECEIPT,
      target: target.targetId,
      tile: { x: target.x, y: target.y },
      item: carried.qualifiedItemId,
      armed: { emptyPedestals: 1, carriedObjectSlots: 1 },
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
 * The ONE empty pedestal the Given staged, from the Mod's projection.
 *
 * Zero rows is refused by name rather than passed over: a deciduous "no target, nothing to assert" would report the
 * same `passed` for a run whose fixture never armed - the zero-population defect this gate exists to not repeat. More
 * than one row is refused for the other reason: the Given stages exactly one, so a second would mean the world is not
 * the one this contract describes.
 */
function chooseEmptyPedestal(snapshot) {
  const rows = (snapshot.worldObjectTargets ?? []).filter(
    (entry) => entry?.kind === "empty_pedestal" && typeof entry.targetId === "string" && entry.targetId.length > 0,
  );
  if (rows.length !== 1)
    throw new Error(
      `place_item_on_pedestal_empty_pedestal_count:${rows.length};found=${describeWorldObjectRows(snapshot)}`,
    );
  const target = rows[0];
  if (!Number.isSafeInteger(target.x) || !Number.isSafeInteger(target.y))
    throw new Error(`place_item_on_pedestal_target_malformed:${target.targetId}`);
  return target;
}

function emptyPedestalAt(snapshot, targetId) {
  return (snapshot.worldObjectTargets ?? []).find(
    (entry) => entry?.kind === "empty_pedestal" && entry?.targetId === targetId,
  );
}

/**
 * The ONE ordinary carried object, from the pack's own rows.
 *
 * The fixture arms exactly one `Object` - the pedestal's acceptance rule is `dropInItem.GetType() == typeof(Object)`,
 * so an ordinary object is the only kind that can be placed at all - while every other carried item in a starter pack
 * is a `(T)` tool. The rule is therefore the numerator the engine has (a qualified `(O)` id), not the item id the
 * fixture happens to choose: a second spelling of `(O)388` here would go stale the day that Given's item changed.
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
    throw new Error(`place_item_on_pedestal_carried_object_count:${rows.length};pack=${describePack(snapshot)}`);
  return rows[0];
}

function carriedQuantity(snapshot, qualifiedItemId) {
  let total = 0;
  for (const entry of snapshot.inventoryItemFacts ?? [])
    if (entry?.qualifiedItemId === qualifiedItemId && Number.isSafeInteger(entry.stack)) total += entry.stack;
  return total;
}

function describeWorldObjectRows(snapshot) {
  const rows = snapshot.worldObjectTargets;
  if (!Array.isArray(rows)) return "none";
  return (
    rows
      .map((entry) => `${entry?.kind ?? "?"}:${entry?.qualifiedItemId ?? "?"}@${entry?.x ?? "?"},${entry?.y ?? "?"}`)
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
    throw new Error(`place_item_on_pedestal_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runPlaceItemOnPedestalSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
