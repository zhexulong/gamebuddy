import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { OWNER_HOLD_ENDS, SOURCES, findingLine, modSources, ownerHoldGate } from "./check-body-owner-hold-bounds.mjs";

/**
 * THE GATE'S OWN PROOF. The tree's reading is the first test; the rest are violations injected into the population the
 * gate derives from the Mod's own declaration, so a member nobody has written yet still fails loudly and by name.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The real shipped Mod, with an optional overlay of mutated files. */
function modTree(overrides = {}) {
  const tree = modSources(ROOT);
  for (const [relative, text] of Object.entries(overrides)) tree.set(relative, text);
  return tree;
}

/** The real tree, one mutated file at a time. */
function movedTree(relative, mutate) {
  return modTree({ [relative]: mutate(readFileSync(path.join(ROOT, relative), "utf8")) });
}

test("a_body_can_be_held_with_no_way_out: every declared hold kind names what ends it", () => {
  const finding = ownerHoldGate(modTree(), OWNER_HOLD_ENDS);
  console.log(findingLine(finding));
  assert.equal(finding.blocked, null, "the Mod's own hold-kind declaration was found");
  assert.deepEqual(finding.silent, [], "an owner with no declared end is a body nobody can release");
  assert.deepEqual(finding.unsupported, [], "a declaration the source does not support is a label, not a bound");
  assert.deepEqual(finding.expired, [], "a declaration for an owner the Mod no longer declares has expired");
  assert.equal(finding.owners.length, 7, "the seven hold kinds the Mod declares today are all accounted for");
});

test("falsifier: a NEW hold kind with no declared end is named", () => {
  const tree = movedTree(SOURCES.holdKinds, (text) =>
    text.replace(
      'internal const string BodyOwnedByActivity = "body_owned_by_activity";',
      'internal const string BodyOwnedByActivity = "body_owned_by_activity";\n    internal const string BodyOwnedBySitting = "body_owned_by_sitting";',
    ),
  );
  const finding = ownerHoldGate(tree, OWNER_HOLD_ENDS);
  console.log(findingLine(finding));
  assert.deepEqual(
    finding.silent.map((entry) => entry.owner),
    ["body_owned_by_sitting"],
    "the new owner is named, so the next reader knows which row to bound",
  );
});

test("falsifier: a bound the source no longer carries is unsupported, and the owner is named", () => {
  const tree = movedTree(SOURCES.holdKinds, (text) =>
    text.replace(
      'internal const string BodyOwnedByActivity = "body_owned_by_activity";',
      'internal const string BodyOwnedByActivity = "body_owned_by_activity";\n    internal const string BodyOwnedBySitting = "body_owned_by_sitting";',
    ),
  );
  const table = { ...OWNER_HOLD_ENDS, body_owned_by_sitting: { bound: ["SittingWindowTicks"], why: "a window that no longer exists in this source" } };
  const finding = ownerHoldGate(tree, table);
  console.log(findingLine(finding));
  assert.deepEqual(
    finding.unsupported.map((entry) => `${entry.owner}:${entry.missing.join(",")}`),
    ["body_owned_by_sitting:SittingWindowTicks"],
    "a bound naming a constant the Mod does not declare is a stale claim, named with the token it lost",
  );
});

test("falsifier: a stop claimed for an owner whose own row refuses cancellation fails", () => {
  // `PeekDayAdvanceOwner` publishes `CancelSafe: false`, so "a stop ends this" is the one pair of answers a refusal
  // must never give at once: the row says cancelling is unsafe while the table says a stop is the way out.
  const table = {
    ...OWNER_HOLD_ENDS,
    body_owned_by_night: { stop: true, why: "claiming a stop ends the night, which the row itself refuses" },
  };
  const finding = ownerHoldGate(modTree(), table);
  console.log(findingLine(finding));
  assert.equal(finding.unsupported.length, 1, "the contradiction is reported");
  assert.match(finding.unsupported[0].missing.join(" "), /CancelSafe: false/u, "and it names the row that disagrees");
});

test("falsifier: a declaration for an owner the Mod no longer declares has expired", () => {
  const table = {
    ...OWNER_HOLD_ENDS,
    body_owned_by_sitting: { bound: ["StallTimeoutTicks"], why: "an owner that was removed from the Mod" },
  };
  const finding = ownerHoldGate(modTree(), table);
  assert.deepEqual(finding.expired, ["body_owned_by_sitting"], "an exemption must expire with the thing it exempted");
});

test("falsifier: a tree with no hold-kind declaration is BLOCKED, never green", () => {
  const finding = ownerHoldGate(new Map([[SOURCES.holdKinds, "// nothing declared\n"]]), OWNER_HOLD_ENDS);
  assert.equal(finding.blocked, "no_hold_kind_declared");
  assert.equal(finding.owners.length, 0, "zero examined agrees with itself, which is why it is blocked");
});
