// Runner-side failure taxonomy for Stardew fixture, attachment, and formal
// action gates. This is diagnostic metadata only: it never replaces a native
// receipt state or reasonCode.

const RULES = [
  {
    category: "fixture_precondition",
    pattern: /^(fixture_preflight_blocked_|fixture_native_)/,
    normalizedReasonCode: "fixture_native_precondition_missing",
    nextStep: "Inspect the allowlisted initializer and target-version native fixture facts; restore instead of starting an AI action run.",
  },
  {
    category: "fixture_readiness",
    pattern: /^fixture_readiness_(authentication_failed|invalid|clock_invalid|timeout|stale)$/,
    normalizedReasonCode: "fixture_readiness_unavailable",
    nextStep: "Inspect the signed readiness report, effective Host Mod config, session scope, and launch freshness before retrying attachment.",
  },
  {
    category: "attachment",
    pattern: /^(host_world_not_ready|host_lan_not_ready|attachment_|manifest_|farmhand_|world_not_ready)/,
    normalizedReasonCode: "formal_attachment_unavailable",
    nextStep: "Inspect effective SMAPI config, Host save/load, native LAN readiness, and Farmhand provisioning before running a production action.",
  },
  {
    category: "bridge_transport",
    pattern: /^bridge_(disconnected|observe_failed)$/,
    normalizedReasonCode: "authenticated_bridge_unavailable",
    nextStep: "Re-establish a formal ready bridge; do not infer action success after disconnect or replay a consumed request.",
  },
  {
    category: "live_target",
    pattern: /^no_live_/,
    normalizedReasonCode: "live_target_missing",
    nextStep: "Inspect fresh snapshot discovery and fixture readiness facts; do not submit a production request without a live target.",
  },
  {
    category: "target_staleness",
    pattern: /(stale|revision)/,
    normalizedReasonCode: "target_or_revision_stale",
    nextStep: "Take a fresh snapshot and rediscover the target; audit discovery/execution timing if it repeatedly becomes stale.",
  },
  {
    category: "execution_submission",
    pattern: /^execution_(submit_failed|response_invalid)|^formal_action_gate_invalid_/,
    normalizedReasonCode: "execution_submission_invalid",
    nextStep: "Inspect request shape, live capability, policy, scope, and bridge protocol before retrying with a new request id.",
  },
  {
    category: "execution_lifecycle",
    pattern: /(?:terminal_timeout|navigation_timeout|_timeout$|^execution_(blocked|invalidated|cancelled|expired|rejected|uncertain))/,
    normalizedReasonCode: "execution_did_not_reach_required_terminal_state",
    nextStep: "Inspect the authoritative terminal receipt and action lifecycle; accepted or running is not success.",
  },
  {
    category: "postcondition",
    pattern: /(postcondition|evidence|inventory|target.*(removed|absent)|animation_complete)/,
    normalizedReasonCode: "authoritative_postcondition_missing",
    nextStep: "Keep the native receipt, then inspect the fresh post-receipt snapshot and action-specific evidence predicate.",
  },
  {
    category: "policy_or_configuration",
    pattern: /(capability_missing|invalid_client_config|invalid_.*config|scenario_unknown|not_allowlisted)/,
    normalizedReasonCode: "policy_or_configuration_invalid",
    nextStep: "Inspect the effective Host/AI Mod configs, scenario allowlist, live capability, and fixture profile transaction.",
  },
];

/**
 * Returns stable runner diagnostic metadata while preserving `nativeReasonCode`
 * untouched. `reasonCode` may be a runner/FormalActionGate error or an
 * authoritative native receipt reason.
 */
export function classifyStardewGateFailure(reasonCode, { nativeReasonCode = null } = {}) {
  const sourceReasonCode = normalizeReasonCode(reasonCode);
  const native = normalizeOptionalReasonCode(nativeReasonCode);
  const rule = RULES.find((candidate) => candidate.pattern.test(sourceReasonCode));
  if (rule !== undefined) {
    return Object.freeze({
      category: rule.category,
      normalizedReasonCode: rule.normalizedReasonCode,
      sourceReasonCode,
      nativeReasonCode: native,
      nextStep: rule.nextStep,
    });
  }
  return Object.freeze({
    category: "native_or_unknown",
    normalizedReasonCode: "unclassified_gate_failure",
    sourceReasonCode,
    nativeReasonCode: native,
    nextStep: "Preserve and inspect the authoritative native receipt/log evidence; do not infer a retry strategy from an unclassified reason.",
  });
}

function normalizeReasonCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,256}$/.test(value)
    ? value
    : "invalid_or_missing_reason_code";
}

function normalizeOptionalReasonCode(value) {
  return typeof value === "string" && /^[A-Za-z0-9_:-]{1,256}$/.test(value) ? value : null;
}
