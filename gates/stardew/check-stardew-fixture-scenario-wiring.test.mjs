import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkStardewFixtureScenarioWiring,
  extractDeclaredScenarios,
  extractFixtureScenarioIds,
  extractScenarioRows,
} from "./check-stardew-fixture-scenario-wiring.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// ModEntry is a partial class: the row table lives in ModEntry.Fixtures.ScenarioInitializers.cs, not ModEntry.cs.
const REAL_ENTRY = fs
  .readdirSync(path.join(root, "integrations/stardew"))
  .filter((name) => /^ModEntry(\..+)?\.cs$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(path.join(root, "integrations/stardew", name), "utf8"))
  .join("\n");
const REAL_CONFIG = fs.readFileSync(path.join(root, "integrations/stardew/ModConfig.cs"), "utf8");

/**
 * A minimal triple of sources with the populations under our control, plus the tools-side declaration of which scenario a
 * run asks for.
 *
 * The config is written the way `ModConfig.cs` writes it after `21bd3a46`: the armed universe and the host-automation
 * set as their own literal arrays, and `KnownFixtureScenarios` as the derived union. `tools` defaults to the armed set so
 * a test about a Mod-side list keeps its violation list to that list alone.
 */
function sources({ armed, hostAutomation = [], rows = armed, tools = armed, knownOverride = null }) {
  const list = (names) => names.map((name) => `"${name}",`).join("\n        ");
  const known =
    knownOverride === null
      ? "NativeLocalFixtureScenarios.Concat(HostAutomationFixtureSaveScenarios).ToArray()"
      : `new[]\n    {\n        ${list(knownOverride)}\n    }`;
  const config = [
    `    internal static readonly string[] NativeLocalFixtureScenarios = new[]\n    {\n        ${list(armed)}\n    };`,
    `    private static readonly string[] HostAutomationFixtureSaveScenarios = new[]\n    {\n        ${list(hostAutomation)}\n    };`,
    `    internal static readonly string[] KnownFixtureScenarios = ${known};`,
  ].join("\n\n");
  const entry = rows
    .map(
      (name) =>
        `        NativeLocalFixtureScenarioRow.ActorPrepared("${name}", static (mod, player, farm, _) => mod.Initialize("${name}")),`,
    )
    .join("\n");
  const library = [
    "export function fixtureScenario(actions, action) {",
    ...tools.map((name) => `  if (action === "${name}") return "${name}";`),
    '  return "";',
    "}",
  ].join("\n");
  return { modEntrySource: entry, modConfigSource: config, fixtureLibrarySource: library };
}

const issuesFor = (report, scenario) =>
  report.violations
    .filter((violation) => violation.scenario === scenario)
    .map((violation) => violation.issue)
    .sort();

test("the real repository wiring is consistent", () => {
  const report = checkStardewFixtureScenarioWiring();
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
  assert.equal(report.violations.length, 0);
  // The parity claims themselves, read from the real declarations rather than pinned as numbers: the row table builds
  // exactly the scenarios the armed config accepts, and everything the config calls known is one of those or one another
  // dispatcher owns. The known set drops the empty scenario because the tools-side population uses `""` for "no fixture
  // world"; the armed set keeps it, because there the empty string IS the move-only profile.
  const armed = extractDeclaredScenarios(REAL_CONFIG, "NativeLocalFixtureScenarios");
  const hostAutomation = extractDeclaredScenarios(REAL_CONFIG, "HostAutomationFixtureSaveScenarios");
  assert.deepEqual(
    [...extractScenarioRows(REAL_ENTRY)].sort(),
    [...armed].sort(),
    "the row table and the armed population disagree",
  );
  assert.equal(report.counts.armed, armed.size);
  assert.equal(report.counts.hostAutomation, hostAutomation.size);
  assert.equal(report.counts.known, [...armed, ...hostAutomation].filter((scenario) => scenario.length > 0).length);
});

test("a scenario the armed config accepts but the row table cannot build is reported", () => {
  const report = checkStardewFixtureScenarioWiring(
    sources({ armed: ["a_v1", "b_v1"], rows: ["a_v1"], tools: ["a_v1"] }),
  );
  assert.equal(report.state, "failed");
  assert.deepEqual(issuesFor(report, "b_v1"), ["accepted_by_config_but_refused_before_arming"]);
});

test("a row for a scenario the armed config refuses is reported", () => {
  // The other direction, and the one that reads as harmless: a world no configuration can ask for. `IsValid` refuses the
  // scenario before dispatch is reached, so the initializer is dead code that looks alive.
  const report = checkStardewFixtureScenarioWiring(sources({ armed: ["a_v1"], rows: ["a_v1", "ghost_v1"] }));
  assert.deepEqual(issuesFor(report, "ghost_v1"), ["dispatched_but_config_rejects"]);
});

test("a known scenario neither population explains is reported", () => {
  // Reachable through the literal form of the initializer, which `parseKnownFixtureScenarios` still reads: a hand-written
  // `KnownFixtureScenarios` can name a scenario the armed universe cannot build and the host-automation dispatcher does
  // not own, and nothing then builds its world.
  const report = checkStardewFixtureScenarioWiring(
    sources({ armed: ["a_v1"], rows: ["a_v1"], tools: ["a_v1"], knownOverride: ["a_v1", "stray_v1"] }),
  );
  assert.deepEqual(issuesFor(report, "stray_v1"), ["known_scenario_outside_both_populations"]);
});

test("the host-automation scenarios' absence from the row table is declared intent", () => {
  // `21bd3a46` replaced the `else` that built the water-crop world for any unlisted scenario: these two are accepted when
  // this fixture creates the disposable save and refused when it arms, so the absence is the decision, not a gap.
  const report = checkStardewFixtureScenarioWiring(
    sources({ armed: ["a_v1"], hostAutomation: ["native_farmhand_chat_v1"], rows: ["a_v1"] }),
  );
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));

  const withRow = checkStardewFixtureScenarioWiring(
    sources({
      armed: ["a_v1"],
      hostAutomation: ["native_farmhand_chat_v1"],
      rows: ["a_v1", "native_farmhand_chat_v1"],
    }),
  );
  assert.deepEqual(issuesFor(withRow, "native_farmhand_chat_v1"), ["dispatched_but_config_rejects"]);
});

test("a row a later stage declares is read without editing this gate", () => {
  // The population is the CALLS, not a list of stage names: `21bd3a46` introduced the table with three factories, and a
  // fourth must join the population by being written rather than by someone remembering to add it here.
  const report = checkStardewFixtureScenarioWiring({
    ...sources({ armed: ["a_v1"], rows: [] }),
    modEntrySource:
      '        NativeLocalFixtureScenarioRow.SomeLaterStage("a_v1", static (mod, fixture) => mod.Initialize("a_v1")),',
  });
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
  assert.equal(report.counts.rows, 1);
});

test("a row table this gate cannot read is refused instead of compared against nothing", () => {
  const report = checkStardewFixtureScenarioWiring({
    ...sources({ armed: ["a_v1"], rows: [] }),
    modEntrySource: "// no rows",
  });
  assert.equal(report.state, "failed");
  assert.deepEqual(
    report.violations.map((violation) => violation.issue),
    ["dispatcher_table_missing"],
  );
});

test("an armed population this gate cannot read is refused instead of compared against nothing", () => {
  const report = checkStardewFixtureScenarioWiring({
    ...sources({ armed: ["a_v1"] }),
    modConfigSource: 'string[] SomeOtherList = new[]\n{\n    "a_v1",\n};',
  });
  assert.equal(report.state, "failed");
  assert.deepEqual(
    report.violations.map((violation) => violation.issue),
    ["armed_scenarios_block_missing"],
  );
});

// The direction that hid `native_open_geode_v1`: the tools side asked for a
// scenario the Mod had never heard of, and the Mod-side loops stayed green
// because they only iterate Mod-side sets.
test("a scenario the tools side arms but the Mod has no scenario for is reported", () => {
  const report = checkStardewFixtureScenarioWiring(
    sources({ armed: ["a_v1"], rows: ["a_v1"], tools: ["a_v1", "native_geode_v1"] }),
  );
  assert.equal(report.state, "failed");
  assert.deepEqual(issuesFor(report, "native_geode_v1"), [
    "armed_by_the_tools_side_but_config_rejects",
    "armed_by_the_tools_side_but_no_recipe",
  ]);
});

test("a scenario the tools side arms and the Mod accepts is not reported", () => {
  // The green half of the same guard: without it, a checker that reports every
  // tools-side scenario would look identical on the red case.
  const report = checkStardewFixtureScenarioWiring(sources({ armed: ["a_v1", "b_v1"] }));
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
});

test("a tools-side scenario with a config entry but no recipe is named as the recipe gap", () => {
  const report = checkStardewFixtureScenarioWiring(
    sources({ armed: ["a_v1", "b_v1"], rows: ["a_v1"], tools: ["a_v1", "b_v1"] }),
  );
  assert.deepEqual(
    report.violations
      .filter((violation) => violation.scenario === "b_v1" && violation.issue.startsWith("armed_by_the_tools_side"))
      .map((violation) => violation.issue),
    ["armed_by_the_tools_side_but_no_recipe"],
  );
});

test("a missing fixtureScenario fails loudly instead of checking an empty population", () => {
  const report = checkStardewFixtureScenarioWiring({
    ...sources({ armed: ["a_v1"] }),
    fixtureLibrarySource: "export function somethingElse() {}",
  });
  assert.deepEqual(
    report.violations.filter((violation) => violation.issue === "tools_fixture_scenario_function_missing").length,
    1,
  );
});

test("the extractor reads the function's own returns and drops the empty answer", () => {
  const library = [
    "export function fixtureScenario(actions, action) {",
    '  if (action === "a") return "one_v1";',
    '  if (actions.includes("b")) return "two_v1";',
    '  return "";',
    "}",
    "export function other() {",
    '  return "not_a_scenario";',
    "}",
  ].join("\n");
  assert.deepEqual([...extractFixtureScenarioIds(library)].sort(), ["one_v1", "two_v1"]);
});

test("the declared-scenario reader keeps the move-only profile and reports absence as null", () => {
  // `""` is a scenario in these two arrays - the move-only profile, whose Given is the world as it loaded - and dropping
  // it made the gate report the config accepting a scenario no row declared. Absence must read as `null` rather than as an
  // empty set, or a renamed declaration would pass by having nothing to compare.
  const source =
    '    internal static readonly string[] NativeLocalFixtureScenarios = new[]\n    {\n        "", "a_v1",\n    };';
  assert.deepEqual([...extractDeclaredScenarios(source, "NativeLocalFixtureScenarios")].sort(), ["", "a_v1"]);
  assert.equal(extractDeclaredScenarios(source, "AnotherList"), null);
});

test("the row reader takes the scenario each factory names first", () => {
  const entry = [
    '        NativeLocalFixtureScenarioRow.Worldless("", null),',
    '        NativeLocalFixtureScenarioRow.Worldless("navigation_read_only_v1", null),',
    '        NativeLocalFixtureScenarioRow.ActorPrepared("native_till_soil_v1", static (mod, player, farm, _) => mod.Initialize("not_a_scenario")),',
  ].join("\n");
  assert.deepEqual([...extractScenarioRows(entry)].sort(), ["", "native_till_soil_v1", "navigation_read_only_v1"]);
});

test("the real armed set contains the scenarios whose runners exist", () => {
  // Regression guard for the exact incidents: both had runners and dispatch blocks yet were refused before arming.
  const armed = extractDeclaredScenarios(REAL_CONFIG, "NativeLocalFixtureScenarios");
  for (const scenario of ["native_clear_debris_resource_clump_v1", "native_refill_watering_can_v1"]) {
    assert.ok(armed.has(scenario), `${scenario} must be in the armed population`);
  }
});

test("the real config gate accepts navigation_read_only_v1", () => {
  // It has a row, a dedicated direct gate, a smoke runner and a replay test, so a config gate that rejected it silently
  // disabled all of them.
  assert.ok(extractDeclaredScenarios(REAL_CONFIG, "NativeLocalFixtureScenarios").has("navigation_read_only_v1"));
});

test("the retired tree_first_hit fixture scenario is gone", () => {
  // `tree_first_hit` is a retired action (the Host schema pins it as unknown_action). Keeping a fixture scenario for it
  // meant config accepted a scenario that provisions nothing.
  assert.equal(
    extractDeclaredScenarios(REAL_CONFIG, "NativeLocalFixtureScenarios").has("native_tree_first_hit_v1"),
    false,
  );
  assert.equal(extractScenarioRows(REAL_ENTRY).has("native_tree_first_hit_v1"), false);
});
