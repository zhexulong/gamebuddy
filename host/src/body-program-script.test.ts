import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_PLAN_NODES,
  type CompiledPlan,
  compilePlanScript,
  planActionsFromRegistrations,
  planProgramId,
  planShape,
  planWorkDescription,
} from "./body-program-script.js";
import { type ActionRegistration, type Snapshot, validateBodyProgramCandidateRequest } from "./protocol.js";

/**
 * The published surface is the authority for the builder's vocabulary, so this suite feeds the generator from
 * the Mod-owned artifact instead of hand-writing the actions it expects.
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
  postcondition?: Readonly<{ name?: string }>;
}>;

const SURFACE = (
  JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { schema: unknown; actions: readonly SurfaceAction[] }
).actions;

/** The same registrations the Mod publishes on hello_ack, rebuilt from the surface artifact. */
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

/** The surface's own declaration of one action's arguments, in the order the artifact lists them. */
function surfaceArguments(
  actionId: string,
): readonly Readonly<{ name: string; type: string; enum?: readonly string[]; description?: string }>[] {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} is on the published surface`);
  return Object.entries(action.argumentSchema ?? {}).map(([name, declared]) => ({
    name,
    type: declared.type,
    ...(declared.enum === undefined ? {} : { enum: declared.enum }),
    ...(declared.description === undefined ? {} : { description: declared.description }),
  }));
}

const ACTIONS = planActionsFromRegistrations(REGISTRATIONS);

const BASE_SNAPSHOT: Snapshot = {
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
};

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return { ...BASE_SNAPSHOT, ...overrides } as Snapshot;
}

const crop = (targetId: string, x: number, y: number) => ({
  targetId,
  x,
  y,
  cropId: "spring_onion",
  displayName: "Parsnip",
});

function compile(script: string, overrides: Partial<Snapshot> = {}): CompiledPlan {
  return compilePlanScript({ script }, { snapshot: snapshot(overrides), actions: ACTIONS });
}

function refusalOf(result: CompiledPlan): string {
  if (result.ok) assert.fail("expected a refusal");
  return result.reasonCode;
}

/** The action shape a refused builder call answered with, read from the result the materializer publishes. */
function requirementOf(result: CompiledPlan) {
  if (result.ok) assert.fail("expected a refusal");
  return result.requirement;
}

/** The resource claims the surface publishes for one action: the other half of a refusal's teaching payload. */
function surfaceClaims(actionId: string): readonly Readonly<{ key: string; value: string }>[] {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} is on the published surface`);
  return (action.resourceTemplate?.claims ?? []).map((claim) => ({ key: claim.key, value: claim.value }));
}

type PlanNode = Extract<CompiledPlan, { ok: true }>["program"]["nodes"][number];

function nodesOf(result: CompiledPlan): readonly PlanNode[] {
  if (!result.ok) assert.fail(`expected a plan, received ${result.reasonCode}`);
  return result.program.nodes;
}

const WATER_BY_DOOR = `
for (const crop of snapshot.cropTargets ?? []) {
  if (builder.isFull()) break;
  builder.move_to_tile({ x: crop.x, y: crop.y });
  builder.water_crop({ x: crop.x, y: crop.y, expectedTargetId: crop.targetId });
}
`;

test("a script's calls become one ordered program, chained in the order it wrote them", () => {
  const nodes = nodesOf(
    compile(WATER_BY_DOOR, {
      enabledActionIds: ["move_to_tile", "water_crop"],
      cropTargets: [crop("crop_01", 11, 10), crop("crop_02", 12, 11)],
    }),
  );
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["n01", "move_to_tile", []],
      ["n02", "water_crop", ["n01"]],
      ["n03", "move_to_tile", ["n02"]],
      ["n04", "water_crop", ["n03"]],
    ],
  );
  assert.deepEqual(nodes[1]!.arguments, {
    x: { type: "integer", canonicalValue: "11" },
    y: { type: "integer", canonicalValue: "10" },
    expectedTargetId: { type: "string", canonicalValue: "crop_01" },
  });
  assert.equal(nodes[1]!.bindings !== undefined && Object.keys(nodes[1]!.bindings).length, 0);
});

test("the program a script produced passes the real Body Program validator", () => {
  const result = compile(WATER_BY_DOOR, {
    enabledActionIds: ["move_to_tile", "water_crop"],
    cropTargets: [crop("crop_01", 11, 10)],
  });
  const nodes = nodesOf(result);
  assert.equal(
    validateBodyProgramCandidateRequest({ programId: planProgramId(11, nodes), nodes }),
    null,
    "the compiled program must be one the Mod accepts",
  );
});

test("the same script and snapshot compile to a byte-identical program and program id", () => {
  const overrides = { enabledActionIds: ["move_to_tile", "water_crop"], cropTargets: [crop("crop_01", 11, 10)] };
  const first = compile(WATER_BY_DOOR, overrides);
  const second = compile(WATER_BY_DOOR, overrides);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  if (!first.ok || !second.ok) assert.fail("both compiles must produce a plan");
  assert.equal(planProgramId(11, first.program.nodes), planProgramId(11, second.program.nodes));
  // A different plan over the same world is a DIFFERENT program: the id is content-addressed, so the second
  // plan cannot be answered as the first one's duplicate.
  assert.notEqual(
    planProgramId(11, first.program.nodes),
    planProgramId(11, nodesOf(compile(WATER_BY_DOOR, { ...overrides, cropTargets: [crop("crop_02", 13, 10)] }))),
  );
});

test("a script that reaches outside its sandbox is refused by name, and nothing is compiled", () => {
  for (const [script, name] of [
    ["await builder.move_to_tile({ x: 1, y: 1 });", "await"],
    ['const fs = require("node:fs");', "require"],
    ["const now = Date.now();", "Date"],
    ["const pick = Math.random();", "Math.random"],
    ["setTimeout(() => {}, 10);", "setTimeout"],
    ['return fetch("http://127.0.0.1");', "fetch"],
    ["return process.env;", "process"],
  ] as const)
    assert.equal(refusalOf(compile(script)), `plan_script_uses_forbidden:${name}`);
});

test("a plan is refused by name past the corruption bound, never truncated", () => {
  // The bound is 256, not 16. It is the READ-BACK corruption bound on a journal this product could have written, and it
  // was 16 - which is not a corruption bound at all: a 16-node plan is ordinary, so the writer's policy was being enforced
  // by the reader. A plan past this bound is refused by name rather than silently truncated, because a truncated plan would
  // be a companion that believes it did everything it wrote.
  const result = compile(
    `
for (let index = 0; index < ${MAX_PLAN_NODES + 1}; index++) builder.move_to_tile({ x: 10 + (index % 50), y: 10 });
`,
  );
  assert.equal(refusalOf(result), `plan_cap_exceeded:${MAX_PLAN_NODES + 1}`);
});

test("isFull() stops the script at the bound instead of being refused", () => {
  // `isFull` still exists - a script may legitimately want to stop - but it now answers a bound no ordinary plan reaches,
  // and the tool description no longer shows it, so a model writing a batch does not learn to police itself. Measured
  // 2026-10-31: 31 of 117 historical `plan_work` calls used it, because the only worked example in the description did.
  const nodes = nodesOf(
    compile(
      `
for (let index = 0; index < ${MAX_PLAN_NODES + 40}; index++) {
  if (builder.isFull()) break;
  builder.move_to_tile({ x: 10 + (index % 50), y: 10 });
}
`,
    ),
  );
  assert.equal(nodes.length, MAX_PLAN_NODES);
});

/**
 * `advance_day` rebuilds the world, so it is the LAST node a plan can carry.
 *
 * It walks the actor to its own bed and then runs the save/warp/day-start lifecycle, which discards the world every
 * later node was compiled against. A node written after it is a step aimed at a snapshot that no longer describes the
 * farm, so the Mod could only refuse it at runtime - the builder refuses it at the call that wrote it instead, and
 * names both actions so the author sees which line was wrong.
 */
test("a node compiled after advance_day is refused by name, at the call that wrote it", () => {
  const result = compile(`
builder.move_to_tile({ x: 12, y: 8 });
builder.advance_day();
builder.cut_weeds({ x: 12, y: 8, slot: 0, expectedTargetId: "debris_01" });
`);
  assert.equal(refusalOf(result), "plan_script_action_after_world_reset:cut_weeds:advance_day");
});

test("advance_day as the last node still compiles, and a menu-closing step is not terminal", () => {
  const ending = nodesOf(
    compile(`
builder.move_to_tile({ x: 12, y: 8 });
builder.advance_day();
`),
  );
  assert.deepEqual(
    ending.map((node) => node.actionId),
    ["move_to_tile", "advance_day"],
  );
  // Closing a menu changes nothing about the world, so watering a crop afterwards is a legal sequence and stays one.
  const afterMenu = nodesOf(
    compile(`
builder.dismiss_modal();
builder.water_crop({ x: 12, y: 8, expectedTargetId: "crop_01" });
`),
  );
  assert.deepEqual(
    afterMenu.map((node) => node.actionId),
    ["dismiss_modal", "water_crop"],
  );
});

/**
 * The terminal set is hand-declared because the surface publishes no "this rebuilds the world" property, so this test
 * keeps the rule honest against the one catalog fact that does exist: the `day_advanced` postcondition.
 *
 * It asks the compiler, not the list, so the assertion survives the set becoming derived: every surface action
 * declaring `day_advanced` must be refused as the step before another one, by the same named code. A second such
 * action fails HERE by name instead of silently escaping the rule.
 */
test("every action the surface declares day_advanced refuses a step written after it", () => {
  const dayAdvanced = SURFACE.filter((action) => action.postcondition?.name === "day_advanced").map(
    (action) => action.actionId,
  );
  assert.ok(dayAdvanced.length > 0, "the surface still declares the day_advanced postcondition");
  for (const actionId of dayAdvanced) {
    assert.equal(
      refusalOf(compile(`builder.${actionId}();\nbuilder.move_to_tile({ x: 11, y: 10 });`)),
      `plan_script_action_after_world_reset:move_to_tile:${actionId}`,
      `${actionId} declares day_advanced, so a plan may not write a node after it`,
    );
  }
});

test("a builder method generated from the published surface rejects a wrong, missing or non-canonical argument", () => {
  // `move_to_tile` declares exactly x and y. Every one of these is the mistake a script actually makes.
  assert.equal(
    refusalOf(compile("builder.move_to_tile({ x: 10, y: 10, expectedTargetId: 'nope' });")),
    "plan_script_unknown_argument:move_to_tile.expectedTargetId",
  );
  assert.equal(refusalOf(compile("builder.move_to_tile({ x: 10 });")), "plan_script_missing_argument:move_to_tile.y");
  assert.equal(
    refusalOf(compile("builder.move_to_tile({ x: '10', y: 10 });")),
    "plan_script_argument_not_canonical:move_to_tile.x",
  );
  // A real action that the Mod declares read-only has no method at all, and the refusal names it: a plan is made of
  // executions, and an observation is not a step the Mod can run.
  assert.equal(refusalOf(compile("builder.observe_scene({});")), "plan_script_unknown_action:observe_scene");
});

test("a builder method is generated for exactly the lifecycles the Mod's Body Program catalog admits", () => {
  const generated = ACTIONS.map((action) => action.actionId);
  for (const actionId of ["move_to_tile", "water_crop", "harvest_crop", "pickup_forage"])
    assert.ok(generated.includes(actionId), `${actionId} must be callable from a plan`);
  // `live_verified` is an admission, not a draft: the action really ran on the target game version and produced a
  // native receipt, so the Mod accepts it as a node. A Host gate that dropped it refused plans the Mod accepts, and
  // the companion then had no way to name those actions except one flat tool call per step.
  for (const actionId of ["clear_debris", "cut_weeds", "talk_to_npc", "express_emote"])
    assert.ok(generated.includes(actionId), `${actionId} is live-verified and must be callable from a plan`);
  // Every generated method's argument list is the surface's own declaration, name for name.
  const declared = new Map(
    SURFACE.map((action) => [action.actionId, Object.keys(action.argumentSchema ?? {})] as const),
  );
  for (const action of ACTIONS)
    assert.deepEqual(
      action.arguments.map((argument) => argument.name),
      declared.get(action.actionId),
    );
});

/**
 * The Mod's own Body Program catalog is the authority for what a node may name, so this test reads it rather than
 * restating it: whatever lifecycles the C# projection admits, the builder must generate, and whatever it refuses,
 * the builder must refuse. A future divergence between the two fails here instead of in a live run.
 */
const MOD_PROJECTION = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/BodyPrograms/FarmhandBodyProgramCatalogProjection.cs"),
  "utf8",
);
const MOD_LIFECYCLE_WIRE = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
  "utf8",
);

/** The enum-to-wire map the Mod publishes with, straight from its own source. */
const MOD_LIFECYCLE_VALUES: readonly string[] = [
  ...MOD_LIFECYCLE_WIRE.matchAll(/FarmhandActionLifecycle\.([A-Za-z]+) => "([a-z_]+)"/gu),
].map((match) => match[2] as string);

/** The lifecycles `FarmhandBodyProgramCatalogProjection.TryProject` admits, read from its own condition. */
function modAdmittedLifecycles(): readonly string[] {
  const at = MOD_PROJECTION.indexOf("if (source.Lifecycle != ");
  assert.notEqual(at, -1, "the Mod's lifecycle admission condition is in the source");
  const condition = MOD_PROJECTION.slice(at, MOD_PROJECTION.indexOf("{", at));
  const wire = new Map(
    [...MOD_LIFECYCLE_WIRE.matchAll(/FarmhandActionLifecycle\.([A-Za-z]+) => "([a-z_]+)"/gu)].map(
      (match) => [match[1], match[2]] as const,
    ),
  );
  return [...condition.matchAll(/FarmhandActionLifecycle\.([A-Za-z]+)\.ToWireValue\(\)/gu)].map((match) => {
    const lifecycle = wire.get(match[1] as string);
    assert.ok(lifecycle !== undefined, `${match[1]} has a wire value in the Mod's own map`);
    return lifecycle;
  });
}

const registrationWith = (lifecycle: string, actionId = "move_to_tile"): ActionRegistration => ({
  actionId,
  familyId: "movement_navigation",
  identityVersion: 1,
  lifecycle: lifecycle as ActionRegistration["lifecycle"],
  kind: "execution",
  descriptor: { argumentSchema: { x: { type: "integer" }, y: { type: "integer" } } },
});

test("the builder admits and refuses exactly the lifecycles the Mod's catalog does", () => {
  const admitted = modAdmittedLifecycles();
  assert.ok(admitted.length > 0, "the Mod's admission condition was read, not assumed");
  for (const lifecycle of admitted)
    assert.deepEqual(
      planActionsFromRegistrations([registrationWith(lifecycle)]).map((action) => action.actionId),
      ["move_to_tile"],
      `${lifecycle} is admitted by the Mod's Body Program catalog, so the builder must generate it`,
    );
  const refused = MOD_LIFECYCLE_VALUES.filter((lifecycle) => !admitted.includes(lifecycle));
  assert.ok(refused.length > 0, "the Mod refuses at least one lifecycle, so the refusal side is exercised");
  for (const lifecycle of refused)
    assert.deepEqual(
      planActionsFromRegistrations([registrationWith(lifecycle)]),
      [],
      `${lifecycle} is not a Body Program node the Mod accepts, so the builder must not generate it`,
    );
});

test("a script that swallows a builder refusal still fails the plan, and a clock or a throw is named", () => {
  // try/catch around the builder must not turn a refused step into a silently shorter plan.
  const swallowed = compile(`
try { builder.move_to_tile({ x: 10, y: 10, unexpected: 1 }); } catch (error) {}
builder.move_to_tile({ x: 11, y: 10 });
`);
  assert.equal(refusalOf(swallowed), "plan_script_unknown_argument:move_to_tile.unexpected");
  assert.equal(refusalOf(compile("throw new TypeError('nope');")), "plan_script_threw:TypeError");
  assert.equal(refusalOf(compile("while (true) {}")), "plan_script_timeout:50");
  assert.equal(refusalOf(compile("   ")), "plan_script_invalid");
  assert.equal(refusalOf(compile("const nothing = 1;")), "plan_script_empty");
});

/**
 * A script that does not compile is the one refusal no builder call can explain: `plan_script_threw:SyntaxError`
 * alone says something is wrong somewhere in eight kilobytes of script, which is the state a weak model cannot leave
 * in one turn. So the answer carries the engine's own words and the line they point at, in the script's own numbering.
 */
test("a script that throws answers with the engine's own message and the line it named", () => {
  const threwOf = (result: CompiledPlan) => {
    if (result.ok) assert.fail("expected a refusal");
    return result.threw;
  };
  const unparsed = compile("const steps = 2;\nbuilder.move_to_tile({ x: 10, y: 10 );");
  assert.equal(refusalOf(unparsed), "plan_script_threw:SyntaxError");
  assert.equal(threwOf(unparsed)?.line, 2, "the line is the script's own, not the wrapper's");
  assert.ok((threwOf(unparsed)?.message.length ?? 0) > 0, "the parser's own message reaches the caller");
  assert.notEqual(threwOf(unparsed)?.message, "SyntaxError", "the error's name is not an account of it");

  // A runtime throw is the same seam, and its message is the script's own text.
  const raised = compile("const steps = 2;\nthrow new TypeError('bad loop');");
  assert.equal(refusalOf(raised), "plan_script_threw:TypeError");
  assert.deepEqual(threwOf(raised), { message: "bad loop", line: 2 });

  // An unclosed group is reported at the wrapper's closing line, which is not a line of the script: the answer
  // says it has no line instead of naming one the companion would search for and not find.
  assert.equal(threwOf(compile("const steps = 2;\n}"))?.line, null);
  // A script that never ran has no account to give.
  assert.equal(threwOf(compile("   ")), undefined);
});

test("a plan with no snapshot refuses rather than compiling from nothing", () => {
  const result = compilePlanScript(
    { script: "builder.move_to_tile({ x: 1, y: 1 });" },
    { snapshot: null, actions: ACTIONS },
  );
  assert.equal(refusalOf(result), "plan_snapshot_unavailable");
});

test("the script cannot mutate the snapshot the Host handed it", () => {
  assert.equal(
    refusalOf(
      compile(
        `
snapshot.revision = 999;
builder.move_to_tile({ x: 10, y: 10 });
`,
      ),
    ),
    "plan_script_threw:TypeError",
  );
  assert.equal(snapshot().revision, 11, "the live snapshot object is untouched");
});

test("a destination selector argument is compiled in the typed shape the wire declares", () => {
  const nodes = nodesOf(compile("builder.navigate_to_destination({ destination: { kind: 'label', label: 'Mine' } });"));
  assert.deepEqual(nodes[0]!.arguments.destination, {
    type: "destination_selector",
    destination: { kind: "label", label: "Mine" },
  });
});

/**
 * The refusal is the teaching surface now that no per-action tool carries a schema: a builder call that names the wrong
 * argument, drops one, or supplies the wrong kind must answer with the action's OWN declared arguments - read back here
 * from the artifact, so a hand-written list cannot drift from what the Mod enforces.
 */
test("a refused builder call answers with the action id, its required argument names and their kinds", () => {
  const required = surfaceArguments("cut_weeds");
  assert.ok(required.length >= 2, "cut_weeds declares more than one argument");
  for (const script of [
    // Already the live failure: x and y supplied, the tool slot and the target id guessed at or omitted.
    "builder.cut_weeds({ x: 10, y: 10 });",
    "builder.cut_weeds({ x: 10, y: 10, slot: 3, expectedTargetId: 'weed_01', targetId: 'weed_01' });",
    "builder.cut_weeds({ x: 10, y: 10, slot: 'first', expectedTargetId: 'weed_01' });",
  ])
    assert.deepEqual(requirementOf(compile(script)), {
      actionId: "cut_weeds",
      requiredArguments: required,
      resourceClaims: surfaceClaims("cut_weeds"),
    });

  // A closed set travels with the argument that declares it, so the refusal can name the values a guess must be one of.
  const choice = requirementOf(compile("builder.respond_level_up({ choice: 'left' });"));
  assert.deepEqual(choice, {
    actionId: "respond_level_up",
    requiredArguments: surfaceArguments("respond_level_up"),
    resourceClaims: surfaceClaims("respond_level_up"),
  });
  assert.deepEqual(choice?.requiredArguments.find((argument) => argument.name === "choice")?.enum, [
    "confirm",
    "branch_a",
    "branch_b",
  ]);
});

/** `stardew_plan_shape` answers from this function, so its answer is the surface's own vocabulary, not a second copy. */
test("plan_shape names the surface's own arguments, output facts and resource claims for one action", () => {
  const cutWeeds = planShape(ACTIONS, { actionId: "cut_weeds" });
  assert.ok(cutWeeds.ok, "cut_weeds is a plannable action");
  assert.deepEqual(
    cutWeeds.actions.map((action) => action.actionId),
    ["cut_weeds"],
  );
  assert.deepEqual(
    cutWeeds.actions[0]!.arguments.map((argument) => argument.name),
    Object.keys(SURFACE.find((action) => action.actionId === "cut_weeds")!.argumentSchema ?? {}),
  );
  assert.deepEqual(cutWeeds.actions[0]!.arguments, surfaceArguments("cut_weeds"));

  const inspect = planShape(ACTIONS, { actionId: "machine_inspect" });
  assert.ok(inspect.ok);
  assert.deepEqual(inspect.actions[0]!.outputFacts, [{ name: "machine_target_id", type: "string" }]);
  assert.deepEqual(
    inspect.actions[0]!.resourceClaims,
    SURFACE.find((action) => action.actionId === "machine_inspect")!.resourceTemplate!.claims.map((claim) => ({
      key: claim.key,
      value: claim.value,
    })),
  );
});

test("plan_shape answers a whole family, and a selector that names nothing with what does exist", () => {
  const family = planShape(ACTIONS, { family: "fixture_family" });
  assert.ok(family.ok);
  assert.deepEqual(
    family.actions.map((action) => action.actionId),
    ACTIONS.map((action) => action.actionId),
  );

  assert.deepEqual(planShape(ACTIONS, {}), { ok: false, reasonCode: "plan_shape_selector_invalid" });
  assert.deepEqual(planShape(ACTIONS, { actionId: "cut_weeds", family: "fixture_family" }), {
    ok: false,
    reasonCode: "plan_shape_selector_invalid",
  });
  const unknown = planShape(ACTIONS, { actionId: "brew_potion" });
  assert.ok(!unknown.ok);
  assert.equal(unknown.reasonCode, "plan_shape_unknown_action:brew_potion");
  // The ids it offers are the vocabulary's own head, bounded: a wrong name teaches without spending the turn on all of it.
  assert.deepEqual(
    unknown.legalActionIds,
    ACTIONS.slice(0, 20).map((action) => action.actionId),
  );
  const unknownFamily = planShape(ACTIONS, { family: "brewing" });
  assert.ok(!unknownFamily.ok);
  assert.equal(unknownFamily.reasonCode, "plan_shape_unknown_family:brewing");
  assert.deepEqual(unknownFamily.legalFamilies, ["fixture_family"]);
});

/**
 * The companion used to guess the tool (`scythe` for weeds, `pickaxe` for rocks) and the slot from tool order, and got
 * ``cut_weeds`` right by luck and ``break_rock_source`` wrong. So the shape answer carries the tool the surface itself
 * declares - for every action, never omitted - and never invents one for an action whose surface is silent.
 */
test("plan_shape reports the tool the surface declares, and tool_requirement_undeclared when it declares none", () => {
  const withClaims = (actionId: string, claims: readonly Readonly<{ key: string; value: string }>[]) =>
    Object.freeze({
      actionId,
      familyId: "resource_gathering",
      identityVersion: 1,
      lifecycle: "live_verified" as const,
      kind: "execution" as const,
      descriptor: Object.freeze({
        argumentSchema: {
          x: { type: "integer" },
          y: { type: "integer" },
          slot: { type: "integer" },
          expectedTargetId: { type: "string" },
        },
        resourceTemplate: Object.freeze({ claims: Object.freeze(claims.map((claim) => Object.freeze(claim))) }),
      }),
    });
  const actions = planActionsFromRegistrations([
    // The Mod's own two words for the level half of a `tool:<category>` claim, verbatim from its claim value.
    withClaims("cut_weeds", [
      { key: "embodied_actor", value: "ScopePlayer" },
      { key: "tool:scythe", value: "AnyUpgrade" },
    ]),
    withClaims("break_rock_source", [
      { key: "embodied_actor", value: "ScopePlayer" },
      { key: "tool:pickaxe", value: "BasicOnly" },
    ]),
    // Declares its embodied actor and nothing about a tool: the surface is silent, and the answer says so by name.
    withClaims("chop_tree_source", [{ key: "embodied_actor", value: "ScopePlayer" }]),
    // A word the Host cannot translate is passed through as declared rather than dropped or guessed at.
    withClaims("dig_artifact_spot", [{ key: "tool:hoe", value: "SomeFutureWord" }]),
  ]);

  const shapeOf = (actionId: string) => {
    const shape = planShape(actions, { actionId });
    assert.ok(shape.ok, `${actionId} is plannable`);
    return shape.actions[0]!.toolRequirement;
  };
  assert.deepEqual(shapeOf("cut_weeds"), {
    declared: true,
    category: "scythe",
    upgradeRequirement: "AnyUpgrade",
    minimumUpgradeLevel: 0,
    maximumUpgradeLevel: null,
  });
  // "the basic one": the Mod refuses an upgraded pickaxe by name, so a bare `minimumUpgradeLevel` would be a lie.
  assert.deepEqual(shapeOf("break_rock_source"), {
    declared: true,
    category: "pickaxe",
    upgradeRequirement: "BasicOnly",
    minimumUpgradeLevel: 0,
    maximumUpgradeLevel: 0,
  });
  assert.deepEqual(shapeOf("chop_tree_source"), { declared: false, reasonCode: "tool_requirement_undeclared" });
  assert.deepEqual(shapeOf("dig_artifact_spot"), {
    declared: true,
    category: "hoe",
    upgradeRequirement: "SomeFutureWord",
    minimumUpgradeLevel: null,
    maximumUpgradeLevel: null,
  });

  // The tool is read off claims only: no category is ever fabricated from an action id. On the artifact's own
  // vocabulary each action answers with the `tool:<category>` claim it publishes, and the one that publishes none
  // answers `tool_requirement_undeclared` - the requirement is read from the surface, never invented from an action id.
  assert.ok(
    ACTIONS.some((action) => action.toolRequirement.declared),
    "the surface declares a tool on some action",
  );
  assert.ok(
    ACTIONS.some((action) => !action.toolRequirement.declared),
    "the surface is silent about a tool on some action",
  );
  for (const action of ACTIONS) {
    assert.ok("toolRequirement" in action, `${action.actionId} carries the field rather than omitting it`);
    const claim = surfaceClaims(action.actionId).find((candidate) => candidate.key.startsWith("tool:"));
    if (claim === undefined) {
      assert.deepEqual(
        action.toolRequirement,
        { declared: false, reasonCode: "tool_requirement_undeclared" },
        `${action.actionId} publishes no tool claim, so the answer is the surface's silence`,
      );
      continue;
    }
    const requirement = action.toolRequirement;
    assert.ok(requirement.declared, `${action.actionId} publishes ${claim.key}`);
    assert.equal(requirement.category, claim.key.slice("tool:".length));
    assert.equal(requirement.upgradeRequirement, claim.value);
  }
});

/**
 * "Is the scythe equipped" cannot be judged statically and the slot index cannot be guessed: the Mod publishes the held
 * tool and the pack's tool slots, so a script reads both from the snapshot it was handed instead of inventing a slot.
 */
test("a script reads the held tool and its slot from the snapshot instead of guessing a slot index", () => {
  // The surface's claim says WHICH tool (`tool:scythe`); the slot stays the actor's own state, read here from the
  // snapshot. Nothing is emitted on the plan for the requirement: the builder writes the call the script wrote.
  const nodes = nodesOf(
    compile(
      `
const held = snapshot.currentTool;
const slot = (snapshot.toolSlots ?? []).find((entry) => entry.label === held);
if (slot === undefined) throw new Error("held_tool_has_no_slot");
builder.cut_weeds({ x: snapshot.tile.x, y: snapshot.tile.y, slot: slot.slot, expectedTargetId: "weed_01" });
`,
      { currentTool: "(T)Scythe", toolSlots: [{ slot: 3, label: "(T)Scythe" }] },
    ),
  );
  assert.deepEqual(nodes[0]!.arguments.slot, { type: "integer", canonicalValue: "3" });
  // One node for one call: declaring the tool is what the surface does, and it is not a step of its own.
  assert.deepEqual(
    nodes.map((node) => node.actionId),
    ["cut_weeds"],
  );
});

/** A live ResourceClump target: where the surface lets the TARGET itself name the tool a hit needs. */
function debris(targetId: string, slot: number, toolKind: string) {
  return { targetId, slot, toolKind, requiredUpgradeLevel: 0, x: 11, y: 12, parentSheetIndex: 600, health: 2 };
}

const TOOL_PACK = [
  { slot: 0, label: "(T)Axe", upgradeLevel: 0 },
  { slot: 3, label: "(T)Pickaxe", upgradeLevel: 0 },
] as const;

test("a plan names a chest and one of the items inside it, out of the container's own state", () => {
  // The round trip the ruling is about: `chests` is entity state, and the two actions take their own safe slice out
  // of it - the container's published id and the item id. Nothing here flattens: the plan reads the container, then
  // decides.
  //
  // These arguments were `slot`, `x`, `y` and `expectedTargetId` until the container became an entity. The compiler
  // refused the old shape with `plan_script_unknown_argument:chest_retrieve.slot`, which is the correct answer and the
  // reason this assertion is worth keeping: it reads the catalog instead of restating a shape by hand.
  const nodes = nodesOf(
    compile(
      `
for (const chest of snapshot.chests ?? []) {
  if (builder.isFull()) break;
  for (const item of chest.items) {
    if (item.qualifiedItemId !== "(O)388") continue;
    builder.chest_retrieve({ chestId: chest.chestId, expectedQualifiedItemId: item.qualifiedItemId });
  }
}
`,
      {
        enabledActionIds: ["chest_retrieve"],
        chests: [
          {
            chestId: "chest_0123456789abcdef",
            x: 9,
            y: 10,
            displayName: "Chest",
            isFridge: false,
            items: [
              { slot: 0, qualifiedItemId: "(O)388", displayName: "Wood", stack: 40 },
              { slot: 1, qualifiedItemId: "(O)390", displayName: "Stone", stack: 7 },
            ],
          },
        ],
      },
    ),
  );
  assert.deepEqual(
    nodes.map((node) => node.actionId),
    ["chest_retrieve"],
  );
  // The node carries the container id and the item id, and nothing else: a tile and a pack slot were the flattened
  // shape's arguments, and the container is now the entity those two facts belong to.
  assert.deepEqual(nodes[0]!.arguments, {
    chestId: { type: "string", canonicalValue: "chest_0123456789abcdef" },
    expectedQualifiedItemId: { type: "string", canonicalValue: "(O)388" },
  });
  // The plan is one the Mod accepts, so the chest’s own id is a legal target id and not a shape only this compiler
  // would produce.
  assert.equal(
    validateBodyProgramCandidateRequest({ programId: planProgramId(11, nodes), nodes }),
    null,
    "the compiled plan must be one the Mod accepts",
  );
  // A script may see EVERY item a container holds: the mirror is not shortened on the way in, so a loop over
  // `chest.items` reaches the last one exactly as the Mod published it.
  const everyItem = nodesOf(
    compile(
      `
for (const chest of snapshot.chests ?? []) {
  for (const item of chest.items) {
    builder.move_to_tile({ x: chest.x + item.slot, y: chest.y });
  }
}
`,
      {
        enabledActionIds: ["move_to_tile"],
        chests: [
          {
            chestId: "chest_0123456789abcdef",
            x: 9,
            y: 10,
            displayName: "Chest",
            isFridge: false,
            items: Array.from({ length: MAX_PLAN_NODES }, (_, slot) => ({
              slot,
              qualifiedItemId: `(O)${100 + slot}`,
              displayName: `Item ${slot}`,
              stack: 1,
            })),
          },
        ],
      },
    ),
  );
  assert.equal(everyItem.length, MAX_PLAN_NODES, "every item of a container is visible to the script");
  assert.equal(
    JSON.stringify(everyItem[MAX_PLAN_NODES - 1]!.arguments.x),
    JSON.stringify({ type: "integer", canonicalValue: String(9 + MAX_PLAN_NODES - 1) }),
    "the last item of the container is reachable, so the mirror was not shortened",
  );
});

test("equipFor writes the equip step the target declares, then the action, and answers the slot to name", () => {
  const nodes = nodesOf(
    compile(
      `
for (const clump of snapshot.debrisTargets ?? []) {
  const slot = builder.equipFor('clear_debris', clump);
  builder.clear_debris({ slot, x: clump.x, y: clump.y, expectedTargetId: clump.targetId });
}
`,
      {
        currentTool: "(T)Axe",
        currentToolSlot: 0,
        toolSlots: TOOL_PACK,
        debrisTargets: [debris("debris_01", 3, "pickaxe")],
      },
    ),
  );
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["n01", "equip_tool", []],
      ["n02", "clear_debris", ["n01"]],
    ],
  );
  // The equip step carries a semantic category from equip_tool's own closed set, never the slot: the Mod resolves the
  // slot itself, so an index here would be a slot masquerading as a tool.
  assert.deepEqual(nodes[0]!.arguments, { tool: { type: "string", canonicalValue: "pickaxe" } });
  // The action names the target's OWN slot, which is the value equipFor answered.
  assert.deepEqual(nodes[1]!.arguments.slot, { type: "integer", canonicalValue: "3" });
  assert.equal(
    validateBodyProgramCandidateRequest({ programId: planProgramId(11, nodes), nodes }),
    null,
    "the compiled plan must be one the Mod accepts",
  );
});

test("equipFor emits nothing when the tool the target declares is already the held one", () => {
  const nodes = nodesOf(
    compile(
      `
for (const animal of snapshot.animalProductTargets ?? []) {
  const slot = builder.equipFor('collect_animal_product', animal);
  builder.collect_animal_product({ slot, x: animal.x, y: animal.y, expectedTargetId: animal.targetId });
}
`,
      {
        currentTool: "(T)MilkPail",
        currentToolSlot: 3,
        toolSlots: TOOL_PACK,
        animalProductTargets: [
          {
            targetId: "animal_product_01",
            slot: 3,
            x: 12,
            y: 9,
            animalType: "White Cow",
            qualifiedProduceItemId: "(O)184",
            displayName: "Cow Milk",
            toolKind: "milk_pail",
            produceStack: 1,
          },
        ],
      },
    ),
  );
  // No equip step: the tool is in hand, so the plan is the action alone and its slot is the held one.
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [["n01", "collect_animal_product", []]],
  );
  assert.deepEqual(nodes[0]!.arguments.slot, { type: "integer", canonicalValue: "3" });
});

/**
 * `cut_weeds` declares `tool:scythe` on the surface, so the helper must honour that claim. When the pack publishes the
 * category the slot is resolved and no equip step is written (the tool is in hand); when the pack publishes no
 * categories the refusal names the CATEGORY it could not resolve - never "requirement undeclared", which would be a
 * false statement about a claim the surface makes.
 */
test("equipFor resolves the declared category from the pack, and names the category when no slot publishes it", () => {
  // The scythe is already the held tool, so the call writes the action it was asked about and no equip step.
  const declared = compile(
    "const slot = builder.equipFor('cut_weeds'); builder.cut_weeds({ x: 5, y: 6, slot, expectedTargetId: 'weed_01' });",
    {
      currentToolSlot: 3,
      toolSlots: [
        { slot: 0, label: "(T)Axe", upgradeLevel: 0, category: "axe" },
        { slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" },
      ],
    },
  );
  assert.deepEqual(
    nodesOf(declared).map((node) => node.actionId),
    ["cut_weeds"],
  );

  // The axe is held instead, so the same call writes one equip step naming the category, then the action.
  const notHeld = compile(
    "const slot = builder.equipFor('cut_weeds'); builder.cut_weeds({ x: 5, y: 6, slot, expectedTargetId: 'weed_01' });",
    {
      currentToolSlot: 0,
      toolSlots: [
        { slot: 0, label: "(T)Axe", upgradeLevel: 0, category: "axe" },
        { slot: 3, label: "(W)47", upgradeLevel: 0, category: "scythe" },
      ],
    },
  );
  assert.deepEqual(
    nodesOf(notHeld).map((node) => node.actionId),
    ["equip_tool", "cut_weeds"],
  );

  // The pack is older than the claim: no slot says `scythe`, so the refusal names that, not the requirement.
  const packWithoutCategories = compile("builder.equipFor('cut_weeds');", {
    currentToolSlot: 0,
    toolSlots: TOOL_PACK,
  });
  assert.equal(refusalOf(packWithoutCategories), "plan_script_tool_slot_unresolved:cut_weeds:scythe");

  // A weed target declares no tool, so passing one cannot stand in for the claim either.
  assert.equal(
    refusalOf(
      compile("builder.equipFor('cut_weeds', snapshot.weedTargets[0]);", {
        weedTargets: [{ targetId: "weed_01", location: "Farm", x: 5, y: 6, health: 1 }],
      }),
    ),
    "plan_script_tool_slot_unresolved:cut_weeds:scythe",
  );
  // An id the vocabulary does not have answers with that name, and the host adds the ids it DOES have.
  assert.equal(refusalOf(compile("builder.equipFor('brew_potion');")), "plan_script_unknown_action:brew_potion");
});

test("a published argument description reaches the plan shape, because the Mod owns the meaning", () => {
  // Measured 2026-10-29: `PLAN_TOOL_SLOT_MEANING` said a `slot` is "never a backpack index". All thirteen actions that
  // take a `slot` read `Game1.player.Items[slot]` - it IS a backpack index - and three of them additionally require it
  // to equal `Farmer.CurrentToolIndex`. One Host-side sentence could not be true for both families, so the meaning now
  // travels per argument, from the handler that enforces it.
  const withDescription: readonly ActionRegistration[] = [
    Object.freeze({
      actionId: "cut_weeds",
      familyId: "resource_gathering",
      identityVersion: 1,
      lifecycle: "live_verified" as ActionRegistration["lifecycle"],
      kind: "execution" as ActionRegistration["kind"],
      descriptor: {
        arguments: [
          { name: "x", type: "integer" },
          { name: "y", type: "integer" },
          { name: "slot", type: "integer", description: "The TOOL's backpack slot, which must also be the held one." },
        ],
      },
    }),
  ];
  const [action] = planActionsFromRegistrations(withDescription);
  assert.ok(action, "the action is plannable");
  assert.deepEqual(
    action.arguments.map((argument) => argument.name),
    ["x", "y", "slot"],
  );
  assert.equal(
    action.arguments[2]?.description,
    "The TOOL's backpack slot, which must also be the held one.",
    "the Mod's own words for the argument survive into what a plan shape answers",
  );
  // An argument the surface does not describe stays UNDESCRIBED rather than becoming an empty string: absent is how a
  // surface says "the name is the whole story", and an empty description would be a label that says nothing.
  assert.equal(action.arguments[0]?.description, undefined);
  assert.equal("description" in (action.arguments[0] ?? {}), false);
});

test("the surface artifact carries a slot description for every action whose slot has a rule", () => {
  // The artifact is what the Mod publishes and the Host reads, so this is the one place the two sides are compared.
  // It fails by NAME when a `slot` argument loses its description, which is the drift the previous design could not
  // detect: a Host paragraph is not compared against anything.
  const slotActions = SURFACE.filter((action) => action.argumentSchema?.slot !== undefined);
  assert.ok(slotActions.length > 0, "the surface declares actions with a slot argument");
  const described = slotActions.filter((action) => (action.argumentSchema?.slot?.description ?? "").length > 0);
  assert.deepEqual(
    slotActions
      .filter((action) => (action.argumentSchema?.slot?.description ?? "").length === 0)
      .map((action) => action.actionId),
    [],
    "every action whose `slot` has a rule states that rule in its own words; an undescribed one is a guess the model makes",
  );
  assert.ok(described.length === slotActions.length);
});

/**
 * The plan tool's description must name exactly the actions this session publishes - and both directions of that
 * comparison are DERIVED, never hand-maintained.
 *
 * The defect the gate exists for is a description that says "every action you can take is a builder method" and names
 * none. Measured 2026-10-28 (`round6`): the companion reached 22:00 without dispatching `advance_day`, wrote goodnight
 * dialogue instead, and its own thinking recorded that it did not know the action was called and would not guess; the
 * engine passed it out at 02:00 onto a standing ShippingMenu. A name it can read costs nothing; a name one tool call
 * away is a round-trip it may decline to pay, and declining it degenerates to single steps or to dialogue.
 *
 * The published side is the Mod catalog: the surface artifact for ids, lifecycles, kinds and arguments, and the Mod's
 * own registration list for the family each action belongs to. The described side is read back out of the description
 * string production hands the model. A published action the description omits, a described id the catalog does not
 * publish, and an action listed under the wrong family each fail here, by name.
 */
const MOD_REGISTRATIONS = readFileSync(
  resolve(hostRoot, "../integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
  "utf8",
);

/** actionId -> familyId exactly as the Mod declares them, from its one registration list. */
function modFamiliesOfActions(): ReadonlyMap<string, string> {
  const body = MOD_REGISTRATIONS.match(/\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/u)?.[1];
  assert.ok(body !== undefined, "the Mod's registration list must be readable from its own source");
  const families = new Map<string, string>();
  for (const entry of body.split(/(?=\b(?:E|R|Registration)\()/u)) {
    const match = entry.match(/\b(?:E|R|Registration)\(\s*"([a-z][a-z0-9_]{1,127})",\s*"([a-z][a-z0-9_]{1,127})"/u);
    if (match?.[1] !== undefined && match[2] !== undefined) families.set(match[1], match[2]);
  }
  return families;
}

const MOD_FAMILY_OF_ACTION = modFamiliesOfActions();

/** The surface artifact's registrations, each carrying the family the Mod really declares for it. */
const CATALOG_REGISTRATIONS: readonly ActionRegistration[] = SURFACE.map((action) => {
  const familyId = MOD_FAMILY_OF_ACTION.get(action.actionId);
  assert.ok(
    familyId !== undefined,
    `${action.actionId} is on the published surface but the Mod's registration list declares no family for it`,
  );
  return Object.freeze({
    actionId: action.actionId,
    familyId,
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
  });
});

const CATALOG_ACTIONS = planActionsFromRegistrations(CATALOG_REGISTRATIONS);

/**
 * The vocabulary block read back out of the description: `family: action, action` per line, in the order it prints.
 * Only a line that starts with one family id and a colon is a vocabulary line, so neither the prose nor the script
 * example - both of which end a sentence and then a colon - can be mistaken for one.
 */
function describedVocabulary(description: string): ReadonlyMap<string, readonly string[]> {
  const vocabulary = new Map<string, readonly string[]>();
  for (const line of description.split("\n")) {
    const match = /^([a-z][a-z0-9_]*): (.+)$/u.exec(line);
    if (match?.[1] === undefined || match[2] === undefined) continue;
    assert.equal(vocabulary.has(match[1]), false, `the description lists the family ${match[1]} twice`);
    vocabulary.set(match[1], match[2].split(/,\s*/u));
  }
  return vocabulary;
}

test("the plan description names every action this session publishes, under the family the Mod declares, and no other", () => {
  assert.ok(CATALOG_ACTIONS.length > 0, "the catalog publishes plannable actions");
  const described = describedVocabulary(planWorkDescription(CATALOG_ACTIONS));
  assert.ok(described.size > 0, "the description carries the action vocabulary at all");

  const published = new Set(CATALOG_ACTIONS.map((action) => action.actionId));
  const describedIds = new Set([...described.values()].flat());

  // Direction 1: a published action the description never names. This is the `advance_day` defect - the companion held
  // a description that claimed the whole surface and could not read a single name out of it.
  assert.deepEqual(
    [...published].filter((actionId) => !describedIds.has(actionId)).sort(),
    [],
    "every action the session publishes is named in the plan tool's description",
  );
  // Direction 2: a name in the description that this session does not publish. A stale id is worse than a missing one:
  // the companion writes `builder.<thatName>` and is only refused after paying for the call.
  assert.deepEqual(
    [...describedIds].filter((actionId) => !published.has(actionId)).sort(),
    [],
    "the plan tool's description names no action this session does not publish",
  );
  // The grouping is the Mod's own, not a Host invention: each family lists exactly the actions declared in it, so an
  // action filed under the wrong family fails by name instead of merely appearing somewhere.
  assert.deepEqual(
    [...described.keys()].sort(),
    [...new Set(CATALOG_ACTIONS.map((action) => action.familyId))].sort(),
    "the description's families are exactly the families the Mod declares for its plannable actions",
  );
  for (const [familyId, members] of described)
    assert.deepEqual(
      [...members].sort(),
      CATALOG_ACTIONS.filter((action) => action.familyId === familyId)
        .map((action) => action.actionId)
        .sort(),
      `${familyId} lists exactly its own actions`,
    );
});

test("the description's example uses a published action and that action's own declared argument names", () => {
  const description = planWorkDescription(CATALOG_ACTIONS);
  const call = /builder\.([a-z0-9_]+)\(\{ (.*) \}\);/u.exec(description);
  assert.ok(call, "the description carries one builder call as an example");
  const action = SURFACE.find((entry) => entry.actionId === call[1]);
  assert.ok(action, `${String(call[1])} in the example is an action the surface publishes`);
  assert.deepEqual(
    [...(call[2] as string).matchAll(/([A-Za-z0-9_]+):/gu)].map((match) => match[1]),
    Object.keys(action.argumentSchema ?? {}),
    "the example's argument names are that action's declared ones, in order",
  );
});
