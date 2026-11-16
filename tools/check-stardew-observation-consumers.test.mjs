#!/usr/bin/env node
// Falsifiers for tools/check-stardew-observation-consumers.mjs.
//
// The gate answers one question per (action, family) pair: can the model ASK about this family, or must it pay a whole
// `stardew_observe`? Its population comes from the surface's own `targetFamily` entries and its channels come from the
// sources that answer questions (`host/src/game-lookup.ts`, the per-turn `<world-state>` text, the Mod's scene
// affordances). The per-turn text is derived by `perTurnFamilies` in the field-rendering gate, which owns the renderer
// declaration: the `[State HUD: …]` block that used to answer it was deleted in `213cde50`.
//
// Every guard here is proven red before it is trusted: each `no_channel`, `stale_baseline_entry`, `baseline_entry_*`
// and `blocked` case is driven by a planted defect, because a suite that only re-runs the gate on a green tree proves
// the tree, not the gate.
//
// red-proof: inject  with the baseline emptied, the gate failed on
//   70 `observation_consumers_no_channel` pairs (`rotate_furniture -> worldObjectTargets` first of them, `travel ->
//   warps` beside it) and exited 1; this suite then fails on
//   "a target-bearing action with no channel reds" with the planted pair, on the stale-entry case when a family is
//   widened, and on the unaskable-after-removal case when a look_up subject's case is deleted.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  auditConsumers,
  auditTree,
  BASELINE,
  lookupChannels,
  LOOKUP_SOURCE,
  MOD_ENTRY,
  pairId,
  PROTOCOL_SOURCE,
  report,
  SURFACE,
  sceneActions,
  targetBearingPairs,
} from "./check-stardew-observation-consumers.mjs";
import { perTurnFamilies, tableKeys } from "./check-snapshot-field-rendering.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(ROOT, file), "utf8");

const TREE = {
  surface: JSON.parse(read(SURFACE)),
  lookupSource: read(LOOKUP_SOURCE),
  perTurn: perTurnFamilies({ root: ROOT }),
  modEntrySource: read(MOD_ENTRY),
  // The snapshot's declared keys are the population for the generic family door; without them every family looks
  // undeclared, which would make the suite measure the fixture rather than the tool.
  protocolSource: read(PROTOCOL_SOURCE),
  baseline: JSON.parse(read(BASELINE)),
};

/** The real tree with one of its sources replaced, so a planted defect is the only difference. */
function withSources(overrides) {
  return auditConsumers({ ...TREE, ...overrides });
}

function pairOf(result, id) {
  return result.classified.find((pair) => pairId(pair) === id);
}

// ---------------------------------------------------------------------------------------------------------------
// The derivation: the channels are read out of the sources, never listed in this gate.
// ---------------------------------------------------------------------------------------------------------------

test("every advertised look_up subject has a case, and every case answers from a family", () => {
  const { vocabulary, channels, nonSnapshot, problems } = lookupChannels(TREE.lookupSource);
  assert.ok(vocabulary.length > 0, "LOOKUP_SUBJECTS must be non-empty, or the channel is not measured");
  assert.deepEqual(problems, [], `a subject the tool advertises cannot be answered: ${problems.join(", ")}`);
  // A channel is either a snapshot family (`channels`) or a source of its own (`nonSnapshot`, printed by the CLI) - and
  // a subject that is neither is still the finding this assertion exists for.
  for (const subject of vocabulary)
    assert.ok(channels.has(subject) || nonSnapshot.has(subject), `${subject} is advertised but answers nothing`);
  // Falsifier: an arm that HANDS the snapshot to a function which reads no family of it is still reported, so "reads a
  // different source" cannot become a way to smuggle in a subject that answers nothing from the snapshot.
  const synthetic = [
    'export const LOOKUP_SUBJECTS = Object.freeze([\n  "hollow",\n] as const);',
    'function hollow(snapshot) { return { subject: "hollow" }; }',
    'export function lookUp() { switch (subject) { case "hollow": return hollow(snapshot); } }',
  ].join("\n");
  assert.deepEqual(lookupChannels(synthetic).problems, ["lookup_subject_reads_nothing:hollow(hollow)"]);
});

test("the per-turn text names families, and the derivation says which half named them", () => {
  const { rows, mentioned, families, problems } = TREE.perTurn;
  assert.deepEqual(problems, [], "a renderer or row table this gate cannot read is a broken channel, not an empty one");
  assert.ok(families.size > 0, "zero names would be a blocked measurement");
  assert.ok(rows.has("shopTargets"), "the row table is what prints a shop counter: `商店`");
  assert.ok(mentioned.has("villagerWhereabouts"), "a family the composer reads by name is named per turn too");
  for (const name of families) assert.notEqual(name.trim(), "", "an empty name cannot be reported");
});

// The falsifier for "the family -> channel map is derived": delete one subject from the switch and the pairs it used
// to answer must fall through - first to the generic family door, and with THAT door removed to `no_channel`. A
// hand-written map would keep them green in both cases, which is why both steps are asserted.
test("removing a look_up subject's case makes its pairs unaskable, so the map comes from the source", () => {
  const before = pairOf(withSources({}), "water_crop -> cropTargets");
  assert.equal(before.classification, "queryable", "water_crop is answered by the crops subject at HEAD");

  const withoutCrops = TREE.lookupSource.replace('case "crops":\n      return crops(snapshot);', "");
  assert.notEqual(withoutCrops, TREE.lookupSource, "the planted edit must actually remove the case");
  const after = withSources({ lookupSource: withoutCrops });
  assert.ok(
    after.blocked.includes("lookup_subject_without_case:crops"),
    `an advertised subject with no case is blocked by name, got ${JSON.stringify(after.blocked)}`,
  );
  // The shaped subject is gone, and the per-turn text names the family - so the free channel is the one that answers it,
  // and the claim names the family rather than a subject that no longer has a case.
  assert.equal(pairOf(after, "water_crop -> cropTargets").classification, "world_state");
  assert.equal(pairOf(after, "water_crop -> cropTargets").channel, "world_state:cropTargets");

  // Close every remaining channel the honest way. The generic door goes by renaming the function its branch calls, so the
  // source no longer accepts a family by name; the per-turn set goes by removing the family from it, which is the edit a
  // renderer change would make. Now nothing can answer the family, and the pair must become a finding.
  const withoutDoor = withoutCrops.replaceAll("familyRows(", "familyRowsClosed(");
  assert.notEqual(withoutDoor, withoutCrops, "the planted edit must actually close the generic door");
  const closed = withSources({
    lookupSource: withoutDoor,
    perTurn: {
      ...TREE.perTurn,
      families: new Set([...TREE.perTurn.families].filter((family) => family !== "cropTargets")),
    },
  });
  assert.equal(pairOf(closed, "water_crop -> cropTargets").classification, "no_channel");
});

// The same falsifier for the per-turn channel: name one more family in it and the pairs that family answers stop
// being findings - and their baseline entries become stale, which is the ratchet working.
test("a family the per-turn text names answers its pairs, and their baseline entries become stale", () => {
  const widened = { ...TREE.perTurn, families: new Set([...TREE.perTurn.families, "warps"]) };
  assert.ok(
    !TREE.perTurn.families.has("warps"),
    "the planted edit must actually add a name the composer does not print",
  );
  const result = withSources({ perTurn: widened });
  assert.equal(pairOf(result, "travel -> warps").classification, "world_state");
  // `enter_exit -> warps` is answered by the Mod's Door affordance and is not a baseline entry at all - widening the
  // per-turn set can only make the pairs that were findings stop being findings.
  const stale = result.findings.filter((finding) => finding.code === "stale_baseline_entry").map((f) => f.pair);
  // The real baseline no longer lists `travel -> warps` (the generic door answers it), so the ratchet is proven on a
  // baseline that still names the pair: widening the per-turn set must make THAT entry stale by name.
  const withEntry = withSources({
    perTurn: widened,
    baseline: {
      ...TREE.baseline,
      entries: [
        {
          kind: "no_channel",
          id: "travel -> warps",
          reason: "planted: the baseline names a pair the widened per-turn set now answers, so the entry must go stale",
        },
      ],
    },
  });
  assert.deepEqual(
    withEntry.findings.filter((f) => f.code === "stale_baseline_entry").map((f) => f.pair),
    ["travel -> warps"],
  );
  assert.equal(withEntry.status, "failed");
  assert.deepEqual(stale, [], "nothing in the real baseline is stale while every pair has a channel");
  assert.equal(result.status, "passed");
});

// ---------------------------------------------------------------------------------------------------------------
// The finding: a target-bearing action whose family nothing can answer.
// ---------------------------------------------------------------------------------------------------------------

test("a target-bearing action with no channel reds, naming the action, the family and the channels checked", () => {
  const surface = {
    ...TREE.surface,
    actions: [
      ...TREE.surface.actions,
      {
        actionId: "planted_probe",
        lifecycle: "experimental",
        argumentSchema: { expectedTargetId: { type: "string" } },
        targetFamily: "plantedFamilyTargets",
      },
    ],
  };
  const result = withSources({ surface });
  assert.equal(result.status, "failed");
  const finding = result.findings.find((f) => f.code === "family_not_in_snapshot");
  assert.ok(finding, "the planted pair must be the finding");
  assert.equal(finding.pair, "planted_probe -> plantedFamilyTargets");
  // A family the snapshot never declares is WORSE than an unaskable one: no channel can ever answer it, so it keeps
  // its own word instead of hiding inside `no_channel`.
  assert.equal(pairOf(result, "planted_probe -> plantedFamilyTargets").classification, "family_not_in_snapshot");

  const lines = [];
  assert.equal(report(result, { write: (text) => lines.push(text) }), 1, "an undeclared no_channel exits non-zero");
  const text = lines.join("\n");
  assert.match(text, /observation_consumers_family_not_in_snapshot: planted_probe -> plantedFamilyTargets/u);
  assert.match(text, /observation_consumers: failed/u);
});

// The legitimate classes must stay legitimate: a pair answered by the per-turn text and a pair answered by a scene
// affordance are not findings, and a gate that reds them would be wrong about the product.
test("world_state and scene answers are classified, not reddened", () => {
  const result = auditTree();
  assert.equal(pairOf(result, "shop_purchase -> shopTargets").classification, "world_state");
  assert.equal(pairOf(result, "enter_exit -> warps").classification, "scene");
  assert.equal(pairOf(result, "chest_store -> chests").classification, "queryable");
  // The felled-tree rows are printed every turn, so this pair is answered by the free channel now; filing it under
  // `scene` was the expensive answer and would have understated what she already has.
  assert.equal(pairOf(result, "chop_tree -> treeChopSourceTargets").classification, "world_state");
  for (const id of [
    "shop_purchase -> shopTargets",
    "chop_tree -> treeChopSourceTargets",
    "enter_exit -> warps",
    "chest_store -> chests",
  ])
    assert.ok(!result.findings.some((finding) => finding.pair === id), `${id} is answered and must not be a finding`);
});

// ---------------------------------------------------------------------------------------------------------------
// The baseline: a ratchet in both directions.
// ---------------------------------------------------------------------------------------------------------------

test("the tree at HEAD passes, and the population is a measurement rather than a formality", () => {
  const result = auditTree();
  assert.deepEqual(result.findings, [], `HEAD must be green, findings: ${JSON.stringify(result.findings)}`);
  assert.equal(result.status, "passed");
  assert.ok(result.pairs > 50, `examined ${result.pairs} pairs: a population this small would not be a reading`);
  assert.ok(result.lookupVocabulary.length > 0 && result.worldStateNames > 0);
  assert.equal(
    result.counts.queryable + result.counts.world_state + result.counts.scene + result.counts.no_channel,
    result.pairs,
    "every pair is classified exactly once",
  );
  assert.equal(result.declared + result.undeclared, result.counts.no_channel);
});

test("every baseline entry is a pair the surface still declares, with a reason that names it", () => {
  const result = auditTree();
  const pairs = new Set(targetBearingPairs(TREE.surface).map(pairId));
  const kinds = new Set(["opaque_identity_unaskable", "tile_addressed_unaskable", "published_only_at_an_event"]);
  for (const entry of TREE.baseline.entries) {
    assert.ok(kinds.has(entry.kind), `${entry.id} has kind "${entry.kind}", which is not one of the closed set`);
    assert.ok(pairs.has(entry.id), `${entry.id} is not a target-bearing pair the surface declares`);
    const [actionId, family] = entry.id.split(" -> ");
    assert.ok(entry.reason.includes(actionId), `${entry.id}'s reason must name its action`);
    assert.ok(entry.reason.includes(family), `${entry.id}'s reason must name its family`);
    assert.equal(pairOf(result, entry.id).classification, "no_channel", `${entry.id} is no longer a finding`);
  }
});

test("a baseline entry for a pair that now has a channel is stale, not satisfiable", () => {
  const baseline = {
    entries: [
      ...TREE.baseline.entries,
      {
        kind: "opaque_identity_unaskable",
        id: "shop_purchase -> shopTargets",
        reason: "a planted entry naming an action and a family the per-turn text already names",
      },
    ],
  };
  const result = withSources({ baseline });
  assert.equal(result.status, "failed");
  const stale = result.findings.find((finding) => finding.code === "stale_baseline_entry");
  assert.ok(stale, "an entry whose family gained a channel must be deleted");
  assert.equal(stale.pair, "shop_purchase -> shopTargets");
  assert.match(stale.detail, /now world_state through world_state:shopTargets/u);
});

test("a baseline entry for a pair the surface no longer declares is reported, not ignored", () => {
  const baseline = {
    entries: [
      ...TREE.baseline.entries,
      {
        kind: "tile_addressed_unaskable",
        id: "deleted_action -> deletedTargets",
        reason: "a planted entry naming an action and a family the surface does not declare anywhere",
      },
    ],
  };
  const result = withSources({ baseline });
  assert.equal(result.status, "failed");
  assert.ok(result.findings.some((finding) => finding.code === "baseline_entry_unknown_pair"));
});

test("a baseline entry that cannot name its case is a finding, and so is a duplicate", () => {
  const shortReason = withSources({
    baseline: {
      entries: [{ kind: "opaque_identity_unaskable", id: "craft_item -> craftingRecipeTargets", reason: "n/a" }],
    },
  });
  assert.ok(shortReason.findings.some((finding) => finding.code === "baseline_entry_unreasoned"));

  const duplicated = withSources({ baseline: { entries: [TREE.baseline.entries[0], TREE.baseline.entries[0]] } });
  assert.ok(duplicated.findings.some((finding) => finding.code === "baseline_entry_duplicated"));
});

// ---------------------------------------------------------------------------------------------------------------
// Zero population is blocked, never green: a check that agrees with itself proves nothing.
// ---------------------------------------------------------------------------------------------------------------

test("each zero population blocks by name instead of passing", () => {
  const cases = [
    [{ surface: { actions: [] } }, "surface_declares_no_target_family"],
    [{ lookupSource: "" }, "lookup_subjects_unread"],
    [
      { perTurn: { rows: new Set(), mentioned: new Set(), families: new Set(), problems: [] } },
      "world_state_families_unread",
    ],
    [{ modEntrySource: "" }, "scene_affordances_unread"],
  ];
  for (const [overrides, reason] of cases) {
    const result = withSources(overrides);
    assert.equal(result.status, "blocked", `${reason} must block, not pass`);
    assert.ok(result.blocked.includes(reason), `expected ${reason}, got ${JSON.stringify(result.blocked)}`);
  }
});

test("a missing input file blocks the tree read rather than reading as green", () => {
  const result = auditTree({
    read: () => {
      throw new Error("missing");
    },
  });
  assert.equal(result.status, "blocked");
  assert.ok(result.blocked[0].startsWith("missing_input:"));
});

test("the report prints the blocked reason and exits non-zero", () => {
  const lines = [];
  const outcome = report(
    { status: "blocked", blocked: ["surface_declares_no_target_family"], findings: [] },
    { write: (text) => lines.push(text) },
  );
  assert.equal(outcome, 1);
  assert.match(lines.join("\n"), /observation_consumers_blocked: surface_declares_no_target_family/u);
});

test("scene affordances are read from the Mod, and an empty parse is a problem rather than coverage", () => {
  const known = TREE.surface.actions.map((action) => action.actionId);
  const hinted = sceneActions(TREE.modEntrySource, known);
  assert.ok(hinted.size > 0, "the Mod publishes affordances; zero would mean the parse stopped matching");
  assert.deepEqual([...sceneActions("", known)], []);
  assert.ok(hinted.has("chop_tree"), "the Tree affordance names chop_tree");
});

test("the per-turn derivation reports a renderer that is gone instead of an empty channel", () => {
  const broken = perTurnFamilies({
    root: ROOT,
    renderers: [{ path: "host/src/not-a-renderer.ts", audience: "companion" }],
  });
  assert.deepEqual(broken.problems, [
    "per_turn_renderer_missing:host/src/not-a-renderer.ts",
    "per_turn_rows_empty:no renderer iterates a row table",
  ]);
  assert.deepEqual(
    broken.families,
    new Set(),
    "a renderer set that cannot be read names nothing, which the gate blocks on rather than passing",
  );
});

test("a row table is read to its own closing brace, so a later table's keys are not called printed", () => {
  // The population is the vocabulary's own declaration: `NON_ROW_FAMILIES` exists to say which families the row line
  // does NOT print, and it is declared immediately after the row table. A reader that ran to the end of the file
  // therefore credited its keys - and the keys of every later literal - as printed rows, which is a channel claimed for
  // a fact that never arrives. Measured: 85 "rows" for a 74-key table.
  const vocabulary = read("host/src/game-world-vocabulary.ts");
  const notPrinted = tableKeys(vocabulary, "NON_ROW_FAMILIES");
  assert.ok(notPrinted.length > 0, "the non-row table declares families; zero entries would make this guard vacuous");
  for (const family of notPrinted)
    assert.ok(!TREE.perTurn.rows.has(family), `${family} is declared NOT printed as a row, so it cannot be a row`);
  assert.ok(TREE.perTurn.rows.has("shopTargets"), "and the table's own keys are still read");
});
