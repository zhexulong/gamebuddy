#!/usr/bin/env node
/**
 * Static, fail-closed Batch D contract for the M9 Special Order seam.
 *
 * This artifact is deliberately unprovisioned. It describes the typed
 * boundary, but does not grant capability, select content, execute a native
 * lifecycle, or establish live closure. The implementation and fixture are
 * still needed; menu ownership is not itself treated as a blocker.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validatePortfolioM9SpecialOrderSourceAudit } from "./lib/stardew-portfolio-m9-special-order-source-audit.mjs";

const TARGET = Object.freeze({
  gameVersion: "1.6.15.24356",
  assemblySha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
});
const SOURCE_AUDIT_FILE = "tools/stardew-portfolio-m9-special-order-source-audit.json";
const SOURCE_ROOT = "ref/external/StardewValleyDecompiled/Stardew Valley";
const FIXTURE_REF = "fixtures/stardew/portfolio-m9-special-order-action-contract-unprovisioned.example.json";
const EXPECTED_ANCHORS = Object.freeze([
  "special_order_board_acceptance_commit",
  "special_order_objective_registration",
  "special_order_objective_progress_commit",
  "special_order_completion_reward_availability",
  "special_order_completion_state_commit",
  "special_order_reward_claim_consumption",
  "special_order_reward_grant",
  "special_order_failure_state",
]);
const EXPECTED_ACTIONS = Object.freeze(["accept_special_order_offer", "claim_special_order_reward"]);
const EXPECTED_STATES = Object.freeze([
  "fresh_offer_available",
  "accepted_in_progress",
  "completed_reward_unclaimed",
  "completed_reward_claimed",
  "unselected_domain_no_claim",
]);
const REQUIRED_FORBIDDEN = Object.freeze([
  "generic_special_order_progress_action",
  "generic_special_order_complete_action",
  "ui_board_click_or_menu_callback",
  "raw_dispatcher_or_string_action",
  "keyboard_mouse_xinput_or_visual_input",
  "save_xml_or_direct_save_mutation",
  "synthetic_receipt_or_fixture_postcondition",
  "claim_for_unselected_order_or_reward",
]);
const REQUIRED_NON_CLAIMS = Object.freeze([
  "This contract does not select an order, objective, generation, or reward value.",
  "This contract does not publish either action or establish a target-version live closure.",
  "This contract does not prove objective-specific action equivalence, completion, reward grant, or save/reopen persistence.",
]);
const FIXTURE_FORBIDDEN = Object.freeze([
  "terminal special order, preselected offer, objective, generation, reward, or claimed entitlement",
  "save XML editing, direct team/order/objective/reward mutation, or synthetic receipt/postcondition creation",
  "UI/input automation, board/menu callback invocation, raw dispatcher, or arbitrary native fallback",
]);
const FIXTURE_NON_CLAIMS = Object.freeze([
  "This unprovisioned fixture contract does not create a save, publish an action, or establish live evidence.",
  "Fresh observation must supply opaque offer and generation values; no static IDs are substituted.",
]);

function object(value, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  return true;
}
function exactFields(value, fields, label, errors) {
  if (!object(value, label, errors)) return;
  const expected = new Set(fields);
  for (const field of fields) if (!Object.hasOwn(value, field)) errors.push(`${label}: missing field ${field}.`);
  for (const field of Object.keys(value)) if (!expected.has(field)) errors.push(`${label}: unknown field ${field}.`);
}
function exactArray(value, expected, label, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) errors.push(`${label} must match the bounded policy.`);
}
function nonempty(value, label, errors) {
  if (typeof value !== "string" || value.trim() === "") errors.push(`${label} must be a nonempty string.`);
}
function exactString(value, expected, label, errors) {
  if (value !== expected) errors.push(`${label} is invalid.`);
}
function _boolean(value, label, errors) {
  if (typeof value !== "boolean") errors.push(`${label} must be boolean.`);
}
function selector(value, label, errors) {
  exactFields(value, ["kind", "selectionSource", "resolvedAtDispatch", "valueEmbedded"], label, errors);
  exactString(value?.kind, "opaque_runtime_fact", `${label}.kind`, errors);
  exactString(value?.selectionSource, "frozen_dsm_plus_fresh_observation", `${label}.selectionSource`, errors);
  if (value?.resolvedAtDispatch !== true) errors.push(`${label}.resolvedAtDispatch must be true.`);
  if (value?.valueEmbedded !== false) errors.push(`${label}.valueEmbedded must be false.`);
}
function transition(value, label, errors, expected) {
  exactFields(value, ["from", "to", "nativeFacts", "typedTransaction"], label, errors);
  if (value?.from !== expected.from || value?.to !== expected.to)
    errors.push(`${label} has an invalid state transition.`);
  if (
    !Array.isArray(value?.nativeFacts) ||
    value.nativeFacts.length === 0 ||
    !value.nativeFacts.every((entry) => typeof entry === "string")
  )
    errors.push(`${label}.nativeFacts must be a nonempty string array.`);
  nonempty(value?.typedTransaction, `${label}.typedTransaction`, errors);
}
function sharedBooleanMap(value, fields, label, errors) {
  exactFields(value, fields, label, errors);
  for (const field of fields) if (value?.[field] !== true) errors.push(`${label}.${field} must be true.`);
}
function action(action, expectedId, errors) {
  exactFields(
    action,
    [
      "actionId",
      "actionClass",
      "target",
      "input",
      "eligibility",
      "commit",
      "receiptEvidence",
      "freshPostcondition",
      "doesNotDo",
    ],
    `${expectedId} action`,
    errors,
  );
  exactString(action?.actionId, expectedId, `${expectedId}.actionId`, errors);
  exactString(action?.actionClass, "primitive", `${expectedId}.actionClass`, errors);
  selector(action?.target, `${expectedId}.target`, errors);
  exactFields(
    action?.input,
    expectedId === "accept_special_order_offer" ? ["offerTarget", "generation"] : ["orderKey", "generation", "reward"],
    `${expectedId}.input`,
    errors,
  );
  for (const value of Object.values(action?.input ?? {}))
    exactString(value, "selectedDomain.reference", `${expectedId}.input`, errors);
  exactFields(
    action?.receiptEvidence,
    ["sameExecution", "successState", "evidenceNonEmpty", "actionSpecific"],
    `${expectedId}.receiptEvidence`,
    errors,
  );
  if (
    action?.receiptEvidence?.sameExecution !== true ||
    action?.receiptEvidence?.successState !== "succeeded" ||
    action?.receiptEvidence?.evidenceNonEmpty !== true ||
    action?.receiptEvidence?.actionSpecific !== true
  )
    errors.push(`${expectedId}.receiptEvidence is not authoritative-shaped.`);
  if (
    !Array.isArray(action?.freshPostcondition) ||
    action.freshPostcondition.length === 0 ||
    !action.freshPostcondition.every((entry) => typeof entry === "string")
  )
    errors.push(`${expectedId}.freshPostcondition must be a nonempty string array.`);
  exactString(action?.doesNotDo, "ui_or_raw_dispatch_or_save_mutation", `${expectedId}.doesNotDo`, errors);
}

export function validateM9SpecialOrderActionContract(contract) {
  const errors = [];
  exactFields(
    contract,
    [
      "schemaVersion",
      "artifactKind",
      "contractId",
      "milestone",
      "topology",
      "target",
      "sourceAudit",
      "selectedDomain",
      "objectiveBoundary",
      "actions",
      "stateMachine",
      "sharedRequestGuards",
      "sharedEvidenceRules",
      "status",
      "forbiddenBehavior",
      "nonClaims",
      "fixtureContractRef",
    ],
    "contract",
    errors,
  );
  if (contract?.schemaVersion !== 1) errors.push("contract.schemaVersion must be 1.");
  exactString(contract?.artifactKind, "portfolio_m9_action_contract", "contract.artifactKind", errors);
  exactString(contract?.contractId, "portfolio_m9_special_order_action_contract_v1", "contract.contractId", errors);
  exactString(contract?.milestone, "M9", "contract.milestone", errors);
  exactString(contract?.topology, "single_player_native_companion", "contract.topology", errors);

  exactFields(contract?.target, ["gameVersion", "assemblySha256"], "target", errors);
  for (const [field, expected] of Object.entries(TARGET))
    exactString(contract?.target?.[field], expected, `target.${field}`, errors);

  exactFields(
    contract?.sourceAudit,
    ["auditId", "traceFamilyId", "sourceAuditFile", "anchorIds", "projectionState", "liveState"],
    "sourceAudit",
    errors,
  );
  exactString(
    contract?.sourceAudit?.auditId,
    "portfolio_m9_special_order_source_audit_v1",
    "sourceAudit.auditId",
    errors,
  );
  exactString(
    contract?.sourceAudit?.traceFamilyId,
    "portfolio_m9_special_order_to_reward",
    "sourceAudit.traceFamilyId",
    errors,
  );
  exactString(contract?.sourceAudit?.sourceAuditFile, SOURCE_AUDIT_FILE, "sourceAudit.sourceAuditFile", errors);
  exactArray(contract?.sourceAudit?.anchorIds, EXPECTED_ANCHORS, "sourceAudit.anchorIds", errors);
  exactString(contract?.sourceAudit?.projectionState, "blocked", "sourceAudit.projectionState", errors);
  exactString(contract?.sourceAudit?.liveState, "not_performed", "sourceAudit.liveState", errors);

  exactFields(
    contract?.selectedDomain,
    ["offerTarget", "orderKey", "generation", "objectiveSet", "reward", "selectionRule"],
    "selectedDomain",
    errors,
  );
  for (const field of ["offerTarget", "orderKey", "generation", "objectiveSet", "reward"])
    selector(contract?.selectedDomain?.[field], `selectedDomain.${field}`, errors);
  exactString(
    contract?.selectedDomain?.selectionRule,
    "DSM selects finite content; fresh observation supplies opaque offer and generation; no static ID is accepted",
    "selectedDomain.selectionRule",
    errors,
  );

  exactFields(
    contract?.objectiveBoundary,
    [
      "sourceDerivedStages",
      "objectiveWorkPolicy",
      "allowedObjectiveIngress",
      "genericProgressAction",
      "genericCompleteAction",
      "completionObservation",
    ],
    "objectiveBoundary",
    errors,
  );
  exactArray(
    contract?.objectiveBoundary?.sourceDerivedStages,
    [
      "objective_registration_is_native_order_lifecycle",
      "objective_specific_progress_commit",
      "order_completion_sets_complete_and_participant_reward_entitlement",
    ],
    "objectiveBoundary.sourceDerivedStages",
    errors,
  );
  exactFields(
    contract?.objectiveBoundary?.objectiveWorkPolicy,
    ["mode", "selectionRequirement", "runtimeClaim"],
    "objectiveBoundary.objectiveWorkPolicy",
    errors,
  );
  exactString(
    contract?.objectiveBoundary?.objectiveWorkPolicy?.mode,
    "reuse_or_separately_selected",
    "objectiveWorkPolicy.mode",
    errors,
  );
  exactString(
    contract?.objectiveBoundary?.objectiveWorkPolicy?.selectionRequirement,
    "each objective must map to an existing equivalent typed action or an independently selected typed objective action",
    "objectiveWorkPolicy.selectionRequirement",
    errors,
  );
  exactString(
    contract?.objectiveBoundary?.objectiveWorkPolicy?.runtimeClaim,
    "unselected objective domains are observable only and cannot be claimed",
    "objectiveWorkPolicy.runtimeClaim",
    errors,
  );
  exactString(
    contract?.objectiveBoundary?.allowedObjectiveIngress,
    "existing_equivalent_action_or_separately_selected_typed_objective_action",
    "allowedObjectiveIngress",
    errors,
  );
  exactString(contract?.objectiveBoundary?.genericProgressAction, "prohibited", "genericProgressAction", errors);
  exactString(contract?.objectiveBoundary?.genericCompleteAction, "prohibited", "genericCompleteAction", errors);
  exactFields(
    contract?.objectiveBoundary?.completionObservation,
    [
      "requiresAllSelectedObjectivesComplete",
      "requiresNativeCompleteState",
      "requiresRewardEntitlement",
      "doesNotClaimReward",
    ],
    "completionObservation",
    errors,
  );
  for (const field of [
    "requiresAllSelectedObjectivesComplete",
    "requiresNativeCompleteState",
    "requiresRewardEntitlement",
    "doesNotClaimReward",
  ])
    if (contract?.objectiveBoundary?.completionObservation?.[field] !== true)
      errors.push(`completionObservation.${field} must be true.`);

  if (!Array.isArray(contract?.actions) || contract.actions.length !== 2)
    errors.push("actions must contain exactly the two distinct M9 actions.");
  else {
    if (JSON.stringify(contract.actions.map((entry) => entry?.actionId)) !== JSON.stringify(EXPECTED_ACTIONS))
      errors.push("actions must be ordered accept then claim and contain no generic action.");
    action(contract.actions[0], EXPECTED_ACTIONS[0], errors);
    action(contract.actions[1], EXPECTED_ACTIONS[1], errors);
    exactFields(
      contract.actions[0]?.eligibility,
      [
        "offerFresh",
        "offerSelectedByDsm",
        "generationMatchesOffer",
        "orderTypeNotAlreadyAccepted",
        "playerEligible",
        "unselectedDomainRejected",
      ],
      "accept eligibility",
      errors,
    );
    for (const field of [
      "offerFresh",
      "offerSelectedByDsm",
      "generationMatchesOffer",
      "orderTypeNotAlreadyAccepted",
      "playerEligible",
      "unselectedDomainRejected",
    ])
      if (contract.actions[0]?.eligibility?.[field] !== true) errors.push(`accept eligibility.${field} must be true.`);
    exactFields(
      contract.actions[0]?.commit,
      ["transaction", "nativeEffects", "separateFromRewardClaim"],
      "accept commit",
      errors,
    );
    exactString(contract.actions[0]?.commit?.transaction, "accept_offer", "accept commit.transaction", errors);
    exactArray(
      contract.actions[0]?.commit?.nativeEffects,
      ["accepted_special_order_type_added", "generated_order_key_and_generation_added_to_native_team_state"],
      "accept commit.nativeEffects",
      errors,
    );
    if (contract.actions[0]?.commit?.separateFromRewardClaim !== true)
      errors.push("accept must be separate from reward claim.");
    exactFields(
      contract.actions[1]?.eligibility,
      [
        "nativeOrderComplete",
        "participantRewardUnclaimed",
        "selectedOrderMatches",
        "alreadyClaimedRejected",
        "unselectedDomainRejected",
      ],
      "claim eligibility",
      errors,
    );
    for (const field of [
      "nativeOrderComplete",
      "participantRewardUnclaimed",
      "selectedOrderMatches",
      "alreadyClaimedRejected",
      "unselectedDomainRejected",
    ])
      if (contract.actions[1]?.eligibility?.[field] !== true) errors.push(`claim eligibility.${field} must be true.`);
    exactFields(
      contract.actions[1]?.commit,
      ["transaction", "nativeEffects", "separateFromOfferAcceptance"],
      "claim commit",
      errors,
    );
    exactString(contract.actions[1]?.commit?.transaction, "claim_reward", "claim commit.transaction", errors);
    exactArray(
      contract.actions[1]?.commit?.nativeEffects,
      ["participant_reward_entitlement_consumed", "native_reward_granted"],
      "claim commit.nativeEffects",
      errors,
    );
    if (contract.actions[1]?.commit?.separateFromOfferAcceptance !== true)
      errors.push("claim must be separate from offer acceptance.");
  }

  exactFields(contract?.stateMachine, ["states", "transitions", "unselectedDomainRule"], "stateMachine", errors);
  exactArray(contract?.stateMachine?.states, EXPECTED_STATES, "stateMachine.states", errors);
  const expectedTransitions = [
    ["fresh_offer_available", "accepted_in_progress"],
    ["accepted_in_progress", "completed_reward_unclaimed"],
    ["completed_reward_unclaimed", "completed_reward_claimed"],
  ];
  if (
    !Array.isArray(contract?.stateMachine?.transitions) ||
    contract.stateMachine.transitions.length !== expectedTransitions.length
  )
    errors.push("stateMachine.transitions must contain exactly three native transitions.");
  else
    contract.stateMachine.transitions.forEach((entry, index) =>
      transition(entry, `stateMachine.transitions[${index}]`, errors, {
        from: expectedTransitions[index][0],
        to: expectedTransitions[index][1],
      }),
    );
  exactString(
    contract?.stateMachine?.unselectedDomainRule,
    "unselected offer/objective/reward state may be observed but has no runtime claim route",
    "stateMachine.unselectedDomainRule",
    errors,
  );

  sharedBooleanMap(
    contract?.sharedRequestGuards,
    [
      "freshObservation",
      "opaqueOffer",
      "opaqueGeneration",
      "scope",
      "gameThread",
      "revision",
      "policy",
      "deadline",
      "idempotency",
      "cancel",
      "gameState",
      "noUiOrRawFallback",
    ],
    "sharedRequestGuards",
    errors,
  );
  sharedBooleanMap(
    contract?.sharedEvidenceRules,
    [
      "receiptState",
      "receiptEvidence",
      "postcondition",
      "sameExecution",
      "objectiveSpecific",
      "rewardEntitlement",
      "saveReopen",
    ],
    "sharedEvidenceRules",
    errors,
  );
  exactFields(contract?.status, ["implementation", "fixture", "liveClosure"], "status", errors);
  exactString(contract?.status?.implementation, "implementation_needed", "status.implementation", errors);
  exactString(contract?.status?.fixture, "fixture_needed", "status.fixture", errors);
  exactString(contract?.status?.liveClosure, "none", "status.liveClosure", errors);
  exactArray(contract?.forbiddenBehavior, REQUIRED_FORBIDDEN, "forbiddenBehavior", errors);
  exactArray(contract?.nonClaims, REQUIRED_NON_CLAIMS, "nonClaims", errors);
  exactString(contract?.fixtureContractRef, FIXTURE_REF, "fixtureContractRef", errors);
  return errors;
}

export function validateM9SpecialOrderUnprovisionedFixture(fixture) {
  const errors = [];
  exactFields(
    fixture,
    [
      "schemaVersion",
      "artifactKind",
      "fixtureId",
      "topology",
      "targetVersion",
      "purpose",
      "startingState",
      "freshSelectionRequirements",
      "antiFinalStepAssertions",
      "forbiddenBehavior",
      "nonClaims",
      "status",
    ],
    "fixture",
    errors,
  );
  if (fixture?.schemaVersion !== 1) errors.push("fixture.schemaVersion must be 1.");
  exactString(fixture?.artifactKind, "portfolio_m9_unprovisioned_fixture_contract", "fixture.artifactKind", errors);
  exactString(fixture?.fixtureId, "portfolio_m9_special_order_unprovisioned_v1", "fixture.fixtureId", errors);
  exactString(fixture?.topology, "single_player_native_companion", "fixture.topology", errors);
  exactString(fixture?.targetVersion, TARGET.gameVersion, "fixture.targetVersion", errors);
  nonempty(fixture?.purpose, "fixture.purpose", errors);
  exactFields(
    fixture?.startingState,
    [
      "saveCreatedBy",
      "specialOrderState",
      "selectedOffer",
      "selectedGeneration",
      "selectedObjectives",
      "rewardEntitlement",
      "terminalFacts",
    ],
    "fixture.startingState",
    errors,
  );
  for (const [field, expected] of Object.entries({
    saveCreatedBy: "target_version_native_only",
    specialOrderState: "ordinary_nonterminal_or_absent",
    selectedOffer: "unselected",
    selectedGeneration: "unselected",
    selectedObjectives: "unselected",
    rewardEntitlement: "absent",
    terminalFacts: "absent",
  }))
    exactString(fixture?.startingState?.[field], expected, `fixture.startingState.${field}`, errors);
  exactFields(
    fixture?.freshSelectionRequirements,
    ["offer", "generation", "objectiveSet", "reward", "revalidation"],
    "fixture.freshSelectionRequirements",
    errors,
  );
  for (const [field, expected] of Object.entries({
    offer: "fresh_opaque_observation",
    generation: "fresh_opaque_observation_matching_offer",
    objectiveSet: "frozen_dsm_finite_set_then_fresh_native_observation",
    reward: "frozen_dsm_content_then_fresh_native_observation",
    revalidation: "game_thread_before_each_typed_transaction",
  }))
    exactString(
      fixture?.freshSelectionRequirements?.[field],
      expected,
      `fixture.freshSelectionRequirements.${field}`,
      errors,
    );
  exactArray(
    fixture?.antiFinalStepAssertions,
    [
      "No offer acceptance, objective progress, completion, reward claim, receipt, postcondition, or final-result script occurs during fixture creation.",
      "No static order key, generation seed, objective ID, or reward ID substitutes for an opaque unselected value.",
      "The fixture contains no terminal completion state, participant entitlement, reward inventory delta, or claimed reward.",
    ],
    "fixture.antiFinalStepAssertions",
    errors,
  );
  exactArray(fixture?.forbiddenBehavior, FIXTURE_FORBIDDEN, "fixture.forbiddenBehavior", errors);
  exactArray(fixture?.nonClaims, FIXTURE_NON_CLAIMS, "fixture.nonClaims", errors);
  exactFields(fixture?.status, ["state", "liveClosure"], "fixture.status", errors);
  exactString(fixture?.status?.state, "fixture_needed", "fixture.status.state", errors);
  exactString(fixture?.status?.liveClosure, "none", "fixture.status.liveClosure", errors);
  return errors;
}

function issue(message) {
  return `m9-special-order-action-contract: ${message}`;
}
async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read or parse ${file}: ${error.message}`);
  }
}
async function loadAndValidate(contractFile, root = process.cwd()) {
  const contract = await readJson(contractFile);
  const errors = validateM9SpecialOrderActionContract(contract);
  if (errors.length) {
    const error = new Error(errors.map(issue).join("\n"));
    error.code = "m9_special_order_action_contract_invalid";
    throw error;
  }
  const fixturePath = path.resolve(root, contract.fixtureContractRef);
  const fixture = await readJson(fixturePath);
  const fixtureErrors = validateM9SpecialOrderUnprovisionedFixture(fixture);
  if (fixtureErrors.length) {
    const error = new Error(fixtureErrors.map(issue).join("\n"));
    error.code = "m9_special_order_fixture_contract_invalid";
    throw error;
  }
  const auditPath = path.resolve(root, SOURCE_AUDIT_FILE);
  const audit = await readJson(auditPath);
  const sourceFiles = Object.fromEntries(
    await Promise.all(
      audit.anchors.map(async (anchor) => [
        anchor.relativePath,
        await readFile(path.resolve(root, SOURCE_ROOT, anchor.relativePath)),
      ]),
    ),
  );
  const auditResult = validatePortfolioM9SpecialOrderSourceAudit(audit, sourceFiles);
  if (audit.auditId !== contract.sourceAudit.auditId || audit.traceFamilyId !== contract.sourceAudit.traceFamilyId)
    throw new Error(issue("contract/audit identity mismatch."));
  return Object.freeze({
    state: "implementation_needed",
    contractKind: "portfolio_action_contract",
    milestone: "M9",
    actions: EXPECTED_ACTIONS,
    sourceAuditVerified: true,
    sourceAudit: auditResult,
    projectionState: "blocked",
    implementationStatus: "implementation_needed",
    fixtureStatus: "fixture_needed",
    liveClosure: "none",
    closure: "none",
    fixtureContractRef: contract.fixtureContractRef,
  });
}

export async function checkM9SpecialOrderActionContract(contractFile, root = process.cwd()) {
  return loadAndValidate(contractFile, root);
}
function parseContractArg(argv) {
  const index = argv.indexOf("--contract");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--") || argv.slice(index + 2).length)
    throw new Error("Usage: node tools/stardew-portfolio-m9-special-order-action-contract.mjs --contract <path>");
  return path.resolve(argv[index + 1]);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(
      JSON.stringify(await checkM9SpecialOrderActionContract(parseContractArg(process.argv.slice(2))), null, 2),
    );
  } catch (error) {
    console.error(`${error.code ?? "m9_special_order_action_contract_check_failed"}: ${error.message}`);
    process.exitCode = 1;
  }
}
