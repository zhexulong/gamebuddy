import { createHash } from "node:crypto";
import { validateNativeTransitionScopeManifest } from "./stardew-native-transition-scope-manifest.mjs";

const TRANSITION_KINDS = new Set([
  "source_router",
  "source_owned_transition",
  "owner_managed_continuation",
  "scope_exclusion_boundary",
  "unresolved_gap",
]);
const HANDOFF_KINDS = new Set([
  "direct_call", "conditional_branch", "virtual_dispatch", "delegate",
  "content_lookup", "event_registration", "update_resume", "external",
]);
const HANDOFF_PHASES = new Set(["routing", "before_commit", "after_commit", "continuation"]);
const FORBIDDEN_KEYS = new Set([
  "action", "actionId", "primitive", "primitiveId", "operation", "operationId",
  "semanticFamily", "intent", "contract", "receipt", "evidence", "policy",
  "capability", "publicAction", "publicActionId", "projection", "reuse", "playerOutcome",
]);
const SHA256 = /^[a-f0-9]{64}$/;

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function requiredString(value, field, details = {}) {
  if (typeof value !== "string" || value.trim() === "") fail("transition_ledger_invalid", `Expected non-empty ${field}.`, details);
  return value;
}
function requiredArray(value, field, details = {}) {
  if (!Array.isArray(value)) fail("transition_ledger_invalid", `Expected ${field} array.`, details);
  return value;
}
function requiredInteger(value, field, details = {}) {
  if (!Number.isInteger(value) || value < 0) fail("transition_ledger_invalid", `Expected non-negative integer ${field}.`, details);
  return value;
}
function assertNoForbiddenKeys(value, path = "$") {
  if (Array.isArray(value)) return value.forEach((entry, index) => assertNoForbiddenKeys(entry, `${path}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) fail("transition_ledger_forbidden_field", `Transition ledger must not infer ${key}.`, { path: `${path}.${key}` });
    assertNoForbiddenKeys(child, `${path}.${key}`);
  }
}
function sourceAnchor(value, field, details = {}) {
  if (!value || typeof value !== "object") fail("transition_ledger_invalid", `Expected ${field} source anchor.`, details);
  requiredString(value.sourcePath, `${field}.sourcePath`, details);
  requiredString(value.member, `${field}.member`, details);
  for (const key of ["sourceSliceSha256", "sourceFileSha256"]) {
    if (!SHA256.test(value[key] ?? "")) fail("transition_ledger_invalid", `Expected SHA-256 ${field}.${key}.`, details);
  }
  const start = requiredInteger(value.startByte, `${field}.startByte`, details);
  const end = requiredInteger(value.endByte, `${field}.endByte`, details);
  if (end <= start) fail("transition_ledger_invalid", `Expected ${field} to have a non-empty byte span.`, details);
  return value;
}
function verifyAnchor(anchor, sourceFiles, field, details) {
  sourceAnchor(anchor, field, details);
  const source = sourceFiles.get(anchor.sourcePath);
  if (!source) fail("transition_ledger_anchor_source_unknown", "Anchor source path is absent from the exact source manifest.", { ...details, field, sourcePath: anchor.sourcePath });
  if (anchor.sourceFileSha256 !== source.sha256) fail("transition_ledger_anchor_source_stale", "Anchor source file hash does not match exact source manifest.", { ...details, field, sourcePath: anchor.sourcePath, expected: source.sha256, actual: anchor.sourceFileSha256 });
  if (source.text === undefined) return;
  const bytes = Buffer.from(source.text, "utf8");
  if (anchor.endByte > bytes.length) fail("transition_ledger_anchor_span_invalid", "Anchor byte span exceeds exact source file length.", { ...details, field, sourcePath: anchor.sourcePath });
  const slice = bytes.subarray(anchor.startByte, anchor.endByte);
  const actualSlice = sha256(slice);
  if (actualSlice !== anchor.sourceSliceSha256) fail("transition_ledger_anchor_slice_stale", "Anchor slice hash does not match exact source span.", { ...details, field, sourcePath: anchor.sourcePath, expected: actualSlice, actual: anchor.sourceSliceSha256 });
  const memberIdentifier = anchor.member.split(/[.#]/).filter(Boolean).at(-1);
  if (!memberIdentifier || !Buffer.from(slice).toString("utf8").includes(memberIdentifier)) {
    fail("transition_ledger_anchor_member_unproven", "Anchor member identifier is absent from its exact source span.", { ...details, field, sourcePath: anchor.sourcePath, member: anchor.member });
  }
}
function observation(value, field, details, sourceFiles) {
  if (!value || typeof value !== "object") fail("transition_ledger_invalid", `Expected ${field} observation.`, details);
  requiredString(value.ownerSyntax, `${field}.ownerSyntax`, details);
  requiredString(value.stateSyntax, `${field}.stateSyntax`, details);
  verifyAnchor(value.anchor, sourceFiles, `${field}.anchor`, details);
}
function handoffsFor(node, byId, sourceFiles) {
  const details = { nodeId: node.transitionId };
  const handoffs = requiredArray(node.handoffs, "handoffs", details);
  const sequences = new Set();
  for (const handoff of handoffs) {
    if (!handoff || typeof handoff !== "object") fail("transition_ledger_invalid", "Handoff must be an object.", details);
    requiredString(handoff.toTransitionId, "handoffs[].toTransitionId", details);
    if (!byId.has(handoff.toTransitionId)) fail("transition_ledger_dangling_handoff", "Transition handoff does not resolve to a node.", { ...details, targetId: handoff.toTransitionId });
    if (!HANDOFF_KINDS.has(handoff.kind)) fail("transition_ledger_invalid", "Unknown handoff kind.", { ...details, kind: handoff.kind });
    if (!HANDOFF_PHASES.has(handoff.phase)) fail("transition_ledger_invalid", "Unknown handoff phase.", { ...details, phase: handoff.phase });
    const sequence = requiredInteger(handoff.sequence, "handoffs[].sequence", details);
    if (sequences.has(sequence)) fail("transition_ledger_duplicate_handoff_sequence", "Handoff sequence must be unique within a node.", details);
    sequences.add(sequence);
    verifyAnchor(handoff.handoffAnchor, sourceFiles, "handoffs[].handoffAnchor", details);
    if (handoff.condition === "always") {
      if (handoff.conditionAnchor !== undefined) fail("transition_ledger_invalid", "An always handoff must not have a condition anchor.", details);
    } else if (handoff.condition === "conditional") {
      verifyAnchor(handoff.conditionAnchor, sourceFiles, "handoffs[].conditionAnchor", details);
    } else fail("transition_ledger_invalid", "Handoff condition must be always or conditional.", details);
  }
  if ((node.kind === "source_router" || node.kind === "source_owned_transition" || node.kind === "owner_managed_continuation") && handoffs.length === 0) {
    fail("transition_ledger_empty_nonterminal", "A non-terminal source node requires at least one explicit handoff.", details);
  }
  const sourceNode = ["source_router", "source_owned_transition", "owner_managed_continuation"].includes(node.kind);
  if (!sourceNode) return handoffs;
  if (!["exhaustive", "partial"].includes(node.exitCoverage)) fail("transition_ledger_invalid", "Source nodes require exitCoverage exhaustive or partial.", details);
  const exits = requiredArray(node.exitInventory, "exitInventory", details);
  const exitIds = new Set(); const representedSequences = new Set(); let unresolvedExitCount = 0;
  for (const exit of exits) {
    if (!exit || typeof exit !== "object" || typeof exit.exitId !== "string" || !exit.exitId || exitIds.has(exit.exitId)) fail("transition_ledger_exit_inventory_invalid", "Every source exit inventory row needs a unique exitId.", details);
    exitIds.add(exit.exitId); verifyAnchor(exit.anchor, sourceFiles, "exitInventory[].anchor", details);
    if (exit.kind === "terminal") {
      requiredString(exit.terminalReason, "exitInventory[].terminalReason", details); verifyAnchor(exit.terminalReasonAnchor, sourceFiles, "exitInventory[].terminalReasonAnchor", details);
    } else if (exit.kind === "handoff" || exit.kind === "unresolved_gap") {
      const sequence = requiredInteger(exit.handoffSequence, "exitInventory[].handoffSequence", details);
      const handoff = handoffs.find((item) => item.sequence === sequence);
      if (!handoff || representedSequences.has(sequence)) fail("transition_ledger_exit_inventory_handoff_mismatch", "Every handoff must have exactly one corresponding exit inventory row.", { ...details, sequence });
      if (exit.kind === "unresolved_gap" && byId.get(handoff.toTransitionId).kind !== "unresolved_gap") fail("transition_ledger_exit_inventory_gap_mismatch", "An unresolved exit inventory row must terminate at an unresolved gap.", { ...details, sequence });
      if (exit.kind === "unresolved_gap") unresolvedExitCount += 1;
      representedSequences.add(sequence);
    } else fail("transition_ledger_exit_inventory_invalid", "Unknown exit inventory kind.", details);
  }
  if (representedSequences.size !== handoffs.length) fail("transition_ledger_exit_inventory_incomplete", "Every explicit handoff needs exactly one source-anchored exit inventory row.", details);
  if (node.exitCoverage === "partial" && unresolvedExitCount === 0) fail("transition_ledger_partial_exit_without_gap", "A partial source region needs a source-anchored omitted exit routed to an unresolved gap.", details);
  if (node.exitCoverage === "exhaustive" && unresolvedExitCount > 0) fail("transition_ledger_exhaustive_with_gap", "An exhaustive source region cannot retain an unresolved exit.", details);
  return handoffs;
}
function validateNode(node, scopedMechanismIds, sourceFiles, scopeBoundaries) {
  if (!node || typeof node !== "object") fail("transition_ledger_invalid", "Transition node must be an object.");
  const details = { nodeId: node.transitionId };
  requiredString(node.transitionId, "transitionId", details);
  if (!TRANSITION_KINDS.has(node.kind)) fail("transition_ledger_invalid", "Unknown transition node kind.", { ...details, kind: node.kind });
  requiredArray(node.incomingMechanismIds, "incomingMechanismIds", details);
  for (const mechanismId of node.incomingMechanismIds) {
    requiredString(mechanismId, "incomingMechanismIds[]", details);
    if (!scopedMechanismIds.has(mechanismId)) fail("transition_ledger_unscoped_mechanism", "Node references a mechanism outside the ledger scope.", { ...details, mechanismId });
  }
  if (new Set(node.incomingMechanismIds).size !== node.incomingMechanismIds.length) fail("transition_ledger_duplicate_incoming_mechanism", "A transition cannot repeat an incoming mechanism.", details);
  if (typeof node.possiblyGameplayBearing !== "boolean") fail("transition_ledger_invalid", "Expected possiblyGameplayBearing boolean.", details);
  if (!node.possiblyGameplayBearing) {
    requiredString(node.nonGameplayReason, "nonGameplayReason", details);
    verifyAnchor(node.nonGameplayReasonAnchor, sourceFiles, "nonGameplayReasonAnchor", details);
  }
  if (node.kind === "source_router") {
    verifyAnchor(node.ownerAnchor, sourceFiles, "ownerAnchor", details);
    requiredString(node.routerReason, "routerReason", details);
  } else if (node.kind === "source_owned_transition" || node.kind === "owner_managed_continuation") {
    verifyAnchor(node.ownerAnchor, sourceFiles, "ownerAnchor", details);
    const post = requiredArray(node.postStateObservations, "postStateObservations", details);
    const pending = requiredArray(node.pendingNativeContinuationState, "pendingNativeContinuationState", details);
    post.forEach((item) => observation(item, "postStateObservations[]", details, sourceFiles));
    pending.forEach((item) => observation(item, "pendingNativeContinuationState[]", details, sourceFiles));
    if (node.kind === "source_owned_transition") {
      verifyAnchor(node.commitAnchor, sourceFiles, "commitAnchor", details);
      if (post.length === 0 && pending.length === 0) fail("transition_ledger_transition_without_observation", "A source-owned transition needs an anchored post-state or pending-continuation observation.", details);
    } else {
      if (pending.length === 0) fail("transition_ledger_continuation_without_pending_state", "A continuation needs pending native continuation state.", details);
      verifyAnchor(node.registrationAnchor, sourceFiles, "registrationAnchor", details);
      if (node.resumeAnchor) verifyAnchor(node.resumeAnchor, sourceFiles, "resumeAnchor", details);
      else verifyAnchor(node.terminalAnchor, sourceFiles, "terminalAnchor", details);
    }
  } else if (node.kind === "scope_exclusion_boundary") {
    verifyAnchor(node.boundaryAnchor, sourceFiles, "boundaryAnchor", details);
    requiredString(node.boundaryKind, "boundaryKind", details);
    if (node.scopeDisposition !== "out_of_scope") fail("transition_ledger_boundary_not_excluded", "Only an explicit out_of_scope boundary may be terminal.", details);
    requiredString(node.scopeReason, "scopeReason", details);
    const scopeBoundary = scopeBoundaries?.boundaryById.get(node.scopeManifestBoundaryId);
    if (!scopeBoundary || scopeBoundary.boundaryKind !== node.boundaryKind || scopeBoundary.scopeReason !== node.scopeReason || !scopeBoundaries.sameAnchor(scopeBoundary.sourceAnchor, node.boundaryAnchor)) {
      fail("transition_ledger_scope_boundary_unapproved", "A terminal exclusion must exactly reference an approved exact-target scope-manifest boundary.", details);
    }
  } else {
    verifyAnchor(node.boundaryAnchor, sourceFiles, "boundaryAnchor", details);
    requiredString(node.gapOrBoundaryReason, "gapOrBoundaryReason", details);
    if (node.possiblyGameplayBearing !== true) fail("transition_ledger_gap_must_block", "An unresolved gap is always blocking until it is resolved or replaced by an exact out-of-scope boundary.", details);
  }
}
function reachableFrom(rootId, byId, visited = new Set()) {
  if (visited.has(rootId)) return visited;
  visited.add(rootId);
  for (const handoff of byId.get(rootId)?.handoffs ?? []) reachableFrom(handoff.toTransitionId, byId, visited);
  return visited;
}
export function validateNativeTransitionLedger(ledger, { expectedMechanismIds = [], expectedMechanismRecords = null, reviewedMechanismDispositions = null, scopeManifest = null, sourceFiles = {}, expectedAttestation = null } = {}) {
  if (!ledger || typeof ledger !== "object") fail("transition_ledger_required", "A transition ledger object is required.");
  assertNoForbiddenKeys(ledger);
  if (ledger.schemaVersion !== 2 || ledger.artifactKind !== "native_transition_continuation_ledger") fail("transition_ledger_schema_invalid", "Expected transition ledger schema version 2.");
  const targetAssemblySha256 = requiredString(ledger.attestation?.targetAssemblySha256, "attestation.targetAssemblySha256");
  const sourceManifestSha256 = requiredString(ledger.attestation?.sourceManifestSha256, "attestation.sourceManifestSha256");
  if (!SHA256.test(targetAssemblySha256) || !SHA256.test(sourceManifestSha256)) fail("transition_ledger_invalid", "Ledger attestation must contain SHA-256 values.");
  if (expectedAttestation && (targetAssemblySha256 !== expectedAttestation.targetAssemblySha256 || sourceManifestSha256 !== expectedAttestation.sourceManifestSha256)) {
    fail("transition_ledger_attestation_mismatch", "Ledger target/source attestation does not match the exact mechanism report.", {
      expected: expectedAttestation,
      actual: { targetAssemblySha256, sourceManifestSha256 },
    });
  }
  const expected = new Set(expectedMechanismIds);
  if (expected.size !== expectedMechanismIds.length) fail("transition_ledger_duplicate_mechanism", "Mechanism report contains duplicate IDs.");
  const allowedInScope = reviewedMechanismDispositions === null ? null : new Map(Object.entries(reviewedMechanismDispositions));
  if (allowedInScope && (allowedInScope.size !== expected.size || [...expected].some((id) => !allowedInScope.has(id)))) {
    fail("transition_ledger_review_register_invalid", "A complete review disposition is required for every exact mechanism before Stage 2 can scope a root.");
  }
  const mechanismRecords = expectedMechanismRecords === null ? null : new Map(expectedMechanismRecords.map((record) => [record?.mechanismId, record]));
  if (mechanismRecords && mechanismRecords.size !== expectedMechanismIds.length) fail("transition_ledger_mechanism_records_invalid", "Expected mechanism records must be unique and match expected mechanism IDs.");
  const fileEntries = sourceFiles instanceof Map ? [...sourceFiles.entries()] : Object.entries(sourceFiles);
  const exactSources = new Map();
  for (const [sourcePath, record] of fileEntries) {
    if (exactSources.has(sourcePath) || !SHA256.test(record?.sha256 ?? "")) fail("transition_ledger_source_manifest_invalid", "Exact source manifest has duplicate or malformed source records.", { sourcePath });
    exactSources.set(sourcePath, record);
  }
  if (exactSources.size === 0) fail("transition_ledger_source_manifest_required", "Exact source manifest is required for source anchor verification.");
  const scoped = requiredArray(ledger.scopedMechanismIds, "scopedMechanismIds");
  const scopedMechanismIds = new Set();
  for (const mechanismId of scoped) {
    requiredString(mechanismId, "scopedMechanismIds[]");
    if (!expected.has(mechanismId)) fail("transition_ledger_unknown_mechanism", "Ledger scope references mechanism absent from exact report.", { mechanismId });
    if (allowedInScope && !["in_scope_root", "in_scope_continuation", "in_scope_content_interpreter"].includes(allowedInScope.get(mechanismId))) {
      fail("transition_ledger_unreviewed_or_excluded_mechanism", "Stage-2 scope may reference only an explicitly in-scope reviewed mechanism.", { mechanismId, disposition: allowedInScope.get(mechanismId) });
    }
    if (scopedMechanismIds.has(mechanismId)) fail("transition_ledger_duplicate_scoped_mechanism", "Ledger scope duplicates a mechanism.", { mechanismId });
    scopedMechanismIds.add(mechanismId);
  }
  if (scopedMechanismIds.size === 0) fail("transition_ledger_empty_scope", "A transition ledger must explicitly scope at least one mechanism.");
  const scopeBoundaries = scopeManifest === null ? null : validateNativeTransitionScopeManifest(scopeManifest, { expectedAttestation: expectedAttestation ?? { targetAssemblySha256, sourceManifestSha256 } });
  const nodes = requiredArray(ledger.transitions, "transitions");
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node?.transitionId)) fail("transition_ledger_duplicate_transition", "Duplicate transition ID.", { transitionId: node?.transitionId });
    byId.set(node?.transitionId, node);
  }
  for (const node of nodes) validateNode(node, scopedMechanismIds, exactSources, scopeBoundaries);
  for (const node of nodes) handoffsFor(node, byId, exactSources);
  const rootBindings = requiredArray(ledger.rootBindings, "rootBindings");
  const rootCounts = new Map();
  for (const binding of rootBindings) {
    requiredString(binding?.mechanismId, "rootBindings[].mechanismId");
    requiredString(binding?.transitionId, "rootBindings[].transitionId");
    if (!scopedMechanismIds.has(binding.mechanismId)) fail("transition_ledger_unscoped_mechanism", "Root binding references a mechanism outside scope.", binding);
    if (!byId.has(binding.transitionId)) fail("transition_ledger_unknown_transition", "Root binding references unknown transition.", binding);
    if (mechanismRecords) {
      const record = mechanismRecords.get(binding.mechanismId);
      const anchor = byId.get(binding.transitionId).ownerAnchor ?? byId.get(binding.transitionId).boundaryAnchor;
      const locator = record?.sourceLocator;
      if (!record || !anchor || record.sourcePath !== anchor.sourcePath || locator?.startByte !== anchor.startByte || locator?.endByte !== anchor.endByte || locator?.sliceSha256 !== anchor.sourceSliceSha256) {
        fail("transition_ledger_root_anchor_mismatch", "Root transition anchor must exactly match its exact mechanism declaration locator.", { binding, record, anchor });
      }
    }
    rootCounts.set(binding.mechanismId, (rootCounts.get(binding.mechanismId) ?? 0) + 1);
    if (!byId.get(binding.transitionId).incomingMechanismIds.includes(binding.mechanismId)) {
      fail("transition_ledger_root_binding_not_declared_incoming", "Root binding must be declared by its bound transition as an incoming mechanism.", binding);
    }
  }
  for (const mechanismId of scopedMechanismIds) {
    const count = rootCounts.get(mechanismId) ?? 0;
    if (count !== 1) fail("transition_ledger_root_not_exactly_once", "Each scoped mechanism needs exactly one root binding.", { mechanismId, count });
  }
  const reachable = new Set();
  for (const binding of rootBindings) for (const nodeId of reachableFrom(binding.transitionId, byId)) reachable.add(nodeId);
  const orphanTransitionIds = nodes.filter((node) => !reachable.has(node.transitionId)).map((node) => node.transitionId);
  if (orphanTransitionIds.length) fail("transition_ledger_orphan_transition", "Every transition must be reachable from a scoped root.", { orphanTransitionIds });
  const blockingNodeIds = nodes.filter((node) => node.kind === "unresolved_gap").map((node) => node.transitionId);
  if (ledger.closureState === "native_transition_closure_complete" && blockingNodeIds.length) fail("transition_ledger_blocking_gap", "Unresolved or non-gameplay terminal nodes block native transition closure.", { blockingNodeIds });
  if (!new Set(["partial", "native_transition_closure_complete"]).has(ledger.closureState)) fail("transition_ledger_closure_state_invalid", "Invalid closure state.");
  return Object.freeze({ transitionCount: nodes.length, rootBindingCount: rootBindings.length, scopedMechanismCount: scopedMechanismIds.size, blockingNodeCount: blockingNodeIds.length, closureState: ledger.closureState });
}
