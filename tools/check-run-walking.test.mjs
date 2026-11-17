/**
 * The walking reading against a number it did not compute: `round66`'s hand count.
 *
 * WHY THIS FILE EXISTS. A reading is only a measurement if it can be WRONG, and the only way to know that a parser of a
 * 174-line fact stream reads what a human read is to compare them on the same run. `round66` was counted by hand from
 * its receipts - `37 positioned events · 647 tiles walked (Manhattan) · 17 world-changing actions = 38 tiles/action`,
 * with three crops visited `(60,10) → (58,14) → (60,9)` costing 13 tiles where 8 would do - and every test below either
 * reproduces one of those numbers or makes the same guard red on an injected violation.
 *
 * The fact stream used is the COMMITTED one (`tools/fixtures/declared-deleted/round66-facts.runner-log`): it is the real
 * run's `BRIDGE_FACT` lines, the same 46 `accepted` receipts the Mod's receipt-uniqueness test counts, so the reading is
 * held to history rather than to a fixture someone invented to agree with the parser.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { main } from "./check-run-walking.mjs";
import {
  WALKING_READINGS,
  auditWalkingAccount,
  auditWalkingMeasurement,
  manhattanLeg,
  manhattanSpanningTree,
  readWalking,
  renderWalking,
} from "./lib/walking.mjs";

const ROUND66 = "tools/fixtures/declared-deleted/round66-facts.runner-log";
const TEXT = readFileSync(ROUND66, "utf8");
const RECORD = readWalking(TEXT, { source: ROUND66 });
const ACCOUNT = renderWalking(RECORD);

const scratch = mkdtempSync(join(tmpdir(), "run-walking-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

/** A log a test can hand the reader: `BRIDGE_FACT <json>` lines, nothing else. */
function logOf(facts) {
  return `${facts.map((fact) => `BRIDGE_FACT ${JSON.stringify(fact)}`).join("\n")}\n`;
}

const receipt = (actionId, reasonCode, detail, executionId = `exec-${reasonCode}`) => ({
  type: "execution_receipt",
  atMs: 1,
  executionId,
  reasonCode,
  evidence: { detail },
  worldFactPayload: { actionId, reasonCode },
});

/**
 * The LENGTH OF THE LEAST WALKING ORDER from the first position, by enumeration - the second method the printed bound
 * is checked against. Only for a handful of positions: the reading prints a spanning tree because an optimum is not
 * computable for 37, and this exists to prove the tree never exceeds the optimum on sets small enough to know it.
 */
function bestOrderFromStart(positions) {
  const rest = positions.slice(1);
  const permutations = (items) =>
    items.length <= 1
      ? [items]
      : items.flatMap((item, index) =>
          permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((tail) => [item, ...tail]),
        );
  return Math.min(
    ...permutations(rest).map((order) => {
      const path = [positions[0], ...order];
      return path.slice(1).reduce((sum, point, index) => sum + manhattanLeg(path[index], point), 0);
    }),
  );
}

function logFile(name, text) {
  const path = join(scratch, name);
  writeFileSync(path, text);
  return path;
}

// ---------------------------------------------------------------------------------------------------------------------
// ① THE KNOWN ANSWER. Every number here was counted by hand from `round66`'s receipts before this parser existed.
// ---------------------------------------------------------------------------------------------------------------------

test("① round66 reads 37 positioned events · 647 tiles · 38 tiles/action · longest 81", () => {
  assert.match(ACCOUNT, /walked 647 tiles/u, `the hand count is 647 tiles, the account says: ${ACCOUNT}`);
  assert.match(ACCOUNT, /positioned events 37 \(44 facts stated a body position, 7 restated/u, ACCOUNT);
  assert.match(ACCOUNT, /tiles per action 38 \(17 world-changing actions\)/u, ACCOUNT);
  assert.match(ACCOUNT, /longest walk 81 tiles/u, ACCOUNT);
  assert.equal(RECORD.walked, 647);
  assert.equal(RECORD.positioned, 37);
  assert.equal(RECORD.longest, 81);
  assert.equal(Math.round(RECORD.perAction), 38, "647 tiles over 17 world-changing actions is 38 tiles/action");
  assert.equal(RECORD.examined, 174, "the run's fact stream, as the log writes it");
  assert.match(
    ACCOUNT,
    /body position carried by approach 17, arrival 23, settlement 4/u,
    "the account names WHICH facts carried a position, and the three counts sum to the 44",
  );
  assert.equal(RECORD.carriers["approach:placed"] + RECORD.carriers["arrival:placed"] + RECORD.carriers["settlement:placed"], RECORD.placed);
});

test("① the CLI agrees with the record, exit 0 on the pinned history", () => {
  assert.equal(
    main(["--log", ROUND66, "--expect", "walked=647,positioned=37,longest=81,perAction=38,bound=163,excess=484"]),
    0,
  );
});

test("① the three crops walk 13 tiles where the best order walks 8 - the hand count's own example", () => {
  const crops = RECORD.positions.filter((position) => position.reason === "crop_harvested");
  assert.deepEqual(
    crops.map((position) => `${String(position.x)},${String(position.y)}`),
    ["60,10", "58,14", "60,9"],
    "the run harvested three crops, in this order",
  );
  const walked = crops
    .slice(1)
    .reduce((sum, crop, index) => sum + manhattanLeg(crops[index], crop), 0);
  assert.equal(walked, 13, "60,10 → 58,14 → 60,9 is 6 + 7 tiles");
  const optimal = bestOrderFromStart(crops);
  assert.equal(optimal, 8, "the best order of the same three crops walks 8: 60,10 → 60,9 → 58,14");
  assert.ok(manhattanSpanningTree(crops) <= optimal, "the printed bound is never above the optimum");
  assert.equal(
    manhattanSpanningTree(crops),
    7,
    "the tree takes the two cheapest edges (1 and 6) and is one tile short",
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// ② THE THREE READINGS ARE ONE READING EACH. Properties, not copies of today's numbers.
// ---------------------------------------------------------------------------------------------------------------------

test("② walked / longest / excess are the legs they claim to be", () => {
  assert.equal(RECORD.walked, RECORD.legs.reduce((sum, leg) => sum + leg, 0));
  assert.equal(RECORD.longest, Math.max(...RECORD.legs));
  assert.equal(RECORD.excess, RECORD.walked - RECORD.bound);
  assert.equal(RECORD.legs.length, RECORD.positioned - 1, "n positions make n-1 legs");
});

test("② the bound is a LOWER bound: no visiting order can be shorter than the tree", () => {
  assert.ok(
    RECORD.bound <= RECORD.walked,
    `bound ${String(RECORD.bound)} must not exceed walked ${String(RECORD.walked)}`,
  );
  // An order that is already optimal has walked === tree: a straight line walked in one direction.
  const line = [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 4 },
    { x: 10, y: 4 },
  ];
  const walkedAlong = line.slice(1).reduce((sum, point, index) => sum + manhattanLeg(line[index], point), 0);
  assert.equal(manhattanSpanningTree(line), walkedAlong, "walking a line once is optimal, so the tree equals it");
  // An order that doubles back has walked > tree, which is the whole reason `excess` is printed.
  const backAndForth = [line[0], line[3], line[0]];
  const doubled = manhattanLeg(backAndForth[0], backAndForth[1]) + manhattanLeg(backAndForth[1], backAndForth[2]);
  assert.ok(doubled > manhattanSpanningTree(backAndForth));
  assert.equal(doubled, 28, "10,4 twice is 28 tiles, and the tree over the same two points is 14");
});

test("② a restated position is counted once and named: 44 body positions, 37 positions, 7 restated", () => {
  assert.equal(RECORD.placed - RECORD.positioned, RECORD.restated);
  const positions = RECORD.positions;
  for (let index = 1; index < positions.length; index += 1) {
    assert.ok(
      positions[index].x !== positions[index - 1].x || positions[index].y !== positions[index - 1].y,
      `position ${String(index)} repeats the one before it and should have collapsed`,
    );
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// ③ `walking_is_measured_not_abbreviated`. `unplaced 0` has to be a measurement, and a log with nothing to place is
//    BLOCKED rather than green.
// ---------------------------------------------------------------------------------------------------------------------

test("③ every examined fact lands in exactly one named bucket: examined 174 = counted 174", () => {
  assert.equal(RECORD.placement.examined, RECORD.examined);
  assert.equal(
    RECORD.placement.counted,
    RECORD.examined,
    "a fact that lands nowhere would make `unplaced` an abbreviation",
  );
  assert.equal(RECORD.placement.omitted, 0);
  const buckets = RECORD.placement.counts.reduce((sum, entry) => sum + entry.total, 0);
  assert.equal(buckets, RECORD.examined, "the buckets partition the population");
  const total = Object.fromEntries(RECORD.placement.counts.map((entry) => [entry.key, entry.total]));
  assert.equal(total["body position"], RECORD.placed);
  assert.equal(RECORD.placed + RECORD.unplaced, RECORD.examined);
  assert.equal(auditWalkingMeasurement(RECORD, ROUND66).verdict, "measured");
});

test("③ THE FALSIFIER: a log whose positions are stripped is BLOCKED, not walked 0", () => {
  const POSITION = /\b(?:tile|reached|actor|actual|target|stand_at)=-?\d+,-?\d+;?/gu;
  const stripped = TEXT.split("\n")
    .filter((line) => line.startsWith("BRIDGE_FACT "))
    .map((line) => line.replace(POSITION, ""))
    .join("\n");
  const path = logFile("stripped.runner-log", `${stripped}\n`);
  const blocked = main(["--log", path]);
  assert.equal(blocked, 2, "a fact stream with no body position measured NOTHING, and 0 tiles would be a lie");
  const record = readWalking(`${stripped}\n`, { source: "stripped" });
  assert.equal(record.positioned, 0);
  assert.equal(record.examined > 0, true, "the facts are still there - only the positions are gone");
  const verdict = auditWalkingMeasurement(record, "stripped");
  assert.equal(verdict.verdict, "blocked");
  assert.equal(verdict.code, "walking_nothing_to_place");
});

test("③ THE FALSIFIER: one restored arrival turns the same log from BLOCKED into a reading", () => {
  const one = readWalking(
    logOf([receipt("move_to_tile", "target_reached", "tile=4,5;target=4,5;arrival=exact")]),
    { source: "one arrival" },
  );
  assert.equal(auditWalkingMeasurement(one, "one arrival").verdict, "measured");
  assert.equal(one.positioned, 1);
  assert.equal(one.walked, 0);
  assert.equal(one.longest, 0);
  assert.match(renderWalking(one), /positioned events 1/u, "the genuine zero prints the count beside it");
});

test("③ THE FALSIFIER: a log with no BRIDGE_FACT line is `walking_not_measured`, not a clean run", () => {
  const empty = readWalking("assistant turns examined 2 · per delivered batch: turns opened 1\n", {
    source: "no facts",
  });
  const verdict = auditWalkingMeasurement(empty, "no facts");
  assert.equal(verdict.verdict, "blocked");
  assert.equal(verdict.code, "walking_not_measured");
  assert.equal(main(["--log", logFile("not-a-run.runner-log", "assistant turns examined 2\n")]), 2);
});

test("③ a settlement that names its subject and no tile is COUNTED, and placing it moves the walk", () => {
  const withoutTile = RECORD.placement.counts.find((entry) => entry.key === "subject without a tile");
  assert.equal(withoutTile?.total, 9, "seven chops, one cut weed and one broken rock name an id, not a tile");
  const chopped = TEXT.split("\n").find((line) => line.includes("tree_source_chopped"));
  assert.ok(chopped !== undefined);
  const withTile = chopped.replace(
    /"detail":"target=([^;"]+)/u,
    '"detail":"tile=56,31;target=$1',
  );
  assert.notEqual(withTile, chopped, "the injected position has to land in the detail");
  const after = readWalking(TEXT.replace(chopped, withTile), { source: "one chop placed" });
  assert.equal(after.placed, RECORD.placed + 1, "the row was read all along; only its position was missing");
  assert.equal(
    after.walked,
    RECORD.walked,
    "56,31 is where the chop's approach already put the body, so the walk does not move",
  );
  assert.equal(after.placement.counted, after.placement.examined);
  assert.equal(
    after.placement.counts.find((entry) => entry.key === "subject without a tile")?.total,
    8,
    "the bucket that held it shrank by exactly one",
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// ④ `a_run_does_not_report_its_walking:<field>`, against the DECLARATION and not against a list.
// ---------------------------------------------------------------------------------------------------------------------
test("④ the run's own account reports 0 of 6 walking readings - the gap this reader fills, on real history", () => {
  assert.equal(RECORD.sessionAccount.lines, 3, "round66 printed three GAME_TURN_ACCOUNT lines");
  assert.equal(
    RECORD.sessionAccount.readings,
    0,
    "and none of them carried a distance, which is why the hand count had to be done by hand",
  );
  assert.match(ACCOUNT, /walking in the run's own account: 0 of 6 readings over 3 GAME_TURN_ACCOUNT line\(s\)/u);
  const withWalking = readWalking(
    `${logOf([receipt("move_to_tile", "target_reached", "tile=4,5;target=4,5")])}\n` +
      'GAME_TURN_ACCOUNT turns opened 1 · walked 9 tiles · positioned events 2 · longest walk 9 tiles\n',
    { source: "an account that reports its walking" },
  );
  assert.equal(withWalking.sessionAccount.readings, 3, "the three fields the account carried are counted as present");
});

test("④ the account reports every declared reading, and the gate names the one that is missing", () => {
  assert.deepEqual(auditWalkingAccount(ACCOUNT), [], "the real account reports all six");
  for (const reading of WALKING_READINGS) {
    const without = ACCOUNT.split(`${reading.field} `).join("");
    const findings = auditWalkingAccount(without);
    assert.ok(
      findings.some((finding) => finding.code === `a_run_does_not_report_its_walking:${reading.id}`),
      `dropping \`${reading.field}\` must fail by name: ${JSON.stringify(findings)}`,
    );
    assert.equal(findings.length, 1, `only \`${reading.id}\` was dropped, so only it may fire`);
  }
});

test("④ THE FALSIFIER: a reading declared and never rendered fails on the next renderer", () => {
  const truncated = renderWalking(RECORD).split("\n")[0];
  const findings = auditWalkingAccount(truncated);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["a_run_does_not_report_its_walking:bound", "a_run_does_not_report_its_walking:excess"],
    "a renderer that prints only the first line loses the comparison, by name",
  );
});

// ---------------------------------------------------------------------------------------------------------------------
// ⑤ WHAT IT REFUSES TO MEASURE. A destination is not a position, and an item's tile is not the body's.
// ---------------------------------------------------------------------------------------------------------------------

test("⑤ a destination is counted as `not the body` and does not move the walk", () => {
  const accepted = RECORD.carriers.destination;
  assert.ok(accepted > 0, "round66 accepted receipts state where the body is going");
  const destinationOnly = readWalking(
    logOf([receipt("move_to_tile", "accepted", "route_revision=1;target=3,11")]),
    { source: "destination only" },
  );
  assert.equal(destinationOnly.placed, 0);
  assert.equal(destinationOnly.placement.counts[0].key, "not the body");
});

test("⑤ an item's tile is counted as `not the body`: the magnet pulled it in, the body did not walk to it", () => {
  const pickup = readWalking(
    logOf([receipt("pickup_item", "item_picked_up", "location=Farm;tile=61,33;within_magnet=true;radius=1")]),
    { source: "pickup only" },
  );
  assert.equal(pickup.placed, 0);
  assert.equal(pickup.placement.counts[0].key, "not the body");
  const arrived = readWalking(
    logOf([
      receipt("pickup_item", "item_pickup_approach_completed", "tile=60,33;target=61,33;arrival=exact"),
      receipt("pickup_item", "item_picked_up", "location=Farm;tile=61,33;within_magnet=true", "exec-1"),
    ]),
    { source: "approach then pickup" },
  );
  assert.equal(arrived.positioned, 1, "the approach states the stand tile; the pickup states the item's");
});

test("⑤ a warp's location-bound position is named, not silently dropped", () => {
  const warp = readWalking(
    logOf([receipt("enter_exit", "enter_exit_completed", "expected=Farm:64,15;actual=Farm:64,15")]),
    { source: "warp only" },
  );
  assert.equal(warp.placed, 0);
  assert.equal(warp.placement.counts[0].key, "location-bound position");
  assert.equal(RECORD.placement.counts.find((entry) => entry.key === "location-bound position")?.total, 9);
});
