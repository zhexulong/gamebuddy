import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  forEachRules,
  MAX_FOR_EACH_LOOP_DOCUMENT_CHARS,
  MAX_FOR_EACH_ROWS,
  MAX_FOR_EACH_RULES,
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
/** The Mod's loop reader, where the document's wire bound is declared on that side. */
const MOD_ARGUMENTS_PATH = resolve(repositoryRoot, "integrations/stardew/src/Core/Policy/FarmhandForEachArguments.cs");
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
 * PROPERTY 3, RE-ANCHORED. The form is hosted, so `for_each_execution_unavailable` no longer reaches the model - and the
 * two facts that made it honest are still asserted.
 *
 * WHAT CHANGED. The Mod now PUBLISHES the form (`FarmhandPlanFormCatalog`, appended to the hello's registrations), so
 * `planFormNodesOutsideCatalogue` derives an empty answer for `for_each` and the plan is submitted. The refusal code is
 * still derived from the form's own id, and the gate that answers it is still positioned BEFORE the submit, because both
 * remain the only honest answer for a form an older or different Mod does not publish. What must NOT survive is the
 * description promising the caller an unexecutable loop: a description that teaches a refusal nobody will meet is the
 * same defect in reverse.
 */
test("a form the Mod now hosts is described by what it does, and an unpublished form is still refused before submission", () => {
  assert.deepEqual(PLAN_FORM_ACTION_IDS, [FOR_EACH_PLAN_ACTION_ID]);
  const code = planFormExecutionUnavailableReason(FOR_EACH_PLAN_ACTION_ID);
  assert.equal(code, "for_each_execution_unavailable");
  assert.equal(
    code,
    `${FOR_EACH_PLAN_ACTION_ID}_execution_unavailable`,
    "the code is derived from the id, never a second name for the same form",
  );

  const description = planWorkDescription(ACTIONS);
  assert.equal(
    description.includes(code),
    false,
    `${code} is unreachable for this form now that the Mod publishes it, so the description must not teach it`,
  );
  assert.equal(description.includes("does not execute the loop yet"), false);
  assert.ok(
    description.includes("expanded by the Mod on the game thread"),
    "the description must say what now happens: the Mod expands the loop itself",
  );
  assert.ok(
    description.includes("for_each_source_unavailable:family") &&
      description.includes("for_each_source_unavailable:query"),
    "the two sources whose row sourcing does not exist are refusals that DO reach the model, so they are named",
  );
  assert.ok(
    description.includes(String(MAX_FOR_EACH_LOOP_DOCUMENT_CHARS)),
    "the document's wire bound is printed, so a caller can size a pass without discovering the limit by refusal",
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

/**
 * The document's length bound is ONE number, said on both sides of the bridge.
 *
 * A canonical string may occupy 512 characters on the wire (the Host's `isBodyCanonicalValue`, the Mod's
 * `TryDecodeRuntimeValue`), and the compiler refuses an oversized loop with its own count so the pipe is never the thing
 * that answers. This gate reads the Mod's constant instead of restating it: two numbers that agree today are a
 * disagreement scheduled for later.
 */
test("the document bound the compiler enforces is the bound the Mod's own reader declares", () => {
  const declared = /MaximumDocumentChars\s*=\s*(\d+)/u.exec(readFileSync(MOD_ARGUMENTS_PATH, "utf8"));
  assert.ok(
    declared !== null,
    "the Mod's loop reader must still declare MaximumDocumentChars; this gate reads it from there",
  );
  assert.equal(MAX_FOR_EACH_LOOP_DOCUMENT_CHARS, Number(declared[1]));
});

/** A document the wire cannot carry is refused by the COMPILER, with its own length and the bound. */
test("a loop document past the wire bound is refused with its own length", () => {
  // Every part is legal on its own - names are opaque ids, values are under the scalar bound - and the DOCUMENT is still
  // too long for the one canonical string it becomes. This is the only test that can catch that: the value bound says
  // nothing about the sum.
  const padding = "x".repeat(120);
  const rule = `{ do: { action: "cut_weeds", note: "${padding}" } }`;
  const then = Array.from({ length: MAX_FOR_EACH_RULES - 1 }, () => rule).join(", ");
  const result = compile(
    `builder.for_each({ source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: { action: "cut_weeds" }, then: [${then}] });`,
  );
  assert.equal(result.ok, false, "the script is refused: the document cannot cross the bridge");
  const reasonCode = result.ok ? "" : result.reasonCode;
  assert.match(
    reasonCode,
    new RegExp(
      `^plan_script_for_each_loop_document_too_long:\\d+_of_${String(MAX_FOR_EACH_LOOP_DOCUMENT_CHARS)}$`,
      "u",
    ),
    "the refusal carries the document's real length AND the bound to stay under",
  );
});

/**
 * THE LINK THAT WAS MISSING. The Host refuses a whole plan before submitting when a node's action id is a form the
 * attached Mod does not publish, and that answer is derived from the Mod's own hello registrations - not from a Host list.
 * This is the registration the Mod publishes (`FarmhandPlanFormCatalog`: published, execution, one `loop` argument of type
 * `string`), so the form survives the plan vocabulary filter and the plan is submitted instead of answered.
 *
 * The Mesh case is the falsifier: an experimental form is NOT plannable, so this cannot pass by admitting everything.
 */
test("the plan vocabulary keeps the plan form the Mod publishes, so a loop is submitted rather than answered", () => {
  const form = (lifecycle: string): ActionRegistration =>
    Object.freeze({
      actionId: "for_each",
      familyId: "plan_forms",
      identityVersion: 1,
      lifecycle: lifecycle as ActionRegistration["lifecycle"],
      kind: "execution",
      descriptor: {
        argumentSchema: { loop: { type: "string" } },
        outputFacts: {},
        resourceTemplate: { claims: [{ key: "embodied_actor", value: "ScopePlayer" }] },
      },
    } as ActionRegistration);

  assert.deepEqual(
    planActionsFromRegistrations([form("published")]).map((action) => action.actionId),
    ["for_each"],
    "a published execution form with a scalar argument is plannable, which is what keeps `for_each_execution_unavailable` from reaching the model",
  );
  assert.deepEqual(
    planActionsFromRegistrations([form("experimental")]).map((action) => action.actionId),
    [],
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
