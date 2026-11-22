export const gateDeclaration = {
  id: "check-stardew-fixture-scenario-wiring",
  domain: "stardew",
  tier: "l0",
  kind: "contract",
};

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseKnownFixtureScenarios } from "../../tools/prelive.mjs";

/**
 * Fixture-scenario wiring parity across the Mod's declarations AND the tools side's declaration of which scenario a run
 * will arm.
 *
 * To be runnable an armed scenario must be named in two places, and a known scenario must be explained by one of them:
 *   1. `NativeLocalPlayerFixtureConfig.NativeLocalFixtureScenarios` (`ModConfig.cs`) -- the ARMED universe. A scenario
 *      outside it is refused by `IsValid` before anything runs.
 *   2. `NativeLocalFixtureScenarioRows` (`ModEntry.Fixtures.ScenarioInitializers.cs`) -- one row per scenario, declaring
 *      the stage its Given runs in and the initializer that builds it. `TryInitializeNativeLocalPlayerFixtureScenario`
 *      refuses a scenario with no row, which is why a member of (1) with no row is a run that config accepts and the
 *      dispatcher rejects.
 * plus `HostAutomationFixtureSaveScenarios`, the two scenarios whose Given the HOST-AUTOMATION dispatcher owns: they are
 * accepted when this fixture creates the disposable save and refused when it arms, so their absence from the row table
 * is declared intent rather than a gap.
 *
 * WHAT THIS GATE READ UNTIL `21bd3a46`, and why the reading changed. It used to check three hand-written lists - the
 * config set, a `FixtureScenario is not (...)` pre-attachment allowlist, and an `if (fixture.FixtureScenario == "X")`
 * chain in `ModEntry.Fixtures.cs`. That refactor replaced the allowlist and the chain with the row table, because the
 * chain's LAST branch carried no guard: a scenario nobody had written a branch for silently built the `else` world
 * (arming `native_farmhand_chat_v1` created dry unwatered crops and logged a water-crop initialisation). The table
 * refuses instead, so this gate reads the table: the expectation - a scenario the config accepts must be one the
 * dispatcher can build, and a scenario the dispatcher can build must be one the config accepts - is unchanged, and only
 * the mechanism that carries it moved. `armed_without_a_recipe` retired with the chain: a row whose stage and initializer
 * shape disagree is refused by `FoldNativeLocalFixtureScenarioDeclarations` at start-up, so "arms and provisions
 * nothing" is no longer a state this tree can reach.
 *
 * THE TOOLS -> MOD DIRECTION, and the gap that added it: the tools side decides which scenario id a run asks for
 * (`fixtureScenario` in `tools/lib/stardew-native-local-player-fixture.mjs`), and nothing checked that the Mod had ever
 * heard of that id. `native_open_geode_v1` was returned by the tools function, shipped in a runner and in the
 * action-gate descriptor, and was absent from the Mod's declarations - so the Mod rejected its own configuration at
 * launch and the fixture ticked forever with no bridge. The population for that direction is DERIVED from the tools
 * function's own `return` literals: a hand-written copy of the scenario names here would be a second authority that
 * drifts from the function that actually decides.
 *
 * The known set is read by `parseKnownFixtureScenarios` in `tools/prelive.mjs`, which resolves the DERIVED initializer
 * `KnownFixtureScenarios = NativeLocalFixtureScenarios.Concat(HostAutomationFixtureSaveScenarios).ToArray()` that
 * `21bd3a46` introduced. That reader is shared with `tools/check-stardew-promotion-parity.mjs` and prelive's own ladder:
 * this gate was the only one of the four readers of that declaration that still looked for a literal block, so it
 * reported `known_scenarios_block_missing` on a tree whose wiring was fine.
 *
 * red-proof: inject  one `native_*_v1` id renamed in `ModConfig.NativeLocalFixtureScenarios` ->
 *                    `"state":"failed"` with `{"issue":"accepted_by_config_but_refused_before_arming",
 *                    "scenario":"native_removed_for_the_proof_v1"}` (config accepts an armed run whose scenario the
 *                    dispatcher has no row for) plus `dispatched_but_config_rejects` for the rename's other half, exit 1;
 *                    the unmodified tree reports `"state":"passed"` with `"known":120`, `"armed":119`, `"rows":119` and no
 *                    violations, exit 0 (tools/check-stardew-fixture-scenario-wiring.mjs)
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, "..");
const MOD_CONFIG = path.join(repositoryRoot, "integrations/stardew/ModConfig.cs");
/**
 * ModEntry is a partial class: the row table lives in ModEntry.Fixtures.ScenarioInitializers.cs and the dispatch that
 * reads it in ModEntry.Fixtures.cs, so every partial is concatenated rather than one file being read.
 */
const MOD_ENTRY_PARTIALS = fs
  .readdirSync(path.join(repositoryRoot, "integrations/stardew"))
  .filter((name) => /^ModEntry(\..+)?\.cs$/.test(name))
  .sort()
  .map((name) => path.join(repositoryRoot, "integrations/stardew", name));
/**
 * The tools-side authority for "which scenario will this run arm".
 */
const FIXTURE_LIBRARY = path.join(repositoryRoot, "tools/lib/stardew-native-local-player-fixture.mjs");

/** The row type whose static factories each name one scenario. */
const SCENARIO_ROW_TYPE = "NativeLocalFixtureScenarioRow";

function readModEntryPartials() {
  return MOD_ENTRY_PARTIALS.map((file) => fs.readFileSync(file, "utf8")).join("\n");
}

/** Double-quoted string literals of a source slice. */
function quoted(source) {
  return [...source.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
}

/**
 * One `string[] NAME = new[] { ... }` declaration's literals, or `null` when the file declares no such array.
 *
 * The empty string is KEPT: for these two declarations it is a scenario like any other - the move-only profile, whose
 * Given is the world as it loaded - and both the armed config and the row table carry it. (The tools side uses `""`
 * for something else, "this action needs no fixture world", which is why that population drops it instead.)
 *
 * `null` is not "empty": the caller reports it by name, because a population this gate cannot find is a reading it must
 * refuse rather than a population with nothing in it.
 */
export function extractDeclaredScenarios(source, name) {
  const declaration = new RegExp(`string\\[\\]\\s+${name}\\s*=\\s*new(?:\\s+string)?\\s*\\[\\s*\\]`, "u").exec(source);
  if (declaration === null) return null;
  const open = source.indexOf("{", declaration.index + declaration[0].length);
  const close = source.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  return new Set(quoted(source.slice(open, close)));
}

/**
 * Every scenario the row table declares, read from the factories that name one.
 *
 * The population is the CALLS, not a list of stages: `NativeLocalFixtureScenarioRow.<AnyFactory>("<scenario>", ...)`.
 * A stage added later joins without editing this gate, and a row moved to a shape that does not name its scenario first
 * fails as a scenario the config accepts with no row - loudly, and on the right side of the comparison.
 */
export function extractScenarioRows(entry) {
  const rows = new Set();
  const pattern = new RegExp(`\\b${SCENARIO_ROW_TYPE}\\.[A-Z][A-Za-z0-9_]*\\(\\s*"((?:[^"\\\\]|\\\\.)*)"`, "gu");
  for (const match of entry.matchAll(pattern)) rows.add(match[1]);
  return rows;
}

/**
 * Every scenario id the tools side can ask for: the `return` literals of
 * `fixtureScenario`. `""` is the deliberate "this action needs no fixture world"
 * answer, not a scenario, so it is dropped.
 *
 * The slice ends at the first `\n}` - the function's own closing brace at column
 * zero. Its body is the only part of the module with no column-zero brace inside
 * it, and a missing function returns `null` so the caller fails loudly instead of
 * checking an empty population.
 */
export function extractFixtureScenarioIds(librarySource) {
  const start = librarySource.indexOf("export function fixtureScenario(");
  if (start < 0) return null;
  const end = librarySource.indexOf("\n}", start);
  if (end < 0) return null;
  return new Set(
    [...librarySource.slice(start, end).matchAll(/return\s+"([^"]*)"/g)]
      .map((match) => match[1])
      .filter((name) => name.length > 0),
  );
}

export function checkStardewFixtureScenarioWiring({ modEntrySource, modConfigSource, fixtureLibrarySource } = {}) {
  const entry = modEntrySource ?? readModEntryPartials();
  const config = modConfigSource ?? fs.readFileSync(MOD_CONFIG, "utf8");
  const library = fixtureLibrarySource ?? fs.readFileSync(FIXTURE_LIBRARY, "utf8");

  const violations = [];
  const add = (issue, scenario, detail) => violations.push({ issue, scenario, detail });
  const refuse = (issue, detail) => ({ state: "failed", violations: [{ issue, detail }] });

  const armed = extractDeclaredScenarios(config, "NativeLocalFixtureScenarios");
  if (armed === null) {
    return refuse(
      "armed_scenarios_block_missing",
      "ModConfig declares no `string[] NativeLocalFixtureScenarios = new[]` array, so the armed population was not read and no wiring was checked",
    );
  }
  const hostAutomation = extractDeclaredScenarios(config, "HostAutomationFixtureSaveScenarios");
  if (hostAutomation === null) {
    return refuse(
      "host_automation_scenarios_block_missing",
      "ModConfig declares no `string[] HostAutomationFixtureSaveScenarios = new[]` array, so the scenarios another dispatcher owns were not read and their absence from the row table could not be told from a gap",
    );
  }
  let known;
  try {
    known = parseKnownFixtureScenarios(config);
  } catch (error) {
    return refuse(
      "known_scenarios_block_missing",
      `ModConfig's KnownFixtureScenarios was not readable as a scenario set, so no wiring was checked: ${error.message}`,
    );
  }
  const rows = extractScenarioRows(entry);
  if (rows.size === 0) {
    return refuse(
      "dispatcher_table_missing",
      `no \`${SCENARIO_ROW_TYPE}.<Factory>("<scenario>", ...)\` row was found in the ModEntry partials, so the dispatcher population was not read and no comparison was made`,
    );
  }

  // The armed direction. `IsValid` accepts a scenario from this set, and the dispatch refuses one with no row, so a
  // member here without a row is a configuration the Mod accepts and then cannot build.
  for (const scenario of armed) {
    if (rows.has(scenario)) continue;
    add(
      "accepted_by_config_but_refused_before_arming",
      scenario,
      "in NativeLocalFixtureScenarios (so the armed config accepts it) but the row table has no initializer for it, which is a configuration the Mod refuses before any Given runs",
    );
  }
  // The other direction: a row the config refuses is a world no configuration can ask for.
  for (const scenario of rows) {
    if (armed.has(scenario)) continue;
    add(
      "dispatched_but_config_rejects",
      scenario,
      "the row table declares an initializer for it but NativeLocalFixtureScenarios omits it, so IsValid refuses the configuration before dispatch is reached",
    );
  }
  // Every scenario the config calls known must be explained by one of the two populations: the armed universe it can
  // build, or the host-automation dispatcher whose Given it only creates the save for.
  for (const scenario of known) {
    if (armed.has(scenario) || hostAutomation.has(scenario)) continue;
    add(
      "known_scenario_outside_both_populations",
      scenario,
      "KnownFixtureScenarios lists it but it is neither in NativeLocalFixtureScenarios (which has an initializer) nor in HostAutomationFixtureSaveScenarios (whose Given another dispatcher owns), so nothing in this Mod can build its world",
    );
  }

  // The tools -> Mod direction. A scenario the tools side can return but the Mod
  // has never heard of is not a missing test: it is a run that arms nothing and
  // ticks forever, because the Mod rejects its own configuration before the
  // bridge opens. Both Mod-side facts are named separately, because each one is a
  // different fix and a reader needs to know which is missing.
  const toolsScenarios = extractFixtureScenarioIds(library);
  if (toolsScenarios === null) {
    add(
      "tools_fixture_scenario_function_missing",
      null,
      "fixtureScenario was not found in the tools fixture library, so the tools -> Mod direction checked nothing",
    );
  } else {
    for (const scenario of toolsScenarios) {
      if (!known.has(scenario)) {
        add(
          "armed_by_the_tools_side_but_config_rejects",
          scenario,
          "fixtureScenario returns it but KnownFixtureScenarios omits it, so the Mod rejects its own configuration at launch and never opens the bridge",
        );
      }
      if (!rows.has(scenario)) {
        add(
          "armed_by_the_tools_side_but_no_recipe",
          scenario,
          "fixtureScenario returns it but the row table has no initializer for it, so it arms and provisions nothing",
        );
      }
    }
  }

  return {
    state: violations.length === 0 ? "passed" : "failed",
    counts: {
      known: known.size,
      armed: armed.size,
      hostAutomation: hostAutomation.size,
      rows: rows.size,
      tools: toolsScenarios?.size ?? 0,
    },
    violations,
  };
}

if (import.meta.main) {
  const report = checkStardewFixtureScenarioWiring();
  console.log(JSON.stringify(report, null, 2));
  if (report.state !== "passed") process.exitCode = 1;
}
