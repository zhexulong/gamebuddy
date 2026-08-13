#!/usr/bin/env node
/**
 * Static, fail-closed Batch B1 contract for the M7 bundle seam.
 *
 * This artifact deliberately describes the missing typed transactions only. It
 * does not select a bundle, publish either action, invoke a menu callback,
 * mutate a save, or establish target-version live closure.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validatePortfolioM7BundleSourceAudit } from "./lib/stardew-portfolio-m7-bundle-source-audit.mjs";

const TOPOLOGY = "single_player_native_companion";
const TARGET_VERSION = "1.6.15.24356";
const SOURCE_AUDIT = "tools/stardew-portfolio-m7-bundle-source-audit.json";
const SOURCE_ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley";
const FIXTURE_REF = "fixtures/stardew/portfolio-m7-bundle-unprovisioned.fixture.example.json";
const AUDIT_ID = "portfolio_m7_bundle_slot_reward_source_audit_v1";
const TRACE_FAMILY_ID = "portfolio_m7_bundle_slot_to_reward";
const ACTIONS = Object.freeze(["contribute_bundle_slot", "claim_bundle_reward"]);
const ANCHORS = Object.freeze([
  "community_center_bundle_mutex_ingress",
  "bundle_accepted_alternative_guard",
  "bundle_accepted_alternative_consumption",
  "bundle_slot_progress_commit",
  "bundle_completion_commit",
  "bundle_reward_available_commit",
  "bundle_reward_collection_ingress",
  "bundle_reward_claim_commit",
]);
const FORBIDDEN = Object.freeze([
  "UI automation, window/visual inspection, keyboard/mouse/XInput, or coordinate selection",
  "Game1.activeClickableMenu, Bundle, JunimoNoteMenu, ItemGrabMenu, raw menu callback, or dialogue callback invocation",
  "GameLocation.checkAction, CommunityCenter bundle ingress, raw dispatcher string, or generic method-name dispatch",
  "save XML editing, direct net-world-state/player/mail/inventory/bundle mutation, or fixture-written result state",
  "arbitrary native call fallback, reflection, private callback invocation, or synthetic receipt/postcondition",
  "generic complete-bundle, donate-and-claim, or combined contribution/reward action",
]);
const NON_CLAIMS = Object.freeze([
  "This static contract does not publish contribute_bundle_slot or claim_bundle_reward.",
  "This contract does not establish source realization, target-version live closure, receipt evidence, or release evidence.",
  "The current UI-owned source transaction is an implementation seam, not a reason to classify the typed action as dependency_blocked.",
]);
const FIXTURE_FORBIDDEN = Object.freeze([
  "terminal bundle completion, preloaded selected slot progress, reward availability, or claimed reward",
  "save XML editing, direct community-center/player/inventory/mail/bundle mutation, or synthetic receipt/postcondition creation",
  "UI/input automation, menu or callback invocation, raw dispatcher, or arbitrary native fallback",
]);
const FIXTURE_NON_CLAIMS = Object.freeze([
  "This example is an unprovisioned starting-state contract, not a provisioned save or live fixture.",
  "It contains no concrete slot/item/reward identity, receipt, postcondition, or terminal result.",
]);

function fail(message, code = "portfolio_m7_bundle_action_contract_invalid") {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function object(value, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object.`);
  return value;
}
function exact(value, fields, name) {
  object(value, name);
  const expected = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(value, field)) fail(`${name} is missing field ${field}.`);
  for (const field of Object.keys(value)) if (!expected.has(field)) fail(`${name} has unknown field ${field}.`);
}
function exactArray(value, expected, name) {
  if (!Array.isArray(value) || JSON.stringify(value) !== JSON.stringify(expected))
    fail(`${name} must match the approved bounded policy.`);
}
function string(value, name) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string.`);
}
function noStaticIdentity(value, name) {
  if (Array.isArray(value)) return value.forEach((entry, index) => noStaticIdentity(entry, `${name}[${index}]`));
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (["value", "itemId", "slotId", "rewardId", "identity"].includes(key) && typeof entry === "string")
      fail(`${name}.${key} must not contain a static identity.`);
    noStaticIdentity(entry, `${name}.${key}`);
  }
}
function opaque(value, name, kind, source) {
  exact(value, ["kind", "source", "value"], name);
  if (value.kind !== kind || value.source !== source || value.value !== null)
    fail(`${name} must remain a fresh opaque runtime value.`);
}
function bounded(value, name, min, max) {
  exact(value, ["kind", "min", "max", "value"], name);
  if (value.kind !== "bounded_runtime_integer" || value.min !== min || value.max !== max || value.value !== null)
    fail(`${name} must be an unmaterialized bounded DSM/runtime integer.`);
}
function validateSelection(value) {
  exact(value, ["slot", "item", "reward", "dispatchBinding"], "selection");
  opaque(value.slot, "selection.slot", "opaque_runtime_bundle_slot", "fresh_observation");
  exact(value.item, ["identity", "quality", "stack", "selectionSource"], "selection.item");
  opaque(value.item.identity, "selection.item.identity", "opaque_runtime_item_identity", "fresh_observation");
  bounded(value.item.quality, "selection.item.quality", 0, 4);
  bounded(value.item.stack, "selection.item.stack", 1, 999);
  if (value.item.selectionSource !== "signed_dsm_bounded_domain_plus_fresh_observation")
    fail("selection.item.selectionSource must bind DSM bounds to fresh observation.");
  opaque(value.reward, "selection.reward", "opaque_runtime_bundle_reward", "fresh_observation");
  exact(value.dispatchBinding, ["required", "resolution", "immutable", "provenance"], "selection.dispatchBinding");
  if (value.dispatchBinding.required !== true || value.dispatchBinding.resolution !== "before_native_invocation" || value.dispatchBinding.immutable !== true || value.dispatchBinding.provenance !== "fresh_observation_bound_to_signed_dsm")
    fail("selection.dispatchBinding is not strict.");
}
function validateAction(value, expectedId) {
  exact(value, ["actionId", "actionClass", "target", "input", "guards", "nativeBoundary", "commit", "terminalReceipt", "freshPostcondition", "lifecycle", "forbiddenBehavior"], `${expectedId} action`);
  if (value.actionId !== expectedId || value.actionClass !== "primitive") fail(`${expectedId} action identity/class is invalid.`);
  opaque(value.target, `${expectedId}.target`, "opaque_runtime_bundle_slot", "fresh_observation");
  exact(value.input, expectedId === ACTIONS[0] ? ["itemIdentity", "quality", "stack", "boundAtDispatch"] : ["reward", "boundAtDispatch"], `${expectedId}.input`);
  if (expectedId === ACTIONS[0]) {
    opaque(value.input.itemIdentity, `${expectedId}.input.itemIdentity`, "opaque_runtime_item_identity", "fresh_observation");
    bounded(value.input.quality, `${expectedId}.input.quality`, 0, 4);
    bounded(value.input.stack, `${expectedId}.input.stack`, 1, 999);
  } else opaque(value.input.reward, `${expectedId}.input.reward`, "opaque_runtime_bundle_reward", "fresh_observation");
  if (value.input.boundAtDispatch !== true) fail(`${expectedId} input must be frozen at dispatch.`);
  exact(value.guards, ["gameThreadRevalidation", "topology", "player", "world", "scope", "revision", "policy", "deadline", "idempotency", "cancel", "gameState", "freshObservation", "selectedDomain"], `${expectedId}.guards`);
  if (value.guards.gameThreadRevalidation !== true || value.guards.topology !== TOPOLOGY || value.guards.freshObservation !== true || value.guards.selectedDomain !== "signed_dsm_bounded_domain") fail(`${expectedId} guards are not strict.`);
  for (const field of ["player", "world", "scope", "revision", "policy", "deadline", "idempotency", "cancel", "gameState"])
    if (value.guards[field] !== "required") fail(`${expectedId}.guards.${field} must be required.`);
  exact(value.nativeBoundary, ["mutex", "progress", "reward", "presentation"], `${expectedId}.nativeBoundary`);
  exact(value.commit, ["transaction", "effects", "doesNotDo"], `${expectedId}.commit`);
  exact(value.terminalReceipt, ["state", "evidence", "sameExecution", "actionSpecific"], `${expectedId}.terminalReceipt`);
  if (value.terminalReceipt.state !== "succeeded" || value.terminalReceipt.evidence !== "non_empty_action_specific" || value.terminalReceipt.sameExecution !== true || value.terminalReceipt.actionSpecific !== true) fail(`${expectedId} receipt policy is not strict.`);
  exact(value.freshPostcondition, ["provenance", "requiresRevisionAfterReceipt", "facts"], `${expectedId}.freshPostcondition`);
  if (value.freshPostcondition.provenance !== "fresh_native_observation" || value.freshPostcondition.requiresRevisionAfterReceipt !== true || !Array.isArray(value.freshPostcondition.facts) || value.freshPostcondition.facts.length === 0) fail(`${expectedId} fresh postcondition is invalid.`);
  exact(value.lifecycle, ["cancellation", "replay", "saveReopen"], `${expectedId}.lifecycle`);
  if (value.lifecycle.cancellation !== "local_stop_no_success" || value.lifecycle.replay !== "idempotent_same_request_only" || value.lifecycle.saveReopen !== "required_when_composed") fail(`${expectedId} lifecycle policy is invalid.`);
  exactArray(value.forbiddenBehavior, FORBIDDEN, `${expectedId}.forbiddenBehavior`);
}

export function validateM7BundleFixtureContract(fixture) {
  exact(fixture, ["schemaVersion", "artifactKind", "fixtureId", "topology", "targetVersion", "provisioningState", "purpose", "startingState", "freshSelectionRequirements", "antiFinalStepAssertions", "forbiddenBehavior", "nonClaims"], "M7 bundle fixture");
  if (fixture.schemaVersion !== 1 || fixture.artifactKind !== "portfolio_m7_unprovisioned_fixture_contract" || fixture.fixtureId !== "portfolio_m7_bundle_unprovisioned_v1" || fixture.topology !== TOPOLOGY || fixture.targetVersion !== TARGET_VERSION || fixture.provisioningState !== "unprovisioned_example") fail("M7 fixture identity, topology, version, or provisioning state is invalid.");
  string(fixture.purpose, "fixture.purpose");
  exact(fixture.startingState, ["saveCreation", "communityCenter", "bundleSlot", "playerInventory", "bundleReward", "receipts", "terminalFacts"], "fixture.startingState");
  if (fixture.startingState.saveCreation !== "target_version_native_only" || fixture.startingState.communityCenter !== "ordinary_nonterminal_state" || fixture.startingState.bundleSlot !== "unselected_not_precompleted" || fixture.startingState.playerInventory !== "ordinary_native_inventory" || fixture.startingState.bundleReward !== "not_available_unclaimed" || fixture.startingState.receipts !== "none" || fixture.startingState.terminalFacts !== "absent") fail("M7 fixture starting state is terminal or synthetic.");
  exact(fixture.freshSelectionRequirements, ["slot", "acceptedItemDomain", "quality", "stack", "dispatchBinding", "baseline"], "fixture.freshSelectionRequirements");
  if (fixture.freshSelectionRequirements.slot !== "fresh_opaque_observation" || fixture.freshSelectionRequirements.acceptedItemDomain !== "signed_dsm_bounded_domain" || fixture.freshSelectionRequirements.quality !== "dsm_bound_0_to_4_at_dispatch" || fixture.freshSelectionRequirements.stack !== "dsm_bound_1_to_999_at_dispatch" || fixture.freshSelectionRequirements.dispatchBinding !== "freeze_slot_item_identity_quality_stack_before_native_invocation" || fixture.freshSelectionRequirements.baseline !== "capture_progress_inventory_reward_before_each_transition") fail("M7 fixture selection requirements are invalid.");
  exactArray(fixture.antiFinalStepAssertions, [
    "No contribution or reward claim request, receipt, postcondition, or final-result script occurs during fixture creation.",
    "The slot, item identity, quality, stack, and reward remain unmaterialized until fresh dispatch-time observation.",
    "The fixture contains no completed slot, bundle completion, reward availability, claimed reward, or terminal portfolio fact.",
  ], "fixture.antiFinalStepAssertions");
  exactArray(fixture.forbiddenBehavior, FIXTURE_FORBIDDEN, "fixture.forbiddenBehavior");
  exactArray(fixture.nonClaims, FIXTURE_NON_CLAIMS, "fixture.nonClaims");
  noStaticIdentity(fixture, "fixture");
  return Object.freeze({ fixtureId: fixture.fixtureId, state: "fixture_needed", provisioningState: fixture.provisioningState, terminalState: "absent" });
}

export function validateM7BundleActionContract(contract) {
  exact(contract, ["schemaVersion", "artifactKind", "contractId", "milestone", "topology", "targetVersion", "sourceAudit", "selection", "actions", "sharedRequestGuards", "sharedEvidenceRules", "forbiddenBehavior", "nonClaims", "fixtureContractRef", "implementationStatus", "fixtureStatus", "liveClosure", "publication"], "M7 bundle action contract");
  if (contract.schemaVersion !== 1 || contract.artifactKind !== "portfolio_static_action_contract" || contract.contractId !== "portfolio_m7_bundle_actions_v1" || contract.milestone !== "M7" || contract.topology !== TOPOLOGY || contract.targetVersion !== TARGET_VERSION) fail("M7 action contract identity, milestone, topology, or version is invalid.");
  exact(contract.sourceAudit, ["path", "auditId", "traceFamilyId", "anchorIds", "projectionState", "liveState"], "sourceAudit");
  if (contract.sourceAudit.path !== SOURCE_AUDIT || contract.sourceAudit.auditId !== AUDIT_ID || contract.sourceAudit.traceFamilyId !== TRACE_FAMILY_ID || contract.sourceAudit.projectionState !== "blocked" || contract.sourceAudit.liveState !== "not_performed") fail("M7 source audit identity or non-promotable state is invalid.");
  exactArray(contract.sourceAudit.anchorIds, ANCHORS, "sourceAudit.anchorIds");
  validateSelection(contract.selection);
  if (!Array.isArray(contract.actions) || contract.actions.length !== 2 || JSON.stringify(contract.actions.map((action) => action.actionId)) !== JSON.stringify(ACTIONS)) fail("M7 actions must contain contribution then independent reward claim.");
  validateAction(contract.actions[0], ACTIONS[0]);
  validateAction(contract.actions[1], ACTIONS[1]);
  if (contract.actions[0].nativeBoundary.progress !== "slot_progress_commit_only" || contract.actions[0].nativeBoundary.reward !== "observe_availability_only" || contract.actions[0].nativeBoundary.presentation !== "no_menu_or_callback") fail("contribution must preserve progress/reward/presentation boundaries.");
  if (contract.actions[1].nativeBoundary.progress !== "observe_existing_progress_only" || contract.actions[1].nativeBoundary.reward !== "reward_claim_commit_only" || contract.actions[1].nativeBoundary.presentation !== "typed_non_ui_inventory_transfer") fail("reward claim must preserve progress/reward/presentation boundaries.");
  if (contract.actions[0].commit.transaction !== "contribute_one_selected_bundle_slot" || contract.actions[1].commit.transaction !== "claim_one_selected_bundle_reward" || contract.actions[0].commit.doesNotDo !== "claim_reward_or_complete_bundle" || contract.actions[1].commit.doesNotDo !== "contribute_slot_or_complete_bundle") fail("M7 action commits are not independent and narrow.");
  exact(contract.sharedRequestGuards, ["freshObservation", "opaqueSelectedSlot", "boundedDsmItemIdentityQualityStack", "scope", "gameThread", "revision", "policy", "deadline", "idempotency", "cancel", "state", "noUiOrRawFallback"], "sharedRequestGuards");
  for (const field of Object.keys(contract.sharedRequestGuards)) if (contract.sharedRequestGuards[field] !== true) fail(`sharedRequestGuards.${field} must be true.`);
  exact(contract.sharedEvidenceRules, ["receiptState", "receiptEvidence", "sameExecution", "freshPostcondition", "progressDelta", "rewardAvailabilityDelta", "inventoryDelta", "saveReopen"], "sharedEvidenceRules");
  for (const field of Object.keys(contract.sharedEvidenceRules)) if (contract.sharedEvidenceRules[field] !== true) fail(`sharedEvidenceRules.${field} must be true.`);
  exactArray(contract.forbiddenBehavior, FORBIDDEN, "forbiddenBehavior");
  exactArray(contract.nonClaims, NON_CLAIMS, "nonClaims");
  if (contract.fixtureContractRef !== FIXTURE_REF) fail("fixtureContractRef is invalid.");
  if (contract.implementationStatus !== "implementation_needed" || contract.fixtureStatus !== "fixture_needed" || contract.liveClosure !== "none" || contract.publication !== "none") fail("M7 status must remain implementation_needed/fixture_needed/liveClosure none.");
  noStaticIdentity(contract, "contract");
  return Object.freeze({ state: "implementation_needed", contractKind: "static_action_contract_only", milestone: "M7", actions: ACTIONS, fixtureStatus: "fixture_needed", liveClosure: "none", publication: "none" });
}

async function loadSources(root, audit) {
  return Object.fromEntries(await Promise.all(audit.anchors.map(async ({ relativePath }) => {
    const source = path.resolve(root, SOURCE_ROOT, relativePath);
    const sourceRoot = path.resolve(root, SOURCE_ROOT);
    if (!source.startsWith(`${sourceRoot}${path.sep}`)) fail(`M7 source audit anchor escapes source root: ${relativePath}.`, "portfolio_m7_source_audit_path_escape");
    return [relativePath, await readFile(source)];
  })));
}

export async function checkM7BundleActionContract(contractPath = path.resolve("tools/stardew-portfolio-m7-bundle-action-contract.json"), root = path.resolve(".")) {
  const contract = JSON.parse(await readFile(contractPath, "utf8"));
  const result = validateM7BundleActionContract(contract);
  const fixture = JSON.parse(await readFile(path.resolve(root, FIXTURE_REF), "utf8"));
  const fixtureResult = validateM7BundleFixtureContract(fixture);
  const audit = JSON.parse(await readFile(path.resolve(root, SOURCE_AUDIT), "utf8"));
  if (audit.auditId !== AUDIT_ID || audit.traceFamilyId !== TRACE_FAMILY_ID || audit.topology !== TOPOLOGY) fail("M7 source audit identity does not match the contract.", "portfolio_m7_source_audit_identity_mismatch");
  const auditResult = validatePortfolioM7BundleSourceAudit(audit, await loadSources(root, audit));
  if (auditResult.projectionState !== "blocked" || auditResult.liveState !== "not_performed") fail("M7 source audit promoted unexpectedly.");
  return Object.freeze({ ...result, sourceAuditVerified: true, sourceAudit: auditResult, fixture: fixtureResult, fixtureContract: contract.fixtureContractRef });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const contractPath = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve("tools/stardew-portfolio-m7-bundle-action-contract.json");
    console.log(JSON.stringify(await checkM7BundleActionContract(contractPath), null, 2));
  } catch (error) {
    console.error(`${error.code ?? "portfolio_m7_bundle_action_contract_check_failed"}: ${error.message}`);
    process.exitCode = 1;
  }
}
