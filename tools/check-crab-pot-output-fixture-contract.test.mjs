import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  checkCrabPotOutputFixtureContract,
  validateCrabPotOutputFixtureContract,
} from "./check-crab-pot-output-fixture-contract.mjs";

const contractPath = new URL("../fixtures/stardew/crab-pot-output.fixture.example.json", import.meta.url);

async function loadContract() {
  return JSON.parse(await readFile(contractPath, "utf8"));
}

function errorsFor(mutator) {
  return loadContract().then((contract) => {
    mutator(contract);
    return validateCrabPotOutputFixtureContract(contract).join("\n");
  });
}

test("checked-in example is explicitly unprovisioned and passes as non-closure metadata", async () => {
  const contract = await loadContract();
  const errors = validateCrabPotOutputFixtureContract(contract);
  assert.deepEqual(errors, []);
  const result = await checkCrabPotOutputFixtureContract(contractPath);
  assert.deepEqual(result, {
    state: "fixture_needed",
    contractKind: "provenance_contract_only",
    liveClosure: "none",
    fixtureId: "GameBuddyFixture_CrabPotOutput_1_6_15",
    action: "collect_crab_pot_output",
    targetVersion: "1.6.15.24356",
    provisioningState: "unprovisioned",
    templateValidated: false,
  });
});

test("unknown and missing metadata fields fail closed", async () => {
  const unknown = await errorsFor((contract) => {
    contract.unknown = true;
  });
  assert.match(unknown, /contract: unknown field unknown/);

  const missing = await errorsFor((contract) => {
    delete contract.requiredLiveFacts.requiresHeldOutput;
  });
  assert.match(missing, /requiredLiveFacts: missing field requiresHeldOutput/);
});

test("provisioning rejects placeholder hashes and refuses unprovisioned hash claims", async () => {
  const placeholder = await errorsFor((contract) => {
    contract.save.provisioningState = "provisioned";
    contract.save.templatePayloadSha256 = "<operator-recorded-sha256-of-canonical-template-payload>";
  });
  assert.match(placeholder, /real operator-recorded 64-hex SHA-256/);

  const unprovisionedHash = await errorsFor((contract) => {
    contract.save.templatePayloadSha256 = "a".repeat(64);
  });
  assert.match(unprovisionedHash, /unprovisioned save must use templatePayloadSha256=null/);
});

test("unapproved target versions and hashes fail closed", async () => {
  const errors = await errorsFor((contract) => {
    contract.target.gameVersion = "1.6.14.0";
    contract.target.assemblySha256 = "a".repeat(64);
    contract.target.contentHashesSha256 = "b".repeat(64);
  });
  assert.match(errors, /target.gameVersion is not the approved target-version value/);
  assert.match(errors, /target.assemblySha256 is not the approved target-version value/);
  assert.match(errors, /target.contentHashesSha256 is not the approved target-version value/);
});

test("unsafe lifecycle, forbidden behavior, claim escalation, and opaque IDs fail closed", async () => {
  const lifecycle = await errorsFor((contract) => {
    contract.nativeOrigin.requiredLifecycle.pop();
  });
  assert.match(lifecycle, /nativeOrigin.requiredLifecycle must match the approved bounded policy/);

  const forbidden = await errorsFor((contract) => {
    contract.forbiddenFixtureBehavior.pop();
  });
  assert.match(forbidden, /forbiddenFixtureBehavior must match the approved bounded policy/);

  const escalation = await errorsFor((contract) => {
    contract.publicationState = "live_closure";
  });
  assert.match(escalation, /unknown field publicationState/);
  assert.match(escalation, /production\/publication\/live-closure claim/);

  const opaque = await errorsFor((contract) => {
    contract.fixtureCreationChecklist[2] = "target=crab_pot_deadbeefcafebabefeed";
  });
  assert.match(opaque, /accidental opaque target ID/);
});

test("CLI argument parsing and malformed JSON fail closed", async () => {
  await assert.rejects(
    () => checkCrabPotOutputFixtureContract(new URL("./missing-contract.json", import.meta.url)),
    /Unable to read contract/,
  );
  const directory = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-crab-pot-contract-"));
  const malformedPath = path.join(directory, "malformed.json");
  try {
    await writeFile(malformedPath, "{not-json", "utf8");
    await assert.rejects(() => checkCrabPotOutputFixtureContract(malformedPath), /Contract is not valid JSON/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
