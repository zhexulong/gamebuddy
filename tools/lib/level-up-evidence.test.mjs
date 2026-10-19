// The level-up evidence parse, pinned against every shape the wire actually carries.
//
// Measured 2026-10-17 on run g10: the watcher stringified the evidence OBJECT and reported
// `level_up_pair_not_published` while the Mod had published `level_up=4@6` all along, so the run stopped one step
// short of resolving the menu it had correctly recognized. These cases are the falsifiers for that shape.
import assert from "node:assert/strict";
import test from "node:test";

import {
  chooseLevelUpResolution,
  evidenceDetail,
  parsePendingLevelUps,
  readPendingLevelUpsFromSnapshot,
} from "./level-up-evidence.mjs";

test("the snapshot's own projection is read as pairs, and a malformed entry is not a pair", () => {
  // This is the reader the watcher now uses: the Mod publishes `skill@level` on every snapshot, so the harness no longer
  // has to learn the pending pair by parsing a refusal. Malformed entries are dropped rather than guessed at, and a
  // snapshot without the field reads as `[]` (older Mods) - which `chooseLevelUpResolution` then names.
  assert.deepEqual(readPendingLevelUpsFromSnapshot({ pendingLevelUps: ["4@6", "2@10"] }), [
    { skill: 4, level: 6 },
    { skill: 2, level: 10 },
  ]);
  assert.deepEqual(readPendingLevelUpsFromSnapshot({}), []);
  assert.deepEqual(readPendingLevelUpsFromSnapshot(undefined), []);
  assert.deepEqual(readPendingLevelUpsFromSnapshot({ pendingLevelUps: ["nonsense", "4-6"] }), []);
});

test("the pair is read from the fact log's { detail } shape", () => {
  const detail = "modal_type=LevelUpMenu;dismissible=false;pending_level_ups=1;level_up=4@6";
  assert.deepEqual(parsePendingLevelUps({ detail }), [{ skill: 4, level: 6 }]);
  // A bare string is the other shape the same evidence arrives in.
  assert.deepEqual(parsePendingLevelUps(detail), [{ skill: 4, level: 6 }]);
  // And the world-fact payload nesting, which is how a replayed fact carries it.
  assert.deepEqual(parsePendingLevelUps({ worldFactPayload: { evidence: { detail } } }), [{ skill: 4, level: 6 }]);
});

test("an unknown shape yields no pair instead of a stringified object", () => {
  // This is the bug that cost run g10: String({detail}) is "[object Object]", which matched nothing and looked
  // like the Mod had published nothing.
  assert.equal(evidenceDetail({ detail: "x" }), "x");
  assert.equal(evidenceDetail("[object Object]"), "[object Object]");
  assert.deepEqual(parsePendingLevelUps({}), []);
  assert.deepEqual(parsePendingLevelUps(null), []);
  assert.deepEqual(parsePendingLevelUps(undefined), []);
  assert.deepEqual(parsePendingLevelUps({ detail: "modal_type=LevelUpMenu" }), []);
});

test("multiple pending level-ups keep the Mod's own order", () => {
  const pairs = parsePendingLevelUps({ detail: "pending_level_ups=2;level_up=0@2;level_up=4@6" });
  assert.deepEqual(pairs, [
    { skill: 0, level: 2 },
    { skill: 4, level: 6 },
  ]);
});

test("an ordinary level is confirmed and a milestone is refused by name", () => {
  // An ordinary level has exactly one legal value, so the watcher may pass it without deciding anything.
  const ordinary = chooseLevelUpResolution([{ skill: 4, level: 6 }]);
  assert.equal(ordinary.choice, "confirm");
  assert.equal(ordinary.reasonCode, null);
  assert.equal(ordinary.levelUp.skill, 4);
  // A milestone is the companion's own decision: the watcher names it and stops.
  for (const level of [5, 10]) {
    const milestone = chooseLevelUpResolution([{ skill: 2, level }]);
    assert.equal(milestone.choice, null);
    assert.equal(milestone.reasonCode, `level_up_requires_companion_choice:2@${String(level)}`);
  }
  const nothing = chooseLevelUpResolution([]);
  assert.equal(nothing.reasonCode, "level_up_pair_not_published");
  assert.equal(nothing.choice, null);
});
