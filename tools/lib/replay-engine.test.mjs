// The replay engine's falsifiers: every way a day-level replay can be unfaithful must be a named outcome,
// and the clock gate must be what actually holds the dispatch back.
//
// The world is modelled as an explicit clock object rather than by timers: `advancePerWait` game-minutes
// per gate wait is the only thing that moves it. That makes "the gate waited" and "the gate gave up"
// observable without a single setTimeout, and it cannot accidentally pass by real time passing.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildFailureSnapshot,
  buildReproPlan,
  planReplaySchedule,
  SEASON_NAMES,
  SINGLE_STEP_ENTRY,
} from "./failure-dump.mjs";
import { replayActionTrace } from "./replay-engine.mjs";
import { decideReplayDispatch } from "./replay-clock.mjs";

const TRACE = [
  makeEntry("req-1", "till_soil", "620", "succeeded", "soil_tilled"),
  makeEntry("req-2", "water_crop", "900", "succeeded", "crop_watered"),
  makeEntry("req-3", "harvest_crop", "1000", "succeeded", "crop_harvested"),
];

function makeEntry(requestId, action, inGameTime, state, reasonCode) {
  return {
    requestId,
    action,
    args: { targetX: 5, targetY: 6 },
    state,
    reasonCode,
    inGameTime,
    day: 5,
    season: "spring",
    year: 1,
    dispatchedAtMs: 1_700_000_000_000,
  };
}

const toMinutes = (timeOfDay) => Math.floor(timeOfDay / 100) * 60 + (timeOfDay % 100);
const fromMinutes = (minutes) => Math.floor(minutes / 60) * 100 + (minutes % 60);

/**
 * A scripted world. `timeOfDay` is a mutable clock the replay's gate advances by `advancePerWait` game
 * minutes each time it asks again; receipts come from the trace's own states unless overridden.
 */
function world({ timeOfDay = 620, advancePerWait = 0, receipts = new Map() } = {}) {
  const dispatched = [];
  const waits = [];
  let clock = timeOfDay;
  return {
    dispatched,
    waits,
    get clock() {
      return clock;
    },
    state: {
      get snapshot() {
        return { timeOfDay: clock };
      },
    },
    async execute(request) {
      dispatched.push(request);
      const receipt = receipts.get(request.requestId);
      if (receipt === undefined) throw new Error(`no_receipt_scripted:${request.requestId}`);
      return receipt;
    },
    async wait() {
      waits.push(clock);
      clock = advancePerWait === 0 ? clock : fromMinutes(toMinutes(clock) + advancePerWait);
    },
  };
}

const receiptsFor = (...ids) =>
  new Map(
    ids.map((id) => [
      id,
      {
        state: TRACE.find((entry) => entry.requestId === id).state,
        reasonCode: TRACE.find((entry) => entry.requestId === id).reasonCode,
      },
    ]),
  );

const run = (connection, turn, options = {}) =>
  replayActionTrace({ connection, actionTrace: TRACE, turn, maxClockWaitMs: 5_000, pollMs: 0, ...options });

test("the clock gate holds the dispatch until the world reaches the recorded moment", async () => {
  // The world never advances: the gate must keep waiting and end at a NAMED wait exhaustion, having
  // dispatched nothing beyond the step that was already at 6:20. Dispatching step 2 early is not an option.
  const connection = world({ timeOfDay: 620, advancePerWait: 0, receipts: receiptsFor("req-1", "req-2") });
  const result = await run(connection, 2);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "replay_clock_wait_exhausted:900:620");
  assert.deepEqual(
    connection.dispatched.map((request) => request.requestId),
    ["req-1"],
  );
  assert.ok(connection.waits.length > 0, "the gate must have waited rather than dispatched");
});

test("the same trace completes once the world's own clock arrives", async () => {
  // 100 game minutes per wait: the gate reaches 9:00 by waiting, then dispatches the recorded frame.
  const connection = world({ timeOfDay: 620, advancePerWait: 100, receipts: receiptsFor("req-1", "req-2") });
  const result = await run(connection, 2);
  assert.equal(result.state, "reached");
  assert.deepEqual(
    connection.dispatched.map((request) => request.requestId),
    ["req-1", "req-2"],
  );
  // The request frame is the trace's own, so the replay is byte-comparable with what the run sent.
  assert.deepEqual(connection.dispatched[1], {
    requestId: "req-2",
    action: "water_crop",
    args: { targetX: 5, targetY: 6 },
  });
});

test("a step whose receipt disagrees with the trace is a divergence, never a success", async () => {
  const receipts = receiptsFor("req-1");
  receipts.set("req-2", { state: "failed", reasonCode: "crop_not_watered" });
  const result = await run(world({ timeOfDay: 620, advancePerWait: 100, receipts }), 2);
  assert.equal(result.state, "diverged");
  assert.equal(result.reasonCode, "replay_step_diverged:1:succeeded:failed");
  assert.equal(result.step, 1);
});

test("a world that has already ended the day is refused, not waited out", async () => {
  // 6:20 is reachable only from a day that has not passed out yet: at 2:00 AM it never will be.
  const connection = world({ timeOfDay: 2600 });
  const result = await run(connection, 1);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "replay_clock_behind:620:2600");
  assert.deepEqual(connection.dispatched, []);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].phase, "clock");
});

test("a moment the day can no longer reach is named, not waited out", async () => {
  const result = await run(world({ timeOfDay: 2600 }), 1, {
    actionTrace: [makeEntry("req-9", "till_soil", "1400", "succeeded", "soil_tilled")],
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "replay_clock_behind:1400:2600");
});

test("an unreadable clock blocks instead of dispatching at a guessed time", async () => {
  const connection = {
    state: { snapshot: {} },
    async execute() {
      throw new Error("must_not_execute");
    },
  };
  const result = await run(connection, 1);
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "replay_clock_input_invalid");
});

test("a step that never settles is a named timeout, not a hang", async () => {
  const connection = {
    state: { snapshot: { timeOfDay: 620 } },
    execute: () => new Promise(() => {}),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
  const result = await replayActionTrace({
    connection,
    actionTrace: TRACE,
    turn: 1,
    stepTimeoutMs: 5,
    maxClockWaitMs: 5_000,
    pollMs: 1,
  });
  assert.equal(result.state, "blocked");
  assert.equal(result.reasonCode, "replay_step_timeout");
  assert.equal(result.steps[0].phase, "execute");
});

test("bad inputs are refused by name before any dispatch", async () => {
  const outOfRange = await run(world({}), 9);
  assert.equal(outOfRange.reasonCode, "replay_turn_out_of_range");
  const noTrace = await replayActionTrace({ connection: world({}), actionTrace: null, turn: 0 });
  assert.equal(noTrace.reasonCode, "replay_trace_invalid");
  const noAction = await replayActionTrace({
    connection: world({}),
    actionTrace: [{ ...TRACE[0], action: null }],
    turn: 1,
    maxClockWaitMs: 5_000,
    pollMs: 0,
  });
  assert.equal(noAction.reasonCode, "replay_step_action_missing");
});

test("the failure snapshot is the bridge's own facts, with nothing invented", () => {
  const snapshot = buildFailureSnapshot({
    reasonCode: "native_door_locked",
    component: "native-state",
    step: 30,
    snapshot: {
      timeOfDay: 900,
      dayOfMonth: 5,
      seasonIndex: 0,
      year: 1,
      location: "Town",
      tileX: 12,
      tileY: 8,
      facing: "up",
    },
    atMs: 1_700_000_500_000,
    blockingProperties: ["NPCPassable"],
    collisionLayers: ["Buildings"],
  });
  assert.equal(snapshot.inGameTime, "900");
  assert.equal(snapshot.season, SEASON_NAMES[0]);
  assert.deepEqual(snapshot.playerTile, { x: 12, y: 8 });
  // A snapshot the world did not have leaves null, which the bundle contract then reports as missing.
  const empty = buildFailureSnapshot({ reasonCode: "x", component: "y", step: 0, snapshot: null });
  assert.equal(empty.playerTile, null);
  assert.equal(empty.inGameTime, null);
  assert.equal(empty.day, null);
  assert.equal(empty.atMs !== null, true);
});

test("the replay plan derives its budget from the trace and points at the real entry point", () => {
  const plan = buildReproPlan({
    actionTrace: TRACE,
    turn: 2,
    slot: "GameBuddyFixtureStable_1",
    scenario: "morning_routine",
  });
  // 620 -> 900 is 160 game minutes at the engine's 700 ms per game minute.
  assert.equal(plan.expectedWallClockMs, 112_000);
  assert.equal(plan.replayedSteps, 2);
  assert.ok(plan.command.includes(SINGLE_STEP_ENTRY));
  assert.ok(plan.command.includes("--turn 2"));
  assert.ok(plan.command.includes("--scenario morning_routine"));
  assert.equal(buildReproPlan({ actionTrace: TRACE, turn: 1, slot: "" }), null);
  assert.equal(buildReproPlan({ actionTrace: "nope", turn: 1, slot: "s" }), null);
});

test("the published schedule is the engine's own decision, per step", () => {
  const schedule = planReplaySchedule(TRACE, decideReplayDispatch);
  assert.deepEqual(
    schedule.map((step) => step.decision),
    ["dispatch", "dispatch", "dispatch"],
  );
  assert.deepEqual(
    schedule.map((step) => step.inGameTime),
    ["620", "900", "1000"],
  );
  assert.equal(planReplaySchedule(null, decideReplayDispatch), null);
});

test("the entry point the plan names exists, and a trace round-trips through disk", () => {
  assert.ok(
    existsSync(new URL("../live-run/game/run-single-step.mjs", import.meta.url)),
    `${SINGLE_STEP_ENTRY} is named by repro plans but missing`,
  );
  const dir = mkdtempSync(join(tmpdir(), "gb-repro-"));
  try {
    const path = join(dir, "actionTrace.jsonl");
    writeFileSync(path, `${TRACE.map((entry) => JSON.stringify(entry)).join("\n")}\n`, "utf8");
    assert.ok(existsSync(path));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
