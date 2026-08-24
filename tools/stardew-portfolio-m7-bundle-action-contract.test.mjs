import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkM7BundleActionContract,
  validateM7BundleActionContract,
  validateM7BundleFixtureContract,
} from "./stardew-portfolio-m7-bundle-action-contract.mjs";

const CONTRACT = new URL("./stardew-portfolio-m7-bundle-action-contract.json", import.meta.url);
const FIXTURE = new URL("../fixtures/stardew/portfolio-m7-bundle-unprovisioned.fixture.example.json", import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, "utf8"));
}

test("M7 static contract and unprovisioned fixture validate with source audit identity", async () => {
  const result = await checkM7BundleActionContract();
  assert.equal(result.state, "implementation_needed");
  assert.deepEqual(result.actions, ["contribute_bundle_slot", "claim_bundle_reward"]);
  assert.equal(result.fixtureStatus, "fixture_needed");
  assert.equal(result.liveClosure, "none");
  assert.equal(result.sourceAuditVerified, true);
  assert.equal(result.sourceAudit.projectionState, "blocked");
  assert.equal(result.sourceAudit.liveState, "not_performed");
});

test("M7 selection requires opaque fresh slot and bounded item quality/stack", async () => {
  const contract = await readJson(CONTRACT);
  contract.selection.slot.value = "static-slot";
  assert.throws(() => validateM7BundleActionContract(contract), /fresh opaque runtime value/);

  const boundedContract = await readJson(CONTRACT);
  boundedContract.actions[0].input.stack.max = 9999;
  assert.throws(() => validateM7BundleActionContract(boundedContract), /unmaterialized bounded DSM\/runtime integer/);
});

test("M7 refuses combined donation/claim and terminal or synthetic fixture state", async () => {
  const contract = await readJson(CONTRACT);
  contract.actions[0].commit.doesNotDo = "nothing";
  assert.throws(() => validateM7BundleActionContract(contract), /independent and narrow|M7 action commits/);

  const fixture = await readJson(FIXTURE);
  fixture.startingState.bundleReward = "available";
  assert.throws(() => validateM7BundleFixtureContract(fixture), /terminal or synthetic/);
});

test("M7 action contract rejects UI/raw/save mutation or generic completion policy drift", async () => {
  const contract = await readJson(CONTRACT);
  contract.forbiddenBehavior = contract.forbiddenBehavior.filter((entry) => !entry.includes("generic complete-bundle"));
  assert.throws(() => validateM7BundleActionContract(contract), /approved bounded policy/);
});
