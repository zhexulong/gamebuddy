import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  gameClockHhmmFromMs,
  gameClockMs,
  gameClockMsFromInGameTime,
  receiptTargetTile,
  snapshotClock,
} from "./lib/stardew-player-probe-driver.mjs";
import { parseReceiptEvidence } from "./lib/multiday-baseline.mjs";
import {
  COVENANT_LINE,
  COVENANT_RECALL_TOKENS,
  HOST_PLAYER_SCRIPT_SCHEMA,
  PAIRED_SLICES,
  allocationLeaksTile,
  appendHostPlayerScript,
  attentionSubject,
  awaitHostPlayerRecords,
  covenantIsFieldDerivable,
  fixtureGapLine,
  gameMinutesBetween,
  judgeConcurrentClaim,
  judgeCoopNight,
  judgeCrossDayMemory,
  judgeJointAttention,
  normalizeReceipt,
  planHostAttentionScript,
  planHostClaimScript,
  readCompanionNightRecord,
  readHostNightRecord,
  readHostPlayerRecords,
  renderSliceLine,
  runPairedLiveRun,
  sealHostPlayerScript,
  sliceAllocation,
  topologyFacts,
  worldVocabularyTokens,
} from "./run-stardew-native-local-player-paired-companion-live-run.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "gb-paired-"));

/**
 * Two ripe grab crops on 38/39,18 - the shape `native_harvest_crop_v1` grows - and one chest holding one item, which is
 * what `native_chest_retrieve_v1` places. The two arms are separate launches, so a world carries one subject or the
 * other; a world carrying both is only used here to pin the ORDER in which the attention slice prefers them.
 */
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
    // A scythe crop and a regrowing one are NOT this action's target.
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

const chestSnapshot = (overrides = {}) =>
  ripeSnapshot({
    harvestTargets: [],
    chests: [
      {
        chestId: "chest_0123456789abcdef",
        x: 30,
        y: 20,
        displayName: "Chest",
        isFridge: false,
        items: [{ slot: 0, qualifiedItemId: "(O)24", displayName: "Ruby", stack: 1 }],
      },
    ],
    ...overrides,
  });

/**
 * A script written by the run and performed by the Mod is ONE contract across two languages: the schema literal, the
 * four action names, numbers for tiles, `nearby` as a boolean, and a 1-based `seq` on every step. The Mod refuses
 * anything else by name (`script_step_invalid`, `script_step_not_sequenced`), so this is what keeps a harness edit from
 * silently producing a script the other side refuses. `seq` is the part S2 needs: a step is new to the Mod because its
 * POSITION is past the cursor, never because the file changed.
 */
test("the Host player's script is the protocol the Mod parses, and it round-trips through its records", () => {
  const dir = scratch();
  try {
    const scriptPath = join(dir, "script.json");
    const recordsPath = join(dir, "records.jsonl");
    const plan = planHostAttentionScript({ snapshot: ripeSnapshot() });
    const armed = appendHostPlayerScript(scriptPath, plan.steps);
    assert.equal(armed.ok, true);
    assert.deepEqual(armed.seqs, [1, 2, 3], "the writer owns the positions, so a slice knows exactly what it armed");

    const written = JSON.parse(readFileSync(scriptPath, "utf8"));
    assert.equal(written.schema, HOST_PLAYER_SCRIPT_SCHEMA);
    assert.equal(HOST_PLAYER_SCRIPT_SCHEMA, "gamebuddy-host-player-script/v2");
    assert.equal(written.sealed, false, "an open document is one the fixture may still append to");
    assert.deepEqual(
      written.steps.map((step) => step.action),
      ["walk_to_tile", "emote", "say"],
    );
    assert.deepEqual(
      written.steps.map((step) => step.seq),
      [1, 2, 3],
    );
    assert.equal(typeof written.steps[0].x, "number", "the Mod reads x/y as JSON numbers and refuses strings");
    assert.equal(typeof written.steps[0].y, "number");
    assert.equal(written.steps[0].nearby, true);
    assert.equal(written.steps[0].location, "Farm");
    assert.equal(written.steps[1].emote, "exclamation");
    assert.equal(written.steps[2].text, COVENANT_LINE, "the promise is the player's own line, spoken in the world");

    // The records the channel would write, read back into the same field names a receipt is read by.
    writeFileSync(
      recordsPath,
      [
        {
          seq: 1,
          stepId: "walk",
          action: "walk_to_tile",
          state: "succeeded",
          reasonCode: "walked_to_tile",
          x: 39,
          y: 19,
          timeOfDay: 1010,
          dayOfMonth: 1,
          location: "Farm",
        },
        {
          seq: 3,
          stepId: "say",
          action: "say",
          state: "succeeded",
          reasonCode: "chat_sent",
          x: 39,
          y: 19,
          timeOfDay: 1010,
          dayOfMonth: 1,
        },
        {
          seq: null,
          stepId: null,
          action: "script",
          state: "succeeded",
          reasonCode: "script_complete",
          x: 39,
          y: 19,
          timeOfDay: 1010,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const records = readHostPlayerRecords(recordsPath);
    assert.equal(records.length, 3);
    assert.equal(records[0].seq, 1, "a step record carries the position that makes it attributable to one slice");
    assert.equal(records[2].seq, null, "a channel-level record belongs to no step");
    assert.deepEqual(records[0].targetTile, { x: 39, y: 19, source: "host_player_record" });
    assert.equal(records[0].tGameMs, gameClockMs(1010));
    assert.equal(records[0].dayOfMonth, 1);
    // A disabled lane writes nothing and reads as nothing - not as an empty success.
    assert.deepEqual(readHostPlayerRecords(null), []);
    assert.deepEqual(readHostPlayerRecords(join(dir, "absent.jsonl")), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * S1'S STEPS AND S2'S STEPS LIVE IN ONE DOCUMENT, and the second slice's are BEHIND the first's. This is the whole of
 * what S2 proved: the fixture could write its steps and the Mod would never read them, because a document was adopted
 * once and finished forever. The positions are what make the document extendable - and the writer is the only thing that
 * assigns them, so a slice cannot overwrite a position another slice already performed.
 */
test("S2's steps are appended behind S1's in the same document, at positions of their own", () => {
  const dir = scratch();
  try {
    const scriptPath = join(dir, "script.json");
    const s1 = appendHostPlayerScript(scriptPath, planHostAttentionScript({ snapshot: ripeSnapshot() }).steps);
    const s2 = appendHostPlayerScript(scriptPath, planHostClaimScript({ snapshot: chestSnapshot() }).steps);
    assert.deepEqual(s1.seqs, [1, 2, 3]);
    assert.deepEqual(s2.seqs, [4, 5], "the second slice's steps are new positions, not a rewrite of the first's");

    const written = JSON.parse(readFileSync(scriptPath, "utf8"));
    assert.deepEqual(
      written.steps.map((step) => step.action),
      ["walk_to_tile", "emote", "say", "walk_to_tile", "chest_take"],
    );
    assert.deepEqual(
      written.steps.map((step) => step.seq),
      [1, 2, 3, 4, 5],
    );
    assert.deepEqual(
      written.steps.map((step) => step.stepId),
      ["walk", "emote", "say", "walk", "chest"],
      "a repeated step id is two steps, because two positions carry it",
    );

    // Sealing is the fixture's own end-of-stream, and it keeps every step exactly as written.
    const sealed = sealHostPlayerScript(scriptPath);
    assert.equal(sealed.ok, true);
    const final = JSON.parse(readFileSync(scriptPath, "utf8"));
    assert.equal(final.sealed, true);
    assert.equal(final.steps.length, 5);

    // A document this run cannot extend is refused by name rather than replaced: replacing it would drop steps the Mod
    // may already have performed.
    writeFileSync(scriptPath, `${JSON.stringify({ schema: "gamebuddy-host-player-script/v1", steps: [] })}\n`);
    const stale = appendHostPlayerScript(scriptPath, planHostClaimScript({ snapshot: chestSnapshot() }).steps);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "host_player_script_schema_mismatch");
    assert.deepEqual(stale.seqs, []);

    const unarmed = appendHostPlayerScript(null, []);
    assert.equal(unarmed.ok, false);
    assert.equal(unarmed.reason, "host_player_script_not_configured");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the attention slice walks the Host player to a place the WORLD published, and never invents one", () => {
  const cropPlan = planHostAttentionScript({ snapshot: ripeSnapshot() });
  assert.equal(cropPlan.subject.kind, "ready_grab_crop");
  assert.deepEqual(cropPlan.subject.tile, { x: 39, y: 18 });
  assert.equal(cropPlan.steps[0].nearby, true, "a crop occupies the tile itself, so the person stands beside it");

  // The container arm of the same launch: no crop, one chest holding an item.
  const chestPlan = planHostAttentionScript({ snapshot: chestSnapshot() });
  assert.equal(chestPlan.subject.kind, "chest_with_item");
  assert.deepEqual(chestPlan.subject.tile, { x: 30, y: 20 });
  assert.equal(chestPlan.steps[0].x, 30);

  // Neither arm: a named gap, and no substituted tile.
  const empty = planHostAttentionScript({ snapshot: ripeSnapshot({ harvestTargets: [], chests: [] }) });
  assert.equal(empty.subject, null);
  assert.deepEqual(empty.steps, []);
  assert.deepEqual(empty.dropped, [
    { step: "all", reason: "snapshot_published_no_ripe_crop_and_no_chest_holding_an_item" },
  ]);
  assert.equal(
    attentionSubject(ripeSnapshot({ location: "" })),
    null,
    "a snapshot with no location publishes no place to stand",
  );
});

test("S1's own sentence hands away neither the tile nor the decision to go", () => {
  const allocation = sliceAllocation("s1_attention");
  const subject = attentionSubject(ripeSnapshot());
  assert.equal(allocationLeaksTile(allocation, subject.tile), false);
  // The durable property: the sentence must not be able to answer the question the slice asks.
  for (const leak of ["去 (39,18) 那格看看。", "去 39:18。", "坐标 39 18 那里。", "去第 39 格。"])
    assert.equal(allocationLeaksTile([leak], subject.tile), true, `a sentence naming the tile must be caught: ${leak}`);
  // And it must not name the harvest either: "go harvest" is the answer, not the cue.
  assert.doesNotMatch(allocation.join(""), /收|harvest|作物|番茄/u);
});

test("S1 passes on the tile the person stands beside, and refuses to judge when the cue never existed", () => {
  const hostTile = { x: 39, y: 19 };
  const stub = (tile = hostTile) => [
    {
      action: "walk_to_tile",
      state: "succeeded",
      reasonCode: "walked_to_tile",
      targetTile: { ...tile, source: "host_player_record" },
      tGameMs: gameClockMs(1010),
    },
  ];
  const seen = [{ x: 39, y: 19, name: "Player", facing: "down", doing: "emoting" }];

  const passed = judgeJointAttention({
    hostRecords: stub(),
    otherFarmers: seen,
    companion: [{ targetTile: { x: 39, y: 18 }, tGameMs: gameClockMs(1020), state: "succeeded" }],
    subject: "ready_grab_crop",
    probeTGameMs: gameClockMs(1010),
  });
  assert.equal(passed.state, "passed");
  assert.equal(passed.reasonCode, "went_to_the_other_farmer");
  assert.equal(passed.reads.dGameMin, 10);

  // RED CASE 1: she acted somewhere else. That is a wrong reading of the person's attention, not lateness.
  const away = judgeJointAttention({
    hostRecords: stub(),
    otherFarmers: seen,
    companion: [{ targetTile: { x: 12, y: 9 }, tGameMs: gameClockMs(1020), state: "succeeded" }],
    probeTGameMs: gameClockMs(1010),
  });
  assert.equal(away.state, "failed");
  assert.equal(away.reasonCode, "acted_away_from_the_other_farmer");

  // RED CASE 2: the prompt named the tile. Whatever she did proves nothing.
  const leaked = judgeJointAttention({
    hostRecords: stub(),
    otherFarmers: seen,
    companion: [{ targetTile: { x: 39, y: 18 }, state: "succeeded" }],
    promptTileLeak: true,
  });
  assert.equal(leaked.state, "not_measured");
  assert.equal(leaked.reasonCode, "prompt_leaks_the_tile");

  // The Host player never arrived: the cue was never given, so this is the instrument, not her.
  const noStub = judgeJointAttention({ hostRecords: [], otherFarmers: seen, companion: [] });
  assert.equal(noStub.state, "not_measured");
  assert.equal(noStub.reasonCode, "host_player_stub_unavailable:no_records");
  assert.equal(noStub.reads.launchesWith.indexOf("-HostPlayerScript") >= 0, true);

  // She was never shown the person: `otherFarmers` is the same map plus a six-tile window.
  const unseen = judgeJointAttention({ hostRecords: stub(), otherFarmers: [], companion: [] });
  assert.equal(unseen.state, "not_measured");
  assert.equal(unseen.reasonCode, "other_farmer_not_in_her_observation");

  // She acted on nothing at all inside a slice that ran to its own end: measured, and a failure.
  assert.equal(judgeJointAttention({ hostRecords: stub(), otherFarmers: seen, companion: [] }).reasonCode, "late");
  // The slice's own budget cut her turn: our clock, not her failure.
  const cut = judgeJointAttention({ hostRecords: stub(), otherFarmers: seen, companion: [], turnTimedOut: true });
  assert.equal(cut.state, "not_measured");
  assert.equal(cut.reasonCode, "turn_budget_exhausted");
});

test("S2: exactly one takes the item, the other is refused BY NAME, and either side may win", () => {
  const contended = { chestId: "chest_0123456789abcdef", tile: { x: 30, y: 20 }, itemId: "(O)24", displayName: "Ruby" };
  const hostWon = {
    state: "succeeded",
    reasonCode: "chest_taken",
    tGameMs: gameClockMs(1030),
    evicted: [],
    targetTile: { x: 30, y: 20 },
  };
  const hostLost = {
    state: "rejected",
    reasonCode: "container_in_use",
    tGameMs: gameClockMs(1030),
    evicted: [],
    targetTile: { x: 30, y: 20 },
  };
  const companionWon = {
    state: "succeeded",
    reasonCode: "chest_retrieved",
    tGameMs: gameClockMs(1031),
    evicted: ["30:20"],
    targetTile: { x: 30, y: 20 },
  };
  const companionLost = {
    state: "rejected",
    reasonCode: "chest_empty",
    tGameMs: gameClockMs(1031),
    evicted: [],
    targetTile: { x: 30, y: 20 },
  };

  // THE ORDER IS NOT ASSUMED: the Host player winning is a pass, and so is the companion winning.
  const hostFirst = judgeConcurrentClaim({ contended, host: hostWon, companion: companionLost, world: "item_evicted" });
  assert.equal(hostFirst.state, "passed");
  assert.equal(hostFirst.reads.winner, "host");
  assert.equal(hostFirst.reads.loserReason, "chest_empty");
  const companionFirst = judgeConcurrentClaim({
    contended,
    host: hostLost,
    companion: companionWon,
    world: "item_evicted",
  });
  assert.equal(companionFirst.state, "passed");
  assert.equal(companionFirst.reads.winner, "companion");

  // RED CASE 3: both settle as the take. One item cannot have two carriers.
  const both = judgeConcurrentClaim({ contended, host: hostWon, companion: companionWon, world: "item_evicted" });
  assert.equal(both.state, "failed");
  assert.equal(both.reasonCode, "both_claimed");

  // A refusal with no reason code is a refusal by nothing.
  const unnamed = judgeConcurrentClaim({
    contended,
    host: hostWon,
    companion: { ...companionLost, reasonCode: "" },
    world: "item_evicted",
  });
  assert.equal(unnamed.reasonCode, "unnamed_refusal:companion");

  // A loser whose own receipt lists the container's tile is claiming an effect it did not get.
  const claiming = judgeConcurrentClaim({
    contended,
    host: hostWon,
    companion: { ...companionLost, reasonCode: "body_owned", evicted: ["30:20"] },
    world: "item_evicted",
  });
  assert.equal(claiming.reasonCode, "loser_claimed_the_effect:companion");

  // The world could not be re-read, or the item is still there: not measured, never a pass.
  assert.equal(
    judgeConcurrentClaim({ contended, host: hostWon, companion: companionLost, world: null }).reasonCode,
    "world_fact_absent",
  );
  assert.equal(
    judgeConcurrentClaim({ contended, host: hostWon, companion: companionLost, world: "item_still_there" }).state,
    "not_measured",
  );
  assert.equal(
    judgeConcurrentClaim({ contended, host: null, companion: companionWon }).reasonCode,
    "one_side_never_dispatched",
  );
  assert.equal(judgeConcurrentClaim({ contended: null }).reasonCode, "fixture_missing:chest_with_item");
});

test("S2's plan contends over the container the world published, with one item in it", () => {
  const plan = planHostClaimScript({ snapshot: chestSnapshot() });
  assert.equal(plan.contended.chestId, "chest_0123456789abcdef");
  assert.equal(plan.contended.itemId, "(O)24");
  assert.deepEqual(plan.contended.tile, { x: 30, y: 20 });
  assert.deepEqual(
    plan.steps.map((step) => step.action),
    ["walk_to_tile", "chest_take"],
  );
  assert.equal(plan.steps[1].targetRef, "chest_0123456789abcdef");
  assert.equal(plan.steps[1].expectedQualifiedItemId, "(O)24");
  // The world S2 needs is a container WITH something in it: an empty one is a fixture gap by name.
  const empty = planHostClaimScript({ snapshot: chestSnapshot({ chests: [{ chestId: "c", x: 1, y: 2, items: [] }] }) });
  assert.equal(empty.contended, null);
  assert.equal(empty.dropped[0].reason, "snapshot_published_no_chest_holding_an_item");
});

test("S3: two readable nights pass; ONE night is a failure, and an unreadable hour is not the farmer's fault", () => {
  const hostNight = {
    absent: false,
    state: "passed",
    day: 4,
    bedTime: 2210,
    bedTimeSource: "pre_crossing_clock",
    bedTimeAbsent: null,
  };
  const companionNight = { day: 4, bedTime: 2240, bedTimeSource: "pre_crossing_clock", bedTimeAbsent: null };
  const passed = judgeCoopNight({ hostNight, companionNight });
  assert.equal(passed.state, "passed");
  assert.equal(passed.reads.order, "host_first");

  // RED CASE 4: only one night is readable - the body that never slept, `round94`'s `null`.
  const oneNight = judgeCoopNight({
    hostNight,
    companionNight: {
      ...companionNight,
      bedTime: null,
      bedTimeSource: null,
      bedTimeAbsent: "no_clock_reading_before_the_crossing",
    },
  });
  assert.equal(oneNight.state, "failed");
  assert.equal(oneNight.reasonCode, "companion_never_slept");
  assert.equal(judgeCoopNight({ hostNight, companionNight: null }).reasonCode, "companion_night_absent");

  // Two nights, two different nights: the co-op night did not happen.
  assert.match(
    judgeCoopNight({ hostNight, companionNight: { ...companionNight, day: 5 } }).reasonCode,
    /^wrong_night:probe=day4:companion=day5$/u,
  );

  // A night whose clock genuinely could not be read is `not_measured` - the instrument's blind spot, not her failure -
  // and the code names the field the settlement says is missing.
  const blind = judgeCoopNight({
    hostNight: {
      ...hostNight,
      bedTime: null,
      bedTimeSource: null,
      bedTimeAbsent: "no_clock_reading_before_the_crossing",
    },
    companionNight,
  });
  assert.equal(blind.state, "not_measured");
  assert.equal(blind.reasonCode, "host_bed_time_unreadable:no_clock_reading_before_the_crossing");

  // No second body at all: the run was not launched with the Host sleep lane.
  const single = judgeCoopNight({ hostNight: null, companionNight });
  assert.equal(single.state, "not_measured");
  assert.equal(single.reasonCode, "two_bodies_unavailable:host_night_not_configured");
});

test("the Host night is read from the file-armed lifecycle's own evidence, hour included", () => {
  const dir = scratch();
  try {
    assert.deepEqual(readHostNightRecord(join(dir, "absent.json")), {
      absent: true,
      reason: "host_sleep_lifecycle_evidence_missing",
    });
    assert.equal(readHostNightRecord(null), null);

    const path = join(dir, "host-night.json");
    // The settlement the lifecycle now writes: the crossing's day AND the hour it took the farmer.
    writeFileSync(
      path,
      JSON.stringify({
        schema: "gamebuddy-sleep-lifecycle/v1",
        state: "passed",
        reasonCode: "day_advanced",
        settlement: { dayBefore: 4, dayAfter: 5, bedTime: 2210, bedTimeSource: "pre_crossing_clock" },
      }),
    );
    const record = readHostNightRecord(path);
    assert.equal(record.day, 4);
    assert.equal(record.state, "passed");
    assert.equal(record.bedTime, 2210);
    assert.equal(record.bedTimeSource, "pre_crossing_clock");
    assert.equal(record.bedTimeAbsent, null);

    // An older/other writer that publishes no hour keeps a NAMED gap rather than a fabricated 06:00.
    writeFileSync(
      path,
      JSON.stringify({
        schema: "gamebuddy-sleep-lifecycle/v1",
        state: "passed",
        settlement: { dayBefore: 4, dayAfter: 5 },
      }),
    );
    const bare = readHostNightRecord(path);
    assert.equal(bare.bedTime, null);
    assert.equal(bare.bedTimeAbsent, "host_lifecycle_evidence_publishes_no_bed_time");

    // The settlement's own reason travels through unchanged when it has one.
    writeFileSync(
      path,
      JSON.stringify({
        schema: "gamebuddy-sleep-lifecycle/v1",
        state: "passed",
        settlement: { dayBefore: 4, bedTimeAbsent: "no_clock_reading_before_the_crossing" },
      }),
    );
    assert.equal(readHostNightRecord(path).bedTimeAbsent, "no_clock_reading_before_the_crossing");

    writeFileSync(join(dir, "broken.json"), "{not json");
    assert.deepEqual(readHostNightRecord(join(dir, "broken.json")), {
      absent: true,
      reason: "host_sleep_lifecycle_evidence_unreadable",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S3 end to end: the Host lane's own evidence file decides the slice, and a file with no hour never passes", () => {
  const dir = scratch();
  try {
    const path = join(dir, "host-night.json");
    const companionNight = { day: 4, bedTime: 2240, bedTimeSource: "pre_crossing_clock", bedTimeAbsent: null };
    const hostNightFile = (settlement) =>
      writeFileSync(
        path,
        JSON.stringify({
          schema: "gamebuddy-sleep-lifecycle/v1",
          state: "passed",
          reasonCode: "day_advanced",
          settlement,
        }),
      );

    // The night the lifecycle publishes: the judge reads the HOUR it published, not just the presence of a field, so
    // moving the Host farmer's bed time moves the order the verdict reports.
    hostNightFile({ dayBefore: 4, dayAfter: 5, bedTime: 2210, bedTimeSource: "pre_crossing_clock" });
    const earlier = judgeCoopNight({ hostNight: readHostNightRecord(path), companionNight });
    assert.equal(earlier.state, "passed");
    assert.equal(earlier.reads.hostBedTime, 2210);
    assert.equal(earlier.reads.order, "host_first");

    hostNightFile({ dayBefore: 4, dayAfter: 5, bedTime: 2310, bedTimeSource: "pre_crossing_clock" });
    assert.equal(
      judgeCoopNight({ hostNight: readHostNightRecord(path), companionNight }).reads.order,
      "companion_first",
    );

    // A file that publishes no hour - an older writer, or one whose clock was never read - is `not_measured` with the
    // READER's reason, never a pass on an hour nobody observed.
    hostNightFile({ dayBefore: 4, dayAfter: 5 });
    const bare = judgeCoopNight({ hostNight: readHostNightRecord(path), companionNight });
    assert.equal(bare.state, "not_measured");
    assert.equal(bare.reasonCode, "host_bed_time_unreadable:host_lifecycle_evidence_publishes_no_bed_time");

    // And a settlement that names its own absence carries the writer's spelling through to the verdict.
    hostNightFile({ dayBefore: 4, bedTimeAbsent: "no_clock_reading_before_the_crossing" });
    assert.equal(
      judgeCoopNight({ hostNight: readHostNightRecord(path), companionNight }).reasonCode,
      "host_bed_time_unreadable:no_clock_reading_before_the_crossing",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the covenant the run speaks is one the FIELD cannot answer", () => {
  const observation = ripeSnapshot({
    otherFarmers: [{ x: 39, y: 19, name: "Player" }],
    villagers: [{ displayName: "Robin" }],
  });
  const vocabulary = worldVocabularyTokens(observation);
  // The field's own vocabulary is what it published: addresses, item ids, display names, people.
  for (const token of ["39,18", "39:18", "(o)256", "tomato", "player", "robin", "farm"])
    assert.ok(vocabulary.includes(token), `the observation publishes ${token}`);

  assert.equal(covenantIsFieldDerivable(COVENANT_LINE, observation), false);
  // A covenant that names a world thing is too weak, and the slice must say so rather than report recall.
  assert.equal(covenantIsFieldDerivable("把 (O)256 那个番茄留给我。", observation), true);
  assert.equal(covenantIsFieldDerivable("东边那棵树先别动，39,18 那格也一样。", observation), true);
  // Nothing to compare against is "cannot be decided", which is never a pass.
  assert.equal(covenantIsFieldDerivable(COVENANT_LINE, null), null);
  assert.equal(covenantIsFieldDerivable("", observation), null);
});

test("S4 judges the promise across the rebuilt session, and names a covenant too weak to test", () => {
  const anchor = { tile: { x: 39, y: 18 }, itemId: "(O)256", displayName: "番茄" };
  const covenant = { line: COVENANT_LINE, tokens: COVENANT_RECALL_TOKENS, spoken: true, fieldDerivable: false };

  const both = judgeCrossDayMemory({
    anchor,
    dayOneFactsInTrace: true,
    companionTurns: ["昨天我把那格番茄收了。", "东边那棵树我留着没动。"],
    dayRolledOver: true,
    covenant,
    sessionBoundary: "fresh_game_runtime_session_on_the_same_continuity_identity",
  });
  assert.equal(both.state, "passed");
  assert.equal(both.reads.saysIt, true);
  assert.equal(both.reads.covenantSaid, true);
  assert.equal(both.reads.covenantFieldDerivable, false);

  // RED CASE 5: the promise itself is missing from her next-day answer.
  const forgot = judgeCrossDayMemory({
    anchor,
    dayOneFactsInTrace: true,
    companionTurns: ["昨天我把那格番茄收了。"],
    dayRolledOver: true,
    covenant,
  });
  assert.equal(forgot.state, "failed");
  assert.equal(forgot.reasonCode, "covenant_not_recalled");

  // RED CASE 6: the covenant could be answered by looking at the field - the slice says the question was too weak,
  // NOT that she remembered.
  const weak = judgeCrossDayMemory({
    anchor,
    dayOneFactsInTrace: true,
    companionTurns: ["东边那棵树我留着。", "昨天收了番茄。"],
    dayRolledOver: true,
    covenant: { ...covenant, fieldDerivable: true },
  });
  assert.equal(weak.state, "failed");
  assert.equal(weak.reasonCode, "covenant_field_derivable");

  // A session boundary that was never crossed measures nothing about memory.
  assert.equal(
    judgeCrossDayMemory({
      anchor,
      dayOneFactsInTrace: true,
      companionTurns: ["东边那棵树我留着。"],
      dayRolledOver: false,
      covenant,
    }).reasonCode,
    "day_did_not_roll_over",
  );

  // No promise at all: there is nothing to recall, and that is not a pass either.
  assert.equal(
    judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: ["东边那棵树。"], dayRolledOver: true })
      .reasonCode,
    "covenant_absent:no_verbal_promise_before_the_boundary",
  );
  assert.equal(
    judgeCrossDayMemory({
      anchor,
      dayOneFactsInTrace: true,
      companionTurns: ["东边那棵树。"],
      dayRolledOver: true,
      covenant: { ...covenant, fieldDerivable: null },
    }).reasonCode,
    "covenant_derivability_unknown",
  );
  assert.equal(
    judgeCrossDayMemory({
      anchor,
      dayOneFactsInTrace: true,
      companionTurns: ["东边那棵树。"],
      dayRolledOver: true,
      covenant: { ...covenant, spoken: false },
    }).reasonCode,
    "covenant_never_spoken",
  );

  // The old halves are still judged: she says a day-one action the trace cannot support.
  const claimed = judgeCrossDayMemory({
    anchor,
    dayOneFactsInTrace: false,
    companionTurns: ["昨天我把那格番茄收了。", "东边那棵树我留着。"],
    dayRolledOver: true,
    covenant,
  });
  assert.equal(claimed.reasonCode, "claim_without_fact");

  // Nothing happened on day one and nothing was said: `nothing_to_recall`, not a pass.
  assert.equal(
    judgeCrossDayMemory({
      anchor,
      dayOneFactsInTrace: false,
      companionTurns: ["今天天气不错。"],
      dayRolledOver: true,
      covenant,
    }).reasonCode,
    "nothing_to_recall",
  );
  assert.equal(
    judgeCrossDayMemory({ anchor, dayOneFactsInTrace: true, companionTurns: [], dayRolledOver: true, covenant })
      .reasonCode,
    "no_next_day_turn",
  );
  // The tile is a token too, so a companion that says WHERE is recognised without knowing the item's name.
  assert.equal(
    judgeCrossDayMemory({
      anchor,
      dayOneFactsInTrace: true,
      companionTurns: ["39,18 那一格是我收的。", "东边的树我没砍。"],
      dayRolledOver: true,
      covenant,
    }).state,
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
  assert.equal(
    readCompanionNightRecord({ receipts: [{ actionId: "sleep", reasonCode: "not_home", evidence: "day_before=4" }] }),
    null,
  );
});

test("the world clock is ONE conversion in both directions, and a missing reading is null rather than midnight", () => {
  assert.equal(gameClockMs(1010), (10 * 60 + 10) * 60_000);
  assert.equal(gameClockMs(2600), 26 * 60 * 60_000);
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
  assert.deepEqual(receiptTargetTile({ evicted: ["38:19"] }, { parseEvidence: parseReceiptEvidence }), {
    x: 38,
    y: 19,
    source: "evicted",
  });
  assert.deepEqual(
    receiptTargetTile(
      { evidence: "location=Farm;tile=38,19;chore=harvestTargets" },
      { parseEvidence: parseReceiptEvidence },
    ),
    { x: 38, y: 19, source: "evidence.tile" },
  );
  // A receipt that names no tile names none: an id is not a tile, and it must not be read as one.
  assert.equal(receiptTargetTile({ evicted: ["soilTiles"] }, { parseEvidence: parseReceiptEvidence }), null);
  assert.equal(receiptTargetTile({}, { parseEvidence: parseReceiptEvidence }), null);
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
      observation: {
        location: "Farm",
        tileX: 38,
        tileY: 20,
        facing: 2,
        inGameTime: "1030",
        playerNearby: true,
        revision: 44,
      },
    },
    { atMs: 7 },
  );
  assert.equal(receipt.requester, "companion");
  assert.deepEqual(receipt.targetTile, { x: 38, y: 19, source: "evicted" });
  assert.equal(receipt.tGameMs, gameClockMs(1030));

  const line = renderSliceLine(judgeJointAttention({ hostRecords: [], companion: [] }));
  assert.match(line, /^PAIRED_SLICE s1_attention not_measured host_player_stub_unavailable:no_records/u);

  const gap = fixtureGapLine("chest_with_item", "snapshot_published_no_chest_holding_an_item");
  assert.match(gap, /^PAIRED_FIXTURE_MISSING chest_with_item reason=/u);
  assert.match(gap, /arm=native_chest_retrieve_v1/u);

  const topology = topologyFacts();
  assert.equal(topology.bridgeConsumers, 1);
  assert.equal(topology.secondConnectionOpenedByProbe, false);
  assert.equal(topology.secondBodyAvailable, "host_farmer_script_and_sleep");
  assert.equal(topology.probeBodyBySlice.s1_attention, "host_farmer");
  assert.equal(topology.probeBodyBySlice.s4_memory, "companion_body");
});

test("the Host player's records are waited for, and a slice that never got them says so", async () => {
  const dir = scratch();
  try {
    const recordsPath = join(dir, "records.jsonl");
    const waited = await awaitHostPlayerRecords({ path: recordsPath, seqs: [1], timeoutMs: 0, pollMs: 0 });
    assert.equal(waited.timedOut, true);
    assert.deepEqual(waited.records, []);

    writeFileSync(
      recordsPath,
      `${JSON.stringify({ seq: 1, stepId: "walk", action: "walk_to_tile", state: "succeeded", reasonCode: "walked_to_tile", x: 39, y: 19, timeOfDay: 1010 })}\n`,
    );
    const settled = await awaitHostPlayerRecords({ path: recordsPath, seqs: [1], timeoutMs: 5_000, pollMs: 0 });
    assert.equal(settled.timedOut, false);
    assert.equal(settled.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A RECORD FROM AN EARLIER SLICE IS NOT EVIDENCE THAT THIS ONE DISPATCHED. S1's `walk` and S2's `walk` are two steps in
 * one document, and the old wait matched on the step id - so S2's wait was satisfied by S1's record the instant it
 * started, and the slice reported a `not_measured` verdict about a lane it had never actually waited for. The position
 * is the whole of the fix: a wait is matched by the `seq`s its own append returned.
 */
test("a record from a previous slice never satisfies a later slice's wait", async () => {
  const dir = scratch();
  try {
    const recordsPath = join(dir, "records.jsonl");
    // S1 armed positions 1-3 and performed them; S2 armed 4-5 and nothing has settled yet.
    writeFileSync(
      recordsPath,
      [
        {
          seq: 1,
          stepId: "walk",
          action: "walk_to_tile",
          state: "succeeded",
          reasonCode: "walked_to_tile",
          x: 39,
          y: 19,
          timeOfDay: 1010,
        },
        {
          seq: 2,
          stepId: "emote",
          action: "emote",
          state: "succeeded",
          reasonCode: "emote_started",
          x: 39,
          y: 19,
          timeOfDay: 1010,
        },
        {
          seq: 3,
          stepId: "say",
          action: "say",
          state: "succeeded",
          reasonCode: "chat_sent",
          x: 39,
          y: 19,
          timeOfDay: 1010,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const stale = await awaitHostPlayerRecords({ path: recordsPath, seqs: [4, 5], timeoutMs: 0, pollMs: 0 });
    assert.equal(stale.timedOut, true, "S1's `walk` record must not stand in for S2's `walk`");
    assert.deepEqual(stale.records, []);

    // The same file, with S2's own positions present: now - and only now - the wait is satisfied, and only with its own
    // records.
    writeFileSync(
      recordsPath,
      [
        {
          seq: 1,
          stepId: "walk",
          action: "walk_to_tile",
          state: "succeeded",
          reasonCode: "walked_to_tile",
          x: 39,
          y: 19,
          timeOfDay: 1010,
        },
        {
          seq: 4,
          stepId: "walk",
          action: "walk_to_tile",
          state: "succeeded",
          reasonCode: "walked_to_tile",
          x: 30,
          y: 21,
          timeOfDay: 1015,
        },
        {
          seq: 5,
          stepId: "chest",
          action: "chest_take",
          state: "succeeded",
          reasonCode: "chest_taken",
          x: 30,
          y: 21,
          timeOfDay: 1015,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const own = await awaitHostPlayerRecords({ path: recordsPath, seqs: [4, 5], timeoutMs: 5_000, pollMs: 0 });
    assert.equal(own.timedOut, false);
    assert.deepEqual(
      own.records.map((record) => record.seq),
      [4, 5],
      "the slice reads its own steps and not S1's walk",
    );

    // A channel-level refusal ends every wait at once and travels with the records: the channel is finished, so no step
    // will ever settle and waiting out the budget would report our clock instead of the refusal.
    writeFileSync(
      recordsPath,
      `${JSON.stringify({ seq: 4, stepId: "walk", action: "script", state: "rejected", reasonCode: "script_stopped_by:walk", detail: "reason=walk_no_route_to_tile:30,20" })}\n`,
    );
    const refused = await awaitHostPlayerRecords({ path: recordsPath, seqs: [5], timeoutMs: 0, pollMs: 0 });
    assert.equal(refused.timedOut, false);
    assert.equal(refused.records.length, 1);
    assert.equal(refused.records[0].reasonCode, "script_stopped_by:walk");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one launch prints four slice lines, and a missing second body is never a pass", async () => {
  const dir = scratch();
  const printed = [];
  const original = console.log;
  const recordsPath = join(dir, "host-player-records.jsonl");
  console.log = (line) => printed.push(String(line));
  try {
    // The Host player's lane really performed S1's steps, and the world she was observed in carries her at 39,19. The
    // positions are the ones S1's own append assigns - that is what the wait matches, so a record from another slice's
    // position could never stand in for these.
    writeFileSync(
      recordsPath,
      [
        {
          seq: 1,
          stepId: "walk",
          action: "walk_to_tile",
          state: "succeeded",
          reasonCode: "walked_to_tile",
          x: 39,
          y: 19,
          timeOfDay: 1010,
          dayOfMonth: 1,
        },
        {
          seq: 2,
          stepId: "emote",
          action: "emote",
          state: "succeeded",
          reasonCode: "emote_started",
          x: 39,
          y: 19,
          timeOfDay: 1010,
          dayOfMonth: 1,
        },
        {
          seq: 3,
          stepId: "say",
          action: "say",
          state: "succeeded",
          reasonCode: "chat_sent",
          x: 39,
          y: 19,
          timeOfDay: 1010,
          dayOfMonth: 1,
        },
      ]
        .map((record) => JSON.stringify(record))
        .join("\n"),
    );
    const report = await runPairedLiveRun({
      config: {},
      traceDir: dir,
      hostNightEvidence: null,
      hostPlayerScript: join(dir, "host-player-script.json"),
      hostPlayerScriptRecords: recordsPath,
      sessionFactory: async ({ onFact }) => ({
        client: { close: () => {} },
        runTurn: async () => {
          // Her own turn dispatches through her own runtime; the trace sees the receipt the wire carried.
          onFact?.({
            type: "execution_receipt",
            payload: {
              actionId: "harvest_crop",
              state: "succeeded",
              reasonCode: "crop_harvested",
              evidence: "location=Farm;tile=39,19",
              evicted: ["39:19"],
              observation: { inGameTime: "1020" },
            },
          });
          return { admitted: true, settled: true, turns: [{ text: "我过去了，就在你旁边。" }] };
        },
        dispose: () => {},
      }),
      observe: async () => ripeSnapshot({ otherFarmers: [{ x: 39, y: 19, name: "Player", doing: "emoting" }] }),
      now: (() => {
        let clock = 0;
        return () => (clock += 1_000);
      })(),
      pollMs: 0,
    });
    const sliceLines = printed.filter((line) => line.startsWith("PAIRED_SLICE "));
    assert.equal(sliceLines.length, 4, `every slice printed exactly one line: ${JSON.stringify(sliceLines)}`);
    assert.match(sliceLines[0], /^PAIRED_SLICE s1_attention passed went_to_the_other_farmer/u);
    // No container in this world: S2 names the arm it needs instead of passing.
    assert.match(sliceLines[1], /^PAIRED_SLICE s2_claim not_measured fixture_missing:chest_with_item/u);
    assert.ok(printed.some((line) => line.startsWith("PAIRED_FIXTURE_MISSING chest_with_item")));
    assert.match(sliceLines[2], /^PAIRED_SLICE s3_night not_measured two_bodies_unavailable/u);
    // The day never rolled over, so the memory slice measured nothing - and says so rather than passing.
    assert.match(sliceLines[3], /^PAIRED_SLICE s4_memory not_measured day_did_not_roll_over/u);
    assert.notEqual(report.state, "passed");

    // The trace is the deliverable: the slice lines on disk agree with the four printed ones.
    const onDisk = readFileSync(join(dir, "slices.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.startsWith("PAIRED_SLICE "));
    assert.equal(onDisk.length, sliceLines.length);
    assert.equal(JSON.parse(readFileSync(join(dir, "paired-report.json"), "utf8")).slices.length, PAIRED_SLICES.length);
    // The session boundary is recorded with the identity it kept, so a reader can see what was crossed.
    const boundary = readFileSync(join(dir, "timeline.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.type === "session_boundary");
    assert.equal(boundary.payload.conversation, "fresh_game_runtime_session");
  } finally {
    console.log = original;
    rmSync(dir, { recursive: true, force: true });
  }
});
