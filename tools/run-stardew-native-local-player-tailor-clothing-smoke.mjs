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

const ACTION = "tailor_clothing";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/**
 * tailor_clothing live contract.
 *
 * The receipt is not the proof. Four things are read, and the first is what makes the action worth
 * its consumption:
 *
 *   1. the two ingredients LEFT the backpack — read from the FRESH snapshot's `inventoryItemFacts`
 *      after the call (not from the receipt's own counts), so the claim is about the world;
 *   2. the garment EXISTS — the same fresh reading must show the output item id up by exactly the
 *      `delivered` the receipt reports, and any piece that did not fit must be on the ground as
 *      debris (`dropped_debris=1`);
 *   3. BOTH halves must hold together. A run where the reagents left but no garment exists, or a
 *      garment appeared while the reagents stayed, is a defect this action exists to never produce;
 *   4. RESUBMITTING WITH AN ID THAT IS NOT THE LIVE PAIR is refused by name and moves nothing. Two
 *      negatives, because they are different refusals: the OTHER KIND's id for the same pair
 *      (`tailoring_target_not_found`) and the same kind with a flipped digest
 *      (`tailoring_target_changed`). An action that reported success on either would be acting on a
 *      target it never published.
 *
 * The runner never chooses the pair: it comes from the `tailoringTargets` discovery projection the
 * Mod publishes, and the Mod re-resolves the pair on the game thread.
 */
export async function runTailorClothingSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const snapshot = await observeFresh(client, { actionable: true });
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const target = chooseRecipeTarget(snapshot);
  const before = inventoryItemCounts(snapshot);
  const args = { leftSlot: target.leftSlot, rightSlot: target.rightSlot, expectedTargetId: target.targetId };

  const requestId = `native_local_tailor_clothing_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args,
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({ step: "tailor", action: ACTION, target: target.targetId, output: target.outputQualifiedItemId, receipt: summarizeReceipt(accepted) });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("tailor_clothing terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "clothing_tailored")
    throw new Error(
      `tailor_clothing did not produce a garment: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const evidence = parseEvidence(terminal.evidence);
  const after = await observeFresh(client, { actionable: true });
  const checks = assertTailorClothingPostconditions({
    target,
    evidence,
    before,
    after: inventoryItemCounts(after),
  });
  trace.push({ step: "observed", target: target.targetId, evidence, countsBefore: before, countsAfter: inventoryItemCounts(after), checks });

  // Negative A: the id of the OTHER kind for the very same pair. The pair is real, the intent is
  // real, and the id names a route this action does not serve.
  const wrongKindId = target.targetId.replace("tailoring_recipe_", "tailoring_dye_");
  const wrongKind = await executeNegative(client, receipts, args, wrongKindId, terminalTimeoutMs);
  // Negative B: the same kind with a different digest — a stale id that still LOOKS publishable.
  const flipped = `${target.targetId.slice(0, -1)}${target.targetId.slice(-1) === "0" ? "1" : "0"}`;
  const stale = await executeNegative(client, receipts, args, flipped, terminalTimeoutMs);
  trace.push({ step: "negative_wrong_kind", receipt: wrongKind.receipt }, { step: "negative_stale_id", receipt: stale.receipt });

  checks.wrongKindRefused = wrongKind.refused && wrongKind.reasonCode === "tailoring_target_not_found";
  checks.staleIdRefused = stale.refused && stale.reasonCode === "tailoring_target_changed";
  checks.negativesMovedNothing = wrongKind.movedNothing && stale.movedNothing;

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`tailor_clothing live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "clothing_tailored", trace, checks, evidence };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the
 * published target, the receipt's evidence, and the backpack counts before and after, both read
 * from fresh snapshots. `after` is null when the observation surface did not publish an inventory,
 * and then the world half of the claim is `not_checked` — never a pass, because "I could not look"
 * and "the reagents stayed" must not read the same.
 */
export function assertTailorClothingPostconditions({ target, evidence, before, after }) {
  const observable = after !== null && before !== null;
  const leftBefore = Number(evidence.left_before);
  const leftAfter = Number(evidence.left_after);
  const rightBefore = Number(evidence.right_before);
  const rightAfter = Number(evidence.right_after);
  const outputBefore = Number(evidence.output_before);
  const outputAfter = Number(evidence.output_after);
  const delivered = Number(evidence.delivered);
  const dropped = Number(evidence.dropped);
  const rightSpent = evidence.right_spent === "true";
  // The receipt's own four counts must be integers and internally coherent before anything is
  // compared with the world: a receipt that cannot state what it consumed cannot be a success.
  const countsAreIntegers = [leftBefore, leftAfter, rightBefore, rightAfter, outputBefore, outputAfter, delivered, dropped].every(
    (value) => Number.isSafeInteger(value) && value >= 0,
  );
  return {
    // The receipt names the very pair the published target named.
    receiptNamesTheTarget:
      evidence.target === target.targetId &&
      evidence.left === target.leftQualifiedItemId &&
      evidence.right === target.rightQualifiedItemId &&
      evidence.output === target.outputQualifiedItemId,
    receiptCountsAreIntegers: countsAreIntegers,
    // Half one: each named reagent left by exactly the native consumption (the left always, the
    // right only when the recipe's own `SpendRightItem` says so).
    receiptSaysReagentsSpent:
      countsAreIntegers && leftAfter === leftBefore - 1 && rightAfter === (rightSpent ? rightBefore - 1 : rightBefore),
    // Half two: a product exists, split between the backpack and the ground with nothing lost.
    receiptSaysGarmentExists: countsAreIntegers && delivered + dropped >= 1 && outputAfter === outputBefore + delivered,
    // And the disposition the receipt claims is the split it reports.
    dispositionMatchesSplit:
      (evidence.disposition === "inventory" && dropped === 0) ||
      (evidence.disposition === "dropped_on_ground" && delivered === 0 && dropped > 0) ||
      (evidence.disposition === "partially_dropped" && delivered > 0 && dropped > 0),
    // The world, read independently: the backpack the fresh snapshot publishes must show the same
    // consumption and the same delivery the receipt claims.
    worldShowsReagentsSpent: observable
      ? (before[target.leftQualifiedItemId] ?? 0) - (after[target.leftQualifiedItemId] ?? 0) === 1 &&
        (after[target.rightQualifiedItemId] ?? 0) === (before[target.rightQualifiedItemId] ?? 0) - (rightSpent ? 1 : 0)
      : "not_checked",
    // A product must EXIST somewhere: the receipt says one went to the backpack (`delivered`) or to the ground
    // (`dropped`). Without that first requirement the comparison below is satisfied by a total no-op - the garment
    // count unchanged and the receipt claiming nothing delivered - which is exactly what the offline suite caught.
    worldShowsGarmentExists: observable
      ? delivered + dropped >= 1 &&
        (after[target.outputQualifiedItemId] ?? 0) === (before[target.outputQualifiedItemId] ?? 0) + delivered
      : "not_checked",
  };
}

/**
 * One refused submission. The judgement is the same for every negative: a NAMED refusal (a success
 * here would be acting on an unpublished target), and a backpack the FRESH snapshot taken around the
 * attempt shows unmoved. Each negative observes its own snapshot: the previous request advanced the
 * Mod's revision, so reusing an older one would be refused as stale before the action was reached.
 */
async function executeNegative(client, receipts, args, expectedTargetId, terminalTimeoutMs) {
  const requestId = `native_local_tailor_clothing_negative_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const snapshot = await observeFresh(client, { actionable: true });
  const before = inventoryItemCounts(snapshot);
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { ...args, expectedTargetId },
    snapshot,
    timeoutMs: 30_000,
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  const after = inventoryItemCounts(await observeFresh(client, { actionable: true }));
  const moved = Object.keys({ ...before, ...after }).filter((key) => before[key] !== after[key]);
  return {
    refused: terminal.state === "rejected",
    reasonCode: terminal.reasonCode,
    receipt: summarizeReceipt(terminal),
    movedNothing: before !== null && after !== null && moved.length === 0,
    moved,
  };
}

/** The recipe-kind target the fixture armed, as discovery publishes it. */
function chooseRecipeTarget(snapshot) {
  const candidates = tailoringTargets(snapshot).filter(
    (entry) => entry?.kind === "recipe" && Number.isSafeInteger(entry.leftSlot) && Number.isSafeInteger(entry.rightSlot),
  );
  if (candidates.length === 0)
    throw new Error(`no recipe tailoring target is advertised: ${JSON.stringify(tailoringTargets(snapshot))}`);
  return candidates[0];
}

function tailoringTargets(snapshot) {
  const targets = snapshot?.tailoringTargets;
  return Array.isArray(targets) ? targets : [];
}

/**
 * The backpack the fresh snapshot publishes, as qualifiedItemId -> total stack. Returns null when
 * the surface does not carry the inventory at all, so an absent projection reads as "not observed"
 * rather than as "empty".
 */
export function inventoryItemCounts(snapshot) {
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
    const result = await runTailorClothingSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
