// red-proof: inject  dropping the `other_player_owns_the_barrier` witness in night-verdict.mjs ->
//   `AssertionError: she declared locally ready: got companion_sleep_refused:requires_other_player` at
//   tools/live-run/game/run-stardew-native-local-agent-ab-live.test.mjs:2715
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DAILY_TASK_ROTATION } from "../../lib/multiday-daily-tasks.mjs";
import { DECIDER_WAKE_REASONS } from "../../lib/multiday-loop.mjs";
import { sessionEntries } from "../../lib/session-jsonl.mjs";
import { assessPlayerInputSchedule, SCHEDULED_DIALOGUE_GATES } from "../dialogue-gates.mjs";
import {
  BLIND_MARKER,
  DAY_ONE_WORDS,
  DAY_TWO_WORDS,
  dayTurnSource,
  deciderFactNames,
  deciderReturnedReasons,
  extractRunnerFunction,
  loadPromptScope,
  MULTIDAY_LOOP_SOURCE,
  OBSERVED_FIRST_DELIVERY,
  ROUND49_FIRST_DELIVERY,
  RUNNER_SOURCE,
  RUNNER_SURFACE_SOURCE,
  reasonsProbedFrom,
  sessionLine,
  suppliedFactNames,
} from "./run-stardew-native-local-agent-ab-live.support.mjs";

test("the day's shortage fact is composed once, on the first turn, and published beside the task verdicts", () => {
  // The runner must hand the fact over through the module whose once-ness is testable, not re-compose the sentence
  // here: a second spelling of the composition is how a fact quietly becomes an instruction on every turn.
  assert.match(
    RUNNER_SOURCE,
    /import \{ dayPromptWithFact, seedShortageFact \} from "\.\.\/\.\.\/lib\/seed-shortage\.mjs"/,
  );
  assert.match(RUNNER_SOURCE, /const withDayFact = \(prompt, fact\) => dayPromptWithFact\(prompt, fact, localeKey\)/);
  // ONCE PER DAY: the fact is computed under the first-turn guard, from the world as it stands then.
  assert.match(
    RUNNER_SOURCE,
    /const dayFact =\s*turns === 1\s*\?\s*seedShortageFact\(\{/,
    "the fact is computed on the day's first turn and on no other turn",
  );
  assert.match(RUNNER_SOURCE, /taskId: taskForDay\(day\),\s*snapshot: client\.state\?\.snapshot \?\? null,/);
  // And the first-turn prompt is the one that carries it: a fact appended to a later turn would repeat.
  assert.match(RUNNER_SOURCE, /turns === 1\s*\?\s*withDayFact\(dayWords, dayFact\)/);
  // The day's own words are named ONCE, because two readers need the same string: the prompt that is asked, and the words
  // the day's delivery is found by in the session record.
  assert.match(RUNNER_SOURCE, /const dayWords = turns === 1 \? promptForDay\(day\) : null;/);
  // Published, so "she was handed the supply and did not go" is distinguishable from "nothing ever told her".
  assert.match(RUNNER_SOURCE, /const seedFacts = \[\];/);
  assert.match(RUNNER_SOURCE, /if \(dayFact !== null\) seedFacts\.push\(Object\.freeze\(\{ day, \.\.\.dayFact \}\)\);/);
  assert.match(RUNNER_SOURCE, /\n {4}seedFacts,/);
});

/**
 * THE OTHER HALF OF REACHABILITY, on the runner's side of it.
 *
 * `objective_unreachable_for_today` is answered from `readObjectiveState`, which answers `advancing` whenever either
 * the progress or the span is unmeasured - deliberately, so "we could not tell" can never licence the reason. The
 * consequence for the RUN is not visible to any test of the decider: a day loop that hands `decideDayWake` an
 * `objectiveMet` and nothing else can never reach the reason, however late its evening gets, and every producer table
 * above would still pass. Measured on the tree this test was written against: the runner's one `decideDayWake` call
 * passed neither `objectiveProgressSinceMs` nor `objectiveSpanMs`.
 */
test("the day loop measures the facts its objective branch reads, instead of handing the decider a branch that cannot fire", () => {
  const loop = dayTurnSource(RUNNER_SOURCE);
  const callAt = loop.indexOf("decideDayWake({");
  assert.ok(callAt >= 0, "the day loop must ask the decider");
  const call = loop.slice(callAt, loop.indexOf("});", callAt) + 3);
  // WHICH FACTS MUST BE HANDED OVER IS NOT A LIST HERE. It used to be one - three names typed into this test - and it
  // could not notice a fact the decider reads that the loop never supplies, which is exactly how `worldStateStale` sat
  // dead in `round76`'s day loop for a whole night. `wakeReachability` below derives the population from the decider's
  // own signature and from the reasons its return sites name, so a fact added tomorrow is examined without editing this.
  // What is asserted here is the SHAPE of the two measurements: the progress is the age of the objective's own published
  // reading and the span is this run's prompt-turn cadence, so a constant cannot stand in for either.
  assert.match(
    call,
    /objectiveProgressSinceMs:[\s\S]{0,120}?objectiveProgress/u,
    "the progress handed to the decider must be the age of the objective's published reading",
  );
  assert.match(
    call,
    /objectiveSpanMs: medianPromptTurnIntervalMs\(/u,
    "the span handed to the decider must be this run's own measured prompt-turn interval",
  );
});

/**
 * A REASON THAT CAN NEVER FIRE IS A REASON THAT LIES ABOUT WHAT CAN WAKE HER.
 *
 * Measured 2026-11-18 (`round76`): `multiday.wakes.byReason` read `stall_wake 0`, `stale_world 0`, `day_end_offer 0`,
 * and the longest silence was 701,970 ms ending on `waiting_for_the_world`. The cause was one missing fact: the day loop
 * called `decideDayWake({...})` without `worldStateStale`, so `if (worldStateStale === true)` was dead code in the only
 * loop that runs it - and the cutscene ended at 23:05:58 with `can_move=true` while nothing woke her until the next
 * in-game evening. Every producer table in this file passed throughout, because a table that hands the decider its facts
 * says nothing about whether the runner does.
 *
 * So the population is the decider's own return sites, and reachability is measured against the fact set the DAY LOOP
 * supplies - not against the facts the decider declares. `reasons examined R · reachable A · declared D` prints all
 * three: `D` is a reason the vocabulary declares that these return sites do not name (a call-site reason such as
 * `player_input`), which is a declaration and not a dead branch.
 */
test("a wake reason that can never fire, and a fact the decider reads that the day loop never hands over", () => {
  const loop = dayTurnSource(RUNNER_SOURCE);
  const declared = deciderFactNames(MULTIDAY_LOOP_SOURCE);
  const supplied = suppliedFactNames(loop);
  assert.ok(declared.length > 0, "examined 0 decider facts - a check whose population is empty agrees with itself");
  for (const fact of supplied) {
    assert.ok(
      declared.includes(fact),
      `a_wake_fact_the_decider_does_not_read:${fact} - the day loop hands over a fact no branch of the decision asks for`,
    );
  }
  for (const fact of declared) {
    assert.ok(
      supplied.includes(fact),
      `a_wake_fact_the_day_loop_never_hands_over:${fact} - the branch that reads it cannot fire in any run`,
    );
  }
  const examined = deciderReturnedReasons(MULTIDAY_LOOP_SOURCE);
  assert.ok(examined.length > 0, "examined 0 wake reasons - a check whose population is empty agrees with itself");
  const reachable = reasonsProbedFrom(MULTIDAY_LOOP_SOURCE, supplied);
  const declaredElsewhere = DECIDER_WAKE_REASONS.filter((reason) => !examined.includes(reason));
  const reachableExamined = examined.filter((reason) => reachable.has(reason));
  console.log(
    `wake reachability gate: reasons examined ${String(examined.length)} · reachable ${String(
      reachableExamined.length,
    )} · declared ${String(declaredElsewhere.length)} (facts supplied ${String(supplied.length)} of ${String(
      declared.length,
    )})`,
  );
  for (const reason of examined) {
    if (reachable.has(reason) || declaredElsewhere.includes(reason)) continue;
    assert.fail(
      `a_wake_reason_that_can_never_fire:${reason} - the decision names it, and the day loop's own facts can never reach it`,
    );
  }
});

test("the run's prompt-turn span is measured from its own turns, and an unmeasured cadence is not a span", () => {
  // "Nothing moved for a whole turn" is a statement about THIS run's turns, so the number comes from the turn starts
  // the harness recorded. Fewer than two turns is no interval at all - `null`, which `readObjectiveState` refuses as
  // unmeasured - rather than a zero that would read as a stall nobody observed.
  const interval = extractRunnerFunction(RUNNER_SURFACE_SOURCE, "medianPromptTurnIntervalMs");
  assert.equal(interval([]), null, "a run with no prompt turn has no cadence to measure");
  assert.equal(interval([1_000]), null, "one turn is not an interval");
  assert.equal(interval([1_000, 3_000]), 2_000, "two turns: the one interval between them");
  assert.equal(interval([0, 10_000, 30_000]), 15_000, "two intervals: their mean, rounded");
  assert.equal(interval([0, 10_000, 30_000, 100_000]), 20_000, "three intervals: the middle one");
  // A cadence the world produced in zero milliseconds is `0`, and `readObjectiveState` refuses `spanMs <= 0` as an
  // unmeasured span: the answer is `advancing`, not a stall. The reading does not silently become `1` here.
  assert.equal(interval([5, 5]), 0);
});

test("the day's offer is closed by BOTH reasons that make it, and asked as the late-day question", () => {
  // `decideWake` answers `already_offered` once `dayEndOffered` is true, for `day_end_offer` AND for
  // `objective_unreachable_for_today`: they are the day's one question, asked once. The runner keeps one flag, so a
  // flag closed on only one of them re-asks the same question on every poll until the night - the ping the flag
  // exists to remove - and the second reason only became able to fire once the run measured the two facts above.
  const loop = dayTurnSource(RUNNER_SOURCE);
  const flagAt = loop.indexOf("dayEndOffered = true");
  assert.ok(flagAt >= 0, "the day loop must remember that it offered the day");
  // The STATEMENT, not the line: the condition names both reasons and may be laid out over several lines.
  const statementAt = loop.lastIndexOf("if (", flagAt);
  assert.ok(statementAt >= 0 && statementAt < flagAt, "the flag must be closed by a condition, not unconditionally");
  const flagStatement = loop.slice(statementAt, loop.indexOf("\n", flagAt));
  for (const reason of ["WAKE_REASON.dayEndOffer", "WAKE_REASON.objectiveUnreachableForToday"]) {
    assert.ok(
      flagStatement.includes(reason),
      `the day's offer is not closed when ${reason} fires: it repeats every poll`,
    );
  }
  // AND ASKED AS THE LATE-DAY QUESTION: this reason means the rest of the day is the decision, so the prompt states
  // the clock and the one action that ends a day rather than saying "carry on".
  const promptChoice = loop.slice(loop.indexOf("const prompt ="), loop.indexOf("const spokenBefore"));
  assert.ok(promptChoice.length > 0, "the day loop must choose what it asks her");
  assert.ok(
    promptChoice.includes("WAKE_REASON.objectiveUnreachableForToday"),
    "the reason's own question is not chosen: it would fall through to whichever prompt the clock happened to select",
  );
  assert.ok(
    /objectiveUnreachableForToday[\s\S]{0,80}promptForLateDay/u.test(promptChoice),
    "the still objective is asked the late-day question, not `carry on`",
  );
});

test("the multi-day result publishes the wake account the verdict reads", () => {
  // The account cannot be reconstructed from the session alone - a prompt that was never issued leaves no record there -
  // so the runner has to publish it by name.
  assert.match(RUNNER_SOURCE, /dayEndOffers:/u);
  assert.match(RUNNER_SOURCE, /stallWakes:/u);
  assert.match(RUNNER_SOURCE, /suppressedByReason:/u);
  assert.match(RUNNER_SOURCE, /suppressed: wakesSuppressed/u);
  // THE SILENCE, PUBLISHED - and the two spans it is made of, each under its own name. `noWakeForMs` is the run's
  // silence, read from the turn stream; `dayLoopWithheldWakeMs` is the day loop's own share of the wait. Publishing one
  // under the other's name is the defect this pair replaces: measured 2026-11-19 (`round77`), `noWakeForMs: 712856` on a
  // run whose 171 turn openings were never more than 175,201 ms apart.
  assert.match(RUNNER_SOURCE, /noWakeForMs: silence\.longestMs/u);
  assert.match(RUNNER_SOURCE, /noWakeTurns: silence\.turns/u);
  assert.match(RUNNER_SOURCE, /dayLoopWithheldWakeMs: withheldWake\.forMs/u);
  assert.match(RUNNER_SOURCE, /dayLoopWithheldWakeReason: withheldWake\.lastReason/u);
  // AND MEASURED FROM THE TURN STREAM, not from this loop's own wake accounting: the real `turnGap` runs here, against a
  // record whose turns the loop never issued.
  const turnGap = extractRunnerFunction(RUNNER_SURFACE_SOURCE, "turnGap", { sessionEntries });
  const at = (offsetMs) => new Date(Date.UTC(2026, 10, 19, 4, 46, 54) + offsetMs).toISOString();
  const entry = (offsetMs, role) =>
    `${JSON.stringify({ type: "message", timestamp: at(offsetMs), message: { role, content: [] } })}\n`;
  const gaps = turnGap(
    `${JSON.stringify({ type: "session", version: 3, timestamp: at(0) })}\n${entry(1_000, "user")}${entry(30_000, "assistant")}${entry(90_000, "user")}${entry(100_000, "user")}{half-written\n`,
  );
  assert.equal(gaps.turns, 3, "every user message is one turn opened, and the assistant's reply is not one");
  assert.equal(gaps.longestMs, 89_000, "the longest stretch between two turn openings, not the run's wall clock");
  assert.equal(turnGap("").longestMs, null, "a record with no turn has no interval to measure, not a zero");
  assert.equal(turnGap(entry(5_000, "user")).turns, 1);
  assert.equal(turnGap(entry(5_000, "user")).longestMs, null, "one turn is not an interval");
  assert.equal(
    turnGap(`${entry(5_000, "user")}${entry(5_000, "user")}`).longestMs,
    0,
    "two openings at one instant is a measured zero",
  );
  assert.match(RUNNER_SOURCE, /"MULTIDAY_NO_WAKE"/u);
  assert.match(RUNNER_SOURCE, /no_wake_for_ms:\$\{String\(silence\.longestMs\)\}:\$\{String\(silence\.turns\)\}/u);
  assert.match(RUNNER_SOURCE, /day_loop_withheld_wake_ms:\$\{String\(withheldWake\.forMs\)\}/u);
  // The span the objective branch read travels with them: a run that published `objective_unreachable_for_today: 1`
  // must be readable against the number that licensed it, and that number exists nowhere else.
  assert.match(RUNNER_SOURCE, /objectiveSpanMs/u);
});

/**
 * THE PROMISE THAT WAS NEVER TAKEN, on the runner's own side of it.
 *
 * The reading itself is the baseline module's (`multiday-baseline.test.mjs` drives it, in both directions). What can only
 * be checked here is that the runner JOINS the two halves the reading needs - what she said, per turn, and whether that
 * turn submitted `sleep` - because `sessionTurns` is the only record where they meet.
 *
 * Measured 2026-11-13 (`round47`): nine delivered turns in the farmhouse with her saying 「就睡」/「躺平」/「这觉才算真睡下去」,
 * and ZERO `sleep` submissions in fifty-nine turns. The night was reported as `pass_out` - its consequence - so the
 * wiring below is what makes the cause visible at all.
 */
test("the runner records, per turn, whether that turn submitted a sleep", () => {
  const sleepSubmittedSince = extractRunnerFunction(RUNNER_SURFACE_SOURCE, "sleepSubmittedSince");
  const flat = (action) => ({ via: "flat", action, requestId: `req-${action}`, state: "succeeded" });
  const program = (actionId, args = {}) => ({
    programId: `plan_${actionId}`,
    accepted: true,
    nodes: [{ nodeId: "n01", actionId, arguments: args }],
  });
  // THE FLAT CHANNEL: the row is appended by the turn that dispatched it, and only rows AFTER the marker count.
  const beforeTheTurn = [flat("harvest_crop")];
  assert.equal(
    sleepSubmittedSince(
      { traceFrom: beforeTheTurn.length, submissionsFrom: 0 },
      { trace: [...beforeTheTurn, flat("sleep")], submissions: [] },
    ),
    true,
    "a flat `sleep` in this turn is the action that ends the night",
  );
  // THE PROGRAM CHANNEL: a node names the action, and there is no trace row for it at all.
  assert.equal(
    sleepSubmittedSince(
      { traceFrom: 0, submissionsFrom: 0 },
      { trace: [], submissions: [program("move_to_tile"), program("sleep")] },
    ),
    true,
    "a `sleep` node inside a submitted program is the same night ended",
  );
  // AND THE OTHER DIRECTION, which is the run this reading exists for: a turn of ordinary farm work submits no sleep, and
  // the thing that merely LOOKS like it - the emote named `sleep` - is not the action.
  assert.equal(
    sleepSubmittedSince(
      { traceFrom: 0, submissionsFrom: 0 },
      {
        trace: [flat("move_to_tile"), flat("express_emote")],
        submissions: [program("express_emote", { emote: "sleep" })],
      },
    ),
    false,
    "an emote named sleep is not the sleep action",
  );
  // A DISPATCH FROM AN EARLIER TURN IS NOT THIS TURN'S: the markers are the boundary, so a night she ended before this
  // turn cannot answer for it.
  const earlier = [flat("sleep")];
  assert.equal(
    sleepSubmittedSince(
      { traceFrom: earlier.length, submissionsFrom: 1 },
      {
        trace: [...earlier, flat("harvest_crop")],
        submissions: [program("sleep"), program("harvest_crop")],
      },
    ),
    false,
    "only what arrived after the marker belongs to this turn",
  );
  // AND THE WIRING, which no unit of the reading can check: the turn carries the answer, and the assessment is handed
  // the reading instead of judging the night by its consequence alone.
  assert.match(
    RUNNER_SOURCE,
    /sessionTurns\.push\(\s*Object\.freeze\(\{\s*goalIndex:[\s\S]{0,400}?sleepSubmitted,/u,
    "the turn record must carry what the turn dispatched beside what it said",
  );
  assert.match(
    RUNNER_SOURCE,
    /const sleepPromises = sleepPromisesNotTaken\(\{\s*turns: attributeTurnSpeech\(sessionTurns, presentationPieces\),/u,
    "the reading is taken from the turn stream, with its population printed",
  );
  // AND THE TURN STREAM IT IS HANDED CARRIES THE LINES THE PRESENTATION PORT COMMITTED FOR THAT TURN, not a slice taken
  // when the turn's await returned: `round87b` recorded `spokenLines: []` for a day whose window held nineteen bubbles, so
  // a promise made that day was invisible to this reading (`./turn-speech.mjs`).
  assert.match(
    RUNNER_SOURCE,
    /sessionTurns: attributeTurnSpeech\(sessionTurns, presentationPieces\),/u,
    "the bundle publishes the attributed turns, so the lines are checkable in the artifact",
  );
  assert.match(
    RUNNER_SOURCE,
    /assessMultiDayBaseline\(\{[\s\S]{0,1200}?sleepPromises: sleepPromises\.readings,/u,
    "the assessment must be handed the promises, not asked to guess them from the pass-out",
  );
  assert.match(
    RUNNER_SOURCE,
    /MULTIDAY_SLEEP_PROMISES[\s\S]{0,400}?examined: sleepPromises\.examined/u,
    "the population the reading examined is printed beside the readings themselves",
  );
});

test("the fragment the note assertion searches for is the note's own text, for every task the rotation can ask for", () => {
  // A second hand-written copy of the note would pass this assertion on the day it was written and stop meaning anything
  // the moment the note's wording changed. The population comes from the rotation, not from a list here.
  const scope = loadPromptScope();
  const drifted = [];
  for (const task of DAILY_TASK_ROTATION) {
    for (const locale of ["zh", "en"]) {
      const fragment = scope.dayNoteFragment(task, locale);
      const note = scope.SCENARIO_PROMPTS.multiday_routine[locale](1, task);
      if (typeof fragment !== "string" || fragment.length === 0) drifted.push(`${locale}:${task}:no_fragment`);
      else if (!note.includes(fragment)) drifted.push(`${locale}:${task}:not_in_the_note`);
    }
  }
  assert.deepEqual(drifted, [], drifted.join("; "));
  // A task the table cannot state is reported as a missing note text, never as an empty fragment that matches everything.
  assert.equal(scope.dayNoteFragment("a_task_nobody_wrote", "zh"), null);
});

test("the session reader answers what she was told, and null when it could not read the record", () => {
  // The reader is the instrument the whole assertion rests on: an admission the Host accepted and never delivered must be
  // visible as absent, so the reading is taken from the session's own user messages.
  const readSessionPlayerTexts = extractRunnerFunction(RUNNER_SURFACE_SOURCE, "readSessionPlayerTexts", {
    readFileSync,
    sessionEntries,
  });
  const dir = mkdtempSync(join(tmpdir(), "session-player-texts-"));
  const path = join(dir, "session.jsonl");
  writeFileSync(
    path,
    [
      sessionLine("早上好"),
      JSON.stringify({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "早上好。" }] },
      }),
      JSON.stringify({ type: "message", message: { role: "user", content: "a bare string" } }),
      JSON.stringify({ type: "other", message: { role: "user", content: "not a message entry" } }),
      "{ half-written",
    ].join("\n"),
    "utf8",
  );
  assert.deepEqual(readSessionPlayerTexts(path), ["早上好", "a bare string"]);
  assert.equal(readSessionPlayerTexts(undefined), null, "no record is not an empty record");
  assert.equal(readSessionPlayerTexts(join(dir, "absent.jsonl")), null);
});

test("round49's shape is three findings and a zero, and the same run with its note delivered is none", () => {
  // Both cases from ONE population: the session record this run would have written. The note's text is composed by the
  // runner's own scenario prompt, and the fragment is the table entry that note is built from.
  const scope = loadPromptScope();
  const stance = SCHEDULED_DIALOGUE_GATES.find((entry) => entry.id === "turn-initiative-split");
  const note = scope.SCENARIO_PROMPTS.multiday_routine.zh(1, "clear_east_patch");
  const scheduled = [{ day: 1, task: "clear_east_patch", note: scope.dayNoteFragment("clear_east_patch", "zh") }];
  const readSessionPlayerTexts = extractRunnerFunction(RUNNER_SURFACE_SOURCE, "readSessionPlayerTexts", {
    readFileSync,
    sessionEntries,
  });
  const dir = mkdtempSync(join(tmpdir(), "day-note-"));
  const round49Session = join(dir, "round49.jsonl");
  const correctSession = join(dir, "correct.jsonl");
  writeFileSync(round49Session, sessionLine(stance.prompt), "utf8");
  writeFileSync(correctSession, [sessionLine(note), sessionLine(stance.prompt)].join("\n"), "utf8");

  const lost = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled,
    inputs: [
      { day: 1, channel: "harness", text: note, admitted: true },
      {
        day: 1,
        channel: "gate",
        gateId: stance.id,
        text: stance.prompt,
        declaredGameTime: stance.trigger.atGameTime,
        gameTime: 620,
        admitted: true,
      },
    ],
    sessionTexts: readSessionPlayerTexts(round49Session),
  });
  assert.equal(lost.reading, "days scheduled 1 · notes delivered 0");
  assert.deepEqual(
    lost.findings.map((finding) => finding.code),
    [
      "day_note_not_delivered:1:clear_east_patch",
      "dialogue_gate_preempted_the_day_note:turn-initiative-split:1",
      "dialogue_gate_fired_early:turn-initiative-split:1200:0620",
    ],
  );
  assert.equal(lost.passed, false);

  const correct = assessPlayerInputSchedule({
    schedulesDayNotes: true,
    scheduled,
    inputs: [
      { day: 1, channel: "harness", text: note, admitted: true },
      {
        day: 1,
        channel: "gate",
        gateId: stance.id,
        text: stance.prompt,
        declaredGameTime: stance.trigger.atGameTime,
        gameTime: 1205,
        admitted: true,
      },
    ],
    sessionTexts: readSessionPlayerTexts(correctSession),
  });
  assert.deepEqual(correct.findings, []);
  assert.equal(correct.reading, "days scheduled 1 · notes delivered 1");
  assert.equal(correct.passed, true);
});

test("the note assertion is wired to the session record, the planner's clock and the run's verdict", () => {
  // A reading nobody calls is a document. These are the links that make it a measurement.
  assert.match(RUNNER_SOURCE, /assessPlayerInputSchedule,/);
  // 1. BOTH submission sites record what they sent, and where the note arrived from: the harness's own day turns and the
  //    scheduled gates. One site recording is a note whose absence can only be guessed at.
  assert.equal(
    (RUNNER_SOURCE.match(/playerInputs\.push\(/gu) ?? []).length,
    2,
    "the day turns and the gates are the two places a player line is submitted",
  );
  // 2. The clock reaches the planner, read at the boundary that speaks - otherwise `atGameTime` is a comment.
  assert.match(
    RUNNER_SOURCE,
    /const boundaryClock = readWorldClock\(\);\n\s+const gameTime = boundaryClock\.unknown === true \? null : boundaryClock\.timeOfDay;/u,
    "the boundary reads the world clock it is about to be judged on",
  );
  assert.match(RUNNER_SOURCE, /planGateDeliveries\(SCHEDULED_DIALOGUE_GATES, \{\n\s+day,\n\s+gameTime,/u);
  // 3. The reading is taken from THIS run's session record, and prints its population so a zero is visible as a zero.
  assert.match(
    RUNNER_SOURCE,
    /const sessionDeliveryTexts = readSessionPlayerTexts\(sessionSearch\.path\);/u,
    "the reading must read what arrived, not what was sent",
  );
  assert.match(RUNNER_SOURCE, /sessionTexts: sessionDeliveryTexts,/u, "and it is that read the note reading is handed");
  assert.match(RUNNER_SOURCE, /MULTIDAY_DAY_NOTES[\s\S]{0,200}dayNoteDelivery\.reading/u);
  // 4. And it reaches the verdict: an arm of the session verdict (so `completed` is unreachable), a clause of its own,
  //    and the reading itself in result.json.
  assert.match(RUNNER_SOURCE, /dayNoteVerdict: dayNoteDelivery\.verdictCode,/u);
  assert.match(RUNNER_SOURCE, /if \(dayNoteVerdict !== null\) return dayNoteVerdict;/u);
  assert.match(RUNNER_SOURCE, /id: "day_note_delivery",/u);
  assert.match(RUNNER_SOURCE, /^\s+dayNoteDelivery,$/mu, "the reading must reach result.json");
});

test("a day that opened without a world is a finding, named with its day and the wait in front of it", () => {
  const [readDayStartDeliveries, assessDayStarts] = extractRunnerFunction(RUNNER_SURFACE_SOURCE, [
    "readDayStartDeliveries",
    "assessDayStarts",
  ]);
  // RED, on round49's own delivery: the message that reached her carried no world.
  const blind = readDayStartDeliveries({
    days: [{ day: 1, prompt: DAY_ONE_WORDS, waitedMs: 15_000 }],
    texts: [ROUND49_FIRST_DELIVERY],
    marker: BLIND_MARKER,
  })[0];
  assert.equal(blind.measured, true);
  assert.equal(blind.startedBlind, true, "round49's first delivery was handed a turn with no world in it");
  const red = assessDayStarts({ scheduledDays: 1, readings: [blind] });
  assert.deepEqual(
    red.findings.map((finding) => finding.code),
    ["day_started_blind:1"],
  );
  assert.equal(red.findings[0].waitedMs, 15_000, "the finding carries the wait that expired in front of it");
  assert.equal(red.reading, "days started blind 1 of 1");
  assert.equal(red.verdictCode, "day_started_blind:1");
  assert.equal(red.blocked, null);

  // GREEN, on the delivery the attach boundary produces: the world-state block is the reading itself, so a reader can
  // check the judgement instead of trusting it.
  const observed = readDayStartDeliveries({
    days: [{ day: 1, prompt: DAY_ONE_WORDS, waitedMs: 0 }],
    texts: [OBSERVED_FIRST_DELIVERY],
    marker: BLIND_MARKER,
  })[0];
  assert.equal(observed.startedBlind, false);
  assert.match(observed.worldState ?? "", /^<world-state>世界（revision 0/u);
  const green = assessDayStarts({ scheduledDays: 1, readings: [observed] });
  assert.deepEqual(green.findings, []);
  assert.equal(green.reading, "days started blind 0 of 1");
  assert.equal(green.verdictCode, null);
});

test("a day is found by its own words, not by the message that happened to arrive after the turn opened", () => {
  const [readDayStartDeliveries, assessDayStarts] = extractRunnerFunction(RUNNER_SURFACE_SOURCE, [
    "readDayStartDeliveries",
    "assessDayStarts",
  ]);
  // ROUND99'S OWN SHAPE: day 2's prompt was admitted at 10:07:55 and the Host wrote it into the record at 10:09:52, with
  // the pump's own batches in between. A reading indexed off the record as it stood when the turn opened took "the next
  // user message" and found none (`day_start_reading_missing:2:no_user_message_after_day_prompt`), and the day AFTER it was
  // read off the day before: day 1's reading was the attach batch, not the day's words.
  const round99 = [
    OBSERVED_FIRST_DELIVERY,
    "<world-facts>\n- 12:00 又过了一个时辰：1200 ·current\n</world-facts>",
    "<world-facts>\n- express_emote 没做成。A cutscene currently holds the farmhand.\n</world-facts>",
    `${DAY_TWO_WORDS}\n<world-state>\n世界（revision 104，刚刚更新）08:10（上午）；1年第6天 春季；位置: 农场\n</world-state>`,
  ];
  const readings = readDayStartDeliveries({
    days: [
      { day: 1, prompt: DAY_ONE_WORDS, waitedMs: 0 },
      { day: 2, prompt: DAY_TWO_WORDS, waitedMs: 250 },
    ],
    texts: round99,
    marker: BLIND_MARKER,
  });
  assert.deepEqual(
    readings.map((reading) => [reading.day, reading.measured, reading.startedBlind]),
    [
      [1, true, false],
      [2, true, false],
    ],
    "both days were delivered and both opened on an observed world",
  );
  assert.match(readings[1].worldState ?? "", /1年第6天/u, "day 2's reading is day 2's own delivery");
  assert.equal(readings[1].waitedMs, 250);
  const assessed = assessDayStarts({ scheduledDays: 2, readings });
  assert.deepEqual(assessed.findings, []);
  assert.equal(
    assessed.verdictCode,
    null,
    "a delivered day cannot be blocked for a prompt the record had not reached yet",
  );

  // TWO DAYS THAT ASK THE SAME THING read two deliveries, in order, instead of the first one twice.
  const repeated = readDayStartDeliveries({
    days: [
      { day: 1, prompt: DAY_ONE_WORDS, waitedMs: 0 },
      { day: 2, prompt: DAY_ONE_WORDS, waitedMs: 0 },
    ],
    texts: [ROUND49_FIRST_DELIVERY, OBSERVED_FIRST_DELIVERY],
    marker: BLIND_MARKER,
  });
  assert.deepEqual(
    repeated.map((reading) => reading.startedBlind),
    [true, false],
    "the second day reads the second delivery, not the first one over again",
  );
});

test("the reading is over the days the run scheduled, so zero days and an unread record cannot pass", () => {
  const [readDayStartDeliveries, assessDayStarts] = extractRunnerFunction(RUNNER_SURFACE_SOURCE, [
    "readDayStartDeliveries",
    "assessDayStarts",
  ]);
  // A run that scheduled no day has not been measured, and `0 of 0` would agree with itself.
  const empty = assessDayStarts({ scheduledDays: 0, readings: [] });
  assert.equal(empty.reading, "days started blind 0 of 0");
  assert.equal(empty.blocked, "no_days_scheduled");
  assert.equal(empty.verdictCode, "no_days_scheduled", "zero population is blocked, never green");

  // The three gaps that are not "blind" and are not a pass either, each with its own owner.
  const unread = readDayStartDeliveries({
    days: [{ day: 1, prompt: DAY_ONE_WORDS, waitedMs: null }],
    texts: null,
    marker: BLIND_MARKER,
  })[0];
  assert.equal(unread.measured, false);
  assert.equal(unread.reason, "session_record_unreadable");
  const blocked = assessDayStarts({ scheduledDays: 1, readings: [unread] });
  assert.equal(blocked.findings[0].code, "day_start_reading_missing:1:session_record_unreadable");
  assert.equal(blocked.verdictCode, "day_start_reading_missing:1:session_record_unreadable");
  // A day the record never carried: the prompt was admitted and never delivered, which is a finding about the day and not
  // a silence about her.
  const never = readDayStartDeliveries({
    days: [{ day: 2, prompt: DAY_TWO_WORDS, waitedMs: 0 }],
    texts: [OBSERVED_FIRST_DELIVERY],
    marker: BLIND_MARKER,
  })[0];
  assert.equal(never.reason, "day_prompt_not_in_session");
  // A day scheduled without words to look for is the harness's own gap, named as one.
  assert.equal(
    readDayStartDeliveries({ days: [{ day: 1, prompt: "", waitedMs: 0 }], texts: [], marker: BLIND_MARKER })[0].reason,
    "day_prompt_text_missing",
  );
  // And a reading with no marker fails loudly: comparing against "" would call every delivery blind or every one sound.
  assert.throws(
    () => readDayStartDeliveries({ days: [{ day: 1, prompt: DAY_ONE_WORDS }], texts: [OBSERVED_FIRST_DELIVERY] }),
    /day_start_marker_required/u,
  );
});

test("the wait for the world is bounded in polls as well as in the clock, and its expiry is named", async () => {
  const [awaitDayOpeningWorld, dayPromptWithoutObservation] = extractRunnerFunction(RUNNER_SURFACE_SOURCE, [
    "awaitDayOpeningWorld",
    "dayPromptWithoutObservation",
  ]);
  // The world arrives on the third poll: the wait reports HOW LONG, and the revision it saw.
  let probes = 0;
  const observed = await awaitDayOpeningWorld({
    probe: () => {
      probes += 1;
      return { observed: probes >= 3, revision: probes >= 3 ? 0 : null };
    },
    timeoutMs: 10_000,
    pollMs: 100,
    now: () => 0,
    pause: async () => {},
  });
  assert.equal(observed.observed, true);
  assert.equal(observed.polls, 2);
  assert.equal(observed.revision, 0);
  assert.equal(observed.waitedMs, 0);

  // It never arrives and the clock never moves: the POLL BOUND is what ends the wait, so "bounded" is a property of this
  // function rather than a claim about the caller's clock.
  let never = 0;
  const expired = await awaitDayOpeningWorld({
    probe: () => {
      never += 1;
      return { observed: false };
    },
    timeoutMs: 1000,
    pollMs: 100,
    now: () => 0,
    pause: async () => {},
  });
  assert.equal(expired.observed, false);
  assert.equal(expired.polls, 11);
  assert.ok(never >= 12, "the probe is not asked after the bound is spent");

  // The prompt keeps the day's own words and says what the harness could not hand over - a fact about the harness, not
  // an instruction to go and look.
  const dayPrompt = "第 1 天：去钓鱼。";
  const expiredPrompt = dayPromptWithoutObservation(dayPrompt, { observed: false, waitedMs: 15_000 }, "zh");
  assert.ok(expiredPrompt.startsWith(dayPrompt), "the day's prompt is not rewritten");
  assert.match(expiredPrompt, /系统没有拿到世界的观察：等了 15 秒/u);
  assert.doesNotMatch(
    expiredPrompt,
    /观察一下|先看看|observe first/u,
    "the fix is the snapshot, not a sentence telling her to look",
  );
  assert.equal(dayPromptWithoutObservation(dayPrompt, { observed: true, waitedMs: 0 }, "zh"), dayPrompt);
});

test("the attach boundary is called before the first prompt, and both first turns wait for the world", () => {
  const attachBoundaryGate = (source) => {
    const at = source.indexOf("runtime.connected.activateIngress();");
    const guard = source.indexOf(
      'if (runtime.connected === undefined) throw new Error("agent_runtime_not_connected");',
    );
    return at > 0 && guard !== -1 && guard < at && at < source.indexOf("await runAgentTurn(");
  };
  assert.ok(
    attachBoundaryGate(RUNNER_SOURCE),
    "the harness must activate the ingress between the materialized-runtime check and the first turn: it is the only path that hands launch.initialFacts to the pump",
  );
  // FALSIFIER: the same gate on a source with that one line removed is red, so the guard reads the call and not the file.
  assert.equal(attachBoundaryGate(RUNNER_SOURCE.replace("runtime.connected.activateIngress();", "")), false);
  // Both ways a run reaches its first turn go through the wait, and neither can reach `runAgentTurn` with the raw prompt.
  assert.match(RUNNER_SOURCE, /const opening = turns === 1 \? await dayOpeningFor\(day\) : null;/u);
  assert.match(RUNNER_SOURCE, /const firstOpening = await dayOpeningFor\(1\);/u);
  // The prompt that reaches her is the STATED one - the day's prompt plus any world fact the day has lost since it opened
  // (`statedPrompt`) - and the raw prompt is the input to that composition, never the thing dispatched.
  assert.match(
    RUNNER_SOURCE,
    /const statedPrompt = withDayFact\(prompt, seedMarketFactPending\);\n\s+seedMarketFactPending = null;\n\s+const deliveredPrompt =\n\s+opening !== null && opening\.observed !== true\n\s+\? dayPromptWithoutObservation\(statedPrompt, opening, localeKey\)\n\s+: statedPrompt;/u,
  );
  assert.match(
    RUNNER_SOURCE,
    /const walked = await runAgentTurn\(deliveredPrompt, tools, \{ reason: wake\.reason \}\);/u,
  );
  assert.match(RUNNER_SOURCE, /const firstTurn = await runAgentTurn\(firstDeliveredPrompt, tools,/u);
  // And the reading reaches the record and the verdict, printed so a zero is visible as a zero.
  assert.match(RUNNER_SOURCE, /"DAY_STARTS",\n\s+dayStartAssessment\.reading,/u);
  assert.match(RUNNER_SOURCE, /^\s+dayStarts: dayStartAssessment,$/mu, "the reading must reach result.json");
  assert.match(RUNNER_SOURCE, /dayStartVerdict: dayStartAssessment\.verdictCode,/u);
  assert.match(RUNNER_SOURCE, /if \(dayStartVerdict !== null\) return dayStartVerdict;/u);
  assert.match(
    RUNNER_SOURCE,
    /day_prompt_delivered_without_observation:\$\{String\(day\)\}:\$\{String\(opening\.waitedMs\)\}/u,
  );
});

test("a blind day outranks her silence, and the attach's arrival is answered before it too", () => {
  const [, , deriveSessionVerdict] = extractRunnerFunction(RUNNER_SURFACE_SOURCE, [
    "taskPurposeReading",
    "taskPurposeVerdict",
    "deriveSessionVerdict",
  ]);
  const healthy = {
    worldStallReason: null,
    sessionTurns: [{}],
    unsettledTurns: [],
    turnFailureReason: undefined,
    bridgeDisconnections: [],
    sessionSpoken: true,
    accomplishedActionIds: ["harvest_crop"],
    taskPurposes: [],
    multidayAssessment: null,
  };
  assert.equal(deriveSessionVerdict({ ...healthy, dayStartVerdict: "day_started_blind:1" }), "day_started_blind:1");
  // The earlier fact wins: a day that was handed a turn before it was handed the world is blind first, note-less second.
  assert.equal(
    deriveSessionVerdict({
      ...healthy,
      dayStartVerdict: "day_started_blind:1",
      dayNoteVerdict: "day_note_not_delivered:1",
    }),
    "day_started_blind:1",
  );
  // `silent` describes a companion who was asked and did not answer; the arrival was never delivered at all.
  assert.equal(
    deriveSessionVerdict({
      ...healthy,
      sessionSpoken: false,
      companionArrivalVerdict: "companion_arrival_not_delivered",
    }),
    "companion_arrival_not_delivered",
  );
  assert.equal(
    deriveSessionVerdict({ ...healthy, dayStartVerdict: null, dayNoteVerdict: null, companionArrivalVerdict: null }),
    "completed",
  );
});

test("the attach's arrival fact is said once per session, and a run that never attached is not charged for it", () => {
  const [assessCompanionArrival] = extractRunnerFunction(RUNNER_SURFACE_SOURCE, ["assessCompanionArrival"]);
  const arrivalDelivery = "<world-facts>\n- 她到了\n</world-facts>";
  const once = assessCompanionArrival({ attached: true, texts: [OBSERVED_FIRST_DELIVERY, arrivalDelivery] });
  assert.equal(once.said, 1);
  assert.equal(once.reading, "arrival said 1 of 1");
  assert.equal(once.verdictCode, null);
  // The same call that suppressed the world-state block suppressed this: a companion never told she arrived.
  assert.equal(
    assessCompanionArrival({ attached: true, texts: [OBSERVED_FIRST_DELIVERY] }).verdictCode,
    "companion_arrival_not_delivered",
  );
  assert.equal(
    assessCompanionArrival({
      attached: true,
      texts: [arrivalDelivery, `${OBSERVED_FIRST_DELIVERY}\n${arrivalDelivery}`],
    }).verdictCode,
    "companion_arrival_said_twice",
  );
  // A run that never materialized already names its own cause; the attach it never attempted is not a second charge.
  const unattached = assessCompanionArrival({ attached: false, texts: null });
  assert.equal(unattached.measured, false);
  assert.equal(unattached.verdictCode, null);
  // A record that cannot be read is a gap, and it is still not a pass.
  assert.equal(assessCompanionArrival({ attached: true, texts: null }).verdictCode, "companion_arrival_unmeasured");
});

test("the runner reads the owner's own strings for both markers, so neither can drift in silence", () => {
  // One authority per fact: both markers are declared in `host/src/fact-brief.ts`. Neither is exported, so they are
  // compared against the owner's source instead of being restated here (a copy that agrees today is a disagreement
  // scheduled for later).
  const factBrief = readFileSync(new URL("../../../host/src/fact-brief.ts", import.meta.url), "utf8");
  const ownerMarker = /const NOTHING_OBSERVED = "([^"]+)";/u.exec(factBrief)?.[1];
  const runnerMarker = /const NOTHING_OBSERVED_WORLD = "([^"]+)";/u.exec(RUNNER_SURFACE_SOURCE)?.[1];
  assert.ok(ownerMarker === undefined || ownerMarker.length > 0);
  assert.ok(
    (ownerMarker ?? "").length > 0,
    "the owner must still declare NOTHING_OBSERVED; if it was renamed, update this reading",
  );
  assert.equal(runnerMarker, ownerMarker, "the blind marker must be the owner's wording, not a second copy of it");

  const arrivalLineOwner = /companion_arrival: "([^"]+)",/u.exec(factBrief)?.[1];
  const runnerArrivalLine = /const arrivalLine = "- ([^"]+)";/u.exec(RUNNER_SURFACE_SOURCE)?.[1];
  assert.ok(
    (arrivalLineOwner ?? "").length > 0,
    "the owner must still name `companion_arrival` in WORLD_FACT_KIND_ZH; if it was renamed, update this reading",
  );
  assert.equal(
    runnerArrivalLine,
    arrivalLineOwner,
    "the arrival marker must be the line the owner prints for that kind, not a second copy of it",
  );
});

test("a Mod log written as UTF-16 is read back as text, so the archive is not a binary file", () => {
  // Two writers, two encodings: the lane's console capture is a PowerShell redirect (UTF-16LE) and SMAPI writes UTF-8.
  // Reading both as UTF-8 is what made `mod-log.txt` unreadable in `round76`. The real reader is extracted and driven
  // against real files here, because the property is about bytes rather than about a regex in the source.
  const [readSource] = extractRunnerFunction(
    RUNNER_SURFACE_SOURCE,
    ["readModLogSource", "modLogEncoding", "decodeUtf16"],
    {
      readFileSync,
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "gamebuddy-mod-log-"));
  try {
    const console = join(dir, "lane-console.log");
    // No BOM: this is the shape a redirected capture actually has, and the NUL pattern is what identifies it.
    writeFileSync(console, "game_mode=play;saving=false\r\nDEBUG-native-local-heartbeat day=6\r\n", "utf16le");
    const bommed = join(dir, "lane-console-bom.log");
    writeFileSync(bommed, "\uFEFFDEBUG-native-local-heartbeat day=6\r\n", "utf16le");
    const smapi = join(dir, "SMAPI-latest.txt");
    writeFileSync(smapi, "SMAPI 4.5.2\nDEBUG-native-local-heartbeat day=6\n", "utf8");

    const wide = readSource(console);
    assert.equal(wide.encoding, "utf16le", "a redirected console capture is UTF-16LE, and the reader says so");
    assert.ok(!wide.text.includes("\u0000"), "no NUL survives the decode: a NUL is what made the archive binary");
    assert.ok(wide.text.includes("game_mode=play;saving=false"), `decoded text: ${JSON.stringify(wide.text)}`);
    assert.ok(wide.text.includes("DEBUG-native-local-heartbeat day=6"));
    // A BOM is part of the encoding, not part of the first line.
    assert.equal(readSource(bommed).text, "DEBUG-native-local-heartbeat day=6\r\n");
    const narrow = readSource(smapi);
    assert.equal(narrow.encoding, "utf8");
    assert.ok(narrow.text.startsWith("SMAPI 4.5.2"), "a UTF-8 source is not re-read as UTF-16");
    // The two halves concatenate into ONE text, which is what the archive writes.
    const joined = [wide, narrow].map((source) => source.text).join("\n");
    assert.ok(!joined.includes("\u0000"), "the concatenation is text, whatever each half was written in");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
