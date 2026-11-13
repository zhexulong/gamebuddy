#!/usr/bin/env node
// Falsifiers for tools/check-stardew-observation-consumers.mjs.
//
// The gate answers one question per (action, family) pair: can the model ASK about this family, or must it pay a whole
// `stardew_observe`? Its population comes from the surface's own `targetFamily` entries and its channels come from the
// sources that answer questions (`host/src/game-lookup.ts` and the Mod's scene affordances).
//
// Every guard here is proven red before it is trusted: each `no_channel`, `stale_baseline_entry`, `baseline_entry_*`
// and `blocked` case is driven by a planted defect, because a suite that only re-runs the gate on a green tree proves
// the tree, not the gate.
//
// red-proof: inject  with the baseline emptied, the gate failed on
//   70 `observation_consumers_no_channel` pairs (`rotate_furniture -> worldObjectTargets` first of them, `travel ->
//   warps` beside it) and exited 1; this suite then fails on
//   "a target-bearing action with no channel reds" with the planted pair, and on the unaskable-after-removal case when a
//   look_up subject's case is deleted.
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (file) => readFileSync(resolve(ROOT, file), "utf8");

const TREE = {
  surface: JSON.parse(read(SURFACE)),
  lookupSource: read(LOOKUP_SOURCE),
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

test("the family -> channel map is derived, and the generic door is the one that answers by name", () => {
  // `shop_purchase -> shopTargets` used to be answered by the `[State HUD: …]` block's `shop` line - text composed into
  // `WorldFact.contextProjection.hud` and read by nobody. With that module gone the pair is answered by
  // `stardew_look_up`'s generic family door, and this pins WHICH channel it is so a re-appearing "arrives every turn"
  // claim has to name a renderer she actually reads.
  const result = auditTree();
  assert.equal(pairOf(result, "shop_purchase -> shopTargets")?.channel, "look_up:shopTargets");
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
  // The shaped subject is gone, and the family is still askable by name - that is the generic door doing its job, and
  // it must be the door, not a stale mapping, that answers: the channel names the family.
  assert.equal(pairOf(after, "water_crop -> cropTargets").channel, "look_up:cropTargets");

  // Close the generic door the honest way: rename the function the generic branch calls, so the source no longer
  // accepts a family by name. Now nothing can answer the family, and the pair must become a finding.
  const withoutDoor = withoutCrops.replaceAll("familyRows(", "familyRowsClosed(");
  assert.notEqual(withoutDoor, withoutCrops, "the planted edit must actually close the generic door");
  const closed = withSources({ lookupSource: withoutDoor });
  assert.equal(pairOf(closed, "water_crop -> cropTargets").classification, "no_channel");
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

// The legitimate classes must stay legitimate: a pair answered by a `look_up` family door and a pair answered by a scene
// affordance are not findings, and a gate that reds them would be wrong about the product.
test("queryable and scene answers are classified, not reddened", () => {
  const result = auditTree();
  assert.equal(pairOf(result, "shop_purchase -> shopTargets")?.classification, "queryable");
  assert.equal(pairOf(result, "chop_tree -> treeChopSourceTargets")?.classification, "scene");
  assert.equal(pairOf(result, "chest_store -> chests")?.classification, "queryable");
  for (const id of ["shop_purchase -> shopTargets", "chop_tree -> treeChopSourceTargets", "chest_store -> chests"])
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
  assert.ok(result.lookupVocabulary.length > 0, "a lookup subject vocabulary is what the doors are derived from");
  assert.equal(
    result.counts.queryable + result.counts.scene + result.counts.no_channel,
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
        reason: "a planted entry naming an action and a family that the generic look_up family door already answers",
      },
    ],
  };
  const result = withSources({ baseline });
  assert.equal(result.status, "failed");
  const stale = result.findings.find((finding) => finding.code === "stale_baseline_entry");
  assert.ok(stale, "an entry whose family gained a channel must be deleted");
  assert.equal(stale.pair, "shop_purchase -> shopTargets");
  assert.match(stale.detail, /now queryable through look_up:shopTargets/u);
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
