import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  admitCandidateClosureReceipt,
  admitCandidateRegistry,
  admitPortfolioCheckpoint,
  admitPortfolioMonitorReceipt,
  admitPortfolioRegistry,
  createPortfolioContractEnvelope,
  createPortfolioExecutionLedger,
  evaluateAuthoritativeCompletion,
  getCandidateRegistry,
  getPortfolioRegistry,
  hashPortfolioCanonicalJson,
  PORTFOLIO_CONTRACT_PROTOCOL_VERSION,
  PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
  PORTFOLIO_MILESTONE_MONITORS,
  PORTFOLIO_TARGET_GAME_SHA256,
  PORTFOLIO_TARGET_SMAPI_VERSION,
  PORTFOLIO_TARGET_VERSION,
  PORTFOLIO_TOPOLOGY,
  signCandidateClosureManifest,
  signPortfolioCcm,
  signPortfolioDsm,
  validateCandidateClosureManifest,
  validatePortfolioCcm,
  validatePortfolioCheckpoint,
  validatePortfolioContractEnvelope,
  validatePortfolioDsm,
  validatePortfolioReceipt,
} from "./lib/stardew-portfolio-contracts.mjs";
import { computePortfolioBindingHash } from "./lib/stardew-portfolio-p0b.mjs";

const KEY = "untracked-test-key-portfolio-contracts";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);
const HASH_F = "f".repeat(64);
const SAVE_NAME = "GameBuddyPortfolio_1_6_15";
const SCOPE = Object.freeze({
  saveId: SAVE_NAME,
  worldId: "world_01",
  localPlayerId: "player_01",
  companionId: "companion_01",
  bindingGeneration: 1,
  bindingHash: computePortfolioBindingHash({
    saveId: SAVE_NAME,
    worldId: "world_01",
    localPlayerId: "player_01",
    companionId: "companion_01",
    bindingGeneration: 1,
  }),
});
const TARGET = Object.freeze({
  gameVersion: PORTFOLIO_TARGET_VERSION,
  gameBuild: 24356,
  gameSha256: PORTFOLIO_TARGET_GAME_SHA256,
  smapiVersion: PORTFOLIO_TARGET_SMAPI_VERSION,
  smapiSha256: HASH_A,
  smapiExeSha256: HASH_B,
  modSha256: HASH_C,
  hostSha256: HASH_D,
});
const PROVENANCE = Object.freeze({
  sourceKind: "target_version_native",
  sourceRevision: PORTFOLIO_TARGET_VERSION,
  nativeSourceSha256: HASH_E,
  contentManifestSha256: HASH_F,
});

function finiteDomain(domainId, values) {
  return { kind: "finite", domainId, values, valueHash: hashPortfolioCanonicalJson(values) };
}
function variant(variantId, actionClass = "primitive") {
  return {
    variantId,
    actionClass,
    contractRevision: "portfolio-contract-v1",
    domain: finiteDomain(`${variantId}-domain`, ["target_01"]),
  };
}
function candidateManifest(overrides = {}) {
  return signCandidateClosureManifest(
    {
      schemaVersion: 1,
      artifactKind: "candidate_closure_manifest",
      topology: PORTFOLIO_TOPOLOGY,
      contractKind: "candidate_closure",
      candidateClosureRunId: "candidate_move_01",
      variant: variant("move_to_tile__single_player_native_companion"),
      target: TARGET,
      scope: SCOPE,
      contentProvenance: PROVENANCE,
      evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
      registryRevision: "portfolio-registry-v1",
      exclusions: ["ui", "generic_dispatcher"],
      ...overrides,
    },
    KEY,
  );
}

const MOVE_VARIANT = variant("move_to_tile__single_player_native_companion");
const SLEEP_VARIANT = variant("single_player_sleep_and_advance_day__single_player_native_companion", "coordination");

function dsm(overrides = {}) {
  const variants = [
    {
      variantId: MOVE_VARIANT.variantId,
      actionClass: MOVE_VARIANT.actionClass,
      domainHash: MOVE_VARIANT.domain.valueHash,
      provenanceHash: HASH_E,
      ccmRowId: "ccm_move_01",
      closureAttestationHash: HASH_A,
    },
    {
      variantId: SLEEP_VARIANT.variantId,
      actionClass: SLEEP_VARIANT.actionClass,
      domainHash: SLEEP_VARIANT.domain.valueHash,
      provenanceHash: HASH_E,
      ccmRowId: "ccm_sleep_01",
      closureAttestationHash: HASH_B,
    },
  ];
  const milestones = [
    ["M1", [MOVE_VARIANT.variantId]],
    ["M2", [SLEEP_VARIANT.variantId]],
    ["M3", [MOVE_VARIANT.variantId]],
    ["M4", [MOVE_VARIANT.variantId]],
    ["M5", [SLEEP_VARIANT.variantId]],
    ["M6", [SLEEP_VARIANT.variantId]],
    ["M7", [MOVE_VARIANT.variantId]],
    ["M8", [MOVE_VARIANT.variantId]],
    ["M9", [MOVE_VARIANT.variantId]],
    ["M10", [MOVE_VARIANT.variantId]],
  ].map(([id, requiredVariantIds]) => ({
    id,
    monitorId: `portfolio_${id.toLowerCase()}_native_persisted_v1`,
    requiredVariantIds,
  }));
  return signPortfolioDsm(
    {
      schemaVersion: 1,
      artifactKind: "portfolio_dsm",
      topology: PORTFOLIO_TOPOLOGY,
      contractKind: "portfolio_run",
      portfolioId: "core_valley_milestone_portfolio_v1",
      portfolioRunId: "portfolio_run_01",
      frozen: true,
      target: TARGET,
      scope: SCOPE,
      variants,
      milestones,
      contentScope: {
        bundle: { slotId: "Pantry_0", acceptedItemIds: ["(O)24"], rewardId: "(O)498" },
        mine: { routeId: "mine_route_01", targetFloor: 40 },
        specialOrder: { orderId: "QiCrop", objectiveIds: ["objective_01"], rewardId: "qi_gem" },
        museum: { pieceIds: ["(O)80"], pieceSetHash: HASH_C, rewardId: "museum_reward_01" },
      },
      barriers: { sleepVariantId: SLEEP_VARIANT.variantId, saveReopenRequired: true },
      registryRevision: "portfolio-registry-v1",
      policyRevision: "portfolio-policy-v1",
      evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
      startManifestHash: HASH_D,
      exclusions: ["farmhand", "preview", "ui", "save_edit"],
      ...overrides,
    },
    KEY,
  );
}

function ccm(overrides = {}) {
  return signPortfolioCcm(
    {
      schemaVersion: 1,
      artifactKind: "portfolio_ccm",
      topology: PORTFOLIO_TOPOLOGY,
      contractKind: "candidate_closure",
      ccmRevision: "ccm-v1",
      evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
      publicationState: "published_for_single_player_native_companion",
      rows: [
        ccmRow("ccm_move_01", MOVE_VARIANT, "candidate_move_01", HASH_A, "primitive"),
        ccmRow("ccm_sleep_01", SLEEP_VARIANT, "candidate_sleep_01", HASH_B, "coordination"),
      ],
      ...overrides,
    },
    KEY,
  );
}
function ccmRow(rowId, rowVariant, candidateClosureRunId, candidateManifestHash, actionClass) {
  return {
    rowId,
    variantId: rowVariant.variantId,
    candidateClosureRunId,
    candidateManifestHash,
    domainHash: rowVariant.domain.valueHash,
    provenanceHash: HASH_E,
    topology: PORTFOLIO_TOPOLOGY,
    bindingHash: SCOPE.bindingHash,
    bindingGeneration: SCOPE.bindingGeneration,
    targetVersion: `${PORTFOLIO_TARGET_VERSION}.24356`,
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
    actionClass,
    status: "closed",
    contractGate: "PASS",
    deterministicGate: "PASS",
    liveGate: "PASS",
    recoveryGate: "PASS",
    closureAttestationHash: rowId === "ccm_move_01" ? HASH_A : HASH_B,
  };
}
function receipt(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "portfolio_execution_receipt",
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
    topology: PORTFOLIO_TOPOLOGY,
    bindingHash: SCOPE.bindingHash,
    bindingGeneration: SCOPE.bindingGeneration,
    contractKind: "portfolio_run",
    contractId: "portfolio_run_01",
    manifestHash: dsm().manifestHash,
    requestId: "request_01",
    requestFingerprint: HASH_D,
    executionId: "execution_01",
    revision: 2,
    actionVariant: MOVE_VARIANT.variantId,
    state: "succeeded",
    reasonCode: "target_reached",
    evidence: { schemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION, executionId: "execution_01", evidenceHash: HASH_E },
    ...overrides,
  };
}
function checkpoint(overrides = {}) {
  return {
    schemaVersion: 1,
    artifactKind: "portfolio_checkpoint",
    evidenceSchemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION,
    topology: PORTFOLIO_TOPOLOGY,
    bindingHash: SCOPE.bindingHash,
    bindingGeneration: SCOPE.bindingGeneration,
    contractKind: "portfolio_run",
    contractId: "portfolio_run_01",
    manifestHash: dsm().manifestHash,
    requestId: "request_01",
    requestFingerprint: HASH_D,
    executionId: "execution_01",
    revision: 3,
    actionVariant: MOVE_VARIANT.variantId,
    state: "succeeded",
    reasonCode: "target_reached",
    evidence: { schemaRevision: PORTFOLIO_EVIDENCE_SCHEMA_REVISION, executionId: "execution_01", evidenceHash: HASH_E },
    checkpointId: "checkpoint_01",
    monitorId: "portfolio_m1_native_persisted_v1",
    ...overrides,
  };
}
function freshObservation(overrides = {}) {
  return {
    schemaVersion: 1,
    topology: PORTFOLIO_TOPOLOGY,
    bindingHash: SCOPE.bindingHash,
    bindingGeneration: SCOPE.bindingGeneration,
    revision: 3,
    capturedAfterExecutionId: "execution_01",
    provenance: "target_version_native_field_adapter",
    sourceField: "Game1.player.currentLocation",
    fields: { location: "Town", tile: "10,10" },
    ...overrides,
  };
}
function postcondition(overrides = {}) {
  return {
    schemaVersion: 1,
    topology: PORTFOLIO_TOPOLOGY,
    bindingHash: SCOPE.bindingHash,
    bindingGeneration: SCOPE.bindingGeneration,
    executionId: "execution_01",
    actionVariant: MOVE_VARIANT.variantId,
    observedAfterReceipt: true,
    observedRevision: 3,
    provenance: "target_version_native_field_adapter",
    postconditionHash: HASH_F,
    ...overrides,
  };
}

test("candidate closure manifests are signed, finite, topology-suffixed and never portfolio runs", () => {
  const signed = candidateManifest();
  assert.equal(validateCandidateClosureManifest(signed, { signingKey: KEY }).valid, true);
  assert.equal(getCandidateRegistry({ manifest: signed, signingKey: KEY }).variants.length, 1);

  const tampered = validateCandidateClosureManifest(
    { ...signed, variant: { ...signed.variant, variantId: "move_to_tile" } },
    { signingKey: KEY },
  );
  assert.equal(tampered.valid, false);
  assert.ok(tampered.errors.includes("portfolio_manifest_hash_mismatch"));
  assert.ok(tampered.errors.includes("portfolio_candidate_variant_not_topology_suffixed"));

  const portfolioShaped = validateCandidateClosureManifest(
    { ...signed, portfolioRunId: "portfolio_run_01" },
    { signingKey: KEY },
  );
  assert.ok(portfolioShaped.errors.includes("portfolio_candidate_manifest_unknown_field"));
});

test("candidate and final registry admission expose only exact topology-scoped variants", () => {
  const manifest = candidateManifest();
  const candidate = admitCandidateRegistry({
    manifest,
    signingKey: KEY,
    requestedVariantId: manifest.variant.variantId,
    requestedDomainHash: manifest.variant.domain.valueHash,
  });
  assert.equal(candidate.state, "ADMITTED");
  assert.equal(candidate.contractKind, "candidate_closure");

  assert.equal(
    admitCandidateRegistry({ manifest, signingKey: KEY, requestedVariantId: "travel__single_player_native_companion" })
      .reasonCode,
    "portfolio_candidate_registry_variant_not_authorized",
  );
  assert.equal(
    admitCandidateRegistry({ manifest, signingKey: KEY, requestedDomainHash: HASH_B }).reasonCode,
    "portfolio_candidate_registry_domain_not_authorized",
  );

  const final = admitPortfolioRegistry({
    dsm: dsm(),
    ccm: ccm(),
    dsmSigningKey: KEY,
    ccmSigningKey: KEY,
    scope: SCOPE,
    requestedVariantId: MOVE_VARIANT.variantId,
    requestedDomainHash: MOVE_VARIANT.domain.valueHash,
  });
  assert.equal(final.state, "ADMITTED");
  assert.equal(final.contractKind, "portfolio_run");
  assert.equal(
    admitPortfolioRegistry({
      dsm: dsm(),
      ccm: ccm(),
      dsmSigningKey: KEY,
      ccmSigningKey: KEY,
      scope: SCOPE,
      requestedVariantId: "travel__single_player_native_companion",
    }).reasonCode,
    "portfolio_registry_variant_not_closed",
  );
  assert.equal(
    admitPortfolioRegistry({
      dsm: dsm(),
      ccm: ccm(),
      dsmSigningKey: KEY,
      ccmSigningKey: KEY,
      scope: SCOPE,
      requestedVariantId: MOVE_VARIANT.variantId,
      requestedDomainHash: HASH_B,
    }).reasonCode,
    "portfolio_registry_domain_not_closed",
  );
});

test("DSM is frozen only with all ten monitors and locked finite content scope", () => {
  const signed = dsm();
  const result = validatePortfolioDsm(signed, { signingKey: KEY, scope: SCOPE });
  assert.equal(result.valid, true);
  assert.deepEqual(
    [...PORTFOLIO_MILESTONE_MONITORS.keys()],
    ["M1", "M2", "M3", "M4", "M5", "M6", "M7", "M8", "M9", "M10"],
  );

  const drift = validatePortfolioDsm({ ...signed, frozen: false }, { signingKey: KEY });
  assert.equal(drift.valid, false);
  assert.ok(drift.errors.includes("portfolio_dsm_must_be_frozen"));

  const missingMonitor = validatePortfolioDsm(
    { ...signed, milestones: signed.milestones.slice(0, 9) },
    { signingKey: KEY },
  );
  assert.equal(missingMonitor.valid, false);
  assert.ok(missingMonitor.errors.includes("portfolio_dsm_milestones_incomplete"));
});

test("CCM publication requires independent closed candidate rows and contains no receipt/evidence payload", () => {
  const signed = ccm();
  const result = validatePortfolioCcm(signed, { signingKey: KEY, scope: SCOPE });
  assert.equal(result.valid, true);
  assert.equal(
    getPortfolioRegistry({ dsm: dsm(), ccm: signed, dsmSigningKey: KEY, ccmSigningKey: KEY }).variants.length,
    2,
  );

  const injectedReceipt = validatePortfolioCcm(
    { ...signed, rows: signed.rows.map((row) => ({ ...row, receiptId: "execution_01" })) },
    { signingKey: KEY },
  );
  assert.equal(injectedReceipt.valid, false);
  assert.ok(injectedReceipt.errors.includes("portfolio_ccm_unknown_row_field"));

  const open = validatePortfolioCcm(
    { ...signed, rows: signed.rows.map((row) => ({ ...row, liveGate: "BLOCKED" })) },
    { signingKey: KEY },
  );
  assert.equal(open.valid, false);
  assert.ok(open.errors.includes("portfolio_ccm_row_liveGate_not_closed"));

  const wrongBinding = validatePortfolioCcm(
    { ...signed, rows: signed.rows.map((row) => ({ ...row, bindingGeneration: 2 })) },
    { signingKey: KEY, scope: SCOPE },
  );
  assert.ok(wrongBinding.errors.includes("portfolio_ccm_row_binding_scope_mismatch"));
});

test("candidate receipts cannot advance a portfolio monitor; final admission requires same run, closure, evidence, postcondition and fresh native fields", () => {
  const finalDsm = dsm();
  const finalCcm = ccm();
  const candidate = {
    ...receipt(),
    contractKind: "candidate_closure",
    contractId: "candidate_move_01",
    manifestHash: candidateManifest().manifestHash,
  };
  const rejected = admitPortfolioMonitorReceipt({
    milestoneId: "M1",
    dsm: finalDsm,
    ccm: finalCcm,
    dsmSigningKey: KEY,
    ccmSigningKey: KEY,
    currentScope: SCOPE,
    receipt: candidate,
    postcondition: postcondition(),
    observation: freshObservation(),
  });
  assert.equal(rejected.state, "REJECTED");
  assert.equal(rejected.reasonCode, "portfolio_monitor_candidate_receipt_forbidden");

  const accepted = admitPortfolioMonitorReceipt({
    milestoneId: "M1",
    dsm: finalDsm,
    ccm: finalCcm,
    dsmSigningKey: KEY,
    ccmSigningKey: KEY,
    currentScope: SCOPE,
    receipt: receipt({ manifestHash: finalDsm.manifestHash }),
    postcondition: postcondition(),
    observation: freshObservation(),
  });
  assert.equal(accepted.state, "ACCEPTED", JSON.stringify(accepted));
  assert.equal(accepted.executionId, "execution_01");

  const stale = admitPortfolioMonitorReceipt({
    milestoneId: "M1",
    dsm: finalDsm,
    ccm: finalCcm,
    dsmSigningKey: KEY,
    ccmSigningKey: KEY,
    currentScope: SCOPE,
    receipt: receipt({ manifestHash: finalDsm.manifestHash }),
    postcondition: postcondition(),
    observation: freshObservation({ capturedAfterExecutionId: "other_execution" }),
  });
  assert.equal(stale.state, "REJECTED");
  assert.equal(stale.reasonCode, "portfolio_monitor_observation_not_after_receipt");

  const reboundScope = {
    ...SCOPE,
    bindingGeneration: 2,
    bindingHash: computePortfolioBindingHash({ ...SCOPE, bindingGeneration: 2 }),
  };
  const rebound = admitPortfolioMonitorReceipt({
    milestoneId: "M1",
    dsm: finalDsm,
    ccm: finalCcm,
    dsmSigningKey: KEY,
    ccmSigningKey: KEY,
    currentScope: reboundScope,
    receipt: receipt({ manifestHash: finalDsm.manifestHash }),
    postcondition: postcondition(),
    observation: freshObservation(),
  });
  assert.equal(rebound.state, "REJECTED");
  assert.equal(rebound.reasonCode, "portfolio_monitor_dsm_invalid");
});

test("candidate closure receipts and Portfolio checkpoints remain contract-specific", () => {
  const manifest = candidateManifest();
  const candidateReceipt = receipt({
    contractKind: "candidate_closure",
    contractId: manifest.candidateClosureRunId,
    manifestHash: manifest.manifestHash,
    actionVariant: manifest.variant.variantId,
  });
  const admittedCandidate = admitCandidateClosureReceipt({
    manifest,
    signingKey: KEY,
    receipt: candidateReceipt,
    postcondition: postcondition({
      bindingHash: manifest.scope.bindingHash,
      bindingGeneration: manifest.scope.bindingGeneration,
      executionId: candidateReceipt.executionId,
      actionVariant: candidateReceipt.actionVariant,
    }),
  });
  assert.equal(admittedCandidate.state, "ADMITTED", JSON.stringify(admittedCandidate));
  assert.equal(admittedCandidate.contractKind, "candidate_closure");

  const wrongVariant = admitCandidateClosureReceipt({
    manifest,
    signingKey: KEY,
    receipt: { ...candidateReceipt, actionVariant: SLEEP_VARIANT.variantId },
    postcondition: postcondition({ actionVariant: SLEEP_VARIANT.variantId }),
  });
  assert.equal(wrongVariant.state, "REJECTED");
  assert.equal(wrongVariant.reasonCode, "portfolio_candidate_receipt_variant_mismatch");

  const admittedCheckpoint = admitPortfolioCheckpoint({
    dsm: dsm(),
    checkpoint: checkpoint({ manifestHash: dsm().manifestHash }),
    dsmSigningKey: KEY,
    currentScope: SCOPE,
  });
  assert.equal(admittedCheckpoint.state, "ADMITTED");
  assert.equal(admittedCheckpoint.contractKind, "portfolio_run");

  const candidateCheckpoint = admitPortfolioCheckpoint({
    dsm: dsm(),
    checkpoint: checkpoint({ contractId: "candidate_move_01" }),
    dsmSigningKey: KEY,
    currentScope: SCOPE,
  });
  assert.equal(candidateCheckpoint.state, "REJECTED");

  const reboundCheckpoint = admitPortfolioCheckpoint({
    dsm: dsm(),
    checkpoint: checkpoint(),
    dsmSigningKey: KEY,
    currentScope: {
      ...SCOPE,
      bindingGeneration: 2,
      bindingHash: computePortfolioBindingHash({ ...SCOPE, bindingGeneration: 2 }),
    },
  });
  assert.equal(reboundCheckpoint.state, "REJECTED");
  assert.equal(reboundCheckpoint.reasonCode, "portfolio_checkpoint_dsm_invalid");
  assert.equal(
    admitPortfolioCheckpoint({ dsm: dsm(), checkpoint: checkpoint(), dsmSigningKey: KEY }).reasonCode,
    "portfolio_checkpoint_current_scope_required",
  );
});

test("authoritative completion requires same-execution succeeded receipt, evidence and fresh action postcondition", () => {
  const valid = evaluateAuthoritativeCompletion({ receipt: receipt(), postcondition: postcondition() });
  assert.deepEqual(valid, { state: "authoritatively_completed", reasonCode: "action_postcondition_verified" });
  const candidate = receipt({
    contractKind: "candidate_closure",
    contractId: "candidate_move_01",
    manifestHash: candidateManifest().manifestHash,
  });
  assert.equal(
    evaluateAuthoritativeCompletion({ receipt: candidate, postcondition: postcondition() }).reasonCode,
    "portfolio_authoritative_completion_candidate_receipt_forbidden",
  );
  assert.equal(
    evaluateAuthoritativeCompletion({
      receipt: { ...receipt(), contractKind: "not_a_contract" },
      postcondition: postcondition(),
    }).state,
    "REJECTED",
  );
  assert.equal(
    evaluateAuthoritativeCompletion({ receipt: receipt(), postcondition: postcondition({ observedRevision: 1 }) })
      .state,
    "REJECTED",
  );
  assert.equal(
    evaluateAuthoritativeCompletion({ receipt: receipt({ state: "accepted" }), postcondition: postcondition() }).state,
    "REJECTED",
  );
  assert.equal(
    evaluateAuthoritativeCompletion({ receipt: receipt({ evidence: null }), postcondition: postcondition() }).state,
    "REJECTED",
  );
  assert.equal(
    evaluateAuthoritativeCompletion({
      receipt: receipt(),
      postcondition: postcondition({ executionId: "other_execution" }),
    }).state,
    "REJECTED",
  );
  assert.equal(
    evaluateAuthoritativeCompletion({
      receipt: receipt({ topology: "native_ai_farmhand_multiplayer" }),
      postcondition: postcondition(),
    }).state,
    "REJECTED",
  );
});

test("receipt and checkpoint contracts reject Farmhand/cross-run data and preserve exact required fields", () => {
  assert.equal(
    validatePortfolioReceipt(receipt(), {
      contractKind: "portfolio_run",
      contractId: "portfolio_run_01",
      manifestHash: receipt().manifestHash,
      scope: SCOPE,
    }).valid,
    true,
  );
  const farmhand = validatePortfolioReceipt({ ...receipt(), topology: "native_ai_farmhand_multiplayer" }, {});
  assert.equal(farmhand.valid, false);
  assert.ok(farmhand.errors.includes("portfolio_receipt_topology_invalid"));
  const candidateWithDsm = validatePortfolioReceipt(
    {
      ...receipt(),
      contractKind: "candidate_closure",
      contractId: "candidate_01",
      manifestHash: receipt().manifestHash,
    },
    {
      contractKind: "candidate_closure",
      contractId: "candidate_01",
      manifestHash: receipt().manifestHash,
      scope: SCOPE,
    },
  );
  assert.equal(candidateWithDsm.valid, false);
  assert.ok(candidateWithDsm.errors.includes("portfolio_candidate_receipt_manifest_kind_mismatch"));
  assert.equal(
    validatePortfolioCheckpoint(checkpoint(), {
      contractKind: "portfolio_run",
      contractId: "portfolio_run_01",
      manifestHash: checkpoint().manifestHash,
      scope: SCOPE,
    }).valid,
    true,
  );
  const checkpointExtra = validatePortfolioCheckpoint({ ...checkpoint(), candidateClosureRunId: "candidate_01" }, {});
  assert.ok(checkpointExtra.errors.includes("portfolio_checkpoint_unknown_field"));
});

test("durable ledger keeps candidate and portfolio namespaces physically separate and survives reopen", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-portfolio-contracts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const finalDsm = dsm();
  const finalReceipt = receipt({ manifestHash: finalDsm.manifestHash });
  const finalCheckpoint = checkpoint({ manifestHash: finalDsm.manifestHash });
  const finalLedger = await createPortfolioExecutionLedger({
    dataRoot: root,
    contractKind: "portfolio_run",
    contractId: "portfolio_run_01",
    manifestHash: finalDsm.manifestHash,
    scope: SCOPE,
  });
  const candidateLedger = await createPortfolioExecutionLedger({
    dataRoot: root,
    contractKind: "candidate_closure",
    contractId: "candidate_move_01",
    manifestHash: candidateManifest().manifestHash,
    scope: SCOPE,
    variantId: MOVE_VARIANT.variantId,
  });
  await assert.rejects(
    () =>
      createPortfolioExecutionLedger({
        dataRoot: root,
        contractKind: "candidate_closure",
        contractId: "candidate_move_01",
        manifestHash: candidateManifest().manifestHash,
        scope: SCOPE,
        variantId: SLEEP_VARIANT.variantId,
      }),
    /portfolio_ledger_identity_conflict/,
  );
  assert.notEqual(finalLedger.namespacePath, candidateLedger.namespacePath);
  assert.equal((await finalLedger.appendReceipt(finalReceipt)).state, "written");
  assert.equal((await finalLedger.writeCheckpoint(finalCheckpoint)).state, "written");
  assert.equal((await finalLedger.appendReceipt(finalReceipt)).state, "replayed");
  await assert.rejects(() => candidateLedger.appendReceipt(finalReceipt), /portfolio_receipt_contract_kind_mismatch/);

  const reopened = await createPortfolioExecutionLedger({
    dataRoot: root,
    contractKind: "portfolio_run",
    contractId: "portfolio_run_01",
    manifestHash: finalDsm.manifestHash,
    scope: SCOPE,
  });
  assert.deepEqual(await reopened.readReceipt("request_01"), finalReceipt);
  assert.deepEqual(await reopened.readCheckpoint("checkpoint_01"), finalCheckpoint);
  const stored = await readFile(join(finalLedger.namespacePath, "receipts", "request_01.json"), "utf8");
  assert.match(stored, /portfolio_run/);
  assert.match(finalLedger.namespacePath, /portfolio-run[\\/]+portfolio_run_01[\\/]+/);
  assert.match(candidateLedger.namespacePath, /candidate-closure[\\/]+candidate_move_01[\\/]+/);

  await assert.rejects(
    () =>
      createPortfolioExecutionLedger({
        dataRoot: root,
        contractKind: "portfolio_run",
        contractId: "portfolio_run_01",
        manifestHash: HASH_A,
        scope: SCOPE,
      }),
    /portfolio_ledger_binding_stale/,
  );
});

test("contract protocol is a separate schema-only seam with exact contract/run identity", () => {
  const scope = { ...SCOPE };
  const envelope = createPortfolioContractEnvelope(
    "candidate_execution_request",
    {
      topology: PORTFOLIO_TOPOLOGY,
      contractKind: "candidate_closure",
      contractId: "candidate_move_01",
      manifestHash: candidateManifest().manifestHash,
      bindingHash: SCOPE.bindingHash,
      bindingGeneration: SCOPE.bindingGeneration,
    },
    {
      actionVariant: MOVE_VARIANT.variantId,
      target: { id: "target_01" },
      deadlineMs: Date.now() + 10_000,
      idempotencyKey: "request_01",
    },
    "request_01",
  );
  assert.equal(envelope.protocolVersion, PORTFOLIO_CONTRACT_PROTOCOL_VERSION);
  assert.equal(
    validatePortfolioContractEnvelope(envelope, {
      ...scope,
      contractKind: "candidate_closure",
      contractId: "candidate_move_01",
      manifestHash: envelope.contract.manifestHash,
    }).valid,
    true,
  );
  const wrongRun = validatePortfolioContractEnvelope(
    { ...envelope, contract: { ...envelope.contract, contractId: "portfolio_run_01" } },
    {
      ...scope,
      contractKind: "candidate_closure",
      contractId: "candidate_move_01",
      manifestHash: envelope.contract.manifestHash,
    },
  );
  assert.equal(wrongRun.valid, false);
  assert.ok(wrongRun.errors.includes("portfolio_contract_identity_mismatch"));
  assert.equal(
    validatePortfolioContractEnvelope(
      { ...envelope, type: "execution_request" },
      {
        ...scope,
        contractKind: "candidate_closure",
        contractId: "candidate_move_01",
        manifestHash: envelope.contract.manifestHash,
      },
    ).valid,
    false,
  );
  assert.ok(
    validatePortfolioContractEnvelope(
      {
        ...envelope,
        type: "candidate_checkpoint_request",
        payload: {
          checkpointId: "checkpoint_01",
          monitorId: "portfolio_m1_native_persisted_v1",
          idempotencyKey: "request_01",
        },
      },
      {
        ...scope,
        contractKind: "candidate_closure",
        contractId: "candidate_move_01",
        manifestHash: envelope.contract.manifestHash,
      },
    ).errors.includes("portfolio_candidate_checkpoint_request_forbidden"),
  );
  assert.ok(
    validatePortfolioContractEnvelope(
      { ...envelope, contract: { ...envelope.contract, contractId: "portfolio_run_01" } },
      {
        ...scope,
        contractKind: "candidate_closure",
        contractId: "candidate_move_01",
        manifestHash: envelope.contract.manifestHash,
      },
    ).errors.includes("portfolio_contract_identity_candidate_run_id_invalid"),
  );
});
