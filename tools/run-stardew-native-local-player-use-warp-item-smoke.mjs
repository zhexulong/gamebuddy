// use_warp_item live contract: production native client, bounded scope, revision-bound
// requests, exact receipt identity, terminal wait, and owned teardown all come from the
// shared harness. Action-specific logic (totem discovery, the arrival postcondition, the
// negative case) stays in this runner.
//
// The receipt is not the proof. The world genuinely MOVES the actor (the native branch
// only schedules `DelayedAction.fadeAfterDelay(totemWarpForReal, 1000)`), so the terminal
// is the ARRIVAL and this runner waits for the destination location to become the actor's
// own -- the same shape `travel`/`ride_minecart`/`use_obelisk` use, never a same-frame
// read.

import {
  assertRequiredCapabilities,
  connectNativeLocalClient,
  executeFresh,
  executeFreshAfterReobserve,
  observeFresh,
  readNativeClientConfig,
  summarizeReceipt,
  waitForFreshSnapshot,
  waitForTerminal,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";

const ACTION = "use_warp_item";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];

/** Execute one native warp-totem activation. The arrival is the terminal. */
export async function runUseWarpItemSmoke(
  client,
  receipts,
  _config,
  { terminalTimeoutMs = 30_000, arrivalTimeoutMs = 30_000 } = {},
) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseWarpTotem(snapshot);
    const origin = snapshot.location;

    const requestId = `native_local_use_warp_item_${Date.now()}`;
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "activate_totem",
      action: ACTION,
      slot: target.slot,
      item: target.qualifiedItemId,
      origin,
      destination: target.destination,
      receipt: summarizeReceipt(submitted),
    });

    // Either shape is legal: a totem whose native branch arms the routine answers
    // `accepted` and warps later, and a refusal answers with an immediate terminal. The
    // terminal is what this contract asserts.
    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error(`use_warp_item_terminal_identity_mismatch:${terminal.requestId}:${terminal.executionId}`);
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "warp_item_arrived")
      throw new Error(
        `use_warp_item_failed:${terminal.state}/${terminal.reasonCode};${summarizeEvidence(terminal.evidence)}`,
      );

    // Each fact is asserted on the receipt that carries it. The terminal above is the SHARED arrival
    // terminal (`CompleteTravelAfterWarp`), whose evidence describes the arrival; the dispatch facts -
    // the slot, the stack pair and whether the native call actually started the routine - are emitted by
    // this action's own dispatch receipt.
    const dispatchEvidence = parseEvidence(submitted.evidence);
    assertEvidence(dispatchEvidence, "slot", String(target.slot));
    assertEvidence(dispatchEvidence, "item", target.qualifiedItemId);
    assertEvidence(dispatchEvidence, "destination", target.destination);
    assertEvidence(dispatchEvidence, "native_use_started", "true");
    // The native action-button dispatch consumes one unit after a true return; a receipt
    // that cannot say the stack moved is not proof that the pair ran.
    if (!(Number(dispatchEvidence.stack_after) < Number(dispatchEvidence.stack_before)))
      throw new Error(
        `use_warp_item_stack_not_consumed:before=${dispatchEvidence.stack_before};after=${dispatchEvidence.stack_after}`,
      );

    // The world change, re-read after the terminal: the actor is IN the destination the
    // totem names. A same-frame read of the destination is the bug this waits out.
    const arrived = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: arrivalTimeoutMs,
      check: (candidate) => candidate.location === target.destination,
    });
    if (arrived.location !== target.destination)
      throw new Error(
        `use_warp_item_world_unchanged:expected=${target.destination};actual=${arrived.location};tile=${arrived.tile?.x},${arrived.tile?.y}`,
      );

    // Negative case. The same slot no longer holds the totem the native pair consumed, so
    // the same intent must be REFUSED and the world must not move: an action that reports
    // a second arrival, or warps a second time, fails the run rather than passing on a
    // green receipt.
    // The arrival can still be finishing (the totem's freeze plus the warp fade), and admission answers
    // `player_not_actionable` for that - true, but not the clause under test. Wait for an actionable
    // actor, then send: the refusal must come from the slot no longer holding the totem.
    const ready = await waitForFreshSnapshot(client, {
      minRevision: terminal.revision,
      timeoutMs: arrivalTimeoutMs,
      check: (candidate) => candidate.actionable === true && candidate.activeExecution == null,
    });
    const negativeRequestId = `native_local_use_warp_item_consumed_${Date.now()}`;
    const negativeSubmitted = await executeFreshAfterReobserve(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { slot: target.slot, expectedQualifiedItemId: target.qualifiedItemId },
      timeoutMs: 30_000,
    });
    trace.push({
      step: "activate_consumed_totem",
      action: ACTION,
      slot: target.slot,
      receipt: summarizeReceipt(negativeSubmitted),
    });
    const negativeTerminal = await waitForTerminal(receipts, negativeSubmitted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected")
      throw new Error(
        `use_warp_item_consumed_totem_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`,
      );
    const REFUSALS = ["item_not_owned_in_slot", "item_slot_changed", "item_not_a_warp_totem", "warp_item_already_at_destination"];
    if (!REFUSALS.includes(negativeTerminal.reasonCode))
      throw new Error(`use_warp_item_consumed_totem_unexpected_refusal:${negativeTerminal.reasonCode}`);

    const after = await observeFresh(client);
    if (after.location !== arrived.location)
      throw new Error(
        `use_warp_item_refusal_moved_world:before=${arrived.location};after=${after.location}`,
      );

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "warp_item_arrived",
      item: target.qualifiedItemId,
      slot: target.slot,
      arrival: { origin, destination: arrived.location, tile: arrived.tile },
      // The dispatch facts, which is what this contract is about; the arrival facts are in `arrival`.
      evidence: dispatchEvidence,
      negative: { reasonCode: negativeTerminal.reasonCode, location: after.location },
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
 * The warp totem the fixture armed, taken from the Mod's own discovery projection. This
 * runner never picks an inventory slot: the Mod publishes the slot it can actually route,
 * and re-resolves the item on the game thread.
 */
function chooseWarpTotem(snapshot) {
  const targets = snapshot.warpItemTargets;
  if (targets == null || !Array.isArray(targets) || targets.length === 0)
    throw new Error("use_warp_item_no_advertised_totem");
  const usable = targets.filter(
    (entry) =>
      entry?.qualifiedItemId != null &&
      Number.isInteger(entry.slot) &&
      entry.stack >= 1 &&
      typeof entry.destination === "string" &&
      entry.destination.length > 0,
  );
  if (usable.length === 0)
    throw new Error(`use_warp_item_no_usable_totem:candidates=${JSON.stringify(summarizeCandidates(targets))}`);
  const away = usable.filter((entry) => entry.destination !== snapshot.location);
  if (away.length === 0)
    throw new Error(`use_warp_item_declared_given_absent:location=${snapshot.location};candidates=${JSON.stringify(summarizeCandidates(usable))}`);
  return away[0];
}

function summarizeCandidates(targets) {
  return (targets ?? []).map((entry) => ({
    slot: entry?.slot,
    item: entry?.qualifiedItemId,
    stack: entry?.stack,
    destination: entry?.destination,
  }));
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected)
    throw new Error(`use_warp_item_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
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
    const result = await runUseWarpItemSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
