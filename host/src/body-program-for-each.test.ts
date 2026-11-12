import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FOR_EACH_SOURCE_UNRECOGNISED,
  FOR_EACH_WHERE_UNRECOGNISED,
  forEachRules,
  isForEachLoopDocument,
  MAX_FOR_EACH_LOOP_DOCUMENT_CHARS,
  MAX_FOR_EACH_OCCUPANT_CHARS,
  MAX_FOR_EACH_ROWS,
  MAX_FOR_EACH_RULES,
  MAX_FOR_EACH_STEPS,
  type PlanForEachLoop,
  type PlanForEachRule,
  PLAN_FOR_EACH_PREDICATE_SPELLINGS,
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
  STEP_ARGUMENTS_STILL_OMISSIBLE,
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
    `builder.till_soil({ x: 60, y: 18, charge: 0 });
     builder.for_each({ source: { area: { x: 0, y: 0, w: 20, h: 20 } }, do: { action: "cut_weeds" } });
     builder.till_soil({ x: 61, y: 18, charge: 0 });`,
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
    `builder.for_each({ source: { area: { x: 60, y: 18, w: 20, h: 3 } }, where: [{ field: "kind", in: ["weed", "stone"] }], do: { action: "by_kind" } });`,
  );
  assert.equal(byKind.ok, true);
  const unknown = compile(
    `builder.for_each({ source: { area: { x: 60, y: 18, w: 20, h: 3 } }, do: { action: "obliterate" } });`,
  );
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
    description.includes("for_each_source_unrecognised:<given>;allowed=area"),
    "the ONE source the form has, and the refusal a caller meets for any other word, are both in the description",
  );
  assert.equal(
    description.includes("for_each_source_unavailable"),
    false,
    "a source is refused by the grammar now, so no source can reach the game thread to be refused there - a description that teaches for_each_source_unavailable teaches a code nothing answers",
  );
  assert.equal(
    /\{ family:|\{ query:/.test(description),
    false,
    "the withdrawn sources must not be taught anywhere: a caller taught `{ family: ... }` writes a loop the compiler refuses",
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
  const loop: PlanForEachLoop = { source: { area: { x: 60, y: 18, w: 20, h: 3 } }, do: null };
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
    `builder.till_soil({ x: 60, y: 18, charge: 0 });
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

/** One loop document around one `where` predicate, so every case below asks the reader the same question. */
function loopAround(predicate: unknown): Record<string, unknown> {
  return { source: { area: { x: 0, y: 0, w: 2, h: 1 } }, where: [predicate], do: { action: "cut_weeds" } };
}

/**
 * The spellings the Mod's predicate model declares, read out of `FarmhandForEachPredicate.Selectors` rather than restated
 * here: the constants are resolved through their own names, so the gate follows a rename instead of going quiet.
 */
function modWhereSpellings(): readonly string[] {
  const source = readFileSync(MOD_RULES_PATH, "utf8");
  const block = /Selectors\s*=\s*\{([^}]*)\}/u.exec(source);
  assert.ok(block !== null, "the Mod's predicate model must still declare Selectors; this gate reads it from there");
  return block[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((name) => {
      const declared = new RegExp(`${name}\\s*=\\s*"([a-z0-9_]+)"`, "u").exec(source);
      assert.ok(declared !== null, `the Mod's Selectors names ${name}, which must still be declared in the same file`);
      return declared[1]!;
    });
}

/**
 * THE WHERE SPELLINGS ARE ONE DECLARATION IN TWO LANGUAGES.
 *
 * POPULATION: the spellings the model declares. The Mod's half is read out of `FarmhandForEachPredicate.Selectors` (the
 * array its own reader accepts against and its refusal prints), and the Host's `PLAN_FOR_EACH_PREDICATE_SPELLINGS` is
 * asserted equal to it word for word - so a spelling added on either side is red here, naming the side that drifted.
 *
 * PROPERTY: every declared spelling is read by BOTH readers for the same document, and the refusal for a word the grammar
 * does not have names all of them. What that replaces, measured: `tools/body-program-journal/journal.json` carries
 * `failureCode: for_each_where_unrecognised:in` - a document the compiler and the wire had already accepted, refused on
 * the game thread by a word that named nothing the caller could write instead, after which she stopped trying.
 *
 * THE MOD'S OTHER HALF is `FarmhandForEachArgumentsTests.EveryDeclaredWhereSpellingIsReadAndTheRefusalNamesThem`, driven
 * through `TryParseDocument`: a node test cannot call into C#, so the same property is asserted on each side against the
 * same declaration. Neither half passes alone.
 */
test("where_spellings: every spelling the model declares is read by both readers and named by the refusal", () => {
  const modSpellings = modWhereSpellings();
  assert.ok(
    modSpellings.length > 0,
    "blocked: the Mod's predicate model declares no where spelling, so this gate examined nothing",
  );
  for (const spelling of PLAN_FOR_EACH_PREDICATE_SPELLINGS)
    assert.ok(modSpellings.includes(spelling), `where_readers_disagree:${spelling}:mod`);
  for (const spelling of modSpellings)
    assert.ok(PLAN_FOR_EACH_PREDICATE_SPELLINGS.includes(spelling), `where_readers_disagree:${spelling}:host`);
  assert.deepEqual(
    PLAN_FOR_EACH_PREDICATE_SPELLINGS,
    modSpellings,
    "one declaration, two languages: the order the refusal prints is the Mod's order",
  );

  // One minimal document per spelling; a spelling with none here is a blocked reading that says so, never a silent skip.
  const documents: Readonly<Record<string, unknown>> = Object.freeze({
    field: { field: "kind", eq: "weed" },
    col: { col: { every: 2, offset: 0 } },
    row: { row: { every: 2, offset: 0 } },
    occupant: { occupant: "weed" },
  });
  for (const spelling of modSpellings) {
    const document = documents[spelling];
    assert.ok(document !== undefined, `where_spelling_unproven:${spelling} - nothing here proves this reader reads it`);
    const reading = readForEachLoop(loopAround(document), null);
    assert.ok(
      reading.ok,
      `where_readers_disagree:${spelling}:host (${reading.ok ? "" : `${reading.code}:${reading.detail}`})`,
    );
    assert.equal(
      isForEachLoopDocument({ type: "loop", ...loopAround(document) }),
      true,
      `the wire must carry ${spelling} too: it runs the same reader`,
    );
  }

  // THE REFUSAL ARM, on the word she actually wrote: `{ in: [...] }` is a comparison with nothing to compare.
  const refused = readForEachLoop(loopAround({ in: ["weed"] }), null);
  assert.equal(refused.ok, false, "a predicate with no selector is not a predicate");
  assert.equal(
    refused.ok ? "" : refused.code,
    FOR_EACH_WHERE_UNRECOGNISED,
    "the refusal names the fact: this word is not one this form has",
  );
  const detail = refused.ok ? "" : refused.detail;
  const allowed = detail.split(";allowed=")[1]?.split(",") ?? [];
  for (const spelling of modSpellings)
    assert.ok(allowed.includes(spelling), `where_spelling_not_in_refusal:${spelling} - the refusal says ${detail}`);
  assert.deepEqual(
    allowed,
    modSpellings,
    "the alternatives are the declaration, in its order, not a list written beside the message",
  );
  assert.ok(
    detail.startsWith("predicate[0]:in;"),
    `the refusal also names the row of the declaration that broke it, received ${detail}`,
  );
});

/**
 * The row sources the Mod's reader accepts, read out of `FarmhandForEachSource.Kinds` rather than restated here: the
 * constants are resolved through their own names, so the gate follows a rename instead of going quiet.
 */
function modLoopSourceKinds(): readonly string[] {
  const source = readFileSync(MOD_RULES_PATH, "utf8");
  const block = /Kinds\s*=\s*\{([^}]*)\}/u.exec(source);
  assert.ok(block !== null, "the Mod's loop model must still declare Kinds; this gate reads it from there");
  return block[1]!
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((name) => {
      const declared = new RegExp(`${name}\\s*=\\s*"([a-z0-9_]+)"`, "u").exec(source);
      assert.ok(declared !== null, `the Mod's Kinds names ${name}, which must still be declared in the same file`);
      return declared[1]!;
    });
}

/**
 * THE ROW SOURCE SET IS ONE DECLARATION IN TWO LANGUAGES, AND THIS IS THE GATE FOR IT.
 *
 * POPULATION: the Mod's own `FarmhandForEachSource.Kinds` - the array its reader accepts against and its refusal prints -
 * compared with `PLAN_FOR_EACH_SOURCES`, which the compiler, the wire reader and the description all read.
 *
 * THE DEFECT THIS CLOSES. This grammar accepted `family` and `query` and the Mod enumerated one: both validated here, both
 * passed the preflight, and both died on the game thread as `for_each_source_unavailable:<kind>` - a code naming a source
 * the caller had written. `sceneTarget`, `regrowDays: -1` and `seedSupplyTargets` were the same split: a key one side
 * accepts and the other cannot answer. A source added to the grammar alone is red here, naming the side and the word.
 */
test("for_each_source_set_drift: the grammar accepts exactly the row sources the Mod's reader enumerates", () => {
  const modKinds = modLoopSourceKinds();
  assert.ok(
    modKinds.length > 0,
    "blocked: the Mod's loop model declares no source kind, so this gate examined nothing",
  );
  for (const kind of PLAN_FOR_EACH_SOURCES)
    assert.ok(modKinds.includes(kind), `for_each_source_set_drift:host:${kind}`);
  for (const kind of modKinds) assert.ok(PLAN_FOR_EACH_SOURCES.includes(kind), `for_each_source_set_drift:mod:${kind}`);
  assert.deepEqual(
    PLAN_FOR_EACH_SOURCES,
    modKinds,
    "one declaration, two languages: the words the refusal prints are the Mod's, in its order",
  );

  // THE OTHER HALF, driven through the readers: the word the Mod refuses is the word this grammar refuses, with the same
  // alternatives - so a caller cannot be taught one answer and given another.
  for (const withdrawn of ["family", "query"]) {
    assert.equal(
      PLAN_FOR_EACH_SOURCES.includes(withdrawn),
      false,
      `for_each_source_set_drift:host:${withdrawn} - the Mod enumerates no rows for this source, so the grammar must not accept it`,
    );
    const refused = readForEachLoop(
      { source: { [withdrawn]: withdrawn === "family" ? "cropTargets" : { subject: "crop" } }, do: null },
      null,
    );
    assert.equal(
      refused.ok ? "" : refused.code,
      FOR_EACH_SOURCE_UNRECOGNISED,
      `${withdrawn} is not a source this form has`,
    );
    assert.equal(
      refused.ok ? "" : refused.detail,
      `${withdrawn};allowed=${modKinds.join(",")}`,
      `the refusal names the word written and the words the Mod's own declaration allows`,
    );
  }
  const empty = readForEachLoop({ source: {}, do: null }, null);
  assert.equal(
    empty.ok ? "" : empty.detail,
    `empty;allowed=${modKinds.join(",")}`,
    "a source with no word at all says so",
  );
});

/**
 * `occupant` IS THE TILE'S OWN FACT, AND THE CALLER WRITES ONE WORD FOR IT.
 *
 * A mixed patch is the measured case: filtering by `kind` asks "whatever the Mod would clear with a scythe", which sent a
 * weed tool at the stones and reported the stones as worked. The occupant words are the engine's own - the same words the
 * Mod's `Clears` declarations are written in - and this side neither invents nor validates a vocabulary, it only bounds the
 * word by the length the wire already bounds that field by.
 */
test("an occupant predicate is read, compiled, carried by the wire, and bounded like the field it tests", () => {
  const document = loopAround({ occupant: "weed" });
  const reading = readForEachLoop(document, null);
  assert.ok(
    reading.ok,
    `a tile's occupant is one of the spellings this form has (${reading.ok ? "" : `${reading.code}:${reading.detail}`})`,
  );
  assert.deepEqual(
    reading.loop.where,
    [{ occupant: "weed" }],
    "the predicate travels as the caller wrote it, because the Mod reads the same word on the game thread",
  );

  const compiled = compile(
    `builder.for_each({ source: { area: ${PATCH} }, where: [{ occupant: "weed" }], do: { action: "cut_weeds" } });`,
  );
  assert.deepEqual(forEachRules(loopOf(nodesOf(compiled)[0]!))[0]?.where, [{ occupant: "weed" }]);

  const description = planWorkDescription(ACTIONS);
  assert.ok(
    description.includes('{ occupant: "weed" }'),
    "the teaching block shows the spelling, or the companion never learns it exists",
  );
  assert.ok(
    description.includes(FOR_EACH_WHERE_UNRECOGNISED),
    "the description prints the refusal both sides answer, so a wrong spelling is recognisable when it arrives",
  );

  // RANGE: the word is bounded where the row's own `occupant` field is bounded, and an empty word claims nothing.
  const tooLong = readForEachLoop(loopAround({ occupant: "x".repeat(MAX_FOR_EACH_OCCUPANT_CHARS + 1) }), null);
  assert.equal(tooLong.ok ? "" : tooLong.detail, "predicate[0]:occupant");
  assert.equal(readForEachLoop(loopAround({ occupant: "" }), null).ok, false);
  // AND IT IS ONE TEST: a second spelling beside it is refused rather than folded into it, and that refusal is generated
  // from the same declaration the one above is - so a hand-written list in either message is red here.
  const twoTests = readForEachLoop(loopAround({ occupant: "weed", eq: "weed" }), null);
  assert.equal(twoTests.ok ? "" : twoTests.code, FOR_EACH_WHERE_UNRECOGNISED);
  assert.deepEqual(
    (twoTests.ok ? "" : twoTests.detail).split(";allowed=")[1]?.split(","),
    [...PLAN_FOR_EACH_PREDICATE_SPELLINGS],
    "a second test beside `occupant` is refused with the spellings this form has, not with a list written beside the message",
  );
});

/**
 * An argument only the caller can supply is refused WHEN THE PLAN IS COMPILED, not once per row.
 *
 * <p>
 * `till_soil` declares `charge` since the area-tool unit: one native use covers the tool's own footprint, and `0` is
 * the single named tile. A `for_each` row supplies the tile, the identity the family mints from it, and the step's own
 * scalars - so a step that leaves the charge out closes EVERY row `row_argument_missing:charge`, and the pass reports
 * nothing worked. Learning that from a spent pass costs the whole patch, so the compiler answers it in the call that
 * wrote it, naming the argument and the list the action actually declares.
 * </p>
 *
 * <p>
 * red-proof: remove `refuseMissingStepArguments` from `emitForEachNode` -> this compile is accepted and the loop is
 * submitted, which is the per-row answer this exists to pre-empt.
 * </p>
 */
test("a step that omits an argument only the caller can supply is refused at compile time", () => {
  const missing = compile(
    `builder.for_each({ source: { area: { x: 60, y: 18, w: 3, h: 1 } }, do: { action: "till_soil" } });`,
  );
  assert.equal(missing.ok, false, "a step the rows could never complete must not be accepted");
  assert.deepEqual(missing.ok ? [] : missing.rejected.map((entry) => entry.reasonCode), [
    "plan_script_loop_do_argument_missing:charge:declared=[x,y,charge]",
  ]);
  assert.deepEqual(missing.dropped, ["n01:plan_script_loop_do_argument_missing:charge:declared=[x,y,charge]"]);
  const refusedNames = missing.ok ? [] : (missing.missingArguments ?? []);
  assert.deepEqual(refusedNames, ["charge"], "the answer names every argument left out, not just the first");

  // With the charge supplied the same step compiles: the refusal names a missing argument, never the action.
  const supplied = compile(
    `builder.for_each({ source: { area: { x: 60, y: 18, w: 3, h: 1 } }, do: { action: "till_soil", charge: 0 } });`,
  );
  assert.equal(supplied.ok, true);

  // And `by_kind` names no action of its own, so there is nothing for this check to compare against: the Mod's
  // classifier decides per row and its answers stay the row's.
  const byKind = compile(
    `builder.for_each({ source: { area: { x: 60, y: 18, w: 3, h: 1 } }, do: { action: "by_kind" } });`,
  );
  assert.equal(byKind.ok, true);

  // The two names a step can still leave out are exactly the two the shipped examples omit, and no others: a third
  // would be a capability decision taken outside a plan-time answer.
  assert.deepEqual(
    [...STEP_ARGUMENTS_STILL_OMISSIBLE],
    ["slot", "expectedQualifiedItemId"],
    "the omissible set is a measured finding, so it cannot grow silently",
  );
});

/**
 * The description TEACHES the repair, and the example it prints is a call the compiler accepts.
 *
 * <p>
 * A refusal without a taught repair is the shape this repository keeps paying for: `by_kind` cannot work fresh ground
 * any more (its step has nowhere to put a charge), and an agent that is only denied will retry the same loop. So the
 * description says, in one sentence, that fresh ground is tilled with an explicit `charge: 0` step - and the loop
 * example it prints carries the argument, because a description that teaches a shape the compiler refuses is the same
 * defect in reverse.
 * </p>
 *
 * <p>
 * red-proof: drop the sentence from `planWorkDescription`, or drop `charge: 0` from the printed example -> this test
 * names what stopped being taught.
 * </p>
 */
test("the loop description teaches the charge and prints a step the compiler accepts", () => {
  const description = planWorkDescription(ACTIONS);
  assert.ok(
    description.includes('do: { action: "till_soil", charge: 0 }'),
    "the printed loop example must be a step the compiler accepts, so it carries the argument the action declares",
  );
  assert.ok(
    description.includes("loop_do_argument_missing"),
    "the description names the compile-time refusal, so a caller can recognise the answer it will get",
  );
  assert.ok(
    description.includes("fresh ground is tilled with"),
    "the repair for the kind `by_kind` can no longer work is taught, not merely denied",
  );
  assert.ok(
    description.includes("by_kind"),
    "the sentence must say which kinds `by_kind` still covers, or the caller is left guessing",
  );

  // The example the description prints is compiled HERE, so a description that drifts from the compiler fails rather
  // than teaching a call that is refused.
  const example = compile(
    `builder.for_each({ source: { area: { x: 60, y: 18, w: 20, h: 3 } }, where: [{ col: { every: 3, offset: 0 } }], do: { action: "till_soil", charge: 0 } });`,
  );
  assert.equal(example.ok, true, "the loop the description prints must compile");
});
