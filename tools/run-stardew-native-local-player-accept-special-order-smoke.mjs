// accept_special_order live contract: production native client, bounded scope, revision-bound requests,
// exact receipt identity, terminal wait and owned teardown come from the shared harness.
// Action-specific logic (the offer discovery, the accept postcondition, the world change after the
// terminal, the stale negative) stays in this runner.
//
// The receipt is not the proof. The accept is the board's own two-state write -
// `acceptedSpecialOrderTypes.Add(orderType)` and `FarmerTeam.AddSpecialOrder(questKey, seed)` - and three
// things are observed:
//
//   1. the RECEIPT's own postcondition, read off the world after the writes: the team's order list grew by
//      exactly one and now names an order with this `questKey` whose state is InProgress, and the board
//      type is marked;
//   2. the MOD'S PUBLISHED FACT changes: `specialOrderTargets` carries an offer only while no board has
//      been used for it and it is not already active, so after the accept the offer must be ABSENT from a
//      fresh snapshot - a stronger claim than "the receipt said ok" - and the snapshot's own
//      `activeSpecialOrderKeys` must now name the accepted order;
//   3. RESUBMITTING THE STALE ID is refused by name and moves nothing: a second `special_order_accepted`
//      there would be accepting an order that is already active, and a silently-green run fails instead of
//      passing.
//
// The runner never picks the order: it comes from the `specialOrderTargets` discovery projection the Mod
// publishes, and the Mod re-resolves it on the game thread.

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

const ACTION = "accept_special_order";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
// The order named by a request that already took it can only be refused by one of these; anything else
// (including a second success) fails the run.
const STALE_REFUSALS = [
  "special_order_already_active",
  "special_order_board_already_used",
  "special_order_target_moved",
  "special_order_unavailable",
];

/** Accept one offered special order and prove the accept changed the world. */
export async function runAcceptSpecialOrderSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseSpecialOrderTarget(snapshot);

    const requestId = `native_local_accept_special_order_${Date.now()}`;
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({ step: "accept", action: ACTION, target: target.targetId, receipt: summarizeReceipt(submitted) });

    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error("accept_special_order terminal does not belong to this request");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "special_order_accepted")
      throw new Error(
        `accept_special_order did not accept the offer: state=${terminal.state};reason=${terminal.reasonCode};evidence=${evidenceDetail(terminal.evidence)}`,
      );

    const evidence = parseEvidence(terminal.evidence);

    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`accept_special_order_stale_reread:${after.revision}:${terminal.revision}`);

    const checks = assertAcceptSpecialOrderPostconditions({
      target,
      evidence,
      targetsAfter: specialOrderTargets(after),
      activeOrderKeysAfter: activeSpecialOrderKeys(after),
    });
    trace.push({
      step: "observed",
      checks,
      evidence,
      targetsAfter: specialOrderTargets(after),
      activeOrderKeys: after.activeSpecialOrderKeys ?? null,
    });

    const failed = Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name);
    if (failed.length > 0)
      throw new Error(`accept_special_order live contract failed: ${failed.join(",")};checks=${JSON.stringify(checks)}`);

    // Negative case: the stale id names an offer that has already been taken. A second accepted receipt, or
    // a world that moves, fails the run rather than passing on a green receipt.
    const staleRequestId = `native_local_accept_special_order_stale_${Date.now()}`;
    const stale = await executeFresh(client, {
      requestId: staleRequestId,
      idempotencyKey: `${staleRequestId}_idem`,
      action: ACTION,
      args: { expectedTargetId: target.targetId },
      snapshot: after,
      timeoutMs: 30_000,
    });
    const staleTerminal = await waitForTerminal(receipts, stale, terminalTimeoutMs);
    trace.push({ step: "stale_target", action: ACTION, target: target.targetId, receipt: summarizeReceipt(staleTerminal) });
    checks.staleTargetRefused = staleTerminal.state === "rejected" && STALE_REFUSALS.includes(staleTerminal.reasonCode);
    if (checks.staleTargetRefused !== true)
      throw new Error(`accept_special_order_stale_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode}`);

    const settled = await observeFresh(client);
    if ((specialOrderTargets(settled) ?? []).some((entry) => entry?.targetId === target.targetId))
      throw new Error(`accept_special_order_stale_readvertised:${target.targetId}`);
    const activeAfterStale = activeSpecialOrderKeys(settled);
    if (activeAfterStale !== null && !activeAfterStale.includes(target.questKey))
      throw new Error(`accept_special_order_stale_moved_world:${JSON.stringify(activeAfterStale)}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "special_order_accepted",
      target: target.targetId,
      questKey: target.questKey,
      checks,
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
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the receipt's
 * own postcondition fields, the offer's survival in the fresh snapshot, and the snapshot's own active-order
 * read.
 *
 * `offerNoLongerAdvertised` and `activeListNamesOrder` are `not_checked` - not `true` - when the
 * observation surface does not carry the field at all, because "I could not look" and "the offer was taken"
 * must never read the same, and the caller treats `not_checked` as a failure.
 */
export function assertAcceptSpecialOrderPostconditions({ target, evidence, targetsAfter, activeOrderKeysAfter }) {
  const targetsObservable = Array.isArray(targetsAfter);
  const activeObservable = Array.isArray(activeOrderKeysAfter);
  const ordersBefore = integerEvidence(evidence.orders_before);
  const ordersAfter = integerEvidence(evidence.orders_after);
  return {
    // The receipt's postcondition, read off the world after the writes.
    receiptSaysAccepted:
      evidence.board_marker_after === "true" &&
      evidence.order_present_after === "true" &&
      evidence.order_in_progress_after === "true",
    // The creation write added exactly one order: adding none, or two, is not the native write half.
    activeListGrewByOne: ordersBefore !== null && ordersAfter !== null && ordersAfter - ordersBefore === 1,
    // The board's own marker flipped, which is what hides its Accept buttons and gates its action tile.
    boardTypeMarked: evidence.board_marker_before === "false" && evidence.board_marker_after === "true",
    // The receipt names the offer this run read, not some other one.
    evidenceNamesTheOffer: evidence.quest_key === target.questKey,
    // The published fact changed: an offer is advertised only while it is still acceptable.
    offerNoLongerAdvertised: targetsObservable
      ? targetsAfter.every((entry) => entry?.targetId !== target.targetId)
      : "not_checked",
    // The board's whole offer set is gone: the fixture published exactly one, and it is now taken.
    noOfferLeftOnTheBoard: targetsObservable ? targetsAfter.length === 0 : "not_checked",
    // The snapshot's own active-order read now names the accepted order.
    activeListNamesOrder: activeObservable ? activeOrderKeysAfter.includes(target.questKey) : "not_checked",
  };
}

/**
 * The offer the fixture established, as the Mod's discovery projection publishes it. The fixture reduces
 * the pool to exactly one, so anything other than exactly one well-formed target fails the run rather than
 * letting it pick among candidates.
 */
function chooseSpecialOrderTarget(snapshot) {
  const targets = specialOrderTargets(snapshot);
  if (targets === null) throw new Error(`accept_special_order_no_discovery_surface:${snapshot?.location ?? "unknown"}`);
  const valid = targets.filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      entry.targetId.length > 0 &&
      typeof entry.questKey === "string" &&
      entry.questKey.length > 0,
  );
  if (valid.length !== 1)
    throw new Error(`accept_special_order_declared_given_absent:specialOrderTargets=${JSON.stringify(targets)}`);
  return valid[0];
}

/** The discovery projection, or null when the observation surface does not carry it at all. */
function specialOrderTargets(snapshot) {
  const targets = snapshot?.specialOrderTargets;
  return Array.isArray(targets) ? targets : null;
}

/** The active-order read, or null when the observation surface does not carry it at all. */
function activeSpecialOrderKeys(snapshot) {
  const keys = snapshot?.activeSpecialOrderKeys;
  return Array.isArray(keys) ? keys : null;
}

function integerEvidence(value) {
  if (typeof value !== "string" || !/^-?\d+$/.test(value)) return null;
  return Number(value);
}

/** `key=value;key=value` - the Mod's evidence shape, carried on the wire as `{ detail }`. */
function parseEvidence(evidence) {
  const text = typeof evidence === "string" ? evidence : typeof evidence?.detail === "string" ? evidence.detail : "";
  if (text.length === 0) throw new Error("native_local_evidence_empty");
  const values = {};
  for (const field of text.split(";")) {
    const at = field.indexOf("=");
    if (at > 0) values[field.slice(0, at)] = field.slice(at + 1);
  }
  return values;
}

function evidenceDetail(evidence) {
  const text = typeof evidence === "string" ? evidence : typeof evidence?.detail === "string" ? evidence.detail : "";
  return text.length > 0 ? text : "no_evidence";
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runAcceptSpecialOrderSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
