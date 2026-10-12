import assert from "node:assert/strict";
import test from "node:test";

import { assertClearFishPondPostconditions } from "./run-stardew-native-local-player-clear-fish-pond-smoke.mjs";

/**
 * The clear_fish_pond live judgement, tested DIRECTLY.
 *
 * My first version of this file faked the harness transport and failed all six cases, because I invented the client's
 * method name instead of reading what the harness actually calls - the "fake encodes my assumption" trap. The
 * judgement is pure, so it is exported and exercised here with no transport at all, which is also what makes these
 * cases meaningful: each one is a way the LIVE run could lie.
 */

const TARGET = {
  targetId: "fish_pond_0123456789abcdef",
  location: "Farm",
  x: 10,
  y: 12,
  buildingType: "Fish Pond",
  occupants: 3,
  fishType: "(O)142",
};

const EVIDENCE = {
  pond_id: TARGET.targetId,
  fish_type_before: "(O)142",
  fish_type_after: "none",
  occupants_before: "3",
  occupants_after: "0",
  fish_ejected: "3",
};

const debrisOf = (count) => Array.from({ length: count }, () => ({ itemId: "(O)142" }));

test("the honest happy path passes every check", () => {
  const checks = assertClearFishPondPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    survivors: [],
    debris: debrisOf(3),
  });
  assert.deepEqual(checks, {
    pondNoLongerAdvertised: true,
    receiptSaysEmpty: true,
    evidenceCountsMatch: true,
    fishEjected: true,
  });
});

test("a pond still advertised after the clear fails: the published fact must change", () => {
  const checks = assertClearFishPondPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    survivors: [{ targetId: TARGET.targetId, occupants: 3 }],
    debris: debrisOf(3),
  });
  assert.equal(checks.pondNoLongerAdvertised, false);
});

test("a receipt claiming a clear that did not happen fails", () => {
  const checks = assertClearFishPondPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, occupants_after: "2", fish_type_after: "(O)142" },
    survivors: [],
    debris: debrisOf(3),
  });
  assert.equal(checks.receiptSaysEmpty, false);
});

test("counts that name a different pond fail", () => {
  const checks = assertClearFishPondPostconditions({
    target: TARGET,
    evidence: { ...EVIDENCE, occupants_before: "1", fish_ejected: "1" },
    survivors: [],
    debris: debrisOf(3),
  });
  assert.equal(checks.evidenceCountsMatch, false);
});

test("ejecting fewer fish than the pond held fails", () => {
  const checks = assertClearFishPondPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    survivors: [],
    debris: debrisOf(2),
  });
  assert.equal(checks.fishEjected, false);
});

test("an observation surface with no debris reports not_checked, NEVER a pass", () => {
  // The distinction this test exists for: "I could not look" must not read as "the fish were not ejected" - and the
  // runner treats `not_checked` as a failure, so a surface that cannot show debris cannot silently bless a run.
  const checks = assertClearFishPondPostconditions({ target: TARGET, evidence: EVIDENCE, survivors: [], debris: null });
  assert.equal(checks.fishEjected, "not_checked");
  assert.equal(
    Object.entries(checks).filter(([, ok]) => ok === false || ok === "not_checked").length,
    1,
    "the run must fail, on exactly this check",
  );
});

test("debris of a DIFFERENT fish does not count as this pond's ejection", () => {
  const checks = assertClearFishPondPostconditions({
    target: TARGET,
    evidence: EVIDENCE,
    survivors: [],
    debris: debrisOf(3).map(() => ({ itemId: "(O)999" })),
  });
  assert.equal(checks.fishEjected, false);
});
