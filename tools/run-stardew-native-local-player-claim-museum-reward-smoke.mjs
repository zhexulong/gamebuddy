// claim_museum_reward live contract: production native client, bounded scope, revision-bound requests,
// exact receipt identity, terminal wait and owned teardown come from the shared harness.
// Action-specific logic (the reward-set discovery, the collect postcondition, the world change after the
// terminal, the stale negative) stays in this runner.
//
// The receipt is not the proof. The museum has no persistent container - the reward menu is built from a
// COMPUTED list - so three things are observed:
//
//   1. the RECEIPT's own postcondition, read off the world after the call: the enumeration returned the
//      whole set the published target named, every returned reward was recorded as collected and deposited,
//      and a fresh read of the read-only collectable set is empty;
//   2. the MOD'S PUBLISHED FACT changes: `museumRewardTargets` carries a target only while there is
//      something to collect, so after the claim the target must be ABSENT from a fresh snapshot - a
//      stronger claim than "the receipt said ok", because the published set is the same read-only predicate
//      the claim itself collects;
//   3. RESUBMITTING THE STALE ID is refused by name and moves nothing: there is nothing left to collect, so
//      a second `museum_rewards_collected` there would be collecting nothing and claiming it, and a
//      silently-green run fails instead of passing.
//
// The runner never picks the reward set: it comes from the `museumRewardTargets` discovery projection the
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

const ACTION = "claim_museum_reward";
const REQUIRED_CAPABILITIES = ["cancel_active_execution", "inspect_self", ACTION];
// The set named by a request that already collected it can only be refused by one of these; anything else
// (including a second success) fails the run.
const STALE_REFUSALS = ["museum_rewards_empty", "museum_reward_target_moved"];

/** Collect the museum's owed rewards and prove the collect changed the world. */
export async function runClaimMuseumRewardSmoke(client, receipts, _config, { terminalTimeoutMs = 5_000 } = {}) {
  const trace = [];
  try {
    const snapshot = await observeFresh(client, { actionable: true });
    assertRequiredCapabilities(snapshot, REQUIRED_CAPABILITIES);
    const target = chooseMuseumRewardTarget(snapshot);

    const requestId = `native_local_claim_museum_reward_${Date.now()}`;
    const submitted = await executeFresh(client, {
      requestId,
      idempotencyKey: `${requestId}_idem`,
      action: ACTION,
      args: { expectedTargetId: target.targetId },
      snapshot,
      timeoutMs: 30_000,
    });
    trace.push({
      step: "collect",
      action: ACTION,
      target: target.targetId,
      rewardCount: target.rewardCount,
      receipt: summarizeReceipt(submitted),
    });

    const terminal = await waitForTerminal(receipts, submitted, terminalTimeoutMs);
    if (terminal.requestId !== requestId || terminal.executionId !== submitted.executionId)
      throw new Error("claim_museum_reward terminal does not belong to this request");
    if (terminal.state !== "succeeded" || terminal.reasonCode !== "museum_rewards_collected")
      throw new Error(
        `claim_museum_reward did not collect the rewards: state=${terminal.state};reason=${terminal.reasonCode};evidence=${evidenceDetail(terminal.evidence)}`,
      );

    const evidence = parseEvidence(terminal.evidence);

    const after = await observeFresh(client);
    if (after.revision < terminal.revision)
      throw new Error(`claim_museum_reward_stale_reread:${after.revision}:${terminal.revision}`);

    const checks = assertClaimMuseumRewardPostconditions({
      target,
      evidence,
      targetsAfter: museumRewardTargets(after),
    });
    trace.push({ step: "observed", checks, evidence, targetsAfter: museumRewardTargets(after) });

    const failed = Object.entries(checks)
      .filter(([, ok]) => ok === false || ok === "not_checked")
      .map(([name]) => name);
    if (failed.length > 0)
      throw new Error(`claim_museum_reward live contract failed: ${failed.join(",")};checks=${JSON.stringify(checks)}`);

    // Negative case: the stale id names a reward set that has already been collected. A second success, or a
    // world that moves, fails the run rather than passing on a green receipt.
    const staleRequestId = `native_local_claim_museum_reward_stale_${Date.now()}`;
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
      throw new Error(`claim_museum_reward_stale_not_refused:${staleTerminal.state}/${staleTerminal.reasonCode}`);

    const settled = await observeFresh(client);
    if ((museumRewardTargets(settled) ?? []).length > 0)
      throw new Error(`claim_museum_reward_stale_readvertised:${JSON.stringify(museumRewardTargets(settled))}`);

    return {
      state: "passed",
      topology: "native_local_player_fixture",
      reasonCode: "museum_rewards_collected",
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
 * The live contract's judgement, as a PURE function so it can be tested without a transport: the receipt's
 * own postcondition fields and the reward set's survival in the fresh snapshot.
 *
 * `publishedFactChanged` is `not_checked` - not `true` - when the observation surface does not carry the
 * field at all, because "I could not look" and "there is nothing left to collect" must never read the same,
 * and the caller treats `not_checked` as a failure.
 */
export function assertClaimMuseumRewardPostconditions({ target, evidence, targetsAfter }) {
  const targetsObservable = Array.isArray(targetsAfter);
  const before = integerEvidence(evidence.rewards_before);
  const returned = integerEvidence(evidence.rewards_returned);
  const delivered = integerEvidence(evidence.rewards_delivered);
  const recorded = integerEvidence(evidence.rewards_recorded);
  const after = integerEvidence(evidence.rewards_after);
  const mailBefore = integerEvidence(evidence.mail_flags_before);
  const mailAfter = integerEvidence(evidence.mail_flags_after);
  return {
    // The receipt's own verdict, read off the world after the call.
    receiptSaysCollected: evidence.rewards_collected === "true",
    // The published target named exactly the set the enumeration returned, and it was not empty.
    returnedTheWholePublishedSet: before !== null && returned !== null && before >= 1 && before === returned,
    // Every returned reward was deposited into the pack and recorded as collected.
    deliveredAndRecordedTheWholeSet:
      returned !== null &&
      returned >= 1 &&
      delivered === returned &&
      recorded === returned,
    // A fresh read of the read-only collectable set found nothing left.
    nothingLeftToCollect: after === 0,
    // Collecting records something: each item's own key, and any reward's completion flag.
    somethingWasRecorded: mailBefore !== null && mailAfter !== null && mailAfter > mailBefore,
    // The published fact changed: a reward set is advertised only while it is still collectable.
    publishedFactChanged: targetsObservable
      ? targetsAfter.every((entry) => entry?.targetId !== target.targetId) && targetsAfter.length === 0
      : "not_checked",
  };
}

/**
 * The reward set the fixture established, as the Mod's discovery projection publishes it. A museum
 * advertises at most one target - the whole set at once - so anything other than exactly one well-formed
 * target fails the run rather than letting it pick among candidates.
 */
function chooseMuseumRewardTarget(snapshot) {
  const targets = museumRewardTargets(snapshot);
  if (targets === null) throw new Error(`claim_museum_reward_no_discovery_surface:${snapshot?.location ?? "unknown"}`);
  const valid = targets.filter(
    (entry) =>
      typeof entry?.targetId === "string" &&
      entry.targetId.length > 0 &&
      Number.isInteger(entry.rewardCount) &&
      entry.rewardCount >= 1,
  );
  if (valid.length !== 1)
    throw new Error(`claim_museum_reward_declared_given_absent:museumRewardTargets=${JSON.stringify(targets)}`);
  return valid[0];
}

/** The discovery projection, or null when the observation surface does not carry it at all. */
function museumRewardTargets(snapshot) {
  const targets = snapshot?.museumRewardTargets;
  return Array.isArray(targets) ? targets : null;
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
    const result = await runClaimMuseumRewardSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
