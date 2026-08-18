import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  checkStardewPortfolioSleepDayFixtureContract,
  validateStardewPortfolioSleepDayFixtureContract,
} from "./check-stardew-portfolio-sleep-day-fixture-contract.mjs";

const contractPath = new URL("../fixtures/stardew/portfolio-sleep-day-fixture.example.json", import.meta.url);

async function loadContract() {
  return JSON.parse(await readFile(contractPath, "utf8"));
}

async function errorsFor(mutator) {
  const contract = await loadContract();
  mutator(contract);
  return validateStardewPortfolioSleepDayFixtureContract(contract).join("\n");
}

test("checked-in example is strict fixture-needed metadata and never live closure", async () => {
  const contract = await loadContract();
  assert.deepEqual(validateStardewPortfolioSleepDayFixtureContract(contract), []);
  assert.deepEqual(await checkStardewPortfolioSleepDayFixtureContract(contractPath), {
    state: "fixture_needed",
    contractKind: "contract_only",
    liveClosure: "none",
    fixtureId: "GameBuddyPortfolioFixture_SleepDay_1_6_15",
    action: "single_player_sleep_and_advance_day",
    targetVersion: "1.6.15.24356",
    provisioningState: "unprovisioned",
    templateValidated: false,
  });
});

test("unknown, missing, malformed, and target-version fields fail closed", async () => {
  const unknown = await errorsFor((contract) => {
    contract.startingFacts.unapproved = true;
  });
  assert.match(unknown, /startingFacts: unknown field unapproved/);

  const missing = await errorsFor((contract) => {
    delete contract.receiptPredicate.requiredEvidence;
  });
  assert.match(missing, /receiptPredicate: missing field requiredEvidence/);

  const malformed = await errorsFor((contract) => {
    contract.phaseSequence = "Saving";
  });
  assert.match(malformed, /phaseSequence must be an array/);

  const wrongTarget = await errorsFor((contract) => {
    contract.target.gameVersion = "1.6.14.0";
    contract.target.assemblySha256 = "a".repeat(64);
    contract.target.contentHashesSha256 = "b".repeat(64);
  });
  assert.match(wrongTarget, /target.gameVersion must be "1.6.15.24356"/);
  assert.match(wrongTarget, /target.assemblySha256 must be/);
  assert.match(wrongTarget, /target.contentHashesSha256 must be/);
});

test("terminal, provisioned, success, and concrete execution claims are rejected", async () => {
  const terminal = await errorsFor((contract) => {
    contract.startingFacts.nonterminalCropPrecondition.readyForHarvest = true;
    contract.startingFacts.nonterminalAnimalPrecondition.currentProduce = "(O)340";
    contract.startingFacts.nonterminalMachinePrecondition.readyForHarvest = true;
    contract.startingFacts.nonterminalMachinePrecondition.heldOutput = "(O)395";
  });
  assert.match(terminal, /readyForHarvest must be false/);
  assert.match(terminal, /currentProduce must be null/);
  assert.match(terminal, /heldOutput must be null/);

  const provisioned = await errorsFor((contract) => {
    contract.fixtureStatus.templateState = "provisioned";
  });
  assert.match(provisioned, /fixtureStatus.templateState must be "unprovisioned"/);
  assert.match(provisioned, /forbidden success, publication, or provisioned-template claim/);

  const success = await errorsFor((contract) => {
    contract.fixtureStatus.successClaimAllowed = true;
    contract.receiptPredicate.requiredState = "succeeded";
  });
  assert.match(success, /fixtureStatus.successClaimAllowed must be false/);
  assert.match(success, /forbidden success, publication, or provisioned-template claim/);

  const execution = await errorsFor((contract) => {
    contract.nonClaims.push("executionId=execution_deadbeef12345678");
  });
  assert.match(execution, /unknown field|nonClaims must match|concrete runtime or opaque target ID/);
});

test("phase, evidence, reopen, teardown, and prohibited direct ingress are immutable", async () => {
  const phase = await errorsFor((contract) => {
    contract.phaseSequence.splice(4, 1);
  });
  assert.match(phase, /phaseSequence must match/);

  const evidence = await errorsFor((contract) => {
    contract.receiptPredicate.requiredEvidence.pop();
    contract.freshObservations.dayStarted.requiredFacts.pop();
  });
  assert.match(evidence, /receiptPredicate.requiredEvidence must match/);
  assert.match(evidence, /freshObservations.dayStarted.requiredFacts must match/);

  const reopen = await errorsFor((contract) => {
    contract.freshObservations.reopen.oldBindingGenerationMustBeRejected = false;
    contract.traceIdentity.reopenRequiresNewBindingGeneration = false;
  });
  assert.match(reopen, /oldBindingGenerationMustBeRejected must be true/);
  assert.match(reopen, /reopenRequiresNewBindingGeneration must be true/);

  const forbidden = await errorsFor((contract) => {
    contract.prohibitedOperations = contract.prohibitedOperations.filter((entry) => !entry.includes("NewDay"));
  });
  assert.match(forbidden, /prohibitedOperations must match/);

  const mutation = await errorsFor((contract) => {
    contract.startingFacts.fixtureMustNotMutateGameplayState = false;
  });
  assert.match(mutation, /fixtureMustNotMutateGameplayState must be true/);
});

test("malformed JSON and missing files fail closed", async () => {
  await assert.rejects(
    () => checkStardewPortfolioSleepDayFixtureContract(new URL("./missing-contract.json", import.meta.url)),
    /Unable to read contract/,
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-sleep-day-contract-"));
  const malformedPath = path.join(directory, "malformed.json");
  try {
    await writeFile(malformedPath, "{not-json", "utf8");
    await assert.rejects(
      () => checkStardewPortfolioSleepDayFixtureContract(malformedPath),
      /Contract is not valid JSON/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
