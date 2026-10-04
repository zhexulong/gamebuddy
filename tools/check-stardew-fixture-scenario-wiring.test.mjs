import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkStardewFixtureScenarioWiring, extractPreAttachmentAllowlist } from "./check-stardew-fixture-scenario-wiring.mjs";

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

/** A minimal pair of sources with the three lists under our control. */
function sources({ known, allowlist = known, dispatch = known, preAllowlist = [] }) {
  const list = (names) => names.map((n) => `"${n}"`).join(" or ");
  const entry = [
    ...preAllowlist.map((n) => `if (fixture.FixtureScenario == "${n}") { return; }`),
    `if (fixture.FixtureScenario is not (${list(allowlist)}) || Game1.player is null) { return; }`,
    ...dispatch.map((n) => `if (fixture.FixtureScenario == "${n}") { /* recipe */ }`),
  ].join("\n");
  const config = `KnownFixtureScenarios = new[]\n{\n    "", ${known.map((n) => `"${n}"`).join(", ")},\n};`;
  return { modEntrySource: entry, modConfigSource: config };
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
  const report = checkStardewFixtureScenarioWiring(
    sources({ known: ["a_v1", "b_v1"], allowlist: ["a_v1", "b_v1"], dispatch: ["a_v1"] }),
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
    report.violations.filter((v) => v.scenario === "ghost_v1").map((v) => v.issue).sort(),
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

test("the `is \"X\"` dispatcher spelling is recognised", () => {
  // Some blocks are written as `FixtureScenario is "x"` (pattern matching) rather
  // than `==`. Missing that spelling made the checker report false positives.
  const entry = [
    'if (fixture.FixtureScenario is not ("a_v1" or "b_v1")) { return; }',
    'if (fixture.FixtureScenario is "a_v1") { }',
    'if (fixture.FixtureScenario is "b_v1") { }',
  ].join("\n");
  const config = 'KnownFixtureScenarios = new[]\n{\n    "", "a_v1", "b_v1",\n};';
  const report = checkStardewFixtureScenarioWiring({ modEntrySource: entry, modConfigSource: config });
  assert.equal(report.state, "passed", JSON.stringify(report.violations, null, 2));
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
