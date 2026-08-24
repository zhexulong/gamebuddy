import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  checkM8ElevatorActionContract,
  validateM8ElevatorActionContract,
} from "./stardew-portfolio-m8-elevator-action-contract.mjs";

const contractPath = new URL("../fixtures/stardew/portfolio-m8-elevator-contract.example.json", import.meta.url);

async function loadContract() {
  return JSON.parse(await readFile(contractPath, "utf8"));
}
function errorsFor(mutator) {
  return loadContract().then((contract) => {
    mutator(contract);
    return validateM8ElevatorActionContract(contract).join("\n");
  });
}

test("M8 elevator example records deterministic implementation while retaining fixture/live closure boundaries", async () => {
  const contract = await loadContract();
  assert.deepEqual(validateM8ElevatorActionContract(contract), []);
  const result = await checkM8ElevatorActionContract(contractPath, process.cwd());
  assert.equal(result.state, "implementation_present_not_live");
  assert.equal(result.fixtureState, "fixture_needed");
  assert.equal(result.action, "select_mine_elevator_floor");
  assert.equal(result.publication, "none");
  assert.equal(result.liveClosure, "none");
  assert.equal(result.sourceAudit.projectionState, "blocked");
  assert.equal(result.sourceAudit.liveState, "not_performed");
});

test("M8 elevator contract rejects static floors, opaque native targets, and route widening", async () => {
  const staticFloor = await errorsFor((contract) => {
    contract.selectedDomain.selectedCheckpoint.value = 25;
  });
  assert.match(staticFloor, /selectedDomain\.selectedCheckpoint\.value must be null|static floor/);

  const opaqueNativeTarget = await errorsFor((contract) => {
    contract.action.target = {
      kind: "opaque_runtime_target",
      source: "fresh_native_elevator_observation",
      value: null,
    };
  });
  assert.match(opaqueNativeTarget, /action: unknown field target/);

  const ladder = await errorsFor((contract) => {
    contract.routeBoundary.selectedVariant = "ladder_and_elevator";
  });
  assert.match(ladder, /routeBoundary\.selectedVariant/);

  const genericWarp = await errorsFor((contract) => {
    contract.routeBoundary.genericWarpRoute = "allowed";
  });
  assert.match(genericWarp, /routeBoundary\.genericWarpRoute/);
});

test("M8 elevator contract requires fresh entry/floor/unlock facts and strict guards", async () => {
  const missingFact = await errorsFor((contract) => {
    delete contract.action.input.currentFloor;
  });
  assert.match(missingFact, /action\.input: missing field currentFloor/);

  const stale = await errorsFor((contract) => {
    contract.action.guards.unlockedLevel = "fixture_value";
  });
  assert.match(stale, /action\.guards\.unlockedLevel/);

  const signedDsm = await errorsFor((contract) => {
    contract.selectedDomain.selectionSource = "signed_dsm_plus_fresh_observation";
  });
  assert.match(signedDsm, /selectedDomain\.selectionSource/);

  const noEnabledActions = await errorsFor((contract) => {
    contract.action.guards.enabledActions = "not_required";
  });
  assert.match(noEnabledActions, /action\.guards\.enabledActions/);

  const weakEvidence = await errorsFor((contract) => {
    contract.sharedEvidenceRules.lowestMineLevel = false;
  });
  assert.match(weakEvidence, /sharedEvidenceRules\.lowestMineLevel/);

  const invalidPersistenceClaim = await errorsFor((contract) => {
    contract.sharedEvidenceRules.saveReopen = true;
  });
  assert.match(invalidPersistenceClaim, /sharedEvidenceRules\.saveReopen/);

  const published = await errorsFor((contract) => {
    contract.fixtureStatus.successClaimAllowed = true;
  });
  assert.match(published, /fixtureStatus\.successClaimAllowed/);
});

test("M8 elevator contract permits only a named staged Given fixture while keeping action mutation forbidden", async () => {
  const contract = await loadContract();
  for (const entry of [
    "ladder route selection or ladder/elevator route conflation",
    "generic mine action, generic travel action, generic warp action, or direct warp request",
    "UI/menu automation, keyboard/mouse/XInput, visual/input injection, or window inspection",
    "direct action save mutation, direct action player/world mutation, fixture-written action result, or use of a staged-save Given fixture outside its named launcher-owned validation transaction",
  ])
    assert.ok(contract.forbiddenBehavior.includes(entry), entry);
  assert.equal(contract.fixtureStartingFacts.fixtureMutatesGameplayState, "declared_staged_given_only");
  assert.ok(contract.fixtureCreationRules.some((entry) => entry.includes("mine_lowestLevelReached to 10")));
  assert.equal(contract.fixtureStartingFacts.fixtureWritesSave, "declared_staged_slot_only_canonical_never_written");
  assert.equal(
    contract.fixtureStartingFacts.stagedSaveFixture,
    "design/84_M8_STAGED_SAVE_GIVEN_FIXTURE_IMPLEMENTATION_PLAN.md",
  );

  const mutated = await errorsFor((value) => {
    value.forbiddenBehavior = value.forbiddenBehavior.filter((entry) => !entry.includes("ladder route"));
  });
  assert.match(mutated, /forbiddenBehavior must match/);

  const arbitraryPatch = await errorsFor((value) => {
    value.fixtureStartingFacts.stagedSaveFixture = "arbitrary-xml-patch";
  });
  assert.match(arbitraryPatch, /fixtureStartingFacts\.stagedSaveFixture/);
});
