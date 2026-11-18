import assert from "node:assert/strict";
import test from "node:test";

import {
  probeStardewGuardianObjects,
  type StardewGuardianNamedObjectAnswer,
  type StardewGuardianNamedObjectProbe,
  type StardewGuardianObjectPresence,
} from "./stardew-guardian-object-presence.js";

const NAMES = Object.freeze({
  playerJobName: "Local\\GameBuddy-PlayerJob-1",
  leaseName: "Local\\GameBuddy-Lease-1",
});

/** The declared answer vocabulary; every pair of them must have a defined verdict. */
const ANSWERS: readonly StardewGuardianNamedObjectAnswer[] = ["opened", "not_found", "unclassified", "unmeasured"];

function answeringProbe(
  playerJob: StardewGuardianNamedObjectAnswer,
  lease: StardewGuardianNamedObjectAnswer,
): StardewGuardianNamedObjectProbe {
  return async () => ({ playerJob, lease });
}

test("presence is absent only when both Guardian-owned objects are gone", async () => {
  const verdict = await probeStardewGuardianObjects(answeringProbe("not_found", "not_found"), NAMES);
  assert.deepEqual(verdict, { presence: "absent", playerJob: "not_found", lease: "not_found" });
});

test("presence is present only when both Guardian-owned objects can be opened", async () => {
  const verdict = await probeStardewGuardianObjects(answeringProbe("opened", "opened"), NAMES);
  assert.deepEqual(verdict, { presence: "present", playerJob: "opened", lease: "opened" });
});

/**
 * The population is the declared answer vocabulary against itself, so a new
 * answer added to the union cannot arrive without a verdict: the table below
 * fails on the member that has no expected presence instead of silently mapping
 * it to one.
 */
test("every pair of OS answers has the conservative verdict, and one absent object proves nothing", async () => {
  const expected: Readonly<Record<string, StardewGuardianObjectPresence>> = Object.freeze({
    "opened:opened": "present",
    "not_found:not_found": "absent",
    // The Guardian drops the lease and the player Job at different moments, so a
    // single absent object says only that one of them is gone.
    "not_found:opened": "unverifiable",
    "opened:not_found": "unverifiable",
    // Access denied, a foreign DACL, or a name that resolves to another object
    // kind: the object may well exist, and nothing may be released on a guess.
    "opened:unclassified": "unverifiable",
    "unclassified:opened": "unverifiable",
    "not_found:unclassified": "unverifiable",
    "unclassified:not_found": "unverifiable",
    "unclassified:unclassified": "unverifiable",
    // The probe could not run, so neither object was asked about. It is not a
    // statement about either of them, and it wins over every pair: a probe that
    // never ran cannot have seen one object present and the other gone.
    "unmeasured:opened": "unmeasured",
    "unmeasured:not_found": "unmeasured",
    "unmeasured:unclassified": "unmeasured",
    "unmeasured:unmeasured": "unmeasured",
    "opened:unmeasured": "unmeasured",
    "not_found:unmeasured": "unmeasured",
    "unclassified:unmeasured": "unmeasured",
  });
  const examined: string[] = [];
  for (const playerJob of ANSWERS) {
    for (const lease of ANSWERS) {
      const key = `${playerJob}:${lease}`;
      const wanted = expected[key];
      assert.notEqual(wanted, undefined, `no verdict is declared for ${key}`);
      const verdict = await probeStardewGuardianObjects(answeringProbe(playerJob, lease), NAMES);
      assert.equal(verdict.presence, wanted, `wrong presence for ${key}`);
      examined.push(key);
    }
  }
  assert.equal(examined.length, ANSWERS.length * ANSWERS.length);
  assert.deepEqual([...examined].sort(), Object.keys(expected).sort());
});

test("a probe that cannot answer says so, rather than reading as a verdict about the objects", async () => {
  const verdict = await probeStardewGuardianObjects(async () => {
    throw new Error("windows_guardian_object_probe_unavailable");
  }, NAMES);
  // `unmeasured`, not `unverifiable`: nothing was asked about either object, and the
  // caller must be able to name that rather than report them as still owned.
  assert.deepEqual(verdict, { presence: "unmeasured", playerJob: "unmeasured", lease: "unmeasured" });
});

test("an answer outside the declared vocabulary reads as unclassified, never as absence", async () => {
  const verdict = await probeStardewGuardianObjects(
    (async () => ({ playerJob: "denied", lease: "not_found" })) as unknown as StardewGuardianNamedObjectProbe,
    NAMES,
  );
  assert.deepEqual(verdict, { presence: "unverifiable", playerJob: "unclassified", lease: "not_found" });
});

test("the probe receives the exact names the owner record carries", async () => {
  const seen: Array<Readonly<{ playerJobName: string; leaseName: string }>> = [];
  await probeStardewGuardianObjects(async (names) => {
    seen.push(names);
    return { playerJob: "opened", lease: "opened" };
  }, NAMES);
  assert.deepEqual(seen, [NAMES]);
});
