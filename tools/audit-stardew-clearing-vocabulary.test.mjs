// Falsifier suite for the clearing-vocabulary gate.
//
// The gate is the property - "every word the world publishes for what stands on a tile is either cleared by a published
// action or declared unclearable with a reason" - so what matters is that it goes RED FOR THE RIGHT MEMBER and GREEN
// when the crossing is complete, in BOTH directions. Each case below is one member of the class:
//
//   * a published word no declaration answers (`object` in `round58`, refused 11 times as
//     `no_published_action_clears:object`);
//   * a clearer for a word nothing publishes (a `Clears` entry nobody can aim);
//   * one word declared both ways (two meanings, one spelling);
//   * "not clearable" with no reason (the silence the declaration replaces);
//   * a declared vocabulary and the classifier's own returns disagreeing;
//   * a future member: a word the classifier starts returning tomorrow, which no declaration answers yet.
//
// The gate's red proof is declared in `tools/audit-stardew-clearing-vocabulary.mjs`, not restated here: a `history`
// reading of `0dce992a`, where the same gate code named `object`, `resource_clump` and `terrain` and exited 1.
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkStardewClearingVocabulary,
  clearedKinds,
  constantsIn,
  declaredKinds,
  judge,
  publishedWords,
  unclearableKinds,
} from "./audit-stardew-clearing-vocabulary.mjs";

/** One population, as the judge reads it: `Map` of word -> where it came from. */
const words = (...kinds) => new Map(kinds.map((kind) => [kind, "probe"]));

const judgeOf = (overrides = {}) =>
  judge({
    published: words("none", "stone", "weed", "object"),
    cleared: new Map([
      ["stone", []],
      ["weed", []],
    ]),
    unclearable: new Map([["object", "an object no published action opens a route through"]]),
    freeTile: "none",
    declared: null,
    ...overrides,
  });

test("published_kind_no_action_clears: a word neither cleared nor declared unclearable is named", () => {
  const verdict = judgeOf({ unclearable: new Map() });

  assert.equal(verdict.verdict, "failed");
  assert.deepEqual(verdict.findings, ["published_kind_no_action_clears:object"]);
  assert.deepEqual(verdict.counts, { published: 3, cleared: 2, unclearable: 0 });
});

test("the free-tile word is not a kind: `none` needs no clearer and is not counted as published", () => {
  const verdict = judgeOf();

  assert.equal(verdict.verdict, "passed", verdict.findings.join(" "));
  assert.equal(
    verdict.published.includes("none"),
    false,
    "the absence of an occupant is not something an action clears",
  );
  assert.equal(verdict.counts.published, 3);
});

test("cleared_kind_not_published: a `Clears` entry for a word the classifier never returns is named", () => {
  const verdict = judgeOf({
    cleared: new Map([
      ["stone", []],
      ["weed", []],
      ["twig", []],
    ]),
  });

  assert.deepEqual(verdict.findings, ["cleared_kind_not_published:twig"]);
});

test("unclearable_kind_not_published: a declaration about a word nothing carries is named", () => {
  const verdict = judgeOf({
    unclearable: new Map([
      ["object", "reason"],
      ["bush", "reason"],
    ]),
  });

  assert.deepEqual(verdict.findings, ["unclearable_kind_not_published:bush"]);
});

test("declared_kind_both_ways: one word declared cleared and unclearable is two meanings for one spelling", () => {
  const verdict = judgeOf({
    unclearable: new Map([
      ["object", "reason"],
      ["weed", "reason"],
    ]),
  });

  assert.deepEqual(verdict.findings, ["declared_kind_both_ways:weed"]);
});

test("unclearable_kind_without_reason: `not clearable` without why is the silence this gate replaces", () => {
  const verdict = judgeOf({ unclearable: new Map([["object", "   "]]) });

  assert.deepEqual(verdict.findings, ["unclearable_kind_without_reason:object"]);
});

test("a declared vocabulary and the classifier disagreeing is reported in both directions", () => {
  const verdict = judgeOf({ declared: ["stone", "weed", "bush"] });

  assert.deepEqual(verdict.findings, ["kind_declared_but_never_returned:bush", "kind_returned_but_undeclared:object"]);
});

test("zero population is blocked, never green: a scan that read no word has not measured a tree", () => {
  const verdict = judgeOf({ published: new Map(), cleared: new Map(), unclearable: new Map() });

  assert.equal(verdict.verdict, "failed");
  assert.deepEqual(verdict.findings, ["stardew_clearing_vocabulary_unmeasured:no published kind was read"]);
});

test("an unresolved free-tile word is a blocked reading rather than a passing one", () => {
  const verdict = judgeOf({ freeTile: undefined });

  assert.deepEqual(verdict.findings, ["free_tile_word_unresolved:FarmhandForEachHealing.NoOccupant"]);
});

test("clearedKinds reads the occupants and never the tool the swing costs", () => {
  const catalog = `
    private static readonly string[] ClumpOccupants = { "stump", "quarry_boulder" };
    E("chop_tree", "x", G, Clears(SelfWalked(SlotTargetWith("axe", V, M)), "axe", destructive: false, null, "tree"), L, "treeChopSourceTargets");
    E("clear_debris", "x", G, Clears(SelfWalked(SlotTarget(Carried)), FarmhandClearingCost.TargetDecidesTool, destructive: false, null, ClumpOccupants), L, "debrisTargets");
    E("cut_grass", "x", G, Clears(SelfWalked(SlotTargetWith("scythe", V, M)), "scythe", destructive: true, CutGrassRefusalDetail, "grass"), L, "grassTargets");
  `;

  assert.deepEqual([...clearedKinds(catalog).keys()], ["tree", "stump", "quarry_boulder", "grass"]);
});

test("publishedWords resolves the vocabulary constants a classifier returns", () => {
  const classifier = `
    internal static class TileOccupancy
    {
        internal static string ObjectKind(StardewValley.Object item) =>
            NativeItemPredicates.IsBreakableStone(item) ? TileOccupantKind.Stone : TileOccupantKind.Object;
        internal static string Of(GameLocation location, int x, int y) => FarmhandForEachHealing.NoOccupant;
    }
  `;
  const vocabulary = `
    public static class TileOccupantKind
    {
        public const string Stone = "stone";
        public const string Object = "object";
    }
  `;

  const read = publishedWords(classifier, { constants: constantsIn(vocabulary) });

  assert.deepEqual([...read.words.keys()], ["stone", "object"]);
  assert.deepEqual(read.unresolved, []);
});

test("a constant the vocabulary does not declare is reported by name instead of dropped", () => {
  const classifier = "return TileOccupantKind.Twig;";

  const read = publishedWords(classifier, { constants: constantsIn('public const string Stone = "stone";') });

  assert.deepEqual(read.unresolved, ["TileOccupantKind.Twig"]);
});

test("unclearableKinds keeps each reason whole and names an entry that carries none", () => {
  const vocabulary = `
    public static class TileOccupantKind
    {
        public const string Object = "object";
        public const string Bush = "bush";
        public static readonly IReadOnlyList<(string Kind, string Reason)> Unclearable = new[]
        {
            (Object, "a placed machine or a chest: no published action opens a route through one"),
            (Bush, ""),
        };
    }
  `;
  const constants = constantsIn(vocabulary);
  const declared = unclearableKinds(vocabulary, constants);

  assert.deepEqual([...declared.keys()], ["object", "bush"]);
  assert.match(declared.get("object"), /no published action opens a route through one/u);
  assert.equal(declared.get("bush"), "");
});

test("declaredKinds reads the vocabulary's own Published list", () => {
  const vocabulary = `
    public static class TileOccupantKind
    {
        public const string Stone = "stone";
        public const string Object = "object";
        public static readonly IReadOnlyList<string> Published = new[] { Stone, Object };
    }
  `;

  assert.deepEqual(declaredKinds(vocabulary, constantsIn(vocabulary)), ["stone", "object"]);
});

test("the tree this suite runs in answers every published kind, and the census is not empty", () => {
  const result = checkStardewClearingVocabulary();

  assert.ok(result.counts.published > 0, "zero population is not a clean tree");
  assert.deepEqual(result.findings, [], result.findings.join(" "));
  assert.equal(result.verdict, "passed");
  assert.ok(result.unclearable.length > 0, "a tree where nothing is unclearable has not exercised the declaration");
  for (const kind of result.unclearable) assert.notEqual(result.cleared.includes(kind), true, kind);
});

test("a classifier that starts publishing a kind tomorrow is red until a declaration answers it", () => {
  const result = checkStardewClearingVocabulary({
    read: (relative) => {
      const source = REAL[relative];
      if (source === undefined) throw new Error(`no probe source for ${relative}`);
      return relative === "integrations/stardew/TileOccupancy.cs"
        ? `${source}\ninternal static class Probe { internal static string Future() => "peat"; }`
        : source;
    },
  });

  assert.equal(result.verdict, "failed");
  assert.ok(
    result.findings.includes("published_kind_no_action_clears:peat"),
    `the future member is named: ${result.findings.join(" ")}`,
  );
});

// The real sources, read once, so the probe above mutates one file of a tree that otherwise passes.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REAL = Object.freeze({
  "integrations/stardew/TileOccupancy.cs": readFileSync(
    path.join(ROOT, "integrations/stardew/TileOccupancy.cs"),
    "utf8",
  ),
  "integrations/stardew/src/Core/TileOccupantKind.cs": readFileSync(
    path.join(ROOT, "integrations/stardew/src/Core/TileOccupantKind.cs"),
    "utf8",
  ),
  "integrations/stardew/StardewBodyController.cs": readFileSync(
    path.join(ROOT, "integrations/stardew/StardewBodyController.cs"),
    "utf8",
  ),
  "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs": readFileSync(
    path.join(ROOT, "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs"),
    "utf8",
  ),
  "integrations/stardew/src/Core/Policy/FarmhandForEachHealing.cs": readFileSync(
    path.join(ROOT, "integrations/stardew/src/Core/Policy/FarmhandForEachHealing.cs"),
    "utf8",
  ),
});
