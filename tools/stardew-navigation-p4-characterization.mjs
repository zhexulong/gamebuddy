import { createHash } from "node:crypto";

export const CHARACTERIZATION_VERSION = "stardew-navigation-p4-v5";
export const P4A_TARGET_BINDING_V1 = Object.freeze({
  gameAssemblyVersion: "1.6.15.24356",
  inputDigest: "ef2f63a15e9f528cfa70dcf8602013d241503d308b8702b846578fbf76e4876a",
});
export const SEARCH_POLICY_V1 = Object.freeze({
  version: "p4c-lexical-v4",
  unicodeForm: "NFKC",
  casePolicy: "unicode-lower-und",
  fuzzyScorer: "levenshtein-normalized-v1",
  fuzzyThreshold: 0.82,
  fuzzyMargin: 0.08,
  maximumCandidates: 3,
  scalarLength: Object.freeze({ minimum: 1, maximum: 128 }),
});

const scalarLength = (value) => [...value.trim()].length;
const isUnsafe = (value) =>
  /[\p{C}\\/]/u.test(value) ||
  /(?:^|\s)[+-]?\d+(?:\.\d+)?\s*[,;:]\s*[+-]?\d+(?:\.\d+)?(?:\s|$)/u.test(value) ||
  /(?:^|\s)(?:action|warp|mine)\s*[:(]/iu.test(value);
export function normalizeDestinationText(value) {
  if (typeof value !== "string" || scalarLength(value) < 1 || scalarLength(value) > 128) return null;
  const normalized = value.normalize(SEARCH_POLICY_V1.unicodeForm);
  if (scalarLength(normalized) < 1 || scalarLength(normalized) > 128 || isUnsafe(normalized)) return null;
  const folded = normalized.toLocaleLowerCase("und").replace(/[\s\p{P}\p{S}_]+/gu, "");
  return folded.length === 0 ? null : folded;
}
function editDistance(left, right) {
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++)
      current.push(
        Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)),
      );
    previous = current;
  }
  return previous[right.length];
}
export function scoreDestinationMatch(query, label) {
  const q = normalizeDestinationText(query),
    l = normalizeDestinationText(label);
  return q === null || l === null ? 0 : 1 - editDistance(q, l) / Math.max(q.length, l.length);
}
const idOf = (entry) => entry.id ?? entry.destinationId;
const byCanonicalId = (left, right) => idOf(left).localeCompare(idOf(right));
function validateCharacterizationPolicy(policy) {
  if (!policy || typeof policy !== "object" || !Number.isFinite(policy.fuzzyThreshold) || !Number.isFinite(policy.fuzzyMargin) || policy.fuzzyThreshold < 0 || policy.fuzzyThreshold > 1 || policy.fuzzyMargin < 0 || policy.fuzzyMargin > 1 || policy.maximumCandidates !== SEARCH_POLICY_V1.maximumCandidates || policy.unicodeForm !== SEARCH_POLICY_V1.unicodeForm || policy.casePolicy !== SEARCH_POLICY_V1.casePolicy || policy.fuzzyScorer !== SEARCH_POLICY_V1.fuzzyScorer || policy.scalarLength !== SEARCH_POLICY_V1.scalarLength) throw new Error("invalid_characterization_search_policy");
  return Object.freeze(policy);
}
function result(kind, stage, entries, destinationId, policy) {
  return Object.freeze({
    kind,
    stage,
    ...(destinationId ? { destinationId } : {}),
    candidates: entries
      .map(idOf)
      .sort((a, b) => a.localeCompare(b))
      .slice(0, policy.maximumCandidates),
  });
}
// Characterization-only policy seam. Production callers retain findDestination's frozen v1 policy.
export function findDestinationWithPolicy(entries, query, currentLocale, fallbackLocale, policy) {
  policy = validateCharacterizationPolicy(policy);
  const q = normalizeDestinationText(query);
  if (q === null) return Object.freeze({ kind: "invalid_query", candidates: [] });
  for (const [stage, select] of [
    ["current_locale_exact", (entry) => [entry.labels[currentLocale]]],
    ["fallback_locale_exact", (entry) => [entry.labels[fallbackLocale]]],
    ["alias_exact", (entry) => entry.aliases],
  ]) {
    const matches = entries.filter((entry) => select(entry).some((label) => normalizeDestinationText(label) === q));
    if (matches.length === 1) return result("resolved", stage, matches, idOf(matches[0]), policy);
    if (matches.length > 1) return result("ambiguous", stage, matches, undefined, policy);
  }
  if ([...q].length < 3) return Object.freeze({ kind: "not_found", stage: "short_query", candidates: [] });
  const scored = entries
    .map((entry) => ({
      entry,
      score: Math.max(
        ...Object.values(entry.labels)
          .filter(Boolean)
          .map((label) => scoreDestinationMatch(query, label)),
        ...entry.aliases.map((label) => scoreDestinationMatch(query, label)),
      ),
    }))
    .sort((a, b) => b.score - a.score || byCanonicalId(a.entry, b.entry));
  const [first, second] = scored;
  if (!first || first.score < policy.fuzzyThreshold)
    return Object.freeze({ kind: "not_found", stage: "fuzzy_below_threshold", candidates: [] });
  if (second && first.score - second.score <= policy.fuzzyMargin)
    return Object.freeze({
      kind: "candidates",
      stage: "fuzzy_low_margin",
      candidates: scored.slice(0, policy.maximumCandidates).map(({ entry }) => idOf(entry)),
    });
  return result("resolved", "fuzzy", [first.entry], idOf(first.entry), policy);
}
export function findDestination(entries, query, currentLocale, fallbackLocale) {
  return findDestinationWithPolicy(entries, query, currentLocale, fallbackLocale, SEARCH_POLICY_V1);
}
export function evaluateMatcherCorpus(corpus) {
  const outcomes = corpus.cases.map((entry) => ({
    id: entry.id,
    locale: entry.currentLocale,
    actual: findDestination(corpus.entries, entry.query, entry.currentLocale, entry.fallbackLocale),
  }));
  const counts = { total: outcomes.length, correct: 0, falseAccept: 0, falseReject: 0, ambiguity: 0 };
  const localeMatrix = {};
  for (const outcome of outcomes) {
    const expected = corpus.cases.find((entry) => entry.id === outcome.id).expected;
    const row = (localeMatrix[outcome.locale] ??= { correct: 0, falseAccept: 0, falseReject: 0, ambiguity: 0 });
    if (JSON.stringify(outcome.actual) === JSON.stringify(expected)) {
      counts.correct++;
      row.correct++;
    } else if (outcome.actual.kind === "resolved" && expected.kind !== "resolved") {
      counts.falseAccept++;
      row.falseAccept++;
    } else if (outcome.actual.kind !== "resolved" && expected.kind === "resolved") {
      counts.falseReject++;
      row.falseReject++;
    }
    if (outcome.actual.kind === "ambiguous") {
      counts.ambiguity++;
      row.ambiguity++;
    }
  }
  return Object.freeze({ policy: SEARCH_POLICY_V1, localeCases: outcomes, counts, localeMatrix });
}
const canonical = (value) =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(",")}]`
    : value && typeof value === "object"
      ? `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(",")}}`
      : JSON.stringify(value);
export function deriveNavigationCharacterization(probe) {
  if (!probe || probe.artifactKind !== "stardew_navigation_p4_redacted_probe" || probe.schemaVersion !== 2)
    throw new Error("invalid_navigation_probe");
  const join = probe.mineLineage?.sourceJoin;
  if (
    probe.gameAssemblyVersion !== P4A_TARGET_BINDING_V1.gameAssemblyVersion ||
    probe.inputDigest !== P4A_TARGET_BINDING_V1.inputDigest ||
    probe.loaders?.locations?.count !== 91 ||
    probe.loaders?.worldMap?.count !== 2 ||
    probe.hierarchy?.regionCount !== 2 ||
    probe.hierarchy?.areaCount !== 17 ||
    probe.hierarchy?.tooltipCount !== 56 ||
    probe.hierarchy?.worldPositionCount !== 67 ||
    probe.hierarchy?.maxDepth !== 3 ||
    probe.hierarchy?.pagination?.pageSize !== 16 ||
    probe.hierarchy?.pagination?.rootPageCount !== 1 ||
    probe.hierarchy?.pagination?.maximumAreaChildren !== 12 ||
    probe.hierarchy?.pagination?.maximumTooltipChildren !== 20 ||
    probe.hierarchy?.pagination?.maximumPositionChildren !== 19 ||
    probe.conditions?.areas?.absent !== 16 ||
    probe.conditions?.areas?.presentNotEvaluated !== 1 ||
    probe.conditions?.tooltips?.absent !== 42 ||
    probe.conditions?.tooltips?.presentNotEvaluated !== 14 ||
    probe.conditions?.knownConditions?.absent !== 41 ||
    probe.conditions?.knownConditions?.presentNotEvaluated !== 15 ||
    probe.joins?.directWorldPositionToLocation?.candidateCount !== 67 ||
    probe.joins?.directWorldPositionToLocation?.resolvedUniqueCount !== 57 ||
    probe.joins?.directWorldPositionToLocation?.unresolvedCount !== 4 ||
    probe.joins?.directWorldPositionToLocation?.nonUniqueCount !== 6 ||
    probe.joins?.tooltipToLocation?.status !== "no_explicit_location_identity_member" ||
    probe.collisions?.duplicateRegionKeys !== 0 ||
    probe.collisions?.duplicateAreaIdsWithinRegion !== 0 ||
    probe.collisions?.duplicateTooltipIdsWithinArea !== 0 ||
    probe.collisions?.duplicateLocationKeys !== 0 ||
    probe.collisions?.duplicateDirectLocationJoinTargets !== 2 ||
    probe.leafResolution?.directResolvedUniqueCount !== 55 ||
    probe.leafResolution?.directUnresolvedCount !== 4 ||
    probe.leafResolution?.directNonUniqueCount !== 6 ||
    probe.leafResolution?.contentPresentNotRuntimeEvaluated !== true ||
    probe.mineLineage?.locationIdentity !== "Mine" ||
    probe.mineLineage?.mountainBinding !== "Mountain/Mines" ||
    join?.regionToMountainAreaMultiplicity !== 1 ||
    join?.mountainAreaToMinesTooltipMultiplicity !== 1 ||
    join?.mineCanonicalLocationInLocations !== 1 ||
    join?.inclusionState !== "content_present_not_runtime_evaluated" ||
    JSON.stringify(join?.areaConditionStates) !== JSON.stringify(["absent"]) ||
    JSON.stringify(join?.tooltipConditionStates) !== JSON.stringify(["absent"]) ||
    JSON.stringify(join?.tooltipKnownConditionStates) !== JSON.stringify(["absent"])
  )
    throw new Error("target_navigation_probe_drift");
  return Object.freeze({
    characterizationVersion: CHARACTERIZATION_VERSION,
    target: Object.freeze({ assemblyVersion: probe.gameAssemblyVersion, inputDigest: probe.inputDigest }),
    counts: Object.freeze({
      locationCount: probe.loaders.locations.count,
      regionCount: probe.loaders.worldMap.count,
      mountainAreaCount: probe.counts.mountainAreaCount,
      mountainTooltipCount: probe.counts.mountainTooltipCount,
      minesTooltipIdCount: probe.counts.minesTooltipIdCount,
    }),
    hierarchy: Object.freeze({
      regionCount: probe.hierarchy.regionCount,
      areaCount: probe.hierarchy.areaCount,
      tooltipCount: probe.hierarchy.tooltipCount,
      worldPositionCount: probe.hierarchy.worldPositionCount,
      maxDepth: probe.hierarchy.maxDepth,
      nodesByDepth: Object.freeze([...probe.hierarchy.nodesByDepth]),
      pagination: Object.freeze({ ...probe.hierarchy.pagination }),
    }),
    conditions: Object.freeze({
      areas: Object.freeze({ ...probe.conditions.areas }),
      tooltips: Object.freeze({ ...probe.conditions.tooltips }),
      knownConditions: Object.freeze({ ...probe.conditions.knownConditions }),
    }),
    joins: Object.freeze({
      directWorldPositionToLocation: Object.freeze({ ...probe.joins.directWorldPositionToLocation }),
      tooltipToLocation: Object.freeze({ ...probe.joins.tooltipToLocation }),
    }),
    collisions: Object.freeze({ ...probe.collisions }),
    leafResolution: Object.freeze({ ...probe.leafResolution }),
    mineLineage: Object.freeze({
      locationIdentity: probe.mineLineage.locationIdentity,
      locationDisplayTokenSha256: probe.mineLineage.locationDisplayTokenSha256,
      displayNameSource: Object.freeze({ ...probe.mineLineage.displayNameSource }),
      mountainBinding: probe.mineLineage.mountainBinding,
      mapRegionGetLocationNameApi: probe.mineLineage.mapRegionGetLocationNameApi,
      currentWorldFact: probe.mineLineage.currentWorldFact,
      sourceJoin: Object.freeze({ ...join }),
    }),
    shapeDigest: createHash("sha256").update(canonical(probe.shapes)).digest("hex"),
    nonClaim: probe.nonClaim,
  });
}

export const P4D_STRING_ENVELOPE_CONTRACT_V1 = Object.freeze({
  artifactKind: "stardew_navigation_p4d_opaque_handle_characterization",
  schemaVersion: 2,
  carrier: Object.freeze({
    type: "string",
    minimumLength: 1,
    maximumLength: 512,
    opaqueToCaller: true,
    callerParsingForbidden: true,
  }),
  reasonTaxonomy: Object.freeze([
    "ref_malformed",
    "ref_forged",
    "ref_wrong_issuer",
    "ref_wrong_kind",
    "ref_expired",
    "ref_scope",
    "ref_owner_drift",
    "ref_canonical_drift",
    "ref_content_generation_drift",
    "ref_replay_transition",
  ]),
  bindingInvariants: Object.freeze([
    "runtime_instance",
    "scope_save_world_player_companion",
    "content_owner",
    "canonical_identity",
    "world_generation",
    "content_generation",
    "observation_sequence",
    "execution_correlation",
    "expiry",
  ]),
  observationAdvance:
    "a find-issued handle may first bind to a later trusted navigation execution; only an issuer-trusted execution-local observation may advance it",
  nonClaim:
    "Characterization-only issuer; it grants no navigation permission, route, movement, action, production reference, or protocol.",
});
export function validateP4DStringEnvelope(value) {
  return typeof value !== "string" || value.length < 1 || value.length > 512
    ? "ref_malformed"
    : "opaque_carrier_not_parsed";
}
/** Characterization model: all binding facts and capability brands remain closure-private. */
export function createP4DCharacterizationIssuer({
  now = () => Date.now(),
  privateFactSource,
  privateTrustedExecutionFactFor,
  ttlMs = 1_000,
} = {}) {
  if (
    typeof privateFactSource !== "function" ||
    typeof privateTrustedExecutionFactFor !== "function" ||
    !Number.isFinite(ttlMs) ||
    ttlMs <= 0
  )
    throw new Error("invalid_private_issuer_configuration");
  const handles = new Map();
  let serial = 0;
  const factKeys = Object.freeze([
    "issuer",
    "runtimeInstance",
    "scope",
    "save",
    "world",
    "player",
    "companion",
    "owner",
    "canonical",
    "worldGeneration",
    "contentGeneration",
  ]);
  const snapshotFact = (value, error) => {
    if (!value || !factKeys.every((key) => typeof value[key] === "string" && value[key])) throw new Error(error);
    return Object.freeze(Object.fromEntries(factKeys.map((key) => [key, value[key]])));
  };
  const facts = () => snapshotFact(privateFactSource(), "invalid_private_fact_source");
  const deny = (reason) => Object.freeze({ outcome: "denied", reason });
  const revoke = (record, reason) => {
    record.revoked = reason;
    return deny(reason);
  };
  const trustedFacts = (token) => {
    const value = privateTrustedExecutionFactFor(token);
    if (!value || typeof value !== "object" || !Object.isFrozen(value)) return null;
    try {
      return snapshotFact(value, "invalid_trusted_execution_fact");
    } catch {
      return null;
    }
  };
  const compareBinding = (record, execution) => {
    const current = facts(),
      original = record.fact;
    if (current.issuer !== original.issuer || execution.issuer !== original.issuer) return "ref_wrong_issuer";
    if (
      ["runtimeInstance", "scope", "save", "world", "player", "companion", "worldGeneration"].some(
        (key) => current[key] !== original[key] || execution[key] !== original[key],
      )
    )
      return "ref_scope";
    if (current.owner !== original.owner || execution.owner !== original.owner) return "ref_owner_drift";
    if (current.canonical !== original.canonical || execution.canonical !== original.canonical)
      return "ref_canonical_drift";
    if (
      current.contentGeneration !== original.contentGeneration ||
      execution.contentGeneration !== original.contentGeneration
    )
      return "ref_content_generation_drift";
    return null;
  };
  return Object.freeze({
    issueFindHandle() {
      const fact = facts();
      const handle = `p4d-h-${String(++serial).padStart(12, "0")}`;
      handles.set(handle, { fact, expiry: now() + ttlMs, bound: null, consumed: false, revoked: null, sequence: 0 });
      return handle;
    },
    consume(handle, token) {
      if (validateP4DStringEnvelope(handle) === "ref_malformed") return deny("ref_malformed");
      const record = handles.get(handle);
      if (!record) return deny(handle.startsWith("p4d-h-") ? "ref_forged" : "ref_wrong_issuer");
      const execution = trustedFacts(token);
      if (!execution) return deny("ref_wrong_kind");
      if (record.revoked) return deny(record.revoked);
      if (now() >= record.expiry) return revoke(record, "ref_expired");
      if (record.consumed) return deny("ref_replay_transition");
      const mismatch = compareBinding(record, execution);
      if (mismatch) return revoke(record, mismatch);
      record.bound = token;
      record.consumed = true;
      return Object.freeze({ outcome: "consumed", handleState: "bound", permission: "none" });
    },
    observeTrustedExecution(token) {
      const execution = trustedFacts(token);
      if (!execution) return deny("ref_wrong_kind");
      const bound = [...handles.values()].find((record) => record.bound === token && record.consumed);
      if (!bound) return deny("ref_replay_transition");
      if (bound.revoked) return deny(bound.revoked);
      if (now() >= bound.expiry) return revoke(bound, "ref_expired");
      const mismatch = compareBinding(bound, execution);
      if (mismatch) return revoke(bound, mismatch);
      bound.sequence++;
      return Object.freeze({ outcome: "advanced", observationSequence: bound.sequence, permission: "none" });
    },
  });
}

export const P4C_TELEMETRY_SCHEMA_V1 = Object.freeze({
  artifactKind: "stardew_navigation_p4c_redacted_telemetry",
  schemaVersion: 1,
  outcomes: Object.freeze([
    "not_invoked",
    "used_not_consumed",
    "used_and_consumed",
    "failed_to_resolve",
    "misresolved",
  ]),
  forbiddenFields: Object.freeze(["query", "label", "ref", "route", "destination", "map", "tile", "identity"]),
});
const opaqueId = (value) => typeof value === "string" && /^p4c-(?:inv|res|nav)-[a-z0-9-]{1,80}$/u.test(value);
export function validateP4CTelemetryEvent(event) {
  const allowed = new Set([
    "invocationId",
    "resultId",
    "exactLabelDisclosed",
    "matchStage",
    "candidateCount",
    "scoreBucket",
    "marginBucket",
    "latencyBucket",
    "navigationConsumptionId",
    "outcome",
  ]);
  if (!event || typeof event !== "object" || Object.keys(event).some((key) => !allowed.has(key))) return false;
  return (
    opaqueId(event.invocationId) &&
    opaqueId(event.resultId) &&
    typeof event.exactLabelDisclosed === "boolean" &&
    typeof event.matchStage === "string" &&
    Number.isInteger(event.candidateCount) &&
    typeof event.scoreBucket === "string" &&
    typeof event.marginBucket === "string" &&
    typeof event.latencyBucket === "string" &&
    (event.navigationConsumptionId === null || opaqueId(event.navigationConsumptionId)) &&
    P4C_TELEMETRY_SCHEMA_V1.outcomes.includes(event.outcome)
  );
}
export function correlateP4CTelemetry(events) {
  if (!Array.isArray(events) || !events.every(validateP4CTelemetryEvent)) throw new Error("invalid_redacted_telemetry");
  return Object.freeze(
    events.map((event) => {
      const consumed =
        event.outcome === "used_not_consumed" &&
        events.some(
          (other) => other.navigationConsumptionId === event.resultId && other.outcome === "used_and_consumed",
        );
      return Object.freeze({
        invocationId: event.invocationId,
        resultId: event.resultId,
        outcome: consumed ? "used_and_consumed" : event.outcome,
      });
    }),
  );
}
