import assert from "node:assert/strict";
import test from "node:test";

import { compilePlanScript } from "./body-program-script.js";
import type { ActionRegistration, Snapshot } from "./protocol.js";
import { planActionsFromRegistrations } from "./body-program-script.js";

/**
 * A MISTAKE VISIBLE BEFORE IT IS MADE.
 *
 * <p>
 * A plan is compiled against ONE snapshot, and the nodes it writes are dispatched into a world that may already have
 * moved. What this answers is narrower and checkable: did the snapshot the plan was compiled against actually carry the
 * layout facts the node's decision depends on? A watering node aimed at a crop row published before `isRaised` existed
 * (or by a family that never publishes it) is a plan whose author could not have known whether the column blocks - and
 * the answer says so instead of leaving the discovery to the receipt.
 * </p>
 *
 * <p>
 * It is NOT a refusal. The plan still compiles, still submits and still runs: the point is that a companion learns from
 * the answer's own words, and a harness that blocked her would teach nothing.
 * </p>
 */

const registrations: readonly ActionRegistration[] = [
  Object.freeze({
    actionId: "water_crop",
    familyId: "farming_crops",
    identityVersion: 1,
    lifecycle: "published" as const,
    kind: "execution" as const,
    descriptor: {
      argumentSchema: {
        x: { type: "integer" },
        y: { type: "integer" },
        expectedTargetId: { type: "string" },
      },
      outputFacts: {},
      targetFamily: "cropTargets",
    },
  }),
];

const actions = planActionsFromRegistrations(registrations);

const baseSnapshot: Snapshot = {
  revision: 21,
  location: "Farm",
  tile: { x: 10, y: 10 },
  stamina: 270,
  health: 100,
  actionable: true,
  exhausted: false,
  capabilities: ["water_crop"],
  catalogRevision: 1,
  enabledActionIds: ["water_crop"],
  presentationLocale: "en-US",
  timeOfDay: 600,
  dayOfMonth: 1,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
};

/** The row a Mod publishes TODAY: it carries both layout facts. */
const rowWithFacts = {
  targetId: "crop_deadbeef",
  x: 10,
  y: 12,
  cropId: "472",
  displayName: "Parsnip",
  watered: false,
  harvestable: false,
  isRaised: false,
  tileBlockedNow: false,
};

const SCRIPT = 'builder.water_crop({ x: 10, y: 12, expectedTargetId: "crop_deadbeef" });';

function compileAgainst(cropTargets: readonly Readonly<Record<string, unknown>>[]) {
  const snapshot = { ...baseSnapshot, cropTargets } as unknown as Snapshot;
  return compilePlanScript({ script: SCRIPT }, { snapshot, actions });
}

test("a plan whose row lacks a layout fact is compiled and warned about, not refused", () => {
  const { isRaised: _raised, tileBlockedNow: _blocked, ...rowWithoutLayoutFacts } = rowWithFacts;
  const compiled = compileAgainst([rowWithoutLayoutFacts]);

  assert.equal(compiled.ok, true, "the plan still runs: the warning is a fact, not a gate");
  assert.deepEqual(compiled.ok ? compiled.layoutFactsAbsent : [], [
    "layout_facts_absent:call 1:isRaised",
    "layout_facts_absent:call 1:tileBlockedNow",
  ]);
  assert.equal(compiled.ok ? compiled.layoutFactsAbsentCount : -1, 2);
});

test("a plan whose row carries the facts is answered with no warning at all", () => {
  const compiled = compileAgainst([rowWithFacts]);
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.ok ? compiled.layoutFactsAbsent : ["unreachable"], []);
  assert.equal(compiled.ok ? compiled.layoutFactsAbsentCount : -1, 0);
});

test("a node aimed at a tile the snapshot has no row for warns by the node's own position", () => {
  const compiled = compileAgainst([]);
  assert.equal(compiled.ok, true);
  assert.deepEqual(compiled.ok ? compiled.layoutFactsAbsent : [], [
    "layout_facts_absent:call 1:isRaised",
    "layout_facts_absent:call 1:tileBlockedNow",
  ]);
});

test("the warning list is bounded while its count is not", () => {
  const { isRaised: _raised, tileBlockedNow: _blocked, ...rowWithoutLayoutFacts } = rowWithFacts;
  const steps = Array.from(
    { length: 6 },
    (_, index) =>
      `builder.water_crop({ x: ${10 + index}, y: 12, expectedTargetId: "crop_deadbeef" });\n` +
      `builder.water_crop({ x: ${10 + index}, y: 13, expectedTargetId: "crop_deadbeef" });`,
  ).join("\n");
  const rows = Array.from({ length: 6 }, (_, index) =>
    ["a", "b"].map((suffix) => ({
      ...rowWithoutLayoutFacts,
      targetId: `crop_deadbeef_${index}_${suffix}`,
      x: 10 + index,
      y: suffix === "a" ? 12 : 13,
    })),
  ).flat();
  const compiled = compilePlanScript(
    { script: steps },
    { snapshot: { ...baseSnapshot, cropTargets: rows } as unknown as Snapshot, actions },
  );

  assert.equal(compiled.ok, true);
  assert.equal(compiled.ok ? compiled.layoutFactsAbsentCount : -1, 24, "twelve nodes, two facts each");
  assert.equal(
    compiled.ok ? compiled.layoutFactsAbsent.length : -1,
    8,
    "the list is bounded; the count is the population",
  );
  // AND THE WINDOW SAYS HOW IT WAS CUT: the last row is the ceiling and the population it truncated, so the list is
  // never read as a whole answer that happens to be short. Measured before this row existed: eight rows and no way to
  // tell 8 of 8 from 8 of 24 without comparing `layoutFactsAbsentCount` beside them by hand.
  assert.equal(
    compiled.ok ? compiled.layoutFactsAbsent.at(-1) : "",
    "layout_facts_absent_over_ceiling:24:8",
    "a truncated list ends in the code that names its ceiling and the population it cut",
  );
  assert.equal(
    compiled.ok ? compiled.layoutFactsAbsent.filter((row) => row.startsWith("layout_facts_absent:")).length : -1,
    7,
    "the ceiling row takes one slot of the eight, so the window is 7 facts and one code - the list stays eight long",
  );
});
