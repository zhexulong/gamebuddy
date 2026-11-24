/**
 * The other HUMAN PLAYERS, on the per-turn world line.
 *
 * <p>
 * THE FACT THIS FILE EXISTS FOR. `<world-state>` covered crops, weeds, objects, chests, animals, villagers, buildings and
 * ground, and nothing in it was the person standing next to her: `Game1.otherFarmers` was never read, so a co-op session
 * with a human at (33,17), facing left with a watering can in hand, was indistinguishable from an empty farm. This file
 * drives the real composer (`composeWorldState`) over the wire shape the Mod publishes, so what it asserts is the line the
 * model reads rather than a rendering written for the test.
 * </p>
 *
 * <p>
 * AND WHAT THE FAMILY IS NOT. No published action takes a human player as its target, so a row carries no address and the
 * label says so ("只能看见，不是目标"): the tests below hold the label to the row shape the wire declares, so a label
 * promising perception over an addressable row - or an addressable row under a label promising perception - fails here.
 * The action-addressing crossing itself is owned by `stardew-observation-budget-reachability.test.ts`, whose population is
 * the wire's row shapes crossed with the catalogue's own addressing arguments, and which therefore already includes this
 * family.
 * </p>
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { composeWorldState } from "./fact-brief.js";
import { FARMER_DOING_WORDS, FARMER_FACING_WORDS, TARGET_FAMILY_LABELS } from "./game-world-vocabulary.js";
import type { Snapshot } from "./protocol.js";

const WIRE_SCHEMA: Readonly<{
  $defs: Readonly<Record<string, Readonly<{ properties?: Readonly<Record<string, unknown>> }>>>;
}> = JSON.parse(readFileSync(new URL("../../protocol/bridge-v1.schema.json", import.meta.url), "utf8"));

/** The wire's own declaration of the family's row: the shape every assertion below is measured against. */
const OTHER_FARMER_ROW = WIRE_SCHEMA.$defs.otherFarmer?.properties ?? {};

/** The label this file holds to the row shape, read from the one table the renderer prints families from. */
const LABEL = TARGET_FAMILY_LABELS.otherFarmers ?? "";

/** The one row the fixtures publish: a human one tile away, facing left, holding a watering can, mid-swing. */
const BESIDE_HER = Object.freeze({
  location: "Farm",
  x: 33,
  y: 17,
  name: "阿明",
  facing: "left" as const,
  heldQualifiedItemId: "(T)WateringCan",
  heldDisplayName: "洒水壶",
  doing: "using_tool" as const,
});

/** The smallest snapshot the composer accepts, so each case varies only the family under test. */
const BASE: Snapshot = {
  revision: 12,
  location: "Farm",
  tile: { x: 32, y: 17 },
  stamina: 250,
  health: 100,
  actionable: true,
  capabilities: [],
  catalogRevision: 3,
  enabledActionIds: [],
  presentationLocale: "zh-CN",
  exhausted: false,
  timeOfDay: 900,
  dayOfMonth: 3,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
} as unknown as Snapshot;

/** The block the model is handed for one snapshot: the real composer, not a rendering written for this test. */
function blockOf(snapshot: Snapshot): string {
  return composeWorldState({
    snapshot,
    revision: snapshot.revision,
    ageTurns: 0,
    ageMs: 0,
    contentAgeMs: 0,
  });
}

test("a human standing beside her reaches the world line with every fact the engine answered", () => {
  const block = blockOf({ ...BASE, otherFarmers: [BESIDE_HER], otherFarmersOmitted: 0 } as unknown as Snapshot);

  // The label first: the row is printed under a word that says what it is and what it is not.
  assert.ok(LABEL.length > 0, "the family must have a label, or the row reaches the line under no name at all");
  assert.match(block, new RegExp(`${LABEL} \\(33,17\\)`, "u"), `the row names the tile the human stands on: ${block}`);
  // Position, name, facing, held thing, what they are doing - the five halves of the row.
  assert.ok(block.includes("阿明"), `the row names the player: ${block}`);
  assert.ok(block.includes(`朝向 ${FARMER_FACING_WORDS.left}`), `the row says which way they look: ${block}`);
  assert.ok(block.includes("拿 洒水壶"), `the row says what they hold: ${block}`);
  assert.ok(block.includes(`在做 ${FARMER_DOING_WORDS.using_tool}`), `the row says what they are doing: ${block}`);
  // The world line's own shape: the family costs one segment of the paragraph, not a block of its own.
  assert.equal(
    block.split("\n").filter((line) => line.startsWith(LABEL)).length,
    1,
    `the family prints once: ${block}`,
  );
});

test("empty hands are told apart from a hand that was not measured", () => {
  const empty = blockOf({
    ...BASE,
    otherFarmers: [{ ...BESIDE_HER, heldQualifiedItemId: "none", heldDisplayName: "none", doing: "idle" }],
    otherFarmersOmitted: 0,
  } as unknown as Snapshot);
  assert.ok(empty.includes("空手"), `a measured "no item in hand" prints as a fact: ${empty}`);
  assert.ok(empty.includes(`在做 ${FARMER_DOING_WORDS.idle}`), `and a body all four predicates answered no about: ${empty}`);

  // A row whose doing was NOT measured prints the word for that, never the idle claim.
  const unmeasured = blockOf({
    ...BASE,
    otherFarmers: [{ ...BESIDE_HER, doing: "not_measured" }],
    otherFarmersOmitted: 0,
  } as unknown as Snapshot);
  assert.ok(
    unmeasured.includes(`在做 ${FARMER_DOING_WORDS.not_measured}`),
    `a fact the engine could not answer says so: ${unmeasured}`,
  );
});

test("a human across the farm is withheld AND counted, so the line never says nobody is here", () => {
  // The window published no row and counted the one it withheld - the state a companion must not read as "I am alone".
  const block = blockOf({ ...BASE, otherFarmers: [], otherFarmersOmitted: 1 } as unknown as Snapshot);

  assert.match(
    block,
    new RegExp(`${LABEL} 这一带没有（Mod 那边还有 1 处没发出来）`, "u"),
    `the withheld farmer is a sentence with a number, not silence: ${block}`,
  );
  assert.equal(
    block.includes(`这一带没有：${LABEL}`),
    false,
    `and it is not also listed as a family with nothing in it: ${block}`,
  );

  // The other zero: a family the observation did not carry at all is NOT measured, and prints nothing at all.
  const absent = blockOf({ ...BASE } as unknown as Snapshot);
  assert.equal(absent.includes(LABEL), false, `an unmeasured family stays silent: ${absent}`);
});

test("the label promises perception only, and the wire's row carries no address", () => {
  // THE LABEL/ROW AGREEMENT. The label's whole claim is that this family is not a target ("只能看见，不是目标"), and the
  // row shape the wire declares is what has to keep that true: a row carrying an identifier an action could be shown
  // would make the label a lie, and the reachability gate would then be right to count the family as addressable.
  assert.ok(LABEL.includes("不是目标"), `the label must say the family is not a target: ${LABEL}`);
  assert.deepEqual(
    Object.keys(OTHER_FARMER_ROW)
      .filter((field) => /Id$/u.test(field) && field !== "heldQualifiedItemId" && field !== "heldDisplayName")
      .sort(),
    [],
    "the wire's row for a perception-only family must carry no address - `held*Id` names an item, not a target",
  );
  // And the facts the label promises are the facts the row declares: position, facing, held thing, what they are doing.
  for (const field of ["x", "y", "name", "facing", "heldQualifiedItemId", "heldDisplayName", "doing"])
    assert.ok(field in OTHER_FARMER_ROW, `the row the label is printed over declares ${field}`);
});
