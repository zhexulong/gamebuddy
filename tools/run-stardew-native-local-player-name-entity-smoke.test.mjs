import assert from "node:assert/strict";
import test from "node:test";

import { assertNameEntityPostconditions } from "./run-stardew-native-local-player-name-entity-smoke.mjs";

/**
 * The name_entity live judgement, tested DIRECTLY (no transport fake).
 *
 * The judgement is pure, so each case below is one way the LIVE run could lie about the stored
 * name: the write never landed, the write landed twice, the receipt names a value the world does
 * not hold, the entity already had a name, the receipt reads the wrong fact, or the surface cannot
 * be read at all.
 */

const REQUESTED = "GameBuddyNamedHorse";

const EVIDENCE = {
  owner_id: "77",
  location: "Farm",
  actor_tile: "64,15",
  horse_tile: "65,15",
  horse_owner_id: "77",
  horse_name: "none",
  horse_id: "0123456789abcdef0123456789abcdef",
  name_before: "none",
  requested: REQUESTED,
  name_after: REQUESTED,
  name_matches_requested: "true",
  player_horse_name_updated: "true",
};

const advertised = (names) => names.map((name, index) => ({ targetId: `horse_00000000000000${index}`, x: 65, y: 15, name }));

test("the honest happy path passes every check", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: EVIDENCE,
    horseTargets: advertised([REQUESTED]),
  });
  assert.deepEqual(checks, {
    receiptSaysNamed: true,
    storedNameReadBackFromEntity: true,
    advertisedNameAgreesWithReceipt: true,
    evidenceMatchesRequest: true,
  });
});

test("a name the world does not hold fails: the receipt is not the proof", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: EVIDENCE,
    horseTargets: advertised(["SomeOtherHorse"]),
  });
  assert.equal(checks.storedNameReadBackFromEntity, false);
});

test("the name landing on two entities fails: the write must land exactly once", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: EVIDENCE,
    horseTargets: advertised([REQUESTED, REQUESTED]),
  });
  assert.equal(checks.storedNameReadBackFromEntity, false);
});

test("a receipt naming a value the world does not report fails", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: { ...EVIDENCE, name_after: "SomethingElse" },
    horseTargets: advertised([REQUESTED]),
  });
  assert.equal(checks.advertisedNameAgreesWithReceipt, false);
});

test("naming an entity that already had a name fails: that is not a name write", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: { ...EVIDENCE, name_before: "OldName", horse_name: "OldName" },
    horseTargets: advertised([REQUESTED]),
  });
  assert.equal(checks.receiptSaysNamed, false);
});

test("the entity's own name field must be the fact the receipt claims", () => {
  const checks = assertNameEntityPostconditions({
    requestedName: REQUESTED,
    evidence: { ...EVIDENCE, name_matches_requested: "false" },
    horseTargets: advertised([REQUESTED]),
  });
  assert.equal(checks.evidenceMatchesRequest, false);
});

test("a surface with no horse projection reports not_checked, NEVER a pass", () => {
  // The distinction this test exists for: "I could not look" must not read as "the entity stores
  // the name" - and the runner treats `not_checked` as a failure, so a surface that cannot show
  // horses cannot silently bless a run.
  const checks = assertNameEntityPostconditions({ requestedName: REQUESTED, evidence: EVIDENCE, horseTargets: null });
  assert.equal(checks.storedNameReadBackFromEntity, "not_checked");
  assert.equal(checks.advertisedNameAgreesWithReceipt, "not_checked");
  assert.equal(
    Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").length,
    2,
    "the run must fail, on exactly these two checks",
  );
});
