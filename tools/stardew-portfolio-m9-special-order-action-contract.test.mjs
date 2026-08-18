import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import {
  checkM9SpecialOrderActionContract,
  validateM9SpecialOrderActionContract,
  validateM9SpecialOrderUnprovisionedFixture,
} from "./stardew-portfolio-m9-special-order-action-contract.mjs";

const execFile = promisify(execFileCallback);
const CONTRACT = new URL("./stardew-portfolio-m9-special-order-action-contract.json", import.meta.url);
const SCRIPT = new URL("./stardew-portfolio-m9-special-order-action-contract.mjs", import.meta.url);
const FIXTURE = new URL(
  "../fixtures/stardew/portfolio-m9-special-order-action-contract-unprovisioned.example.json",
  import.meta.url,
);
async function json(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("M9 contract validates its exact action boundary and unprovisioned fixture", async () => {
  const contract = await json(CONTRACT);
  const fixture = await json(FIXTURE);
  assert.deepEqual(validateM9SpecialOrderActionContract(contract), []);
  assert.deepEqual(validateM9SpecialOrderUnprovisionedFixture(fixture), []);
  const result = await checkM9SpecialOrderActionContract(fileURLToPath(CONTRACT));
  assert.equal(result.state, "implementation_needed");
  assert.equal(result.implementationStatus, "implementation_needed");
  assert.equal(result.fixtureStatus, "fixture_needed");
  assert.equal(result.liveClosure, "none");
  assert.equal(result.projectionState, "blocked");
  assert.deepEqual(result.actions, ["accept_special_order_offer", "claim_special_order_reward"]);
});

test("M9 CLI accepts --contract and returns truthful non-closure summary", async () => {
  const { stdout } = await execFile(process.execPath, [fileURLToPath(SCRIPT), "--contract", fileURLToPath(CONTRACT)], {
    cwd: path.resolve(fileURLToPath(new URL("../", import.meta.url))),
  });
  const result = JSON.parse(stdout);
  assert.equal(result.implementationStatus, "implementation_needed");
  assert.equal(result.fixtureStatus, "fixture_needed");
  assert.equal(result.liveClosure, "none");
  assert.equal(result.sourceAuditVerified, true);
});

test("M9 contract rejects generic progress/complete and static selected values", async () => {
  const contract = await json(CONTRACT);
  contract.actions[0].actionId = "complete_special_order";
  contract.selectedDomain.generation.valueEmbedded = true;
  const errors = validateM9SpecialOrderActionContract(contract);
  assert.ok(errors.some((error) => error.includes("actions must be ordered accept then claim")));
  assert.ok(errors.some((error) => error.includes("selectedDomain.generation.valueEmbedded must be false")));
});

test("M9 contract rejects source-audit identity drift and fixture final-step contamination", async () => {
  const contract = await json(CONTRACT);
  contract.sourceAudit.auditId = "other_audit";
  assert.ok(validateM9SpecialOrderActionContract(contract).some((error) => error.includes("sourceAudit.auditId")));
  const fixture = await json(FIXTURE);
  fixture.startingState.selectedOffer = "(O)123";
  assert.ok(validateM9SpecialOrderUnprovisionedFixture(fixture).some((error) => error.includes("selectedOffer")));
  fixture.startingState.selectedOffer = "unselected";
  fixture.startingState.terminalFacts = "completion_observed";
  assert.ok(validateM9SpecialOrderUnprovisionedFixture(fixture).some((error) => error.includes("terminalFacts")));
});

test("M9 CLI/checker remains fail-closed for a malformed contract", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "m9-contract-"));
  const file = path.join(directory, "bad.json");
  await writeFile(file, JSON.stringify({ schemaVersion: 1 }));
  await assert.rejects(() => checkM9SpecialOrderActionContract(file), {
    code: "m9_special_order_action_contract_invalid",
  });
});
