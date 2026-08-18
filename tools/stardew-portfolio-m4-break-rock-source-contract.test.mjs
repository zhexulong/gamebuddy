import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkM4BreakRockSourceContract,
  validateM4BreakRockSourceContract,
} from "./stardew-portfolio-m4-break-rock-source-contract.mjs";

const path = new URL("./stardew-portfolio-m4-break-rock-source-contract.json", import.meta.url);
const fixturePath = new URL(
  "../fixtures/stardew/portfolio-m4-break-rock-source-unprovisioned.fixture.example.json",
  import.meta.url,
);
async function contract() {
  return JSON.parse(await readFile(path, "utf8"));
}
async function fixture() {
  return JSON.parse(await readFile(fixturePath, "utf8"));
}

test("M4 BDD contract is source-bound, narrow, and dependency-blocked", async () => {
  const result = await checkM4BreakRockSourceContract();
  assert.equal(result.action, "break_rock_source");
  assert.equal(result.status, "dependency_blocked");
  assert.equal(result.liveClosure, "none");
  assert.equal(result.producer, "fresh source observation");
  assert.equal(result.consumer, "typed guarded coordinator");
  assert.equal(result.verifier, "future exact fresh-debris reader");
});

test("M4 fixture is an unprovisioned non-mutation Given with no source transform or pickup", async () => {
  const value = await fixture();
  assert.equal(value.artifactKind, "portfolio_m4_unprovisioned_fixture_contract");
  assert.equal(value.provisioningState, "unprovisioned_example");
  assert.equal(value.given.terminalSourceTransform, "absent");
  assert.equal(value.given.debris, "absent_until_native_source_destroy");
  assert.match(value.nonClaims[1], /Pickup is not part/);
});

test("M4 contract rejects a static protocol promotion, pickup widening, and synthetic evidence", async () => {
  const promoted = await contract();
  promoted.status = "implemented";
  assert.throws(() => validateM4BreakRockSourceContract(promoted), /scope\/status/);
  const widened = await contract();
  widened.action = "collect_resource";
  assert.throws(() => validateM4BreakRockSourceContract(widened), /identity/);
  const synthetic = await contract();
  synthetic.forbidden.pop();
  assert.throws(() => validateM4BreakRockSourceContract(synthetic), /scope\/status/);
});
