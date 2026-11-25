import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gameClockHhmmFromMs,
  gameClockMs,
  gameClockMsFromInGameTime,
  planProbeScript,
  receiptTargetTile,
  readyGrabCrop,
  runProbeScript,
  snapshotClock,
} from "./lib/stardew-player-probe-driver.mjs";
import { parseReceiptEvidence } from "./lib/multiday-baseline.mjs";
import {
  fixtureGapLine,
  gameMinutesBetween,
  judgeConcurrentClaim,
  judgeCoopNight,
  judgeCrossDayMemory,
  judgeJointAttention,
  normalizeReceipt,
  readCompanionNightRecord,
  readHostNightRecord,
  renderSliceLine,
  runPairedLiveRun,
  topologyFacts,
} from "./run-stardew-native-local-player-paired-companion-live-run.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "gb-paired-"));

/** Two ripe grab crops on 38/39,18 - the shape `native_harvest_crop_v1` grows, ordered so the PICK is not luck. */
const ripeSnapshot = (overrides = {}) => ({
  revision: 41,
  timeOfDay: 1010,
  dayOfMonth: 1,
  location: "Farm",
  harvestTargets: [
    {
      targetId: "sr1_BBBBBBBBBBBBBBBB",
      x: 39,
      y: 18,
      cropId: "256",
      qualifiedHarvestItemId: "(O)256",
      displayName: "Tomato",
      readyForHarvest: true,
      harvestMethod: "grab",
    },
    {
      targetId: "sr1_AAAAAAAAAAAAAAAA",
      x: 38,
      y: 19,
      cropId: "256",
      qualifiedHarvestItemId: "(O)256",
      displayName: "Tomato",
      readyForHarvest: true,
      harvestMethod: "grab",
    },
    // A scythe crop and a regrowing one are NOT this action's target, and offering either would make the probe's
    // pointer a refusal instead of a pointer.
    {
      targetId: "sr1_CCCCCCCCCCCCCCCC",
      x: 12,
      y: 9,
      qualifiedHarvestItemId: "(O)262",
      displayName: "Wheat",
      readyForHarvest: true,
      harvestMethod: "scythe",
    },
  ],
  chests: [],
  ...overrides,
});

const dispatchStub = (calls) => async ({ step }) => {
  calls.push({ action: step.action, args: step.args });
  return { requestId: `native_local_${step.action}_probe_${calls.length}`, state: "succeeded", reasonCode: "ok" };
};

test("the probe's script is a PURE FUNCTION of the snapshot: the same world twice is the same dispatch sequence", async () => {
  const first = planProbeScript({ snapshot: ripeSnapshot(), slice: "s1_attention" });
  const second = planProbeScript({ snapshot: ripeSnapshot(), slice: "s1_attention" });
  assert.deepEqual(second, first);
  // The order the world listed its rows in is not the order the probe chooses in.
  const reversed = ripeSnapshot();
  const reordered = { ...reversed, harvestTargets: [...reversed.harvestTargets].reverse() };
  assert.deepEqual(planProbeScript({ snapshot: reordered, slice: "s1_attention" }).tile, first.tile);
  assert.deepEqual(
    first.steps.map((step) => step.action),
    ["move_to_tile", "express_emote", "send_multiplayer_chat"],
  );
  // The report is a deep copy, so a caller mutating one plan cannot change the next one.
  assert.deepEqual(planProbeScript({ snapshot: ripeSnapshot(), slice: "s1_attention" }), first);
  const calls = [];
  const records = await runProbeScript({
    slice: "s1_attention",
    plan: first,
    observe: async () => ripeSnapshot(),
    dispatch: dispatchStub(calls),
    now: () => 1_000,
    startedAtMs: 1_000,
  });
  assert.deepEqual(
    calls.map((call) => call.action),
    first.steps.map((step) => step.action),
  );
  assert.deepEqual(
    records.map((record) => record.action),
    first.steps.map((step) => step.action),
  );
});

test("a world with no ripe crop drops every step WITH its reason, and never invents a target", () => {
  const plan = planProbeScript({ snapshot: ripeSnapshot({ harvestTargets: [] }), slice: "s1_attention" });
  assert.equal(plan.tile, null);
  assert.deepEqual(plan.steps, []);
  assert.deepEqual(plan.dropped, [{ step: "all", reason: "snapshot_published_no_ready_grab_crop_at_index_0" }]);
  // The second crop is what S2 contends over; a world with only one leaves S2 with nothing to claim.
  assert.equal(readyGrabCrop(ripeSnapshot(), { index: 1 }).targetId, "sr1_AAAAAAAAAAAAAAAA");
  assert.equal(readyGrabCrop(ripeSnapshot({ harvestTargets: [] }), { index: 1 }), null);
  // A chest that is published but holds nothing is not a chest step.
  const withEmptyChest = ripeSnapshot({ chests: [{ chestId: "c1", x: 30, y: 20, displayName: "Chest", isFridge: false, items: [] }] });
  const planWithChest = planProbeScript({ snapshot: withEmptyChest, slice: "s1_attention" });
  assert.deepEqual(planWithChest.dropped, [{ step: "chest", reason: "snapshot_published_no_chest_holding_an_item" }]);
});

test("the world clock is ONE conversion in both directions, and a missing reading is null rather than midnight", () => {
  assert.equal(gameClockMs(1010), (10 * 60 + 10) * 60_000);
  assert.equal(gameClockMs(2600), (26 * 60) * 60_000);
  assert.equal(gameClockHhmmFromMs(gameClockMs(1010)), 1010);
  assert.equal(gameClockHhmmFromMs(gameClockMs(2600)), 2600);
  assert.equal(gameClockMsFromInGameTime("2210"), gameClockMs(2210));
  for (const invalid of [0, null, undefined, -1, 2700, 1061, "1010"]) assert.equal(gameClockMs(invalid), null);
  assert.equal(snapshotClock({ revision: 1 }).absent, "snapshot_published_no_clock");
  assert.equal(snapshotClock({ revision: 1, timeOfDay: 900, dayOfMonth: 3 }).tGameMs, gameClockMs(900));
  assert.equal(gameMinutesBetween(gameClockMs(900), gameClockMs(920)), 20);
  assert.equal(gameMinutesBetween(null, gameClockMs(920)), null);
});

test("a receipt's target tile is read from its TYPED address first, then the evidence detail", () => {
  assert.deepEqual(
    receiptTargetTile({ evicted: ["38:19"] }, { parseEvidence: parseReceiptEvidence }),
    { x: 38, y: 19, source: "evicted" },
  );
  assert.deepEqual(
    receiptTargetTile({ evidence: "location=Farm;tile=38,19;chore=harvestTargets" }, { parseEvidence: parseReceiptEvidence }),
    { x: 38, y: 19, source: "evidence.tile" },
  );
  // A receipt that names no tile names none: an id is not a tile, and it must not be read as one.
  assert.equal(receiptTargetTile({ evicted: ["soilTiles"] }, { parseEvidence: parseReceiptEvidence }), null);
  assert.equal(receiptTargetTile({}, { parseEvidence: parseReceiptEvidence }), null);
});

test("S1 passes on the pointed tile, and a DIFFERENT tile is wrong_target rather than late", () => {
  const probeTile = { x: 38, y: 19 };
  const passed = judgeJointAttention({
    probeTile,
    probeTGameMs: gameClockMs(1010),
    companion: [{ targetTile: { x: 38, y: 19 }, tGameMs: gameClockMs(1020), state: "succeeded" }],
  });
  assert.equal(passed.state, "passed");
  assert.equal(passed.reads.dGameMin, 10);

  // RED CASE 1: she tilled/harvested a different tile. That is a wrong reading of the player's attention.
  const wrongTarget = judgeJointAttention({
    probeTile,
    probeTGameMs: gameClockMs(1010),
    companion: [{ targetTile: { x: 39, y: 18 }, tGameMs: gameClockMs(1020), state: "succeeded" }],
  });
  assert.equal(wrongTarget.state, "failed");
  assert.equal(wrongTarget.reasonCode, "wrong_target");

  // She acted on nothing at all inside the slice: measured, and a failure - not "unmeasured".
  assert.equal(judgeJointAttention({ probeTile, companion: [], turnTimedOut: false }).reasonCode, "late");
  // The slice's own budget cut her turn: that is OUR clock, so it is not her failure.
  assert.equal(
    judgeJointAttention({ probeTile, companion: [], turnTimedOut: true }).reasonCode,
    "turn_budget_exhausted",
  );
  assert.equal(judgeJointAttention({ probeTile, companion: [], turnTimedOut: true }).state, "not_measured");
  // A world with no ripe crop is a fixture gap by name, with the scenario that would arm it.
  const gap = judgeJointAttention({ probeTile: null, companion: [] });
  assert.equal(gap.reasonCode, "fixture_missing:ready_grab_crop");
  assert.equal(gap.reads.fixtureArm, "ready_grab_crop");
});

test("S2: exactly one succeeds, the other is refused BY NAME, and the loser may not claim the effect", () => {
  const contended = { x: 38, y: 19 };
  const won = {
    state: "succeeded",
    reasonCode: "crop_harvested",
    tGameMs: gameClockMs(1030),
    evicted: ["38:19"],
    targetTile: contended,
  };
  const refused = { state: "rejected", reasonCode: "target_gone", tGameMs: gameClockMs(1030), evicted: [], targetTile: contended };
  const passed = judgeConcurrentClaim({ contended, probe: refused, companion: won, world: "crop_row_evicted" });
  assert.equal(passed.state, "passed");
  assert.equal(passed.reads.winner, "companion");
  assert.equal(passed.reads.loserReason, "target_gone");

  // RED CASE 2: both settle as the effect. One row cannot have two owners.
  const both = judgeConcurrentClaim({ contended, probe: won, companion: won, world: "crop_row_evicted" });
  assert.equal(both.state, "failed");
  assert.equal(both.reasonCode, "both_claimed");

  // A refusal with no reason code is a refusal by nothing: it must be named.
  const unnamed = judgeConcurrentClaim({
    contended,
    probe: { state: "failed", reasonCode: "", tGameMs: null, evicted: [], targetTile: contended },
    companion: won,
    world: "crop_row_evicted",
  });
  assert.equal(unnamed.reasonCode, "unnamed_refusal:probe");

  // A loser whose own receipt lists the row as taken is claiming an effect it did not get.
  const claiming = judgeConcurrentClaim({
    contended,
    probe: { state: "rejected", reasonCode: "body_owned", tGameMs: null, evicted: ["38:19"], targetTile: contended },
    companion: won,
    world: "crop_row_evicted",
  });
  assert.equal(claiming.reasonCode, "loser_claimed_the_effect:probe");

  // Neither receipt nor the world can say what happened to the row: not measured, never a pass.
  const noWorld = judgeConcurrentClaim({
    contended,
    probe: refused,
    companion: { ...won, evicted: [] },
    world: null,
  });
  assert.equal(noWorld.state, "not_measured");
  assert.equal(noWorld.reasonCode, "world_fact_absent");
  assert.equal(judgeConcurrentClaim({ contended: null }).reasonCode, "fixture_missing:second_ready_grab_crop");
});

test("S3: two readable nights pass; ONE night is a failure, and an unreadable hour is not the farmer's fault", () => {
  const hostNight = { absent: false, state: "passed", day: 4, bedTime: 2210, bedTimeSource: "host_sleep_lifecycle_settlement", bedTimeAbsent: null };
  const companionNight = { day: 4, bedTime: 2240, bedTimeSource: "pre_crossing_clock", bedTimeAbsent: null };
  const passed = judgeCoopNight({ hostNight, companionNight });
  assert.equal(passed.state, "passed");
  assert.equal(passed.reads.order, "host_first");

  // RED CASE 3: only one night is readable - the body that never slept, `round94`'s `null`.
  const oneNight = judgeCoopNight({ hostNight, companionNight: { ...companionNight, bedTime: null, bedTimeSource: null, bedTimeAbsent: "no_clock_reading_before_the_crossing" } });
  assert.equal(oneNight.state, "failed");
  assert.equal(oneNight.reasonCode, "companion_never_slept");
  assert.equal(judgeCoopNight({ hostNight, companionNight: null }).reasonCode, "companion_night_absent");

  // Two nights, two different nights: the co-op night did not happen.
  assert.match(
    judgeCoopNight({ hostNight, companionNight: { ...companionNight, day: 5 } }).reasonCode,
    /^wrong_night:probe=day4:companion=day5$/u,
  );

  // The Host lane publishes the crossing's day and NO clock, so the hour is unreadable - `not_measured`, because the
  // instrument's blind spot and the farmer's night are two different facts.
  const blind = judgeCoopNight({
    hostNight: { ...hostNight, bedTime: null, bedTimeSource: null, bedTimeAbsent: "host_lifecycle_evidence_publishes_no_clock" },
    companionNight,
  });
  assert.equal(blind.state, "not_measured");
  assert.equal(blind.reasonCode, "host_bed_time_unreadable:host_lifecycle_evidence_publishes_no_clock");

  // No second body at all: the run was not launched with the Host sleep lane.
  const single = judgeCoopNight({ hostNight: null, companionNight });
  assert.equal(single.state, "not_measured");
  assert.equal(single.reasonCode, "two_bodies_unavailable:host_night_not_configured");
});

test("S4 judges the two halves separately: claim without fact is its own failure", () => {
  // `displayName` is the world's own word for the thing - in a zh-CN session the game publishes 蕃茄, which is what a
  // companion would actually say. The token set is {tile, item id, displayName}, so all three spellings are live.
  const anchor = { tile: { x: 38, y: 19 }, itemId: "(O)256", displayName: "番茄" };
  const both = judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: ["昨天我把那格番茄收了。"], dayRolledOver: true });
  assert.equal(both.state, "passed");
  assert.equal(both.reads.saysIt, true);
  assert.equal(both.reads.inWorldFacts, true);

  // RED CASE 4: she says it, and the trace cannot support it.
  const claimed = judgeCrossDayMemory({ anchor, dayOneFactsInTrace: false, companionTurns: ["昨天我把那格番茄收了。"], dayRolledOver: true });
  assert.equal(claimed.state, "failed");
  assert.equal(claimed.reasonCode, "claim_without_fact");

  // The other half: the fact is there and she is silent about it.
  const silent = judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: ["今天天气不错。"], dayRolledOver: true });
  assert.equal(silent.state, "failed");
  assert.equal(silent.reasonCode, "not_recalled");
  assert.equal(silent.reads.inWorldFacts, true);
  assert.equal(silent.reads.saysIt, false);

  // Nothing happened on day one: nothing to recall, and that is not a pass either.
  assert.equal(
    judgeCrossDayMemory({ anchor, dayOneFactsInTrace: false, companionTurns: ["今天天气不错。"], dayRolledOver: true }).reasonCode,
    "nothing_to_recall",
  );
  assert.equal(
    judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: [], dayRolledOver: true }).reasonCode,
    "no_next_day_turn",
  );
  assert.equal(
    judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: ["昨天收了番茄。"], dayRolledOver: false }).reasonCode,
    "day_did_not_roll_over",
  );
  // The tile is a token too, so a companion that says WHERE is recognised without knowing the item's name.
  assert.equal(
    judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: ["38,19 那一格是我收的。"], dayRolledOver: true }).state,
    "passed",
  );
});

test("the companion's night comes from the world's own ending spellings, and states the hour's provenance", () => {
  const sleepReceipt = {
    actionId: "sleep",
    reasonCode: "day_advanced",
    evidence: "state=passed;reason=day_advanced;day_before=4;day_after=5",
  };
  const withClock = readCompanionNightRecord({ receipts: [sleepReceipt], preCrossingClock: gameClockMs(2240) });
  assert.equal(withClock.day, 4);
  assert.equal(withClock.bedTime, 2240);
  assert.equal(withClock.bedTimeSource, "pre_crossing_clock");

  // A night crossed with no clock reading anywhere is BARE, and says why.
  const bare = readCompanionNightRecord({ receipts: [sleepReceipt], preCrossingClock: null });
  assert.equal(bare.bedTime, null);
  assert.equal(bare.bedTimeAbsent, "no_clock_reading_before_the_crossing");

  // The engine's own pass-out spelling is the other way a night ends.
  const passOut = readCompanionNightRecord({
    worldFacts: [{ kind: "night_ended_pass_out", eventId: "night_ended_pass_out_day_6" }],
    preCrossingClock: gameClockMs(2600),
  });
  assert.equal(passOut.day, 6);
  assert.equal(passOut.cause, "pass_out");

  // A blocked lifecycle receipt is how a night STARTED, not a claim that it crossed.
  assert.equal(readCompanionNightRecord({ receipts: [{ actionId: "sleep", reasonCode: "not_home", evidence: "day_before=4" }] }), null);
});

test("the Host night is read from the file-armed lifecycle's own evidence, with its clock gap NAMED", () => {
  const dir = scratch();
  try {
    assert.deepEqual(readHostNightRecord(join(dir, "absent.json")), {
      absent: true,
      reason: "host_sleep_lifecycle_evidence_missing",
    });
    assert.equal(readHostNightRecord(null), null);

    const path = join(dir, "host-night.json");
    writeFileSync(
      path,
      JSON.stringify({ schema: "gamebuddy-sleep-lifecycle/v1", state: "passed", reasonCode: "day_advanced", settlement: { dayBefore: 4, dayAfter: 5 } }),
    );
    const record = readHostNightRecord(path);
    assert.equal(record.day, 4);
    assert.equal(record.state, "passed");
    // The lane publishes the crossing's day and no clock; the gap is stated rather than filled in.
    assert.equal(record.bedTime, null);
    assert.equal(record.bedTimeAbsent, "host_lifecycle_evidence_publishes_no_clock");

    writeFileSync(join(dir, "broken.json"), "{not json");
    assert.deepEqual(readHostNightRecord(join(dir, "broken.json")), {
      absent: true,
      reason: "host_sleep_lifecycle_evidence_unreadable",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the receipt normaliser reads fields, and the slice line names every read the verdict used", () => {
  const receipt = normalizeReceipt(
    {
      actionId: "harvest_crop",
      requestId: "native_local_harvest_crop_probe_claim_1",
      executionId: "exec_1",
      state: "succeeded",
      reasonCode: "crop_harvested",
      revision: 44,
      evidence: "location=Farm;tile=38,19;chore=harvestTargets",
      evicted: ["38:19"],
      observation: { location: "Farm", tileX: 38, tileY: 20, facing: 2, inGameTime: "1030", playerNearby: true, revision: 44 },
    },
    { atMs: 7, requester: "probe" },
  );
  assert.equal(receipt.requester, "probe");
  assert.deepEqual(receipt.targetTile, { x: 38, y: 19, source: "evicted" });
  assert.equal(receipt.tGameMs, gameClockMs(1030));

  const line = renderSliceLine(judgeJointAttention({ probeTile: { x: 38, y: 19 }, probeTGameMs: gameClockMs(1010), companion: [] }));
  assert.match(line, /^PAIRED_SLICE s1_attention failed late probeTile=38,19/u);

  const gap = fixtureGapLine("ready_grab_crop", "snapshot_published_no_ready_grab_crop_at_index_0");
  assert.match(gap, /^PAIRED_FIXTURE_MISSING ready_grab_crop reason=/u);
  assert.match(gap, /arm=native_harvest_crop_v1/u);
  assert.match(gap, /then=S1 and S2 measure a real ripe crop/u);

  const topology = topologyFacts();
  assert.equal(topology.bridgeConsumers, 1);
  assert.equal(topology.secondConnectionOpenedByProbe, false);
  assert.equal(topology.secondBodyAvailable, "host_farmer_sleep_only");
  assert.equal(topology.probeBodyBySlice.s3_night, "host_farmer");
});

test("one failed slice still prints the other three lines: a stop is never a silence", async () => {
  const dir = scratch();
  const printed = [];
  const original = console.log;
  console.log = (line) => printed.push(String(line));
  try {
    const report = await runPairedLiveRun({
      config: {},
      traceDir: dir,
      // No Host sleep lane: S3 has no second body, and the run must say so rather than pass.
      hostNightEvidence: null,
      sessionFactory: async () => ({
        client: null,
        runTurn: async () => ({ admitted: true, settled: true, turns: [] }),
        dispose: () => {},
      }),
      observe: async () => ripeSnapshot(),
      // The companion dispatches nothing at all: `late`, which stops the run after line one.
      runTurn: async () => ({ admitted: true, settled: true, turns: [] }),
      dispatch: async ({ step }) => ({ requestId: `req_${step.action}`, state: "succeeded", reasonCode: "ok" }),
      now: (() => {
        let clock = 0;
        return () => (clock += 1_000);
      })(),
    });
    assert.equal(report.state, "failed");
    const sliceLines = printed.filter((line) => line.startsWith("PAIRED_SLICE "));
    assert.equal(sliceLines.length, 4, `every slice printed exactly one line: ${JSON.stringify(sliceLines)}`);
    assert.match(sliceLines[0], /^PAIRED_SLICE s1_attention failed late /u);
    assert.match(sliceLines[1], /^PAIRED_SLICE s2_claim not_measured run_stopped_by:s1_attention:late/u);
    assert.match(sliceLines[3], /^PAIRED_SLICE s4_memory not_measured run_stopped_by:s1_attention:late/u);
    assert.ok(printed.some((line) => line.startsWith("PAIRED_RESULT ")));
    // The trace is the deliverable: the slice lines on disk agree with the four printed ones (the fixture gap this
    // run also has to report is its own line, not a slice).
    const onDisk = readFileSync(join(dir, "slices.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("PAIRED_SLICE "));
    assert.equal(onDisk.length, sliceLines.length);
    assert.ok(JSON.parse(readFileSync(join(dir, "paired-report.json"), "utf8")).slices.length === 4);
  } finally {
    console.log = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
