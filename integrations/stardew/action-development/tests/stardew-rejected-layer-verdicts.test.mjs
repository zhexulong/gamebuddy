#!/usr/bin/env node
/**
 * Tests for the rejected layer of `stardew-action-inventory-reconciliation.mjs`.
 *
 * The rejected layer is the only place that can see a player entry whose method body
 * is pure delegation, because the nine predicates remove such a unit before any other
 * analysis runs: it is absent from `unmatchedCandidates`, so the remaining-actions
 * report has no row for it. `Grass.performToolAction` is the case that motivated the
 * layer; nothing downstream could see that cutting grass fills a silo.
 *
 * The three rules that matter, each with a mutation check in the sibling
 * `.mutation.mjs`:
 *   1. seam join runs FIRST, so an already-covered unit is not reported as a gap
 *      (`HoeDirt.performUseAction` -> harvest_crop)
 *   2. the chain hit is keyed by (file, member) with NO member-name fallback, because
 *      member names collide across classes and that collision is exactly what this
 *      layer must distinguish: `cut_weeds`'s seam is `Object.performToolAction`, while
 *      `Grass.performToolAction` is a different implementation on a different class
 *   3. every unit that still needs a verdict must have one, or the build fails
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { groupRejectedUnits } from "../src/analysis/stardew-action-inventory-reconciliation.mjs";
import { REJECTED_LAYER_VERDICTS } from "../src/analysis/stardew-rejected-layer-verdicts.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Minimal seam index in the shape `registeredSeamMembers` returns. */
function seamIndex(entries) {
  const byMember = new Map();
  const byFileMember = new Map();
  for (const [file, member, actionId] of entries) {
    if (!byMember.has(member)) byMember.set(member, new Set());
    byMember.get(member).add(actionId);
    byFileMember.set(`${file.toLowerCase()}\u0000${member}`, new Set([actionId]));
  }
  return { byMember, byFileMember };
}

const unit = (over = {}) => ({
  className: "X",
  member: "m",
  file: "X.cs",
  line: 1,
  rejectedBy: ["P4"],
  ownEffects: ["presentation"],
  chainGameplayEffects: ["world-write"],
  resolveChain: [],
  ownTerminalWrite: false,
  chainReachesGameplay: true,
  ...over,
});

test("a covered unit is reported as registered, not as a gap", () => {
  // The seam is on the unit's own (file, member).
  const rows = groupRejectedUnits({
    methodResolution: { units: [unit({ className: "HoeDirt", member: "performUseAction", file: "HoeDirt.cs", line: 478 })] },
    seamMembers: seamIndex([["hoedirt.cs", "performUseAction", "harvest_crop"]]),
    verdicts: {},
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].group, "already_registered");
  assert.deepEqual(rows[0].actionIds, ["harvest_crop"]);
  assert.match(rows[0].reason, /registered seam itself/);
});

test("a chain member on the same file can cover the unit", () => {
  const rows = groupRejectedUnits({
    methodResolution: {
      units: [unit({ className: "Fence", member: "checkForAction", file: "Fence.cs", resolveChain: ["performToolAction@436"] })],
    },
    seamMembers: seamIndex([["fence.cs", "performToolAction", "toggle_fence_gate"]]),
    verdicts: {},
  });
  assert.equal(rows[0].group, "already_registered");
  assert.match(rows[0].reason, /resolution chain/);
});

test("a colliding member name in ANOTHER file must not cover the unit", () => {
  // This is the Grass case: cut_weeds's seam is Object.performToolAction, and
  // Grass.performToolAction is a different implementation. A member-name fallback
  // would report Grass as covered and hide the gap this layer exists to find.
  const rows = groupRejectedUnits({
    methodResolution: { units: [unit({ className: "Grass", member: "performToolAction", file: "Grass.cs", line: 365 })] },
    seamMembers: seamIndex([["object.cs", "performToolAction", "cut_weeds"]]),
    verdicts: { "Grass.performToolAction@365": { group: "new_primitive_needed", actionId: "cut_grass", reason: "x", anchor: "y" } },
  });
  assert.equal(rows[0].group, "new_primitive_needed", "a same-named member in another file must not cover this unit");
  assert.deepEqual(rows[0].actionIds, ["cut_grass"]);
});

test("a unit needing a verdict without one fails the build", () => {
  assert.throws(
    () =>
      groupRejectedUnits({
        methodResolution: { units: [unit({ className: "Q", member: "r", file: "Q.cs", line: 9 })] },
        seamMembers: seamIndex([]),
        verdicts: {},
      }),
    /rejected_unit_without_verdict:Q\.r@9/,
  );
});

test("a verdict that matches no unit fails the build", () => {
  assert.throws(
    () =>
      groupRejectedUnits({
        methodResolution: { units: [] },
        seamMembers: seamIndex([]),
        verdicts: { "Ghost.method@1": { group: "explicit_exclusion", reason: "x", anchor: "y" } },
      }),
    /rejected_layer_verdict_not_matched_to_any_unit:Ghost\.method@1/,
  );
});

test("an entry with no gameplay effect anywhere is excluded, not adjudicated", () => {
  const rows = groupRejectedUnits({
    methodResolution: {
      units: [
        unit({
          ownEffects: ["presentation"],
          chainReachesGameplay: false,
          chainGameplayEffects: [],
          ownTerminalWrite: false,
        }),
      ],
    },
    seamMembers: seamIndex([]),
    verdicts: {},
  });
  assert.equal(rows[0].group, "explicit_exclusion");
});

test("an entry that itself writes gameplay state is implementation-complete", () => {
  const rows = groupRejectedUnits({
    methodResolution: { units: [unit({ ownTerminalWrite: true, chainReachesGameplay: false })] },
    seamMembers: seamIndex([]),
    verdicts: {},
  });
  assert.equal(rows[0].group, "already_implemented");
});

test("the shipped verdicts cover every rejected-layer unit that needs one", async () => {
  // Guards the real table against a unit being added or renamed without a verdict.
  const artifactPath = path.join(HERE, "../../../.stardew-rejected-resolution.cache.json");
  if (!fs.existsSync(artifactPath)) {
    // The artifact is produced by the CI wiring; validate the table's own shape here.
    const keys = Object.keys(REJECTED_LAYER_VERDICTS);
    assert.ok(keys.length >= 11, `expected the shipped verdicts, got ${keys.length}`);
    assert.ok(keys.includes("Grass.performToolAction@365"), "cut_grass must have a verdict");
    return;
  }
  const resolution = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  const rows = groupRejectedUnits({ methodResolution: resolution, seamMembers: seamIndex([]) });
  const stillNeeding = rows.filter((r) => r.group === "needs_adjudication");
  assert.equal(stillNeeding.length, 0, `unadjudicated: ${stillNeeding.map((r) => r.key).join(", ")}`);
});