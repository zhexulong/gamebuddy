import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  type CompiledPlan,
  compilePlanScript,
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
 */
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
    const body = block.slice(match.index + match[0].length, rowEnd);
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
 * A TILE THE SUBMITTED SNAPSHOT DOES NOT HOLD IS REFUSED THERE, not twenty-two times in the body. The refusal names the
 * family she should re-read and the tile she named, and it costs only the call that named it.
 */
test("a target the snapshot does not hold is refused by name at submit time, and only that call", () => {
  const fields = FAMILY_FIELDS.get("seedTargets")!;
  const live = snapshotCarrying(bareSnapshot("plant_seed"), "seedTargets", [rowAt(fields, { x: 79, y: 18 })]);
  const result = compile(
    [
      `builder.plant_seed({ x: 79, y: 18, expectedQualifiedItemId: "(O)472" });`,
      `builder.plant_seed({ x: 81, y: 40, expectedQualifiedItemId: "(O)472" });`,
    ].join("\n"),
    live,
  );
  assert.equal(result.status, "partial", JSON.stringify(result));
  assert.equal(
    result.status === "partial" ? result.reasonCode : "compiled",
    "plan_script_target_not_in_the_submitted_snapshot:seedTargets:81,40",
    "the refusal names the family to re-read and the tile she named",
  );
  assert.deepEqual(
    nodesOf(result).map((node) => node.arguments.x),
    [{ type: "integer", canonicalValue: "79" }],
    "the step whose target IS in the snapshot still runs",
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
    const empty = compile(callScript(action), snapshotCarrying(bareSnapshot(action.actionId), family, []));
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
  const census: Census3 = { derived: 0, submitBound: 0, afterPriorNode: 0, refused: [], tileless: [] };
  for (const action of PLAN_ACTIONS) for (const argument of action.arguments) readOneDerived(action, argument, census);
  console.log(
    `a_reading_bound_from_the_submit_snapshot_does_not_refuse_a_reading_a_prior_node_makes: derived ${String(census.derived)} · ` +
      `bound-at-submit ${String(census.submitBound)} · bound-after-a-prior-node ${String(census.afterPriorNode)} · ` +
      `refused ${String(census.refused.length)}`,
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
    census.refused.push(`${subject}:${chained.status === "refused" ? chained.reasonCode : "the step was dropped"}`);
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
  // AND WHEN THE PUBLISHED FAMILY HOLDS NO ROW AT HER TARGET, NOTHING IS ACCEPTED: the refusal is the whole point.
  const elsewhere = snapshotCarrying(bareSnapshot(action.actionId), action.targetFamily!, [
    rowAt(familyFields, { x: 90, y: 90 }),
  ]);
  const refused = compile(callScript(action, [argument.name]), elsewhere);
  const code = refused.status === "compiled" ? "accepted" : refused.reasonCode;
  const namesTheAbsence = code.startsWith(`plan_script_target_not_in_the_submitted_snapshot:${action.targetFamily!}:`);
  if (!namesTheAbsence && code !== "accepted")
    census.faults.push(`${subject}: a snapshot holding other targets answered ${code}`);
}
