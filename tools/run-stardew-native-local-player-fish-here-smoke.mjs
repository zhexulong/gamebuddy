// fish_here live contract: production native client, bounded scope, revision-bound requests,
// exact receipt identity, terminal wait, and owned teardown come from the shared harness.
// Action-specific logic (which water the engine offers, and what its receipt must prove about
// the catch) stays in this runner.
//
// THE RECEIPT IS NOT THE PROOF, and neither is `succeeded`. Three independent facts are read
// here, each from the ENGINE's own objects rather than from the action's word for it:
//
//   1. the tile was castable because `GameLocation.canFishHere` + `isTileFishable` said so - the
//      published row this runner dispatches is the Mod's `waterTargets`, and the target id it
//      carries is the address the handler recomputes for that tile before it casts;
//   2. the catch was CREDITED by the engine's own win path, which is `farmer.fishCaught` growing
//      (`pullFishFromWater` -> `playerCaughtFishEndFunction` -> `farmer.caughtFish`) and the fish
//      landing in the pack (`doneHoldingFish`). A receipt that reports a fish but a flat
//      `fishCaught` means the action narrated a catch the engine never booked;
//   3. the cast COST what a cast costs, from the engine's own mutations: bait out of the rod,
//      stamina off the bar, and the rod's own durability answer.
//
// The negative half is deliberate: a request whose `expectedTargetId` names a different tile is
// refused by name and moves nothing, so a green run cannot come from a handler that accepts
// whatever it is handed.

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

const ACTION = "fish_here";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Cast at the nearest water the engine published and prove the engine credited the catch. */
export async function runFishHereSmoke(client, receipts, _config, { terminalTimeoutMs = 60_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const water = chooseWaterTarget(snapshot);

    const requestId = `native_local_fish_here_${Date.now()}`;
    // No deadline of this runner's own: the cast is bounded by the window `fish_here` publishes on `hello_ack`, which
    // is the same number the Mod admits a request with. A runner-written window is how this action's first live slice
    // was refused `bridge_rejected:invalid_deadline` - 120 s written against a 60 s window.
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: water.x, y: water.y, expectedTargetId: water.targetId },
      snapshot,
    });
    trace.push({
      step: "cast",
      action: ACTION,
      water: `${water.x},${water.y}`,
      targetId: water.targetId,
      receipt: summarizeReceipt(submitted),
    });

    // The cast is asynchronous by construction (the engine's own bite timer decides when), so the
    // terminal is the only verdict this contract accepts.
    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error(`fish_here_terminal_identity_mismatch:${terminal.requestId}:${terminal.executionId}`);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "fish_caught")
      throw new Error(
        `fish_here_failed:${terminal.state}/${terminal.reasonCode};${summarizeEvidence(terminal.evidence)}`,
      );

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "target", water.targetId);
    assertEvidence(evidence, "tile", `${water.x},${water.y}`);
    const fish = evidence.caught_qualified_item_id;
    if (typeof fish !== "string" || !fish.startsWith("("))
      throw new Error(`fish_here_evidence_fish_missing:${fish ?? "none"}`);
    if (typeof evidence.display_name !== "string" || evidence.display_name.length === 0)
      throw new Error("fish_here_evidence_display_name_missing");
    // Fact 2, the credit path: `fishCaught` is written in exactly one place - the engine's win
    // (`FishingRod.cs:1104`) - so a growing count IS the engine booking this catch.
    const caughtBefore = Number(evidence.fish_caught_before);
    const caughtAfter = Number(evidence.fish_caught_after);
    if (!(caughtAfter > caughtBefore))
      throw new Error(`fish_here_catch_not_credited:before=${caughtBefore};after=${caughtAfter};fish=${fish}`);
    // ...and the settle that follows it (`doneHoldingFish`) hands the fish to the pack.
    const inventoryBefore = Number(evidence.inventory_before);
    const inventoryAfter = Number(evidence.inventory_after);
    if (!(inventoryAfter > inventoryBefore))
      throw new Error(`fish_here_fish_not_in_pack:before=${inventoryBefore};after=${inventoryAfter};fish=${fish}`);
    // Fact 3, the cost, from the engine's own mutations. Bait is a real stack in the rod, so the
    // comparison is between two counts rather than against an assumed one.
    const baitBefore = Number(evidence.bait_before);
    const baitLeft = Number(evidence.bait_left);
    if (!(baitBefore > 0)) throw new Error(`fish_here_cast_without_bait:bait_before=${evidence.bait_before}`);
    if (!(baitLeft < baitBefore)) throw new Error(`fish_here_bait_not_consumed:before=${baitBefore};left=${baitLeft}`);
    const staminaDelta = Number(evidence.stamina_delta);
    if (!(staminaDelta < 0)) throw new Error(`fish_here_stamina_not_spent:delta=${evidence.stamina_delta}`);
    // `-1` is the Mod's answer for a rod with no tackle ("nothing to wear out"), so the field must
    // be PRESENT and must never read as a durable zero.
    if (evidence.rod_durability_left === undefined || Number.isNaN(Number(evidence.rod_durability_left)))
      throw new Error("fish_here_evidence_rod_durability_missing");
    // The bar's own numbers, which the engine decided (`BobberBar`) rather than this action.
    if (Number.isNaN(Number(evidence.fish_size)) || Number.isNaN(Number(evidence.quality)))
      throw new Error(`fish_here_engine_fish_facts_missing:size=${evidence.fish_size};quality=${evidence.quality}`);
    assertEvidence(evidence, "was_perfect", "true");
    assertEvidence(evidence, "was_perfect_basis", "declared_by_action");

    // The world is re-read after the terminal: the catch must not have taken the water with it,
    // and the snapshot must not be older than the receipt.
    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`fish_here_stale_reread:${after.revision}:${terminal.revision}`);
    if (waterTargetAt(after, water.x, water.y) == null)
      throw new Error(`fish_here_water_consumed_by_catch:tile=${water.x},${water.y}`);

    // Negative case. The same tile, addressed with ANOTHER tile's id: the binding is recomputed
    // before the rig is touched, so this must be refused by name and spend nothing. A handler
    // that casts anyway would make the positive half meaningless.
    const other = (after.waterTargets ?? []).find(
      (entry) =>
        Number.isInteger(entry?.x) && Number.isInteger(entry?.y) && (entry.x !== water.x || entry.y !== water.y),
    );
    const mismatchedTargetId = other?.targetId ?? `${water.targetId}_not_this_tile`;
    const negativeRequestId = `native_local_fish_here_binding_${Date.now()}`;
    const negativeSubmitted = await executeFresh(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { x: water.x, y: water.y, expectedTargetId: mismatchedTargetId },
      snapshot: after,
    });
    trace.push({
      step: "mismatched_binding",
      action: ACTION,
      water: `${water.x},${water.y}`,
      targetId: mismatchedTargetId,
      receipt: summarizeReceipt(negativeSubmitted),
    });
    const negativeTerminal = await waitForTerminal(receipts, negativeSubmitted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected")
      throw new Error(
        `fish_here_mismatched_binding_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`,
      );
    assertEvidence(parseEvidence(negativeTerminal.evidence), "tile", `${water.x},${water.y}`);
    const negativeEvidence = parseEvidence(negativeTerminal.evidence);
    if (negativeEvidence.fish_caught_after != null)
      throw new Error(`fish_here_refusal_booked_a_catch:${negativeEvidence.fish_caught_after}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "fish_caught",
      water,
      evidence,
      negative: { reasonCode: negativeTerminal.reasonCode },
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
 * The nearest water the engine published, or the named reason there is none.
 *
 * The Mod orders `waterTargets` nearest-first and caps the list, so the first row IS the closest
 * castable tile. A location that publishes none is the actor standing where no rod may be cast -
 * a world fact, not a failure of the request.
 */
function chooseWaterTarget(snapshot) {
  const targets = snapshot.waterTargets;
  if (targets == null || !Array.isArray(targets) || targets.length === 0)
    throw new Error(`fish_here_no_water_target:location=${snapshot.location}`);
  const water = targets.find(
    (entry) => typeof entry?.targetId === "string" && Number.isInteger(entry?.x) && Number.isInteger(entry?.y),
  );
  if (water == null) throw new Error(`fish_here_water_target_projection_incomplete:${JSON.stringify(targets)}`);
  return water;
}

/** The published water row at this tile, or null. Absent array and absent member both mean "not published". */
function waterTargetAt(snapshot, x, y) {
  const targets = snapshot.waterTargets;
  if (targets == null || !Array.isArray(targets)) return null;
  return targets.find((entry) => entry?.x === x && entry?.y === y) ?? null;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`fish_here_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function summarizeEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  return detail.length > 0 ? detail : "no_evidence";
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
    const result = await runFishHereSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
