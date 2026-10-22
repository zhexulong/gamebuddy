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
  argumentSchema?: Readonly<Record<string, { type: string; enum?: readonly string[] }>>;
  outputFacts?: Readonly<Record<string, string>>;
  resourceTemplate?: Readonly<{ claims: readonly Readonly<{ key: string; value: string }>[] }>;
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
): readonly Readonly<{ name: string; type: string; enum?: readonly string[] }>[] {
  const action = SURFACE.find((candidate) => candidate.actionId === actionId);
  assert.ok(action, `${actionId} is on the published surface`);
  return Object.entries(action.argumentSchema ?? {}).map(([name, declared]) =>
    declared.enum === undefined ? { name, type: declared.type } : { name, type: declared.type, enum: declared.enum },
  );
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

test("a script that emits a seventeenth node is refused by name, never truncated", () => {
  const result = compile(
    `
for (let index = 0; index < 17; index++) builder.move_to_tile({ x: 10 + index, y: 10 });
`,
  );
  assert.equal(refusalOf(result), `plan_cap_exceeded:${MAX_PLAN_NODES + 1}`);
});

test("isFull() lets the script stop at the cap instead of being refused", () => {
  const nodes = nodesOf(
    compile(
      `
for (let index = 0; index < 40; index++) {
  if (builder.isFull()) break;
  builder.move_to_tile({ x: 10 + index, y: 10 });
}
`,
    ),
  );
  assert.equal(nodes.length, MAX_PLAN_NODES);
  assert.equal(nodes[MAX_PLAN_NODES - 1]!.nodeId, "n16");
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
 * "Is the scythe equipped" cannot be judged statically and the slot index cannot be guessed: the Mod publishes the held
 * tool and the pack's tool slots, so a script reads both from the snapshot it was handed instead of inventing a slot.
 */
test("a script reads the held tool and its slot from the snapshot instead of guessing a slot index", () => {
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
});

/** A live ResourceClump target: the ONE place the published surface declares the tool an action needs. */
function debris(targetId: string, slot: number, toolKind: string) {
  return { targetId, slot, toolKind, requiredUpgradeLevel: 0, x: 11, y: 12, parentSheetIndex: 600, health: 2 };
}

const TOOL_PACK = [
  { slot: 0, label: "(T)Axe", upgradeLevel: 0 },
  { slot: 3, label: "(T)Pickaxe", upgradeLevel: 0 },
] as const;

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
 * The requirement a tool-family action carries lives inside the Mod's handler (`cut_weeds` needs the scythe,
 * `break_rock_source` the basic pickaxe); the surface names none of it. Guessing is what produced the failed hits, so
 * the helper refuses by name and hands back what the surface DOES declare.
 */
test("equipFor refuses an action whose tool only the Mod's handler knows, naming what the surface declares", () => {
  const refusal = compile("builder.equipFor('cut_weeds');", { currentToolSlot: 0, toolSlots: TOOL_PACK });
  assert.equal(refusalOf(refusal), "plan_script_tool_requirement_undeclared:cut_weeds");
  assert.deepEqual(requirementOf(refusal), {
    actionId: "cut_weeds",
    requiredArguments: surfaceArguments("cut_weeds"),
    resourceClaims: surfaceClaims("cut_weeds"),
  });
  // A weed target declares no tool either, so passing one does not turn a guess into a requirement.
  assert.equal(
    refusalOf(
      compile("builder.equipFor('cut_weeds', snapshot.weedTargets[0]);", {
        weedTargets: [{ targetId: "weed_01", location: "Farm", x: 5, y: 6, health: 1 }],
      }),
    ),
    "plan_script_tool_requirement_undeclared:cut_weeds",
  );
  // An id the vocabulary does not have answers with that name, and the host adds the ids it DOES have.
  assert.equal(refusalOf(compile("builder.equipFor('brew_potion');")), "plan_script_unknown_action:brew_potion");
});
