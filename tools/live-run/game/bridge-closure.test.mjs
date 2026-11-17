// A closed bridge ends the run instead of stalling it.
//
// WHY (measured 2026-11-17): after `BRIDGE_DISCONNECTED reasonCode=fact_listener_failed` at 1006833 ms, round66 published
// THIRTY-TWO `GAME_CLOCK_STALLED` lines over the next 930 s - every one with `solicit: "not_attempted:bridge_closed"`,
// `readingsSeen` frozen at 32 and `sinceLastSnapshotMs` climbing to 1179640 - and then the log stopped. Round65 is the
// same shape (to 1326166). The readings below are that run's own tail, in its own units, so the gate is proved red on
// real history rather than on a shape invented to fail.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { BRIDGE_CLOSED_SOLICIT, bridgeClosureStop, countStallsAfterClosure } from "./bridge-closure.mjs";

const RUNNER = join(resolve(dirname(fileURLToPath(import.meta.url))), "run-stardew-native-local-agent-ab-live.mjs");

/** round66's `BRIDGE_DISCONNECTED`, verbatim in its fields. */
const ROUND66_DISCONNECT = Object.freeze({
  reasonCode: "fact_listener_failed",
  atMs: 1794929983237,
  elapsedMs: 1006833,
  flatDispatchesSoFar: 0,
  dispatchesSoFar: 0,
  minFreeMb: 634,
  hostRssMb: 896,
});

/** round66's thirty-two stall readings after that disconnect: `atMs` and `sinceLastSnapshotMs` as published. */
const ROUND66_STALLS = Object.freeze(
  [
    [1794929996407, 249440],
    [1794930026423, 279456],
    [1794930056438, 309471],
    [1794930086442, 339475],
    [1794930116450, 369483],
    [1794930146463, 399496],
    [1794930176474, 429507],
    [1794930206474, 459507],
    [1794930236477, 489510],
    [1794930266480, 519513],
    [1794930296484, 549517],
    [1794930326497, 579530],
    [1794930356502, 609535],
    [1794930386506, 639539],
    [1794930416510, 669543],
    [1794930446513, 699546],
    [1794930476521, 729554],
    [1794930506526, 759559],
    [1794930536535, 789568],
    [1794930566537, 819570],
    [1794930596545, 849578],
    [1794930626552, 879585],
    [1794930656564, 909597],
    [1794930686565, 939598],
    [1794930716566, 969599],
    [1794930746566, 999599],
    [1794930776566, 1029599],
    [1794930806578, 1059611],
    [1794930836589, 1089622],
    [1794930866594, 1119627],
    [1794930896604, 1149637],
    [1794930926607, 1179640],
  ].map(([atMs, sinceLastSnapshotMs]) =>
    Object.freeze({
      atMs,
      sinceLastSnapshotMs,
      heartbeatMs: 30000,
      readingsSeen: 32,
      solicit: BRIDGE_CLOSED_SOLICIT,
      lastReading: Object.freeze({ timeOfDay: 1050, day: 6 }),
    }),
  ),
);

test("round66's tail ends at the FIRST stall after the bridge closed, not the thirty-second", () => {
  const reading = countStallsAfterClosure(ROUND66_STALLS);
  console.log(
    `stall_after_the_bridge_closed:${String(reading.examined)} -> ${String(reading.examined - reading.repeatedAfterEnd)}`,
  );
  assert.equal(reading.examined, 32);
  assert.equal(reading.endedAt, 0, "the run ends at the first reading that says the bridge is closed");
  assert.equal(reading.repeatedAfterEnd, 31, "the other thirty-one lines are the repeats this rule refuses");
  // What the wait cost, in the run's own units: the last stall is 930 s after the first, all of it after the transport
  // was already gone.
  const wastedMs = ROUND66_STALLS.at(-1).atMs - ROUND66_STALLS[0].atMs;
  assert.equal(wastedMs, 930_200, "fifteen and a half minutes, measured");
});

test("the falsifier: the same thirty-two readings over a LIVE bridge are just a slow world", () => {
  const live = ROUND66_STALLS.map((payload, index) =>
    Object.freeze({ ...payload, solicit: index % 2 === 0 ? "read:1050" : "not_attempted:inside_heartbeat_bound" }),
  );
  const reading = countStallsAfterClosure(live);
  assert.equal(reading.endedAt, null, "a bridge that answered is not a bridge that closed");
  assert.equal(reading.repeatedAfterEnd, 0);
  assert.equal(reading.examined, 32, "the population is the same, so the difference is the reading and not the size");
});

test("a stall that could not ask for another reason is not a closure", () => {
  for (const solicit of [
    "not_attempted:no_solicitation_bound",
    "not_attempted:inside_heartbeat_bound",
    "not_attempted:bridge_not_attached",
    "solicit_failed:pipe_write_failed",
  ])
    assert.equal(bridgeClosureStop({ solicit }), null, `${solicit} is a live bridge the beat has not asked yet`);
});

test("the transport's own disconnect is a stop, and it carries the code that closed it", () => {
  const stop = bridgeClosureStop({ bridgeDisconnections: [ROUND66_DISCONNECT] });
  assert.equal(stop.reasonCode, "bridge_closed:fact_listener_failed", "one spelling: the code travels inside the stop");
  assert.equal(stop.cause, "bridge_disconnected");
  assert.equal(stop.atMs, ROUND66_DISCONNECT.atMs, "the moment the transport closed, not the moment somebody noticed");
});

test("no disconnect and no refused solicitation is not a stop", () => {
  assert.equal(bridgeClosureStop({ bridgeDisconnections: [] }), null);
  assert.equal(bridgeClosureStop({}), null);
});

test("the day loop consults the closure INSIDE its wait, before it polls again", () => {
  const source = readFileSync(RUNNER, "utf8");
  const loopAt = source.indexOf("while (!nightCrossedIn(dayScope)) {");
  const waitAt = source.indexOf("setTimeout(resolve, WAKE_POLL_MS)", loopAt);
  assert.ok(loopAt > 0, "the day loop's wait must be found by its own condition");
  assert.ok(waitAt > loopAt, "and the poll it repeats must be inside it");
  const body = source.slice(loopAt, waitAt);
  assert.match(
    body,
    /bridgeClosureStop\(/u,
    "the loop must ask whether the bridge is gone before it waits again - round66 waited sixteen minutes without asking",
  );
  assert.match(body, /break;/u, "and a closure must END the wait, not be counted and re-polled");
});
