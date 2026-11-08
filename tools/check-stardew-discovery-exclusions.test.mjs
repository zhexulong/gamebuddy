#!/usr/bin/env node
/**
 * The falsifier for `tools/check-stardew-discovery-exclusions.mjs`.
 *
 * The gate exists for one defect class: a discovery family that filters a subject on a STATE and publishes nothing, so
 * an empty list answers "there is a tree here but you cannot chop it" and "there is no tree here" with the same value.
 * These cases drive the gate's own `measure()` with a synthetic population, so the verdict is measured rather than
 * assumed, and the real tree is asserted only for the facts that must stay true of it (a non-empty population, the
 * families that record, and the two vocabularies agreeing).
 *
 * red-proof: inject removing the recorder call from `DiscoverHarvestWhereabouts` while its `.Where` still drops unripe
 * crops -> `stardew_discovery_exclusions_missing:harvestWhereabouts` (test "a filter on an explained member with no
 * publication is named, with the member it filtered on", tools/check-stardew-discovery-exclusions.test.mjs)
 * red-proof: inject leaving a filter filed in the backlog after its state gained a token ->
 * `stardew_discovery_exclusions_backlog_token_available:DiscoverHarvestWhereabouts` (test "a filed filter whose state now
 * has a token is red, so the register cannot rot", tools/check-stardew-discovery-exclusions.test.mjs)
 * red-proof: history the ten `token_available` findings this gate produced on 2026-11-08 against the real tree - nine
 * `not_ready`/`already_tapped`/`dead`/`wrong_harvest_method` filters filed instead of published -> exit 1 naming each
 * family (tools/stardew-discovery-exclusions-backlog.json)
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  DISPOSITION_CLASSES,
  STATE_MEMBERS,
  declaredFamilies,
  discoverMethods,
  filterPositions,
  hostTokens,
  measure,
  membersFiltered,
  report,
  schemaFamilies,
  vocabularyTokens,
} from "./check-stardew-discovery-exclusions.mjs";

const TOKENS = Object.keys(STATE_MEMBERS);
const DECLARED = [
  { capability: "chop_tree", family: "treeChopSourceTargets" },
  { capability: "pet_animal", family: "petTargets" },
];
const WIRE = ["treeChopSourceTargets", "petTargets", "discoveryExclusions"];

/** One synthetic `Discover*` method, so a case states only what it is about. */
const method = (name, body) => ({ name, file: `integrations/stardew/${name}.cs`, body });

const measureWith = (overrides) => {
  // The schema's `family` enum is derived from whatever declaration the case supplies, so a case that narrows the
  // declared set does not also have to restate the wire side: that drift is its own case.
  const declared = overrides.declared ?? DECLARED;
  return measure({
    methods: [],
    entries: [],
    tokens: TOKENS,
    mirror: TOKENS,
    declared,
    wireFamilies: WIRE,
    wireExclusionFamilies: declared.map((entry) => entry.family),
    ...overrides,
  });
};

test("a filter on an explained member with no publication is named, with the member it filtered on", () => {
  const result = measureWith({
    methods: [
      method(
        "DiscoverWeedTargets",
        "{ foreach (var pair in objects.Where(pair => pair.Value.health.Value <= 0f)) { } }",
      ),
    ],
    declared: [],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.unexplained.length, 1);
  assert.equal(result.unexplained[0].function, "DiscoverWeedTargets");
  assert.equal(result.unexplained[0].member, "health.Value");
  assert.equal(result.unexplained[0].token, "dead");
});

test("the same filter passes once the family records a reason", () => {
  const result = measureWith({
    methods: [
      method(
        "DiscoverWeedTargets",
        '{ foreach (var pair in objects.Where(pair => pair.Value.health.Value <= 0f)) { exclusions.Record("treeChopSourceTargets", DiscoveryExclusionReasons.Dead); } }',
      ),
    ],
    declared: DECLARED.slice(0, 1),
  });
  assert.equal(result.status, "passed", JSON.stringify(result.findings));
  assert.equal(result.withExclusions, 1);
});

test("a filed filter is named with its disposition instead of being silent", () => {
  const result = measureWith({
    methods: [
      method(
        "DiscoverTreeStumpTargets",
        "{ foreach (var pair in features.Where(pair => pair.Value.stump.Value)) { } }",
      ),
    ],
    entries: [
      {
        function: "DiscoverTreeStumpTargets",
        member: "stump.Value",
        disposition: "kind test: the stump is the subject",
      },
    ],
    declared: [],
  });
  assert.equal(result.status, "passed", JSON.stringify(result.findings));
  assert.equal(result.filed.length, 1);
  assert.match(result.filed[0].entry.disposition, /^kind test:/u);
});

test("a filed filter whose state now has a token is red, so the register cannot rot", () => {
  const result = measureWith({
    methods: [method("DiscoverPetTargets", "{ foreach (var p in pets.Where(p => p.PettedToday)) { } }")],
    entries: [
      {
        function: "DiscoverPetTargets",
        member: "PettedToday",
        token: "petted_today",
        disposition: "token pending: petted_today",
      },
    ],
    declared: [],
  });
  assert.equal(result.status, "failed");
  assert.ok(result.findings.some((finding) => finding.code === "backlog_token_available"));
});

test("a filed filter that no longer exists is red", () => {
  const stale = measureWith({
    methods: [method("DiscoverPetTargets", "{ return pets; }")],
    entries: [{ function: "DiscoverPetTargets", member: "PettedToday", disposition: "token pending: petted_today" }],
    declared: [],
  });
  assert.equal(stale.status, "failed");
  assert.ok(stale.findings.some((finding) => finding.code === "backlog_stale"));

  const gone = measureWith({
    methods: [],
    entries: [{ function: "DiscoverNothingHere", member: "PettedToday", disposition: "token pending: petted_today" }],
    declared: [],
  });
  assert.ok(gone.findings.some((finding) => finding.code === "backlog_not_a_discovery"));
});

test("a disposition that names no class is red, so 'filed' cannot mean 'nobody wrote why'", () => {
  const result = measureWith({
    methods: [
      method(
        "DiscoverTreeStumpTargets",
        "{ foreach (var pair in features.Where(pair => pair.Value.stump.Value)) { } }",
      ),
    ],
    entries: [{ function: "DiscoverTreeStumpTargets", member: "stump.Value", disposition: "later" }],
    declared: [],
  });
  assert.ok(result.findings.some((finding) => finding.code === "backlog_unreasoned"));
  assert.deepEqual(DISPOSITION_CLASSES, ["token pending", "not vanilla", "kind test"]);
});

test("a reason recorded for a family the Mod does not declare, or the wire does not carry, is red", () => {
  const undeclared = measureWith({
    methods: [
      method("DiscoverPetTargets", '{ exclusions.Record("petTargets", DiscoveryExclusionReasons.PettedToday); }'),
    ],
    declared: DECLARED.slice(0, 1),
  });
  assert.ok(undeclared.findings.some((finding) => finding.code === "undeclared_family"));

  const unwired = measureWith({
    methods: [
      method("DiscoverPetTargets", '{ exclusions.Record("petTargets", DiscoveryExclusionReasons.PettedToday); }'),
    ],
    wireFamilies: ["treeChopSourceTargets"],
  });
  assert.ok(unwired.findings.some((finding) => finding.code === "family_without_a_wire_field"));
});

test("a declared family with no publisher is red, and a vocabulary that drifts from the Host's is red", () => {
  const silent = measureWith({ methods: [], declared: DECLARED });
  assert.equal(silent.findings.filter((finding) => finding.code === "declared_family_silent").length, 2);

  const drift = measureWith({ methods: [], declared: [], mirror: [...TOKENS, "invented_state"] });
  assert.ok(drift.findings.some((finding) => finding.code === "vocabulary_drift"));
});

test("a token whose engine member no method is accountable for is red", () => {
  const result = measureWith({ methods: [], declared: [], tokens: [...TOKENS, "invented_state"] });
  assert.ok(result.findings.some((finding) => finding.code === "token_explains_nothing"));
});

test("zero population is not_measured, never green", () => {
  const written = [];
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    written.push(String(chunk));
    return true;
  };
  let exitCode;
  try {
    exitCode = report({
      discoveries: 0,
      withExclusions: 0,
      unexplained: [],
      filed: [],
      findings: [],
      status: "passed",
    });
  } finally {
    process.stdout.write = write;
  }
  assert.equal(exitCode, 2);
  assert.deepEqual(written, [
    "stardew_discovery_exclusions_skipped: no `Discover*` method was found under integrations/stardew, so nothing was examined\n",
  ]);
});

test("filter positions are the .Where lambdas and the if (...) continue; guards, and nothing else", () => {
  const positions = filterPositions(
    "{ var x = list.Where(pair => pair.Value.tapped.Value); if (a.isWatered()) continue; if (b) { return null; } }",
  );
  assert.equal(positions.length, 2);
  assert.deepEqual(
    membersFiltered("{ if (tree.tapped.Value) continue; }").map((entry) => entry.token),
    ["already_tapped"],
  );
});

test("the real tree: a non-empty population, the recording families, and one vocabulary in two languages", () => {
  const methods = discoverMethods();
  assert.ok(methods.length > 40, `population was ${methods.length}`);
  const recording = methods.filter((entry) => /exclusions\.Record\(/u.test(entry.body)).map((entry) => entry.name);
  for (const expected of [
    "DiscoverTreeChopSourceTargets",
    "DiscoverPetTargets",
    "DiscoverFarmAnimalPetTargets",
    "DiscoverCropTargets",
    "DiscoverHarvestTargets",
    "DiscoverPetBowlTargets",
    "DiscoverSlimeHutchTroughTargets",
    "DiscoverBaitCrabPotTargets",
  ])
    assert.ok(recording.includes(expected), `${expected} publishes no exclusion`);

  assert.deepEqual([...vocabularyTokens()].sort(), [...hostTokens()].sort());
  for (const token of vocabularyTokens()) assert.ok(STATE_MEMBERS[token]?.length > 0, `${token} explains no member`);

  const declared = declaredFamilies();
  const wire = new Set(schemaFamilies());
  for (const entry of declared) assert.ok(wire.has(entry.family), `${entry.family} has no wire field`);
});
