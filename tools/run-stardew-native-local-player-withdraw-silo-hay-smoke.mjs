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

const ACTION = "withdraw_silo_hay";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
const HAY_QUALIFIED_ITEM_ID = "(O)178";

/**
 * withdraw_silo_hay live contract.
 *
 * The receipt is not the proof. Two things are observed directly:
 *   1. the declared Given is one Hay in a Farm Silo, so ONE real withdrawal
 *      drains it — the run then reads the silo's own `hay` projection and the
 *      actor's carried Hay out of a FRESH snapshot, not out of the receipt;
 *   2. with the store empty, the same target must be REFUSED with a World that
 *      did not move. That is the negative case: an action that reports success
 *      without changing anything, or that silently no-ops on an empty silo, fails
 *      here rather than passing on a green receipt.
 *
 * The runner never chooses the target tile or the item: both come from the
 * discovery projection the Mod publishes, and the Mod re-resolves them on the
 * game thread.
 */
export async function runWithdrawSiloHaySmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseAdjacentSiloTarget(snapshot);
    const carriedBefore = carriedHay(snapshot);

    const requestId = `native_local_withdraw_silo_hay_${Date.now()}`;
    const accepted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ step: "withdraw", action: ACTION, target: target.targetId, siloHayBefore: target.hay, carriedBefore, receipt: summarizeReceipt(accepted) });
    const terminal = await waitForTerminal(receipts, accepted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== accepted.executionId)
      throw new Error("silo_withdraw_terminal_identity_mismatch");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "silo_hay_taken")
      throw new Error(`silo_withdraw_failed:${terminal.reasonCode}`);

    const evidence = parseEvidence(terminal.evidence);
    assertEvidence(evidence, "silo_hay_before", String(target.hay));
    assertEvidence(evidence, "silo_hay_after", String(target.hay - 1));
    assertEvidence(evidence, "silo_hay_decreased", "true");
    assertEvidence(evidence, "carried_before", String(carriedBefore));
    assertEvidence(evidence, "carried_after", String(carriedBefore + 1));
    assertEvidence(evidence, "carried_hay_increased", "true");

    // The world change, re-read after the terminal: silo store down by exactly one
    // AND carried Hay up by exactly one. Either half alone is not the transfer.
    const after = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(after, REQUIRED_CAPABILITIES);
    const siloHayAfter = siloHayFor(after, target.targetId);
    const carriedAfter = carriedHay(after);
    if (siloHayAfter !== target.hay - 1)
      throw new Error(`silo_withdraw_world_silo_unchanged:${siloHayAfter}:${target.hay - 1}`);
    if (carriedAfter !== carriedBefore + 1)
      throw new Error(`silo_withdraw_world_carried_unchanged:${carriedAfter}:${carriedBefore + 1}`);

    // Negative case: the store is empty now, so the SAME target must be refused and
    // nothing may change. A success here (or a silent no-op) is the failure.
    const negativeRequestId = `native_local_withdraw_silo_hay_empty_${Date.now()}`;
    const negativeAccepted = await executeFresh(client, {
      requestId: negativeRequestId,
      idempotencyKey: `${negativeRequestId}_idem`,
      action: ACTION,
      args: { x: target.x, y: target.y, expectedTargetId: target.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    trace.push({ step: "withdraw_empty", action: ACTION, target: target.targetId, receipt: summarizeReceipt(negativeAccepted) });
    const negativeTerminal = await waitForTerminal(receipts, negativeAccepted, terminalTimeoutMs);
    if (negativeTerminal.state !== "rejected" || negativeTerminal.reasonCode !== "silo_empty")
      throw new Error(`silo_withdraw_empty_not_refused:${negativeTerminal.state}/${negativeTerminal.reasonCode}`);

    const unchanged = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(unchanged, REQUIRED_CAPABILITIES);
    const siloHayUnchanged = siloHayFor(unchanged, target.targetId);
    const carriedUnchanged = carriedHay(unchanged);
    if (siloHayUnchanged !== siloHayAfter || carriedUnchanged !== carriedAfter)
      throw new Error(`silo_withdraw_empty_moved_world:${siloHayUnchanged}/${carriedUnchanged}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "silo_hay_taken",
      target: target.targetId,
      siloHay: { before: target.hay, after: siloHayAfter },
      carriedHay: { before: carriedBefore, after: carriedAfter },
      negative: { reasonCode: negativeTerminal.reasonCode, siloHay: siloHayUnchanged, carriedHay: carriedUnchanged },
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

/** The silo the fixture stands the actor at: an advertised target already in reach. */
function chooseAdjacentSiloTarget(snapshot) {
  const targets = snapshot.siloTargets ?? [];
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("silo_withdraw_no_advertised_target");
  const adjacent = targets.filter((entry) => entry?.targetId
    && Number.isInteger(entry.x) && Number.isInteger(entry.y)
    && Math.max(Math.abs(entry.x - snapshot.tile.x), Math.abs(entry.y - snapshot.tile.y)) <= 1);
  if (adjacent.length === 0) throw new Error("silo_withdraw_no_adjacent_target");
  const stocked = adjacent.filter((entry) => Number.isInteger(entry.hay) && entry.hay >= 1);
  if (stocked.length === 0) throw new Error("silo_withdraw_declared_given_absent");
  return stocked[0];
}

/** The actor's carried Hay, summed across every stack, from the live projection. */
function carriedHay(snapshot) {
  return (snapshot.inventoryItemFacts ?? [])
    .filter((entry) => entry?.qualifiedItemId === HAY_QUALIFIED_ITEM_ID && Number.isInteger(entry.stack))
    .reduce((total, entry) => total + entry.stack, 0);
}

/** The named silo's own store, read from a fresh observation. Missing means gone. */
function siloHayFor(snapshot, targetId) {
  const entry = (snapshot.siloTargets ?? []).find((candidate) => candidate?.targetId === targetId);
  if (entry === undefined || !Number.isInteger(entry.hay)) throw new Error(`silo_withdraw_target_gone:${targetId}`);
  return entry.hay;
}

function assertEvidence(evidence, key, expected) {
  if (evidence[key] !== expected) throw new Error(`silo_withdraw_evidence_${key}:${evidence[key] ?? "missing"}:${expected}`);
}

function parseEvidence(evidence) {
  const detail = typeof evidence?.detail === "string" ? evidence.detail : "";
  if (detail.length === 0) throw new Error("native_local_evidence_empty");
  return Object.fromEntries(detail.split(";").map((pair) => {
    const index = pair.indexOf("=");
    return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : null;
  }).filter(Boolean));
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try { const result = await runWithdrawSiloHaySmoke(session.client, session.receipts, config); console.log(JSON.stringify(result)); if (result.state !== "passed") process.exitCode = 2; }
  finally { session.close(); }
}
