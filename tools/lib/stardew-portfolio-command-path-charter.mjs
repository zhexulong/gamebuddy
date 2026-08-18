const ID = /^[a-z][a-z0-9_]{2,127}$/;
const TOPOLOGY = "single_player_native_companion";
const MILESTONES = new Set(["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"]);
const FORBIDDEN_KEYS = new Set([
  "actionid",
  "primitiveid",
  "operationid",
  "publicactionid",
  "implementationactionids",
  "basisprimitiveids",
  "bridgeaction",
  "registryid",
  "catalogid",
  "fixtureid",
  "requiredvariant",
  "classids",
  "candidateclosurerunid",
  "closureattestationhash",
  "inheritsfrom",
  "reuseevidencefrom",
]);
const ALLOWED_TAXONOMY_INPUTS = new Set([
  "milestone_persisted_predicate",
  "dsm_content_scope",
  "shared_non_ui_execution_rule",
]);
const FORBIDDEN_TAXONOMY_INPUTS = new Set([
  "action_registry",
  "gameplay_capability_catalog",
  "legacy_action_id",
  "old_itm_class",
  "receipt",
  "fixture",
  "concrete_smoke_trace",
]);
const EXCLUSION_CLASSES = new Set([
  "intentionally_not_in_release_scope",
  "unsupported_topology",
  "blocked_native_realization",
  "blocked_content_or_fixture",
  "deferred_domain",
]);
const SOURCE_IMPACT_DISPOSITIONS = new Set([
  "semantic_alias",
  "existing_trace_partition_refinement",
  "new_required_trace",
  "approved_exclusion",
  "unknown_blocking",
]);
const PROJECTION_STATES = new Set([
  "unprojected",
  "primitive",
  "composite",
  "protocol",
  "coordination",
  "content_operation",
  "blocked",
]);
const SOURCE_REALIZATION_STATES = new Set(["unknown", "disproven"]);
const UNREALIZED_SOURCE_REALIZATION_STATES = new Set(["unknown", "disproven"]);
const UNKNOWN_DISPOSITIONS = new Set(["blocks_projection", "requires_scope_revision"]);
const SHA256 = /^[a-f0-9]{64}$/;
const TERMINALS = new Set([
  "succeeded",
  "rejected",
  "cancelled",
  "timed_out",
  "uncertain",
  "protocol_pending",
  "blocked",
]);
const REQUIRED_OBSERVATION_DIMENSIONS = new Set([
  "actor_topology_scope",
  "opaque_target_and_input_identity",
  "authoritative_world_inventory_delta",
  "pending_native_protocol_phase",
  "authority_policy_revision",
  "terminal_cancel_replay_outcome",
  "fresh_evidence_and_persistence",
]);

function fail(message, code, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value, name) {
  if (!isRecord(value)) fail(`${name} must be an object.`, "portfolio_command_path_charter_invalid_shape", { name });
  return value;
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim().length === 0)
    fail(`${name} must be a non-empty string.`, "portfolio_command_path_charter_invalid_shape", { name });
  return value;
}

function requireArray(value, name, { nonEmpty = true } = {}) {
  if (!Array.isArray(value) || (nonEmpty && value.length === 0))
    fail(`${name} must be ${nonEmpty ? "a non-empty" : "an"} array.`, "portfolio_command_path_charter_invalid_shape", {
      name,
    });
  return value;
}

function requireId(value, name) {
  const id = requireString(value, name);
  if (!ID.test(id))
    fail(`${name} must use lower-snake-case ID syntax.`, "portfolio_command_path_charter_invalid_id", {
      name,
      value: id,
    });
  return id;
}

function requireUnique(values, name) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value))
      fail(`${name} contains duplicate ${value}.`, "portfolio_command_path_charter_duplicate", { name, value });
    seen.add(value);
  }
}

function validateNoForbiddenVocabulary(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => validateNoForbiddenVocabulary(entry, `${path}[${index}]`));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) {
      fail(
        `Command-path charter must not use product/action-layer field ${key}.`,
        "portfolio_command_path_charter_forbidden_vocabulary",
        { path, key },
      );
    }
    validateNoForbiddenVocabulary(entry, path ? `${path}.${key}` : key);
  }
}

function validateExactKeys(value, keys, name) {
  requireRecord(value, name);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${name} has unknown or missing fields.`, "portfolio_command_path_charter_unknown_field", {
      name,
      actual,
      expected,
    });
  }
}

function stringArray(value, name, { nonEmpty = true } = {}) {
  return Object.freeze(requireArray(value, name, { nonEmpty }).map((entry) => requireString(entry, `${name} entry`)));
}

function canonicalScopeAtom(value) {
  validateExactKeys(
    value,
    [
      "scopeAtomId",
      "milestoneId",
      "playerSemantic",
      "persistedPredicate",
      "topology",
      "progressionDependencies",
      "contentSelectionState",
    ],
    "scope atom",
  );
  const scopeAtomId = requireId(value.scopeAtomId, "scopeAtomId");
  const milestoneId = requireString(value.milestoneId, `${scopeAtomId}.milestoneId`);
  if (!MILESTONES.has(milestoneId))
    fail(`${scopeAtomId} has an unknown milestone.`, "portfolio_command_path_scope_atom_invalid", { milestoneId });
  if (value.topology !== TOPOLOGY)
    fail(`${scopeAtomId} is not topology-scoped to Portfolio.`, "portfolio_command_path_scope_atom_topology_invalid");
  if (
    value.contentSelectionState !== "pending_signed_dsm_selection" &&
    value.contentSelectionState !== "selected_in_signed_dsm"
  ) {
    fail(`${scopeAtomId} has an invalid content-selection state.`, "portfolio_command_path_scope_atom_invalid");
  }
  return Object.freeze({
    scopeAtomId,
    milestoneId,
    playerSemantic: requireString(value.playerSemantic, `${scopeAtomId}.playerSemantic`),
    persistedPredicate: requireString(value.persistedPredicate, `${scopeAtomId}.persistedPredicate`),
    topology: TOPOLOGY,
    progressionDependencies: stringArray(value.progressionDependencies, `${scopeAtomId}.progressionDependencies`, {
      nonEmpty: false,
    }),
    contentSelectionState: value.contentSelectionState,
  });
}

function canonicalTraceFamily(value, scopeAtoms) {
  validateExactKeys(
    value,
    [
      "traceFamilyId",
      "scopeAtomId",
      "playerSemantic",
      "actorSort",
      "targetSort",
      "parameterDomain",
      "pathLanguage",
      "guardPartitions",
      "outcomeAlgebra",
      "requiredPostcondition",
      "evidencePolicy",
      "sourceRealization",
      "projectionState",
    ],
    "trace family",
  );
  const traceFamilyId = requireId(value.traceFamilyId, "traceFamilyId");
  const scopeAtomId = requireId(value.scopeAtomId, `${traceFamilyId}.scopeAtomId`);
  if (!scopeAtoms.has(scopeAtomId))
    fail(`${traceFamilyId} references unknown scope atom.`, "portfolio_command_path_trace_scope_missing", {
      scopeAtomId,
    });
  validateExactKeys(value.parameterDomain, ["kind", "domainDescription"], `${traceFamilyId}.parameterDomain`);
  if (
    value.parameterDomain.kind !== "parameterized" ||
    typeof value.parameterDomain.domainDescription !== "string" ||
    value.parameterDomain.domainDescription.trim().length === 0
  ) {
    fail(
      `${traceFamilyId} must use a parameterized semantic domain, not a concrete recording.`,
      "portfolio_command_path_trace_not_parameterized",
    );
  }
  const pathLanguage = canonicalPathLanguage(value.pathLanguage, traceFamilyId);
  const outcomes = stringArray(value.outcomeAlgebra, `${traceFamilyId}.outcomeAlgebra`);
  if (!outcomes.includes("succeeded") || outcomes.some((outcome) => !TERMINALS.has(outcome))) {
    fail(`${traceFamilyId} has an invalid terminal algebra.`, "portfolio_command_path_trace_terminal_invalid");
  }
  requireUnique(outcomes, `${traceFamilyId}.outcomeAlgebra`);
  const projectionState = requireString(value.projectionState, `${traceFamilyId}.projectionState`);
  if (!PROJECTION_STATES.has(projectionState)) {
    fail(`${traceFamilyId} has an invalid projection state.`, "portfolio_command_path_trace_invalid");
  }
  const requiredPostcondition = canonicalRequiredPostcondition(value.requiredPostcondition, traceFamilyId);
  const evidencePolicy = canonicalEvidencePolicy(value.evidencePolicy, traceFamilyId);
  const sourceRealization = canonicalSourceRealization(value.sourceRealization, traceFamilyId);
  if (projectionState !== "unprojected" && projectionState !== "blocked") {
    fail(
      `${traceFamilyId} cannot project a trace from the v1 Charter; target-version realization must first be admitted by a separately verifiable dossier.`,
      "portfolio_command_path_projection_before_realization",
    );
  }
  return Object.freeze({
    traceFamilyId,
    scopeAtomId,
    playerSemantic: requireString(value.playerSemantic, `${traceFamilyId}.playerSemantic`),
    actorSort: requireString(value.actorSort, `${traceFamilyId}.actorSort`),
    targetSort: requireString(value.targetSort, `${traceFamilyId}.targetSort`),
    parameterDomain: Object.freeze({
      kind: "parameterized",
      domainDescription: value.parameterDomain.domainDescription,
    }),
    pathLanguage,
    guardPartitions: stringArray(value.guardPartitions, `${traceFamilyId}.guardPartitions`),
    outcomeAlgebra: outcomes,
    requiredPostcondition,
    evidencePolicy,
    sourceRealization,
    projectionState,
  });
}

function canonicalPathLanguage(value, traceFamilyId) {
  validateExactKeys(
    value,
    ["quantification", "variables", "bindingRules", "segments"],
    `${traceFamilyId}.pathLanguage`,
  );
  if (value.quantification !== "for_each_valid_binding") {
    fail(
      `${traceFamilyId} must quantify over valid typed bindings rather than a recorded run.`,
      "portfolio_command_path_trace_not_parameterized",
    );
  }
  const variables = requireArray(value.variables, `${traceFamilyId}.pathLanguage.variables`).map((entry) => {
    validateExactKeys(entry, ["name", "sort", "cardinality"], `${traceFamilyId}.pathLanguage.variable`);
    return Object.freeze({
      name: requireId(entry.name, `${traceFamilyId}.pathLanguage.variable.name`),
      sort: requireString(entry.sort, `${traceFamilyId}.pathLanguage.variable.sort`),
      cardinality: requireString(entry.cardinality, `${traceFamilyId}.pathLanguage.variable.cardinality`),
    });
  });
  requireUnique(
    variables.map((entry) => entry.name),
    `${traceFamilyId}.pathLanguage.variable names`,
  );
  const names = new Set(variables.map((entry) => entry.name));
  const bindingRules = stringArray(value.bindingRules, `${traceFamilyId}.pathLanguage.bindingRules`);
  const segments = requireArray(value.segments, `${traceFamilyId}.pathLanguage.segments`).map((entry, index) =>
    canonicalPathSegment(entry, traceFamilyId, index, names),
  );
  if (segments[0].kind !== "observation_boundary" || segments[0].phase !== "initial") {
    fail(
      `${traceFamilyId} must begin its command-path grammar with an initial observation boundary.`,
      "portfolio_command_path_trace_steps_invalid",
    );
  }
  if (
    !segments.some((entry) => entry.kind === "semantic_transition") ||
    !segments.some((entry) => entry.kind === "observation_boundary" && entry.phase.startsWith("fresh_"))
  ) {
    fail(
      `${traceFamilyId} must preserve semantic commits and a fresh-observation boundary.`,
      "portfolio_command_path_trace_steps_invalid",
    );
  }
  const initialBinds = segments[0].binds;
  const referenced = new Set(
    segments.flatMap((entry) => (entry.kind === "observation_boundary" ? entry.binds : entry.uses)),
  );
  if (initialBinds.length === 0 || [...names].some((name) => !referenced.has(name))) {
    fail(
      `${traceFamilyId} must retain an initial authoritative binding and use every typed parameter in its grammar.`,
      "portfolio_command_path_trace_not_parameterized",
    );
  }
  return Object.freeze({
    quantification: value.quantification,
    variables: Object.freeze(variables),
    bindingRules,
    segments: Object.freeze(segments),
  });
}

function canonicalPathSegment(value, traceFamilyId, index, variableNames) {
  requireRecord(value, `${traceFamilyId}.pathLanguage.segments[${index}]`);
  const kind = requireString(value.kind, `${traceFamilyId}.pathLanguage.segments[${index}].kind`);
  if (kind === "observation_boundary") {
    validateExactKeys(value, ["kind", "phase", "binds"], `${traceFamilyId}.pathLanguage.observation segment`);
    const binds = stringArray(value.binds, `${traceFamilyId}.pathLanguage.observation.binds`, { nonEmpty: false });
    if (binds.some((name) => !variableNames.has(name)))
      fail(
        `${traceFamilyId} observation binds an undeclared variable.`,
        "portfolio_command_path_trace_not_parameterized",
      );
    return Object.freeze({
      kind,
      phase: requireString(value.phase, `${traceFamilyId}.pathLanguage.observation.phase`),
      binds,
    });
  }
  if (kind === "semantic_transition" || kind === "protocol_boundary") {
    const label = kind === "semantic_transition" ? "semanticTransition" : "protocolBoundary";
    validateExactKeys(value, ["kind", label, "uses"], `${traceFamilyId}.pathLanguage.${kind} segment`);
    const uses = stringArray(value.uses, `${traceFamilyId}.pathLanguage.${kind}.uses`);
    if (uses.some((name) => !variableNames.has(name)))
      fail(
        `${traceFamilyId} transition uses an undeclared variable.`,
        "portfolio_command_path_trace_not_parameterized",
      );
    return Object.freeze({
      kind,
      [label]: requireString(value[label], `${traceFamilyId}.pathLanguage.${kind}.${label}`),
      uses,
    });
  }
  fail(`${traceFamilyId} has an unknown command-path segment kind.`, "portfolio_command_path_trace_steps_invalid");
}

function canonicalRequiredPostcondition(value, traceFamilyId) {
  validateExactKeys(
    value,
    ["kind", "sameBindingRequired", "freshAfterExecutionRequired", "nativeSaveReopenRereadRequired"],
    `${traceFamilyId}.requiredPostcondition`,
  );
  if (
    value.kind !== "persisted_predicate" ||
    value.sameBindingRequired !== true ||
    value.freshAfterExecutionRequired !== true ||
    value.nativeSaveReopenRereadRequired !== true
  ) {
    fail(
      `${traceFamilyId} must require a same-binding fresh persisted postcondition.`,
      "portfolio_command_path_postcondition_invalid",
    );
  }
  return Object.freeze({ ...value });
}

function canonicalEvidencePolicy(value, traceFamilyId) {
  validateExactKeys(
    value,
    [
      "topology",
      "sameExecutionRequired",
      "nonNullEvidenceRequired",
      "freshPostconditionRequired",
      "candidateClosureInheritance",
      "crossTopologyInheritance",
    ],
    `${traceFamilyId}.evidencePolicy`,
  );
  if (
    value.topology !== TOPOLOGY ||
    value.sameExecutionRequired !== true ||
    value.nonNullEvidenceRequired !== true ||
    value.freshPostconditionRequired !== true ||
    value.candidateClosureInheritance !== "forbidden" ||
    value.crossTopologyInheritance !== "forbidden"
  ) {
    fail(
      `${traceFamilyId} has an invalid evidence non-inheritance policy.`,
      "portfolio_command_path_evidence_policy_invalid",
    );
  }
  return Object.freeze({ ...value });
}

function canonicalSourceRealization(value, traceFamilyId) {
  requireRecord(value, `${traceFamilyId}.sourceRealization`);
  const status = requireString(value.status, `${traceFamilyId}.sourceRealization.status`);
  if (!SOURCE_REALIZATION_STATES.has(status) || !UNREALIZED_SOURCE_REALIZATION_STATES.has(status))
    fail(
      `${traceFamilyId} has an invalid source realization status.`,
      "portfolio_command_path_source_realization_invalid",
    );
  // A string/hash assertion is not target-version realization evidence. This
  // v1 grammar stays deliberately pre-realization; a future version may admit
  // only a dossier whose anchors and provenance are machine-revalidated.
  validateExactKeys(
    value,
    ["status", "uncertaintyId", "question", "disposition"],
    `${traceFamilyId}.sourceRealization`,
  );
  if (
    !ID.test(value.uncertaintyId ?? "") ||
    typeof value.question !== "string" ||
    value.question.length === 0 ||
    !UNKNOWN_DISPOSITIONS.has(value.disposition)
  ) {
    fail(
      `${traceFamilyId} must preserve unresolved source realization as a blocking disposition.`,
      "portfolio_command_path_source_realization_invalid",
    );
  }
  return Object.freeze({ ...value });
}

function canonicalExclusion(value, scopeAtoms, traceFamilies) {
  validateExactKeys(
    value,
    [
      "exclusionId",
      "classification",
      "omittedScopeAtomIds",
      "omittedTraceFamilyIds",
      "topology",
      "rationale",
      "playerVisibleDisposition",
      "nonSubstitutionRule",
      "admissionCondition",
    ],
    "exclusion",
  );
  const exclusionId = requireId(value.exclusionId, "exclusionId");
  if (!EXCLUSION_CLASSES.has(value.classification) || value.topology !== TOPOLOGY) {
    fail(`${exclusionId} has invalid classification or topology.`, "portfolio_command_path_exclusion_invalid");
  }
  const omittedScopeAtomIds = requireArray(value.omittedScopeAtomIds, `${exclusionId}.omittedScopeAtomIds`, {
    nonEmpty: false,
  }).map((id) => requireId(id, `${exclusionId}.omittedScopeAtomId`));
  const omittedTraceFamilyIds = requireArray(value.omittedTraceFamilyIds, `${exclusionId}.omittedTraceFamilyIds`, {
    nonEmpty: false,
  }).map((id) => requireId(id, `${exclusionId}.omittedTraceFamilyId`));
  requireUnique(omittedScopeAtomIds, `${exclusionId}.omittedScopeAtomIds`);
  requireUnique(omittedTraceFamilyIds, `${exclusionId}.omittedTraceFamilyIds`);
  if (
    omittedScopeAtomIds.length + omittedTraceFamilyIds.length === 0 ||
    omittedScopeAtomIds.some((id) => !scopeAtoms.has(id)) ||
    omittedTraceFamilyIds.some((id) => !traceFamilies.has(id))
  ) {
    fail(`${exclusionId} must identify exact known omitted obligations.`, "portfolio_command_path_exclusion_invalid");
  }
  for (const field of ["rationale", "playerVisibleDisposition", "nonSubstitutionRule", "admissionCondition"])
    requireString(value[field], `${exclusionId}.${field}`);
  return Object.freeze({
    exclusionId,
    classification: value.classification,
    omittedScopeAtomIds: Object.freeze(omittedScopeAtomIds),
    omittedTraceFamilyIds: Object.freeze(omittedTraceFamilyIds),
    topology: TOPOLOGY,
    rationale: value.rationale,
    playerVisibleDisposition: value.playerVisibleDisposition,
    nonSubstitutionRule: value.nonSubstitutionRule,
    admissionCondition: value.admissionCondition,
  });
}

function canonicalSourceImpact(value, traceFamilies, exclusions) {
  validateExactKeys(
    value,
    ["impactId", "traceFamilyId", "sourceAnchor", "disposition", "rationale", "exclusionId"],
    "source impact",
  );
  const impactId = requireId(value.impactId, "impactId");
  const disposition = requireString(value.disposition, `${impactId}.disposition`);
  if (!SOURCE_IMPACT_DISPOSITIONS.has(disposition))
    fail(`${impactId} has an invalid source-impact disposition.`, "portfolio_command_path_source_impact_invalid");
  const traceFamilyId = requireId(value.traceFamilyId, `${impactId}.traceFamilyId`);
  if (!traceFamilies.has(traceFamilyId))
    fail(`${impactId} references unknown trace family.`, "portfolio_command_path_source_impact_invalid");
  requireString(value.sourceAnchor, `${impactId}.sourceAnchor`);
  requireString(value.rationale, `${impactId}.rationale`);
  const exclusionId = value.exclusionId;
  if (disposition === "approved_exclusion") {
    const exclusion = typeof exclusionId === "string" ? exclusions.get(exclusionId) : null;
    if (
      !exclusion ||
      (!exclusion.omittedTraceFamilyIds.includes(traceFamilyId) &&
        !exclusion.omittedScopeAtomIds.includes(traceFamilies.get(traceFamilyId).scopeAtomId))
    ) {
      fail(
        `${impactId} requires an approved exclusion for this exact trace or scope atom.`,
        "portfolio_command_path_source_impact_invalid",
      );
    }
  } else if (exclusionId !== null) {
    fail(
      `${impactId} may reference an exclusion only for approved_exclusion.`,
      "portfolio_command_path_source_impact_invalid",
    );
  }
  return Object.freeze({
    impactId,
    traceFamilyId,
    sourceAnchor: value.sourceAnchor,
    disposition,
    rationale: value.rationale,
    exclusionId,
  });
}

/**
 * Validates the normative Portfolio command-path charter. This governance
 * artifact deliberately stops before action naming, source derivation, bridge
 * projection, or live evidence; it protects their eventual inputs instead.
 */
export function validatePortfolioCommandPathCharter(value) {
  validateNoForbiddenVocabulary(value);
  validateExactKeys(
    value,
    [
      "schemaVersion",
      "modelKind",
      "modelId",
      "target",
      "topology",
      "scopeAuthority",
      "taxonomyInputs",
      "observationAlphabet",
      "scopeAtoms",
      "traceFamilies",
      "exclusions",
      "sourceImpacts",
      "claims",
      "analysisBoundary",
    ],
    "Portfolio command-path charter",
  );
  if (
    value.schemaVersion !== 1 ||
    value.modelKind !== "portfolio_command_path_charter" ||
    value.modelId !== "core_valley_milestone_portfolio_v1_command_path_charter"
  ) {
    fail("Unsupported Portfolio command-path charter identity.", "portfolio_command_path_charter_schema_invalid");
  }
  if (
    !isRecord(value.target) ||
    value.target.gameVersion !== "1.6.15.24356" ||
    value.topology !== TOPOLOGY ||
    !isRecord(value.scopeAuthority) ||
    value.scopeAuthority.document !== "design/16_STARDEW_DEMO_SCOPE_AND_GOAL_CONTRACTS.md" ||
    !SHA256.test(value.scopeAuthority.sha256 ?? "")
  ) {
    fail(
      "Portfolio command-path charter is not bound to the approved target scope.",
      "portfolio_command_path_charter_scope_invalid",
    );
  }
  validateTaxonomyInputs(value.taxonomyInputs);
  const observationAlphabet = stringArray(value.observationAlphabet, "observationAlphabet");
  if (!sameSet(observationAlphabet, REQUIRED_OBSERVATION_DIMENSIONS)) {
    fail(
      "Portfolio command-path charter must freeze every required semantic observation dimension.",
      "portfolio_command_path_observation_incomplete",
    );
  }

  const scopeAtoms = requireArray(value.scopeAtoms, "scopeAtoms").map(canonicalScopeAtom);
  requireUnique(
    scopeAtoms.map((entry) => entry.scopeAtomId),
    "scope atom IDs",
  );
  requireUnique(
    scopeAtoms.map((entry) => entry.milestoneId),
    "scope atom milestones",
  );
  if (
    !sameSet(
      scopeAtoms.map((entry) => entry.milestoneId),
      MILESTONES,
    )
  ) {
    fail(
      "Portfolio command-path charter must account for M1–M10 exactly once.",
      "portfolio_command_path_scope_atom_closure_missing",
    );
  }
  const scopeAtomIds = new Set(scopeAtoms.map((entry) => entry.scopeAtomId));

  const traceFamilies = requireArray(value.traceFamilies, "traceFamilies", { nonEmpty: false }).map((entry) =>
    canonicalTraceFamily(entry, scopeAtomIds),
  );
  requireUnique(
    traceFamilies.map((entry) => entry.traceFamilyId),
    "trace family IDs",
  );
  requireUnique(
    traceFamilies.map((entry) => entry.scopeAtomId),
    "trace family scope atom IDs",
  );
  const traceFamilyIds = new Set(traceFamilies.map((entry) => entry.traceFamilyId));

  const exclusions = requireArray(value.exclusions, "exclusions", { nonEmpty: false }).map((entry) =>
    canonicalExclusion(entry, scopeAtomIds, traceFamilyIds),
  );
  requireUnique(
    exclusions.map((entry) => entry.exclusionId),
    "exclusion IDs",
  );
  const exclusionsById = new Map(exclusions.map((entry) => [entry.exclusionId, entry]));

  const traceFamiliesById = new Map(traceFamilies.map((entry) => [entry.traceFamilyId, entry]));
  const sourceImpacts = requireArray(value.sourceImpacts, "sourceImpacts", { nonEmpty: false }).map((entry) =>
    canonicalSourceImpact(entry, traceFamiliesById, exclusionsById),
  );
  requireUnique(
    sourceImpacts.map((entry) => entry.impactId),
    "source impact IDs",
  );

  validateClaims(value.claims, traceFamilies, scopeAtoms);
  validateAnalysisBoundary(value.analysisBoundary);

  const traceScopeAtoms = new Set(traceFamilies.map((entry) => entry.scopeAtomId));
  const excludedScopeAtoms = new Set(exclusions.flatMap((entry) => entry.omittedScopeAtomIds));
  const unresolvedScopeAtomIds = scopeAtoms
    .map((entry) => entry.scopeAtomId)
    .filter((id) => !traceScopeAtoms.has(id) && !excludedScopeAtoms.has(id));
  return Object.freeze({
    schemaVersion: 1,
    modelKind: "validated_portfolio_command_path_charter",
    modelId: value.modelId,
    scopeAuthority: Object.freeze({ ...value.scopeAuthority }),
    topology: TOPOLOGY,
    scopeAtomCount: scopeAtoms.length,
    traceFamilyCount: traceFamilies.length,
    pendingScopeAtomIds: Object.freeze(unresolvedScopeAtomIds),
    scopeAtoms: Object.freeze(scopeAtoms),
    traceFamilies: Object.freeze(traceFamilies),
    exclusions: Object.freeze(exclusions),
    sourceImpacts: Object.freeze(sourceImpacts),
    claims: Object.freeze({ ...value.claims }),
    analysisBoundary: Object.freeze({ ...value.analysisBoundary }),
    state: traceFamilies.length === 0 ? "scope_chartered_trace_derivation_pending" : "trace_derivation_in_progress",
  });
}

export function assessPortfolioCommandPathCharter(value) {
  const charter = validatePortfolioCommandPathCharter(value);
  const traceFamilyIds = new Set(charter.traceFamilies.map((entry) => entry.traceFamilyId));
  const pendingTraceScopeAtomIds = charter.scopeAtoms
    .map((entry) => entry.scopeAtomId)
    .filter((id) => !charter.traceFamilies.some((trace) => trace.scopeAtomId === id));
  const unknownImpacts = charter.sourceImpacts
    .filter((entry) => entry.disposition === "unknown_blocking")
    .map((entry) => entry.impactId);
  const inReview = charter.traceFamilies
    .filter((entry) => entry.sourceRealization.status !== "realized")
    .map((entry) => entry.traceFamilyId);
  const unprojected = charter.traceFamilies
    .filter((entry) => entry.projectionState === "unprojected")
    .map((entry) => entry.traceFamilyId);
  const state =
    unknownImpacts.length > 0
      ? "blocked_pending_source_impact_disposition"
      : pendingTraceScopeAtomIds.length > 0
        ? "blocked_pending_parameterized_trace_families"
        : inReview.length > 0
          ? "pending_focused_source_realization"
          : unprojected.length > 0
            ? "pending_capability_projection"
            : "not_a_live_or_publication_claim";
  return Object.freeze({
    schemaVersion: 1,
    artifactKind: "portfolio_command_path_charter_assessment",
    modelId: charter.modelId,
    topology: TOPOLOGY,
    state,
    pendingScopeAtomIds: Object.freeze(pendingTraceScopeAtomIds),
    traceFamilyIds: Object.freeze([...traceFamilyIds].sort()),
    sourceImpactIds: Object.freeze(charter.sourceImpacts.map((entry) => entry.impactId).sort()),
    unknownBlockingImpactIds: Object.freeze(unknownImpacts.sort()),
    pendingSourceRealizationTraceFamilyIds: Object.freeze(inReview.sort()),
    pendingProjectionTraceFamilyIds: Object.freeze(unprojected.sort()),
    publishable: false,
    nonClaim:
      "This assessment governs a Portfolio trace-model input only. It does not derive an Action, grant a capability, set a Capability Set status, or establish a real-game live result.",
  });
}

function validateTaxonomyInputs(value) {
  validateExactKeys(value, ["allowed", "forbidden"], "taxonomyInputs");
  const allowed = stringArray(value.allowed, "taxonomyInputs.allowed");
  const forbidden = stringArray(value.forbidden, "taxonomyInputs.forbidden");
  if (!sameSet(allowed, ALLOWED_TAXONOMY_INPUTS) || !sameSet(forbidden, FORBIDDEN_TAXONOMY_INPUTS)) {
    fail(
      "Portfolio charter taxonomy inputs do not freeze the required discovery boundary.",
      "portfolio_command_path_taxonomy_inputs_invalid",
    );
  }
}

function validateClaims(value, traceFamilies, scopeAtoms) {
  validateExactKeys(
    value,
    ["scopeAccounted", "representationClosed", "executionClosed", "publicationClosed"],
    "claims",
  );
  if (Object.values(value).some((entry) => entry !== false)) {
    fail(
      "A charter may not claim closure before trace, realization, projection, and live evidence exist.",
      "portfolio_command_path_claim_invalid",
    );
  }
  if (traceFamilies.length > scopeAtoms.length * 64)
    fail("Portfolio charter trace expansion is implausibly unbounded.", "portfolio_command_path_claim_invalid");
}

function validateAnalysisBoundary(value) {
  validateExactKeys(
    value,
    ["legacyCatalog", "actionRegistry", "sourceRole", "bridgeProjection", "liveEvidence"],
    "analysisBoundary",
  );
  if (
    value.legacyCatalog !== "forbidden_discovery_input" ||
    value.actionRegistry !== "forbidden_discovery_input" ||
    value.sourceRole !== "per_trace_realization_and_impact_evidence_only" ||
    value.bridgeProjection !== "not_performed" ||
    value.liveEvidence !== "not_performed"
  ) {
    fail("Portfolio charter analysis boundary is invalid.", "portfolio_command_path_boundary_invalid");
  }
}

function sameSet(values, expected) {
  const left = [...values].sort();
  const right = [...expected].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
