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
  carriesSteps,
  loadPlanCompiler,
  PRE_FIX_REVISION,
  readModalTargetedActionIds,
  readPlanLegalFixpoint,
  readPublishedActions,
  remediesNamedIn,
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
 * A script by SHAPE rather than by count: what the gate writes alone, the pair under judgement, and the pair with a
 * remedy inserted. The doubles below answer per shape, which is the only thing they are allowed to know.
 */
function shapeOf(script) {
  const steps = stepsIn(script);
  if (steps[1] === undefined) return "alone";
  return steps[2] === undefined ? "pair" : "remedied";
}

function programOf(script) {
  return {
    ok: true,
    reasonCode: undefined,
    rejected: [],
    rejectedCount: 0,
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
  assert.match(output, /^(?:.*\n)*plan_legal_fixpoint status failed$/mu, "the verdict line has to say why it failed");
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
  assert.equal(statusOf(judged), "failed");
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
