#!/usr/bin/env node
/**
 * Read-only M7 `claim_bundle_reward` preflight verifier.
 *
 * The source audit currently identifies the reward collection as a
 * presentation-owned `ItemGrabMenu` route and blocks target-version semantic
 * realization. This verifier intentionally has no bridge client or mutation
 * path: it checks the exact receipt/fresh-reader correlation shape that the
 * shared Portfolio integration must eventually provide, then reports that the
 * action remains BLOCKED until a source-owned non-UI semantic edge exists.
 */
const ACTION = "claim_bundle_reward";
const TOPOLOGY = "single_player_native_companion";
const SOURCE_BLOCKER = "m7_reward_claim_native_semantic_edge_unresolved";
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const SCOPE_KEYS = Object.freeze([
  "integrationId", "topology", "saveId", "worldId", "localPlayerId",
  "companionId", "bindingGeneration", "bindingHash",
]);
const REQUEST_KEYS = Object.freeze([
  "action", "requestId", "traceId", "idempotencyKey", "expectedRevision",
  "deadlineMs", "cancellationToken", "selector", "target", "rewardId", "scope",
]);
const RECEIPT_KEYS = Object.freeze([
  "requestId", "traceId", "executionId", "action", "state", "revision",
  "reasonCode", "evidence", "postcondition",
]);
const EVIDENCE_KEYS = Object.freeze([
  "identity", "action", "phaseTrace", "target", "itemIdentity", "stack", "quality",
  "rewardId", "rewardInventoryIdentity", "rewardInventoryStackBefore", "rewardInventoryStackAfter",
  "mutexBefore", "mutexAfter", "slotBefore", "slotAfter", "rewardBefore",
  "rewardAfter", "progressChanged", "rewardAvailabilityChanged", "inventoryChanged",
]);
const POSTCONDITION_KEYS = Object.freeze([
  "beforeRevision", "afterRevision", "action", "targetId", "progressChanged",
  "rewardAvailable", "rewardClaimed", "inventoryChanged",
]);

function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields) { return record(value) && Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field)); }
function sameScope(actual, expected) { return exact(actual, SCOPE_KEYS) && exact(expected, SCOPE_KEYS) && SCOPE_KEYS.every((field) => actual[field] === expected[field]); }
function blocked(code, details = {}) { return Object.freeze({ state: "BLOCKED", code, ...details }); }
function validId(value) { return typeof value === "string" && ID.test(value); }
function validIdentity(value) { return record(value) && validId(value.requestId) && validId(value.traceId) && validId(value.executionId); }

/** Given: a future live reader must establish an eligible, unclaimed reward. */
export function validateM7ClaimGiven(given, expectedScope) {
  if (!record(given) || given.source !== "target_version_native_bundle_reward_reader" ||
      given.fresh !== true || given.readOnly !== true || given.gameplayMutationObserved !== false ||
      given.saveMutationObserved !== false || given.topology !== TOPOLOGY ||
      !sameScope(given.scope, expectedScope) || !validId(given.targetId) || !validId(given.observationId) ||
      !validId(given.rewardId) || given.mutexState !== "free" || given.slotState !== "contributed" ||
      given.rewardState !== "available" || !Number.isSafeInteger(given.revision) || given.revision < 0)
    return blocked("m7_claim_given_invalid");
  return Object.freeze({ state: "READY", kind: "m7_claim_given", facts: Object.freeze({ ...given }) });
}

/** Then: validate a same-execution success receipt and an exact fresh successor. */
export function validateM7ClaimThen({ request, receipt, freshReward, expectedScope } = {}) {
  const scope = expectedScope ?? request?.scope;
  if (!exact(request, REQUEST_KEYS) || request.action !== ACTION || !validId(request.requestId) ||
      !validId(request.traceId) || !validId(request.idempotencyKey) || !validId(request.cancellationToken) ||
      !validId(request.rewardId) || !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0 ||
      !Number.isSafeInteger(request.deadlineMs) || request.deadlineMs <= Date.now() || !sameScope(request.scope, scope))
    return blocked("m7_claim_request_invalid");
  if (!exact(receipt, RECEIPT_KEYS) || !validIdentity(receipt) || receipt.action !== ACTION ||
      receipt.state !== "succeeded" || receipt.reasonCode !== "bundle_action_completed" ||
      receipt.requestId !== request.requestId || receipt.traceId !== request.traceId ||
      !Number.isSafeInteger(receipt.revision) || receipt.revision <= request.expectedRevision ||
      !exact(receipt.evidence, EVIDENCE_KEYS) || !exact(receipt.postcondition, POSTCONDITION_KEYS))
    return blocked("m7_claim_receipt_invalid");
  const evidence = receipt.evidence;
  const postcondition = receipt.postcondition;
  if (evidence.action !== ACTION || evidence.rewardId !== request.rewardId ||
      evidence.rewardInventoryIdentity !== request.rewardId ||
      !Number.isSafeInteger(evidence.rewardInventoryStackBefore) || !Number.isSafeInteger(evidence.rewardInventoryStackAfter) ||
      evidence.rewardInventoryStackAfter <= evidence.rewardInventoryStackBefore ||
      !sameScope(evidence.identity, scope) || evidence.mutexBefore !== "free" || evidence.mutexAfter !== "released" ||
      evidence.slotBefore !== "contributed" || evidence.slotAfter !== "contributed" ||
      evidence.rewardBefore !== "available" || evidence.rewardAfter !== "claimed" ||
      evidence.inventoryChanged !== true || evidence.progressChanged !== false ||
      evidence.rewardAvailabilityChanged !== false || !Array.isArray(evidence.phaseTrace) || evidence.phaseTrace.length < 3 ||
      postcondition.beforeRevision !== request.expectedRevision || postcondition.afterRevision !== receipt.revision ||
      postcondition.action !== ACTION || postcondition.targetId !== request.target.targetId ||
      postcondition.progressChanged !== false || postcondition.rewardAvailable !== false ||
      postcondition.rewardClaimed !== true || postcondition.inventoryChanged !== true)
    return blocked("m7_claim_receipt_postcondition_invalid");
  const terminal = evidence.phaseTrace.at(-1);
  if (!exact(terminal, ["requestId", "traceId", "executionId", "phase", "revision", "reasonCode"]) ||
      terminal.requestId !== receipt.requestId || terminal.traceId !== receipt.traceId ||
      terminal.executionId !== receipt.executionId || terminal.phase !== "terminal" ||
      terminal.revision !== receipt.revision || terminal.reasonCode !== receipt.reasonCode)
    return blocked("m7_claim_terminal_correlation_invalid");
  if (!record(freshReward) || freshReward.source !== "target_version_native_bundle_reward_reader" ||
      freshReward.fresh !== true || freshReward.readOnly !== true || freshReward.gameplayMutationObserved !== false ||
      freshReward.saveMutationObserved !== false || !sameScope(freshReward.scope, scope) ||
      !validIdentity(freshReward) || freshReward.requestId !== receipt.requestId || freshReward.traceId !== receipt.traceId ||
      freshReward.executionId !== receipt.executionId || freshReward.targetId !== request.target.targetId ||
      freshReward.rewardId !== request.rewardId || freshReward.slotState !== "contributed" ||
      freshReward.rewardState !== "claimed" || freshReward.inventoryChanged !== true ||
      !Number.isSafeInteger(freshReward.revision) || freshReward.revision < receipt.revision)
    return blocked("m7_claim_fresh_postcondition_invalid");
  return Object.freeze({ state: "READY", kind: "m7_claim_then", requestId: receipt.requestId, traceId: receipt.traceId, executionId: receipt.executionId });
}

/**
 * This can validate future live-shaped evidence but cannot make the action
 * executable while the exact non-UI target-version semantic edge is unresolved.
 */
export function runM7ClaimRewardPreflight(input = {}) {
  const given = validateM7ClaimGiven(input.given, input.expectedScope);
  if (given.state !== "READY") return Object.freeze({ state: "BLOCKED", given });
  if (input.request?.expectedRevision !== given.facts.revision || input.request?.target?.targetId !== given.facts.targetId || input.request?.target?.observationId !== given.facts.observationId || input.request?.rewardId !== given.facts.rewardId)
    return Object.freeze({ state: "BLOCKED", given, then: blocked("m7_claim_given_request_correlation_invalid") });
  const then = validateM7ClaimThen({ request: input.request, receipt: input.receipt, freshReward: input.freshReward, expectedScope: input.expectedScope });
  if (then.state !== "READY") return Object.freeze({ state: "BLOCKED", given, then });
  return Object.freeze({ state: "BLOCKED", given, then, code: SOURCE_BLOCKER, sourceFact: "JunimoNoteMenu reward collection enters ItemGrabMenu and clears bundleRewards through its presentation callback; no approved typed non-UI semantic edge is established." });
}

export const M7_CLAIM_REWARD_PREFLIGHT_ACTION = ACTION;
export const M7_CLAIM_REWARD_PREFLIGHT_SOURCE_BLOCKER = SOURCE_BLOCKER;

if (process.argv[1]?.endsWith("run-stardew-portfolio-m7-claim-reward-preflight.mjs"))
  console.log(JSON.stringify(blocked(SOURCE_BLOCKER, { action: ACTION, topology: TOPOLOGY, sourceFact: "No approved typed non-UI target-version reward-claim semantic edge." })));
