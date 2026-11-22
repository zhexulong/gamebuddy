import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type CompiledPlan,
  compilePlanScript,
  PLAN_GUARDED_FAMILIES,
  PLAN_ITERATION_CONDITIONS,
  type PlanIterationCondition,
  PLAN_ROW_IDENTITY,
  PLAN_SNAPSHOT_READINGS,
  type PublishedPlanAction,
  planActionsFromRegistrations,
} from "./body-program-script.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";

/**
 * A DEFENCE THE SUBMITTER CANNOT KNOW IS NOT THE SUBMITTER'S: the arguments that are READINGS of the submit-moment
 * snapshot are bound from it, once, and the ones that are hers to mean stay hers.
 *
 * <p>
 * MEASURED, `round84` (2026-11-20, `.live-runs/game-ladder/2026-11-20T13-52-51-386Z-multiday_routine/result.json`): 54
 * `plant_seed` nodes across 60 accepted programs, **22 of them answered `seed_target_unavailable`**, and the argument
 * list of the one this file opens with is
 * `{ x: 79, y: 18, slot: 11, expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_51f5e088b8c867e7" }`. Two of those
 * five are intentions - the tile and the parsnip - and the other two are copies of a row she was holding. The proof that
 * they were copies and not knowledge is in her own submission: the tile `(59,18)` appears twice in one program with
 * `seed_c3b61bfd997b7c5d` and `seed_e679c8cf63897586`, and the tile `(59,12)` with `seed_5a1d88608da94024` and
 * `seed_a622a6ef9ac8746a`. One tile cannot carry two ids, so at least one of each pair was stale before the plan was
 * even submitted.
 * </p>
 * <p>
 * WHAT THIS FILE PROTECTS. Three answers, and only one of them may be a guess: (1) the snapshot holds the row her tile
 * and item select, so that row's `targetId`/`slot` is what the program carries; (2) the action's family is published and
 * holds NO such row, so the call is refused by name and place at compile time instead of failing once per node in the
 * body; (3) the family is not published at all, so the snapshot cannot answer and her number stands exactly as before.
 * The negative is asserted as hard as the positive: nothing that carries intent - the tile, the item, which seed, how
 * many - is ever replaced, and `boundFromSnapshot` may not name a single argument that is not a reading.
 * </p>
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);
const PROTOCOL_SOURCE = resolve(hostRoot, "src/protocol.ts");

type Json = Record<string, unknown>;

const SURFACE = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as Readonly<{ actions?: readonly Json[] }>;
const PUBLISHED_ACTIONS = SURFACE.actions ?? [];
assert.ok(PUBLISHED_ACTIONS.length > 0, "examined 0 published actions: this gate would agree with itself");

type DeclaredArgument = Readonly<{
  name: string;
  type: string;
  enum?: readonly string[];
  resolvedAtExecution?: boolean;
}>;

function declaredArguments(action: Json): readonly DeclaredArgument[] {
  const schema = (action.argumentSchema ?? {}) as Record<string, Json>;
  return Object.entries(schema).map(([name, declared]) => ({
    name,
    type: typeof declared.type === "string" ? declared.type : "string",
    ...(Array.isArray(declared.enum) ? { enum: declared.enum as readonly string[] } : {}),
    // The Mod's own declaration that its BODY answers for this value at execution, published on the artifact and read
    // by the compiler as `required: false`.
    ...(declared.resolvedAtExecution === true ? { resolvedAtExecution: true as const } : {}),
  }));
}

const REGISTRATIONS: readonly ActionRegistration[] = PUBLISHED_ACTIONS.map((action) => {
  const arguments_ = declaredArguments(action);
  return {
    actionId: action.actionId as string,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    ...(arguments_.length === 0
      ? {}
      : {
          descriptor: {
            arguments: arguments_,
            effect: (action.effect ?? "write") as "read" | "write",
            nativeBinding: "Fixture.Binding",
            ...(action.targetFamily === undefined ? {} : { targetFamily: action.targetFamily as string }),
            ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate as never }),
            ...(action.outputFacts === undefined ? {} : { outputFacts: action.outputFacts as never }),
          },
        }),
  };
});

const PLAN_ACTIONS: readonly PublishedPlanAction[] = planActionsFromRegistrations(REGISTRATIONS);
assert.ok(PLAN_ACTIONS.length > 50, `examined ${String(PLAN_ACTIONS.length)} plannable actions`);

/**
 * The row fields each snapshot family publishes, read out of the `Snapshot` type - the authority the Mod writes to and
 * `planSnapshotRowFamilies` reads at run time.
 *
 * Derby from the type rather than a table here, because a table would answer "what did the family publish when this gate
 * was written" while the question is "what does it publish now": a field the Mod adds is picked up without an edit, and a
 * family renamed takes its rows with it.
 *
 * A NESTED OBJECT IS A FIELD'S VALUE, NOT A FIELD OF THE ROW. `chests.items` and `shopTargets.stockPrices` are rows of
 * their own shape inside one row, and a reader that matched through the braces reported their members (`slot`, `stack`,
 * `qualifiedItemId`, `price`) as fields the outer row publishes - so a fixture row built from this map carried a
 * top-level `qualifiedItemId` that `shopTargets` does not have, and the row-selection it fed matched a phantom field.
 */
function withoutNestedGroups(body: string): string {
  let depth = 0;
  let text = "";
  for (const character of body) {
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) text += character;
  }
  return text;
}

function snapshotFamilyFields(): ReadonlyMap<string, readonly string[]> {
  const source = readFileSync(PROTOCOL_SOURCE, "utf8");
  const typeAt = source.indexOf("export type Snapshot = Readonly<{");
  assert.ok(typeAt >= 0, "protocol_snapshot_type_not_found");
  const open = source.indexOf("{", typeAt);
  let depth = 0;
  let close = -1;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  assert.ok(close > open, "protocol_snapshot_type_unterminated");
  const block = source.slice(open + 1, close);
  const families = new Map<string, readonly string[]>();
  const declaration = /(\w+)\??:\s*readonly\s+Readonly<\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = declaration.exec(block)) !== null) {
    let rowDepth = 0;
    let rowEnd = -1;
    for (let index = match.index + match[0].length - 1; index < block.length; index += 1) {
      if (block[index] === "{") rowDepth += 1;
      else if (block[index] === "}") {
        rowDepth -= 1;
        if (rowDepth === 0) {
          rowEnd = index;
          break;
        }
      }
    }
    if (rowEnd < 0) continue;
    const body = withoutNestedGroups(block.slice(match.index + match[0].length, rowEnd));
    families.set(match[1]!, Object.freeze([...body.matchAll(/(?:^|[\s;,])(\w+)\??:/g)].map((field) => field[1]!)));
  }
  assert.ok(families.size > 50, `examined ${String(families.size)} snapshot families`);
  return families;
}

const FAMILY_FIELDS = snapshotFamilyFields();

/** The tile and item the fixture row sits on, and the values the row publishes for the two readings. */
const ROW_TILE = Object.freeze({ x: 4, y: 9 });
const ROW_SLOT = 12;
const ROW_TARGET_ID = "row_target_id";
const ROW_ITEM = "(O)472";
/** What SHE writes into a reading, which is stale in every direction the fixture needs. */
const HER_SLOT = 3;
const HER_TARGET_ID = "her_stale_target_id";

function bareSnapshot(actionId: string): Snapshot {
  return {
    revision: 52,
    location: "Farm",
    tile: { x: 78, y: 17 },
    stamina: 270,
    exhausted: false,
    health: 100,
    actionable: true,
    capabilities: [actionId],
    catalogRevision: 1,
    enabledActionIds: [actionId],
    presentationLocale: "en-US",
    timeOfDay: 1320,
    dayOfMonth: 5,
    seasonIndex: 0,
    year: 1,
    weather: "sunny",
    activeExecution: null,
  };
}

/** One row as the snapshot publishes it, carrying only the fields the family declares and this compiler can read. */
function rowAt(fields: readonly string[], overrides: Json = {}): Json {
  const values: Json = {
    x: ROW_TILE.x,
    y: ROW_TILE.y,
    targetId: ROW_TARGET_ID,
    slot: ROW_SLOT,
    qualifiedItemId: ROW_ITEM,
    location: "Farm",
  };
  const row: Json = {};
  for (const field of fields) if (field in values) row[field] = values[field];
  return { ...row, ...overrides };
}

/** A snapshot carrying one family's rows: the rows are the fixture's, the rest is what the compiler requires. */
function snapshotCarrying(base: Snapshot, family: string, rows: readonly Json[]): Snapshot {
  return Object.assign({}, base, { [family]: rows });
}

function snapshotWith(action: PublishedPlanAction, overrides: Json = {}): Snapshot {
  const family = action.targetFamily;
  if (family === null) return bareSnapshot(action.actionId);
  const fields = FAMILY_FIELDS.get(family);
  if (fields === undefined || fields.length === 0) return bareSnapshot(action.actionId);
  return snapshotCarrying(bareSnapshot(action.actionId), family, [rowAt(fields, overrides)]);
}

/** A literal she could write for one argument: her intentions as she means them, her readings as a stale copy. */
function literalFor(argument: DeclaredArgument): string {
  if (argument.enum !== undefined) return JSON.stringify(argument.enum[0]);
  if (argument.type === "integer") {
    if (argument.name === "x") return String(ROW_TILE.x);
    if (argument.name === "y") return String(ROW_TILE.y);
    return String(HER_SLOT);
  }
  if (argument.type === "boolean") return "true";
  if (argument.type === "string")
    return JSON.stringify(argument.name === "expectedTargetId" ? HER_TARGET_ID : ROW_ITEM);
  return "{ kind: 'label', label: 'shop' }";
}

function callScript(action: PublishedPlanAction, omit: readonly string[] = []): string {
  const fields = action.arguments
    .filter((argument) => !omit.includes(argument.name))
    .map((argument) => `${argument.name}: ${literalFor(argument)}`);
  return `builder.${action.actionId}({ ${fields.join(", ")} });`;
}

function nodesOf(result: CompiledPlan): readonly Readonly<{ actionId: string; arguments: Record<string, Json> }>[] {
  return result.status === "compiled" || result.status === "partial" ? result.program.nodes : [];
}

function boundOf(result: CompiledPlan): readonly string[] {
  return result.status === "compiled" || result.status === "partial" ? result.boundFromSnapshot : [];
}

function valueOf(result: CompiledPlan, actionId: string, argument: string): string | undefined {
  const node = nodesOf(result).find((candidate) => candidate.actionId === actionId);
  const value = node?.arguments[argument] as Readonly<{ canonicalValue?: unknown }> | undefined;
  return typeof value?.canonicalValue === "string" ? value.canonicalValue : undefined;
}

function compile(script: string, snapshot: Snapshot): CompiledPlan {
  return compilePlanScript({ script }, { snapshot, actions: PLAN_ACTIONS });
}

/**
 * THE MEASURED CALL, verbatim: two intentions and two copies. The snapshot holds the row for `(79,18)` with the id and
 * the slot it holds NOW, and the program that runs must carry those - her copies are a memory of revision 52.
 */
test("the round84 planting carries the row the snapshot holds, not the id and slot she copied", () => {
  const planting = PLAN_ACTIONS.find((action) => action.actionId === "plant_seed");
  assert.ok(planting !== undefined, "the surface publishes plant_seed");
  const fields = FAMILY_FIELDS.get("seedTargets");
  assert.ok(fields !== undefined, "the Snapshot type publishes seedTargets");
  const live = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [
    rowAt(fields, { x: 79, y: 18, slot: 11, targetId: "seed_9c0a51c8f2e7b3d4" }),
    rowAt(fields, { x: 77, y: 18, slot: 11, targetId: "seed_41d8f0b6c9a2e573" }),
  ]);

  const measured = compile(
    [
      `builder.plant_seed({ x: 79, y: 18, slot: 11, expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_51f5e088b8c867e7" });`,
      `builder.plant_seed({ x: 77, y: 18, slot: 11, expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_c73d11af4b137a8b" });`,
    ].join("\n"),
    live,
  );
  assert.equal(measured.status, "compiled", JSON.stringify(nodesOf(measured)));
  assert.deepEqual(
    nodesOf(measured).map((node) => [node.arguments.x, node.arguments.y, node.arguments.expectedTargetId]),
    [
      [
        { type: "integer", canonicalValue: "79" },
        { type: "integer", canonicalValue: "18" },
        { type: "string", canonicalValue: "seed_9c0a51c8f2e7b3d4" },
      ],
      [
        { type: "integer", canonicalValue: "77" },
        { type: "integer", canonicalValue: "18" },
        { type: "string", canonicalValue: "seed_41d8f0b6c9a2e573" },
      ],
    ],
    "each step carries the row its own tile selects, so the program cannot hold one id for two tiles",
  );
  // HER INTENTIONS SURVIVE EXACTLY: the tile and the item are what she meant, and nothing here read them from a row.
  assert.deepEqual(
    nodesOf(measured).map((node) => node.arguments.expectedQualifiedItemId),
    [
      { type: "string", canonicalValue: "(O)472" },
      { type: "string", canonicalValue: "(O)472" },
    ],
  );
  // AND SHE IS TOLD WHICH ONES WERE THE HARNESS'S, so the next plan omits them instead of paying for a copy.
  assert.deepEqual(boundOf(measured), [
    "bound=plant_seed.slot;from=snapshot.seedTargets[].slot",
    "bound=plant_seed.expectedTargetId;from=snapshot.seedTargets[].targetId",
    "bound=plant_seed.slot;from=snapshot.seedTargets[].slot",
    "bound=plant_seed.expectedTargetId;from=snapshot.seedTargets[].targetId",
  ]);
  assert.equal(measured.status === "compiled" ? measured.boundFromSnapshotCount : -1, 4);

  // THE SAME PLAN WITH THE TWO READINGS OMITTED is the same program: they are not hers to write at all.
  const withoutCopies = compile(
    [
      `builder.plant_seed({ x: 79, y: 18, expectedQualifiedItemId: "(O)472" });`,
      `builder.plant_seed({ x: 77, y: 18, expectedQualifiedItemId: "(O)472" });`,
    ].join("\n"),
    live,
  );
  assert.equal(withoutCopies.status, "compiled", JSON.stringify(nodesOf(withoutCopies)));
  assert.deepEqual(nodesOf(withoutCopies), nodesOf(measured));
});

/** The item is what she MEANS: a row holding a different item never replaces the one she wrote. */
test("the item she means is never replaced by the item on the row", () => {
  const planting = PLAN_ACTIONS.find((action) => action.actionId === "plant_seed")!;
  const fields = FAMILY_FIELDS.get("seedTargets")!;
  const live = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [
    rowAt(fields, { qualifiedItemId: "(O)473" }),
  ]);
  const result = compile(`builder.plant_seed({ x: 4, y: 9, slot: 12, expectedQualifiedItemId: "(O)472" });`, live);
  assert.equal(result.status, "compiled", JSON.stringify(result));
  assert.equal(
    valueOf(result, planting.actionId, "expectedQualifiedItemId"),
    "(O)472",
    "the parsnip she chose is hers, even though the row names a different seed",
  );
});

/**
 * A TILE THE SUBMITTED SNAPSHOT DOES NOT HOLD IS REFUSED THERE, not twenty-two times in the body - and WHICH ABSENCE it
 * is depends on whether the snapshot could have looked. Inside the Mod's discovery radius a family that lists nothing has
 * measured her tile and the refusal names the family to re-read; past that radius the family publishes no row for ANY
 * tile, so the same silence is "not asked" and the refusal names the read instead. Both cost only the call that named
 * them.
 */
test("a target the snapshot does not hold is refused by name at submit time, and only that call", () => {
  const fields = FAMILY_FIELDS.get("seedTargets")!;
  const live = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [rowAt(fields, { x: 79, y: 18 })]);
  // (80,19) is Chebyshev 2 from her tile at (78,17): the family reaches it, so its silence is a measurement.
  const result = compile(
    [
      `builder.plant_seed({ x: 79, y: 18, expectedQualifiedItemId: "(O)472" });`,
      `builder.plant_seed({ x: 80, y: 19, expectedQualifiedItemId: "(O)472" });`,
    ].join("\n"),
    live,
  );
  assert.equal(result.status, "partial", JSON.stringify(result));
  assert.equal(
    result.status === "partial" ? result.reasonCode : "compiled",
    "plan_script_target_not_in_the_submitted_snapshot:seedTargets:80,19",
    "the refusal names the family to re-read and the tile she named",
  );
  assert.deepEqual(
    nodesOf(result).map((node) => node.arguments.x),
    [{ type: "integer", canonicalValue: "79" }],
    "the step whose target IS in the snapshot still runs",
  );
  // THE SAME SILENCE TWENTY-THREE TILES AWAY IS NOT THAT CLAIM, and this file used to answer it with the same word.
  const far = compile(`builder.plant_seed({ x: 81, y: 40, expectedQualifiedItemId: "(O)472" });`, live);
  assert.equal(
    far.status === "refused" || far.status === "partial" ? far.reasonCode : "compiled",
    "plan_script_target_outside_the_read:seedTargets:81,40:read_covers=0",
    "outside the radius nothing on this side named the tile, and no rectangle was read this session",
  );
});

/** Two rows on one tile that disagree about the id: the compiler refuses rather than choosing one for her. */
test("a target the snapshot publishes twice is refused rather than guessed", () => {
  const fields = FAMILY_FIELDS.get("seedTargets")!;
  const live = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [
    rowAt(fields, { targetId: "seed_aaaa0000aaaa0000" }),
    rowAt(fields, { targetId: "seed_bbbb1111bbbb1111" }),
  ]);
  const result = compile(`builder.plant_seed({ x: 4, y: 9, expectedQualifiedItemId: "(O)472" });`, live);
  assert.equal(
    result.status === "partial" || result.status === "refused" ? result.reasonCode : "compiled",
    "plan_script_target_is_ambiguous_in_the_submitted_snapshot:seedTargets:4,9",
  );
});

/** Her stale copy never selects the row it is read from: the item does. */
test("a reading never selects the row it is read from", () => {
  const fields = FAMILY_FIELDS.get("seedTargets")!;
  const live = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [
    rowAt(fields, { qualifiedItemId: "(O)472", targetId: "seed_parsnip00000000" }),
    rowAt(fields, { qualifiedItemId: "(O)473", targetId: "seed_other000000000" }),
  ]);
  const result = compile(
    `builder.plant_seed({ x: 4, y: 9, slot: 3, expectedQualifiedItemId: "(O)473", expectedTargetId: "seed_parsnip00000000" });`,
    live,
  );
  assert.equal(result.status, "compiled", JSON.stringify(result));
  assert.equal(
    valueOf(result, "plant_seed", "expectedTargetId"),
    "seed_other000000000",
    "the item she named selects the row, and her copy of the OTHER row's id cannot override it",
  );
});

/** Not measured is not the same answer as measured-and-nothing: an unpublished family leaves her number alone. */
test("a family the snapshot does not publish leaves the number she wrote alone", () => {
  const result = compile(
    `builder.plant_seed({ x: 4, y: 9, slot: 3, expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_as_she_remembered_it" });`,
    bareSnapshot("plant_seed"),
  );
  assert.equal(result.status, "compiled", JSON.stringify(result));
  assert.equal(valueOf(result, "plant_seed", "expectedTargetId"), "seed_as_she_remembered_it");
  assert.equal(valueOf(result, "plant_seed", "slot"), "3");
  assert.deepEqual(boundOf(result), [], "nothing was read, so nothing claims to have been");
  // AND THE ANSWER NAMES WHAT IT COULD NOT READ - for the readings whose value is still HERS. `plant_seed`'s two are not:
  // its body answers both, so a number she never had to write is not reported as one nothing checked.
  assert.deepEqual(result.status === "compiled" ? result.readingsUnmeasured : [], []);
  // An omission in that world is the missing-argument refusal FOR A READING THE BODY DOES NOT ANSWER FOR: the snapshot
  // cannot answer it and the Mod does not compute it, so accepting it would be a plan that fails once per node.
  const omitted = compile(
    `builder.fertilize_tile({ x: 4, y: 9, expectedQualifiedItemId: "(O)465" });`,
    bareSnapshot("fertilize_tile"),
  );
  assert.match(
    omitted.status === "refused" || omitted.status === "partial" ? omitted.reasonCode : "compiled",
    /^plan_script_missing_argument:fertilize_tile\.(slot|expectedTargetId):/u,
  );
  // THE PLANTING PAIR IS THE DECLARED EXCEPTION, in the same world: its body answers both readings, so the call compiles
  // and the node carries neither.
  const planted = compile(
    `builder.plant_seed({ x: 4, y: 9, expectedQualifiedItemId: "(O)472" });`,
    bareSnapshot("plant_seed"),
  );
  assert.equal(planted.status, "compiled", JSON.stringify(planted));
  assert.equal(valueOf(planted, "plant_seed", "expectedTargetId"), undefined, "the body answers it, nobody else did");
  assert.deepEqual(
    planted.status === "compiled" ? planted.readingsUnmeasured : [],
    [],
    "a value the body owns is not an unread one",
  );
});

/**
 * MEASURED-EMPTY IS A REFUSAL; UNMEASURED IS A STATEMENT - and the two used to be one answer.
 *
 * <p>
 * `planSnapshotRows` folded `undefined`, `null` and a MEASURED `[]` into `rows = []`, so the family that says "there is
 * no such target" and the family that was never published both left her number standing. The first is the shape the
 * plan pays for once per node (`seed_target_unavailable` twenty-two times in `round84`); the second is a number nothing
 * on this side can check, and the one answer it may not get is silence. The gate below drives both for every published
 * reading, and prints the population it examined.
 * </p>
 */
test("a_measured_empty_family_refuses_and_an_unmeasured_one_is_named:<action>.<argument>", () => {
  const faults: string[] = [];
  let measuredEmpty = 0;
  let unmeasured = 0;
  for (const action of PLAN_ACTIONS) {
    if (action.targetFamily === null) continue;
    const family = action.targetFamily;
    const readings = action.arguments.filter((argument) => PLAN_SNAPSHOT_READINGS.has(argument.name));
    if (readings.length === 0) continue;
    // (1) MEASURED, AND THE FAMILY HOLDS NOTHING: the target does not exist, so the call is refused by family and place.
    // THE ACTOR STANDS ON THE TILE, because a family's silence is a measurement only inside the Mod's discovery radius:
    // past it the family publishes nothing for any tile and the refusal is a different claim
    // (`plan_script_target_outside_the_read`, driven in `body-program-script.test.ts`).
    const empty = compile(
      callScript(action),
      snapshotCarrying({ ...bareSnapshot(action.actionId), tile: { ...ROW_TILE } }, family, []),
    );
    const code = empty.status === "compiled" ? "accepted" : empty.reasonCode;
    const prefix = `plan_script_target_not_in_the_submitted_snapshot:${family}:`;
    if (!code.startsWith(prefix)) faults.push(`${action.actionId}: a measured-empty ${family} answered ${code}`);
    else if (
      action.arguments.some((argument) => argument.name === "x") &&
      code !== `${prefix}${String(ROW_TILE.x)},${String(ROW_TILE.y)}`
    )
      faults.push(`${action.actionId}: the refusal names ${code.slice(prefix.length)} rather than the tile she wrote`);
    else measuredEmpty += 1;
    // (2) UNMEASURED: never refused, and the answer names every reading it could not read.
    const absent = compile(callScript(action), bareSnapshot(action.actionId));
    if (absent.status !== "compiled") {
      faults.push(`${action.actionId}: an unpublished ${family} answered ${absent.reasonCode}`);
      continue;
    }
    const expected = readings
      .filter((reading) => reading.required)
      .map((reading) => `unmeasured=${action.actionId}.${reading.name};family_not_published=${family}`);
    if (JSON.stringify(absent.readingsUnmeasured) !== JSON.stringify(expected))
      faults.push(
        `${action.actionId}: the answer named ${JSON.stringify(absent.readingsUnmeasured)} rather than ${JSON.stringify(expected)}`,
      );
    else unmeasured += 1;
  }
  console.log(
    `a_measured_empty_family_refuses_and_an_unmeasured_one_is_named: measured-empty ${String(measuredEmpty)} · unmeasured ${String(unmeasured)}`,
  );
  assert.ok(measuredEmpty > 20, `examined ${String(measuredEmpty)} actions with a measured-empty family`);
  assert.ok(unmeasured > 20, `examined ${String(unmeasured)} actions with an unpublished family`);
  assert.deepEqual(faults, [], faults.join("\n"));
});

/**
 * THE GATE: `a_reading_bound_from_the_submit_snapshot_does_not_refuse_a_reading_a_prior_node_makes`.
 *
 * <p>
 * THE PROPERTY. A reading is a value the model copies out of a snapshot. When the target does not exist YET because an
 * earlier node of the same program is about to make it (`till_soil(79,18)` then `plant_seed(79,18)`), the snapshot cannot
 * hold its row and refusing the plan makes the batch this product needs impossible as one plan. The Mod declares which
 * readings its BODY answers for at execution (`resolvedAtExecution`); this gate drives every derived argument through a
 * script whose first call addresses the same tile, against a snapshot whose family is MEASURED and holds a row at
 * another tile - which is exactly the condition that refused the pair.
 * </p>
 * <p>
 * POPULATION comes from the surface: every argument that is derived at all (a snapshot reading, or one the body answers
 * for), never a hand-written list. A reading the body does NOT answer for is excluded from the third count on purpose -
 * nobody can supply it, so refusing it there is the right answer and not this gate's business - and it stays in the
 * first two counts, so the exclusion is visible.
 * </p>
 */
test("a_reading_bound_from_the_submit_snapshot_does_not_refuse_a_reading_a_prior_node_makes:<action>.<argument>", () => {
  const census: Census3 = {
    derived: 0,
    submitBound: 0,
    afterPriorNode: 0,
    refused: [],
    tileless: [],
    tileUnproven: [],
  };
  for (const action of PLAN_ACTIONS) for (const argument of action.arguments) readOneDerived(action, argument, census);
  console.log(
    `a_reading_bound_from_the_submit_snapshot_does_not_refuse_a_reading_a_prior_node_makes: derived ${String(census.derived)} · ` +
      `bound-at-submit ${String(census.submitBound)} · bound-after-a-prior-node ${String(census.afterPriorNode)} · ` +
      `refused ${String(census.refused.length)} · tile-unproven ${String(census.tileUnproven.length)}`,
  );
  console.log(
    `  not measured here (a reading the body answers, on a tile nothing named): ${census.tileUnproven.join(", ")}`,
  );
  assert.ok(census.derived > 100, `examined ${String(census.derived)} derived arguments`);
  assert.ok(census.submitBound > 50, `examined ${String(census.submitBound)} readings the snapshot answered`);
  assert.ok(census.afterPriorNode > 0, "no reading was driven through a prior node, so this gate could not run");
  assert.deepEqual(
    census.refused,
    [],
    `the plan was refused for a reading a prior node makes: ${census.refused.join(", ")}`,
  );
});

/** What the gate counted, so its loop stays one shape rather than five counters in scope. */
type Census3 = {
  derived: number;
  submitBound: number;
  afterPriorNode: number;
  refused: string[];
  tileless: string[];
  /**
   * The subjects whose step was refused by a claim about the TILE - never by the reading this gate varies.
   *
   * <p>
   * A tile claim (`plan_script_target_outside_the_read`, or `plan_script_reading_outside_the_submitted_snapshot` naming
   * the action's OTHER argument) says nothing on this side named the tile, so the step cannot exist whatever the reading
   * a prior node makes. The premise this gate needs - a family that answers her tile - is absent there, so the subject is
   * NOT MEASURED by this gate and is printed by name rather than excused.
   * </p>
   */
  tileUnproven: string[];
};

/** One derived argument, driven twice: the ordinary submit-time binding, and the chain a prior node makes possible. */
function readOneDerived(
  action: PublishedPlanAction,
  argument: PublishedPlanAction["arguments"][number],
  census: Census3,
): void {
  const field = PLAN_SNAPSHOT_READINGS.get(argument.name);
  if (field === undefined && argument.required) return;
  census.derived += 1;
  if (
    field !== undefined &&
    boundOf(compile(callScript(action, [argument.name]), snapshotWith(action))).some((binding) =>
      binding.startsWith(`bound=${action.actionId}.${argument.name};`),
    )
  )
    census.submitBound += 1;
  // THE THIRD COUNT IS FOR THE ARGUMENTS THE BODY ANSWERS FOR: those are the ones a prior node can make readable.
  if (argument.required) return;
  const family = action.targetFamily;
  const subject = `${action.actionId}.${argument.name}`;
  if (family === null || !action.arguments.some((declared) => declared.name === "x")) {
    census.tileless.push(subject);
    return;
  }
  // The family is MEASURED and holds a row somewhere else - the exact shape that refused the pair.
  const elsewhere = snapshotCarrying(bareSnapshot(action.actionId), family, [
    rowAt(FAMILY_FIELDS.get(family) ?? [], { x: ROW_TILE.x + 30, y: ROW_TILE.y + 30 }),
  ]);
  const chained = compile(
    [
      `builder.till_soil({ x: ${String(ROW_TILE.x)}, y: ${String(ROW_TILE.y)}, charge: 0 });`,
      callScript(
        action,
        action.arguments.filter((declared) => !declared.required).map((declared) => declared.name),
      ),
    ].join("\n"),
    elsewhere,
  );
  const node = nodesOf(chained).find((candidate) => candidate.actionId === action.actionId);
  if (node === undefined) {
    // THE FIRST REFUSED CALL'S OWN CODE, which a `partial` plan carries exactly as a `refused` one does: what this gate
    // asks is WHICH claim it is, and "the step was dropped" answers nothing.
    const code = chained.status === "compiled" ? "the step was dropped" : chained.reasonCode;
    if (/^plan_script_(?:target_outside_the_read|reading_outside_the_submitted_snapshot):/u.test(code))
      census.tileUnproven.push(`${subject}:${code}`);
    else census.refused.push(`${subject}:${code}`);
    return;
  }
  if (node.arguments[argument.name] !== undefined) {
    census.refused.push(`${subject}:the node still carries a value nobody could observe`);
    return;
  }
  census.afterPriorNode += 1;
}

/**
 * THE FALSIFIER, spelled as the measured pair: `till_soil(79,18)` then `plant_seed(79,18)` in ONE script, with another
 * tilled tile on the farm - the fixture under which this refused with `plan_script_target_not_in_the_submitted_snapshot:
 * seedTargets:79,18` before the Mod declared the two readings its body answers for.
 */
test("till_soil then plant_seed on one tile is one plan, with another tilled tile on the farm", () => {
  const fields = FAMILY_FIELDS.get("seedTargets");
  assert.ok(fields !== undefined, "the Snapshot type publishes seedTargets");
  const farm = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [
    rowAt(fields, { x: 77, y: 18, slot: 11, targetId: "seed_41d8f0b6c9a2e573" }),
  ]);
  const chained = compile(
    [
      `builder.till_soil({ x: 79, y: 18, charge: 0 });`,
      `builder.plant_seed({ x: 79, y: 18, expectedQualifiedItemId: "(O)472" });`,
    ].join("\n"),
    farm,
  );
  assert.equal(chained.status, "compiled", JSON.stringify(chained));
  const plant = nodesOf(chained).find((node) => node.actionId === "plant_seed");
  assert.ok(plant !== undefined, "the planting step is in the program");
  assert.equal(
    plant.arguments.expectedTargetId,
    undefined,
    "the identity the plan could not observe is left for the body, not invented and not copied from another tile",
  );
  assert.equal(plant.arguments.slot, undefined, "and so is the slot, which the body re-resolves from the item");
  assert.deepEqual(
    chained.status === "compiled" ? chained.resolvedAfter : [],
    ["resolved_after=plant_seed.slot;producer=n01", "resolved_after=plant_seed.expectedTargetId;producer=n01"],
    "the answer says which step the value waits for",
  );
  // HER COPY OF A TILE THAT DID NOT EXIST YET IS NOT CARRIED: the row she remembers belongs to another world, and the
  // only value that can be true when the node runs is the one the body computes.
  const withHerCopy = compile(
    [
      `builder.till_soil({ x: 79, y: 18, charge: 0 });`,
      `builder.plant_seed({ x: 79, y: 18, slot: 11, expectedQualifiedItemId: "(O)472", expectedTargetId: "seed_deadbeefdeadbeef" });`,
    ].join("\n"),
    farm,
  );
  assert.equal(withHerCopy.status, "compiled", JSON.stringify(withHerCopy));
  assert.deepEqual(
    nodesOf(withHerCopy),
    nodesOf(chained),
    "her stale copy is dropped, so both scripts are one program",
  );
});

/**
 * THE GATE, over the whole published vocabulary: `a_defence_the_submitter_cannot_know_is_not_the_submitter's`.
 *
 * The population is the surface's own argument declarations crossed with the one place this product states which of them
 * are readings (`PLAN_SNAPSHOT_READINGS`), and the row each reading is answered from is the family the SURFACE declares
 * for the action, with the fields the `Snapshot` type publishes. Every reading is driven twice - once against a snapshot
 * holding the row, once against one that publishes the family and holds nothing - so "the compiler looked" is proven by
 * an outcome rather than by a sentence.
 */
test("a_defence_the_submitter_cannot_know_is_not_the_submitter's:every published argument", () => {
  const census: Census = { faults: [], undelivered: [], fingerprints: 0, derived: 0, intentions: 0 };
  for (const action of PLAN_ACTIONS) for (const argument of action.arguments) readOneArgument(action, argument, census);
  console.log(
    `a_defence_the_submitter_cannot_know_is_not_the_submitter's: fingerprints ${String(census.fingerprints)} · ` +
      `derived ${String(census.derived)} · still-the-model's ${String(census.intentions)}`,
  );
  console.log(`  undelivered, each named: ${census.undelivered.join(", ")}`);
  assert.ok(census.fingerprints > 100, `examined ${String(census.fingerprints)} fingerprint arguments`);
  assert.ok(census.intentions > 150, `examined ${String(census.intentions)} arguments the author must still state`);
  assert.ok(
    census.derived > 60,
    `the compiler bound ${String(census.derived)} of ${String(census.fingerprints)} readings`,
  );
  assert.ok(
    census.undelivered.some((entry) => entry.startsWith("plant_seed.")) === false,
    `the measured class must be delivered, not excused: ${census.undelivered.filter((e) => e.startsWith("plant_seed.")).join(", ")}`,
  );
  assert.deepEqual(census.faults, [], census.faults.join("\n"));
});

/** What one gate run counted, so the loop that fills it stays one shape rather than five counters in scope. */
type Census = {
  faults: string[];
  undelivered: string[];
  fingerprints: number;
  derived: number;
  intentions: number;
};

/** Why the compiler could not read one argument, in the surface's own terms - or `undefined` when it did read it. */
function unreadReason(action: PublishedPlanAction, field: string, familyFields: readonly string[]): string {
  if (action.targetFamily === null) return "the surface declares no target family";
  if (!familyFields.includes(field)) return `${action.targetFamily} publishes no \`${field}\``;
  return `no argument of hers names a field ${action.targetFamily} publishes`;
}

function readOneArgument(action: PublishedPlanAction, argument: DeclaredArgument, census: Census): void {
  const subject = `${action.actionId}.${argument.name}`;
  const field = PLAN_SNAPSHOT_READINGS.get(argument.name);
  if (field === undefined) {
    census.intentions += 1;
    return;
  }
  census.fingerprints += 1;
  const familyFields = action.targetFamily === null ? [] : (FAMILY_FIELDS.get(action.targetFamily) ?? []);
  const result = compile(callScript(action, [argument.name]), snapshotWith(action));
  // THE NEGATIVE, for every action at once: only a reading may ever be written by the compiler.
  for (const binding of boundOf(result)) {
    const named = binding.slice("bound=".length, binding.indexOf(";from=")).split(".")[1];
    if (named === undefined || !PLAN_SNAPSHOT_READINGS.has(named))
      census.faults.push(`${subject}: the compiler bound ${binding}, which is not a reading`);
  }
  // THE OUTCOME IS THE MEASUREMENT, not a prediction of it: the compiler either read the row or it did not.
  if (!boundOf(result).some((binding) => binding.startsWith(`bound=${action.actionId}.${argument.name};`))) {
    census.undelivered.push(`${subject}: ${unreadReason(action, field, familyFields)}`);
    return;
  }
  census.derived += 1;
  const expected = field === "slot" ? String(ROW_SLOT) : ROW_TARGET_ID;
  assert.equal(
    valueOf(result, action.actionId, argument.name),
    expected,
    `${subject}: the row publishes ${field}=${expected}`,
  );
  // AND WHEN THE PUBLISHED FAMILY HOLDS NO ROW AT HER TARGET, NOTHING IS ACCEPTED: the refusal is the whole point. The
  // actor stands on the tile so the family's silence IS a measurement - outside its radius the same silence is answered
  // by the other claim (`plan_script_target_outside_the_read`), which is not this gate's question.
  const elsewhere = snapshotCarrying(
    { ...bareSnapshot(action.actionId), tile: { ...ROW_TILE } },
    action.targetFamily!,
    [rowAt(familyFields, { x: 90, y: 90 })],
  );
  const refused = compile(callScript(action, [argument.name]), elsewhere);
  const code = refused.status === "compiled" ? "accepted" : refused.reasonCode;
  const namesTheAbsence = code.startsWith(`plan_script_target_not_in_the_submitted_snapshot:${action.targetFamily!}:`);
  if (!namesTheAbsence && code !== "accepted")
    census.faults.push(`${subject}: a snapshot holding other targets answered ${code}`);
}

/**
 * THE ROW A STEP NAMES IS ASKED ABOUT THE STEP, not only for its identity.
 *
 * <p>
 * MEASURED, `round87b` (2026-11-21, `.live-runs/game-ladder/2026-11-21T13-38-15-600Z-multiday_routine`), two programs
 * and 36 refusals, each of which the row her call named had already answered:
 * </p>
 * <ul>
 *   <li>`plan_39_a511ebcdc7723dd5` then `plan_57_8a8ea0ac773aab77`, 4.4 s apart, wrote the same `for (let x = 62; x <=
 *   79; x++) builder.till_soil({ x, y: 18, charge: 0 })` strip twice: 36 `till_soil` nodes, **36 refusals and not one
 *   success** - 30 `soil_already_tilled`, 4 `soil_not_diggable:occupied:object`, 2 `soil_not_diggable:not_map_diggable`.
 *   The row was tilled before either program ran, and `soilTiles` publishes exactly that fact as `hoeDirt`.</li>
 *   <li>`plan_27_05189350af1f1b0d` bought `(O)472` at `shop_23ea23e168822731` (PetAdoption's counter, the one the
 *   affordance list called "nearest") while `shopTargets` published nine counters with `stockItemIds`/`stockCount`, and
 *   the answer was `item_sold_by_another_counter ... sold_here_by=shop_d1821b85749a947f@4,17`. The right counter was in
 *   the snapshot the plan was composed from.</li>
 * </ul>
 * <p>
 * THE NEGATIVES ARE AS LOUD AS THE POSITIVES, because both of these are refusals a plan can be wrong about: a
 * `stockItemIds` the surface truncates at sixteen cannot refuse, a family the snapshot did not publish cannot refuse, a
 * counter in another room is not an address to send her to, and soil the row calls bare is not refused.
 * </p>
 */

/** One `shopTargets` row as the Mod publishes it, under the fields the `Snapshot` type declares. */
function shopRow(fields: readonly string[], overrides: Json): Json {
  return rowAt(fields, { location: "SeedShop", ownerInReach: true, ...overrides });
}

/** The measured pair: the counter she named sells pets, the one beside it sells seed. */
const PET_COUNTER = Object.freeze({
  targetId: "shop_23ea23e168822731",
  shopId: "PetAdoption",
  ownerName: "Marnie",
  ownerTileX: 11,
  ownerTileY: 20,
  stockCount: 2,
  stockItemIds: ["(O)600", "(O)601"],
});
const SEED_COUNTER = Object.freeze({
  targetId: "shop_d1821b85749a947f",
  shopId: "SeedShop",
  ownerName: "Pierre",
  ownerTileX: 4,
  ownerTileY: 17,
  stockCount: 58,
  stockItemIds: ["(O)472", "(O)473"],
});

const PURCHASE_AT_THE_PET_COUNTER = `builder.shop_purchase({ expectedTargetId: "shop_23ea23e168822731", expectedQualifiedItemId: "(O)472", quantity: 34 });`;

function shopSnapshot(...rows: readonly Json[]): Snapshot {
  const fields = FAMILY_FIELDS.get("shopTargets");
  assert.ok(fields !== undefined, "the Snapshot type publishes shopTargets");
  return snapshotCarrying(
    bareSnapshot("shop_purchase"),
    "shopTargets",
    rows.map((row) => shopRow(fields, row)),
  );
}

function refusalOf(result: CompiledPlan): string {
  return result.status === "compiled" ? "accepted" : result.reasonCode;
}

function refusalsOf(result: CompiledPlan): readonly Readonly<{ reasonCode: string }>[] {
  return result.status === "refused" || result.status === "partial" ? result.rejected : [];
}

/** Every refusal the script produced, including the ones past the bounded list `rejected` spells out. */
function refusalCountOf(result: CompiledPlan): number {
  return result.status === "refused" || result.status === "partial" ? result.rejectedCount : 0;
}

test("a counter the item is not sold at is refused before the walk, naming the counter that sells it", () => {
  const result = compile(PURCHASE_AT_THE_PET_COUNTER, shopSnapshot(PET_COUNTER, SEED_COUNTER));
  assert.equal(
    refusalOf(result),
    "plan_script_item_sold_by_another_counter:(O)472:sold_here_by=shop_d1821b85749a947f@4,17",
    "the refusal names the item and the counter in this room that carries it, in the vocabulary the body uses",
  );
  assert.deepEqual(nodesOf(result), [], "and no node is written, so the wrong counter is never walked to");
});

test("the counter that carries the item is accepted, and so is the same counter in another room", () => {
  const atTheSeedCounter = compile(
    `builder.shop_purchase({ expectedTargetId: "shop_d1821b85749a947f", expectedQualifiedItemId: "(O)472", quantity: 34 });`,
    shopSnapshot(PET_COUNTER, SEED_COUNTER),
  );
  assert.equal(refusalOf(atTheSeedCounter), "accepted", "her own call, unchanged");
  // A COUNTER THE ACTOR IS NOT STANDING IN IS NOT AN ADDRESS: the body's own code is `sold_here_by`, "another counter in
  // this room", and naming a shop across the map would send her on a walk she did not ask for.
  const elsewhere = shopSnapshot(PET_COUNTER, { ...SEED_COUNTER, location: "Farm" });
  assert.equal(refusalOf(compile(PURCHASE_AT_THE_PET_COUNTER, elsewhere)), "accepted");
});

test("a stock list the surface truncated cannot refuse, because absence from sixteen of fifty-eight is not absence", () => {
  // `stockItemIds` is capped at 16 per counter and `stockCount` carries the true number, so only a COMPLETE list can say
  // "this counter does not sell it". SeedShop's own row in the measured run was 58 items deep.
  const truncated = shopSnapshot(
    { ...PET_COUNTER, stockCount: 58 },
    { ...SEED_COUNTER, stockCount: 58, stockItemIds: ["(O)473"] },
  );
  assert.equal(
    refusalOf(compile(PURCHASE_AT_THE_PET_COUNTER, truncated)),
    "accepted",
    "a counter whose published stock is a truncation is answered by the body, not refused here",
  );
});

/**
 * The wallet and the unit price are BOTH on the wire now, so the purchase can be answered before the body moves.
 *
 * <p>
 * MEASURED, `round87b` (2026-11-21): `shop_purchase({ expectedQualifiedItemId: "(O)378", quantity: 15 })` was sent at 75g
 * a unit with 35g in hand, and the only answer the run got was the game's own refusal one walk and one menu later -
 * `insufficient_money ... price=75; available=35; short=40`. Nothing on the snapshot could have answered it: the wallet
 * was on no field at all, and `shopTargets` published what a counter sells without what it charges.
 * </p>
 * <p>
 * THE TWO HALVES OF THE GUARD ARE NOT SYMMETRIC. It fires only when BOTH the wallet (`snapshot.money`) and the row's own
 * price for the named item are measured, because a missing fact is `unmeasured` and unmeasured is not affordable - the
 * absence-as-pass shape this repository deletes. The boundary is the other direction: a purchase that costs EXACTLY the
 * wallet is one the game would take, so it stays in the plan.
 * </p>
 */

/** The counter and the wallet the measured refusal was made against: 75g a unit, 35g in hand. */
const COPPER_COUNTER = Object.freeze({
  targetId: "shop_d1821b85749a947f",
  shopId: "SeedShop",
  ownerName: "Pierre",
  ownerTileX: 4,
  ownerTileY: 17,
  stockCount: 1,
  stockItemIds: ["(O)378"],
  stockPrices: [{ qualifiedItemId: "(O)378", price: 75 }],
});

const BUY_FIFTEEN_COPPER = `builder.shop_purchase({ expectedTargetId: "shop_d1821b85749a947f", expectedQualifiedItemId: "(O)378", quantity: 15 });`;

/** The rows plus the wallet the snapshot publishes beside them; `undefined` leaves the wallet unmeasured. */
function shopSnapshotWithMoney(money: number | undefined, ...rows: readonly Json[]): Snapshot {
  const base = shopSnapshot(...rows);
  return money === undefined ? base : Object.assign({}, base, { money });
}

test("the round87b purchase is refused at submit time, naming the total and the wallet it exceeds", () => {
  const result = compile(BUY_FIFTEEN_COPPER, shopSnapshotWithMoney(35, COPPER_COUNTER));
  assert.equal(refusalOf(result), "plan_script_unaffordable_purchase:(O)378:75x15=1125>money:35");
  assert.deepEqual(nodesOf(result), [], "and no node is written, so she does not walk to the counter to be refused");
});

test("a purchase that costs exactly the wallet is accepted, because the game would take it", () => {
  assert.equal(refusalOf(compile(BUY_FIFTEEN_COPPER, shopSnapshotWithMoney(1125, COPPER_COUNTER))), "accepted");
  assert.equal(refusalOf(compile(BUY_FIFTEEN_COPPER, shopSnapshotWithMoney(1126, COPPER_COUNTER))), "accepted");
});

test("an unmeasured wallet is not an affordable one, and neither is an unmeasured price", () => {
  assert.equal(
    refusalOf(compile(BUY_FIFTEEN_COPPER, shopSnapshotWithMoney(undefined, COPPER_COUNTER))),
    "accepted",
    "no wallet was published, so this compiler has nothing to compare and the body answers",
  );
  const unpriced = { ...COPPER_COUNTER, stockPrices: [{ qualifiedItemId: "(O)472", price: 20 }] };
  assert.equal(
    refusalOf(compile(BUY_FIFTEEN_COPPER, shopSnapshotWithMoney(35, unpriced))),
    "accepted",
    "the counter published prices, none of them for the item she named: an absent price is not a free one",
  );
  const { stockPrices: _stripped, ...olderCounter } = COPPER_COUNTER;
  assert.equal(
    refusalOf(compile(BUY_FIFTEEN_COPPER, shopSnapshotWithMoney(35, olderCounter))),
    "accepted",
    "a counter that publishes no prices at all is a counter this compiler cannot price",
  );
});

/** The measured strip: eighteen tiles on one row, every one of them already carrying hoe dirt. */
function tilledStrip(): Snapshot {
  const fields = FAMILY_FIELDS.get("soilTiles");
  assert.ok(fields !== undefined, "the Snapshot type publishes soilTiles");
  const rows: Json[] = [];
  for (let x = 62; x <= 79; x += 1) rows.push(rowAt(fields, { x, y: 18, hoeDirt: true }));
  return snapshotCarrying(bareSnapshot("till_soil"), "soilTiles", rows);
}

test("the tilled strip is refused at submit time, once per tile, instead of once per node in the body", () => {
  const script: string[] = [];
  for (let x = 62; x <= 79; x += 1) script.push(`builder.till_soil({ x: ${String(x)}, y: 18, charge: 0 });`);
  const result = compile(script.join("\n"), tilledStrip());
  assert.equal(result.status, "refused", JSON.stringify(result).slice(0, 400));
  assert.deepEqual(nodesOf(result), [], "not one till node is written over soil the row calls worked");
  const rejected = refusalsOf(result);
  assert.equal(refusalCountOf(result), 18, "every one of the eighteen calls is refused, not only the first");
  assert.deepEqual(
    rejected.map((call) => call.reasonCode),
    Array.from(
      { length: rejected.length },
      (_, index) => `plan_script_target_already_tilled:soilTiles:${String(62 + index)},18`,
    ),
    "each code names the family to re-read and the tile she named",
  );
});

test("bare soil is not refused, and a row that answers only where the tile is still leaves the answer to the body", () => {
  const fields = FAMILY_FIELDS.get("soilTiles");
  assert.ok(fields !== undefined, "the Snapshot type publishes soilTiles");
  const bare = snapshotCarrying(bareSnapshot("till_soil"), "soilTiles", [
    rowAt(fields, { x: 79, y: 18, hoeDirt: false }),
  ]);
  const tilled = compile(`builder.till_soil({ x: 79, y: 18, charge: 0 });`, bare);
  assert.equal(refusalOf(tilled), "accepted", "the row says the tile is bare, which is what tilling wants");
  // A Mod older than `hoeDirt` publishes the tile and no answer: not measured is not "already tilled".
  const unanswered = snapshotCarrying(bareSnapshot("till_soil"), "soilTiles", [{ x: 79, y: 18 }]);
  assert.equal(refusalOf(compile(`builder.till_soil({ x: 79, y: 18, charge: 0 });`, unanswered)), "accepted");
});

test("soil an earlier step in the same program clears is not refused for being worked", () => {
  const soilFields = FAMILY_FIELDS.get("soilTiles");
  const clearFields = FAMILY_FIELDS.get("clearHoeDirtTargets");
  assert.ok(soilFields !== undefined, "the Snapshot type publishes soilTiles");
  assert.ok(clearFields !== undefined, "the Snapshot type publishes clearHoeDirtTargets");
  const live = Object.assign(
    snapshotCarrying(bareSnapshot("till_soil"), "soilTiles", [rowAt(soilFields, { x: 79, y: 18, hoeDirt: true })]),
    { clearHoeDirtTargets: [rowAt(clearFields, { x: 79, y: 18, crop: false, ground: true })] },
  ) as Snapshot;
  const chained = compile(
    [
      `builder.clear_hoedirt({ x: 79, y: 18, slot: 12, expectedTargetId: "clear_hoedirt_0000000000000000" });`,
      `builder.till_soil({ x: 79, y: 18, charge: 0 });`,
    ].join("\n"),
    live,
  );
  assert.equal(
    chained.status,
    "compiled",
    "the row's hoeDirt is not the state this step finds: a step in this program takes it off first",
  );
});

test("till_soil then plant_seed on one bare tile is still one plan when the row is published", () => {
  const fields = FAMILY_FIELDS.get("soilTiles");
  assert.ok(fields !== undefined, "the Snapshot type publishes soilTiles");
  const live = snapshotCarrying(bareSnapshot("till_soil"), "soilTiles", [
    rowAt(fields, { x: 79, y: 18, hoeDirt: false }),
  ]);
  const chained = compile(
    [
      `builder.till_soil({ x: 79, y: 18, charge: 0 });`,
      `builder.plant_seed({ x: 79, y: 18, expectedQualifiedItemId: "(O)472" });`,
    ].join("\n"),
    live,
  );
  assert.equal(chained.status, "compiled", JSON.stringify(chained).slice(0, 600));
  assert.deepEqual(
    nodesOf(chained).map((node) => node.actionId),
    ["till_soil", "plant_seed"],
  );
});

// ---------------------------------------------------------------------------------------------------------------
// GATE `every_guarded_row_is_reached_by_the_action_that_addresses_it:<action>:<family>`
// ---------------------------------------------------------------------------------------------------------------
//
// THE SHAPE, THREE TIMES THIS WEEK: a guard asks a question the action never declared a reading for, so the guard never
// opens. It is one defect because the guard is worth nothing unless the step that triggers it can produce the thing the
// guard reads - and whether it can is decided by DECLARATIONS: the family the surface says an action's targets come from,
// the arguments that action declares, and the fields the family's rows publish. All three are outside this file (the
// surface artifact and the `Snapshot` type), so the population is derived from them rather than written here.
//
//   - `round83`, `already_equipped` 61 times: the equip guard asked the compile-time snapshot whether the tool was in hand,
//     while the hand had already been established by eight steps of the programme. One layer up from the rows, and fixed
//     where that reading lives (`state.heldSlot`, seeded once and moved on by every equip step;
//     `body-program-script.test.ts` "an equip step written for a tool the programme already has in hand is not written
//     twice" is the other half).
//   - `round87b`, 36 `till_soil` nodes and 36 refusals with no success: `PLAN_ITERATION_CONDITIONS.soilTiles` declares
//     `rowField: "hoeDirt"` and the recipe prints `if (soil.hoeDirt !== true)`, and the compiler rendered no guard at all
//     for it - so the declared condition was ASKED BY NOBODY (`coverage.unasked`).
//   - `round87b`, `item_sold_by_another_counter`: `shop_purchase`'s only address is `expectedTargetId`, a READING, and the
//     selection that skips readings found no row to select - so the counter's own stock was never asked. A reading-only
//     action is not refused here; it owes a witness that the row its id names is the row that answers (below).
//
// WHAT THIS GATE IS NOT: a requirement that every action declare a reading. `till_soil` names its row by the tile it
// already declares and owes nothing more, and adding an argument to an action to quiet a gate is the one thing a gate
// must not teach.

/** How a published action's own declarations reach the row of the family the surface says its targets come from. */
type RowReach =
  /** The tile: the pair of coordinates the action declares and the family's rows publish. */
  | "tile"
  /** The row-naming reading alone: the opaque id, which no intention can stand in for. */
  | "reading"
  /** Neither, so no guard over that family can ever open for a call this action writes. */
  | "none";

/** The two row fields a step's own coordinates name it by: the tile, in the vocabulary every receipt uses. */
const ROW_TILE_FIELDS = Object.freeze(["x", "y"] as const);

/**
 * The row-naming reading reads the field the row is identified by - one fact, one spelling, asserted once.
 *
 * `PLAN_ROW_IDENTITY` says which argument and which field; `PLAN_SNAPSHOT_READINGS` says which arguments are readings at
 * all. A pair that disagreed with that map would be a name the compiler copies and never binds.
 */
assert.equal(
  PLAN_SNAPSHOT_READINGS.get(PLAN_ROW_IDENTITY.argument),
  PLAN_ROW_IDENTITY.field,
  "the row-naming argument is a reading of the field the row is identified by",
);

function rowReachOf(action: PublishedPlanAction, family: string): RowReach {
  const published = FAMILY_FIELDS.get(family) ?? [];
  const declared = new Set(action.arguments.map((argument) => argument.name));
  if (ROW_TILE_FIELDS.every((field) => declared.has(field) && published.includes(field))) return "tile";
  if (declared.has(PLAN_ROW_IDENTITY.argument) && published.includes(PLAN_ROW_IDENTITY.field)) return "reading";
  return "none";
}

type GuardCoverage = Readonly<{
  /** (guarded family, action the surface addresses it with) pairs - the population this gate examined. */
  examined: number;
  /** Pairs whose action names the row by its tile, the reach both row-finding paths accept. */
  byTile: number;
  /** Pairs whose only reach is the row-naming reading - `<action>:<family>`, and each owes a witness below. */
  byReading: readonly string[];
  /** Pairs whose action names the row by nothing it declares: the guard can never open for their calls. */
  unreached: readonly string[];
  /** Declared row conditions no guard asks: `<family>:<rowField>`. */
  unasked: readonly string[];
  /** Guarded families no published action addresses: a refusal nobody can reach. */
  unaddressed: readonly string[];
  /** Declared conditions that owe no guard, because the family itself publishes only the rows that need the work. */
  notOwed: readonly string[];
  /** The families examined, printed so "0 unreached" cannot be read without knowing what was looked at. */
  families: readonly string[];
}>;

/**
 * The crossing: what the compiler guards, what the product declares a guard for, and what the actions can reach.
 *
 * Both sides are derived. `guarded` is the compiler's own guard population (`PLAN_GUARDED_FAMILIES`, taken from the rules
 * it really renders) and `conditions` is `PLAN_ITERATION_CONDITIONS` - so a family joins this gate by having a guard
 * rendered or a condition declared, not by appearing in a list here. The actions come from the surface's `targetFamily`
 * and their arguments from the surface's own declarations; the row fields come from the `Snapshot` type. Both tables are
 * parameters so the red cases below can be driven with them taken away, which is the state the compiler was in.
 */
function planGuardCoverage(
  actions: readonly PublishedPlanAction[],
  guarded: readonly string[] = PLAN_GUARDED_FAMILIES,
  conditions: Readonly<Record<string, PlanIterationCondition>> = PLAN_ITERATION_CONDITIONS,
): GuardCoverage {
  const asked = Object.entries(conditions).flatMap(([family, condition]) =>
    "rowField" in condition ? [[family, condition.rowField] as const] : [],
  );
  const families = [...new Set([...guarded, ...asked.map(([family]) => family)])].sort();
  const byReading: string[] = [];
  const unreached: string[] = [];
  let examined = 0;
  let byTile = 0;
  for (const family of families)
    for (const action of actions.filter((candidate) => candidate.targetFamily === family)) {
      examined += 1;
      const reach = rowReachOf(action, family);
      if (reach === "tile") byTile += 1;
      else if (reach === "reading") byReading.push(`${action.actionId}:${family}`);
      else
        unreached.push(
          `${action.actionId}:${family}:names-the-row-by-nothing-it-declares:declares:${action.arguments
            .map((argument) => argument.name)
            .join(",")}:the-row-is-named-by:${ROW_TILE_FIELDS.join(",")}-or-${PLAN_ROW_IDENTITY.argument}`,
        );
    }
  return Object.freeze({
    examined,
    byTile,
    byReading: Object.freeze(byReading.sort()),
    unreached: Object.freeze(unreached.sort()),
    unasked: Object.freeze(
      asked.filter(([family]) => !guarded.includes(family)).map(([family, field]) => `${family}:${field}`),
    ),
    unaddressed: Object.freeze(
      families.filter(
        (family) => guarded.includes(family) && !actions.some((action) => action.targetFamily === family),
      ),
    ),
    notOwed: Object.freeze(
      Object.entries(conditions)
        .filter(([, condition]) => !("rowField" in condition))
        .map(([family]) => family)
        .sort(),
    ),
    families: Object.freeze(families),
  });
}

/**
 * What a reading-only action owes: proof that the row its id names is the row that answers it.
 *
 * The two compiles are the whole assertion and neither is family-specific. WITH the row her id names, the call is refused
 * for something that row says; WITHOUT that row - the family published, the id naming nothing - the same call is
 * accepted, because no rule ran. That pair is what distinguishes "the reading named a row and the row was asked" from
 * "the reading was skipped and the guard never opened", which is `round87b`'s counter exactly.
 */
type ReadingRowWitness = Readonly<{ with: () => CompiledPlan; without: () => CompiledPlan }>;

const READING_ROW_WITNESS: Readonly<Record<string, ReadingRowWitness>> = Object.freeze({
  "shop_purchase:shopTargets": Object.freeze({
    with: () => compile(PURCHASE_AT_THE_PET_COUNTER, shopSnapshot(PET_COUNTER, SEED_COUNTER)),
    without: () => compile(PURCHASE_AT_THE_PET_COUNTER, shopSnapshot(SEED_COUNTER)),
  }),
});

/** An action the surface does not publish, built from one it does: the shape a new member arrives in. */
function probeAction(actionId: string, targetFamily: string, argumentNames: readonly string[]): PublishedPlanAction {
  const base = PLAN_ACTIONS.find((action) => action.actionId === "till_soil");
  assert.ok(base !== undefined, "the surface publishes till_soil");
  return {
    ...base,
    actionId,
    targetFamily,
    arguments: Object.freeze(
      argumentNames.map((name) => ({
        name,
        type: PLAN_SNAPSHOT_READINGS.has(name) ? "string" : "integer",
        required: true,
      })),
    ),
  };
}

test("every_guarded_row_is_reached_by_the_action_that_addresses_it:<action>:<family>", () => {
  const coverage = planGuardCoverage(PLAN_ACTIONS);
  console.log(
    "every_guarded_row_is_reached_by_the_action_that_addresses_it: guards examined " +
      `${String(coverage.examined)} · ` +
      `ask-a-declared-reading ${String(coverage.examined - coverage.unreached.length)} · ` +
      `ask-an-undeclared-one ${String(coverage.unreached.length)} · by-tile ${String(coverage.byTile)} · ` +
      `by-reading ${String(coverage.byReading.length)} (${coverage.families.join(", ")}) · ` +
      `owes-no-guard ${coverage.notOwed.join(", ")}`,
  );
  // Refuse to pass on nothing: a gate whose population is empty agrees with every assertion below, and says so.
  assert.ok(
    coverage.examined > 0,
    `blocked: no published action addresses a guarded family (${coverage.families.join(", ") || "none"}), so this gate examined nothing`,
  );
  assert.deepEqual(
    coverage.unreached,
    [],
    "these actions address a family the compiler asks about the step, by no argument the row-finding accepts, so the guard can never open for them",
  );
  assert.deepEqual(
    coverage.unasked,
    [],
    "the product declares a row condition for these families and the compiler renders no guard for it, which is `round87b`'s 36 tills",
  );
  assert.deepEqual(
    coverage.unaddressed,
    [],
    "the compiler asks a question about these families and no published action addresses one, so the guard is a refusal nobody can reach",
  );
  // The third case's own half: a reading reaches a row only through the row-naming path, so every member owes the proof,
  // and a witness outliving its member is red - the assertion expires with the action it was written for.
  assert.deepEqual(
    coverage.byReading.filter((member) => READING_ROW_WITNESS[member] === undefined),
    [],
    "a row-naming READING is not an intention, so an action whose only address is one owes proof that the row it names is the row that answers",
  );
  assert.deepEqual(
    Object.keys(READING_ROW_WITNESS)
      .filter((member) => !coverage.byReading.includes(member))
      .sort(),
    [],
    "a witness for an action that no longer needs one is a proof of a shape that is gone",
  );
  for (const member of coverage.byReading) {
    const witness = READING_ROW_WITNESS[member]!;
    assert.equal(
      refusalOf(witness.with()) === "accepted",
      false,
      `${member}: the row the reading names is asked about the step, so it can refuse it`,
    );
    assert.equal(
      refusalOf(witness.without()),
      "accepted",
      `${member}: and with that row absent the same call is accepted, so the refusal came from the row the reading named`,
    );
  }
});

test("every_guarded_row_is_reached_by_the_action_that_addresses_it is red on the shape, and names it", () => {
  // THE DECLARED CONDITION NOBODY ASKS: `fe435971`, the tree before the row guard existed. `soilTiles` declared
  // `rowField: "hoeDirt"`, the recipe printed the guard, `till_soil` addressed the family - and no rule read the row, so
  // the 36 tills of `round87b` were written over ground the snapshot said was worked. One entry, one field, one family.
  assert.deepEqual(
    planGuardCoverage(PLAN_ACTIONS, [], PLAN_ITERATION_CONDITIONS).unasked,
    ["soilTiles:hoeDirt"],
    "a declared row condition with no guard asking it is red by family and field, which is the tree before the fix",
  );
  // THE ACTION THAT NAMES ITS ROW BY NOTHING: two actions the surface does not publish, one per shape the gate names.
  const probes = [
    probeAction("probe_charge_only", "soilTiles", ["charge"]),
    probeAction("probe_item_only", "shopTargets", ["expectedQualifiedItemId", "quantity"]),
    probeAction("probe_tile", "soilTiles", ["x", "y"]),
    probeAction("probe_reading_only", "shopTargets", ["expectedTargetId"]),
  ];
  const coverage = planGuardCoverage([...PLAN_ACTIONS, ...probes]);
  const probeIds = new Set(probes.map((probe) => probe.actionId));
  const ofProbes = (entries: readonly string[]): readonly string[] =>
    entries.filter((entry) => probeIds.has(entry.slice(0, entry.indexOf(":"))));
  assert.deepEqual(
    ofProbes(coverage.unreached),
    [
      "probe_charge_only:soilTiles:names-the-row-by-nothing-it-declares:declares:charge:the-row-is-named-by:x,y-or-expectedTargetId",
      "probe_item_only:shopTargets:names-the-row-by-nothing-it-declares:declares:expectedQualifiedItemId,quantity:the-row-is-named-by:x,y-or-expectedTargetId",
    ],
    "an action that addresses a guarded family by arguments none of which name a row is named with its family and what would fix it",
  );
  // The population grows by what was added to it, not to a number this file remembers: a guard family the compiler gains
  // later, or a published action that starts addressing one, moves these counts without an edit here.
  const shipped = planGuardCoverage(PLAN_ACTIONS);
  assert.equal(
    coverage.examined,
    shipped.examined + probes.length,
    "every probe addresses a family the compiler guards, so every probe is one more pair examined",
  );
  // THE TILE IS A DECLARED READING, NOT A GAP: `till_soil` by tile owes no `expectedTargetId`, which is the trap this
  // gate must not fall into - adding an argument to an action to quiet a gate is a change to the surface, not a fix.
  assert.equal(
    coverage.byTile,
    shipped.byTile + 1,
    "the probe written as a tile joins the reach the shipped actions already have, and is not asked for more",
  );
  // THE READING-ONLY MEMBER WITH NO WITNESS: `shop_purchase` as it was while the row-finding skipped readings.
  assert.deepEqual(
    ofProbes(coverage.byReading),
    ["probe_reading_only:shopTargets"],
    "an action whose only address is the opaque id is a member of its own population, not a pass",
  );
  assert.ok(
    coverage.byReading.includes("shop_purchase:shopTargets"),
    "and the shipped reading-only action is in the same population, which is the half that owes a witness",
  );
  assert.deepEqual(
    ofProbes(coverage.byReading).filter((member) => READING_ROW_WITNESS[member] === undefined),
    ["probe_reading_only:shopTargets"],
    "and a member without a witness is what the gate refuses by name",
  );
  // And an empty world is blocked rather than green: no action, no pair, nothing asserted - and the guards that are left
  // with nobody to open them are named, not quietly skipped.
  const nothing = planGuardCoverage([]);
  assert.equal(nothing.examined, 0, "no published action addresses a guarded family");
  assert.deepEqual(
    nothing.unaddressed,
    [...PLAN_GUARDED_FAMILIES],
    "a guard no action can reach is red by family, which is why the gate refuses to pass on an empty population",
  );
});
