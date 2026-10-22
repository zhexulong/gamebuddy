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
    ...(action.argumentSchema === undefined ? {} : { descriptor: { argumentSchema: action.argumentSchema } }),
  }),
);

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
