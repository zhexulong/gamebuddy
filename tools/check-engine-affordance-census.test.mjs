#!/usr/bin/env node
/**
 * The census's own falsifier. Every "red-proof:" line in `check-engine-affordance-census.mjs` is produced here.
 *
 * <p>
 * The fixtures are their own decompiled tree, written into a temporary directory: four C# files, a register with
 * one native seam and a recorded baseline. That is the whole point of the fixture — the population this gate reads
 * is the engine, so the test has to hand it an engine it has never seen rather than assert against the one on this
 * machine.
 * </p>
 *
 * <p>
 * The last four tests read the EXACT tree and the real register. They are the gate proving itself on real history:
 * each asserts a finding this session already knew about before the census existed, so a census that stopped
 * seeing them would be refuted by the same test that recorded them. They are a named skip on a machine without the
 * decompile (the tree is gitignored, `ref/`), never a silent pass.
 * </p>
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  AFFORDANCE_DECLARATIONS,
  AFFORDANCE_MARKERS,
  DEFAULT_REGISTER,
  deriveEngineAffordances,
  evaluateEngineAffordanceCensus,
  PLAYER_FACING,
  parseDeclarationReason,
  REASON_KINDS,
  readRegisterSeams,
} from "./check-engine-affordance-census.mjs";
import { STARDEW_DECOMPILE_ROOT_RELATIVE_PATH } from "./lib/stardew-decompile-root.mjs";

const REPOSITORY_ROOT = fileURLToPath(new URL("..", import.meta.url));
const CENSUS_TOOL = path.join(REPOSITORY_ROOT, "tools", "check-engine-affordance-census.mjs");

/** One C# source that declares a player entry on a type the fixture names. */
function declaringSource({ namespace, type, markers }) {
  const members = markers
    .map((marker) =>
      marker === "receiveLeftClick" || marker === "receiveRightClick"
        ? `public override void ${marker}(int x, int y, bool playSound = true) { }`
        : `public virtual bool ${marker}(Location tileLocation, Farmer who) { return false; }`,
    )
    .join("\n");
  return `namespace ${namespace}\n{\n    public class ${type}\n    {\n${members}\n    }\n}\n`;
}

const GAME_LOCATION = `namespace StardewValley
{
    public class GameLocation
    {
        public virtual bool checkAction(Location tileLocation, Farmer who)
        {
            switch (tileLocation.name)
            {
                case "Blacksmith":
                    return blacksmith(tileLocation);
            }
            return false;
        }
    }
}
`;

/**
 * A decompiled tree the repository does not have: one entry an action's seam claims (`GameLocation::checkAction`)
 * and two it does not (`Furnace::checkForAction`, `MuseumMenu::receiveLeftClick`).
 */
function writeTree(root, { extra = {} } = {}) {
  const files = {
    "StardewValley/GameLocation.cs": GAME_LOCATION,
    "StardewValley.Objects/Furnace.cs": declaringSource({
      namespace: "StardewValley.Objects",
      type: "Furnace",
      markers: ["checkForAction"],
    }),
    "StardewValley.Menus/MuseumMenu.cs": declaringSource({
      namespace: "StardewValley.Menus",
      type: "MuseumMenu",
      markers: ["receiveLeftClick"],
    }),
    ...extra,
  };
  for (const [relative, source] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, source, "utf8");
  }
  return root;
}

/** The register as the census reads it: the action→engine edge, and nothing else. */
function writeRegister(file) {
  writeFileSync(
    file,
    JSON.stringify(
      {
        schemaVersion: 1,
        artifactKind: "stardew_native_multiplayer_sensitivity",
        actions: [
          {
            actionId: "machine_load",
            seams: [
              { kind: "native", file: "StardewValley/GameLocation.cs", signature: "public virtual bool checkAction" },
            ],
          },
        ],
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

function writeBaseline(file, unreachable) {
  writeFileSync(
    file,
    JSON.stringify({ schemaVersion: 1, artifactKind: "stardew_engine_affordance_baseline", unreachable }, null, 2),
    "utf8",
  );
  return file;
}

/** A temporary directory removed when the test finishes, however it finishes. */
function withFixture(t, { extra = {}, baseline = [] } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "engine-affordance-census-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = writeTree(path.join(root, "engine"), { extra });
  const register = writeRegister(path.join(root, "register.json"));
  const baselineFile = writeBaseline(path.join(root, "baseline.json"), baseline);
  // The authored table explains the REAL tree's types, so a fixture population has none of them: the fixture hands
  // the census its own (empty) table rather than making every real declaration an unknown affordance.
  const declarations = path.join(root, "declarations.json");
  writeFileSync(declarations, "[]", "utf8");
  return { root, sourceRoot, register, baseline: baselineFile, declarations };
}

function runCensus(args) {
  const result = spawnSync(process.execPath, [CENSUS_TOOL, ...args], { cwd: REPOSITORY_ROOT, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Every fixture run names all four inputs, so no default can point at the repository's real tree. */
function runOnFixture(fixture, extraArgs = []) {
  return runCensus([
    "--source-root",
    fixture.sourceRoot,
    "--register",
    fixture.register,
    "--baseline",
    fixture.baseline,
    "--declarations",
    fixture.declarations,
    ...extraArgs,
  ]);
}

const FIXTURE_BASELINE = ["Furnace::checkForAction", "MuseumMenu::receiveLeftClick"];

test("the census measures a tree it has never seen and prints the three counts with the per-kind breakdown", (t) => {
  const fixture = withFixture(t, { baseline: FIXTURE_BASELINE });
  const run = runOnFixture(fixture);
  assert.equal(run.status, 0, run.stderr);
  assert.match(
    run.stdout,
    /engine_affordance_census: affordances examined 3 · covered 1 · unreachable 2 · declared-out-of-scope 0/u,
  );
  assert.match(run.stdout, /marker checkAction: examined 1 · covered 1 · unreachable 0 · declared 0/u);
  assert.match(run.stdout, /marker checkForAction: examined 1 · covered 0 · unreachable 1 · declared 0/u);
});

test("a planted player entry no seam claims fails under its own name, and the marker's growth is named beside it", (t) => {
  const fixture = withFixture(t, {
    baseline: FIXTURE_BASELINE,
    extra: {
      "StardewValley.Objects/Furnace.cs": declaringSource({
        namespace: "StardewValley.Objects",
        type: "Furnace",
        markers: ["checkForAction", "performToolAction"],
      }),
    },
  });
  const run = runOnFixture(fixture);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stdout, /finding engine_affordance_unreachable:Furnace::performToolAction/u);
  assert.match(run.stdout, /finding affordance_kind_grew:performToolAction:0->1/u);
});

test("a tree with C# sources and no player entry anywhere is BLOCKED, never passed", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "engine-affordance-empty-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "engine");
  mkdirSync(path.join(sourceRoot, "StardewValley"), { recursive: true });
  writeFileSync(
    path.join(sourceRoot, "StardewValley", "Utility.cs"),
    "namespace StardewValley { public static class Utility { public static int Add(int a, int b) { return a + b; } } }",
    "utf8",
  );
  const register = writeRegister(path.join(root, "register.json"));
  const baseline = writeBaseline(path.join(root, "baseline.json"), []);
  const run = runCensus(["--source-root", sourceRoot, "--register", register, "--baseline", baseline]);
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /blocked: engine_affordance_population_empty/u);
});

test("no decompiled tree at all is BLOCKED with the restore recipe, not a zero finding count", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "engine-affordance-absent-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const register = writeRegister(path.join(root, "register.json"));
  const baseline = writeBaseline(path.join(root, "baseline.json"), []);
  const run = runCensus([
    "--source-root",
    path.join(root, "not-a-tree"),
    "--register",
    register,
    "--baseline",
    baseline,
  ]);
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /blocked: engine_affordance_tree_unavailable/u);
  assert.match(run.stderr, /ilspycmd/u);
});

test("the ratchet records a shrink and refuses to record a new unreachable affordance", (t) => {
  const fixture = withFixture(t, {
    baseline: [...FIXTURE_BASELINE, "RetiredMenu::receiveLeftClick"],
  });
  const stale = runOnFixture(fixture);
  assert.equal(stale.status, 1, stale.stderr);
  assert.match(stale.stdout, /finding stale_affordance_baseline:RetiredMenu::receiveLeftClick/u);

  const recorded = runOnFixture(fixture, ["--record-shrinks"]);
  assert.equal(recorded.status, 0, recorded.stderr);
  assert.match(recorded.stdout, /engine_affordance_baseline_recorded: 2 unreachable affordances/u);
  const written = JSON.parse(readFileSync(fixture.baseline, "utf8"));
  assert.deepEqual(written.unreachable, ["Furnace::checkForAction", "MuseumMenu::receiveLeftClick"]);

  const planted = runOnFixture(fixture);
  assert.equal(planted.status, 0, planted.stderr);
});

test("--record-shrinks refuses a set that grew, so accepting a new unreachable is a reviewed diff and never a flag", (t) => {
  const fixture = withFixture(t, { baseline: ["MuseumMenu::receiveLeftClick"] });
  const run = runOnFixture(fixture, ["--record-shrinks"]);
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /engine_affordance_baseline_can_only_shrink/u);
  assert.deepEqual(JSON.parse(readFileSync(fixture.baseline, "utf8")).unreachable, ["MuseumMenu::receiveLeftClick"]);
});

test("a declaration for an affordance an action already reaches is refused in both directions", () => {
  const reading = evaluateEngineAffordanceCensus({
    affordances: [
      {
        key: "GameLocation::checkAction",
        type: "GameLocation",
        marker: "checkAction",
        file: "a.cs",
        sites: [1],
        selectors: [],
      },
      {
        key: "Furnace::checkForAction",
        type: "Furnace",
        marker: "checkForAction",
        file: "b.cs",
        sites: [3],
        selectors: [],
      },
    ],
    seams: new Map([["a.cs::checkAction", ["machine_load"]]]),
    actionIds: new Set(["machine_load"]),
    declarations: [{ affordance: "GameLocation::checkAction", reason: "not_a_player_interaction" }],
    baseline: { unreachable: ["Furnace::checkForAction"] },
  });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["affordance_declared_but_covered:GameLocation::checkAction"],
  );
});

test("a `reached_through_a_different_action` reason the register cannot verify is refused", () => {
  const affordances = [
    {
      key: "Furnace::checkForAction",
      type: "Furnace",
      marker: "checkForAction",
      file: "StardewValley.Objects/Furnace.cs",
      sites: [3],
      selectors: [],
    },
  ];
  const seams = new Map([["StardewValley.Objects/Other.cs::checkAction", ["machine_load"]]]);
  const reading = evaluateEngineAffordanceCensus({
    affordances,
    seams,
    actionIds: new Set(["machine_load"]),
    declarations: [
      { affordance: "Furnace::checkForAction", reason: "reached_through_a_different_action:machine_load" },
    ],
    baseline: { unreachable: ["Furnace::checkForAction"] },
  });
  assert.deepEqual(
    reading.findings.map((finding) => finding.code),
    ["affordance_declaration_reason_unverified:Furnace::checkForAction:machine_load"],
  );

  const verified = evaluateEngineAffordanceCensus({
    affordances,
    seams: new Map([["StardewValley.Objects/Furnace.cs::checkForAction", ["machine_load"]]]),
    actionIds: new Set(["machine_load"]),
    declarations: [
      { affordance: "Furnace::checkForAction", reason: "reached_through_a_different_action:machine_load" },
    ],
    baseline: { unreachable: [] },
  });
  assert.equal(verified.declared, 0, "an affordance the seam covers is not an unreachable one");
});

test("the reason vocabulary is closed, so growth shows up as a growth of a kind", () => {
  assert.throws(() => parseDeclarationReason("because_it_is_not_needed_here"), /not one of/u);
  assert.throws(() => parseDeclarationReason("out_of_demo_scope:too short"), /characters minimum/u);
  assert.throws(() => parseDeclarationReason("reached_through_a_different_action"), /must name the action id/u);
  assert.deepEqual(REASON_KINDS, [
    "not_a_player_interaction",
    "out_of_demo_scope",
    "reached_through_a_different_action",
  ]);
  for (const declaration of AFFORDANCE_DECLARATIONS)
    assert.doesNotThrow(() => parseDeclarationReason(declaration.reason));
});

/** The exact tree, derived once: four tests read the same reading. */
const decompileRoot = path.join(REPOSITORY_ROOT, STARDEW_DECOMPILE_ROOT_RELATIVE_PATH);
const hasDecompileTree = existsSync(decompileRoot);
let realReadingPromise = null;

async function realReading() {
  if (realReadingPromise === null)
    realReadingPromise = (async () => {
      const register = JSON.parse(readFileSync(path.join(REPOSITORY_ROOT, DEFAULT_REGISTER), "utf8"));
      const derivation = await deriveEngineAffordances({ sourceRoot: decompileRoot });
      return {
        derivation,
        register,
        reading: evaluateEngineAffordanceCensus({
          affordances: derivation.affordances,
          collisions: derivation.collisions,
          seams: readRegisterSeams(register),
          actionIds: new Set(register.actions.map((action) => action.actionId)),
          baseline: JSON.parse(
            readFileSync(path.join(REPOSITORY_ROOT, "tools/engine-affordance-baseline.json"), "utf8"),
          ),
        }),
      };
    })();
  return realReadingPromise;
}

const SKIP_WITHOUT_TREE = hasDecompileTree
  ? false
  : "ref/external/StardewValleyDecompiled is gitignored: the decompiled tree is not on this machine";

test(
  "the census names Clint's counter among the map-Action selectors no action can reach",
  { skip: SKIP_WITHOUT_TREE },
  async () => {
    const { reading } = await realReading();
    const dispatcher = reading.unreachable.find((row) => row.key === "GameLocation::performAction");
    assert.ok(dispatcher !== undefined, "GameLocation::performAction is claimed by an action now — update this test");
    assert.ok(dispatcher.selectors.includes("Blacksmith"), `selectors: ${dispatcher.selectors.join(",")}`);
  },
);

test(
  "the museum's player way in is unreachable while the reward method behind it is claimed",
  { skip: SKIP_WITHOUT_TREE },
  async () => {
    const { reading, register } = await realReading();
    const unreachable = new Set(reading.unreachable.map((row) => row.key));
    assert.ok(unreachable.has("LibraryMuseum::checkAction"), "LibraryMuseum::checkAction is claimed now");
    assert.ok(unreachable.has("MuseumMenu::receiveLeftClick"), "the donation grid's click is claimed now");
    assert.ok(unreachable.has("MuseumMenu::receiveRightClick"), "the donation grid's right click is claimed now");
    const rewardSeam = register.actions
      .find((action) => action.actionId === "claim_museum_reward")
      ?.seams.some((seam) =>
        `${seam.file}::${seam.signature}`.includes("LibraryMuseum.cs::public List<Item> getRewardsForPlayer"),
      );
    assert.equal(rewardSeam, true, "claim_museum_reward no longer cites LibraryMuseum.getRewardsForPlayer");
  },
);

test(
  "the palette and the prize-ticket counter are unreachable, and neither action cites a player entry",
  { skip: SKIP_WITHOUT_TREE },
  async () => {
    const { reading, register } = await realReading();
    const unreachable = new Set(reading.unreachable.map((row) => row.key));
    assert.ok(unreachable.has("DiscreteColorPicker::receiveLeftClick"), "the palette click is claimed now");
    assert.ok(unreachable.has("PrizeTicketMenu::receiveLeftClick"), "the prize-ticket click is claimed now");
    // Both descriptors cite an engine call, and the register records both actions as having no native seam at all,
    // so no seam can cover the entry they belong to.
    for (const actionId of ["color_placed_object", "redeem_prize_ticket"]) {
      const action = register.actions.find((entry) => entry.actionId === actionId);
      assert.equal(
        action.seams.every((seam) => (seam.kind ?? "native") === "mod_owned"),
        true,
        `${actionId} now claims a native seam — re-read this test`,
      );
    }
  },
);

test(
  "every player-facing label still names a type the census derives, and the population is not empty",
  { skip: SKIP_WITHOUT_TREE },
  async () => {
    const { derivation, reading } = await realReading();
    const types = new Set(derivation.affordances.map((affordance) => affordance.type));
    for (const type of Object.keys(PLAYER_FACING))
      assert.ok(types.has(type), `PLAYER_FACING names ${type}, which the tree no longer declares`);
    assert.ok(derivation.filesExamined > 500, `files examined ${String(derivation.filesExamined)}`);
    assert.ok(reading.examined > 200, `affordances examined ${String(reading.examined)}`);
    assert.deepEqual(
      reading.findings.map((finding) => finding.code),
      [],
      "the recorded baseline disagrees with the tree",
    );
    assert.deepEqual(derivation.collisions, []);
    for (const marker of AFFORDANCE_MARKERS) assert.ok(reading.kinds.some((kind) => kind.marker === marker));
  },
);
