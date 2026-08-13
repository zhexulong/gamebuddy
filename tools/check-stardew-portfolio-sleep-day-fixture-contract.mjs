#!/usr/bin/env node
/**
 * Deterministic, fail-closed validator for the metadata-only single-player
 * sleep/day fixture contract. It never provisions a save, starts Stardew,
 * attaches a bridge, mutates gameplay state, or executes an action.
 */
import { readFile } from "node:fs/promises";
import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APPROVED_TARGET = Object.freeze({
  gameVersion: "1.6.15.24356",
  assemblySha256: "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee",
  contentHashesSha256: "8143aa3110810e0039282ab8e9989417092388edb84c8c3b6c0b6f23840a4349",
});
const TOPOLOGY = "single_player_native_companion";
const FIXTURE_ID = "GameBuddyPortfolioFixture_SleepDay_1_6_15";
const ACTION = "single_player_sleep_and_advance_day";
const CONTRACT_ID = "portfolio_sleep_day_fixture_contract_v1";
const PURPOSE =
  "Static, read-only provenance and lifecycle contract for a lawful nonterminal single-player sleep/day fixture; it is not a production request, receipt, template success, or live-closure artifact.";

const ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "contractId",
  "fixtureId",
  "action",
  "topology",
  "target",
  "fixtureStatus",
  "purpose",
  "startingFacts",
  "productionOutcomeOnly",
  "traceIdentity",
  "phaseSequence",
  "irreversibleBoundary",
  "receiptPredicate",
  "freshObservations",
  "teardownRestore",
  "fixtureCreationRules",
  "prohibitedOperations",
  "nonClaims",
]);
const TARGET_FIELDS = Object.freeze(["gameVersion", "assemblySha256", "contentHashesSha256"]);
const STATUS_FIELDS = Object.freeze([
  "state",
  "liveClosure",
  "templateState",
  "productionAdapterState",
  "successClaimAllowed",
]);
const STARTING_FACT_FIELDS = Object.freeze([
  "requiresSinglePlayerLocalCurrentPlayer",
  "requiresTopology",
  "requiresCurrentNativeLocalPlayer",
  "requiresSleepEligibleState",
  "requiresNoActiveMenu",
  "requiresNoActiveEvent",
  "requiresNoActiveMinigame",
  "requiresActionablePlayer",
  "requiresFreshObservation",
  "requiresCurrentRevision",
  "nonterminalCropPrecondition",
  "nonterminalAnimalPrecondition",
  "nonterminalMachinePrecondition",
  "fixtureMustNotAdvanceDateOrDay",
  "fixtureMustNotMutateGameplayState",
  "fixtureMustNotWriteReceiptOrPostcondition",
]);
const CROP_FIELDS = Object.freeze([
  "present",
  "planted",
  "watered",
  "readyForHarvest",
  "terminalHarvestResult",
]);
const ANIMAL_FIELDS = Object.freeze([
  "present",
  "adult",
  "ownedByCurrentPlayer",
  "fedToday",
  "currentProduce",
  "terminalProductResult",
]);
const MACHINE_FIELDS = Object.freeze([
  "present",
  "ownedByCurrentPlayer",
  "loaded",
  "readyForHarvest",
  "heldOutput",
  "terminalOutputResult",
]);
const PRODUCTION_FIELDS = Object.freeze([
  "requiredLifecycle",
  "dateDayAdvanceOwnedBy",
  "fixtureDateDayAdvance",
  "fixtureStateAdvance",
  "directNewDayAllowed",
  "productionSuccessRequiresRunnableLawfulAdapter",
]);
const TRACE_FIELDS = Object.freeze([
  "requiredFields",
  "fixedTopology",
  "identityMustRemainStableThrough",
  "reopenRequiresNewBindingGeneration",
  "oldRequestCannotSucceedAfterReopen",
  "opaqueTargetIdsMustComeFromFreshObservation",
]);
const RECEIPT_FIELDS = Object.freeze([
  "sameExecutionRequired",
  "requiredState",
  "requiredReasonCode",
  "requiresNonEmptyEvidence",
  "requiredIdentityMatches",
  "requiredEvidence",
  "authoritativelyCompletedOnlyWhen",
  "fixtureReceiptForbidden",
]);
const OBSERVATION_FIELDS = Object.freeze(["mustBeFreshAfterReceipt", "requiredFacts", "mustNotBeFixtureWritten"]);
const REOPEN_OBSERVATION_FIELDS = Object.freeze([
  "mustBeFreshAfterClose",
  "requiredFacts",
  "oldBindingGenerationMustBeRejected",
  "mustNotBeFixtureWritten",
]);
const TEARDOWN_FIELDS = Object.freeze(["required", "steps", "restoreMustNot"]);

const PHASE_SEQUENCE = Object.freeze([
  "fresh_start_observation",
  "sleep_eligibility_revalidation",
  "typed_request_accepted",
  "native_sleep_transition",
  "Saving",
  "Saved",
  "DayStarted",
  "controlled_close",
  "reopen_same_save",
  "fresh_reopen_observation",
  "teardown_and_restore",
]);
const REQUIRED_PRODUCTION_LIFECYCLE = Object.freeze([
  "normal native local-player sleep interaction",
  "native Saving",
  "native Saved",
  "native DayStarted/new-day transition",
  "controlled close",
  "reopen same isolated save",
  "fresh post-reopen observation",
]);
const REQUIRED_TRACE_FIELDS = Object.freeze([
  "traceId",
  "topology",
  "saveId",
  "worldId",
  "localPlayerId",
  "companionId",
  "bindingGeneration",
  "requestId",
  "executionId",
  "startRevision",
  "terminalRevision",
  "targetGameVersion",
]);
const REQUIRED_STABLE_IDENTITY_PHASES = Object.freeze([
  "request",
  "Saving",
  "Saved",
  "DayStarted",
  "close",
  "reopen",
]);
const REQUIRED_DAY_STARTED_FACTS = Object.freeze([
  "newDayIdentity",
  "currentLocalPlayerId",
  "saveId",
  "worldId",
  "bindingGeneration",
  "revision",
]);
const REQUIRED_REOPEN_FACTS = Object.freeze([
  "sameSaveId",
  "sameWorldId",
  "currentLocalPlayerId",
  "newBindingGeneration",
  "newRevision",
  "dayIdentityPersisted",
]);
const REQUIRED_RECEIPT_IDENTITIES = Object.freeze([
  "traceId",
  "topology",
  "saveId",
  "worldId",
  "localPlayerId",
  "companionId",
  "bindingGeneration",
  "requestId",
  "executionId",
]);
const REQUIRED_RECEIPT_EVIDENCE = Object.freeze([
  "nativeSleepObserved",
  "savingObserved",
  "savedObserved",
  "dayStartedObserved",
  "newDayIdentity",
  "closeObserved",
  "reopenObserved",
]);
const REQUIRED_COMPLETION_CONDITIONS = Object.freeze([
  "same execution has succeeded receipt",
  "receipt evidence is non-empty and phase-complete",
  "fresh DayStarted observation matches the new-day identity",
  "fresh reopen observation matches the persisted production result",
  "no cancellation, stale revision, disconnect, scope drift, or identity mismatch occurred",
]);
const REQUIRED_TEARDOWN_STEPS = Object.freeze([
  "stop and quiesce the production adapter before cleanup",
  "close the isolated game/save session through its native lifecycle",
  "restore only files listed in the controlled backup manifest",
  "verify restored files byte-for-byte by recorded hashes",
  "remove only registered fixture-owned files",
  "leave unmanaged files untouched",
  "inspect for locks, reparse paths, receipts, traces, and residue",
  "report cleanup failure as blocked",
]);
const REQUIRED_TEARDOWN_PROHIBITIONS = Object.freeze([
  "delete unmanaged files",
  "adopt an existing save or profile",
  "turn a failed or partial trace into success",
]);
const REQUIRED_FIXTURE_RULES = Object.freeze([
  "Create or inspect the starting save through target-version native Stardew only.",
  "Record no concrete opaque target ID, receipt, execution, result, or postcondition in the fixture.",
  "The fixture may establish only the lawful nonterminal starting facts listed in this contract.",
  "The fixture must remain unprovisioned until a lawful adapter and runnable trace exist.",
  "A missing, ambiguous, terminal, contaminated, or advanced starting state fails closed.",
]);
const REQUIRED_PROHIBITED_OPERATIONS = Object.freeze([
  "direct Game1.NewDay or any direct NewDay call",
  "direct startSleep or doSleep invocation",
  "UI dispatcher, dialogue dispatcher, menu callback, or raw dispatcher",
  "keyboard, mouse, XInput, visual, window, or input automation",
  "save XML editing, save-file editing, date/day mutation, or state injection",
  "fixture-created Saving, Saved, DayStarted, receipt, evidence, or postcondition",
  "debug/console/helper completion, preloaded final result, or terminal-state fixture",
  "using Farmhand, preview, or deterministic model evidence as Portfolio evidence",
]);
const REQUIRED_NON_CLAIMS = Object.freeze([
  "This contract does not implement or publish single_player_sleep_and_advance_day.",
  "This contract does not provide a template save, action success, live closure, or Portfolio release evidence.",
  "M2, M5, and M6 aggregate milestones remain unverified until their own native action composition and fresh persistence evidence exist.",
  "A static checker or runner result cannot replace a lawful target-version game-thread adapter and runnable native trace.",
]);

function fail(errors) {
  const error = new Error(errors.join("\n"));
  error.code = "stardew_portfolio_sleep_day_fixture_contract_invalid";
  throw error;
}

function hasExactFields(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return false;
  }
  const expectedSet = new Set(expected);
  for (const field of expected) {
    if (!Object.hasOwn(value, field)) errors.push(`${label}: missing field ${field}.`);
  }
  for (const field of Object.keys(value)) {
    if (!expectedSet.has(field)) errors.push(`${label}: unknown field ${field}.`);
  }
  return true;
}

function exactArray(actual, expected, label, errors) {
  if (!Array.isArray(actual)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    errors.push(`${label} must match the approved bounded policy.`);
  }
}

function exactValue(actual, expected, label, errors) {
  if (actual !== expected) errors.push(`${label} must be ${JSON.stringify(expected)}.`);
}

function exactBooleanFields(value, fields, label, errors) {
  for (const field of fields) exactValue(value?.[field], true, `${label}.${field}`, errors);
}

function scanForConcreteRuntimeIds(value, location, errors) {
  if (typeof value === "string") {
    // Runtime identifiers are deliberately absent from this metadata contract.
    // Hashes are allowed only through the exact target checks above.
    if (
      /(?:^|[^a-z0-9])(?:trace|execution|target|save|world|player|companion|binding)[_-][a-z0-9]{8,}(?:$|[^a-z0-9])/i.test(
        value,
      ) ||
      /(?:^|[^a-z0-9])request[_-](?!accepted(?:$|[^a-z0-9]))[a-z0-9]{8,}(?:$|[^a-z0-9])/i.test(value) ||
      /(?:^|[^a-z0-9])(?:crab[_-]?pot|target|pot)[_-][a-f0-9]{12,}(?:$|[^a-z0-9])/i.test(value)
    ) {
      errors.push(`${location} contains a concrete runtime or opaque target ID.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForConcreteRuntimeIds(entry, `${location}[${index}]`, errors));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) scanForConcreteRuntimeIds(entry, `${location}.${key}`, errors);
  }
}

export function validateStardewPortfolioSleepDayFixtureContract(contract) {
  const errors = [];
  hasExactFields(contract, ROOT_FIELDS, "contract", errors);
  exactValue(contract?.schemaVersion, 1, "contract.schemaVersion", errors);
  exactValue(contract?.contractId, CONTRACT_ID, "contract.contractId", errors);
  exactValue(contract?.fixtureId, FIXTURE_ID, "contract.fixtureId", errors);
  exactValue(contract?.action, ACTION, "contract.action", errors);
  exactValue(contract?.topology, TOPOLOGY, "contract.topology", errors);
  exactValue(contract?.purpose, PURPOSE, "contract.purpose", errors);

  hasExactFields(contract?.target, TARGET_FIELDS, "target", errors);
  for (const field of TARGET_FIELDS) exactValue(contract?.target?.[field], APPROVED_TARGET[field], `target.${field}`, errors);

  hasExactFields(contract?.fixtureStatus, STATUS_FIELDS, "fixtureStatus", errors);
  exactValue(contract?.fixtureStatus?.state, "fixture_needed", "fixtureStatus.state", errors);
  exactValue(contract?.fixtureStatus?.liveClosure, "none", "fixtureStatus.liveClosure", errors);
  exactValue(contract?.fixtureStatus?.templateState, "unprovisioned", "fixtureStatus.templateState", errors);
  exactValue(contract?.fixtureStatus?.productionAdapterState, "not_implemented", "fixtureStatus.productionAdapterState", errors);
  exactValue(contract?.fixtureStatus?.successClaimAllowed, false, "fixtureStatus.successClaimAllowed", errors);

  hasExactFields(contract?.startingFacts, STARTING_FACT_FIELDS, "startingFacts", errors);
  exactBooleanFields(
    contract?.startingFacts,
    [
      "requiresSinglePlayerLocalCurrentPlayer",
      "requiresCurrentNativeLocalPlayer",
      "requiresSleepEligibleState",
      "requiresNoActiveMenu",
      "requiresNoActiveEvent",
      "requiresNoActiveMinigame",
      "requiresActionablePlayer",
      "requiresFreshObservation",
      "requiresCurrentRevision",
      "fixtureMustNotAdvanceDateOrDay",
      "fixtureMustNotMutateGameplayState",
      "fixtureMustNotWriteReceiptOrPostcondition",
    ],
    "startingFacts",
    errors,
  );
  exactValue(contract?.startingFacts?.requiresTopology, TOPOLOGY, "startingFacts.requiresTopology", errors);
  hasExactFields(contract?.startingFacts?.nonterminalCropPrecondition, CROP_FIELDS, "startingFacts.nonterminalCropPrecondition", errors);
  exactBooleanFields(contract?.startingFacts?.nonterminalCropPrecondition, ["present", "planted", "watered"], "startingFacts.nonterminalCropPrecondition", errors);
  exactValue(contract?.startingFacts?.nonterminalCropPrecondition?.readyForHarvest, false, "startingFacts.nonterminalCropPrecondition.readyForHarvest", errors);
  exactValue(contract?.startingFacts?.nonterminalCropPrecondition?.terminalHarvestResult, false, "startingFacts.nonterminalCropPrecondition.terminalHarvestResult", errors);
  hasExactFields(contract?.startingFacts?.nonterminalAnimalPrecondition, ANIMAL_FIELDS, "startingFacts.nonterminalAnimalPrecondition", errors);
  exactBooleanFields(contract?.startingFacts?.nonterminalAnimalPrecondition, ["present", "adult", "ownedByCurrentPlayer", "fedToday"], "startingFacts.nonterminalAnimalPrecondition", errors);
  exactValue(contract?.startingFacts?.nonterminalAnimalPrecondition?.currentProduce, null, "startingFacts.nonterminalAnimalPrecondition.currentProduce", errors);
  exactValue(contract?.startingFacts?.nonterminalAnimalPrecondition?.terminalProductResult, false, "startingFacts.nonterminalAnimalPrecondition.terminalProductResult", errors);
  hasExactFields(contract?.startingFacts?.nonterminalMachinePrecondition, MACHINE_FIELDS, "startingFacts.nonterminalMachinePrecondition", errors);
  exactBooleanFields(contract?.startingFacts?.nonterminalMachinePrecondition, ["present", "ownedByCurrentPlayer", "loaded"], "startingFacts.nonterminalMachinePrecondition", errors);
  exactValue(contract?.startingFacts?.nonterminalMachinePrecondition?.readyForHarvest, false, "startingFacts.nonterminalMachinePrecondition.readyForHarvest", errors);
  exactValue(contract?.startingFacts?.nonterminalMachinePrecondition?.heldOutput, null, "startingFacts.nonterminalMachinePrecondition.heldOutput", errors);
  exactValue(contract?.startingFacts?.nonterminalMachinePrecondition?.terminalOutputResult, false, "startingFacts.nonterminalMachinePrecondition.terminalOutputResult", errors);

  hasExactFields(contract?.productionOutcomeOnly, PRODUCTION_FIELDS, "productionOutcomeOnly", errors);
  exactArray(contract?.productionOutcomeOnly?.requiredLifecycle, REQUIRED_PRODUCTION_LIFECYCLE, "productionOutcomeOnly.requiredLifecycle", errors);
  exactValue(contract?.productionOutcomeOnly?.dateDayAdvanceOwnedBy, "production_native_game_lifecycle_only", "productionOutcomeOnly.dateDayAdvanceOwnedBy", errors);
  exactValue(contract?.productionOutcomeOnly?.fixtureDateDayAdvance, "none", "productionOutcomeOnly.fixtureDateDayAdvance", errors);
  exactValue(contract?.productionOutcomeOnly?.fixtureStateAdvance, "none", "productionOutcomeOnly.fixtureStateAdvance", errors);
  exactValue(contract?.productionOutcomeOnly?.directNewDayAllowed, false, "productionOutcomeOnly.directNewDayAllowed", errors);
  exactValue(contract?.productionOutcomeOnly?.productionSuccessRequiresRunnableLawfulAdapter, true, "productionOutcomeOnly.productionSuccessRequiresRunnableLawfulAdapter", errors);

  hasExactFields(contract?.traceIdentity, TRACE_FIELDS, "traceIdentity", errors);
  exactArray(contract?.traceIdentity?.requiredFields, REQUIRED_TRACE_FIELDS, "traceIdentity.requiredFields", errors);
  exactValue(contract?.traceIdentity?.fixedTopology, TOPOLOGY, "traceIdentity.fixedTopology", errors);
  exactArray(contract?.traceIdentity?.identityMustRemainStableThrough, REQUIRED_STABLE_IDENTITY_PHASES, "traceIdentity.identityMustRemainStableThrough", errors);
  exactValue(contract?.traceIdentity?.reopenRequiresNewBindingGeneration, true, "traceIdentity.reopenRequiresNewBindingGeneration", errors);
  exactValue(contract?.traceIdentity?.oldRequestCannotSucceedAfterReopen, true, "traceIdentity.oldRequestCannotSucceedAfterReopen", errors);
  exactValue(contract?.traceIdentity?.opaqueTargetIdsMustComeFromFreshObservation, true, "traceIdentity.opaqueTargetIdsMustComeFromFreshObservation", errors);

  exactArray(contract?.phaseSequence, PHASE_SEQUENCE, "phaseSequence", errors);
  exactValue(
    contract?.irreversibleBoundary,
    "typed_request_accepted_after_game_thread_revalidation_is the last cancellation-safe boundary; native_sleep_transition may commit the native sleep/save lifecycle and must never be reported successful without all later phases.",
    "irreversibleBoundary",
    errors,
  );

  hasExactFields(contract?.receiptPredicate, RECEIPT_FIELDS, "receiptPredicate", errors);
  exactValue(contract?.receiptPredicate?.sameExecutionRequired, true, "receiptPredicate.sameExecutionRequired", errors);
  exactValue(contract?.receiptPredicate?.requiredState, "succeeded", "receiptPredicate.requiredState", errors);
  exactValue(contract?.receiptPredicate?.requiredReasonCode, "single_player_sleep_and_advance_day_completed", "receiptPredicate.requiredReasonCode", errors);
  exactValue(contract?.receiptPredicate?.requiresNonEmptyEvidence, true, "receiptPredicate.requiresNonEmptyEvidence", errors);
  exactArray(contract?.receiptPredicate?.requiredIdentityMatches, REQUIRED_RECEIPT_IDENTITIES, "receiptPredicate.requiredIdentityMatches", errors);
  exactArray(contract?.receiptPredicate?.requiredEvidence, REQUIRED_RECEIPT_EVIDENCE, "receiptPredicate.requiredEvidence", errors);
  exactArray(contract?.receiptPredicate?.authoritativelyCompletedOnlyWhen, REQUIRED_COMPLETION_CONDITIONS, "receiptPredicate.authoritativelyCompletedOnlyWhen", errors);
  exactValue(contract?.receiptPredicate?.fixtureReceiptForbidden, true, "receiptPredicate.fixtureReceiptForbidden", errors);

  hasExactFields(contract?.freshObservations, ["dayStarted", "reopen"], "freshObservations", errors);
  hasExactFields(contract?.freshObservations?.dayStarted, OBSERVATION_FIELDS, "freshObservations.dayStarted", errors);
  exactValue(contract?.freshObservations?.dayStarted?.mustBeFreshAfterReceipt, true, "freshObservations.dayStarted.mustBeFreshAfterReceipt", errors);
  exactArray(contract?.freshObservations?.dayStarted?.requiredFacts, REQUIRED_DAY_STARTED_FACTS, "freshObservations.dayStarted.requiredFacts", errors);
  exactValue(contract?.freshObservations?.dayStarted?.mustNotBeFixtureWritten, true, "freshObservations.dayStarted.mustNotBeFixtureWritten", errors);
  hasExactFields(contract?.freshObservations?.reopen, REOPEN_OBSERVATION_FIELDS, "freshObservations.reopen", errors);
  exactValue(contract?.freshObservations?.reopen?.mustBeFreshAfterClose, true, "freshObservations.reopen.mustBeFreshAfterClose", errors);
  exactArray(contract?.freshObservations?.reopen?.requiredFacts, REQUIRED_REOPEN_FACTS, "freshObservations.reopen.requiredFacts", errors);
  exactValue(contract?.freshObservations?.reopen?.oldBindingGenerationMustBeRejected, true, "freshObservations.reopen.oldBindingGenerationMustBeRejected", errors);
  exactValue(contract?.freshObservations?.reopen?.mustNotBeFixtureWritten, true, "freshObservations.reopen.mustNotBeFixtureWritten", errors);

  hasExactFields(contract?.teardownRestore, TEARDOWN_FIELDS, "teardownRestore", errors);
  exactValue(contract?.teardownRestore?.required, true, "teardownRestore.required", errors);
  exactArray(contract?.teardownRestore?.steps, REQUIRED_TEARDOWN_STEPS, "teardownRestore.steps", errors);
  exactArray(contract?.teardownRestore?.restoreMustNot, REQUIRED_TEARDOWN_PROHIBITIONS, "teardownRestore.restoreMustNot", errors);
  exactArray(contract?.fixtureCreationRules, REQUIRED_FIXTURE_RULES, "fixtureCreationRules", errors);
  exactArray(contract?.prohibitedOperations, REQUIRED_PROHIBITED_OPERATIONS, "prohibitedOperations", errors);
  exactArray(contract?.nonClaims, REQUIRED_NON_CLAIMS, "nonClaims", errors);

  scanForConcreteRuntimeIds(contract, "contract", errors);
  // The exact schema and values above reject success/publication metadata. This
  // extra key scan makes the claim boundary explicit for future schema edits.
  if (contract && typeof contract === "object") {
    const serialized = JSON.stringify(contract);
    if (/"?(?:successClaimAllowed|liveClosure|templateState|productionAdapterState)"?\s*[:=]\s*(?:true|"(?:succeeded|completed|published|live|provisioned)")/i.test(serialized)) {
      errors.push("contract contains a forbidden success, publication, or provisioned-template claim.");
    }
  }
  return errors;
}

export async function checkStardewPortfolioSleepDayFixtureContract(contractFile) {
  let source;
  try {
    source = await readFile(contractFile, "utf8");
  } catch (error) {
    throw new Error(`Unable to read contract ${contractFile}: ${error.message}`);
  }
  let contract;
  try {
    contract = JSON.parse(source);
  } catch (error) {
    throw new Error(`Contract is not valid JSON: ${error.message}`);
  }
  const errors = validateStardewPortfolioSleepDayFixtureContract(contract);
  if (errors.length) fail(errors);
  return Object.freeze({
    state: "fixture_needed",
    contractKind: "contract_only",
    liveClosure: "none",
    fixtureId: contract.fixtureId,
    action: contract.action,
    targetVersion: contract.target.gameVersion,
    provisioningState: "unprovisioned",
    templateValidated: false,
  });
}

function parseContractArg(argv) {
  const index = argv.indexOf("--contract");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error("Usage: node tools/check-stardew-portfolio-sleep-day-fixture-contract.mjs --contract <path>");
  }
  if (argv.slice(index + 2).length > 0) throw new Error("Unexpected command-line arguments.");
  return argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkStardewPortfolioSleepDayFixtureContract(parseContractArg(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`stardew-portfolio-sleep-day-fixture-contract: ${error.message}`);
    process.exitCode = 1;
  }
}
