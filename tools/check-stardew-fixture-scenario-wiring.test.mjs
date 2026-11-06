import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkStardewFixtureScenarioWiring,
  extractFixtureScenarioIds,
  extractPreAttachmentAllowlist,
} from "./check-stardew-fixture-scenario-wiring.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
// ModEntry is a partial class: the pre-attachment allowlist and the dispatcher
// live in ModEntry.Fixtures.cs (and the per-slot partials), not ModEntry.cs.
const REAL_ENTRY = fs
  .readdirSync(path.join(root, "integrations/stardew"))
  .filter((name) => /^ModEntry(\..+)?\.cs$/.test(name))
  .sort()
  .map((name) => fs.readFileSync(path.join(root, "integrations/stardew", name), "utf8"))
  .join("\n");
const REAL_CONFIG = fs.readFileSync(path.join(root, "integrations/stardew/ModConfig.cs"), "utf8");

/**
 * A minimal pair of sources with the three lists under our control, plus the
 * tools-side declaration of which scenario a run asks for.
 *
 * `tools` defaults to the same set the config gate knows, so a test that is about
 * a Mod-side list keeps its violation list to that list alone. A test about the
 * tools -> Mod direction passes its own `tools`.
 */
function sources({ known, allowlist = known, dispatch = known, preAllowlist = [], tools = known }) {
  const list = (names) => names.map((n) => `"${n}"`).join(" or ");
  const entry = [
    ...preAllowlist.map((n) => `if (fixture.FixtureScenario == "${n}") { return; }`),
    `if (fixture.FixtureScenario is not (${list(allowlist)}) || Game1.player is null) { return; }`,
    ...dispatch.map((n) => `if (fixture.FixtureScenario == "${n}") { /* recipe */ }`),
  ].join("\n");
  const config = `KnownFixtureScenarios = new[]\n{\n    "", ${known.map((n) => `"${n}"`).join(", ")},\n};`;
  const library = [
    "export function fixtureScenario(actions, action) {",
    ...tools.map((n) => `  if (action === "${n}") return "${n}";`),
    '  return "";',
    "}",
  ].join("\n");
  return { modEntrySource: entry, modConfigSource: config, fixtureLibrarySource: library };
}

test("the real repository wiring is consistent", () => {
  const report = checkStardewFixtureScenarioWiring();
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
  assert.equal(report.violations.length, 0);
});

test("a scenario accepted by config but refused before arming is reported", () => {
  const report = checkStardewFixtureScenarioWiring(
    sources({ known: ["a_v1", "b_v1"], allowlist: ["a_v1"], dispatch: ["a_v1", "b_v1"] }),
  );
  assert.equal(report.state, "failed");
  assert.deepEqual(
    report.violations.filter((v) => v.scenario === "b_v1").map((v) => v.issue),
    ["accepted_by_config_but_refused_before_arming"],
  );
});

test("a scenario with no dispatcher block is reported as armed without a recipe", () => {
  // `tools: ["a_v1"]` keeps the tools -> Mod direction out of this assertion: the
  // property under test is the Mod-side list, and b_v1 is deliberately a scenario
  // no run asks for here.
  const report = checkStardewFixtureScenarioWiring(
    sources({ known: ["a_v1", "b_v1"], allowlist: ["a_v1", "b_v1"], dispatch: ["a_v1"], tools: ["a_v1"] }),
  );
  assert.deepEqual(
    report.violations.filter((v) => v.scenario === "b_v1").map((v) => v.issue),
    ["armed_without_a_recipe"],
  );
});

test("an allowlisted scenario the config gate rejects is reported", () => {
  const report = checkStardewFixtureScenarioWiring(
    sources({ known: ["a_v1"], allowlist: ["a_v1", "ghost_v1"], dispatch: ["a_v1", "ghost_v1"] }),
  );
  assert.deepEqual(
    report.violations
      .filter((v) => v.scenario === "ghost_v1")
      .map((v) => v.issue)
      .sort(),
    ["allowlisted_but_config_rejects", "dispatched_but_config_rejects"],
  );
});

test("a scenario handled by an earlier returning block may be absent from the allowlist", () => {
  // navigation_read_only_v1 and native_express_emote_v1 take this shape: the
  // dispatch block runs before the allowlist check and returns, so absence from
  // the allowlist is correct rather than a gap.
  const report = checkStardewFixtureScenarioWiring(
    sources({
      known: ["early_v1", "a_v1"],
      allowlist: ["a_v1"],
      dispatch: ["early_v1", "a_v1"],
      preAllowlist: ["early_v1"],
    }),
  );
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
});

test('the `is "X"` dispatcher spelling is recognised', () => {
  // Some blocks are written as `FixtureScenario is "x"` (pattern matching) rather
  // than `==`. Missing that spelling made the checker report false positives.
  const entry = [
    'if (fixture.FixtureScenario is not ("a_v1" or "b_v1")) { return; }',
    'if (fixture.FixtureScenario is "a_v1") { }',
    'if (fixture.FixtureScenario is "b_v1") { }',
  ].join("\n");
  const config = 'KnownFixtureScenarios = new[]\n{\n    "", "a_v1", "b_v1",\n};';
  const library = 'export function fixtureScenario(actions, action) {\n  return "";\n}';
  const report = checkStardewFixtureScenarioWiring({
    modEntrySource: entry,
    modConfigSource: config,
    fixtureLibrarySource: library,
  });
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
});

// The direction that hid `native_open_geode_v1`: the tools side asked for a
// scenario the Mod had never heard of, and the three Mod-side loops stayed green
// because they only iterate Mod-side sets.
test("a scenario the tools side arms but the Mod has no scenario for is reported", () => {
  const report = checkStardewFixtureScenarioWiring(sources({ known: ["a_v1"], tools: ["a_v1", "native_geode_v1"] }));
  assert.equal(report.state, "failed");
  assert.deepEqual(
    report.violations
      .filter((v) => v.scenario === "native_geode_v1")
      .map((v) => v.issue)
      .sort(),
    ["armed_by_the_tools_side_but_config_rejects", "armed_by_the_tools_side_but_no_recipe"],
  );
});

test("a scenario the tools side arms and the Mod accepts is not reported", () => {
  // The green half of the same guard: without it, a checker that reports every
  // tools-side scenario would look identical on the red case.
  const report = checkStardewFixtureScenarioWiring(sources({ known: ["a_v1", "b_v1"] }));
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
});

test("a tools-side scenario with a config entry but no recipe is named as the recipe gap", () => {
  const report = checkStardewFixtureScenarioWiring(
    sources({ known: ["a_v1", "b_v1"], allowlist: ["a_v1", "b_v1"], dispatch: ["a_v1"], tools: ["a_v1", "b_v1"] }),
  );
  assert.deepEqual(
    report.violations
      .filter((v) => v.scenario === "b_v1" && v.issue.startsWith("armed_by_the_tools_side"))
      .map((v) => v.issue),
    ["armed_by_the_tools_side_but_no_recipe"],
  );
});

test("a missing fixtureScenario fails loudly instead of checking an empty population", () => {
  const report = checkStardewFixtureScenarioWiring({
    ...sources({ known: ["a_v1"] }),
    fixtureLibrarySource: "export function somethingElse() {}",
  });
  assert.deepEqual(report.violations.filter((v) => v.issue === "tools_fixture_scenario_function_missing").length, 1);
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

test("the allowlist group is cut at the first paren outside a string literal", () => {
  // A literal may contain a `)`. Cutting at indexOf(")") truncates the list and
  // makes every later scenario look missing.
  const entry = 'if (fixture.FixtureScenario is not ("alpha(1)_v1" or "beta_v1")) { return; }';
  const group = extractPreAttachmentAllowlist(entry);
  assert.ok(group);
  assert.deepEqual(
    [...group.body.matchAll(/"([^"]+)"/g)].map((m) => m[1]),
    ["alpha(1)_v1", "beta_v1"],
  );
});

test("the real allowlist contains the scenarios whose runners exist", () => {
  // Regression guard for the exact incidents: both had runners and dispatch
  // blocks yet were refused before arming.
  const group = extractPreAttachmentAllowlist(REAL_ENTRY);
  assert.ok(group);
  for (const scenario of ["native_clear_debris_resource_clump_v1", "native_refill_watering_can_v1"]) {
    assert.ok(group.body.includes(`"${scenario}"`), `${scenario} must be in the pre-attachment allowlist`);
  }
});

test("the real config gate accepts navigation_read_only_v1", () => {
  // It has a dispatch block, a dedicated direct gate, a smoke runner and a replay
  // test, so a config gate that rejected it silently disabled all of them.
  const start = REAL_CONFIG.indexOf("KnownFixtureScenarios = new[]");
  const end = REAL_CONFIG.indexOf("};", start);
  assert.ok(REAL_CONFIG.slice(start, end).includes('"navigation_read_only_v1"'));
});

test("the retired tree_first_hit fixture scenario is gone", () => {
  // `tree_first_hit` is a retired action (the Host schema pins it as
  // unknown_action). Keeping a fixture scenario for it meant config accepted a
  // scenario that provisions nothing.
  const start = REAL_CONFIG.indexOf("KnownFixtureScenarios = new[]");
  const end = REAL_CONFIG.indexOf("};", start);
  assert.ok(!REAL_CONFIG.slice(start, end).includes('"native_tree_first_hit_v1"'));
});
