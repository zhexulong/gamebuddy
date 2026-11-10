import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  forEachRules,
  isForEachLoopDocument,
  MAX_FOR_EACH_LOOP_DOCUMENT_CHARS,
  MAX_FOR_EACH_ROWS,
  MAX_FOR_EACH_RULES,
  MAX_FOR_EACH_STEPS,
  type PlanForEachLoop,
  type PlanForEachRule,
  PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL,
  PLAN_FOR_EACH_SOURCES,
  planFormExecutionUnavailableReason,
  readForEachLoop,
} from "./body-program-for-each.js";
import {
  type CompiledPlan,
  compilePlanScript,
  FOR_EACH_PLAN_ACTION_ID,
  PLAN_FORM_ACTION_IDS,
  planActionsFromRegistrations,
  planWorkDescription,
} from "./body-program-script.js";
import { type ActionRegistration, type Snapshot, validateBodyProgramCandidateRequest } from "./protocol.js";

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
  const compiled = compile(
    `builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 0 } }], do: { action: "plant_seed", seed: "hops" } });
       builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 1 } }], do: { action: "plant_seed", seed: "coffee" } });
       builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 2 } }], do: null });`,
  );
  const nodes = nodesOf(compiled);
  assert.equal(nodes.length, 1, "one patch is one intent: the three calls are three rules of it");
  // AND THE ANSWER SAYS SO. Two of her three calls changed the program without becoming nodes of their own, which is a
  // fact she cannot read off the node list: named here, it is the difference between "the compiler folded my loops" and
  // "the compiler lost two of my steps".
  assert.deepEqual(compiled.merged, ["n02:into=n01:same_source", "n03:into=n01:same_source"]);
  assert.equal(compiled.mergedCount, 2);
  assert.deepEqual(compiled.acceptedSteps, ["n01"], "only the first call became a node");
  assert.deepEqual(compiled.dropped, [], "a fold is not a drop, and the answer distinguishes them");
  const loop = loopOf(nodes[0]!);
  const rules = forEachRules(loop);
  assert.equal(rules.length, 3);
  assert.deepEqual(
    rules.map((rule) => rule.do),
    [[{ action: "plant_seed", seed: "hops" }], [{ action: "plant_seed", seed: "coffee" }], null],
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

/**
 * PROPERTY 2, SECOND HALF. A merge carries EVERY rule of both loops, or it refuses and names what it would drop.
 *
 * Measured at `516e2559`: the merge appended exactly `forEachRules(loop)[0]` - one rule per incoming loop - so a loop
 * whose own intent was TWO ordered rules (its predicate, then an ordered follow-up under `then`) compiled `ok: true` with
 * the follow-up silently gone. She wrote it, the compiler dropped it, and the answer said the plan was accepted.
 *
 * The population is the loop model's own `PLAN_FOR_EACH_SOURCES`, and each case renders its script from the SAME document
 * the model reader is asked to read, so this cannot pass by agreeing with a second hand-written copy of the loop. A
 * source kind with no document here is a blocked reading, named, rather than a silent skip.
 */
test("merge_rule_union: a merged pass carries every rule both loops wrote, or refuses naming what it would drop", () => {
  // One source document per kind the model declares, checked against the declaration in BOTH directions below.
  const sourceDocuments: Readonly<Record<string, unknown>> = Object.freeze({
    area: { area: { x: 60, y: 18, w: 20, h: 3 } },
    family: { family: "cropTargets" },
    query: { query: { subject: "crop", only: "ready" } },
  });
  const undocumented = PLAN_FOR_EACH_SOURCES.filter((kind) => !(kind in sourceDocuments));
  assert.deepEqual(
    undocumented,
    [],
    `these loop source kinds have no document here, so the merge is unproven for them: ${undocumented.join(", ")}`,
  );
  const sources = PLAN_FOR_EACH_SOURCES.filter((kind) => kind in sourceDocuments);
  assert.ok(sources.length > 0, "blocked: the loop model declares no source kind, so this gate examined nothing");

  /** One loop over `source` with a rule of its own AND an ordered follow-up, both distinct per `offset`. */
  const loopDocument = (source: unknown, offset: number): Record<string, unknown> => ({
    source,
    where: [{ col: { every: 2, offset } }],
    do: offset === 0 ? { action: "cut_weeds" } : null,
    then: [{ where: [{ row: { every: 2, offset } }], do: { action: "cut_weeds" } }],
  });

  for (const kind of sources) {
    const first = loopDocument(sourceDocuments[kind], 0);
    const second = loopDocument(sourceDocuments[kind], 1);
    // The expected pass is the model's OWN reading of the two documents, concatenated in the order they were written.
    const expected = [first, second].flatMap((document) => {
      const reading = readForEachLoop(document, null);
      assert.ok(reading.ok, `${kind}: the loop model must read its own document (${reading.ok ? "" : reading.code})`);
      return forEachRules(reading.loop);
    });
    assert.equal(expected.length, 4, `${kind}: each loop writes two rules, so the union has four`);
    const nodes = nodesOf(
      compile(`builder.for_each(${JSON.stringify(first)});\nbuilder.for_each(${JSON.stringify(second)});`),
    );
    assert.equal(nodes.length, 1, `${kind}: two loops over one source are one pass, not two`);
    const carried = forEachRules(loopOf(nodes[0]!));
    expected.forEach((rule, index) =>
      assert.deepEqual(
        carried[index],
        rule,
        `${kind}: rule ${String(index)} did not survive the merge - ${JSON.stringify(rule)} is missing from ${JSON.stringify(carried)}`,
      ),
    );
    assert.equal(
      carried.length,
      expected.length,
      `${kind}: the pass carries ${String(carried.length)} rules of the ${String(expected.length)} the caller wrote`,
    );
  }

  // THE REFUSAL ARM. `MAX_FOR_EACH_RULES` is what one pass can carry (the Mod's own reader enforces it), so a merge whose
  // union crosses it has rules with nowhere to go. Trimming would hand the Mod a pass she did not write, so the answer
  // names how many of THIS loop's rules could be kept and how many would be dropped, and the plan is refused whole.
  const full = {
    source: sourceDocuments.area,
    do: { action: "cut_weeds" },
    then: Array.from({ length: MAX_FOR_EACH_RULES - 1 }, () => ({ do: null })),
  };
  const extra = {
    source: sourceDocuments.area,
    where: [{ col: { every: 3, offset: 0 } }],
    do: { action: "cut_weeds" },
  };
  const refused = compile(`builder.for_each(${JSON.stringify(full)});\nbuilder.for_each(${JSON.stringify(extra)});`);
  assert.equal(refused.ok, false, "a merge that cannot carry every rule must refuse the plan, not compile it short");
  assert.equal(
    refused.ok ? "" : refused.reasonCode,
    "plan_script_for_each_merge_would_drop_rules:0:1",
    "the refusal names the incoming loop's rules: none kept of one written, and the pass is already full",
  );
  assert.deepEqual(
    refused.ok ? [] : refused.dropped,
    ["n02:plan_script_for_each_merge_would_drop_rules:0:1"],
    "the call that could not be folded is named by its own position",
  );
});

/**
 * A loop that has to be refused refuses the plan it was written in - nothing runs - and the answer names both halves:
 * the call that was dropped, and the steps the caller wrote around it that compiled.
 */
test("a refused loop refuses the plan, and the answer names the loop and the steps beside it", () => {
  const result = compile(
    `builder.till_soil({ x: 60, y: 18 });
     builder.for_each({ source: { area: { x: 0, y: 0, w: 20, h: 20 } }, do: { action: "cut_weeds" } });
     builder.till_soil({ x: 61, y: 18 });`,
  );
  assert.equal(result.ok, false, "a plan that lost a step must not be reported as accepted");
  assert.deepEqual(result.ok ? [] : result.rejected.map((entry) => entry.reasonCode), [
    "plan_script_loop_too_large:400:64",
  ]);
  assert.deepEqual(result.dropped, ["n02:plan_script_loop_too_large:400:64"]);
  assert.deepEqual(result.acceptedSteps, ["n01", "n03"], "the two tiles she wrote around the loop did compile");
  assert.equal(result.droppedCount, 1);
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
 * THE NESTING WALK READS THE WHOLE DECLARATION, AND IT ENDS ON EVERY ONE.
 *
 * It used to stop after six levels, so a `for_each` buried under a key no rule declares was answered as that unknown key
 * and the nesting it really was went unsaid. The only declaration that walk cannot finish is one that reaches itself -
 * built in the script rather than written as a literal - so the guard has to be "every object once", not a depth.
 */
test("a nested loop is refused wherever it sits, and a declaration that reaches itself still ends", () => {
  const buried = {
    source: { area: { x: 0, y: 0, w: 1, h: 1 } },
    do: null,
    then: [
      {
        do: null,
        where: [
          {
            field: "kind",
            eq: 1,
            extra: { a: { b: { for_each: { source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: null } } } },
          },
        ],
      },
    ],
  };
  const nested = readForEachLoop(buried, null);
  assert.equal(
    nested.ok ? "" : nested.code,
    "nested_loop_unsupported",
    "the form named itself again, so that is what the answer says - not the unknown key it happens to sit under",
  );
  const reachingItself: Record<string, unknown> = { source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: null };
  reachingItself.then = [reachingItself];
  const cyclic = readForEachLoop(reachingItself, null);
  assert.equal(
    cyclic.ok ? "" : cyclic.code,
    "loop_then_invalid",
    "a declaration that reaches itself is read, not walked until the stack ends",
  );
  assert.equal(cyclic.ok ? "" : cyclic.detail, "rule[0]:unknown:source", "and the rule it broke is still named");
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
  const second: PlanForEachRule = { where: [{ field: "readyForHarvest", eq: true }], do: [{ action: "harvest_crop" }] };
  const composed: PlanForEachLoop = { ...loop, then: [second] };
  assert.deepEqual(forEachRules(loop), [{ do: null }], "an absent predicate list means every row, not no rows");
  assert.deepEqual(forEachRules(composed), [{ do: null }, second]);
});

/**
 * PROPERTY 4. THE ROW'S TARGET IDENTITY IS THE MOD'S TO MINT, and a `do` that names one is refused by name.
 *
 * A loop's rows are read live, so an id the caller wrote is a statement about a tile it has not seen: true only until
 * the world differs, which is exactly the lie `expectedTargetId` exists to catch. The Mod fills the argument per row from
 * the family the action's own descriptor declares, so a declaration of it here is a refusal and not a silent override.
 *
 * THE NAME IS ONE WORD ON BOTH SIDES. The code the Mod answers with is read out of the Mod's own constant rather than
 * restated, because a caller told one word and refused with another has been taught nothing.
 */
test("a row identity the caller wrote is refused by name, and the name is the Mod's own", () => {
  const declared = /RowIdentityIsNotTheCallers\s*=\s*"([a-z0-9_:]+)"/u.exec(readFileSync(MOD_ARGUMENTS_PATH, "utf8"));
  assert.ok(
    declared !== null,
    "the Mod's loop reader must still declare the refusal's name; this gate reads it from there",
  );
  assert.equal(
    PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL,
    declared[1],
    "the Host and the Mod must refuse the caller's own row identity with the same code",
  );

  const result = compile(
    `builder.till_soil({ x: 60, y: 18 });
     builder.for_each({ source: { area: ${PATCH} }, do: { action: "harvest_crop", expectedQualifiedItemId: "(O)24", expectedTargetId: "crop_0123456789abcdef" } });`,
  );
  assert.equal(
    result.ok,
    false,
    "the plan is refused, so the refused loop cannot be dispatched with an identity nobody minted",
  );
  assert.deepEqual(
    result.ok ? [] : result.rejected.map((entry) => entry.reasonCode),
    [`plan_script_${PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL}:harvest_crop`],
    "the refused call is named by the action whose row identity the caller tried to write",
  );
  assert.deepEqual(result.dropped, [`n02:plan_script_${PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL}:harvest_crop`]);
  assert.deepEqual(result.acceptedSteps, ["n01"], "the tile she wrote first compiled, and is named beside the refusal");
});

/**
 * PROPERTY 5. A ROW'S `do` IS A CHAIN, and the single object is the chain of length one.
 *
 * Farm work is a chain per tile - clear, till, water, sow - and a form that could name only one action per row needed one
 * pass per action: four passes of waking, ordering and receipts over the same sixty tiles, each pass reporting the tiles the
 * previous one had just prepared. ONE pass now does the whole tile, in the order the caller wrote, and the SHAPE of a step is
 * exactly the object a lone `do` has always been - so there is no second argument spelling beside it.
 */
test("a do array is one ordered chain of steps on one tile, and the bound is the Mod's own number", () => {
  const declaredSteps = /MaximumSteps\s*=\s*(\d+)/u.exec(readFileSync(MOD_RULES_PATH, "utf8"));
  assert.ok(
    declaredSteps !== null,
    "the Mod's chain model must still declare MaximumSteps; this gate reads it from there",
  );
  assert.equal(
    MAX_FOR_EACH_STEPS,
    Number(declaredSteps[1]),
    "the Host and the Mod must bound one row's chain at the same step count",
  );

  const chained = compile(
    `builder.for_each({ source: { area: ${PATCH} }, do: [
       { action: "till_soil" },
       { action: "water_crop" },
       { action: "plant_seed", seed: "hops" }
     ] });`,
  );
  const steps = loopOf(nodesOf(chained)[0]!).do;
  assert.deepEqual(
    steps,
    [{ action: "till_soil" }, { action: "water_crop" }, { action: "plant_seed", seed: "hops" }],
    "the steps arrive in the order the caller wrote them, each with its own arguments",
  );

  // THE SINGLE FORM IS THE SAME VALUE, so a reader downstream has one shape to run and the Mod has one shape to report.
  const single = loopOf(
    nodesOf(compile(`builder.for_each({ source: { area: ${PATCH} }, do: { action: "till_soil" } });`))[0]!,
  );
  assert.deepEqual(single.do, [{ action: "till_soil" }]);
});

/**
 * THE CHAIN IS BOUNDED AT BOTH ENDS, AND EACH END NAMES WHAT TO FIX.
 *
 * An empty array is not "leave this row alone" - `do: null` is the spelling for that - and a chain past the bound answers its
 * own length beside the bound rather than being trimmed: a row that silently lost its fourth step would report the tile as
 * worked, which is the defect class this whole form exists to remove.
 */
test("a chain past its bound and a chain with no steps are refused by name, with the numbers", () => {
  const tooMany = Array.from({ length: MAX_FOR_EACH_STEPS + 1 }, () => ({ action: "till_soil" }));
  const overlong = readForEachLoop({ source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: tooMany }, null);
  assert.equal(overlong.ok, false);
  assert.equal(
    overlong.ok ? "" : overlong.code,
    "loop_do_too_many_steps",
    "the refusal is its own word, not a generic invalid",
  );
  assert.equal(
    overlong.ok ? "" : overlong.detail,
    `${String(MAX_FOR_EACH_STEPS + 1)}:${String(MAX_FOR_EACH_STEPS)}`,
    "the detail carries the count the caller wrote beside the bound it must stay under",
  );

  const empty = readForEachLoop({ source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: [] }, null);
  assert.equal(empty.ok, false);
  assert.equal(empty.ok ? "" : empty.code, "loop_do_empty");
});

/**
 * A STEP THAT IS NOT A STEP IS NAMED BY ITS POSITION AND SAYS WHAT A STEP LOOKS LIKE.
 *
 * The word this used to answer (`loop_do_invalid:not_an_object`) named nothing a caller could act on. In a chain the caller
 * has to know WHICH step to fix, and what a step is: `{ action, <argument>: <scalar> }`.
 */
test("a step that is not a step is named by its position, and what to write instead", () => {
  const notAStep = readForEachLoop(
    { source: { area: { x: 0, y: 0, w: 1, h: 1 } }, do: [{ action: "till_soil" }, "water_crop"] },
    null,
  );
  assert.equal(notAStep.ok, false);
  assert.equal(notAStep.ok ? "" : notAStep.code, "loop_do_step_unrecognised");
  assert.equal(notAStep.ok ? "" : notAStep.detail, "step[1]:expected:{action,<argument>:scalar}");

  const argumentNotAScalar = readForEachLoop(
    {
      source: { area: { x: 0, y: 0, w: 1, h: 1 } },
      do: [{ action: "till_soil" }, { action: "plant_seed", seed: ["hops"] }],
    },
    null,
  );
  assert.equal(argumentNotAScalar.ok, false);
  assert.equal(argumentNotAScalar.ok ? "" : argumentNotAScalar.detail, "step[1].plant_seed.seed");
});

/**
 * THE WIRE READS THE ARRAY FORM BACK WITH THE SAME READER THE COMPILER WRITES IT WITH - one reader, two gates.
 *
 * `isForEachLoopDocument` is what `protocol.ts` calls on a `{ type: "loop" }` runtime value before a program may be
 * submitted. THE ASSERTION GOES THROUGH THAT GATE - `validateBodyProgramCandidateRequest`, the function the materializer
 * calls - and not through `isForEachLoopDocument` directly: a test of the reader by itself stays green if the wire stops
 * consulting it, which is the drift this case exists to catch. Before the chain existed the wire answered
 * `invalid_body_program_request` for a document the compiler had just built, which is a form the Mod can run that never
 * crosses.
 */
test("the wire accepts the chain the compiler writes, and refuses past the same bound", () => {
  const submission = (doSteps: readonly unknown[]) =>
    validateBodyProgramCandidateRequest({
      programId: "program_chain",
      nodes: [
        {
          nodeId: "loop",
          actionId: "for_each",
          arguments: { loop: { type: "loop", source: { area: { x: 0, y: 0, w: 6, h: 1 } }, do: doSteps } },
          dependsOn: [],
          bindings: {},
        },
      ],
    });

  assert.equal(
    submission([{ action: "till_soil" }, { action: "plant_seed", seed: "hops" }]),
    null,
    "a chain the compiler can write is a loop the wire can carry",
  );
  assert.equal(
    submission(Array.from({ length: MAX_FOR_EACH_STEPS + 1 }, () => ({ action: "till_soil" }))),
    "invalid_body_program_request",
    "the wire holds the same bound, because it runs the same reader",
  );
  // The reader itself is asked the question the wire has no vocabulary for: a chain with no steps is not a loop.
  assert.equal(isForEachLoopDocument({ type: "loop", source: { area: { x: 0, y: 0, w: 6, h: 1 } }, do: [] }), false);
});

/** A row identity is the Mod's in EVERY step of a chain, not only in the first one. */
test("a row identity inside a later step is refused by name", () => {
  const result = readForEachLoop(
    {
      source: { area: { x: 0, y: 0, w: 1, h: 1 } },
      do: [{ action: "till_soil" }, { action: "water_crop", expectedTargetId: "crop_0123456789abcdef" }],
    },
    null,
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok ? "" : result.code, PLAN_FOR_EACH_ROW_IDENTITY_REFUSAL);
});

/**
 * THE DESCRIPTION TEACHES THE CHAIN, AND ITS BOUND IS THE READER'S BOUND.
 *
 * The form is only reachable if the block the companion reads shows it: a grammar that accepts an array and a description
 * that only ever shows a single action is `stardew_express_emote` again - named in the prompt, absent from the tool list. So
 * the teaching block is asserted here, with the step count read from the constant the reader refuses past, and the receipt
 * words (`steps`, `stopped_at`) the Mod's own row carries.
 */
test("the plan description shows the chain and prints the bound the reader enforces", () => {
  const description = planWorkDescription(ACTIONS);
  assert.ok(
    description.includes('do: [{ action: "till_soil" }, { action: "plant_seed", seed: "hops" }]'),
    "the description shows a two-step chain, or the companion never learns the form exists",
  );
  assert.ok(
    description.includes(`at most ${String(MAX_FOR_EACH_STEPS)} of them`),
    "the step bound the description prints is the constant the reader refuses past",
  );
  assert.ok(
    description.includes("stopped_at"),
    "a row that stopped half-done is described in the words the Mod answers it in",
  );
});
