/**
 * Falsifier suite for `tools/check-plan-legal-fixpoint.mjs`, one test per assertion the gate makes.
 *
 * THE FIRST TEST IS THE ONE THE RUN PAID FOR. It replays the tree as `PRE_FIX_REVISION` had it - the commit before the
 * compiler wrote the body-yielding dismissal itself - and asserts the gate names `talk_to_npc->shop_purchase` a dead end
 * there. That is a RED ON REAL HISTORY rather than an injected one: `3d249ff1` is the commit that produced round42's four
 * refused programs, `git show` hands this suite that exact classifier, and the answer was `ok: true` with the purchase
 * silently missing from the program.
 *
 * The rest force the shapes today's compiler no longer produces (a plan-level refusal naming a workable remedy, an
 * admitted-but-short program, an empty population, a contradictory declaration), because each of those is a branch of
 * the gate that must be seen red once - a branch nobody can reach today is a branch nobody would notice was broken.
 *
 * red-proof: history  `--revision 3d249ff1894040dc2f0a960486dff1ff04992946` -> this suite's first test passes only
 *            because the gate names `talk_to_npc->shop_purchase` a dead end there, with the compiler's own
 *            `plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal`
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  answerSummaryOf,
  carriesSteps,
  checksOf,
  loadPlanCompiler,
  PRE_BATCH_FIX_REVISION,
  PRE_FIX_REVISION,
  readModalTargetedActionIds,
  readPlanCallTally,
  readPlanLegalFixpoint,
  readPublishedActions,
  remediesNamedIn,
  runStateOf,
  scriptFor,
  statusOf,
  summaryOf,
} from "./check-plan-legal-fixpoint.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GATE_PATH = "tools/check-plan-legal-fixpoint.mjs";

/** The real published vocabulary: the doubles below inject a COMPILER, never a second idea of what an action is. */
const compiler = await loadPlanCompiler();
const { actions } = readPublishedActions({ compiler });
const MODAL_TARGETED = await readModalTargetedActionIds();

/**
 * A stand-in for `compilePlanScript` that reads the steps back out of the script, so a test can answer with a shape the
 * real compiler would not produce (an `ok` answer missing a step, a plan-level refusal naming a remedy).
 */
function stepsIn(script) {
  return [...script.matchAll(/builder\.([a-z0-9_]+)\(/gu)].map((match) => match[1]);
}

/**
 * The call account a CORRECT compiler answers with for a script whose every call became a step: nothing dropped, nothing
 * folded, nothing already true. Derived from the script rather than written out, because the script is the authority on
 * how many calls were asked for - the same authority the gate itself reads.
 */
function accountOf(script) {
  const steps = stepsIn(script);
  return {
    acceptedSteps: steps.map((_, index) => `n${String(index + 1).padStart(2, "0")}`),
    acceptedStepsCount: steps.length,
    merged: [],
    mergedCount: 0,
    noStepNeeded: [],
    noStepNeededCount: 0,
    dropped: [],
    droppedCount: 0,
  };
}

/**
 * A script by SHAPE rather than by count: what the gate writes alone, the pair under judgement, and the pair with a
 * remedy inserted. The doubles below answer per shape, which is the only thing they are allowed to know.
 */
function shapeOf(script) {
  const steps = stepsIn(script);
  if (steps[1] === undefined) return "alone";
  return steps[2] === undefined ? "pair" : "remedied";
}

/**
 * THE REFUSED-CALL BATCH, as the gate writes it: two moves the gate pins, with the injected call between them.
 *
 * The tiles are `x: 5` and `x: 6`, which no pair script can contain: `valueOf` writes every integer as `0`, so every
 * script the pair reading builds carries `0` in `x` and `y`. One marker identifies the batch for the doubles below
 * without giving them a second idea of what a script is.
 */
const REFUSAL_BATCH_MARK = 'builder.move_to_tile({ "x": 5, "y": 5 });';

/**
 * A batch answered the way a compiler that costs ONE refused call answers it: two steps run, the third is named.
 *
 * This is the shape the real compiler produces and the one the gate's fourth assertion demands. The doubles below answer
 * it for the batch scripts so their failure - whichever one it is - is the failure they were written for.
 */
function partialBatchOf(script) {
  const steps = stepsIn(script);
  const reason = `plan_script_argument_not_canonical:${steps[1]}.injected:integer[whole]:snapshot.tile.x:got:string(plan_fixpoint_not_an_integer)`;
  return {
    status: "partial",
    scriptSource: script,
    snapshotRevision: 1,
    reasonCode: reason,
    rejected: [{ call: 2, actionId: steps[1], reasonCode: reason }],
    rejectedCount: 1,
    program: { nodes: [steps[0], steps[2]].map((actionId) => ({ actionId })) },
    inserted: [],
    insertedCount: 0,
    insertedNodeIds: [],
    layoutFactsAbsent: [],
    layoutFactsAbsentCount: 0,
    acceptedSteps: ["n01", "n03"],
    acceptedStepsCount: 2,
    merged: [],
    mergedCount: 0,
    noStepNeeded: [],
    noStepNeededCount: 0,
    dropped: [`n02:${reason}`],
    droppedCount: 1,
  };
}

function programOf(script) {
  if (script.includes(REFUSAL_BATCH_MARK)) return partialBatchOf(script);
  return {
    ok: true,
    reasonCode: undefined,
    rejected: [],
    rejectedCount: 0,
    ...accountOf(script),
    program: { nodes: stepsIn(script).map((actionId, index) => ({ nodeId: `n${index + 1}`, actionId })) },
  };
}

const BODY_YIELD_REFUSAL = (steps) =>
  `plan_script_action_after_body_yield:${steps[1]}:${steps[0]}:dismiss_first=dismiss_modal`;

function reading(overrides = {}) {
  return readPlanLegalFixpoint({
    compile: programOf,
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalClearingActionIds: ["dismiss_modal"],
    modalTargetedActionIds: MODAL_TARGETED,
    ...overrides,
  });
}

test("the gate names the round42 pair a dead end on the revision that produced it", (t) => {
  const run = spawnGate(["--revision", PRE_FIX_REVISION]);
  const output = `${run.stdout}${run.stderr}`;
  if (/plan_fixpoint_history_skipped:/u.test(output))
    return t.skip(`revision ${PRE_FIX_REVISION} is not in this checkout, so the historical red cannot be measured`);
  assert.equal(run.status, 1, `the pre-fix tree has to fail this gate:\n${output}`);
  const pinned = output.split("\n").find((line) => line.startsWith("plan_dead_end:talk_to_npc->shop_purchase:"));
  assert.ok(pinned, `the pair four round42 programs died on was not named:\n${output.slice(0, 4000)}`);
  // The code is the compiler's own, unchanged: the dropped call, and the step it told the author to write instead.
  assert.match(pinned, /plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal$/u);
  // AND THE ANSWER THAT PAIR CAME BACK IN IS NAMED FORGED, on the same run: `ok: true` while one of the author's two
  // steps was thrown away. This is the assertion the unit exists for, and it fires on the commit that shipped the shape.
  const forged = output.split("\n").find((line) => line.startsWith("forged_success:pair:talk_to_npc->shop_purchase:"));
  assert.ok(forged, `the forged success was not named:\n${output.slice(0, 4000)}`);
  assert.match(
    forged,
    /:n02:plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal$/u,
  );
  // The call-accounting assertion cannot be measured on a compiler that keeps no account, and says so instead of passing.
  assert.match(
    output,
    /plan_legal_fixpoint answers examined \d+ · compiled \d+ · partial \d+ · refused \d+ · forged [1-9]\d* · accounted 0$/mu,
  );
  assert.match(output, /plan_legal_fixpoint status failed$/mu, "the verdict line has to say why it failed");
});

test("a pair whose program carries both steps is accepted, and nothing is reported", () => {
  const judged = reading({ bodyYieldingActionIds: ["talk_to_npc"] });
  assert.deepEqual(judged.pairs.deadEnds, []);
  // Every published action pairs with the yielding one, so the count is the population rather than a literal.
  assert.equal(judged.pairs.examined, actions.length);
  assert.equal(judged.pairs.accepted, actions.length);
  assert.equal(judged.pairs.repaired, 0);
  assert.equal(statusOf(judged), "passed");
});

test("an accepted answer that dropped the step is a dead end, not an acceptance", () => {
  // The shape the pre-fix compiler actually returned: `ok: true`, one node, the second call rejected and carried only
  // as a `dropped` diagnostic. Reading `ok` alone would call this pair legal.
  const droppedStep = (script) => {
    const steps = stepsIn(script);
    // The pair is what loses its second step; the program this gate writes alone, or the one a remedy produces, is
    // answered as written.
    if (shapeOf(script) !== "pair") return programOf(script);
    const kept = steps.slice(0, 1);
    return {
      ok: true,
      reasonCode: undefined,
      rejected: [{ reasonCode: BODY_YIELD_REFUSAL(steps) }],
      rejectedCount: 1,
      program: { nodes: kept.map((actionId, index) => ({ nodeId: `n${index + 1}`, actionId })) },
    };
  };
  const judged = readPlanLegalFixpoint({
    compile: droppedStep,
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalClearingActionIds: ["dismiss_modal"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.notEqual(judged.pairs.accepted, judged.pairs.examined, "an ok answer that lost a step is not an acceptance");
  assert.equal(
    judged.pairs.deadEnds.length,
    actions.length,
    "every pair lost its second step, the yielding action's own included",
  );
  const shopPurchase = judged.pairs.deadEnds.find((deadEnd) => deadEnd.pair === "talk_to_npc->shop_purchase");
  assert.ok(shopPurchase, `the round42 pair has to be among the dead ends: ${summaryOf(judged)}`);
  assert.equal(shopPurchase.kind, "accepted_without_step");
  assert.match(shopPurchase.code, /dismiss_first=dismiss_modal$/u);
  assert.deepEqual(shopPurchase.handWritten, ["dismiss_modal"], "the step that would have made it legal is named");
  // AND IT IS NAMED FORGED: the same answer, read as the broken promise it is rather than as a dead end in a table.
  assert.ok(
    judged.answers.forged.some((line) => line.startsWith("forged_success:pair:talk_to_npc->shop_purchase:")),
    `the forged success was not named: ${JSON.stringify(judged.answers.forged.slice(0, 3))}`,
  );
  assert.equal(statusOf(judged), "failed");
});

/**
 * THE FORGED-SUCCESS ASSERTION, seen red on a double that can only fail it one way.
 *
 * The answer is internally consistent everywhere except in the one fact that matters: its account says both calls were
 * accepted, and its own `rejected` list says the second one was refused. The accounting is clean, so the run below is
 * red for the FORGED reason alone - a falsifier that isolates the assertion instead of firing three at once.
 */
test("an ok answer whose own refusals name a call is a forged success, and the call is named", () => {
  const forged = (script) => {
    const steps = stepsIn(script);
    if (shapeOf(script) !== "pair") return programOf(script);
    return {
      ...programOf(script),
      rejected: [{ call: 2, actionId: steps[1], reasonCode: BODY_YIELD_REFUSAL(steps) }],
      rejectedCount: 1,
    };
  };
  const judged = readPlanLegalFixpoint({
    compile: forged,
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalClearingActionIds: ["dismiss_modal"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.deepEqual(
    judged.answers.faults,
    [],
    "the account adds up: this finding is the forged success, not a bookkeeping slip",
  );
  const named = judged.answers.forged.find((line) =>
    line.startsWith("forged_success:pair:talk_to_npc->shop_purchase:"),
  );
  assert.ok(named, `the forged success was not named: ${JSON.stringify(judged.answers.forged.slice(0, 3))}`);
  assert.match(
    named,
    /:n02:plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal$/u,
  );
  assert.equal(statusOf(judged), "failed");
  const check = checksOf(judged).find((entry) => entry.id === "no_forged_success");
  assert.equal(check?.status, "failed");
  assert.ok(check.examined > 0, "and it says what it examined");
});

/**
 * THE ACCOUNTING ASSERTION, seen red in each of the four ways a call can go missing from it.
 *
 * One double per defect, each otherwise a correct compiler, so a failure names the one thing that broke instead of a
 * sentence nothing can act on. The population here is the account's own answers, which is the set the rule is about.
 */
test("a call the account loses, doubles or cuts off is a fault with its own name", () => {
  const accounting = (reshape) => {
    const compile = (script) => {
      const answer = programOf(script);
      return { ...answer, ...reshape(answer) };
    };
    return readPlanLegalFixpoint({
      compile,
      actions,
      bodyYieldingActionIds: ["talk_to_npc"],
      modalTargetedActionIds: MODAL_TARGETED,
    });
  };
  const gap = accounting((answer) => ({ acceptedSteps: answer.acceptedSteps.slice(0, 1), acceptedStepsCount: 1 }));
  assert.ok(
    gap.answers.faults.some((line) => line.startsWith("plan_account_gap:pair:talk_to_npc->")),
    `a call that vanished must be named: ${JSON.stringify(gap.answers.faults.slice(0, 3))}`,
  );
  assert.equal(statusOf(gap), "failed");

  const doubled = accounting((answer) => ({
    dropped: ["n01:plan_script_unknown_action:x"],
    droppedCount: 1,
    acceptedStepsCount: answer.acceptedStepsCount + 1,
  }));
  assert.ok(
    doubled.answers.faults.some((line) => line.startsWith("plan_account_double:pair:talk_to_npc->")),
    `a call in two lists must be named: ${JSON.stringify(doubled.answers.faults.slice(0, 3))}`,
  );

  const truncated = accounting((answer) => ({ merged: ["n01:into=n01:same_source"], mergedCount: 5 }));
  assert.ok(
    truncated.answers.faults.some((line) => line.startsWith("plan_account_truncated:pair:talk_to_npc->")),
    `a window that does not equal its count must be named: ${JSON.stringify(truncated.answers.faults.slice(0, 3))}`,
  );

  const unplaceable = accounting(() => ({
    acceptedSteps: ["n09"],
    acceptedStepsCount: 1,
  }));
  assert.ok(
    unplaceable.answers.faults.some((line) => line.startsWith("plan_account_unplaceable:")),
    `a step numbered past the calls written must be named: ${JSON.stringify(unplaceable.answers.faults.slice(0, 3))}`,
  );
});

/**
 * A COMPILER THAT KEEPS NO ACCOUNT BLOCKS THE ASSERTION INSTEAD OF PASSING IT.
 *
 * This is the shape `--revision` produces on a commit from before the account existed: the forged-success assertion still
 * runs (it reads what the answer says about refusals), and the accounting one reports `blocked` with its population at
 * zero rather than a green tick over nothing.
 */
test("a compiler that answers no account blocks the call-accounting check, never passes it", () => {
  /**
   * THE ACCOUNT IS THE ONE FIELD THIS DOUBLE LACKS, and nothing else: the batch is answered as the partial plan it really
   * is (the fourth assertion reads that, and a compiler that voided the batch there would be a second defect reported over
   * the one this test is about), while `acceptedSteps` - the field the accounting assert measures - is absent.
   */
  const judged = readPlanLegalFixpoint({
    compile: (script) => {
      if (script.includes(REFUSAL_BATCH_MARK))
        return { ...partialBatchOf(script), acceptedSteps: undefined, acceptedStepsCount: undefined };
      return {
        ok: true,
        reasonCode: undefined,
        rejected: [],
        rejectedCount: 0,
        program: { nodes: stepsIn(script).map((actionId, index) => ({ nodeId: `n${index + 1}`, actionId })) },
      };
    },
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.equal(judged.answers.measured, 0);
  assert.equal(judged.answers.forged.length, 0, "an answer that says nothing about a drop is not a forged success");
  assert.deepEqual(
    checksOf(judged).map((entry) => [entry.id, entry.status]),
    [
      ["pair_fixpoint", "passed"],
      ["modal_target_declaration", "passed"],
      ["no_forged_success", "passed"],
      ["call_accounting", "blocked"],
      ["refused_call_cost", "passed"],
    ],
  );
  assert.equal(statusOf(judged), "blocked", "nothing failed, and one rule was not measured");
  assert.match(answerSummaryOf(judged), /forged 0 · accounted 0$/u);
});

/** The reading itself: the tally is a function of the answers, and it names the shape and the call it caught. */
test("the tally reads a forged answer's shape and call, and an honest one names nothing", () => {
  const honest = readPlanCallTally([
    {
      shape: "alone:till_soil",
      script: "builder.till_soil({ x: 0, y: 0 });",
      compiled: programOf("builder.till_soil({ x: 0, y: 0 });"),
    },
  ]);
  assert.deepEqual(honest, {
    examined: 1,
    compiled: 1,
    partial: 0,
    refused: 0,
    measured: 1,
    forged: [],
    faults: [],
  });
  const forged = readPlanCallTally([
    {
      shape: "pair:talk_to_npc->shop_purchase",
      script: "builder.talk_to_npc({});\nbuilder.shop_purchase({});",
      compiled: {
        ok: true,
        dropped: ["n02:plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal"],
        droppedCount: 1,
        acceptedSteps: ["n01"],
        acceptedStepsCount: 1,
        merged: [],
        mergedCount: 0,
        noStepNeeded: [],
        noStepNeededCount: 0,
      },
    },
  ]);
  assert.deepEqual(forged.forged, [
    "forged_success:pair:talk_to_npc->shop_purchase:n02:plan_script_action_after_body_yield:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal",
  ]);
  assert.deepEqual(forged.faults, []);
});

/**
 * THE FOURTH ASSERTION'S OWN RED PROOF, on real history and on the tree under review.
 *
 * `6d6fde60` is the commit before this lane: its compiler is the one that answered one refused call by voiding the batch,
 * and the gate has to name every site where that happened - so the proof is not "the gate can be turned red by an
 * injected double", it is "the gate is red on the compiler that shipped the defect". The working tree must be green on
 * the same reading, with a population that is not zero: 295 sites today, every one of them costing exactly its own call.
 *
 * red-proof: history  `--revision 6d6fde60` -> `refused_call_cost sites examined N · per-call 0 · whole-batch N` and one
 *            `a_refused_call_voids_the_batch:<site>` per site, naming the refusal code that took the batch with it
 */
test("one refused call costs only itself, measured on every per-call refusal site the surface can produce", (t) => {
  const current = spawnGate([]);
  const output = `${current.stdout}${current.stderr}`;
  assert.equal(current.status, 0, `the tree under review has to pass this gate:\n${output.slice(0, 4000)}`);
  const reading = output.split("\n").find((line) => line.startsWith("plan_legal_fixpoint refused_call_cost "));
  assert.ok(reading, `the refusing-cost population was not printed:\n${output.slice(0, 4000)}`);
  const counted = /sites examined (\d+) · per-call (\d+) · whole-batch (\d+)$/u.exec(reading);
  assert.ok(counted, `the population line has to name all three counts: ${reading}`);
  assert.ok(Number(counted[1]) > 0, "a population of zero is blocked, never green");
  assert.equal(Number(counted[2]), Number(counted[1]), `every measured site must cost one call: ${reading}`);
  assert.equal(Number(counted[3]), 0, `no site may cost the batch: ${reading}`);

  // AND THE SAME READING ON THE COMPILER THAT SHIPPED THE DEFECT: every site voids its batch, and each one is named.
  const history = spawnGate(["--revision", PRE_BATCH_FIX_REVISION]);
  const historical = `${history.stdout}${history.stderr}`;
  if (/plan_fixpoint_history_skipped:/u.test(historical))
    return t.skip(
      `revision ${PRE_BATCH_FIX_REVISION} is not in this checkout, so the historical red cannot be measured`,
    );
  const historicalReading = historical
    .split("\n")
    .find((line) => line.startsWith("plan_legal_fixpoint refused_call_cost "));
  assert.ok(historicalReading, `the historical population was not printed:\n${historical.slice(0, 4000)}`);
  const before = /sites examined (\d+) · per-call (\d+) · whole-batch (\d+)$/u.exec(historicalReading);
  assert.ok(before, `the historical population line has to name all three counts: ${historicalReading}`);
  assert.equal(
    Number(before[2]),
    0,
    `on ${PRE_BATCH_FIX_REVISION} no site may yet cost only its own call: ${historicalReading}`,
  );
  assert.equal(Number(before[3]), Number(before[1]), `every site voided the batch there: ${historicalReading}`);
  const named = historical.split("\n").find((line) => line.startsWith("a_refused_call_voids_the_batch:"));
  assert.ok(named, `the site that cost the batch was not named:\n${historical.slice(0, 4000)}`);
  assert.match(named, /^a_refused_call_voids_the_batch:[a-z0-9_]+\.[a-z0-9_]+:the batch answered refused/u);
});

/** A double that voids the batch, so the fourth assertion is seen red on a compiler this suite controls. */
test("an answer that voids the batch is named by site, not reported as a clean run", () => {
  const judged = readPlanLegalFixpoint({
    compile: (script) =>
      script.includes(REFUSAL_BATCH_MARK)
        ? { ok: false, reasonCode: "plan_script_argument_not_canonical:injected", rejected: [] }
        : programOf(script),
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.deepEqual(judged.pairs.deadEnds, [], "the pair reading is untouched: this finding is the new one alone");
  assert.ok(judged.refusedCallCost.wholeBatch.length > 0);
  assert.equal(judged.refusedCallCost.wholeBatch.length, judged.refusedCallCost.sites);
  assert.match(judged.refusedCallCost.wholeBatch[0], /^a_refused_call_voids_the_batch:[a-z0-9_]+\.[a-z0-9_]+:/u);
  assert.equal(
    checksOf(judged).find((entry) => entry.id === "refused_call_cost")?.status,
    "failed",
    "the rule has to be its own entry in the report, with its own verdict",
  );
  assert.equal(statusOf(judged), "failed");
});

/**
 * A PARTIAL PLAN REPORTED AS A SUCCESS, in each of the three ways the answer can tell that lie.
 *
 * These are the shapes the old contract could not produce and the new one must never produce: `partial` beside a success
 * marker, `partial` naming no refused call, and `partial` with no program to run. Each is a different silence, so each gets
 * its own name.
 */
test("a partial answer reported as a success, or naming nothing, is a finding with its own name", () => {
  const batch = partialBatchOf(`${REFUSAL_BATCH_MARK}\nbuilder.injected({});\nbuilder.move_to_tile({});`);
  const tally = (answer) =>
    readPlanCallTally([
      {
        shape: "batch:sample",
        script: `${REFUSAL_BATCH_MARK}\nbuilder.injected({});\nbuilder.move_to_tile({});`,
        compiled: answer,
      },
    ]);

  const asSuccess = tally({ ...batch, ok: true });
  assert.deepEqual(
    asSuccess.forged,
    ["forged_success:batch:sample:reported_ok_while_partial"],
    "an answer that says it refused a call may not also say it succeeded",
  );

  const unnamed = tally({ ...batch, dropped: [], droppedCount: 0, rejected: [], rejectedCount: 0 });
  assert.ok(
    unnamed.faults.includes(
      "plan_partial_unannounced:batch:sample:the answer says one of its calls did not compile and names none of them",
    ),
    `a partial answer that names no refused call is the same silence in a new spelling: ${JSON.stringify(unnamed.faults)}`,
  );

  const programless = tally({ ...batch, program: { nodes: [] } });
  assert.ok(
    programless.faults.some((line) => line.startsWith("plan_partial_without_a_program:batch:sample:")),
    `a partial plan runs part of the work, so it must carry the program it runs: ${JSON.stringify(programless.faults)}`,
  );
});

/**
 * THE ONE PLACE THE TWO SPELLINGS OF AN ANSWER MEET, pinned because the historical red proofs depend on it.
 *
 * Today's compiler answers `status: "compiled" | "partial" | "refused"`; the one at a pinned revision answers `ok: true`
 * (every call became a step) or `ok: false` (a plan-level refusal that ran nothing). A reading that could only speak the
 * new field would report every historical answer as `undefined` - which is neither a pass nor a finding, it is a silence
 * in the one place this gate exists to break them.
 */
test("an answer's state is read in whichever spelling the answer carries it", () => {
  assert.equal(runStateOf({ status: "compiled", ok: true }), "compiled");
  assert.equal(
    runStateOf({ status: "partial", ok: false }),
    "partial",
    "the state wins over a field that used to mean it",
  );
  assert.equal(runStateOf({ status: "refused" }), "refused");
  assert.equal(runStateOf({ ok: true }), "compiled", "an answer from before the state existed");
  assert.equal(runStateOf({ ok: false, reasonCode: "plan_script_threw:TypeError" }), "refused");
  assert.equal(runStateOf(null), "refused", "an answer that is not there ran nothing");
});

test("a plan-level refusal whose named remedy compiles is repaired, not a dead end", () => {
  const refusesAtPlanLevel = (script) => {
    const steps = stepsIn(script);
    return shapeOf(script) === "pair"
      ? { ok: false, reasonCode: BODY_YIELD_REFUSAL(steps), rejected: [] }
      : programOf(script);
  };
  const judged = readPlanLegalFixpoint({
    compile: refusesAtPlanLevel,
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.deepEqual(judged.pairs.deadEnds, [], `nothing ran, and the named remedy works: ${summaryOf(judged)}`);
  assert.equal(judged.pairs.repaired, actions.length);
  assert.equal(statusOf(judged), "passed");
});

test("a refusal naming a remedy that does not compile is still a dead end", () => {
  const refusesWhatever = (script) => {
    const steps = stepsIn(script);
    if (shapeOf(script) === "alone") return programOf(script);
    return shapeOf(script) === "pair"
      ? { ok: false, reasonCode: BODY_YIELD_REFUSAL(steps), rejected: [] }
      : { ok: false, reasonCode: "plan_resource_conflict:resource_conflict:move_to_tile", rejected: [] };
  };
  const judged = readPlanLegalFixpoint({
    compile: refusesWhatever,
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.equal(judged.pairs.repaired, 0);
  assert.equal(judged.pairs.deadEnds.length, actions.length);
  assert.equal(judged.pairs.deadEnds[0]?.kind, "refused");
  assert.match(judged.pairs.deadEnds[0]?.change ?? "", /the refusal names no <key>=<actionId> remedy/u);
  assert.equal(statusOf(judged), "failed");
});

/**
 * The other dead-end shape measured on this class, kept as a fixture: the compiler's OWN two insertions unordered.
 *
 * `talk_to_npc -> travel` was refused `plan_resource_conflict:resource_conflict:move_to_tile` while the dismissal and the
 * walk were written as siblings; writing `[talk_to_npc, dismiss_modal, travel]` by hand compiled, so the missing step was
 * one the compiler had to write itself - which is what the dead end says when the refusal names no remedy.
 */
test("a refusal that names no remedy is a dead end even when one exists by hand", () => {
  const refusesUntilTheChainIsWritten = (script) => {
    if (shapeOf(script) !== "pair") return programOf(script);
    return { ok: false, reasonCode: "plan_resource_conflict:resource_conflict:move_to_tile", rejected: [] };
  };
  const judged = readPlanLegalFixpoint({
    compile: refusesUntilTheChainIsWritten,
    actions,
    bodyYieldingActionIds: ["talk_to_npc"],
    modalClearingActionIds: ["dismiss_modal"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  assert.equal(judged.pairs.repaired, 0, "the refusal named no <key>=<actionId> remedy, so nothing was repaired");
  const travel = judged.pairs.deadEnds.find((deadEnd) => deadEnd.pair === "talk_to_npc->travel");
  assert.ok(travel, `the transition pair has to be named: ${summaryOf(judged)}`);
  assert.equal(travel.kind, "refused");
  assert.equal(travel.code, "plan_resource_conflict:resource_conflict:move_to_tile");
  assert.deepEqual(travel.handWritten, ["dismiss_modal"], "the step that would have made it legal is named anyway");
  assert.match(travel.change, /the missing step is one the compiler must write itself/u);
  assert.equal(statusOf(judged), "failed");
});

test("a modal-target population that read nothing is blocked, not a clean contradiction check", () => {
  const judged = reading({ modalTargetedActionIds: [] });
  assert.deepEqual(
    judged.unmeasured.filter((line) => line.startsWith("plan_population_unmeasured:modal_targets")),
    [
      "plan_population_unmeasured:modal_targets:no published action declares a modal target, so the rule that a modal-" +
        "taking action may not be body-yielding was not measured",
    ],
  );
  assert.equal(statusOf(judged), "blocked");
});

test("an empty population is blocked, and says which side is empty", () => {
  const emptyY = reading({ bodyYieldingActionIds: [] });
  assert.equal(emptyY.pairs.examined, 0);
  assert.equal(statusOf(emptyY), "blocked");
  const emptyX = reading({ actions: [] });
  assert.equal(emptyX.pairs.examined, 0);
  assert.equal(statusOf(emptyX), "blocked");
});

test("a yielding action the surface does not publish is blocked, not silently dropped from the pairs", () => {
  const judged = reading({ bodyYieldingActionIds: ["talk_to_npc", "no_such_published_action"] });
  assert.deepEqual(
    judged.unmeasured.filter((line) => line.startsWith("plan_population_unpublished:no_such_published_action")),
    [
      "plan_population_unpublished:no_such_published_action:the yielding declaration names an action the surface does not publish",
    ],
  );
  assert.equal(statusOf(judged), "blocked", "one side of the population went missing, so the pairs were not measured");
});

test("an action this gate cannot write alone is blocked, not a pair result", () => {
  const judged = reading({
    actions: [{ actionId: "unwritable", arguments: [{ name: "loop", type: "object" }] }],
    bodyYieldingActionIds: [],
  });
  assert.equal(judged.pairs.examined, 0);
  assert.deepEqual(
    judged.unmeasured.filter((line) => line.startsWith("plan_population_unwritable")),
    ["plan_population_unwritable:unwritable:argument_object_unwritable"],
  );
  assert.equal(statusOf(judged), "blocked");
});

test("an action whose own precondition is a modal may not be declared body-yielding", () => {
  assert.ok(
    MODAL_TARGETED.includes("dismiss_modal"),
    "the adapter table names the clearing action as acting on a modal",
  );
  const judged = reading({
    bodyYieldingActionIds: ["talk_to_npc", "dismiss_modal"],
    modalTargetedActionIds: MODAL_TARGETED,
  });
  const contradiction = judged.contradictions.find((line) => line.startsWith("plan_rule_contradiction:dismiss_modal:"));
  assert.ok(contradiction, `the contradiction was not named: ${JSON.stringify(judged.contradictions)}`);
  assert.match(contradiction, /acts on a modal/u);
  assert.equal(statusOf(judged), "failed");
  // And the same declaration without the modal-taking member is not a contradiction: the finding is about the member.
  assert.deepEqual(
    judged.contradictions.filter((line) => line.includes("talk_to_npc")),
    [],
  );
});

test("the reading itself: a step is carried only as many times as the script asked for it", () => {
  const one = { ok: true, program: { nodes: [{ actionId: "talk_to_npc" }] } };
  assert.equal(carriesSteps(one, ["talk_to_npc"]), true);
  assert.equal(carriesSteps(one, ["talk_to_npc", "talk_to_npc"]), false, "asking twice is not satisfied by one node");
  assert.equal(carriesSteps(one, ["talk_to_npc", "shop_purchase"]), false);
  // The nodes the compiler adds are not counted against the script: `[talk, dismiss, shop]` carries its two steps.
  const three = { ok: true, program: { nodes: [{ actionId: "talk_to_npc" }, { actionId: "dismiss_modal" }] } };
  assert.equal(carriesSteps(three, ["talk_to_npc"]), true);
  assert.deepEqual(remediesNamedIn("plan_script_x:shop_purchase:talk_to_npc:dismiss_first=dismiss_modal"), [
    "dismiss_modal",
  ]);
  assert.deepEqual(remediesNamedIn("plan_resource_conflict:resource_conflict:move_to_tile"), []);
  // A script for an action id the vocabulary does not carry is a fact about the population, not a compile.
  assert.deepEqual(scriptFor(actions, ["no_such_action"]), {
    ok: false,
    actionId: "no_such_action",
    reason: "not_published",
  });
});

function spawnGate(arguments_) {
  try {
    const stdout = execFileSync(process.execPath, [GATE_PATH, ...arguments_], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: typeof error.stdout === "string" ? error.stdout : "",
      stderr: typeof error.stderr === "string" ? error.stderr : String(error.message),
    };
  }
}
