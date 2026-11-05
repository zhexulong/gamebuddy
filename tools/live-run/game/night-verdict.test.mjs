// A night that did not cross is reported by the case that explains it, never by one reason code.
//
// The three cases are not degrees of the same thing: (a) is her failure, (b) is the host player's absence, and (c) is a
// named refusal. These fixtures are the receipts that distinguish them - the Mod's own accepted `sleep`
// (`target=own_bed;never_direct_new_day=true`), its `waiting/requires_other_player` barrier terminal, and its
// `rejected` eligibility refusals - so the assertions run the REAL classifier on the shapes the game publishes.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPANION_DID_NOT_SLEEP,
  COMPANION_SLEEP_REFUSED,
  COMPANION_SLEEP_UNRESOLVED,
  COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
  judgeUncrossedNight,
  sleepVerdictCase,
  summarizeCrossings,
} from "./night-verdict.mjs";

/** The receipt a `sleep` dispatch is admitted with (`farmhandexecutioncontroller.lifecycleactions.cs:108-117`). */
const acceptedReceipt = (requestId) =>
  Object.freeze({
    requestId,
    actionId: "sleep",
    state: "accepted",
    reasonCode: "accepted",
    evidence: Object.freeze({ detail: "target=own_bed;never_direct_new_day=true" }),
  });

/**
 * The terminal the lifecycle mints, in the flat `key=value` shape it publishes.
 *
 * `ready`/`required` are the barrier's own counts from the terminal's settlement dict; `ready_at_completion` and
 * `required_at_completion` are published unconditionally and are still 0 on this path, because they are only assigned
 * when the barrier COMPLETES (`SleepAndAdvanceDayLifecycle.cs:1069-1070` vs `:1088-1099`). Reproducing that asymmetry
 * is the point: a fixture that filled them in would assert a shape the producer never emits.
 */
const lifecycleReceipt = (requestId, { state, reasonCode, extra = "" }) =>
  Object.freeze({
    requestId,
    actionId: "sleep",
    state,
    reasonCode,
    evidence: Object.freeze({
      detail:
        `state=${state};reason=${reasonCode};topology=multiplayer;entered_via=native_sleep_prompt;` +
        `saving_observed=false;saved_observed=false;day_started_observed=false;` +
        `save_boundary_not_observed=false;shipping_summary_settled=none;` +
        `ready_check_observed=true;ready_at_completion=0;required_at_completion=0;${extra}`,
    }),
  });

const witness = ({ requestId = "req_1", accepted = true, terminal = null } = {}) =>
  Object.freeze({
    requestId,
    accepted: accepted ? acceptedReceipt(requestId) : null,
    terminal,
  });

const waitingForTheHostPlayer = () =>
  witness({
    requestId: "req_slept",
    terminal: lifecycleReceipt("req_slept", {
      state: "blocked",
      reasonCode: "requires_other_player",
      extra: "ready=1;required=2;topology=multiplayer",
    }),
  });

const refusedBed = () =>
  witness({
    requestId: "req_refused",
    terminal: lifecycleReceipt("req_refused", { state: "rejected", reasonCode: "not_home" }),
  });

test("a night with no sleep dispatch is the companion's own failure", () => {
  const verdict = judgeUncrossedNight({ witnesses: [] });
  assert.equal(
    verdict.reasonCode,
    COMPANION_DID_NOT_SLEEP,
    `she never entered the day-advance path, so the reason is hers: got ${verdict.reasonCode}`,
  );
  assert.equal(verdict.sleepReceipt, null, "there is no receipt to quote, and inventing one is the defect");
  assert.equal(verdict.refusal, null);
});

test("a night she slept through and the host player did not is NOT the companion's failure", () => {
  const verdict = judgeUncrossedNight({ witnesses: [waitingForTheHostPlayer()] });
  assert.equal(
    verdict.reasonCode,
    COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
    `she declared locally ready and the barrier was the other player's: got ${verdict.reasonCode}`,
  );
  // THE DIFFERENCE THIS FIX HAS TO MAKE. One reason covered every uncrossed night, so this night - the one where
  // nothing was wrong on her side - was published under the code that reads as her failure.
  assert.notEqual(
    verdict.reasonCode,
    COMPANION_DID_NOT_SLEEP,
    "the single reason is what made the host player's absence unreadable as such",
  );
  assert.equal(sleepVerdictCase(verdict.reasonCode), COMPANION_SLEPT_HOST_PLAYER_DID_NOT);
  // The receipt that proves her readiness travels WITH the verdict: `requires_other_player` and the barrier's own
  // counts are what a reader needs to see that the night was waiting on somebody else.
  assert.equal(verdict.sleepReceipt.reasonCode, "requires_other_player");
  assert.equal(verdict.sleepReceipt.state, "blocked");
  assert.match(String(verdict.sleepReceipt.evidence.detail), /;ready=1;required=2;/u);
  assert.equal(verdict.sleepReceipt.target, "own_bed", "the bed is where the accepted receipt said she was going");
  assert.equal(verdict.refusal, null, "a wait is not a refusal");
});

test("a refused sleep is reported with its own code and the target it was reaching for", () => {
  const verdict = judgeUncrossedNight({ witnesses: [refusedBed()] });
  assert.equal(
    verdict.reasonCode,
    `${COMPANION_SLEEP_REFUSED}:not_home`,
    `the refusal code must survive into the reason: got ${verdict.reasonCode}`,
  );
  assert.deepEqual(verdict.refusal, { code: "not_home", target: "own_bed" });
  assert.notEqual(verdict.reasonCode, COMPANION_DID_NOT_SLEEP, "a named refusal is not an absence of an attempt");
  assert.notEqual(
    verdict.reasonCode,
    COMPANION_SLEPT_HOST_PLAYER_DID_NOT,
    "a refusal is not a night she slept and waited",
  );
});

test("the target outlives a terminal that does not publish one", () => {
  // The eligibility refusals carry `state=...;reason=...` and no `target=`; the ACCEPTED receipt for the same request
  // declares `target=own_bed`. Reading the two together is what lets the refusal be quoted with a subject instead of
  // a code alone.
  const terminalWithoutTarget = {
    ...refusedBed(),
    terminal: Object.freeze({
      requestId: "req_refused",
      actionId: "sleep",
      state: "rejected",
      reasonCode: "menu_open",
      evidence: Object.freeze({ detail: "state=menu_open;reason=menu_open;topology=single_player" }),
    }),
  };
  assert.equal(judgeUncrossedNight({ witnesses: [terminalWithoutTarget] }).refusal.target, "own_bed");
  const noAcceptedReceipt = Object.freeze({ ...terminalWithoutTarget, accepted: null });
  assert.equal(
    judgeUncrossedNight({ witnesses: [noAcceptedReceipt] }).refusal.target,
    null,
    "with neither receipt naming a target the field is null, not a plausible default",
  );
});

test("a wait outranks an earlier refusal in the same night", () => {
  // The day loop keeps offering turns until the day is crossed, so a night can hold a refused attempt AND a later
  // one she went to bed on. The later dispatch is what the night was.
  const verdict = judgeUncrossedNight({ witnesses: [refusedBed(), waitingForTheHostPlayer()] });
  assert.equal(verdict.reasonCode, COMPANION_SLEPT_HOST_PLAYER_DID_NOT);
  assert.equal(verdict.sleepReceipt.requestId, "req_slept", "the receipt quoted is the one that answers the night");
});

test("a terminal this verdict cannot attribute is named as unresolved, not as an absence or a refusal", () => {
  // `uncertain` is the Mod's own word for doubt about an effect (`farmhandexecutioncontroller.lifecycleactions.cs:153`).
  // Doubt is neither "she never tried" nor "her attempt was declined", and rounding it into either is the same
  // collapse this file exists to remove.
  const verdict = judgeUncrossedNight({
    witnesses: [
      witness({
        requestId: "req_uncertain",
        terminal: lifecycleReceipt("req_uncertain", { state: "uncertain", reasonCode: "sleep_lifecycle_threw" }),
      }),
    ],
  });
  assert.equal(verdict.reasonCode, `${COMPANION_SLEEP_UNRESOLVED}:uncertain/sleep_lifecycle_threw`);
  assert.notEqual(verdict.reasonCode, COMPANION_DID_NOT_SLEEP);
  assert.equal(verdict.refusal, null, "doubt is not a refusal, and a refusal code would be a claim nobody observed");
});

test("a dispatch with no terminal yet is unresolved, not an absence of one", () => {
  const verdict = judgeUncrossedNight({ witnesses: [witness({ requestId: "req_in_flight", terminal: null })] });
  assert.equal(verdict.reasonCode, `${COMPANION_SLEEP_UNRESOLVED}:in_flight`);
  assert.equal(verdict.sleepReceipt.state, null);
});

test("crossings 0 of 2 names the night it is missing, so the count cannot read as her failure", () => {
  const nights = [{ day: 1, nightVerdict: { reasonCode: COMPANION_SLEPT_HOST_PLAYER_DID_NOT, bedTime: 2210 } }];
  const line = summarizeCrossings({ crossings: 0, requestedCrossings: 2, nights });
  assert.match(line, /^crossings 0 of 2: night 1/u, `the count and the night travel together: ${line}`);
  assert.match(
    line,
    /she slept at 2210/u,
    `the hour she went to bed is the observation that makes the wait legible: ${line}`,
  );
  assert.match(line, /NOT a companion failure/u, `a zero here is the host player's absence, in words: ${line}`);
  assert.doesNotMatch(line, /her failure/u);
});

test("crossings 0 with no sleep receipt reads as her failure, and says so", () => {
  const line = summarizeCrossings({
    crossings: 0,
    requestedCrossings: 2,
    nights: [{ day: 1, nightVerdict: { reasonCode: COMPANION_DID_NOT_SLEEP, bedTime: null } }],
  });
  assert.match(line, /^crossings 0 of 2: night 1/u, line);
  assert.match(line, /never entered the day-advance path/u, line);
  assert.match(line, /her failure/u, line);
});

test("crossings 0 with a refusal quotes the code and the target in the same line", () => {
  const line = summarizeCrossings({
    crossings: 0,
    requestedCrossings: 2,
    nights: [
      {
        day: 1,
        nightVerdict: {
          reasonCode: `${COMPANION_SLEEP_REFUSED}:not_home`,
          refusal: { code: "not_home", target: "own_bed" },
        },
      },
    ],
  });
  assert.match(line, /her sleep was refused \(not_home, target own_bed\)/u, line);
  assert.match(line, /the run recorded no crossing for it/u, line);
});

test("a night whose bed time was never observed says so instead of printing a plausible hour", () => {
  const line = summarizeCrossings({
    crossings: 0,
    requestedCrossings: 2,
    nights: [{ day: 1, nightVerdict: { reasonCode: COMPANION_SLEPT_HOST_PLAYER_DID_NOT, bedTime: null } }],
  });
  assert.match(line, /she slept at an unobserved clock/u, line);
});

test("a run that crossed every night it was asked for reads as a pass, and a short run does not", () => {
  const crossed = summarizeCrossings({ crossings: 2, requestedCrossings: 2, nights: [] });
  assert.equal(crossed, "crossings 2 of 2: every night the run was asked for crossed");
  const stopped = summarizeCrossings({ crossings: 0, requestedCrossings: 2, nights: [] });
  assert.equal(stopped, "crossings 0 of 2: the run stopped before the night it was on had ended");
});

test("a harness reason is not mistaken for a sleep verdict", () => {
  // A watch that ended on a dead bridge or a stalled world has no finding about her dispatch; the summary must say the
  // run stopped rather than read the harness's own stop as a night that went wrong on her side.
  assert.equal(sleepVerdictCase("night_watched_over_a_dead_bridge:pipe_closed"), null);
  assert.equal(sleepVerdictCase("world_stopped_advancing:silent_ms=90000"), null);
  assert.equal(sleepVerdictCase(undefined), null);
  assert.equal(
    sleepVerdictCase(`${COMPANION_DID_NOT_SLEEP}:day_turn_still_running`),
    COMPANION_DID_NOT_SLEEP,
    "the harness's own suffix is read off the verdict, not treated as a different case",
  );
  const line = summarizeCrossings({
    crossings: 0,
    requestedCrossings: 2,
    nights: [{ day: 1, nightVerdict: { reasonCode: "night_watched_over_a_dead_bridge:pipe_closed" } }],
  });
  assert.match(line, /the run stopped before the night it was on had ended/u, line);
});
