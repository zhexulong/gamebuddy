/**
 * Evidence verdicts for live-run gates.
 *
 * WHY THIS EXISTS (measured 2026-10-06, commit a58a4386 and the run that exposed it)
 *
 * The game ladder reported "assembly passed" for a companion that had NO persona.
 * The judgement was
 *
 *     const contentPassed = expectation === null ? true : <check>
 *
 * so a disposable runtime root - which has no expectation BY CONSTRUCTION - passed
 * without anything ever being observed. The same shape appeared twice more
 * (contextAssembled, worldBookAssembled) and once for voice
 * (`voiceStarted ? completed : true`, which passes when voice was CONFIGURED but
 * never started). Three sibling copies of one mistake: a gate whose default on
 * missing evidence is PASS.
 *
 * The missing piece was vocabulary. With only booleans, "verified", "failed" and
 * "I could not look" all collapse into `false`/`true`, and every caller invents its
 * own default. This module makes the three outcomes distinct and makes the
 * fail-closed direction structural:
 *
 *   - `verified`   - the fact WAS observed and satisfies the expectation
 *   - `failed`     - observed and does NOT satisfy it
 *   - `unobserved` - no evidence. NEVER a pass; it blocks or becomes a gap.
 *
 * An absent expectation is `unobserved` unless the caller explicitly declares that
 * absence is the expectation, and even then it must NAME why (`absentReason`), so
 * "there was nothing to check" is always written down instead of being silent.
 */

/** The three outcomes a gate may report. */
export const EVIDENCE_STATE = Object.freeze({
  verified: "verified",
  failed: "failed",
  unobserved: "unobserved",
});

/**
 * Judge one observation that the caller believes it has.
 *
 * `observed` must be strictly `true`: a caller that did not look (or looked and
 * found nothing) must not be able to reach `verified`, which removes the class of
 * bug where an emptiness test doubles as a success test.
 */
export function judgeObserved({ observed, ok, reason }) {
  if (observed !== true) {
    return Object.freeze({ state: EVIDENCE_STATE.unobserved, reason: typeof reason === "string" && reason.length > 0 ? reason : "not_observed" });
  }
  if (ok !== true) {
    return Object.freeze({ state: EVIDENCE_STATE.failed, reason: typeof reason === "string" && reason.length > 0 ? reason : "observation_failed" });
  }
  return Object.freeze({ state: EVIDENCE_STATE.verified, reason: null });
}

/**
 * Judge an optional observation against an expectation that may not exist.
 *
 * Fail-closed by default: a missing expectation yields `unobserved` with the reason
 * `no_expectation_configured`, NOT a pass. A caller for whom absence genuinely is
 * the expected outcome (for example "the covenant held" needs no shipment receipt)
 * must say so explicitly AND name the reason, which keeps the decision visible in
 * the artifact instead of hidden in a branch.
 */
export function judgeExpectation({
  expectation,
  observed,
  ok,
  reason,
  absentIsExpected = false,
  absentReason,
}) {
  if (expectation === null || expectation === undefined) {
    if (absentIsExpected !== true) {
      return Object.freeze({ state: EVIDENCE_STATE.unobserved, reason: "no_expectation_configured" });
    }
    if (typeof absentReason !== "string" || absentReason.length === 0) {
      // Declaring absence expected is itself a claim about the run; an unnamed
      // claim is exactly the silent pass this module exists to prevent.
      return Object.freeze({ state: EVIDENCE_STATE.unobserved, reason: "absence_expected_without_reason" });
    }
    return Object.freeze({ state: EVIDENCE_STATE.verified, reason: absentReason });
  }
  return judgeObserved({ observed, ok, reason });
}

/**
 * Roll several verdicts into one.
 *
 * `verified` only when every contributing verdict is verified: an unobserved input
 * can never be outvoted by verified siblings. `not_applicable` verdicts may be
 * passed by way of `judgeNotApplicable` and are excluded by the caller.
 */
export function rollupVerdicts(verdicts) {
  const list = Array.isArray(verdicts) ? verdicts : [];
  const failed = list.filter((v) => v?.state === EVIDENCE_STATE.failed);
  if (failed.length > 0) return Object.freeze({ state: EVIDENCE_STATE.failed, reasons: failed.map((v) => v.reason) });
  const unobserved = list.filter((v) => v?.state !== EVIDENCE_STATE.verified);
  if (unobserved.length > 0) {
    return Object.freeze({ state: EVIDENCE_STATE.unobserved, reasons: unobserved.map((v) => v?.reason ?? "not_observed") });
  }
  return Object.freeze({ state: EVIDENCE_STATE.verified, reasons: [] });
}

/** A verdict that genuinely does not apply (a rung that was not run). */
export function judgeNotApplicable(reason) {
  if (typeof reason !== "string" || reason.length === 0) {
    throw new Error("not_applicable_requires_reason");
  }
  return Object.freeze({ state: "not_applicable", reason });
}

/** True only for a verified verdict - the single spelling callers should use. */
export function isVerified(verdict) {
  return verdict?.state === EVIDENCE_STATE.verified;
}

/** True when the verdict is a pass, failing closed for anything unrecognised. */
export function isPass(verdict) {
  return isVerified(verdict);
}
