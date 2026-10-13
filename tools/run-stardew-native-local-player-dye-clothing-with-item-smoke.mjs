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

const ACTION = "dye_clothing_with_item";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * dye_clothing_with_item live contract.
 *
 * The receipt is not the proof. The garment's COLOUR is read from the world TWICE, independently of
 * the receipt, and that is the point of this runner:
 *
 *   1. the garment's colour BEFORE is the `garmentColour` of the published `tailoringTargets` entry
 *      the request names, and the colour AFTER is the same field of the SAME target id in a fresh
 *      observation — the target id does not hash the colour, so a republished entry is the
 *      garment's live colour and not an echo of the receipt;
 *   2. the receipt's `colour_before`/`colour_after` must agree with those two world reads, and the
 *      change must be the one the dye implies: a different dye colour must MOVE the garment's
 *      colour, and the garment's own colour must stay put when the dye carries the colour it
 *      already has (`Clothing.Dye` is a no-op on a non-dyeable garment, which is exactly the silent
 *      lie this check exists to catch);
 *   3. the dye item was consumed by exactly one and the garment is still in the backpack slot the
 *      target named, both read from the fresh `inventoryItemFacts`;
 *   4. RESUBMITTING WITH AN ID THAT IS NOT THE LIVE PAIR is refused by name and moves nothing —
 *      twice, because the two refusals are different: the other kind's id for the same pair
 *      (`tailoring_target_not_found`) and the same kind with a flipped digest
 *      (`tailoring_target_changed`).
 *
 * The runner never chooses either item: both come from the `tailoringTargets` discovery projection,
 * and the Mod re-resolves the pair on the game thread.
 */
export async function runDyeClothingWithItemSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const target = chooseDyeTarget(snapshot);
  const before = {
    inventory: inventoryItemCounts(snapshot),
    garmentSlot: slotOf(snapshot, target.leftSlot, target.leftQualifiedItemId),
  };
  const args = { leftSlot: target.leftSlot, rightSlot: target.rightSlot, expectedTargetId: target.targetId };

  const requestId = `native_local_dye_clothing_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ step: "dye", action: ACTION, target: target.targetId, garment: target.leftQualifiedItemId, dye: target.rightQualifiedItemId, receipt: summarizeReceipt(accepted) });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("dye_clothing_with_item terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "clothing_dyed")
    throw new Error(
      `dye_clothing_with_item did not recolour the garment: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const evidence = parseEvidence(terminal.evidence);
  const after = await observeFresh(client, { actionable: true });
  const checks = assertDyeClothingPostconditions({
    target,
    evidence,
    before: { ...before, garmentColour: target.garmentColour },
    after: {
      inventory: inventoryItemCounts(after),
      garmentColour: colourOfTarget(after, target.targetId),
      garmentSlot: slotOf(after, target.leftSlot, target.leftQualifiedItemId),
    },
  });
  trace.push({ step: "observed", target: target.targetId, evidence, garmentColourBefore: target.garmentColour, garmentColourAfter: colourOfTarget(after, target.targetId), checks });

  const wrongKindId = target.targetId.replace("tailoring_dye_", "tailoring_recipe_");
  const wrongKind = await executeNegative(client, receipts, args, wrongKindId, target, terminalTimeoutMs);
  const flipped = `${target.targetId.slice(0, -1)}${target.targetId.slice(-1) === "0" ? "1" : "0"}`;
  const stale = await executeNegative(client, receipts, args, flipped, target, terminalTimeoutMs);
  trace.push({ step: "negative_wrong_kind", receipt: wrongKind.receipt }, { step: "negative_stale_id", receipt: stale.receipt });

  checks.wrongKindRefused = wrongKind.refused && wrongKind.reasonCode === "tailoring_target_not_found";
  checks.staleIdRefused = stale.refused && stale.reasonCode === "tailoring_target_changed";
  checks.negativesMovedNothing = wrongKind.movedNothing && stale.movedNothing;

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`dye_clothing_with_item live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "clothing_dyed", trace, checks, evidence };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the
 * published target (and its pre-observation colour), the receipt's evidence, and the world read
 * after — the garment's colour, the backpack counts and the garment's own slot.
 *
 * Every world half that cannot be read is `not_checked`, never a pass.
 */
export function assertDyeClothingPostconditions({ target, evidence, before, after }) {
  const observable = after?.inventory !== null && after?.inventory !== undefined && before?.inventory !== null && before?.inventory !== undefined;
  const colourObservable = typeof before?.garmentColour === "string" && typeof after?.garmentColour === "string";
  const dyeBefore = Number(evidence.dye_before);
  const dyeAfter = Number(evidence.dye_after);
  const dyeSpent = evidence.dye_spent === "true";
  const countsAreIntegers = Number.isSafeInteger(dyeBefore) && Number.isSafeInteger(dyeAfter) && dyeBefore >= 0 && dyeAfter >= 0;
  const colourBefore = before?.garmentColour;
  const colourExpected = evidence.colour_expected;
  const colourAfter = evidence.colour_after;
  return {
    receiptNamesTheTarget:
      evidence.target === target.targetId &&
      evidence.garment === target.leftQualifiedItemId &&
      evidence.dye === target.rightQualifiedItemId,
    receiptCountsAreIntegers: countsAreIntegers,
    // The world BEFORE the call and the receipt's own "before" are the same colour.
    receiptAgreesWithObservedBefore: colourObservable && evidence.colour_before === colourBefore,
    // The dye was consumed by exactly the native amount, and the receipt says which.
    receiptSaysDyeConsumed: countsAreIntegers && dyeAfter === (dyeSpent ? dyeBefore - 1 : dyeBefore),
    // The colour moved exactly when the dye carried a different one, and stayed where it was when
    // the dye carried the colour the garment already had.
    receiptSaysColourApplied:
      colourExpected === colourBefore ? colourAfter === colourBefore : colourAfter !== colourBefore,
    // The world AFTER: the SAME target id republished by a fresh observation carries the colour the
    // receipt claims, so the colour is not taken on the receipt's word.
    worldShowsColourAfter: colourObservable ? after.garmentColour === colourAfter : "not_checked",
    worldShowsColourMoved: colourObservable
      ? colourExpected === colourBefore
        ? after.garmentColour === colourBefore
        : after.garmentColour !== colourBefore
      : "not_checked",
    worldShowsDyeConsumed: observable
      ? (before.inventory[target.rightQualifiedItemId] ?? 0) - (after.inventory[target.rightQualifiedItemId] ?? 0) === (dyeSpent ? 1 : 0)
      : "not_checked",
    // The garment is still the same item in the same slot: a dye that removed it is not a dye.
    worldShowsGarmentStillOwned: before?.garmentSlot !== null && before?.garmentSlot !== undefined
      ? after?.garmentSlot !== null && after?.garmentSlot !== undefined
      : "not_checked",
  };
}

/** One refused submission, with its own fresh observation (the previous request advanced the revision). */
async function executeNegative(client, receipts, args, expectedTargetId, target, terminalTimeoutMs) {
  const requestId = `native_local_dye_clothing_negative_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const snapshot = await observeFresh(client, { actionable: true });
  const before = { inventory: inventoryItemCounts(snapshot), colour: colourOfTarget(snapshot, target.targetId) };
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { ...args, expectedTargetId },
    snapshot,
    timeoutMs: 30_000,
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  const fresh = await observeFresh(client, { actionable: true });
  const after = { inventory: inventoryItemCounts(fresh), colour: colourOfTarget(fresh, target.targetId) };
  const sameInventory = before.inventory !== null && after.inventory !== null && JSON.stringify(before.inventory) === JSON.stringify(after.inventory);
  const sameColour = before.colour === after.colour;
  return {
    refused: terminal.state === "rejected",
    reasonCode: terminal.reasonCode,
    receipt: summarizeReceipt(terminal),
    movedNothing: sameInventory && sameColour,
  };
}

/** The dye-kind target the fixture armed, as discovery publishes it. */
function chooseDyeTarget(snapshot) {
  const candidates = tailoringTargets(snapshot).filter(
    (entry) =>
      entry?.kind === "dye" &&
      Number.isSafeInteger(entry.leftSlot) &&
      Number.isSafeInteger(entry.rightSlot) &&
      typeof entry.garmentColour === "string",
  );
  if (candidates.length === 0)
    throw new Error(`no dye tailoring target is advertised: ${JSON.stringify(tailoringTargets(snapshot))}`);
  return candidates[0];
}

function tailoringTargets(snapshot) {
  const targets = snapshot?.tailoringTargets;
  return Array.isArray(targets) ? targets : [];
}

/** The live colour of one published target, or null when the fresh observation no longer publishes it. */
function colourOfTarget(snapshot, targetId) {
  const entry = tailoringTargets(snapshot).find((candidate) => candidate?.targetId === targetId);
  return typeof entry?.garmentColour === "string" ? entry.garmentColour : null;
}

/** What the snapshot publishes in one backpack slot, or null when the slot is not published. */
function slotOf(snapshot, slot, qualifiedItemId) {
  const items = snapshot?.inventoryItemFacts;
  if (!Array.isArray(items)) return null;
  const entry = items.find((item) => item?.slot === slot && item?.qualifiedItemId === qualifiedItemId);
  return entry ? { slot: entry.slot, qualifiedItemId: entry.qualifiedItemId, stack: entry.stack } : null;
}

/**
 * The backpack the fresh snapshot publishes, as qualifiedItemId -> total stack. Returns null when
 * the surface does not carry the inventory at all, so an absent projection reads as "not observed"
 * rather than as "empty".
 */
function inventoryItemCounts(snapshot) {
  const items = snapshot?.inventoryItemFacts;
  if (!Array.isArray(items)) return null;
  const counts = {};
  for (const item of items) {
    if (typeof item?.qualifiedItemId !== "string" || !Number.isSafeInteger(item?.stack)) continue;
    counts[item.qualifiedItemId] = (counts[item.qualifiedItemId] ?? 0) + item.stack;
  }
  return counts;
}

/** `key=value;key=value` — the Mod's evidence shape. */
function parseEvidence(evidence) {
  const text = typeof evidence === "string" ? evidence : (evidence?.detail ?? "");
  const values = {};
  for (const field of String(text).split(";")) {
    const at = field.indexOf("=");
    if (at <= 0) continue;
    values[field.slice(0, at)] = field.slice(at + 1);
  }
  return values;
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runDyeClothingWithItemSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
