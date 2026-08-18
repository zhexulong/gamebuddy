#!/usr/bin/env node
/**
 * Static, fail-closed validator for the CrabPot output fixture provenance
 * contract. This file validates metadata only; it does not prepare a save,
 * start Stardew, attach a bridge, or execute an action.
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

const EXPECTED_ROOT_FIELDS = Object.freeze([
  "schemaVersion",
  "fixtureId",
  "target",
  "save",
  "action",
  "fixtureScenario",
  "purpose",
  "nativeOrigin",
  "requiredLiveFacts",
  "antiFinalStepAssertions",
  "fixtureCreationChecklist",
  "futureProductionSuccessPostconditions",
  "futureProductionCapacityFailurePostconditions",
  "forbiddenFixtureBehavior",
  "nonClaims",
]);
const EXPECTED_TARGET_FIELDS = Object.freeze(["gameVersion", "assemblySha256", "contentHashesSha256"]);
const EXPECTED_SAVE_FIELDS = Object.freeze([
  "templateName",
  "requiredNativeFiles",
  "provisioningState",
  "templatePayloadSha256",
  "provisioningAttestation",
]);
const EXPECTED_ORIGIN_FIELDS = Object.freeze(["requiredLifecycle", "prohibitedOrigins"]);
const EXPECTED_LIVE_FACT_FIELDS = Object.freeze([
  "locationKind",
  "qualifiedItemId",
  "requiresCurrentLocalPlayerOwner",
  "requiresLegalCrabPotLocation",
  "requiresCardinalStandingTile",
  "requiresBait",
  "requiresReadyForHarvest",
  "requiresHeldOutput",
  "requiresInventoryCapacity",
  "requiresFreshOpaqueTargetRediscovery",
]);

const REQUIRED_LIFECYCLE = Object.freeze([
  "ordinary target-version CrabPot placement",
  "ordinary target-version bait interaction",
  "ordinary target-version day transition that ran CrabPot.DayUpdate",
  "native Saving/Saved and target-version reload before template capture",
]);
const REQUIRED_PROHIBITED_ORIGINS = Object.freeze([
  "save XML editing",
  "direct readyForHarvest, heldObject, tileIndexToShow, bait, owner, object, or inventory mutation",
  "direct DayUpdate invocation or timer skipping",
  "UI/input automation, raw dispatcher, debug readiness mutation, or synthetic bridge receipt",
  "collect_crab_pot_output request or any native collection ingress before template capture",
]);
const REQUIRED_FIXTURE_CREATION_CHECKLIST = Object.freeze([
  "Create the complete save through target-version Stardew only, then capture it outside the repository with the existing read-only template tooling.",
  "Record the target-version and template-payload hashes only after the native save/reload validation cycle succeeds.",
  "Record the native lifecycle trace and same-pot continuity facts without recording an opaque target ID; production must rediscover it from a fresh snapshot.",
  "Reject missing, duplicate, non-owned, unbaited, non-ready, no-output, illegal-location, unreachable, or ambiguous candidate pots before bridge attachment.",
  "The fixture initializer may only validate the template's ready starting facts and position the current local Player; it must not manufacture readiness or invoke collection.",
]);
const REQUIRED_ANTI_FINAL_STEP_ASSERTIONS = Object.freeze([
  "No collect_crab_pot_output bridge request, execution, receipt, or other collection ingress appears in the template-creation trace.",
  "The ready output remains on the same native-owned CrabPot after native save/reload and before bridge attachment.",
  "No output inventory delta, held-output clearance, readiness clearance, bait clearance, pot replacement, or result fixture was produced before production execution.",
]);
const REQUIRED_FORBIDDEN_BEHAVIOR = Object.freeze([
  "Do not call collect_crab_pot_output, GameLocation.checkAction, CrabPot.checkForAction, or a raw dispatcher.",
  "Do not call CrabPot.DayUpdate or write ready/output/bait/owner/object/inventory fields.",
  "Do not emit a bridge request, execution, receipt, or fixture-produced success evidence.",
  "Do not edit save XML after target-version native template creation.",
]);
const REQUIRED_NON_CLAIMS = Object.freeze([
  "This contract does not publish collect_crab_pot_output.",
  "This contract is not native-local mechanics closure, Farmhand evidence, Portfolio evidence, save/reopen action closure, or release evidence.",
  "This contract does not prove place-bait-day-collect composite completion or CrabPot output distributions.",
]);
const REQUIRED_SUCCESS_POSTCONDITIONS = Object.freeze([
  "receipt.state=succeeded",
  "receipt.reasonCode=crab_pot_output_collected",
  "same current-local-player-owned pot output added to inventory",
  "same pot held output cleared",
  "same pot readyForHarvest=false",
  "same pot bait cleared",
  "fresh same-pot snapshot agrees with the receipt evidence",
]);
const REQUIRED_CAPACITY_FAILURE_POSTCONDITIONS = Object.freeze([
  "No succeeded receipt is accepted.",
  "The same pot retains held output and readyForHarvest=true.",
  "The Player inventory does not gain the output.",
]);

function fail(errors) {
  const error = new Error(errors.join("\n"));
  error.code = "crab_pot_output_fixture_contract_invalid";
  throw error;
}

function hasExactFields(value, expected, label, errors) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${label} must be an object.`);
    return;
  }
  const expectedSet = new Set(expected);
  for (const field of expected) if (!Object.hasOwn(value, field)) errors.push(`${label}: missing field ${field}.`);
  for (const field of Object.keys(value)) {
    if (!expectedSet.has(field)) errors.push(`${label}: unknown field ${field}.`);
  }
}

function exactArray(actual, expected, label, errors) {
  if (!Array.isArray(actual)) {
    errors.push(`${label} must be an array.`);
    return;
  }
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    errors.push(`${label} must match the approved bounded policy.`);
}

function nonEmptyString(value, label, errors) {
  if (typeof value !== "string" || value.trim().length === 0) errors.push(`${label} must be a nonempty string.`);
}

function scanForOpaqueTargetIds(value, path, errors) {
  if (typeof value === "string") {
    // Opaque IDs are runtime facts and must never be copied into provenance
    // metadata. The contract may mention the phrase "opaque target" but not a
    // concrete generated identifier.
    if (/(?:^|[^a-z0-9])(?:crab[_-]?pot|target|pot)[_-][a-f0-9]{12,}(?:$|[^a-z0-9])/i.test(value)) {
      errors.push(`${path} contains an accidental opaque target ID.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => scanForOpaqueTargetIds(entry, `${path}[${index}]`, errors));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) scanForOpaqueTargetIds(entry, `${path}.${key}`, errors);
  }
}

export function validateCrabPotOutputFixtureContract(contract) {
  const errors = [];
  hasExactFields(contract, EXPECTED_ROOT_FIELDS, "contract", errors);
  if (contract?.schemaVersion !== 1) errors.push("contract.schemaVersion must be 1.");
  if (contract?.fixtureId !== "GameBuddyFixture_CrabPotOutput_1_6_15") {
    errors.push("contract.fixtureId must identify the bounded CrabPot output fixture.");
  }
  if (contract?.action !== "collect_crab_pot_output") errors.push("contract.action must be collect_crab_pot_output.");
  if (contract?.fixtureScenario !== "native_collect_crab_pot_output_v1") {
    errors.push("contract.fixtureScenario must be native_collect_crab_pot_output_v1.");
  }
  const expectedPurpose =
    "Read-only, pre-attachment native ready-CrabPot starting-state provenance contract; it is not a production request, receipt, result, or live-action evidence artifact.";
  if (contract?.purpose !== expectedPurpose)
    errors.push("contract.purpose must remain fixture-only and non-production.");

  hasExactFields(contract?.target, EXPECTED_TARGET_FIELDS, "target", errors);
  for (const field of EXPECTED_TARGET_FIELDS) {
    if (contract?.target?.[field] !== APPROVED_TARGET[field])
      errors.push(`target.${field} is not the approved target-version value.`);
  }
  hasExactFields(contract?.save, EXPECTED_SAVE_FIELDS, "save", errors);
  if (contract?.save?.templateName !== "GameBuddyFixture_CrabPotOutput_1_6_15") {
    errors.push("save.templateName must match the fixture identity.");
  }
  exactArray(
    contract?.save?.requiredNativeFiles,
    ["GameBuddyFixture_CrabPotOutput_1_6_15", "SaveGameInfo"],
    "save.requiredNativeFiles",
    errors,
  );
  if (!["unprovisioned", "provisioned"].includes(contract?.save?.provisioningState)) {
    errors.push("save.provisioningState must be unprovisioned or provisioned.");
  }
  const payloadHash = contract?.save?.templatePayloadSha256;
  const attestation = contract?.save?.provisioningAttestation;
  if (contract?.save?.provisioningState === "unprovisioned") {
    if (payloadHash !== null)
      errors.push("unprovisioned save must use templatePayloadSha256=null and makes no template claim.");
    if (attestation !== null)
      errors.push("unprovisioned save must use provisioningAttestation=null and makes no reload-attestation claim.");
  } else {
    hasExactFields(
      attestation,
      ["nativeSaveReloadAttested", "attestationReference"],
      "save.provisioningAttestation",
      errors,
    );
    if (typeof payloadHash !== "string" || !/^[a-f0-9]{64}$/i.test(payloadHash) || /^<.*>$/.test(payloadHash)) {
      errors.push(
        "provisioned save.templatePayloadSha256 must be a real operator-recorded 64-hex SHA-256, not a placeholder.",
      );
    }
    if (
      !attestation ||
      typeof attestation !== "object" ||
      Array.isArray(attestation) ||
      attestation.nativeSaveReloadAttested !== true ||
      typeof attestation.attestationReference !== "string" ||
      attestation.attestationReference.trim() === ""
    ) {
      errors.push("provisioned save must include nativeSaveReloadAttested=true and a nonempty attestationReference.");
    }
  }

  hasExactFields(contract?.nativeOrigin, EXPECTED_ORIGIN_FIELDS, "nativeOrigin", errors);
  exactArray(contract?.nativeOrigin?.requiredLifecycle, REQUIRED_LIFECYCLE, "nativeOrigin.requiredLifecycle", errors);
  exactArray(
    contract?.nativeOrigin?.prohibitedOrigins,
    REQUIRED_PROHIBITED_ORIGINS,
    "nativeOrigin.prohibitedOrigins",
    errors,
  );

  hasExactFields(contract?.requiredLiveFacts, EXPECTED_LIVE_FACT_FIELDS, "requiredLiveFacts", errors);
  if (contract?.requiredLiveFacts?.locationKind !== "Farm") errors.push("requiredLiveFacts.locationKind must be Farm.");
  if (contract?.requiredLiveFacts?.qualifiedItemId !== "(O)710")
    errors.push("requiredLiveFacts.qualifiedItemId must be (O)710.");
  for (const field of EXPECTED_LIVE_FACT_FIELDS.slice(2)) {
    if (contract?.requiredLiveFacts?.[field] !== true) errors.push(`requiredLiveFacts.${field} must be true.`);
  }

  exactArray(contract?.antiFinalStepAssertions, REQUIRED_ANTI_FINAL_STEP_ASSERTIONS, "antiFinalStepAssertions", errors);
  exactArray(
    contract?.fixtureCreationChecklist,
    REQUIRED_FIXTURE_CREATION_CHECKLIST,
    "fixtureCreationChecklist",
    errors,
  );
  exactArray(
    contract?.futureProductionSuccessPostconditions,
    REQUIRED_SUCCESS_POSTCONDITIONS,
    "futureProductionSuccessPostconditions",
    errors,
  );
  exactArray(
    contract?.futureProductionCapacityFailurePostconditions,
    REQUIRED_CAPACITY_FAILURE_POSTCONDITIONS,
    "futureProductionCapacityFailurePostconditions",
    errors,
  );
  exactArray(contract?.forbiddenFixtureBehavior, REQUIRED_FORBIDDEN_BEHAVIOR, "forbiddenFixtureBehavior", errors);
  exactArray(contract?.nonClaims, REQUIRED_NON_CLAIMS, "nonClaims", errors);

  // Reject status/closure/publication metadata even if a future caller adds it
  // under a newly invented shape. The accepted artifact is only provenance.
  scanForOpaqueTargetIds(contract, "contract", errors);
  const serialized = JSON.stringify(contract);
  if (
    /"(?:live[_-]?closure|publication[_-]?state|publicationState|production[_-]?evidence|release[_-]?evidence)"\s*:\s*(?!"none"|null\b)(?:true|false|"[^"]+"|\d+)/i.test(
      serialized,
    )
  ) {
    errors.push("contract contains a production/publication/live-closure claim.");
  }
  return errors;
}

export async function checkCrabPotOutputFixtureContract(contractFile) {
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
  const errors = validateCrabPotOutputFixtureContract(contract);
  if (errors.length) fail(errors);
  return Object.freeze({
    state: "fixture_needed",
    contractKind: "provenance_contract_only",
    liveClosure: "none",
    fixtureId: contract.fixtureId,
    action: contract.action,
    targetVersion: contract.target.gameVersion,
    provisioningState: contract.save.provisioningState,
    templateValidated: contract.save.provisioningState === "provisioned",
  });
}

function parseContractArg(argv) {
  const index = argv.indexOf("--contract");
  if (index < 0 || !argv[index + 1] || argv[index + 1].startsWith("--")) {
    throw new Error("Usage: node tools/check-crab-pot-output-fixture-contract.mjs --contract <path>");
  }
  if (argv.slice(index + 2).length > 0) throw new Error("Unexpected command-line arguments.");
  return argv[index + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkCrabPotOutputFixtureContract(parseContractArg(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`crab-pot-output-fixture-contract: ${error.message}`);
    process.exitCode = 1;
  }
}
