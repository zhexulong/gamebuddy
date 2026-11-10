import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_LINE_PREFIX,
  ACTIVITY_POINT_LIMIT,
  readActivityPoints,
  summarizeActivity,
} from "./companion-activity.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** One `COMPANION_ACTIVITY` line, in the shape `host/src/companion-activity.ts` prints. */
const line = (state, atMs) => `COMPANION_ACTIVITY ${JSON.stringify({ state, atMs })}`;

test("a run that published no transition is not_measured, not an empty array", () => {
  // The distinction the bundle exists for: `[]` reads as "she was never idle and never thinking", which is a claim
  // about the run - and it is the same array a run whose channel never wrote a line would carry. MEASURED 2026-11-06
  // (round39): 902 s to the first visible text and a 709 s stretch of silence, with no bundle field that could say
  // whether the companion was thinking or the pipeline had nothing to wake her.
  const measured = readActivityPoints("");
  assert.deepEqual(measured, { records: [], unparsable: 0 });
  assert.equal(summarizeActivity(measured), "not_measured");
  assert.notDeepEqual(summarizeActivity(measured), []);
  // A run whose lines could not be read is also not a measured run, and it says how many lines it could not read
  // rather than reporting silence.
  assert.deepEqual(summarizeActivity({ records: [], unparsable: 2 }), { points: [], omitted: 0, unreadable: 2 });
});

test("the points the bundle carries are the Host's own lines, bounded with a counted remainder", () => {
  const log = [
    'NATIVE_COMPANION_TURN_DELIVERY {"textParts":1}',
    line("thinking", 1_000),
    line("speaking", 5_400),
    line("idle", 9_000),
  ].join("\n");
  const read = readActivityPoints(log);
  assert.deepEqual(read.records, [
    { state: "thinking", atMs: 1_000 },
    { state: "speaking", atMs: 5_400 },
    { state: "idle", atMs: 9_000 },
  ]);
  // The bound keeps the run's OPENING: the stretch a silence audit reads is the first one, and a later point cannot
  // reconstruct it. `points.length + omitted` is what the run published.
  assert.deepEqual(summarizeActivity({ ...read, limit: 2 }), {
    points: [
      { state: "thinking", atMs: 1_000 },
      { state: "speaking", atMs: 5_400 },
    ],
    omitted: 1,
    unreadable: 0,
  });
  const full = summarizeActivity(read);
  assert.equal(full.points.length, 3);
  assert.equal(full.omitted, 0);
});

test("a line that is not a point is counted, not read as a state", () => {
  const log = [line("thinking", 10), 'COMPANION_ACTIVITY {"state":"idle"}', "COMPANION_ACTIVITY not-json"].join("\n");
  const read = readActivityPoints(log);
  assert.deepEqual(read.records, [{ state: "thinking", atMs: 10 }]);
  assert.equal(read.unparsable, 2, "a point without a clock, and a line that is not JSON, are both unreadable");
});

test("the reader and the Host name the channel the same way", () => {
  // Single authority per fact: the line name crosses a process boundary, so it is checked against the producer's own
  // declaration rather than being a second hand-written copy that agrees today.
  const source = readFileSync(resolve(repositoryRoot, "host/src/companion-activity.ts"), "utf8");
  const declared = /export const COMPANION_ACTIVITY_LINE = "([A-Z_]+)";/u.exec(source);
  assert.notEqual(declared, null, "host/src/companion-activity.ts must declare COMPANION_ACTIVITY_LINE");
  assert.equal(`${declared[1]} `, ACTIVITY_LINE_PREFIX);
  // And the bundle field is actually written by the runner, not merely available to it.
  const runner = readFileSync(
    resolve(repositoryRoot, "tools/live-run/game/run-stardew-native-local-agent-ab-live.mjs"),
    "utf8",
  );
  assert.equal(runner.includes("summarizeActivity(readActivityPoints(hostLog))"), true);
  assert.equal(
    runner.includes("    deliveryAccount,\n    activity,\n"),
    true,
    "the bundle carries the field beside the delivery account",
  );
  assert.equal(ACTIVITY_POINT_LIMIT > 0, true);
});
