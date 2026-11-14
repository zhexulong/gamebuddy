/**
 * The clear_fish_pond clause, in every direction the LIVE run could lie.
 *
 * WHY THESE CASES. This hook is the only test of the one clause `contracts/smoke/clear_fish_pond.json` cannot state:
 * the ground debris carrying the pond's fish type must be at least the pond's occupants. The hand-written runner
 * that made this count was deleted while the clause was still declared `unasserted`, so the cases below are the
 * runner's own cases, kept beside the code that now holds them - equal, one short, the two id forms a real receipt
 * carries, and the shapes where the hook must FAIL rather than pass because it could not look.
 *
 * red-proof: inject  `if (ejected >= occupants) return [];` replaced by `return [];` at the top of the function
 *            -> every short-count case below fails, naming the numbers it no longer compares
 *            (tools/assertions/clear_fish_pond.test.mjs).
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSmokeContractFile } from "../lib/stardew-action-smoke-contract.mjs";
import { asserts, clearFishPond } from "./clear_fish_pond.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const POND_ID = "fish_pond_0123456789abcdef";
const POND = Object.freeze({
  targetId: POND_ID,
  location: "Farm",
  x: 10,
  y: 12,
  buildingType: "Fish Pond",
  occupants: 3,
  fishType: "128",
});

const evidenceOf = (fields = { pond_id: POND_ID }) => new Map(Object.entries(fields));
const debris = (ids) => ids.map((qualifiedItemId) => ({ qualifiedItemId, x: 11, y: 12 }));
const run = (overrides = {}) =>
  clearFishPond({
    before: { fishPondTargets: [POND] },
    after: { itemTargets: debris(["(O)128", "(O)128", "(O)128"]) },
    evidence: evidenceOf(),
    ...overrides,
  });

test("as many ejected fish as the pond held satisfies the clause", () => {
  assert.deepEqual(run(), []);
});

test("one fish short fails, and the failure names both numbers", () => {
  const failures = run({ after: { itemTargets: debris(["(O)128", "(O)128"]) } });
  assert.equal(failures.length, 1);
  assert.match(failures[0], /^worldAfter\.itemTargets:/u, "a failure names the clause it belongs to");
  assert.match(failures[0], /= 2\b/u, `the count that was found is named: ${failures[0]}`);
  assert.match(failures[0], /occupants before = 3\b/u, `the count it was measured against is named: ${failures[0]}`);
});

test("the two id forms the two surfaces use are counted together", () => {
  const pond = { ...POND, occupants: 2, fishType: "128" };
  assert.deepEqual(run({ before: { fishPondTargets: [pond] }, after: { itemTargets: debris(["(O)128", "128"]) } }), []);
});

test("a substring of the id is not the fish, so 1280 does not count for 128", () => {
  const pond = { ...POND, occupants: 1 };
  const failures = run({ before: { fishPondTargets: [pond] }, after: { itemTargets: debris(["(O)1280"]) } });
  assert.equal(failures.length, 1, "an id that merely contains 128 is not the pond's fish");
});

test("debris of a different fish does not count as this pond's ejection", () => {
  const pond = { ...POND, occupants: 1 };
  assert.equal(run({ before: { fishPondTargets: [pond] }, after: { itemTargets: debris(["(O)999"]) } }).length, 1);
});

test("a receipt that names no pond is a failure, never a crash and never a pass", () => {
  // The two shapes a real receipt can arrive in: a parsed bag with no `pond_id`, and no bag at all. "I could not
  // look" must not read as "there was nothing to find".
  for (const evidence of [evidenceOf({}), new Map(), null, undefined]) {
    const failures = run({ evidence });
    assert.equal(failures.length, 1, `evidence ${String(evidence)} produced ${failures.length} failures`);
    assert.match(failures[0], /pond_id=none/u, `the missing key is named: ${failures[0]}`);
  }
});

test("a pond the observation does not publish, and a surface with no itemTargets, both fail", () => {
  assert.equal(run({ before: { fishPondTargets: [{ ...POND, targetId: "another_pond" }] } }).length, 1);
  const unobservable = run({ after: {} });
  assert.equal(unobservable.length, 1);
  assert.match(unobservable[0], /no itemTargets array/u, `the run says it could not look: ${unobservable[0]}`);
});

test("the hook declares the clause it answers, in the coverage gate's own spelling", () => {
  assert.deepEqual([...asserts], ["worldAfter.itemTargets"]);
});

test("the contract that names this hook no longer declares the clause unasserted", () => {
  // The defect this file exists to repair: a declaration that outlived the test it excused. Read from the committed
  // contract rather than restated here, so renaming either side is one finding instead of two readings.
  const contract = loadSmokeContractFile(join(ROOT, "contracts/smoke/clear_fish_pond.json"));
  assert.equal(contract.assertion, "clear_fish_pond", "the contract names this hook");
  assert.deepEqual(Object.keys(contract.unasserted), [], "a clause a hook asserts cannot also be declared unasserted");
});
