import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACTIVITY_LINE_PREFIX,
  ACTIVITY_POINT_LIMIT,
  describeActivityPoints,
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
  assert.deepEqual(summarizeActivity({ records: [], unparsable: 2 }), {
    points: [],
    omitted: 0,
    omittedMs: 0,
    unreadable: 2,
  });
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
    omittedMs: 3_600,
    unreadable: 0,
  });
  const full = summarizeActivity(read);
  assert.equal(full.points.length, 3);
  assert.equal(full.omitted, 0);
  assert.equal(full.omittedMs, 0, "a bundle that dropped nothing omits no time");
});

/**
 * THE BOUND HAS TO SAY HOW MUCH OF THE RUN IT DROPPED, NOT HOW MANY EVENTS.
 *
 * MEASURED (`round62`): `ACTIVITY_POINT_LIMIT` kept the first 512 points and dropped the tail, so the bundle's activity
 * read 166,069 ms of idle against the raw log's 222,064 ms - 55,995 ms that landed in the attribution's remainder with no
 * owner, because the field said `omitted 5` and nothing said 55,995. The duration is the reading; the count is beside it.
 */
test("the dropped tail is reported as the wall clock it covers, not only as a count", () => {
  const log = [line("thinking", 1_000), line("idle", 2_000), line("idle", 24_000), line("speaking", 80_000)].join("\n");
  const read = readActivityPoints(log);
  const bounded = summarizeActivity({ ...read, limit: 2 });

  assert.equal(bounded.omitted, 2, "two points the run published are not in the bundle");
  assert.equal(
    bounded.omittedMs,
    78_000,
    "the two dropped points cover 78,000 ms: from the last kept point (2,000) to the last published one (80,000)",
  );
  assert.equal(
    bounded.points.length + bounded.omitted,
    read.records.length,
    "kept plus dropped is what the run published, so no point is lost without being counted",
  );
  assert.equal(describeActivityPoints(bounded), "activity points kept 2 · dropped 2 · droppedMs 78000");
  assert.equal(
    describeActivityPoints("not_measured"),
    "not_measured",
    "a run with no channel has a duration nobody measured",
  );

  // Out-of-order clocks have no span to report; the clamp keeps a negative duration from reading as time recovered.
  const reversed = summarizeActivity({
    records: [
      { state: "idle", atMs: 9_000 },
      { state: "idle", atMs: 1_000 },
    ],
    limit: 1,
  });
  assert.equal(
    reversed.omittedMs,
    0,
    "a channel that published out of order reports no span rather than a negative one",
  );
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
  // And the bound's own reading is PRINTED, beside the delivery account the run already writes in words: a field in the
  // bundle is not a reading an operator sees, and the 55.9 s this unit exists for was invisible for exactly that reason.
  assert.equal(
    runner.includes('console.error("ACTIVITY_ACCOUNT", describeActivityPoints(activity));'),
    true,
    "the run prints the points it kept, dropped and droppedMs, so a bounded activity stream cannot read as a whole one",
  );
  assert.equal(ACTIVITY_POINT_LIMIT > 0, true);
});
