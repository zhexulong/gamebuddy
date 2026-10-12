// accept_daily_quest live contract: production native client, bounded scope, revision-bound
// requests, exact receipt identity, terminal wait and owned teardown come from the shared harness.
// Action-specific logic (the offer discovery, the accept postcondition, the world change after the
// terminal, the stale negative) stays in this runner.
//
// The receipt is not the proof. The accept writes are a sequence of native state writes
// (Billboard.cs:366-372), and three things are observed:
//
//   1. the RECEIPT's own postcondition, read off the world after the writes: the quest is in
//      `Game1.player.questLog` exactly once, `Quest.accepted` is true and
//      `Farmer.acceptedDailyQuest` is true;
//   2. the MOD'S PUBLISHED FACT changes: `dailyQuestTargets` carries the offer only while the
//      game's own `Game1.CanAcceptDailyQuest()` says it is acceptable, so after the accept the
//      offer must be ABSENT from a fresh snapshot and `acceptedDailyQuest` must read true. That is
//      a stronger claim than "the receipt said ok";
//   3. RESUBMITTING THE STALE ID is refused by name and moves nothing: the offer it named has
//      already been taken, so a second `daily_quest_accepted` there would be accepting nothing and
//      claiming it, and a silently-green run fails instead of passing.
//
// The runner never picks the quest: it comes from the `dailyQuestTargets` discovery projection the
// Mod publishes, and the Mod re-resolves it on the game thread.

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

const ACTION = "accept_daily_quest";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
// The offer named by a request that already took it can only be refused by one of these; anything
// else (including a second success) fails the run.
const STALE_REFUSALS = ["daily_quest_already_accepted", "daily_quest_target_moved", "daily_quest_unavailable"];

/** Accept the day's posted quest and prove the accept changed the world. */
export async function runAcceptDailyQuestSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseDailyQuest(snapshot);

    const requestId = `native_local_accept_daily_quest_${Date.now()}`;
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
      throw new Error("accept_daily_quest terminal does not belong to this request");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "daily_quest_accepted")
      throw new Error(
        `accept_daily_quest did not accept the offer: state=${terminal.state};reason=${terminal.reasonCode};evidence=${evidenceDetail(terminal.evidence)}`,
      );

    const evidence = parseEvidence(terminal.evidence);

    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`accept_daily_quest_stale_reread:${after.revision}:${terminal.revision}`);

    const checks = assertAcceptDailyQuestPostconditions({
      target,
      evidence,
      targetsAfter: dailyQuestTargets(after),
      acceptedDailyQuestAfter: typeof after.acceptedDailyQuest === "boolean" ? after.acceptedDailyQuest : undefined,
    });
    trace.push({
      step: "observed",
      checks,
      evidence,
      targetsAfter: dailyQuestTargets(after),
      acceptedDailyQuest: after.acceptedDailyQuest ?? null,
    });

    const failed = Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name);
    if (failed.length > 0)
      throw new Error(`accept_daily_quest live contract failed: ${failed.join(",")};checks=${JSON.stringify(checks)}`);

    // Negative case: the stale id names an offer that has already been taken. A second accepted
    // receipt, or a world that moves, fails the run rather than passing on a green receipt.
    const staleRequestId = `native_local_accept_daily_quest_stale_${Date.now()}`;
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
      throw new Error(`accept_daily_quest_stale_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode}`);

    const settled = await observeFresh(client);
    if (settled.acceptedDailyQuest !== true)
      throw new Error(`accept_daily_quest_stale_moved_world:acceptedDailyQuest=${settled.acceptedDailyQuest}`);
    if ((dailyQuestTargets(settled) ?? []).some((entry) => entry?.targetId === target.targetId))
      throw new Error(`accept_daily_quest_stale_readvertised:${target.targetId}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "daily_quest_accepted",
      target: target.targetId,
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
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the
 * receipt's own postcondition fields, the offer's survival in the fresh snapshot, and the world
 * flag the Mod publishes after the accept.
 *
 * `offerNoLongerAdvertised` and `worldReportsAccepted` are `not_checked` - not `true` - when the
 * observation surface does not carry the field at all, because "I could not look" and "the offer
 * was taken" must never read the same, and the caller treats `not_checked` as a failure.
 */
export function assertAcceptDailyQuestPostconditions({ target, evidence, targetsAfter, acceptedDailyQuestAfter }) {
  const targetsObservable = Array.isArray(targetsAfter);
  return {
    // The receipt's postcondition, read off the world after the writes.
    receiptSaysAccepted: evidence.accepted_after === "true" && evidence.accepted_daily_after === "true",
    // Exactly one entry in the log: an accept that logged nothing, or logged twice, is not the
    // native write half.
    questEnteredLogExactlyOnce: evidence.quest_log_before === "0" && evidence.quest_log_after === "1",
    // The rest of the board's own write half, read back.
    boardFieldsWritten:
      evidence.daily_after === "true" && evidence.can_be_cancelled_after === "true" && evidence.days_left_after === "2",
    // The published fact changed: the offer is advertised only while it is still acceptable.
    offerNoLongerAdvertised: targetsObservable
      ? targetsAfter.every((entry) => entry?.targetId !== target.targetId)
      : "not_checked",
    // The Mod's own world flag agrees the player has taken the daily quest today.
    worldReportsAccepted:
      typeof acceptedDailyQuestAfter === "boolean" ? acceptedDailyQuestAfter === true : "not_checked",
  };
}

/**
 * The offer the fixture established, as the Mod's discovery projection publishes it. There is at
 * most one quest of the day, so anything other than exactly one well-formed target fails the run
 * rather than letting it pick among candidates.
 */
function chooseDailyQuest(snapshot) {
  const targets = dailyQuestTargets(snapshot);
  if (targets === null) throw new Error(`accept_daily_quest_no_discovery_surface:${snapshot?.location ?? "unknown"}`);
  const valid = targets.filter((entry) => typeof entry?.targetId === "string" && entry.targetId.length > 0);
  if (valid.length !== 1)
    throw new Error(`accept_daily_quest_declared_given_absent:dailyQuestTargets=${JSON.stringify(targets)}`);
  return valid[0];
}

/** The discovery projection, or null when the observation surface does not carry it at all. */
function dailyQuestTargets(snapshot) {
  const targets = snapshot?.dailyQuestTargets;
  return Array.isArray(targets) ? targets : null;
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
    const result = await runAcceptDailyQuestSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
