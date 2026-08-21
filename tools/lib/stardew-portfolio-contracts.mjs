import { createHmac, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  canonicalJson,
  computePortfolioBindingHash,
  hashPortfolioCanonicalJson,
  PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
  PORTFOLIO_TARGET_BUILD_NUMBER,
  PORTFOLIO_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION,
  PORTFOLIO_TOPOLOGY,
} from "./stardew-portfolio-contract-primitives.mjs";

export {
  PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
  PORTFOLIO_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION,
  PORTFOLIO_TARGET_BUILD_NUMBER,
  PORTFOLIO_TOPOLOGY,
  hashPortfolioCanonicalJson,
};

/**
 * Phase 3 is a schema/ledger seam only. It never launches Stardew, does not
 * grant a capability, does not produce native evidence, and does not turn a
 * deterministic result into a live or publication result. The final run may consume only the explicit
 * attestation references validated here.
 */
export const PORTFOLIO_CONTRACT_PROTOCOL_VERSION = 2;
export const PORTFOLIO_MILESTONE_MONITORS = new Map([
  ["M1", "portfolio_m1_native_persisted_v1"],
  ["M2", "portfolio_m2_native_persisted_v1"],
  ["M3", "portfolio_m3_native_persisted_v1"],
  ["M4", "portfolio_m4_native_persisted_v1"],
  ["M5", "portfolio_m5_native_persisted_v1"],
  ["M6", "portfolio_m6_native_persisted_v1"],
  ["M7", "portfolio_m7_native_persisted_v1"],
  ["M8", "portfolio_m8_native_persisted_v1"],
  ["M9", "portfolio_m9_native_persisted_v1"],
  ["M10", "portfolio_m10_native_persisted_v1"],
]);

const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const TOPOLOGY_SUFFIX = `__${PORTFOLIO_TOPOLOGY}`;
const SIGNATURE_ALGORITHM = "hmac-sha256";
const CONTRACT_KINDS = new Set(["candidate_closure", "portfolio_run"]);
const ACTION_CLASSES = new Set(["primitive", "composite", "coordination", "coordinated", "content_operation"]);
const EXECUTION_STATES = new Set([
  "blocked",
  "invalidated",
  "succeeded",
  "partially_succeeded",
  "failed",
  "cancelled",
  "expired",
  "rejected",
  "uncertain",
]);
const TERMINAL_SUCCESS = "succeeded";
const CONTRACT_TYPES = new Set([
  "candidate_execution_request",
  "candidate_cancel_request",
  "candidate_checkpoint_request",
  "portfolio_execution_request",
  "portfolio_cancel_request",
  "portfolio_checkpoint_request",
]);
const MANIFEST_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "topology",
  "contractKind",
  "candidateClosureRunId",
  "variant",
  "target",
  "scope",
  "contentProvenance",
  "evidenceSchemaRevision",
  "registryRevision",
  "exclusions",
  "manifestHash",
  "signatureAlgorithm",
  "signature",
]);
const DSM_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "topology",
  "contractKind",
  "portfolioId",
  "portfolioRunId",
  "frozen",
  "target",
  "scope",
  "variants",
  "milestones",
  "contentScope",
  "barriers",
  "registryRevision",
  "policyRevision",
  "evidenceSchemaRevision",
  "startManifestHash",
  "exclusions",
  "manifestHash",
  "signatureAlgorithm",
  "signature",
]);
const CCM_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "topology",
  "contractKind",
  "ccmRevision",
  "evidenceSchemaRevision",
  "publicationState",
  "rows",
  "manifestHash",
  "signatureAlgorithm",
  "signature",
]);
const TARGET_FIELDS = Object.freeze([
  "gameVersion",
  "gameBuild",
  "gameSha256",
  "smapiVersion",
  "smapiSha256",
  "smapiExeSha256",
  "modSha256",
  "hostSha256",
]);
const SCOPE_FIELDS = Object.freeze([
  "saveId",
  "worldId",
  "localPlayerId",
  "companionId",
  "bindingGeneration",
  "bindingHash",
]);
const PROVENANCE_FIELDS = Object.freeze([
  "sourceKind",
  "sourceRevision",
  "nativeSourceSha256",
  "contentManifestSha256",
]);
const VARIANT_FIELDS = Object.freeze(["variantId", "actionClass", "contractRevision", "domain"]);
const DOMAIN_FIELDS = Object.freeze(["kind", "domainId", "values", "valueHash"]);
const DSM_VARIANT_FIELDS = Object.freeze([
  "variantId",
  "actionClass",
  "domainHash",
  "provenanceHash",
  "ccmRowId",
  "closureAttestationHash",
]);
const MILESTONE_FIELDS = Object.freeze(["id", "monitorId", "requiredVariantIds"]);
const CONTENT_SCOPE_FIELDS = Object.freeze(["bundle", "mine", "specialOrder", "museum"]);
const BUNDLE_SCOPE_FIELDS = Object.freeze(["slotId", "acceptedItemIds", "rewardId"]);
const MINE_SCOPE_FIELDS = Object.freeze(["routeId", "targetFloor"]);
const ORDER_SCOPE_FIELDS = Object.freeze(["orderId", "objectiveIds", "rewardId"]);
const MUSEUM_SCOPE_FIELDS = Object.freeze(["pieceIds", "pieceSetHash", "rewardId"]);
const BARRIER_FIELDS = Object.freeze(["sleepVariantId", "saveReopenRequired"]);
const CCM_ROW_FIELDS = Object.freeze([
  "rowId",
  "variantId",
  "candidateClosureRunId",
  "candidateManifestHash",
  "domainHash",
  "provenanceHash",
  "topology",
  "bindingHash",
  "bindingGeneration",
  "targetVersion",
  "evidenceSchemaRevision",
  "actionClass",
  "status",
  "contractGate",
  "deterministicGate",
  "liveGate",
  "recoveryGate",
  "closureAttestationHash",
]);
const RECEIPT_FIELDS = Object.freeze([
  "schemaVersion",
  "artifactKind",
  "topology",
  "bindingHash",
  "bindingGeneration",
  "contractKind",
  "contractId",
  "manifestHash",
  "evidenceSchemaRevision",
  "requestId",
  "requestFingerprint",
  "executionId",
  "revision",
  "actionVariant",
  "state",
  "reasonCode",
  "evidence",
]);
const CHECKPOINT_FIELDS = Object.freeze([
  ...RECEIPT_FIELDS.filter((field) => field !== "artifactKind"),
  "artifactKind",
  "checkpointId",
  "monitorId",
]);

export function signCandidateClosureManifest(value, signingKey) {
  return signArtifact(value, "candidate_closure_manifest", signingKey);
}

export function signPortfolioDsm(value, signingKey) {
  return signArtifact(value, "portfolio_dsm", signingKey);
}

export function signPortfolioCcm(value, signingKey) {
  return signArtifact(value, "portfolio_ccm", signingKey);
}

export function validateCandidateClosureManifest(value, expected = {}) {
  const errors = validateSignedArtifact(
    value,
    MANIFEST_FIELDS,
    "portfolio_candidate_manifest",
    expected,
    "candidate_closure_manifest",
  );
  if (!isPlainObject(value)) return result(false, errors);
  if (value.schemaVersion !== 1) errors.push("portfolio_candidate_manifest_schema_version_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_candidate_manifest_topology_invalid");
  if (value.contractKind !== "candidate_closure") errors.push("portfolio_candidate_manifest_contract_kind_invalid");
  if (
    !validId(value.candidateClosureRunId) ||
    value.candidateClosureRunId.startsWith("portfolio_") ||
    !value.candidateClosureRunId.startsWith("candidate_")
  )
    errors.push("portfolio_candidate_closure_run_id_invalid");
  validateTarget(value.target, errors, "portfolio_candidate_manifest_target");
  validateScope(value.scope, errors, "portfolio_candidate_manifest_scope", expected.scope);
  validateProvenance(value.contentProvenance, errors, "portfolio_candidate_manifest_content_provenance");
  if (value.evidenceSchemaRevision !== PORTFOLIO_EVIDENCE_SCHEMA_REVISION)
    errors.push("portfolio_candidate_manifest_evidence_schema_revision_invalid");
  if (!validId(value.registryRevision)) errors.push("portfolio_candidate_manifest_registry_revision_invalid");
  validateVariant(value.variant, errors, "portfolio_candidate_variant");
  if (!Array.isArray(value.exclusions) || value.exclusions.length === 0 || !value.exclusions.every(validId))
    errors.push("portfolio_candidate_manifest_exclusions_invalid");
  if (value.variant?.variantId && !value.variant.variantId.endsWith(TOPOLOGY_SUFFIX))
    errors.push("portfolio_candidate_variant_not_topology_suffixed");
  return result(errors.length === 0, errors);
}

export function validatePortfolioDsm(value, expected = {}) {
  const errors = validateSignedArtifact(value, DSM_FIELDS, "portfolio_dsm", expected, "portfolio_dsm");
  if (!isPlainObject(value)) return result(false, errors);
  if (value.schemaVersion !== 1) errors.push("portfolio_dsm_schema_version_invalid");
  if (value.artifactKind !== "portfolio_dsm") errors.push("portfolio_dsm_artifact_kind_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_dsm_topology_invalid");
  if (value.contractKind !== "portfolio_run") errors.push("portfolio_dsm_contract_kind_invalid");
  if (!validId(value.portfolioId) || value.portfolioId !== "core_valley_milestone_portfolio_v1")
    errors.push("portfolio_dsm_portfolio_id_invalid");
  if (
    !validId(value.portfolioRunId) ||
    value.portfolioRunId.startsWith("candidate_") ||
    !value.portfolioRunId.startsWith("portfolio_")
  )
    errors.push("portfolio_dsm_run_id_invalid");
  if (value.frozen !== true) errors.push("portfolio_dsm_must_be_frozen");
  validateTarget(value.target, errors, "portfolio_dsm_target");
  validateScope(value.scope, errors, "portfolio_dsm_scope", expected.scope);
  if (value.evidenceSchemaRevision !== PORTFOLIO_EVIDENCE_SCHEMA_REVISION)
    errors.push("portfolio_dsm_evidence_schema_revision_invalid");
  if (!validId(value.registryRevision) || !validId(value.policyRevision)) errors.push("portfolio_dsm_revision_invalid");
  if (!HASH.test(value.startManifestHash ?? "")) errors.push("portfolio_dsm_start_manifest_hash_invalid");
  if (!Array.isArray(value.exclusions) || value.exclusions.length === 0 || !value.exclusions.every(validId))
    errors.push("portfolio_dsm_exclusions_invalid");
  validateDsmVariants(value.variants, errors);
  validateMilestones(value.milestones, value.variants, errors);
  validateContentScope(value.contentScope, errors);
  validateBarriers(value.barriers, value.variants, errors);
  return result(errors.length === 0, errors);
}

export function validatePortfolioCcm(value, expected = {}) {
  const errors = validateSignedArtifact(value, CCM_FIELDS, "portfolio_ccm", expected, "portfolio_ccm");
  if (!isPlainObject(value)) return result(false, errors);
  if (value.schemaVersion !== 1) errors.push("portfolio_ccm_schema_version_invalid");
  if (value.artifactKind !== "portfolio_ccm") errors.push("portfolio_ccm_artifact_kind_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_ccm_topology_invalid");
  if (value.contractKind !== "candidate_closure") errors.push("portfolio_ccm_contract_kind_invalid");
  if (!validId(value.ccmRevision)) errors.push("portfolio_ccm_revision_invalid");
  if (value.evidenceSchemaRevision !== PORTFOLIO_EVIDENCE_SCHEMA_REVISION)
    errors.push("portfolio_ccm_evidence_schema_revision_invalid");
  if (value.publicationState !== "published_for_single_player_native_companion")
    errors.push("portfolio_ccm_publication_state_invalid");
  if (!Array.isArray(value.rows) || value.rows.length === 0 || value.rows.length > 256)
    errors.push("portfolio_ccm_rows_invalid");
  else {
    const rowIds = new Set();
    const variantIds = new Set();
    const candidateRunIds = new Set();
    for (const row of value.rows) {
      validateCcmRow(row, errors, expected.scope, expected.targetVersion, expected.evidenceSchemaRevision);
      if (row?.rowId && rowIds.has(row.rowId)) errors.push("portfolio_ccm_duplicate_row_id");
      if (row?.variantId && variantIds.has(row.variantId)) errors.push("portfolio_ccm_duplicate_variant_id");
      if (row?.candidateClosureRunId && candidateRunIds.has(row.candidateClosureRunId))
        errors.push("portfolio_ccm_duplicate_candidate_closure_run_id");
      if (row?.rowId) rowIds.add(row.rowId);
      if (row?.variantId) variantIds.add(row.variantId);
      if (row?.candidateClosureRunId) candidateRunIds.add(row.candidateClosureRunId);
    }
  }
  return result(errors.length === 0, errors);
}

export function getCandidateRegistry({ manifest, signingKey }) {
  const validation = validateCandidateClosureManifest(manifest, { signingKey });
  if (!validation.valid) throw new Error(validation.errors[0] ?? "portfolio_candidate_manifest_invalid");
  return Object.freeze({
    topology: PORTFOLIO_TOPOLOGY,
    contractKind: "candidate_closure",
    candidateClosureRunId: manifest.candidateClosureRunId,
    manifestHash: manifest.manifestHash,
    variants: Object.freeze([
      Object.freeze({
        ...manifest.variant,
        domain: Object.freeze({
          ...manifest.variant.domain,
          values: Object.freeze([...manifest.variant.domain.values]),
        }),
      }),
    ]),
  });
}

export function admitCandidateRegistry({ manifest, signingKey, requestedVariantId, requestedDomainHash }) {
  const validation = validateCandidateClosureManifest(manifest, { signingKey });
  if (!validation.valid) return rejected("portfolio_candidate_registry_manifest_invalid", validation.errors);
  if (requestedVariantId !== undefined && requestedVariantId !== manifest.variant.variantId)
    return rejected("portfolio_candidate_registry_variant_not_authorized");
  if (requestedDomainHash !== undefined && requestedDomainHash !== manifest.variant.domain.valueHash)
    return rejected("portfolio_candidate_registry_domain_not_authorized");
  return Object.freeze({
    state: "ADMITTED",
    topology: PORTFOLIO_TOPOLOGY,
    contractKind: "candidate_closure",
    candidateClosureRunId: manifest.candidateClosureRunId,
    manifestHash: manifest.manifestHash,
    variantId: manifest.variant.variantId,
    domainHash: manifest.variant.domain.valueHash,
  });
}

export function getPortfolioRegistry({ dsm, ccm, dsmSigningKey, ccmSigningKey, scope }) {
  const dsmResult = validatePortfolioDsm(dsm, { signingKey: dsmSigningKey, scope });
  if (!dsmResult.valid) throw new Error(dsmResult.errors[0] ?? "portfolio_dsm_invalid");
  const ccmResult = validatePortfolioCcm(ccm, {
    signingKey: ccmSigningKey,
    scope,
    targetVersion: `${dsm.target.gameVersion}.${dsm.target.gameBuild}`,
    evidenceSchemaRevision: dsm.evidenceSchemaRevision,
  });
  if (!ccmResult.valid) throw new Error(ccmResult.errors[0] ?? "portfolio_ccm_invalid");
  const rows = new Map(ccm.rows.map((row) => [row.rowId, row]));
  const variants = [];
  for (const entry of dsm.variants) {
    const row = rows.get(entry.ccmRowId);
    if (
      !row ||
      row.variantId !== entry.variantId ||
      row.actionClass !== entry.actionClass ||
      row.status !== "closed" ||
      row.closureAttestationHash !== entry.closureAttestationHash ||
      row.domainHash !== entry.domainHash ||
      row.provenanceHash !== entry.provenanceHash ||
      row.bindingHash !== dsm.scope.bindingHash ||
      row.bindingGeneration !== dsm.scope.bindingGeneration ||
      row.targetVersion !== `${dsm.target.gameVersion}.${dsm.target.gameBuild}` ||
      row.evidenceSchemaRevision !== dsm.evidenceSchemaRevision
    ) {
      throw new Error("portfolio_dsm_ccm_variant_not_closed");
    }
    variants.push(
      Object.freeze({
        variantId: entry.variantId,
        actionClass: entry.actionClass,
        domainHash: entry.domainHash,
        ccmRowId: entry.ccmRowId,
      }),
    );
  }
  return Object.freeze({
    topology: PORTFOLIO_TOPOLOGY,
    contractKind: "portfolio_run",
    portfolioRunId: dsm.portfolioRunId,
    manifestHash: dsm.manifestHash,
    variants: Object.freeze(variants),
  });
}

export function admitPortfolioRegistry({
  dsm,
  ccm,
  dsmSigningKey,
  ccmSigningKey,
  scope,
  requestedVariantId,
  requestedDomainHash,
}) {
  if (!isPlainObject(scope)) return rejected("portfolio_registry_current_scope_required");
  try {
    const registry = getPortfolioRegistry({ dsm, ccm, dsmSigningKey, ccmSigningKey, scope });
    const variant = registry.variants.find((entry) => entry.variantId === requestedVariantId);
    if (!variant) return rejected("portfolio_registry_variant_not_closed");
    if (requestedDomainHash !== undefined && requestedDomainHash !== variant.domainHash)
      return rejected("portfolio_registry_domain_not_closed");
    return Object.freeze({
      state: "ADMITTED",
      ...registry,
      variantId: variant.variantId,
      domainHash: variant.domainHash,
    });
  } catch (error) {
    return rejected(error instanceof Error ? error.message : "portfolio_registry_invalid");
  }
}

export function validatePortfolioReceipt(value, expected = {}) {
  const errors = [];
  validateExactObject(value, RECEIPT_FIELDS, "portfolio_receipt_unknown_field", errors);
  if (!isPlainObject(value)) return result(false, errors);
  if (value.schemaVersion !== 1) errors.push("portfolio_receipt_schema_version_invalid");
  if (value.artifactKind !== "portfolio_execution_receipt") errors.push("portfolio_receipt_artifact_kind_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_receipt_topology_invalid");
  validateBindingFields(value, errors, "portfolio_receipt", expected.scope);
  if (!CONTRACT_KINDS.has(value.contractKind)) errors.push("portfolio_receipt_contract_kind_invalid");
  if (!validId(value.contractId)) errors.push("portfolio_receipt_contract_id_invalid");
  if (expected.contractKind && value.contractKind !== expected.contractKind)
    errors.push("portfolio_receipt_contract_kind_mismatch");
  if (expected.contractId && value.contractId !== expected.contractId)
    errors.push("portfolio_receipt_contract_id_mismatch");
  if (!HASH.test(value.manifestHash ?? "")) errors.push("portfolio_receipt_manifest_hash_invalid");
  if (value.contractKind === "portfolio_run" && !value.contractId.startsWith("portfolio_"))
    errors.push("portfolio_receipt_portfolio_run_id_invalid");
  if (value.contractKind === "candidate_closure" && !value.contractId.startsWith("candidate_"))
    errors.push("portfolio_candidate_receipt_contract_id_invalid");
  if (value.evidenceSchemaRevision !== PORTFOLIO_EVIDENCE_SCHEMA_REVISION)
    errors.push("portfolio_receipt_evidence_schema_revision_invalid");
  if (expected.manifestHash && value.manifestHash !== expected.manifestHash)
    errors.push("portfolio_receipt_manifest_hash_mismatch");
  if (
    value.contractKind === "candidate_closure" &&
    (!expected.candidateManifestHash || value.manifestHash !== expected.candidateManifestHash)
  )
    errors.push("portfolio_candidate_receipt_manifest_kind_mismatch");
  if (!validId(value.requestId) || !validId(value.executionId) || !HASH.test(value.requestFingerprint ?? ""))
    errors.push("portfolio_receipt_execution_identity_invalid");
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) errors.push("portfolio_receipt_revision_invalid");
  if (!validVariantId(value.actionVariant)) errors.push("portfolio_receipt_action_variant_invalid");
  if (!EXECUTION_STATES.has(value.state)) errors.push("portfolio_receipt_state_invalid");
  if (value.state === "authoritatively_completed") errors.push("portfolio_receipt_authoritative_projection_forbidden");
  if (!validReason(value.reasonCode)) errors.push("portfolio_receipt_reason_invalid");
  validateEvidence(value.evidence, errors, value.executionId);
  return result(errors.length === 0, errors);
}

export function validatePortfolioCheckpoint(value, expected = {}) {
  const errors = [];
  validateExactObject(value, CHECKPOINT_FIELDS, "portfolio_checkpoint_unknown_field", errors);
  if (!isPlainObject(value)) return result(false, errors);
  const receiptValue = { ...value, artifactKind: "portfolio_execution_receipt" };
  delete receiptValue.checkpointId;
  delete receiptValue.monitorId;
  const receiptResult = validatePortfolioReceipt(receiptValue, expected);
  errors.push(...receiptResult.errors.filter((error) => error !== "portfolio_receipt_unknown_field"));
  if (value.artifactKind !== "portfolio_checkpoint") errors.push("portfolio_checkpoint_artifact_kind_invalid");
  if (value.contractKind !== "portfolio_run") errors.push("portfolio_checkpoint_contract_kind_invalid");
  if (!validId(value.checkpointId)) errors.push("portfolio_checkpoint_id_invalid");
  if (!validId(value.monitorId) || ![...PORTFOLIO_MILESTONE_MONITORS.values()].includes(value.monitorId))
    errors.push("portfolio_checkpoint_monitor_invalid");
  return result(errors.length === 0, errors);
}

export function evaluateAuthoritativeCompletion({ receipt, postcondition }) {
  if (receipt?.contractKind === "candidate_closure")
    return rejected("portfolio_authoritative_completion_candidate_receipt_forbidden");
  const completion = evaluateReceiptPostcondition({
    receipt,
    postcondition,
    receiptExpectation: { contractKind: "portfolio_run" },
  });
  if (completion.state !== "ADMITTED") return rejected(completion.reasonCode, completion.details);
  return Object.freeze({ state: "authoritatively_completed", reasonCode: "action_postcondition_verified" });
}

export function evaluatePortfolioMonitorInput({ receipt, postcondition, receiptExpectation = {} }) {
  if (receipt?.contractKind === "candidate_closure") return rejected("portfolio_monitor_candidate_receipt_forbidden");
  const completion = evaluateReceiptPostcondition({ receipt, postcondition, receiptExpectation });
  if (completion.state !== "ADMITTED") return rejected(completion.reasonCode, completion.details);
  return Object.freeze({ state: "ADMITTED", reasonCode: "portfolio_monitor_input_admitted" });
}

function evaluateReceiptPostcondition({ receipt, postcondition, receiptExpectation = {} }) {
  const receiptResult = validatePortfolioReceipt(receipt, receiptExpectation);
  if (!receiptResult.valid) return rejected("portfolio_monitor_receipt_invalid", receiptResult.errors);
  if (receipt.state !== TERMINAL_SUCCESS) return rejected("portfolio_monitor_receipt_not_succeeded");
  if (!isPlainObject(receipt.evidence)) return rejected("portfolio_monitor_evidence_missing");
  const postconditionResult = validateFreshPortfolioPostcondition(postcondition, receipt);
  if (!postconditionResult.valid)
    return rejected("portfolio_monitor_postcondition_missing_or_mismatched", postconditionResult.errors);
  return Object.freeze({ state: "ADMITTED", reasonCode: "portfolio_monitor_input_admitted" });
}

export function admitCandidateClosureReceipt({ manifest, signingKey, receipt, postcondition }) {
  const manifestResult = validateCandidateClosureManifest(manifest, { signingKey });
  if (!manifestResult.valid) return rejected("portfolio_candidate_manifest_invalid", manifestResult.errors);
  const receiptResult = validatePortfolioReceipt(receipt, {
    contractKind: "candidate_closure",
    contractId: manifest.candidateClosureRunId,
    manifestHash: manifest.manifestHash,
    candidateManifestHash: manifest.manifestHash,
    scope: manifest.scope,
  });
  if (!receiptResult.valid)
    return rejected(receiptResult.errors[0] ?? "portfolio_candidate_receipt_invalid", receiptResult.errors);
  if (receipt.actionVariant !== manifest.variant.variantId)
    return rejected("portfolio_candidate_receipt_variant_mismatch");
  const completion = evaluateReceiptPostcondition({
    receipt,
    postcondition,
    receiptExpectation: {
      contractKind: "candidate_closure",
      contractId: manifest.candidateClosureRunId,
      manifestHash: manifest.manifestHash,
      candidateManifestHash: manifest.manifestHash,
      scope: manifest.scope,
    },
  });
  if (completion.state !== "ADMITTED") return rejected(completion.reasonCode, completion.details);
  return Object.freeze({
    state: "ADMITTED",
    contractKind: "candidate_closure",
    candidateClosureRunId: manifest.candidateClosureRunId,
    variantId: manifest.variant.variantId,
    executionId: receipt.executionId,
  });
}

export function admitPortfolioCheckpoint({ dsm, checkpoint, dsmSigningKey, currentScope }) {
  if (!isPlainObject(currentScope)) return rejected("portfolio_checkpoint_current_scope_required");
  const expectedScope = currentScope;
  const dsmResult = validatePortfolioDsm(dsm, { signingKey: dsmSigningKey, scope: expectedScope });
  if (!dsmResult.valid) return rejected("portfolio_checkpoint_dsm_invalid", dsmResult.errors);
  const checkpointResult = validatePortfolioCheckpoint(checkpoint, {
    contractKind: "portfolio_run",
    contractId: dsm.portfolioRunId,
    manifestHash: dsm.manifestHash,
    scope: expectedScope,
  });
  if (!checkpointResult.valid)
    return rejected(checkpointResult.errors[0] ?? "portfolio_checkpoint_invalid", checkpointResult.errors);
  const milestone = dsm.milestones.find((entry) => entry.monitorId === checkpoint.monitorId);
  if (!milestone) return rejected("portfolio_checkpoint_monitor_not_in_dsm");
  if (!milestone.requiredVariantIds.includes(checkpoint.actionVariant))
    return rejected("portfolio_checkpoint_variant_not_required");
  return Object.freeze({
    state: "ADMITTED",
    contractKind: "portfolio_run",
    portfolioRunId: dsm.portfolioRunId,
    checkpointId: checkpoint.checkpointId,
    monitorId: checkpoint.monitorId,
  });
}

export function admitPortfolioMonitorReceipt({
  milestoneId,
  dsm,
  ccm,
  dsmSigningKey,
  ccmSigningKey,
  receipt,
  postcondition,
  observation,
  currentScope,
}) {
  if (receipt?.contractKind === "candidate_closure") return rejected("portfolio_monitor_candidate_receipt_forbidden");
  if (!isPlainObject(currentScope)) return rejected("portfolio_monitor_current_scope_required");
  const expectedScope = currentScope;
  const dsmResult = validatePortfolioDsm(dsm, { signingKey: dsmSigningKey, scope: expectedScope });
  if (!dsmResult.valid) return rejected("portfolio_monitor_dsm_invalid", dsmResult.errors);
  const ccmResult = validatePortfolioCcm(ccm, {
    signingKey: ccmSigningKey,
    scope: expectedScope,
    targetVersion: `${dsm.target.gameVersion}.${dsm.target.gameBuild}`,
    evidenceSchemaRevision: dsm.evidenceSchemaRevision,
  });
  if (!ccmResult.valid) return rejected("portfolio_monitor_ccm_invalid", ccmResult.errors);
  const expected = {
    contractKind: "portfolio_run",
    contractId: dsm.portfolioRunId,
    manifestHash: dsm.manifestHash,
    scope: expectedScope,
  };
  const receiptResult = validatePortfolioReceipt(receipt, expected);
  if (!receiptResult.valid)
    return rejected(receiptResult.errors[0] ?? "portfolio_monitor_receipt_invalid", receiptResult.errors);
  const milestone = dsm.milestones.find((entry) => entry.id === milestoneId);
  if (!milestone) return rejected("portfolio_monitor_unknown_milestone");
  if (!milestone.requiredVariantIds.includes(receipt.actionVariant))
    return rejected("portfolio_monitor_variant_not_required");
  const registry = getPortfolioRegistry({ dsm, ccm, dsmSigningKey, ccmSigningKey, scope: expectedScope });
  if (!registry.variants.some((entry) => entry.variantId === receipt.actionVariant))
    return rejected("portfolio_monitor_variant_not_ccm_closed");
  const completion = evaluateReceiptPostcondition({ receipt, postcondition, receiptExpectation: expected });
  if (completion.state !== "ADMITTED") return rejected(completion.reasonCode, completion.details);
  const observationResult = validateFreshPortfolioObservation(observation, receipt);
  if (!observationResult.valid)
    return rejected(observationResult.errors[0] ?? "portfolio_monitor_observation_invalid", observationResult.errors);
  return Object.freeze({
    state: "ACCEPTED",
    reasonCode: "portfolio_monitor_receipt_admitted",
    milestoneId,
    monitorId: milestone.monitorId,
    executionId: receipt.executionId,
    revision: observation.revision,
  });
}

export async function createPortfolioExecutionLedger(options) {
  const context = validateLedgerOptions(options);
  const namespace = context.contractKind === "candidate_closure" ? "candidate-closure" : "portfolio-run";
  const runPath = resolve(context.dataRoot, namespace, context.contractId);
  const identityPath = resolve(
    runPath,
    `${context.manifestHash}__g${context.scope.bindingGeneration}__${context.scope.bindingHash}`,
  );
  if (identityPath !== runPath && !identityPath.startsWith(`${runPath}${process.platform === "win32" ? "\\" : "/"}`))
    throw new Error("portfolio_ledger_path_escape");
  const metadata = {
    schemaVersion: 1,
    artifactKind: "portfolio_ledger_metadata",
    topology: PORTFOLIO_TOPOLOGY,
    contractKind: context.contractKind,
    contractId: context.contractId,
    manifestHash: context.manifestHash,
    bindingHash: context.scope.bindingHash,
    bindingGeneration: context.scope.bindingGeneration,
    variantId: context.variantId ?? null,
  };
  await mkdir(runPath, { recursive: true });
  const runMetadataPath = join(runPath, "ledger.json");
  try {
    const previous = JSON.parse(await readFile(runMetadataPath, "utf8"));
    if (
      previous?.schemaVersion !== 1 ||
      previous?.topology !== PORTFOLIO_TOPOLOGY ||
      previous?.contractKind !== context.contractKind ||
      previous?.contractId !== context.contractId ||
      previous?.manifestHash !== context.manifestHash ||
      previous?.bindingHash !== context.scope.bindingHash ||
      previous?.bindingGeneration !== context.scope.bindingGeneration
    ) {
      throw new Error("portfolio_ledger_binding_stale");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWriteJson(runMetadataPath, metadata);
  }
  await mkdir(join(identityPath, "receipts"), { recursive: true });
  await mkdir(join(identityPath, "checkpoints"), { recursive: true });
  const metadataPath = join(identityPath, "ledger.json");
  try {
    const previous = JSON.parse(await readFile(metadataPath, "utf8"));
    if (canonicalJson(previous) !== canonicalJson(metadata)) throw new Error("portfolio_ledger_identity_conflict");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWriteJson(metadataPath, metadata);
  }
  return Object.freeze({
    topology: PORTFOLIO_TOPOLOGY,
    contractKind: context.contractKind,
    contractId: context.contractId,
    manifestHash: context.manifestHash,
    namespacePath: identityPath,
    appendReceipt: (value) => appendLedgerArtifact(identityPath, "receipts", "receipt", value, context),
    writeCheckpoint: (value) => appendLedgerArtifact(identityPath, "checkpoints", "checkpoint", value, context),
    readReceipt: (requestId) => readLedgerArtifact(identityPath, "receipts", requestId),
    readCheckpoint: (checkpointId) => readLedgerArtifact(identityPath, "checkpoints", checkpointId),
  });
}

export function createPortfolioContractEnvelope(
  type,
  contract,
  payload,
  messageId = randomUUID(),
  timestampMs = Date.now(),
) {
  if (!CONTRACT_TYPES.has(type)) throw new Error("portfolio_contract_type_invalid");
  if (!isPlainObject(contract) || !isPlainObject(payload)) throw new Error("portfolio_contract_envelope_input_invalid");
  return Object.freeze({
    protocolVersion: PORTFOLIO_CONTRACT_PROTOCOL_VERSION,
    messageId,
    correlationId: randomUUID(),
    timestampMs,
    type,
    contract: { ...contract },
    payload: { ...payload },
  });
}

export function validatePortfolioContractEnvelope(value, expected = {}, nowMs = Date.now()) {
  const errors = [];
  validateExactObject(
    value,
    ["protocolVersion", "messageId", "correlationId", "timestampMs", "type", "contract", "payload"],
    "portfolio_contract_unknown_field",
    errors,
  );
  if (!isPlainObject(value)) return result(false, errors);
  if (value.protocolVersion !== PORTFOLIO_CONTRACT_PROTOCOL_VERSION)
    errors.push("portfolio_contract_protocol_version_invalid");
  if (!validId(value.messageId) || !validId(value.correlationId))
    errors.push("portfolio_contract_message_identity_invalid");
  if (!Number.isSafeInteger(value.timestampMs) || Math.abs(nowMs - value.timestampMs) > 5 * 60_000)
    errors.push("portfolio_contract_timestamp_invalid");
  if (!CONTRACT_TYPES.has(value.type)) errors.push("portfolio_contract_type_rejected");
  const contract = value.contract;
  validateContractIdentity(contract, errors, expected);
  if (isPlainObject(contract) && typeof value.type === "string") {
    const expectedKind = value.type.startsWith("candidate_")
      ? "candidate_closure"
      : value.type.startsWith("portfolio_")
        ? "portfolio_run"
        : null;
    if (expectedKind !== contract.contractKind) errors.push("portfolio_contract_type_kind_mismatch");
  }
  validateContractPayload(value.type, value.payload, errors);
  return result(errors.length === 0, errors);
}

function signArtifact(value, artifactKind, signingKey) {
  if (!isPlainObject(value) || typeof signingKey !== "string" || signingKey.length < 16)
    throw new Error("portfolio_contract_signing_key_invalid");
  const unsigned = { ...value, artifactKind };
  delete unsigned.manifestHash;
  delete unsigned.signature;
  delete unsigned.signatureAlgorithm;
  const manifestHash = hashPortfolioCanonicalJson(unsigned);
  const signature = createHmac("sha256", signingKey).update(canonicalJson(unsigned), "utf8").digest("hex");
  return Object.freeze({ ...unsigned, manifestHash, signatureAlgorithm: SIGNATURE_ALGORITHM, signature });
}

function validateSignedArtifact(value, allowedFields, prefix, expected, artifactKind) {
  const errors = [];
  validateExactObject(value, allowedFields, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) return errors;
  if (value.artifactKind !== artifactKind) errors.push(`${prefix}_artifact_kind_invalid`);
  if (!HASH.test(value.manifestHash ?? "")) errors.push(`${prefix}_manifest_hash_invalid`);
  else {
    const unsigned = stripSignature(value);
    if (hashPortfolioCanonicalJson(unsigned) !== value.manifestHash) errors.push("portfolio_manifest_hash_mismatch");
  }
  if (value.signatureAlgorithm !== SIGNATURE_ALGORITHM) errors.push(`${prefix}_signature_algorithm_invalid`);
  if (!HASH.test(value.signature ?? "")) errors.push(`${prefix}_signature_invalid`);
  if (typeof expected.signingKey === "string") {
    if (value.signature !== signArtifact(value, artifactKind, expected.signingKey).signature)
      errors.push(`${prefix}_signature_mismatch`);
  }
  return errors;
}

function stripSignature(value) {
  const unsigned = { ...value };
  delete unsigned.manifestHash;
  delete unsigned.signature;
  delete unsigned.signatureAlgorithm;
  return unsigned;
}

function validateTarget(value, errors, prefix) {
  validateExactObject(value, TARGET_FIELDS, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) return;
  if (value.gameVersion !== PORTFOLIO_TARGET_VERSION || value.gameBuild !== PORTFOLIO_TARGET_BUILD_NUMBER)
    errors.push(`${prefix}_version_or_build_invalid`);
  if (value.gameSha256 !== PORTFOLIO_TARGET_GAME_SHA256 || !HASH.test(value.gameSha256))
    errors.push(`${prefix}_game_hash_invalid`);
  if (
    value.smapiVersion !== PORTFOLIO_TARGET_SMAPI_VERSION ||
    !HASH.test(value.smapiSha256) ||
    !HASH.test(value.smapiExeSha256)
  )
    errors.push(`${prefix}_smapi_identity_invalid`);
  for (const field of ["modSha256", "hostSha256"])
    if (!HASH.test(value[field] ?? "")) errors.push(`${prefix}_${field}_invalid`);
}

function validateScope(value, errors, prefix, expected) {
  validateExactObject(value, SCOPE_FIELDS, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) return;
  for (const field of ["saveId", "worldId", "localPlayerId", "companionId"])
    if (!validId(value[field])) errors.push(`${prefix}_${field}_invalid`);
  if (!Number.isSafeInteger(value.bindingGeneration) || value.bindingGeneration <= 0)
    errors.push(`${prefix}_binding_generation_invalid`);
  if (!HASH.test(value.bindingHash ?? "")) errors.push(`${prefix}_binding_hash_invalid`);
  else {
    try {
      if (value.bindingHash !== computePortfolioBindingHash(value)) errors.push(`${prefix}_binding_hash_mismatch`);
    } catch {
      errors.push(`${prefix}_binding_hash_mismatch`);
    }
  }
  if (isPlainObject(expected)) {
    for (const field of SCOPE_FIELDS) if (value[field] !== expected[field]) errors.push(`${prefix}_${field}_mismatch`);
  }
}

function validateProvenance(value, errors, prefix) {
  validateExactObject(value, PROVENANCE_FIELDS, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) return;
  if (value.sourceKind !== "target_version_native" || value.sourceRevision !== PORTFOLIO_TARGET_VERSION)
    errors.push(`${prefix}_source_invalid`);
  if (!HASH.test(value.nativeSourceSha256 ?? "") || !HASH.test(value.contentManifestSha256 ?? ""))
    errors.push(`${prefix}_hash_invalid`);
}

function validateVariant(value, errors, prefix) {
  validateExactObject(value, VARIANT_FIELDS, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) return;
  if (!validVariantId(value.variantId)) errors.push(`${prefix}_id_invalid`);
  if (!ACTION_CLASSES.has(value.actionClass)) errors.push(`${prefix}_class_invalid`);
  if (!validId(value.contractRevision)) errors.push(`${prefix}_revision_invalid`);
  validateDomain(value.domain, errors, `${prefix}_domain`);
}

function validateDomain(value, errors, prefix) {
  validateExactObject(value, DOMAIN_FIELDS, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) return;
  if (
    value.kind !== "finite" ||
    !validId(value.domainId) ||
    !Array.isArray(value.values) ||
    value.values.length < 1 ||
    value.values.length > 256
  )
    errors.push(`${prefix}_invalid`);
  if (Array.isArray(value.values) && hashPortfolioCanonicalJson(value.values) !== value.valueHash)
    errors.push(`${prefix}_hash_mismatch`);
}

function validateDsmVariants(value, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    errors.push("portfolio_dsm_variants_invalid");
    return;
  }
  const ids = new Set();
  for (const entry of value) {
    validateExactObject(entry, DSM_VARIANT_FIELDS, "portfolio_dsm_variant_unknown_field", errors);
    if (!isPlainObject(entry)) continue;
    if (!validVariantId(entry.variantId) || ids.has(entry.variantId))
      errors.push("portfolio_dsm_variant_identity_invalid");
    ids.add(entry.variantId);
    if (!ACTION_CLASSES.has(entry.actionClass)) errors.push("portfolio_dsm_variant_class_invalid");
    if (
      !HASH.test(entry.domainHash ?? "") ||
      !HASH.test(entry.provenanceHash ?? "") ||
      !validId(entry.ccmRowId) ||
      !HASH.test(entry.closureAttestationHash ?? "")
    )
      errors.push("portfolio_dsm_variant_attestation_invalid");
  }
}

function validateMilestones(value, variants, errors) {
  if (!Array.isArray(value) || value.length !== 10) {
    errors.push("portfolio_dsm_milestones_incomplete");
    return;
  }
  const ids = new Set();
  const variantIds = new Set((variants ?? []).map((entry) => entry?.variantId));
  for (const entry of value) {
    validateExactObject(entry, MILESTONE_FIELDS, "portfolio_dsm_milestone_unknown_field", errors);
    if (!isPlainObject(entry)) continue;
    if (!PORTFOLIO_MILESTONE_MONITORS.has(entry.id) || ids.has(entry.id))
      errors.push("portfolio_dsm_milestone_identity_invalid");
    ids.add(entry.id);
    if (entry.monitorId !== PORTFOLIO_MILESTONE_MONITORS.get(entry.id))
      errors.push("portfolio_dsm_milestone_monitor_invalid");
    if (
      !Array.isArray(entry.requiredVariantIds) ||
      entry.requiredVariantIds.length === 0 ||
      entry.requiredVariantIds.some((id) => !variantIds.has(id))
    )
      errors.push("portfolio_dsm_milestone_variant_reference_invalid");
  }
  if (ids.size !== 10 || [...PORTFOLIO_MILESTONE_MONITORS.keys()].some((id) => !ids.has(id)))
    errors.push("portfolio_dsm_milestones_incomplete");
}

function validateContentScope(value, errors) {
  validateExactObject(value, CONTENT_SCOPE_FIELDS, "portfolio_dsm_content_scope_unknown_field", errors);
  if (!isPlainObject(value)) return;
  validateSimpleRecord(value.bundle, BUNDLE_SCOPE_FIELDS, "portfolio_dsm_bundle_scope", errors);
  if (isPlainObject(value.bundle)) {
    if (
      !validContentId(value.bundle.slotId) ||
      !Array.isArray(value.bundle.acceptedItemIds) ||
      value.bundle.acceptedItemIds.length === 0 ||
      !value.bundle.acceptedItemIds.every(validContentId) ||
      !validContentId(value.bundle.rewardId)
    )
      errors.push("portfolio_dsm_bundle_scope_invalid");
  }
  validateSimpleRecord(value.mine, MINE_SCOPE_FIELDS, "portfolio_dsm_mine_scope", errors);
  if (
    isPlainObject(value.mine) &&
    (!validId(value.mine.routeId) || !Number.isSafeInteger(value.mine.targetFloor) || value.mine.targetFloor < 1)
  )
    errors.push("portfolio_dsm_mine_scope_invalid");
  validateSimpleRecord(value.specialOrder, ORDER_SCOPE_FIELDS, "portfolio_dsm_order_scope", errors);
  if (
    isPlainObject(value.specialOrder) &&
    (!validId(value.specialOrder.orderId) ||
      !Array.isArray(value.specialOrder.objectiveIds) ||
      value.specialOrder.objectiveIds.length === 0 ||
      !value.specialOrder.objectiveIds.every(validId) ||
      !validId(value.specialOrder.rewardId))
  )
    errors.push("portfolio_dsm_order_scope_invalid");
  validateSimpleRecord(value.museum, MUSEUM_SCOPE_FIELDS, "portfolio_dsm_museum_scope", errors);
  if (
    isPlainObject(value.museum) &&
    (!Array.isArray(value.museum.pieceIds) ||
      value.museum.pieceIds.length === 0 ||
      !value.museum.pieceIds.every(validContentId) ||
      !HASH.test(value.museum.pieceSetHash ?? "") ||
      !validContentId(value.museum.rewardId))
  )
    errors.push("portfolio_dsm_museum_scope_invalid");
}

function validateBarriers(value, variants, errors) {
  validateSimpleRecord(value, BARRIER_FIELDS, "portfolio_dsm_barriers", errors);
  const ids = new Set((variants ?? []).map((entry) => entry?.variantId));
  if (!isPlainObject(value) || !ids.has(value.sleepVariantId) || value.saveReopenRequired !== true)
    errors.push("portfolio_dsm_barriers_invalid");
}

function validateSimpleRecord(value, fields, prefix, errors) {
  validateExactObject(value, fields, `${prefix}_unknown_field`, errors);
  if (!isPlainObject(value)) errors.push(`${prefix}_invalid`);
}

function validateCcmRow(value, errors, expectedScope, expectedTargetVersion, expectedEvidenceSchemaRevision) {
  validateExactObject(value, CCM_ROW_FIELDS, "portfolio_ccm_unknown_row_field", errors);
  if (!isPlainObject(value)) return;
  if (
    !validId(value.rowId) ||
    !validVariantId(value.variantId) ||
    !validId(value.candidateClosureRunId) ||
    !value.candidateClosureRunId.startsWith("candidate_")
  )
    errors.push("portfolio_ccm_row_identity_invalid");
  if (value.topology !== PORTFOLIO_TOPOLOGY) errors.push("portfolio_ccm_row_topology_invalid");
  if (
    !HASH.test(value.candidateManifestHash ?? "") ||
    !HASH.test(value.bindingHash ?? "") ||
    !HASH.test(value.closureAttestationHash ?? "")
  )
    errors.push("portfolio_ccm_row_hash_invalid");
  if (
    isPlainObject(expectedScope) &&
    (value.bindingHash !== expectedScope.bindingHash || value.bindingGeneration !== expectedScope.bindingGeneration)
  )
    errors.push("portfolio_ccm_row_binding_scope_mismatch");
  if (!Number.isSafeInteger(value.bindingGeneration) || value.bindingGeneration <= 0)
    errors.push("portfolio_ccm_row_binding_invalid");
  if (
    value.targetVersion !== `${PORTFOLIO_TARGET_VERSION}.${PORTFOLIO_TARGET_BUILD_NUMBER}` ||
    value.evidenceSchemaRevision !== PORTFOLIO_EVIDENCE_SCHEMA_REVISION
  )
    errors.push("portfolio_ccm_row_version_or_schema_invalid");
  if (typeof expectedTargetVersion === "string" && value.targetVersion !== expectedTargetVersion)
    errors.push("portfolio_ccm_row_target_version_mismatch");
  if (expectedEvidenceSchemaRevision !== undefined && value.evidenceSchemaRevision !== expectedEvidenceSchemaRevision)
    errors.push("portfolio_ccm_row_evidence_schema_mismatch");
  if (!HASH.test(value.domainHash ?? "") || !HASH.test(value.provenanceHash ?? ""))
    errors.push("portfolio_ccm_row_attestation_hash_invalid");
  if (!ACTION_CLASSES.has(value.actionClass)) errors.push("portfolio_ccm_row_class_invalid");
  for (const gate of ["status", "contractGate", "deterministicGate", "liveGate", "recoveryGate"]) {
    const expected = gate === "status" ? "closed" : "PASS";
    if (value[gate] !== expected) errors.push(`portfolio_ccm_row_${gate}_not_closed`);
  }
}

function validateBindingFields(value, errors, prefix, expectedScope) {
  if (
    !HASH.test(value.bindingHash ?? "") ||
    !Number.isSafeInteger(value.bindingGeneration) ||
    value.bindingGeneration <= 0
  )
    errors.push(`${prefix}_binding_invalid`);
  if (
    isPlainObject(expectedScope) &&
    (value.bindingHash !== expectedScope.bindingHash || value.bindingGeneration !== expectedScope.bindingGeneration)
  )
    errors.push(`${prefix}_binding_mismatch`);
}

function validateEvidence(value, errors, executionId) {
  if (value === null) return;
  if (!isPlainObject(value)) {
    errors.push("portfolio_receipt_evidence_invalid");
    return;
  }
  const allowed = ["schemaRevision", "executionId", "evidenceHash"];
  validateExactObject(value, allowed, "portfolio_receipt_evidence_unknown_field", errors);
  if (
    value.schemaRevision !== PORTFOLIO_EVIDENCE_SCHEMA_REVISION ||
    value.executionId !== executionId ||
    !HASH.test(value.evidenceHash ?? "")
  )
    errors.push("portfolio_receipt_evidence_invalid");
}

function validateFreshPortfolioPostcondition(value, receipt) {
  const errors = [];
  const fields = [
    "schemaVersion",
    "topology",
    "bindingHash",
    "bindingGeneration",
    "executionId",
    "actionVariant",
    "observedAfterReceipt",
    "observedRevision",
    "provenance",
    "postconditionHash",
  ];
  validateExactObject(value, fields, "portfolio_postcondition_unknown_field", errors);
  if (!isPlainObject(value)) return result(false, errors);
  if (
    value.schemaVersion !== 1 ||
    value.topology !== PORTFOLIO_TOPOLOGY ||
    value.bindingHash !== receipt.bindingHash ||
    value.bindingGeneration !== receipt.bindingGeneration
  )
    errors.push("portfolio_postcondition_scope_invalid");
  if (
    value.executionId !== receipt.executionId ||
    value.actionVariant !== receipt.actionVariant ||
    value.observedAfterReceipt !== true
  )
    errors.push("portfolio_postcondition_execution_mismatch");
  if (!Number.isSafeInteger(value.observedRevision) || value.observedRevision < receipt.revision)
    errors.push("portfolio_postcondition_revision_stale");
  if (value.provenance !== "target_version_native_field_adapter" || !HASH.test(value.postconditionHash ?? ""))
    errors.push("portfolio_postcondition_provenance_invalid");
  return result(errors.length === 0, errors);
}

function validateFreshPortfolioObservation(value, receipt) {
  const errors = [];
  const fields = [
    "schemaVersion",
    "topology",
    "bindingHash",
    "bindingGeneration",
    "revision",
    "capturedAfterExecutionId",
    "provenance",
    "sourceField",
    "fields",
  ];
  validateExactObject(value, fields, "portfolio_monitor_observation_unknown_field", errors);
  if (!isPlainObject(value)) return result(false, errors);
  if (
    value.schemaVersion !== 1 ||
    value.topology !== PORTFOLIO_TOPOLOGY ||
    value.bindingHash !== receipt.bindingHash ||
    value.bindingGeneration !== receipt.bindingGeneration
  )
    errors.push("portfolio_monitor_observation_scope_invalid");
  if (!Number.isSafeInteger(value.revision) || value.revision < receipt.revision)
    errors.push("portfolio_monitor_observation_revision_stale");
  if (value.capturedAfterExecutionId !== receipt.executionId)
    errors.push("portfolio_monitor_observation_not_after_receipt");
  if (
    value.provenance !== "target_version_native_field_adapter" ||
    !/^[A-Za-z][A-Za-z0-9_.[\]-]{0,127}$/.test(value.sourceField ?? "") ||
    !isPlainObject(value.fields)
  )
    errors.push("portfolio_monitor_observation_provenance_invalid");
  return result(errors.length === 0, errors);
}

function validateContractIdentity(value, errors, expected) {
  const fields = ["topology", "contractKind", "contractId", "manifestHash", "bindingHash", "bindingGeneration"];
  validateExactObject(value, fields, "portfolio_contract_identity_unknown_field", errors);
  if (!isPlainObject(value)) return;
  if (
    value.topology !== PORTFOLIO_TOPOLOGY ||
    !CONTRACT_KINDS.has(value.contractKind) ||
    !validId(value.contractId) ||
    !HASH.test(value.manifestHash ?? "") ||
    !HASH.test(value.bindingHash ?? "") ||
    !Number.isSafeInteger(value.bindingGeneration) ||
    value.bindingGeneration <= 0
  )
    errors.push("portfolio_contract_identity_invalid");
  if (value.contractKind === "candidate_closure" && !value.contractId.startsWith("candidate_"))
    errors.push("portfolio_contract_identity_candidate_run_id_invalid");
  if (value.contractKind === "portfolio_run" && !value.contractId.startsWith("portfolio_"))
    errors.push("portfolio_contract_identity_portfolio_run_id_invalid");
  if (
    expected.contractKind &&
    (value.contractKind !== expected.contractKind ||
      value.contractId !== expected.contractId ||
      value.manifestHash !== expected.manifestHash)
  )
    errors.push("portfolio_contract_identity_mismatch");
  if (
    expected.scope &&
    (value.bindingHash !== expected.scope.bindingHash || value.bindingGeneration !== expected.scope.bindingGeneration)
  )
    errors.push("portfolio_contract_identity_scope_mismatch");
}

function validateContractPayload(type, value, errors) {
  if (!isPlainObject(value)) {
    errors.push("portfolio_contract_payload_invalid");
    return;
  }
  if (type.endsWith("execution_request")) {
    validateExactObject(
      value,
      ["actionVariant", "target", "deadlineMs", "idempotencyKey"],
      "portfolio_contract_execution_payload_unknown_field",
      errors,
    );
    if (
      !validVariantId(value.actionVariant) ||
      !isPlainObject(value.target) ||
      !Number.isSafeInteger(value.deadlineMs) ||
      value.deadlineMs <= Date.now() ||
      !validId(value.idempotencyKey)
    )
      errors.push("portfolio_contract_execution_payload_invalid");
  } else if (type.endsWith("cancel_request")) {
    validateExactObject(
      value,
      ["executionId", "idempotencyKey"],
      "portfolio_contract_cancel_payload_unknown_field",
      errors,
    );
    if (!validId(value.executionId) || !validId(value.idempotencyKey))
      errors.push("portfolio_contract_cancel_payload_invalid");
  } else if (type.endsWith("checkpoint_request")) {
    validateExactObject(
      value,
      ["checkpointId", "monitorId", "idempotencyKey"],
      "portfolio_contract_checkpoint_payload_unknown_field",
      errors,
    );
    if (
      !validId(value.checkpointId) ||
      ![...PORTFOLIO_MILESTONE_MONITORS.values()].includes(value.monitorId) ||
      !validId(value.idempotencyKey)
    )
      errors.push("portfolio_contract_checkpoint_payload_invalid");
  }
  if (type.startsWith("candidate_") && type.endsWith("checkpoint_request"))
    errors.push("portfolio_candidate_checkpoint_request_forbidden");
}

function validateLedgerOptions(options) {
  if (
    !isPlainObject(options) ||
    !isAbsolute(options.dataRoot) ||
    !CONTRACT_KINDS.has(options.contractKind) ||
    !validId(options.contractId) ||
    !HASH.test(options.manifestHash ?? "") ||
    !isPlainObject(options.scope)
  )
    throw new Error("portfolio_ledger_options_invalid");
  if (options.contractKind === "candidate_closure" && !options.contractId.startsWith("candidate_"))
    throw new Error("portfolio_candidate_ledger_contract_id_invalid");
  if (options.contractKind === "portfolio_run" && !options.contractId.startsWith("portfolio_"))
    throw new Error("portfolio_run_ledger_contract_id_invalid");
  const scopeErrors = [];
  validateScope(options.scope, scopeErrors, "portfolio_ledger_scope");
  if (scopeErrors.length > 0) throw new Error(scopeErrors[0]);
  if (options.contractKind === "candidate_closure" && !validVariantId(options.variantId ?? ""))
    throw new Error("portfolio_candidate_ledger_variant_required");
  if (options.contractKind === "portfolio_run" && options.variantId !== undefined)
    throw new Error("portfolio_run_ledger_variant_forbidden");
  return {
    dataRoot: resolve(options.dataRoot),
    contractKind: options.contractKind,
    contractId: options.contractId,
    manifestHash: options.manifestHash,
    scope: options.scope,
    variantId: options.variantId,
  };
}

async function appendLedgerArtifact(namespacePath, directory, kind, value, context) {
  const expected = {
    contractKind: context.contractKind,
    contractId: context.contractId,
    manifestHash: context.manifestHash,
    scope: context.scope,
    candidateManifestHash: context.contractKind === "candidate_closure" ? context.manifestHash : undefined,
  };
  if (value?.contractKind !== context.contractKind) throw new Error("portfolio_receipt_contract_kind_mismatch");
  if (kind === "receipt" && context.contractKind === "candidate_closure" && value.actionVariant !== context.variantId)
    throw new Error("portfolio_candidate_ledger_variant_mismatch");
  const validation =
    kind === "receipt" ? validatePortfolioReceipt(value, expected) : validatePortfolioCheckpoint(value, expected);
  if (!validation.valid)
    throw new Error(
      validation.errors.find((error) => error.endsWith("contract_kind_mismatch")) ??
        validation.errors[0] ??
        `portfolio_${kind}_invalid`,
    );
  const id = kind === "receipt" ? value.requestId : value.checkpointId;
  const path = join(namespacePath, directory, `${id}.json`);
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (canonicalJson(previous) === canonicalJson(value)) return Object.freeze({ state: "replayed", path });
    throw new Error(`portfolio_${kind}_replay_conflict`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await atomicWriteJson(path, value);
    return Object.freeze({ state: "written", path });
  }
}

async function readLedgerArtifact(namespacePath, directory, id) {
  if (!validId(id)) throw new Error("portfolio_ledger_read_id_invalid");
  try {
    return JSON.parse(await readFile(join(namespacePath, directory, `${id}.json`), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, path);
}

function validVariantId(value) {
  return validId(value) && value.endsWith(TOPOLOGY_SUFFIX);
}
function validContentId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_()\-.:]{1,128}$/.test(value);
}
function validId(value) {
  return typeof value === "string" && ID.test(value);
}
function validReason(value) {
  return typeof value === "string" && /^[a-z0-9_:-]{1,128}$/.test(value);
}
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validateExactObject(value, fields, reason, errors) {
  if (!isPlainObject(value)) {
    errors.push(`${reason.replace(/_unknown_field$/, "")}_invalid_shape`);
    return;
  }
  const allowed = new Set(fields);
  if (Object.keys(value).some((key) => !allowed.has(key))) errors.push(reason);
}
function result(valid, errors) {
  return Object.freeze({ valid, errors: Object.freeze([...new Set(errors)].sort()) });
}
function rejected(reasonCode, details = undefined) {
  return Object.freeze({ state: "REJECTED", reasonCode, ...(details ? { details: Object.freeze([...details]) } : {}) });
}
