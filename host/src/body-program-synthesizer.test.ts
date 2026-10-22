import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_SYNTHESIZED_PROGRAM_NODES,
  type MacroIntentId,
  type SynthesizeResult,
  type SynthesizedPrograms,
  synthesizePrograms,
} from "./body-program-synthesizer.js";
import { type Snapshot, validateBodyProgramCandidateRequest } from "./protocol.js";

/**
 * The Mod-owned action surface is the authority for which actions exist, what they take and which
 * lifecycle each carries; the synthesizer's compiled argument names and its "may a node name this"
 * gate are checked against it rather than against a hand-copied list.
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
  argumentSchema?: Readonly<Record<string, unknown>>;
}>;

const SURFACE = surfaceActions();
/** Exactly what `FarmhandBodyProgramCatalogProjection.TryProject` keeps: published, executable. */
const PROGRAM_ACTION_IDS = SURFACE.filter(
  (action) => action.lifecycle === "published" && action.kind === "execution",
).map((action) => action.actionId);

function surfaceActions(): readonly SurfaceAction[] {
  const parsed = JSON.parse(readFileSync(SURFACE_PATH, "utf8")) as { schema?: unknown; actions?: unknown };
  assert.equal(parsed.schema, "gamebuddy-action-descriptors/v1");
  assert.ok(Array.isArray(parsed.actions));
  return parsed.actions as readonly SurfaceAction[];
}

function surfaceArgumentNames(actionId: string): readonly string[] {
  const action = SURFACE.find((entry) => entry.actionId === actionId);
  assert.ok(action !== undefined, `action ${actionId} is missing from the published surface`);
  return Object.keys(action.argumentSchema ?? {});
}

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

const harvest = (targetId: string, x: number, y: number) => ({
  targetId,
  x,
  y,
  cropId: "cauliflower",
  qualifiedHarvestItemId: "(O)190",
  displayName: "Cauliflower",
  regrowsAfterHarvest: false,
});

const forage = (targetId: string, x: number, y: number) => ({
  targetId,
  x,
  y,
  qualifiedItemId: "(O)18",
  displayName: "Daffodil",
  stack: 1,
});

const rockSource = (targetId: string, x: number, y: number) => ({
  targetId,
  location: "Farm",
  x,
  y,
  qualifiedItemId: "(O)390",
  displayName: "Stone",
  health: 1,
});

const debris = (targetId: string, slot: number, x: number, y: number) => ({
  targetId,
  slot,
  x,
  y,
  parentSheetIndex: 600,
  toolKind: "axe",
  requiredUpgradeLevel: 0,
  health: 1,
});

const weed = (targetId: string, x: number, y: number) => ({ targetId, location: "Farm", x, y, health: 1 });

const shippingBin = (targetId: string, slot: number, x: number, y: number) => ({
  targetId,
  x,
  y,
  slot,
  qualifiedItemId: "(O)24",
  displayName: "Parsnip",
  stack: 3,
});

function programsOf(result: SynthesizeResult): SynthesizedPrograms {
  if (!result.ok) assert.fail(`expected programs, received ${result.reasonCode}`);
  return result;
}

function refusalOf(result: SynthesizeResult): string {
  if (result.ok) assert.fail("expected a refusal");
  return result.reasonCode;
}

type SynthesizedNode = SynthesizedPrograms["programs"][number]["nodes"][number];

function argumentNames(node: SynthesizedNode): readonly string[] {
  return Object.keys(node.arguments).sort();
}

/** The canonical string of one scalar argument, as the wire carries it. */
function canonical(node: SynthesizedNode, name: string): string | undefined {
  const value = node.arguments[name];
  return value !== undefined && "canonicalValue" in value ? value.canonicalValue : undefined;
}

test("the program catalog keeps only published actions, which today excludes three card actions", () => {
  for (const actionId of ["move_to_tile", "water_crop", "harvest_crop", "pickup_forage", "break_rock_source"])
    assert.ok(PROGRAM_ACTION_IDS.includes(actionId), `${actionId} must be program-publishable`);
  for (const actionId of ["cut_weeds", "clear_debris", "ship_item"])
    assert.ok(!PROGRAM_ACTION_IDS.includes(actionId), `${actionId} is live_verified, so a program may not name it`);
  assert.equal(MAX_SYNTHESIZED_PROGRAM_NODES, 16);
});

test("tend_crops compiles each dry crop and each harvestable into paired nodes, nearest tile first", () => {
  const result = synthesizePrograms(
    snapshot({
      enabledActionIds: ["move_to_tile", "water_crop", "harvest_crop"],
      cropTargets: [crop("crop_far", 20, 20), crop("crop_near", 11, 10)],
      harvestTargets: [harvest("harvest_mid", 13, 10)],
    }),
    "tend_crops",
    { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 },
  );
  const programs = programsOf(result);
  assert.equal(programs.programs.length, 1);
  assert.equal(programs.instanceCount, 3);
  assert.equal(programs.remaining, 0);
  assert.deepEqual(programs.uncompilable, []);
  const nodes = programs.programs[0]!.nodes;
  assert.deepEqual(
    nodes.map((node) => [node.nodeId, node.actionId, node.dependsOn]),
    [
      ["n01", "move_to_tile", []],
      ["n02", "water_crop", ["n01"]],
      ["n03", "move_to_tile", []],
      ["n04", "harvest_crop", ["n03"]],
      ["n05", "move_to_tile", []],
      ["n06", "water_crop", ["n05"]],
    ],
  );
  assert.deepEqual(nodes[0]!.arguments, {
    x: { type: "integer", canonicalValue: "11" },
    y: { type: "integer", canonicalValue: "10" },
  });
  assert.deepEqual(nodes[1]!.arguments, {
    x: { type: "integer", canonicalValue: "11" },
    y: { type: "integer", canonicalValue: "10" },
    expectedTargetId: { type: "string", canonicalValue: "crop_near" },
  });
  assert.deepEqual(nodes[3]!.arguments, {
    x: { type: "integer", canonicalValue: "13" },
    y: { type: "integer", canonicalValue: "10" },
    expectedQualifiedItemId: { type: "string", canonicalValue: "(O)190" },
    expectedTargetId: { type: "string", canonicalValue: "harvest_mid" },
  });
  assert.deepEqual(nodes[5]!.arguments.x, { type: "integer", canonicalValue: "20" });
});

test("an empty instance set refuses per intent by name", () => {
  const cases: readonly (readonly [MacroIntentId, string])[] = [
    ["tend_crops", "nothing_to_water"],
    ["clear_obstacles", "nothing_to_clear"],
    ["gather_forage", "nothing_to_forage"],
    ["store_produce", "nothing_to_ship"],
  ];
  for (const [intentId, reasonCode] of cases)
    assert.equal(
      refusalOf(synthesizePrograms(snapshot(), intentId, { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 })),
      reasonCode,
    );
});

test("one instance compiles into one single-node program", () => {
  const programs = programsOf(
    synthesizePrograms(
      snapshot({ enabledActionIds: ["pickup_forage"], forageTargets: [forage("forage_01", 12, 10)] }),
      "gather_forage",
      { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 },
    ),
  );
  assert.equal(programs.programs.length, 1);
  assert.equal(programs.remaining, 0);
  assert.equal(programs.programs[0]!.nodes.length, 1);
  assert.equal(programs.programs[0]!.nodes[0]!.actionId, "pickup_forage");
  assert.deepEqual(programs.programs[0]!.nodes[0]!.dependsOn, []);
  assert.deepEqual(programs.programs[0]!.nodes[0]!.bindings, {});
});

test("seventeen instances split into 16 + 1 and report the undelivered remainder", () => {
  const debrisTargets = Array.from({ length: 17 }, (_, index) =>
    debris(`debris_${String(index).padStart(2, "0")}`, 3, 10 + index, 10),
  );
  const surface = [...PROGRAM_ACTION_IDS, "clear_debris"];
  const firstTurn = programsOf(
    synthesizePrograms(snapshot({ enabledActionIds: surface, debrisTargets }), "clear_obstacles", {
      programActionIds: surface,
      maxPrograms: 1,
    }),
  );
  assert.equal(firstTurn.instanceCount, 17);
  assert.equal(firstTurn.programs.length, 1);
  assert.equal(firstTurn.programs[0]!.nodes.length, MAX_SYNTHESIZED_PROGRAM_NODES);
  assert.equal(firstTurn.remaining, 1);

  const secondTurn = programsOf(
    synthesizePrograms(snapshot({ enabledActionIds: surface, debrisTargets }), "clear_obstacles", {
      programActionIds: surface,
      maxPrograms: 2,
    }),
  );
  assert.deepEqual(
    secondTurn.programs.map((program) => program.nodes.length),
    [16, 1],
  );
  assert.equal(secondTurn.remaining, 0);
  // The tail keeps the same nearest-first order: instance 16 is the farthest tile.
  assert.equal(canonical(secondTurn.programs[1]!.nodes[0]!, "expectedTargetId"), "debris_16");
});

test("clear_obstacles compiles the families the catalog allows and names every family it cannot", () => {
  const bothKinds = snapshot({
    enabledActionIds: ["move_to_tile", "cut_weeds", "break_rock_source", "clear_debris"],
    weedTargets: [weed("weed_01", 9, 10)],
    rockSourceTargets: [rockSource("rock_01", 10, 11)],
    debrisTargets: [debris("debris_01", 3, 11, 10), debris("debris_02", 3, 12, 10)],
  });
  // With the Mod's real catalog nothing in this intent can be named at all.
  assert.equal(
    refusalOf(
      synthesizePrograms(bothKinds, "clear_obstacles", { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 }),
    ),
    "synthesizer_action_not_published:cut_weeds",
  );
  // Once clear_debris is projectable, the debris ships and the other two families are reported by name.
  const withDebris = programsOf(
    synthesizePrograms(bothKinds, "clear_obstacles", {
      programActionIds: [...PROGRAM_ACTION_IDS, "clear_debris"],
      maxPrograms: 1,
    }),
  );
  assert.equal(withDebris.instanceCount, 2);
  assert.equal(withDebris.programs.length, 1);
  assert.deepEqual(
    withDebris.programs[0]!.nodes.map((node) => canonical(node, "expectedTargetId")),
    ["debris_01", "debris_02"],
  );
  assert.deepEqual(withDebris.uncompilable, [
    { family: "weed", actionId: "cut_weeds", reason: "lifecycle_not_published" },
    { family: "rock_source", actionId: "break_rock_source", reason: "target_unresolved:rock_01" },
  ]);
});

test("store_produce refuses while ship_item is not projectable, and ships once it is", () => {
  const withBin = snapshot({
    enabledActionIds: ["move_to_tile", "ship_item"],
    shippingBinTargets: [shippingBin("shipping_bin_01", 4, 14, 10)],
  });
  assert.equal(
    refusalOf(synthesizePrograms(withBin, "store_produce", { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 })),
    "synthesizer_action_not_published:ship_item",
  );
  const programs = programsOf(
    synthesizePrograms(withBin, "store_produce", {
      programActionIds: [...PROGRAM_ACTION_IDS, "ship_item"],
      maxPrograms: 1,
    }),
  );
  const nodes = programs.programs[0]!.nodes;
  assert.deepEqual(
    nodes.map((node) => node.actionId),
    ["move_to_tile", "ship_item"],
  );
  assert.deepEqual(nodes[1]!.arguments, {
    x: { type: "integer", canonicalValue: "14" },
    y: { type: "integer", canonicalValue: "10" },
    slot: { type: "integer", canonicalValue: "4" },
    expectedQualifiedItemId: { type: "string", canonicalValue: "(O)24" },
    expectedTargetId: { type: "string", canonicalValue: "shipping_bin_01" },
  });
});

test("an action that is program-publishable but not enabled is reported as a capability gap", () => {
  const programs = programsOf(
    synthesizePrograms(
      snapshot({
        enabledActionIds: ["move_to_tile", "harvest_crop"],
        cropTargets: [crop("crop_01", 11, 10)],
        harvestTargets: [harvest("harvest_01", 12, 10)],
      }),
      "tend_crops",
      { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 },
    ),
  );
  assert.equal(programs.instanceCount, 1);
  assert.deepEqual(
    programs.programs[0]!.nodes.map((node) => node.actionId),
    ["move_to_tile", "harvest_crop"],
  );
  assert.deepEqual(programs.uncompilable, [
    { family: "crop", actionId: "water_crop", reason: "capability_not_enabled" },
  ]);
});

test("a target whose tile the snapshot does not publish is refused by name, never guessed", () => {
  const mixed = snapshot({
    enabledActionIds: ["move_to_tile", "water_crop"],
    cropTargets: [crop("crop_broken", Number.NaN, 10), crop("crop_01", 11, 10)],
  });
  const programs = programsOf(
    synthesizePrograms(mixed, "tend_crops", { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 }),
  );
  assert.equal(programs.instanceCount, 1);
  assert.deepEqual(programs.uncompilable, [
    { family: "crop", actionId: "water_crop", reason: "target_unresolved:crop_broken" },
  ]);
  assert.equal(
    refusalOf(
      synthesizePrograms(
        snapshot({
          enabledActionIds: ["move_to_tile", "water_crop"],
          cropTargets: [crop("crop_broken", Number.NaN, 10)],
        }),
        "tend_crops",
        { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 },
      ),
    ),
    "synthesizer_target_unresolved:crop_broken",
  );
});

test("a stale snapshot revision is refused by name", () => {
  const stale = snapshot({ enabledActionIds: ["pickup_forage"], forageTargets: [forage("forage_01", 12, 10)] });
  assert.equal(
    refusalOf(
      synthesizePrograms(stale, "gather_forage", {
        programActionIds: PROGRAM_ACTION_IDS,
        maxPrograms: 1,
        minimumRevision: 12,
      }),
    ),
    "synthesizer_stale_snapshot",
  );
  assert.equal(
    programsOf(
      synthesizePrograms(stale, "gather_forage", {
        programActionIds: PROGRAM_ACTION_IDS,
        maxPrograms: 1,
        minimumRevision: 11,
      }),
    ).instanceCount,
    1,
  );
});

test("a missing snapshot and an unknown intent each refuse by name", () => {
  const options = { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 };
  assert.equal(refusalOf(synthesizePrograms(null, "gather_forage", options)), "synthesizer_no_snapshot");
  assert.equal(refusalOf(synthesizePrograms(undefined, "gather_forage", options)), "synthesizer_no_snapshot");
  assert.equal(
    refusalOf(synthesizePrograms(snapshot(), "till_everything" as MacroIntentId, options)),
    "synthesizer_unknown_intent:till_everything",
  );
});

test("a caller that allows no programs at all is refused as unsatisfiable", () => {
  assert.equal(
    refusalOf(
      synthesizePrograms(
        snapshot({
          enabledActionIds: ["pickup_forage"],
          forageTargets: [forage("forage_01", 12, 10), forage("forage_02", 13, 10)],
        }),
        "gather_forage",
        { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 0 },
      ),
    ),
    "synthesizer_cap_unsatisfiable:2",
  );
});

test("every emitted node passes the real Body Program validator and the published argument shape", () => {
  const result = snapshot({
    enabledActionIds: ["move_to_tile", "water_crop", "harvest_crop", "pickup_forage"],
    cropTargets: [crop("crop_01", 11, 10), crop("crop_02", 12, 11)],
    harvestTargets: [harvest("harvest_01", 13, 10)],
    forageTargets: [forage("forage_01", 9, 10)],
  });
  const programs = programsOf(
    synthesizePrograms(result, "tend_crops", { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 1 }),
  );
  for (const program of programs.programs) {
    assert.equal(validateBodyProgramCandidateRequest({ programId: "program_01", nodes: program.nodes }), null);
    assert.ok(program.nodes.length <= MAX_SYNTHESIZED_PROGRAM_NODES);
    for (const node of program.nodes) {
      assert.ok(PROGRAM_ACTION_IDS.includes(node.actionId), `${node.actionId} is not program-publishable`);
      assert.deepEqual(argumentNames(node), [...surfaceArgumentNames(node.actionId)].sort());
    }
  }
  assert.equal(programs.instanceCount, 3);
});

test("the same snapshot and intent compiled twice gives byte-identical programs", () => {
  const input = snapshot({
    enabledActionIds: ["move_to_tile", "water_crop", "harvest_crop"],
    cropTargets: [crop("crop_b", 12, 10), crop("crop_a", 12, 10), crop("crop_c", 9, 10)],
    harvestTargets: [harvest("harvest_a", 10, 12)],
  });
  const first = programsOf(
    synthesizePrograms(input, "tend_crops", { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 2 }),
  );
  const second = programsOf(
    synthesizePrograms(input, "tend_crops", { programActionIds: PROGRAM_ACTION_IDS, maxPrograms: 2 }),
  );
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  // Equal tiles fall back to target id, so "crop_a" precedes "crop_b" regardless of snapshot order.
  assert.deepEqual(
    first.programs[0]!.nodes.filter((node) => node.actionId === "water_crop").map((node) =>
      canonical(node, "expectedTargetId"),
    ),
    ["crop_c", "crop_a", "crop_b"],
  );
});
