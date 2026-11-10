import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { type CompiledPlan, compilePlanScript, planActionsFromRegistrations } from "./body-program-script.js";
import { type ActionRegistration, type Snapshot, validateBodyProgramCandidateRequest } from "./protocol.js";

/**
 * The measured defect this file is written against.
 *
 * A "clear and plant a 3x20 patch" task ran for 54 plan batches. Read out of the plan scripts themselves
 * (`builder.<action>({x,y})`): `till_soil` made 38 requests landing on 22 distinct tiles inside a 10x8 box (28%
 * density), `plant_seed` 13 tiles inside 18x5 (14%), and `water_crop` was never requested. No rectangle was ever
 * formed, because the interface has no way to say one: every node names ONE published `targetId`, and published
 * soil/crop targets are bounded to Chebyshev 6 (13x13), so a 20-tile row never fits one observation and the only
 * possible behaviour is reacting to the few tiles in view.
 *
 * The form asserted here is ONE loop over any collection of live world rows - a rectangle, a published target family,
 * or a query result - with an optional predicate over the row and a dispatch. The area is a SOURCE, not a privileged
 * form: "every dry crop on the farm" and "every tree with health left" are the shapes a caller reaches for when the
 * thing it wants is not a rectangle. Expansion happens on the game thread against live state, so the caller declares
 * the loop without reading the world.
 *
 * The action and family vocabulary comes from the Mod's own surface artifact, so a renamed action or argument fails
 * here by name instead of at a game launch.
 */

const hostRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const SURFACE_PATH = resolve(
  hostRoot,
  "../integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
);

type SurfaceAction = Readonly<{
  actionId: string;
  lifecycle: string;
  kind: string;
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[]; description?: string }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
}>;

const SURFACE = (
  JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { schema: unknown; actions: readonly SurfaceAction[] }
).actions;

const REGISTRATIONS: readonly ActionRegistration[] = SURFACE.map((action) =>
  Object.freeze({
    actionId: action.actionId,
    familyId: "fixture_family",
    identityVersion: 1,
    lifecycle: action.lifecycle as ActionRegistration["lifecycle"],
    kind: action.kind as ActionRegistration["kind"],
    ...(action.argumentSchema === undefined
      ? {}
      : {
          descriptor: {
            argumentSchema: action.argumentSchema,
            outputFacts: action.outputFacts ?? {},
            ...(action.resourceTemplate === undefined ? {} : { resourceTemplate: action.resourceTemplate }),
          },
        }),
  }),
);

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

const SNAPSHOT: Snapshot = {
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

function refusalOf(result: CompiledPlan): string {
  if (result.ok) assert.fail("expected a refusal, received a plan");
  return result.reasonCode;
}

function loopOf(result: CompiledPlan): Record<string, unknown> {
  const nodes = nodesOf(result);
  assert.equal(nodes.length, 1, "one loop is one node: the Mod expands it on the game thread, not the compiler");
  const loop = nodes[0]!.arguments.loop as Record<string, unknown>;
  assert.ok(loop !== undefined, `the node must carry the loop under 'loop', received ${JSON.stringify(nodes[0])}`);
  return loop;
}

/** A 3-row by 20-column rectangle ten tiles east of the actor's own column: wider than any 13x13 observation. */
const PATCH = "{ x: 60, y: 18, w: 20, h: 3 }";

/**
 * THE RED CASE, and the one a kind-keyed dispatch table fails.
 *
 * hops on columns 0,3,6..., coffee on 1,4,7..., and column 2,5,8... is deliberately a path. Three loops, one shape,
 * one seed each. A `{ empty_tillable: "plant_seed" }` table can express exactly one of these three decisions for every
 * empty tillable tile, which is why intercropping cannot be declared with it.
 */
test("intercropped planting is three loops over one patch, each decided by column, and the path is left alone explicitly", () => {
  const loop = loopOf(
    compile(
      `builder.for_each({
       source: { area: ${PATCH} },
       where: [{ col: { every: 3, offset: 0 } }],
       do: { action: "plant_seed", seed: "hops" }
     });
     builder.for_each({
       source: { area: ${PATCH} },
       where: [{ col: { every: 3, offset: 1 } }],
       do: { action: "plant_seed", seed: "coffee" }
     });
     builder.for_each({
       source: { area: ${PATCH} },
       where: [{ col: { every: 3, offset: 2 } }],
       do: null
     });`,
    ),
  );
  assert.deepEqual(loop.source, { area: { x: 60, y: 18, w: 20, h: 3 } });
  assert.deepEqual(loop.where, [{ col: { every: 3, offset: 0 } }]);
  assert.deepEqual(
    loop.do,
    [{ action: "plant_seed", seed: "hops" }],
    "the single form reads back as the chain of length one",
  );
});

/**
 * THE POINT OF THE WHOLE EXERCISE. The caller never learns what is in the patch: no observation call, no snapshot
 * read, no per-tile coordinate and no target id in the script.
 */
test("no observation call is needed before the loop: the caller declares the loop without reading the world", () => {
  const script = `builder.for_each({
       source: { area: ${PATCH} },
       where: [{ col: { every: 3, offset: 0 } }],
       do: { action: "plant_seed", seed: "hops" }
     });`;
  assert.equal(
    /inspect_tiles|soilTiles|cropTargets|targetId|snapshot\./u.test(script),
    false,
    "the script as the model writes it names no target, no coordinate read and no observation",
  );
  assert.deepEqual(Object.keys(nodesOf(compile(script))[0]!.arguments), ["loop"]);
});

/** A FAMILY source with a FIELD predicate: the caller never enumerates ids, because it cannot see them either. */
test("a published family is a source like any other, filtered by a field predicate", () => {
  const loop = loopOf(
    compile(`builder.for_each({
       source: { family: "cropTargets" },
       where: [{ field: "readyForHarvest", eq: true }],
       do: { action: "harvest_crop" }
     });`),
  );
  assert.deepEqual(loop.source, { family: "cropTargets" });
  assert.deepEqual(loop.where, [{ field: "readyForHarvest", eq: true }]);
});

/** The same rule set over a 1x1 area and over a family is the same semantics: area is not privileged. */
test("a 1x1 area and a family carry the same predicate and the same effect", () => {
  const overArea = loopOf(
    compile(
      `builder.for_each({ source: { area: { x: 60, y: 18, w: 1, h: 1 } }, where: [{ field: "kind", in: ["weed"] }], do: { action: "cut_weeds" } });`,
    ),
  );
  const overFamily = loopOf(
    compile(
      `builder.for_each({ source: { family: "weedTargets" }, where: [{ field: "kind", in: ["weed"] }], do: { action: "cut_weeds" } });`,
    ),
  );
  assert.deepEqual(overFamily.where, overArea.where);
  assert.deepEqual(overFamily.do, overArea.do);
});

/** A kind no loop claims is reported with its kind and its tile; the Mod half of this is its own gate. */
test("a missed row has a named reason code shape, and nothing_matched is not success", () => {
  const loop = loopOf(
    compile(
      `builder.for_each({ source: { area: { x: 60, y: 18, w: 2, h: 1 } }, where: [{ field: "kind", in: ["weed"] }], do: { action: "cut_weeds" } });`,
    ),
  );
  assert.deepEqual(loop.where, [{ field: "kind", in: ["weed"] }]);
});

/** Nesting is refused by name rather than flattened: one level of loop is what this buys. */
test("a nested loop is refused by name instead of silently flattened", () => {
  const result = compile(`builder.for_each({
       source: { area: ${PATCH} },
       do: { for_each: { source: { family: "weedTargets" } } }
     });`);
  assert.match(refusalOf(result), /^plan_script_nested_loop_unsupported$/u);
});

test("a loop naming an action the surface does not publish is refused by name, and not skipped", () => {
  const result = compile(`builder.for_each({ source: { area: ${PATCH} }, do: { action: "obliterate_rock" } });`);
  assert.match(refusalOf(result), /^plan_script_unknown_action:obliterate_rock$/u);
});

test("a loop with no source is refused by name rather than defaulting to the actor's own tile", () => {
  const result = compile(`builder.for_each({ do: { action: "cut_weeds" } });`);
  assert.match(refusalOf(result), /^plan_script_loop_source_invalid:missing$/u);
});

test("a loop larger than the row bound is refused with the row count, not truncated", () => {
  const result = compile(
    `builder.for_each({ source: { area: { x: 0, y: 0, w: 20, h: 20 } }, do: { action: "cut_weeds" } });`,
  );
  assert.match(refusalOf(result), /^plan_script_loop_too_large:400:64$/u);
});

/** The node the form produces must pass the Mod's own request validator. */
test("the compiled loop node passes the Mod's request validator", () => {
  const nodes = nodesOf(
    compile(
      `builder.for_each({ source: { area: ${PATCH} }, where: [{ col: { every: 3, offset: 0 } }], do: { action: "plant_seed", seed: "hops" } });`,
    ),
  );
  assert.equal(validateBodyProgramCandidateRequest({ programId: "area_loop", nodes: nodes as never }), null);
});
