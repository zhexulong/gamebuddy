import assert from "node:assert/strict";
import test from "node:test";

import {
  EVIDENCE_STATE,
  isPass,
  isVerified,
  judgeExpectation,
  judgeNotApplicable,
  judgeObserved,
  rollupVerdicts,
} from "./evidence-verdict.mjs";

test("a gate cannot reach verified without observing", () => {
  // The whole class this module exists for: an emptiness test must never double as
  // a success test, because that is how "assembly passed" was reported for a
  // companion with no persona (measured 2026-10-06, commit a58a4386).
  assert.equal(judgeObserved({ observed: false, ok: true }).state, EVIDENCE_STATE.unobserved);
  assert.equal(judgeObserved({ observed: undefined, ok: true }).state, EVIDENCE_STATE.unobserved);
  assert.equal(judgeObserved({ observed: "yes", ok: true }).state, EVIDENCE_STATE.unobserved);
  assert.equal(judgeObserved({ observed: true, ok: true }).state, EVIDENCE_STATE.verified);
  assert.equal(judgeObserved({ observed: true, ok: false }).state, EVIDENCE_STATE.failed);
  // A verdict is only a pass through the named accessor.
  assert.equal(isPass(judgeObserved({ observed: true, ok: true })), true);
  assert.equal(isPass(judgeObserved({ observed: false, ok: true })), false);
  assert.equal(isPass(undefined), false);
  assert.equal(isPass({ state: "passed" }), false);
});

test("a missing expectation is unobserved, never a pass", () => {
  // This is the exact regression: `expectation === null ? true : check`.
  const noExpectation = judgeExpectation({ expectation: null, observed: true, ok: true });
  assert.equal(noExpectation.state, EVIDENCE_STATE.unobserved);
  assert.equal(noExpectation.reason, "no_expectation_configured");
  assert.equal(isPass(noExpectation), false);
  assert.equal(judgeExpectation({ expectation: undefined, observed: true, ok: true }).state, EVIDENCE_STATE.unobserved);
});

test("absence is only a pass when declared expected AND named", () => {
  // "Nothing happened" is the evidence for some assertions (a held covenant needs
  // no shipment receipt). That is legitimate - but it must be written down, so the
  // decision is visible in the artifact instead of hidden in a branch.
  const declared = judgeExpectation({
    expectation: null,
    observed: true,
    ok: true,
    absentIsExpected: true,
    absentReason: "covenant_assertion_needs_no_receipt",
  });
  assert.equal(declared.state, EVIDENCE_STATE.verified);
  assert.equal(declared.reason, "covenant_assertion_needs_no_receipt");

  const unnamed = judgeExpectation({ expectation: null, absentIsExpected: true });
  assert.equal(unnamed.state, EVIDENCE_STATE.unobserved);
  assert.equal(unnamed.reason, "absence_expected_without_reason");
  assert.equal(isPass(unnamed), false);
});

test("a configured expectation that was never observed stays unobserved even when the caller claims success", () => {
  const configured = judgeExpectation({ expectation: { profileId: "x", revision: 1 }, observed: false, ok: true });
  assert.equal(configured.state, EVIDENCE_STATE.unobserved);
  const wrong = judgeExpectation({ expectation: { profileId: "x" }, observed: true, ok: false, reason: "profile_mismatch" });
  assert.equal(wrong.state, EVIDENCE_STATE.failed);
  assert.equal(wrong.reason, "profile_mismatch");
});

test("a rollup can never be outvoted into a pass by its verified siblings", () => {
  const verified = judgeObserved({ observed: true, ok: true });
  const unobserved = judgeObserved({ observed: false, ok: true });
  const failed = judgeObserved({ observed: true, ok: false, reason: "mismatch" });
  assert.equal(rollupVerdicts([verified, verified]).state, EVIDENCE_STATE.verified);
  assert.equal(rollupVerdicts([verified, unobserved]).state, EVIDENCE_STATE.unobserved);
  assert.deepEqual(rollupVerdicts([verified, unobserved]).reasons, ["not_observed"]);
  assert.equal(rollupVerdicts([unobserved, failed]).state, EVIDENCE_STATE.failed);
  assert.equal(rollupVerdicts([]).state, EVIDENCE_STATE.verified);
});

test("not-applicable is an explicit, named state rather than a silent pass", () => {
  const notApplicable = judgeNotApplicable("ladder_1_not_run");
  assert.equal(notApplicable.state, "not_applicable");
  assert.equal(isVerified(notApplicable), false);
  assert.equal(isPass(notApplicable), false);
  assert.throws(() => judgeNotApplicable(""), /not_applicable_requires_reason/);
});
