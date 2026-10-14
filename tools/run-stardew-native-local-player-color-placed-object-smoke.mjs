import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForActionable,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "color_placed_object";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
/**
 * The palette index the run paints. The fixture paints index 1 (`(85,85,255)`) and asserts the two
 * palette colours are distinct, so `before != after` is a real move; the choice of the run's index
 * lives here, and the action reads the palette bound from the game rather than from this constant.
 */
const COLOR_SELECTION = 2;
/**
 * The frozen evidence keys, IN ORDER (card §9). The Host's completion rule uses `exactEvidence`, which
 * requires the emitted key COUNT to equal its expected list length, so the count is part of the contract
 * and this runner checks the shape before it reads any value.
 */
export const EXPECTED_EVIDENCE_KEYS = [
  "target",
  "tile",
  "location",
  "color_selection",
  "color_before",
  "color_after",
  "color_changed",
];
/**
 * An index that cannot exist in the palette. The runner deliberately does NOT know the palette size
 * (that bound is the game's own, `DiscreteColorPicker.totalColors`, read on the game thread): it asks
 * for a value far past any real palette and requires the Mod to refuse it BY NAME.
 */
const OUT_OF_RANGE_SELECTION = 1000;
/** How long the actor may take to settle after the fixture's warp before the run gives up. */
const ACTIONABLE_TIMEOUT_MS = 30_000;

/**
 * color_placed_object live contract.
 *
 * The receipt is not the proof. The chest's COLOUR is read from the world TWICE, independently of
 * the receipt, and that is the point of this runner:
 *
 *   1. the colour BEFORE is the `color` field of the published `colorTargets` entry the request
 *      names, and the colour AFTER is the same field of the SAME target id in a fresh observation.
 *      The target id does not hash the colour (deliberately - a repaint to the colour a chest
 *      already has must stay a named refusal, not a phantom "moved" target), so a republished entry
 *      is the chest's LIVE colour and not an echo of the receipt;
 *   2. the receipt's `color_before`/`color_after` must agree with those two world reads, and the
 *      change must be a real move (`color_changed=true`, and the two colours differ) - an action
 *      that reported success without the colour moving cannot satisfy the fresh read-back;
 *   3. an ALREADY-SET repaint is refused by name: resubmitting the SAME selection after the write is
 *      `color_already_set`, which the Mod can only answer from a fresh game-thread read of
 *      `playerChoiceColor.Value`. That refusal is the independent confirmation that the world's
 *      colour now equals the palette colour for `color_selection`;
 *   4. an out-of-palette index is refused by name (`invalid_color_selection`) and a tile that holds
 *      no chest is refused by name (`color_target_unavailable`), and neither moves the world.
 *
 * The runner never chooses the chest or its tile: both come from the `colorTargets` discovery
 * projection the Mod publishes, and the Mod re-resolves the target on the game thread.
 */
export async function runColorPlacedObjectSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  const snapshot = await waitForActionable(client, await observeFresh(client), ACTIONABLE_TIMEOUT_MS);
  assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
  const target = chooseColorTarget(snapshot);

  const requestId = `native_local_color_placed_object_${Date.now()}`;
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { x: target.x, y: target.y, expectedTargetId: target.targetId, colorSelection: COLOR_SELECTION },
    snapshot,
    timeoutMs: 30_000,
  });
  trace.push({
    step: "recolor",
    action: ACTION,
    target: target.targetId,
    selection: COLOR_SELECTION,
    receipt: summarizeReceipt(accepted),
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
    throw new Error("color_placed_object terminal does not belong to this request");
  if (terminal.state !== "succeeded" || terminal.reasonCode !== "placed_object_recolored")
    throw new Error(
      `color_placed_object did not repaint the chest: state=${terminal.state};reason=${terminal.reasonCode};evidence=${terminal.evidence ?? ""}`,
    );

  const detail = evidenceDetail(terminal.evidence);
  const evidence = parseEvidence(detail);
  const after = await waitForActionable(client, await observeFresh(client), ACTIONABLE_TIMEOUT_MS);
  assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
  const checks = assertColorPlacedObjectPostconditions({
    target,
    selection: COLOR_SELECTION,
    detail,
    evidence,
    before: { color: target.color },
    after: { color: colourOfTarget(after, target.targetId) },
  });
  trace.push({
    step: "observed",
    before: target.color,
    after: colourOfTarget(after, target.targetId),
    evidence,
    checks,
  });

  // Negative 1: the chest already carries the requested palette colour, so the Mod's fresh game-thread
  // read refuses it by name. This is also the independent world read-back described in the header.
  const alreadyRequestId = `native_local_color_placed_object_already_${Date.now()}`;
  const already = await submitRefused(
    client,
    receipts,
    alreadyRequestId,
    () => target,
    COLOR_SELECTION,
    terminalTimeoutMs,
  );
  trace.push({ step: "negative_already_set", receipt: already.receipt });
  checks.alreadySetRefused = already.state === "rejected" && already.reasonCode === "color_already_set";

  // Negative 2: an index outside the palette. The runner does not know the bound; the Mod owns it.
  const outOfRangeRequestId = `native_local_color_placed_object_range_${Date.now()}`;
  const outOfRange = await submitRefused(
    client,
    receipts,
    outOfRangeRequestId,
    () => target,
    OUT_OF_RANGE_SELECTION,
    terminalTimeoutMs,
  );
  trace.push({ step: "negative_out_of_range", receipt: outOfRange.receipt });
  checks.outOfRangeRefused = outOfRange.state === "rejected" && outOfRange.reasonCode === "invalid_color_selection";

  // Negative 3: the actor's own tile holds no object, so there is no chest to repaint there. The
  // fixture asserts that tile is empty, which is what makes this the `color_target_unavailable` case.
  const absentRequestId = `native_local_color_placed_object_absent_${Date.now()}`;
  const absent = await submitRefused(
    client,
    receipts,
    absentRequestId,
    (fresh) => ({ x: fresh.tile.x, y: fresh.tile.y, targetId: target.targetId }),
    COLOR_SELECTION,
    terminalTimeoutMs,
  );
  trace.push({ step: "negative_no_chest", receipt: absent.receipt });
  checks.noChestRefused = absent.state === "rejected" && absent.reasonCode === "color_target_unavailable";

  // None of the refused requests moved the world: the chest still carries the colour the write set.
  const settled = await waitForActionable(client, await observeFresh(client), ACTIONABLE_TIMEOUT_MS);
  const settledColour = colourOfTarget(settled, target.targetId);
  checks.worldUnchangedByNegatives = settledColour === null ? "not_checked" : settledColour === evidence.color_after;

  const failures = Object.entries(checks)
    .filter(([, ok]) => ok === false || ok === "not_checked")
    .map(([name]) => name);
  if (failures.length > 0)
    throw new Error(`color_placed_object live contract failed: ${failures.join(",")};trace=${JSON.stringify(trace)}`);

  return { state: "passed", reasonCode: "placed_object_recolored", target: target.targetId, evidence, checks, trace };
}

/**
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the
 * published target (and its pre-observation colour), the receipt's evidence, and the world read
 * after — the SAME target id's live colour.
 *
 * Every world half that cannot be read is `not_checked`, never a pass, because "I could not look"
 * and "the colour did not move" must not read the same.
 */
export function assertColorPlacedObjectPostconditions({ target, selection, detail, evidence, before, after }) {
  const beforeColour = typeof before?.color === "string" && before.color.length > 0 ? before.color : null;
  const afterColour = typeof after?.color === "string" && after.color.length > 0 ? after.color : null;
  const worldObservable = beforeColour !== null && afterColour !== null;
  const receiptSelection = integerEvidenceValue(evidence.color_selection);
  return {
    // The evidence is exactly the frozen seven keys, in order, each with a non-empty value and no
    // stray separator: a `;` or `=` inside a value would make the Host's `;`-split unparseable, and a
    // missing or extra key would fail `exactEvidence`'s count.
    evidenceShapeExact: evidenceShapeIsFrozen(detail),
    // The receipt names THIS target: the opaque id, its tile and its location, not the coordinates alone.
    receiptNamesTheTarget:
      evidence.target === target.targetId &&
      evidence.tile === `${target.x},${target.y}` &&
      evidence.location === target.location,
    // ... and the palette index the request carried, not an echo of some other index.
    receiptNamesTheSelection: receiptSelection !== null && receiptSelection === selection,
    // The two colours differ and the receipt's own flag says the world changed.
    receiptColourMoved: evidence.color_before !== evidence.color_after && evidence.color_changed === "true",
    // The receipt's "before" is the colour the observation published before the write.
    receiptAgreesWithObservedBefore: beforeColour === null ? "not_checked" : evidence.color_before === beforeColour,
    // The world AFTER: the SAME target id republished by a fresh observation carries the colour the
    // receipt claims, so the colour is not taken on the receipt's word.
    worldShowsColourAfter: worldObservable ? afterColour === evidence.color_after : "not_checked",
    // ... and it really MOVED from the colour the fresh observation showed before.
    worldShowsColourMoved: worldObservable ? afterColour !== beforeColour : "not_checked",
  };
}

/** One refused submission over a fresh actionable revision; the terminal is returned verbatim. */
async function submitRefused(client, receipts, requestId, pointOf, colorSelection, terminalTimeoutMs) {
  const snapshot = await waitForActionable(client, await observeFresh(client), ACTIONABLE_TIMEOUT_MS);
  const point = pointOf(snapshot);
  if (!Number.isSafeInteger(point?.x) || !Number.isSafeInteger(point?.y))
    throw new Error(`color_placed_object_negative_tile_missing:${JSON.stringify(point ?? null)}`);
  const accepted = await executeFresh(client, {
    requestId,
    idempotencyKey: `${requestId}_idem`,
    action: ACTION,
    args: { x: point.x, y: point.y, expectedTargetId: point.targetId, colorSelection },
    snapshot,
    timeoutMs: 30_000,
  });
  const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
  return { state: terminal.state, reasonCode: terminal.reasonCode, receipt: summarizeReceipt(terminal) };
}

/** The chest the fixture placed, as discovery publishes it. */
function chooseColorTarget(snapshot) {
  const candidates = colorTargets(snapshot).filter(
    (entry) =>
      entry != null &&
      typeof entry.targetId === "string" &&
      entry.targetId.length > 0 &&
      Number.isSafeInteger(entry.x) &&
      Number.isSafeInteger(entry.y) &&
      typeof entry.location === "string" &&
      entry.location.length > 0 &&
      typeof entry.color === "string" &&
      entry.color.length > 0,
  );
  if (candidates.length === 0)
    throw new Error(`no repaintable chest is advertised: ${JSON.stringify(colorTargets(snapshot))}`);
  return candidates[0];
}

/** The raw `key=value;…` evidence text, whether the receipt carries it directly or under `detail`. */
function evidenceDetail(evidence) {
  if (typeof evidence === "string") return evidence;
  return typeof evidence?.detail === "string" ? evidence.detail : "";
}

/**
 * The evidence shape contract: exactly the frozen keys, in order, each `key=value` with a non-empty
 * value, and exactly one `=` per field (so no value smuggles a `;` or an `=` into the Host's split).
 */
function evidenceShapeIsFrozen(detail) {
  if (typeof detail !== "string" || detail.length === 0) return false;
  const fields = detail.split(";");
  if (fields.length !== EXPECTED_EVIDENCE_KEYS.length) return false;
  return fields.every((field, index) => {
    const at = field.indexOf("=");
    return (
      at > 0 &&
      field.slice(0, at) === EXPECTED_EVIDENCE_KEYS[index] &&
      field.length > at + 1 &&
      field.indexOf("=", at + 1) === -1
    );
  });
}

function colorTargets(snapshot) {
  const targets = snapshot?.colorTargets;
  return Array.isArray(targets) ? targets : [];
}

/** The live colour of one published target, or null when the fresh observation no longer publishes it. */
function colourOfTarget(snapshot, targetId) {
  const entry = colorTargets(snapshot).find((candidate) => candidate?.targetId === targetId);
  return typeof entry?.color === "string" && entry.color.length > 0 ? entry.color : null;
}

/** An exact non-negative integer evidence value, or null. */
function integerEvidenceValue(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && String(parsed) === value ? parsed : null;
}

/** `key=value;key=value` — the Mod's evidence shape. */
function parseEvidence(detail) {
  const values = {};
  for (const field of String(detail).split(";")) {
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
    let result;
    try {
      result = await runColorPlacedObjectSmoke(session.client, session.receipts, config);
    } catch (error) {
      result = {
        state: "blocked",
        topology: "native_local_player_fixture",
        reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
        latestReceipt: summarizeReceipt(session.client.state?.latestReceipt),
      };
    }
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    await session.close();
  }
}
