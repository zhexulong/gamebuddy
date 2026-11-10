import assert from "node:assert/strict";
import test from "node:test";

import { NOT_MEASURED, describeRunCost, summarizeRunCost } from "./run-cost-account.mjs";

test("the two ratios come from the run's own populations, each with its counts beside it", () => {
  // The measured `round43` shape: 29 status polls over 26 accepted programmes, 96 model turns over 64 completed actions.
  const account = summarizeRunCost({ planPolls: 29, programmes: 26, modelTurns: 96, completedActions: 64 });
  assert.equal(account.plan_polls_per_programme, 1.12);
  assert.equal(account.plan_polls, 29);
  assert.equal(account.programmes, 26);
  assert.equal(account.turns_per_completed_action, 1.5);
  assert.equal(account.model_turns, 96);
  assert.equal(account.completed_actions, 64);
  assert.equal(account.plan_polls_not_measured, null, "a measured ratio names no missing field");
  assert.equal(account.turns_not_measured, null);
});

test("a run that never asked prints 0 polls per programme, not an absent field", () => {
  // The zero that is a MEASURED zero: the session made no status read at all, which is the outcome the account exists to
  // reward. `undefined` here would be an omitted key, and an omitted key reads as "nobody looked".
  const account = summarizeRunCost({ planPolls: 0, programmes: 4, modelTurns: 12, completedActions: 9 });
  assert.equal(account.plan_polls_per_programme, 0);
  assert.equal(Object.hasOwn(account, "plan_polls_per_programme"), true);
  assert.equal(account.turns_per_completed_action, 1.33);
  assert.match(describeRunCost(account), /plan polls per programme 0 \(0 polls of 4 programmes\)/u);
});

test("an unreadable population is `not_measured` with the field that was missing, never a zero", () => {
  // An unbound session record: the poll count does not exist, so a ratio built from it must not look like a good run.
  const unbound = summarizeRunCost({ planPolls: null, programmes: 3, modelTurns: null, completedActions: 8 });
  assert.equal(unbound.plan_polls_per_programme, NOT_MEASURED);
  assert.equal(unbound.plan_polls_not_measured, "session_record_unbound");
  assert.equal(unbound.turns_per_completed_action, NOT_MEASURED);
  assert.equal(unbound.turns_not_measured, "session_record_unbound");
  assert.equal(unbound.plan_polls, null, "and the number itself is stated as absent, not as 0");
  // Polls with nothing to divide them against is a finding, not a ratio.
  const noProgrammes = summarizeRunCost({ planPolls: 12, programmes: 0, modelTurns: 40, completedActions: 3 });
  assert.equal(noProgrammes.plan_polls_per_programme, NOT_MEASURED);
  assert.equal(noProgrammes.plan_polls_not_measured, "no_programmes_submitted");
  // Turns spent with nothing completed is the other half of the same question.
  const nothingDone = summarizeRunCost({ planPolls: 0, programmes: 2, modelTurns: 40, completedActions: 0 });
  assert.equal(nothingDone.turns_per_completed_action, NOT_MEASURED);
  assert.equal(nothingDone.turns_not_measured, "no_completed_actions");
  // An execution trace that could not be read leaves the denominator unmeasured rather than smaller.
  const traceGone = summarizeRunCost({ planPolls: 0, programmes: 2, modelTurns: 40, completedActions: null });
  assert.equal(traceGone.turns_not_measured, "execution_trace_unavailable");
  // The human line names which one is missing, so a reader of the log is told rather than left to notice an absence.
  assert.match(describeRunCost(unbound), /not_measured:session_record_unbound/u);
});
