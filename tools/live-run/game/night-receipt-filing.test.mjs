/**
 * THE LOOP'S HALF OF A NIGHT'S ATTRIBUTION: WHICH RECORD A RECEIPT IS FILED ON.
 *
 * `multiday-baseline.mjs` answers whether a night crossed and names any receipt that landed twice; it cannot change how
 * the runner files one. Measured `round80` (`2026-11-19T21-44-19-653Z-multiday_routine`): every `sleep -> day_advanced`
 * receipt was minted 18-122 ms AFTER the `day_started` of the day it opened, so the watcher that stood over the night
 * itself had already returned and the NEXT night's watch caught it. The first night's receipt was therefore filed on the
 * SECOND night's record, the record whose own calendar WAS that night carried none, and the baseline's own verdict on
 * that run reads `receipts 3 · paired 1 · unpaired 0 · double-paired 2` with
 * `a_night_receipt_is_paired_by_its_own_day:4->5:dayRecords[0],dayRecords[1]`.
 *
 * The fixture below is that run's own facts: the three receipts verbatim, the fact log in its real arrival order, and the
 * two night records as the loop wrote them. The three readings asserted are the run AS PUBLISHED, the same loop records
 * reconciled today, and the same records after `fileNightReceiptsOnTheirOwnNights` has filed each receipt by its night.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assessMultiDayBaseline,
  MINIMUM_BASELINE_DAYS,
  NIGHT_CAUSE_ENGINE,
  NIGHT_CAUSE_SLEEP,
  nightReceiptPairingLine,
  reconcileDaysWithTheWorld,
  worldDayStartsFromFacts,
  worldNightEndingsFromFacts,
} from "../../lib/multiday-baseline.mjs";
import { fileNightReceiptsOnTheirOwnNights } from "./night-receipt-filing.mjs";

const RUNNER = new URL("./run-stardew-native-local-agent-ab-live.mjs", import.meta.url);

/**
 * One `sleep -> day_advanced` receipt, in the shape the run's fact log records it: `evidence.detail` is the Mod's own
 * `key=value` projection and is quoted verbatim, because `day_before`/`day_after` are the identity this whole test is
 * about. `requestId` is what `result.json` publishes on the day record.
 */
const crossingReceipt = (requestId, detail) =>
  Object.freeze({ requestId, actionId: "sleep", state: "succeeded", reasonCode: "day_advanced", evidence: { detail } });

/** Night 1: ended on `TotalDays` 4, opened 5. */
const NIGHT_1 = crossingReceipt(
  "8cd008be024c444a8f4cf6df8441033d",
  "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=false;shipping_summary_settled=already_committed;engine_crossing_menu=already_committed;overnight_menu_not_recognised=none;day_before=4;days_before=5;day_after=5;days_after=6;enteredVia=native_sleep_prompt;topology=single_player;dayBefore=4;dayAfter=5;daysPlayedBefore=5;daysPlayedAfter=6;savingObserved=False;savedObserved=True;dayStartedObserved=True;saveBoundaryNotObserved=False;readyCheckObserved=False;steps=1;folded=accepted@target=own_bed,never_direct_new_day=true",
);
/** Night 2: ended on `TotalDays` 5, opened 6. No watch ever caught it - the closing day had no watcher. */
const NIGHT_2 = crossingReceipt(
  "801e79b21d5a439d98f021bc9afe4b06",
  "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=false;shipping_summary_settled=none;engine_crossing_menu=none;overnight_menu_not_recognised=none;day_before=5;days_before=6;day_after=6;days_after=7;enteredVia=native_sleep_prompt;topology=single_player;dayBefore=5;dayAfter=6;daysPlayedBefore=6;daysPlayedAfter=7;savingObserved=False;savedObserved=True;dayStartedObserved=True;saveBoundaryNotObserved=False;readyCheckObserved=False;steps=1;folded=accepted@target=own_bed,never_direct_new_day=true",
);
/** Night 3, the closing night: ended on `TotalDays` 6, opened 7. */
const NIGHT_3 = crossingReceipt(
  "2e8d2e9b229642a3b3d421ae70150dfe",
  "state=passed;reason=day_advanced;topology=single_player;entered_via=native_sleep_prompt;saving_observed=false;saved_observed=true;day_started_observed=true;save_boundary_not_observed=false;shipping_summary_settled=none;engine_crossing_menu=none;overnight_menu_not_recognised=none;day_before=6;days_before=7;day_after=7;days_after=8;enteredVia=native_sleep_prompt;topology=single_player;dayBefore=6;dayAfter=7;daysPlayedBefore=7;daysPlayedAfter=8;savingObserved=False;savedObserved=True;dayStartedObserved=True;saveBoundaryNotObserved=False;readyCheckObserved=False;steps=1;folded=accepted@target=own_bed,never_direct_new_day=true",
);

const dayStarted = (day) =>
  Object.freeze({ type: "world_fact", worldFactKind: "day_started", eventId: `day_started_day_${String(day)}` });
const receiptFact = (receipt) =>
  Object.freeze({
    type: "execution_receipt",
    requestId: receipt.requestId,
    reasonCode: receipt.reasonCode,
    worldFactPayload: receipt,
  });

/**
 * The run's fact log in the order the facts arrived: each night's `day_started`, then the receipt 18-122 ms behind it.
 *
 * THE ORDER IS THE DEFECT. `day_started_day_5` at 1795125372121 and night 1's receipt at 1795125372149 - 28 ms later -
 * so the receipt is in the log AFTER the calendar moved, which is what put it in the next watch's window.
 */
const ROUND80_FACTS = Object.freeze([
  dayStarted(5),
  receiptFact(NIGHT_1),
  dayStarted(6),
  receiptFact(NIGHT_2),
  dayStarted(7),
  receiptFact(NIGHT_3),
]);

/** The two night records the loop watched, as `result.json` published them. */
const watchedRecords = () =>
  JSON.parse(
    JSON.stringify([
      {
        day: 1,
        terminal: null,
        after: { dayOfMonth: 6, dayBefore: 5, seasonIndex: 0, timeOfDay: 600 },
        menus: [
          {
            menuType: "LevelUpMenu",
            decision: "respond_level_up",
            respondReceipt: null,
            respondReasonCode: "level_up_pair_not_in_snapshot",
            respondChoice: null,
            levelUp: null,
          },
        ],
        nextDayAccomplishedActionIds: [
          "break_rock",
          "chop_stump",
          "chop_tree",
          "cut_weeds",
          "pickup_item",
          "till_soil",
          "water_crop",
        ],
        cause: NIGHT_CAUSE_ENGINE,
        bedTime: null,
        passedOut: false,
        nightVerdict: null,
        sleepReceipt: null,
      },
      {
        day: 2,
        // NIGHT 1'S RECEIPT, FILED ON NIGHT 2'S RECORD: minted 28 ms after its own `day_started`, it was still the
        // freshest terminal in the window the second watch opened.
        terminal: NIGHT_1,
        after: { dayOfMonth: 7, seasonIndex: 0, timeOfDay: 600 },
        menus: [
          { menuType: "ShippingMenu", decision: "wait", clearedAt: 1795125376493 },
          { menuType: "SaveGameMenu", decision: "wait", clearedAt: 1795126043397 },
        ],
        nextDayAccomplishedActionIds: ["cut_weeds", "fish_here", "water_crop"],
        cause: NIGHT_CAUSE_SLEEP,
        bedTime: 2030,
        passedOut: false,
        nightVerdict: null,
        sleepReceipt: NIGHT_1,
      },
    ]),
  );

/** The records the run published: the loop's two, plus the two the baseline's own reconciliation added at the time. */
const publishedRecords = () => [
  ...watchedRecords(),
  {
    day: null,
    terminal: null,
    after: null,
    menus: [],
    nextDayAccomplishedActionIds: [],
    watched: false,
    cause: NIGHT_CAUSE_SLEEP,
    passedOut: false,
    endedDayOfMonth: 6,
  },
  {
    day: null,
    terminal: null,
    after: null,
    menus: [],
    nextDayAccomplishedActionIds: [],
    watched: false,
    cause: NIGHT_CAUSE_SLEEP,
    passedOut: false,
    endedDayOfMonth: 7,
  },
];

const codes = (assessment) => assessment.violations.map((entry) => entry.code);

/**
 * Read one set of records through the ONE baseline module, and print the numbers it answers with.
 *
 * Printed, not only asserted: the point of this test is a before and an after on the same facts, and a reader who sees
 * only the green assertion cannot tell what changed. `daysCrossed` travels with the world's own count beside it, because
 * `3` and `3` is the agreement and `4` against `3` is the disagreement `round80` shipped.
 */
function read(label, dayRecords) {
  const endings = worldNightEndingsFromFacts(ROUND80_FACTS);
  const assessment = assessMultiDayBaseline({
    dayRecords,
    daysRequested: MINIMUM_BASELINE_DAYS,
    worldDayStarts: worldDayStartsFromFacts(ROUND80_FACTS),
    worldNightEndings: endings,
  });
  console.log(
    `[${label}] ${nightReceiptPairingLine(assessment.nightReceipts)} · daysCrossed ${String(assessment.daysCrossed)} of world ${String(assessment.worldDaysCrossed)} · ${codes(assessment).join(" | ") || "no violations"}`,
  );
  return assessment;
}

test("round80's published records are red on the pairing gate, and the same facts filed by their own night are green", () => {
  // THE RUN AS PUBLISHED. Four records, because the baseline reconciled two nights into the two the loop watched, and
  // the exposed reading is `receipts 3 · paired 1 · unpaired 0 · double-paired 2` with four crossings against a world of
  // three. This half is `multiday-baseline.mjs`'s measurement of the artifact, kept here so the after is measured against
  // the numbers the run actually reported.
  const published = read("round80 as published", publishedRecords());
  assert.equal(
    nightReceiptPairingLine(published.nightReceipts),
    "receipts 3 · paired 1 · unpaired 0 · double-paired 2",
  );
  assert.equal(published.daysCrossed, 4, "two nights counted twice is four crossings");
  assert.equal(published.worldDaysCrossed, 3, "and the world opened three days");
  assert.ok(codes(published).includes("a_night_receipt_is_paired_by_its_own_day:4->5:dayRecords[0],dayRecords[1]"));

  // THE LOOP'S OWN RECORDS, RECONCILED TODAY, BEFORE THE FILING. The count agrees with the world now, and the misfiled
  // receipt is the only thing left red - which is the loop's, not the night's.
  const endings = worldNightEndingsFromFacts(ROUND80_FACTS);
  const before = reconcileDaysWithTheWorld({ dayRecords: watchedRecords(), worldNightEndings: endings });
  const beforeAssessment = read(
    `reconciled, before the filing (${String(before.records.length)} records)`,
    before.records,
  );
  assert.equal(
    nightReceiptPairingLine(beforeAssessment.nightReceipts),
    "receipts 3 · paired 2 · unpaired 0 · double-paired 1",
  );
  assert.deepEqual(codes(beforeAssessment), [
    "level_up_menu_not_resolved:level_up_pair_not_in_snapshot",
    "a_night_receipt_is_paired_by_its_own_day:4->5:dayRecords[0],dayRecords[1]",
  ]);

  // THE SAME FACTS, AFTER THE LOOP FILES EACH RECEIPT ON THE RECORD WHOSE OWN CALENDAR IS THAT NIGHT.
  const records = watchedRecords();
  const filing = fileNightReceiptsOnTheirOwnNights({
    dayRecords: records,
    worldNightEndings: endings,
    receipts: [NIGHT_1, NIGHT_2, NIGHT_3],
  });
  assert.deepEqual(
    { examined: filing.examined, filed: filing.filed, cleared: filing.cleared, nights: [...filing.nights] },
    // Three nights, two of them have a record to be filed on (the closing night's record is minted by reconciliation),
    // and two copies of night 1's receipt - its `terminal` and its `sleepReceipt` - were lying on night 2's record.
    { examined: 3, filed: 2, cleared: 2, nights: [4, 5] },
    "every night with a record gets its own receipt, and the copies on the wrong night are taken off",
  );
  assert.equal(records[0].terminal, NIGHT_1, "night 1's record carries the receipt its own calendar names");
  assert.equal(records[1].terminal, NIGHT_2, "night 2's record carries ITS receipt, which no watch ever caught");
  assert.equal(records[1].sleepReceipt, NIGHT_2, "and its sleep witness is that night's, not the one before it");

  const after = reconcileDaysWithTheWorld({ dayRecords: records, worldNightEndings: endings });
  const afterAssessment = read(
    `reconciled, filed by their own night (${String(after.records.length)} records)`,
    after.records,
  );
  assert.equal(after.recorded, 3, "the ledger covers three nights");
  assert.equal(
    nightReceiptPairingLine(afterAssessment.nightReceipts),
    "receipts 3 · paired 3 · unpaired 0 · double-paired 0",
  );
  assert.equal(afterAssessment.daysCrossed, 3, "three crossings");
  assert.equal(afterAssessment.worldDaysCrossed, 3, "three world days");
  assert.ok(
    !codes(afterAssessment).some((code) => code.startsWith("a_night_receipt_is_paired_by_its_own_day")),
    `the pairing gate is green because the filing changed; got ${JSON.stringify(codes(afterAssessment))}`,
  );
  // THE ONE FINDING THIS RUN KEEPS IS THE ONE IT MEASURED: the first night's rollover raised a `LevelUpMenu` whose
  // pending pair the snapshot never published. Filing a receipt does not answer that, and must not silence it.
  assert.deepEqual(codes(afterAssessment), ["level_up_menu_not_resolved:level_up_pair_not_in_snapshot"]);
});

test("a receipt is never taken off the record that has nothing else to name its night", () => {
  // A record with no calendar at all is named BY the receipt it carries (`nightEndedDayOfMonth`'s last resort), so the
  // clear pass cannot strip the only witness a night has. This is the guard that makes take-then-file safe.
  const orphan = { day: 1, terminal: NIGHT_1, after: null, menus: [], nextDayAccomplishedActionIds: [] };
  const endings = worldNightEndingsFromFacts(ROUND80_FACTS);
  const filings = fileNightReceiptsOnTheirOwnNights({
    dayRecords: [orphan],
    worldNightEndings: endings,
    receipts: [NIGHT_1],
  });
  assert.equal(filings.cleared, 0, "nothing is taken from a record whose receipt is its only identity");
  assert.equal(orphan.terminal, NIGHT_1, "and the night keeps the witness it has");
});

test("a receipt the wrong night carries is taken off it even when its own night has no receipt to put there", () => {
  // THE HALF THE FILE PASS CANNOT DO. Night 2's own receipt can be missing from the log (a night the host player ended, a
  // night whose receipt the run lost), and then nothing is filed on its record - so the only thing that stops the record
  // from claiming night 1 is the clear pass. Measured on that shape: the record read `cause: sleep` for a night it had
  // no witness to, because the receipt beside it belonged to the night before.
  const records = watchedRecords();
  const endings = worldNightEndingsFromFacts(ROUND80_FACTS).filter((ending) => ending.day === 4);
  const filings = fileNightReceiptsOnTheirOwnNights({
    dayRecords: records,
    worldNightEndings: endings,
    receipts: [NIGHT_1],
  });
  assert.equal(filings.filed, 1, "night 1's own record gets the receipt");
  assert.equal(filings.cleared, 2, "and the two copies night 2's record was carrying are taken off it");
  assert.equal(records[0].terminal, NIGHT_1, "night 1 keeps its crossing witness");
  assert.equal(records[1].terminal, null, "night 2 states that it has no receipt rather than the one before it");
  assert.equal(records[1].sleepReceipt, null, "and the same for the witness its cause was read from");
  assert.equal(records[1].after.dayOfMonth, 7, "its own calendar is untouched");
});

test("a receipt for a day the world does not count as a night is not filed", () => {
  // The population is the ledger's own night endings. A stray `day_advanced` receipt for a day no ending names would
  // otherwise be filed onto whichever record its day happens to match, inventing a night the run did not live.
  const stray = crossingReceipt(
    "round80-stray",
    "state=passed;reason=day_advanced;day_before=11;days_before=12;day_after=12;days_after=13",
  );
  const records = watchedRecords();
  const filings = fileNightReceiptsOnTheirOwnNights({
    dayRecords: records,
    worldNightEndings: worldNightEndingsFromFacts(ROUND80_FACTS),
    receipts: [NIGHT_1, NIGHT_2, NIGHT_3, stray],
  });
  assert.equal(filings.filed, 2, "the three nights with records are filed, and the stray day is not one of them");
  assert.equal(records[0].terminal, NIGHT_1, "and no record picked the stray receipt up instead");
});

test("the runner files the receipts before it reconciles, and states whether a turn followed each night", () => {
  const runner = readFileSync(RUNNER, "utf8");
  const filing = runner.indexOf("fileNightReceiptsOnTheirOwnNights({");
  const reconciliation = runner.indexOf("reconcileDaysWithTheWorld({");
  assert.ok(filing > 0, "the runner calls the filing");
  assert.ok(
    filing < reconciliation,
    "the filing runs BEFORE reconciliation: a night filed after the closing night's record was minted would leave the receipt the reconciliation already counted on the wrong record",
  );
  assert.match(
    runner,
    /receipts: factLog\.map\(recordedReceipt\)\.filter\(\(receipt\) => receipt !== null\)/,
    "the receipts are the run's own fact log, read through the one function that reads a recorded receipt",
  );
  assert.match(
    runner,
    /record\.nextDayIssued = index < crossing\.dayRecords\.length - 1 \|\| crossing\.completed === true;/,
    "the loop states whether a turn followed each night, so the record does not answer it by its position",
  );
  // THE CALENDAR THE WATCH BEGAN ON, ON EVERY RETURN THAT PUBLISHES ONE. Without it a record's own calendar cannot say
  // whether its night crossed, and reconciliation falls back to whichever receipt the record happens to carry. The
  // population is the watch's own `after:` values, so a fifth return added later is measured rather than skipped.
  const watchStart = runner.indexOf("async function watchNightRollover(");
  const watchEnd = runner.indexOf("async function ", watchStart + "async function ".length);
  assert.ok(watchStart > 0 && watchEnd > watchStart, "the watch is where this test says it is");
  const afterValues = runner
    .slice(watchStart, watchEnd)
    .split("\n")
    .filter((line) => /^\s+after: /.test(line));
  assert.equal(afterValues.length, 4, "the watch answers with an `after` on four returns");
  for (const line of afterValues)
    assert.match(line, /dayBefore/, `every return states the day the watch began on: ${line.trim()}`);
});
