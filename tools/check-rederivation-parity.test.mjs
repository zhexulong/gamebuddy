// Tests for the re-derivation parity gate.
//
// The mutations run against the REAL registry and the REAL sources, copied in memory and edited, so a passing suite
// proves the checker is decisive about the thing it ships with - and the pre-fix reader is replayed from the revision it
// shipped at rather than described here.
//
// red-proof: inject  the footprint entry's `parityTest` deleted from the registry -> `rederivation_without_parity:
//   Tool.tilesAffected:<our site>`, asserted by "a declared entry with no parity test"
//   (tools/check-rederivation-parity.test.mjs)
// red-proof: history  the fifth `GetChance` argument as it shipped at e882b765, bound once outside the row loop, is
//   named at `integrations/stardew/FishingCatchableQuery.cs:190` - the argument's own line, not the call's - by
//   "the pre-fix reader" (tools/check-rederivation-parity.test.mjs)
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  blankNonCode,
  checkRederivationParity,
  iterationVariables,
  REGISTRY_PATH,
  reachesIteration,
} from "./check-rederivation-parity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceOf = (relativePath) => readFileSync(path.join(root, relativePath), "utf8");
const registry = () => JSON.parse(sourceOf(REGISTRY_PATH)).entries;
const withEntry = (id, change) => registry().map((entry) => (entry.id === id ? { ...entry, ...change } : entry));
const codes = (report) => report.findings.map((finding) => `${finding.code}:${finding.detail}`);

const FOOTPRINT = "tool-footprint-ladder";
const FOOTPRINT_SITE = "host/src/body-program-packing.ts";
const FOOTPRINT_PARITY =
  "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/ToolFootprintTableParityTests.cs";
const READER = "integrations/stardew/FishingCatchableQuery.cs";
const PRE_FIX_REVISION = "e882b765";

test("every declared re-derivation names a site that still exists and the engine members are counted", () => {
  const report = checkRederivationParity();
  const entries = registry();

  assert.ok(entries.length > 0, "the registry must declare something, or the gate agrees with itself");
  assert.equal(report.examined.declared, entries.length);
  assert.equal(
    report.examined.engineMembers,
    new Set(entries.map((entry) => entry.engineMember)).size,
    "engine members are the registry's own distinct count, never a second list",
  );
  assert.equal(
    report.examined.withParity + report.examined.withoutParity,
    report.examined.declared,
    "each declared entry is exactly one of proven or owed",
  );
  assert.ok(report.examined.callSites > 0, "a declared per-iteration argument with no call site would measure nothing");
  assert.deepEqual(
    report.findings.filter((finding) =>
      ["rederivation_site_missing", "rederivation_duplicate", "rederivation_parity_not_a_test"].includes(finding.code),
    ),
    [],
    "the registry's own entries must resolve: an anchor that no longer appears is a finding, not a stale row",
  );
  assert.deepEqual(
    [...new Set(report.findings.map((finding) => finding.code))].sort(),
    [...new Set(report.findings.map((finding) => finding.code))]
      .sort()
      .filter((code) =>
        [
          "rederivation_without_parity",
          "rederivation_undeclared",
          "rederivation_parity_not_a_test",
          "rederivation_site_missing",
          "rederivation_duplicate",
          "rederivation_argument_not_read",
        ].includes(code),
      ),
    "a finding shape nobody declared here is a finding in itself",
  );
});

test("a declared entry with no parity test is named by engine member and site", () => {
  // RED PROOF 1, on the registry's own record: the footprint entry is the one entry with a real engine-driven parity
  // test, so dropping it must red the run and name `Tool.tilesAffected` rather than a count.
  const report = checkRederivationParity({ registry: withEntry(FOOTPRINT, { parityTest: null }) });

  assert.equal(report.verdict, "blocked");
  assert.ok(
    codes(report).includes(`rederivation_without_parity:Tool.tilesAffected:${FOOTPRINT_SITE}`),
    `the finding must name the member and our site: ${codes(report).join(", ")}`,
  );
  assert.equal(
    report.examined.withParity,
    checkRederivationParity().examined.withParity - 1,
    "the proven count drops by exactly the entry that lost its test",
  );
});

test("a parity test that names the member only in prose or a string is not a parity test", () => {
  // The tree has pins of this shape - `ScytheSweepTests` asserts `handler.Should().Contain(".DoDamage(")` - so a
  // substring match would let a source-shape pin stand in for a call. Renaming the CALL and keeping the prose must red.
  const narrowed = sourceOf(FOOTPRINT_PARITY).replace(/this\.tilesAffected\(/gu, "this.FootprintProbe(");
  assert.notEqual(
    narrowed,
    sourceOf(FOOTPRINT_PARITY),
    "the mutation must change the file, or the case proves nothing",
  );
  const report = checkRederivationParity({ overrides: { [FOOTPRINT_PARITY]: narrowed } });

  assert.equal(report.verdict, "blocked");
  assert.ok(
    codes(report).some(
      (code) =>
        code.startsWith(`rederivation_without_parity:Tool.tilesAffected:${FOOTPRINT_SITE}`) &&
        code.includes("never calls tilesAffected outside comments and strings"),
    ),
    `a member named in a comment is not a call: ${codes(report).join(", ")}`,
  );
});

test("a parity test that is not a test file is refused by name", () => {
  const report = checkRederivationParity({
    registry: withEntry(FOOTPRINT, { parityTest: { path: FOOTPRINT_SITE, member: "tilesAffected" } }),
  });

  assert.ok(
    codes(report).includes(`rederivation_parity_not_a_test:Tool.tilesAffected:${FOOTPRINT_SITE} (${FOOTPRINT_SITE})`),
    `a product file cannot be its own parity test: ${codes(report).join(", ")}`,
  );
});

test("the pre-fix reader is named at the argument's own line, and the fixed shape passes", () => {
  // RED PROOF 2, on real history: the reader as it shipped at e882b765 computed the fifth argument once, outside the
  // row loop, while the engine binds `spawn.ItemId == text` per row (GameLocation.cs:13969). The finding must land on
  // the ARGUMENT line, so a reader is sent to the value that is wrong rather than to the call that carries it.
  const preFix = execFileSync("git", ["show", `${PRE_FIX_REVISION}:${READER}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const replayed = checkRederivationParity({ overrides: { [READER]: preFix } });
  const undeclared = replayed.findings.filter((finding) => finding.code === "rederivation_undeclared");

  assert.equal(undeclared.length, 1, `one hoisted argument, one finding: ${codes(replayed).join(", ")}`);
  const reported = preFix.split(/\r?\n/)[Number(undeclared[0].detail.split(":").at(-1)) - 1];
  assert.match(
    reported ?? "",
    /^\s*usingTargetBait\),?\s*$/u,
    `the finding must land on the argument itself, not on the call three lines above it: ${undeclared[0].detail} is ${JSON.stringify(reported)}`,
  );
  assert.match(
    preFix,
    /\bbool usingTargetBait\)/u,
    "the hoisted value is the projection method's own parameter, so the scan followed the binding to the loop - a name " +
      "match would have found the declaration and called it per-row",
  );

  // The inverse: the same file with the argument derived from the row passes, so the rule is about the VALUE and not
  // about the member being called at all.
  const fixed = preFix.replace(
    /^(?<indent>\s*)usingTargetBait\),?$/mu,
    "$<indent>string.Equals(row.ItemId, string.Empty, StringComparison.Ordinal)),",
  );
  assert.notEqual(fixed, preFix, "the mutation must change the file, or the inverse proves nothing");
  const repaired = checkRederivationParity({ overrides: { [READER]: fixed } });
  assert.deepEqual(
    repaired.findings.filter((finding) => finding.code === "rederivation_undeclared"),
    [],
    "a per-row argument is the shape the engine itself uses",
  );
});

test("a hoisted value is caught even when the expression is written inline at the call site", () => {
  // The rule is provenance, not a name match: an argument that is an expression rather than a variable is still
  // loop-invariant when nothing it reads is the loop's element. This is the shape a "bare identifier" rule would miss.
  const scratch = READER.replace("FishingCatchableQuery", "ScratchRederivation");
  const sample = [
    "internal static class ScratchRederivationQuery",
    "{",
    "    private static void Read(Farmer player, GameLocation location, List<SpawnFishData> rows)",
    "    {",
    "        bool curiosityLure = false;",
    "        foreach (SpawnFishData row in rows)",
    "        {",
    "            double chance = row.GetChance(",
    "                curiosityLure,",
    "                player.DailyLuck,",
    "                player.LuckLevel,",
    "                (float value, IList<QuantityModifier> modifiers, QuantityModifier.QuantityModifierMode mode) =>",
    "                    Utility.ApplyQuantityModifiers(value, modifiers, mode, location),",
    '                player.CurrentTool is FishingRod && player.CurrentTool.QualifiedItemId == "(O)685");',
    "        }",
    "    }",
    "}",
    "",
  ].join("\n");
  const loopVariables = iterationVariables(blankNonCode(sample));
  assert.ok(!loopVariables.has("player"), "the loop's element is `row`; `player` is not per-iteration");
  assert.equal(
    reachesIteration({
      source: blankNonCode(sample),
      expression: 'player.CurrentTool is FishingRod && player.CurrentTool.QualifiedItemId == "(O)685"',
      loopVariables,
    }),
    false,
    "a value that reads no loop variable is loop-invariant",
  );

  const report = checkRederivationParity({ overrides: { [scratch]: sample } });
  assert.ok(
    report.findings.some((finding) => finding.code === "rederivation_undeclared" && finding.detail === `${scratch}:14`),
    `the inline hoisted expression must be named at its own line: ${codes(report).join(", ")}`,
  );
});

test("a declared argument whose invocation the scan cannot find measures nothing and is refused", () => {
  // "zero call sites" is not a clean site: the same shape as a gate that passes over an empty population. The scan is
  // pointed at a tree that cannot contain the call, and the declaration is named rather than believed.
  const report = checkRederivationParity({
    registry: withEntry("fishing-chance-targeted-bait", { scan: "host/src" }),
  });

  assert.equal(report.verdict, "blocked");
  assert.ok(
    codes(report).includes(
      "rederivation_site_missing:fishing-chance-targeted-bait: no GetChance invocation under host/src",
    ),
    `a scan that found nothing must say so: ${codes(report).join(", ")}`,
  );
});

test("a registry that measured nothing is refused rather than passed", () => {
  const report = checkRederivationParity({ registry: [] });

  assert.equal(report.examined.declared, 0);
  assert.equal(report.verdict, "blocked");
  const cli = spawnSync(process.execPath, [path.join("tools", "check-rederivation-parity.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
  assert.ok(
    /rederivations examined \d+ · with a parity test \d+ · engine members \d+/u.test(cli.stdout),
    `the population is printed on every run: ${cli.stdout}`,
  );
  assert.equal(
    cli.status,
    /rederivation_parity\/v1: passed/u.test(cli.stdout) ? 0 : 1,
    "the exit code is the verdict that was printed, not a second opinion",
  );
});
