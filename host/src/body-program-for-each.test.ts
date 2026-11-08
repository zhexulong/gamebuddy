import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  forEachRules,
  MAX_FOR_EACH_ROWS,
  type PlanForEachLoop,
  type PlanForEachRule,
  planFormExecutionUnavailableReason,
} from "./body-program-for-each.js";
import {
  type CompiledPlan,
  compilePlanScript,
  FOR_EACH_PLAN_ACTION_ID,
  PLAN_FORM_ACTION_IDS,
  planActionsFromRegistrations,
  planWorkDescription,
} from "./body-program-script.js";
import { type ActionRegistration, type Snapshot } from "./protocol.js";

/**
 * The `for_each` form's own guards, beside the ten cases the form was specified with.
 *
 * The specification says what the form must carry. This file protects the three properties that decide whether the form
 * is HONEST, each of which a green form test would not notice:
 *
 *   1. The row bound here and the bound in the Mod's rules are ONE number, read from the Mod rather than restated.
 *   2. Several loops over one source are one PASS with ordered rules, not several passes - which is the difference
 *      between "one winner per tile" and a tile worked twice with the other rules reported as forgotten.
 *   3. A form the attached Mod cannot execute is answered BY CODE and never submitted, with the code the companion was
 *      told about in the description it already holds.
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(hostRoot, "..");
const SURFACE_PATH = resolve(
  repositoryRoot,
  "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);
const MOD_RULES_PATH = resolve(repositoryRoot, "integrations/stardew/src/Core/Policy/FarmhandForEachRules.cs");
const MATERIALIZER_PATH = resolve(
  hostRoot,
  "src/continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.ts",
);

type SurfaceAction = Readonly<{
  actionId: string;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
}>;

const SURFACE = (JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { actions: readonly SurfaceAction[] }).actions;

const REGISTRATIONS: readonly ActionRegistration[] = SURFACE.map((action) =>
  Object.freeze({
    actionId: action.actionId,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    ...(action.argumentSchema === undefined
      ? {}
      : { descriptor: { argumentSchema: action.argumentSchema, outputFacts: action.outputFacts ?? {} } }),
  }),
);

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

const SNAPSHOT = {
  revision: 11,
  location: "Farm",
  tile: { x: 10, y: 10 },
  stamina: 100,
  health: 100,
  actionable: true,
  exhausted: false,
  capabilities: [],
  catalogRevision: 1,
  enabledActionIds: [],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
} as Snapshot;

function compile(script: string): CompiledPlan {
  return compilePlanScript({ script }, { snapshot: SNAPSHOT, actions: ACTIONS });
}

type PlanNode = Record<string, unknown> & { arguments: Record<string, unknown> };

function nodesOf(result: CompiledPlan): readonly PlanNode[] {
  if (!result.ok) assert.fail(`expected a plan, received ${result.reasonCode}`);
  return [...result.program.nodes] as unknown as readonly PlanNode[];
}

function loopOf(node: PlanNode): PlanForEachLoop & Readonly<{ type: string }> {
  const loop = node.arguments.loop as (PlanForEachLoop & Readonly<{ type: string }>) | undefined;
  assert.ok(loop !== undefined, `the node must carry the loop under 'loop', received ${JSON.stringify(node)}`);
  return loop;
}

/** The patch every case here uses: three rows by twenty columns, wider than any 13x13 observation. */
const PATCH = "{ x: 60, y: 18, w: 20, h: 3 }";

/**
 * PROPERTY 1. The row bound is one fact with two ends, so it is read from the Mod instead of restated here.
 *
 * A bound that drifted would be the worst kind of quiet: the Host would accept a rectangle the Mod then refuses, or
 * refuse one the Mod would have covered, and neither answer would name the number that disagreed.
 */
test("the row bound the compiler enforces is the bound the Mod's own rules declare", () => {
  const declared = /MaximumRows\s*=\s*(\d+)/u.exec(readFileSync(MOD_RULES_PATH, "utf8"));
  assert.ok(declared !== null, "the Mod's rules must still declare MaximumRows; this gate reads it from there");
  assert.equal(MAX_FOR_EACH_ROWS, Number(declared[1]), "the Host and the Mod must bound a loop at the same row count");

  const atBound = compile(
    `builder.for_each({ source: { area: { x: 0, y: 0, w: ${String(MAX_FOR_EACH_ROWS)}, h: 1 } }, do: { action: "cut_weeds" } });`,
  );
  assert.equal(atBound.ok, true, "a rectangle of exactly the bound is one intent");

  const overBound = compile(
    `builder.for_each({ source: { area: { x: 0, y: 0, w: ${String(MAX_FOR_EACH_ROWS + 1)}, h: 1 } }, do: { action: "cut_weeds" } });`,
  );
  assert.equal(overBound.ok, false);
  assert.equal(
    overBound.ok ? "" : overBound.reasonCode,
    `plan_script_loop_too_large:${String(MAX_FOR_EACH_ROWS + 1)}:${String(MAX_FOR_EACH_ROWS)}`,
    "the refusal carries the count AND the bound, so the caller can split the rectangle instead of guessing",
  );
});

/**
 * PROPERTY 2. Three loops over one rectangle are ONE pass with three ordered rules.
 *
 * This is the intercropped patch: hops on columns 0, 3, 6..., coffee on 1, 4, 7..., and a path on 2, 5, 8.... Three
 * separate passes would each report the columns the others own as `no_rule_matched`, and a tile two rules claim would be
 * worked twice. One pass decides each row once, by the first rule that claims it - which is the same statement the Mod's
 * own Core suite makes per tile.
 */
test("loops over one source compose into one pass whose rules keep the order the caller wrote them in", () => {
  const nodes = nodesOf(
    compile(
      `builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 0 } }], do: { action: "plant_seed", seed: "hops" } });
       builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 1 } }], do: { action: "plant_seed", seed: "coffee" } });
       builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 2 } }], do: null });`,
    ),
  );
  assert.equal(nodes.length, 1, "one patch is one intent: the three calls are three rules of it");
  const loop = loopOf(nodes[0]!);
  const rules = forEachRules(loop);
  assert.equal(rules.length, 3);
  assert.deepEqual(
    rules.map((rule) => rule.do),
    [{ action: "plant_seed", seed: "hops" }, { action: "plant_seed", seed: "coffee" }, null],
    "first match wins, so the order the caller wrote is the order the pass decides in",
  );
  assert.deepEqual(
    rules.map((rule) => rule.where),
    [[{ col: { every: 3, offset: 0 } }], [{ col: { every: 3, offset: 1 } }], [{ col: { every: 3, offset: 2 } }]],
  );
});

/** The inverse: a different source is a DIFFERENT intent, so it is its own node with its own single rule. */
test("loops over different sources stay separate passes, so the inverse of composing does not merge", () => {
  const nodes = nodesOf(
    compile(
      `builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 0 } }], do: { action: "plant_seed", seed: "hops" } });
       builder.for_each({ source: { area: { x: 60, y: 21, w: 20, h: 3 } }, where: [{ col: { every: 3, offset: 0 } }], do: { action: "plant_seed", seed: "hops" } });`,
    ),
  );
  assert.equal(nodes.length, 2);
  for (const node of nodes) assert.equal(forEachRules(loopOf(node)).length, 1);
});

/** A loop that has to be refused costs its own call, and the steps the caller wrote around it still compile. */
test("a refused loop is one dropped call and not the whole batch", () => {
  const result = compile(
    `builder.till_soil({ x: 60, y: 18 });
     builder.for_each({ source: { area: { x: 0, y: 0, w: 20, h: 20 } }, do: { action: "cut_weeds" } });
     builder.till_soil({ x: 61, y: 18 });`,
  );
  assert.equal(result.ok, true);
  assert.deepEqual(
    nodesOf(result).map((node) => node.actionId),
    ["till_soil", "till_soil"],
  );
  if (!result.ok) return;
  assert.equal(result.rejectedCount, 1);
  assert.deepEqual(
    result.rejected.map((entry) => entry.reasonCode),
    ["plan_script_loop_too_large:400:64"],
  );
});

/** `by_kind` is a reference to the Mod's own classifier, so it is accepted while naming no action of its own. */
test("by_kind is accepted as a dispatch while an unpublished action id is not", () => {
  const byKind = compile(
    `builder.for_each({ source: { family: "debrisTargets" }, where: [{ field: "kind", in: ["weed", "stone"] }], do: { action: "by_kind" } });`,
  );
  assert.equal(byKind.ok, true);
  const unknown = compile(`builder.for_each({ source: { family: "debrisTargets" }, do: { action: "obliterate" } });`);
  assert.equal(unknown.ok ? "" : unknown.reasonCode, "plan_script_unknown_action:obliterate");
});

/**
 * PROPERTY 3. The loop is a form the Host can compile and the attached Mod cannot execute, and the answer says so.
 *
 * Three separate facts have to hold, and each one alone would let a silent success through:
 *   - the code is derived from the form's own id (`for_each` -> `for_each_execution_unavailable`), so a second form needs
 *     no edit and the two cannot drift;
 *   - the description the companion ALREADY holds names that code, because a caller refused with a word it was never told
 *     spends a turn discovering it;
 *   - the plan path answers it BEFORE submitting, because a program the Mod cannot run is refused whole by the preflight
 *     and takes the executable steps beside the loop with it.
 */
test("a form the Mod cannot execute is named by code in the description and refused before submission", () => {
  assert.deepEqual(PLAN_FORM_ACTION_IDS, [FOR_EACH_PLAN_ACTION_ID]);
  const code = planFormExecutionUnavailableReason(FOR_EACH_PLAN_ACTION_ID);
  assert.equal(code, "for_each_execution_unavailable");
  assert.equal(
    code,
    `${FOR_EACH_PLAN_ACTION_ID}_execution_unavailable`,
    "the code is derived from the id, never a second name for the same form",
  );
  assert.ok(
    planWorkDescription(ACTIONS).includes(code),
    `the description must name ${code}: a refusal the caller was never told about costs a turn to discover`,
  );

  const source = readFileSync(MATERIALIZER_PATH, "utf8");
  const answered = source.indexOf("planFormNodesOutsideCatalogue(nodes, actions)");
  const submitted = source.indexOf("await submitProgram({ programId, nodes })");
  assert.ok(answered > 0, "the plan path must ask which nodes the attached Mod publishes");
  assert.ok(submitted > 0, "the plan path must still submit an executable program");
  assert.ok(
    answered < submitted,
    "the answer must come BEFORE the submission: a program carrying an unexecutable node is refused whole by the preflight, which loses the executable steps beside it",
  );
});

/** The composed pass reads its rules through ONE function, so a writer and a reader cannot enumerate them differently. */
test("the rules of a pass are enumerated in the order they are decided, whatever the loop says", () => {
  const loop: PlanForEachLoop = { source: { family: "cropTargets" }, do: null };
  const second: PlanForEachRule = { where: [{ field: "readyForHarvest", eq: true }], do: { action: "harvest_crop" } };
  const composed: PlanForEachLoop = { ...loop, then: [second] };
  assert.deepEqual(forEachRules(loop), [{ do: null }], "an absent predicate list means every row, not no rows");
  assert.deepEqual(forEachRules(composed), [{ do: null }, second]);
});
