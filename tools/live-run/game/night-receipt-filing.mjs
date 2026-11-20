// FILE EACH NIGHT'S CROSSING RECEIPT ON THE RECORD WHOSE OWN CALENDAR IS THAT NIGHT.
//
// A night's `day_advanced` receipt is minted 18-122 ms AFTER the `day_started` of the day it opened, so it always
// arrives inside the NEXT night's watch: the watcher that stood over the night itself has already returned (the
// calendar moved) by the time the receipt lands, and the watcher for the following night is the one that finds it.
// Attributing by arrival is therefore wrong by construction, and it has a measured cost. `round80`
// (`2026-11-19T21-44-19-653Z-multiday_routine`): three `sleep -> day_advanced` receipts at `day_started_day_5 + 28 ms`,
// `+122 ms` and `+18 ms`; the first night's receipt was filed on the SECOND night's record, so the baseline read
// `receipts 3 · paired 1 · unpaired 0 · double-paired 2` and `daysCrossed 4` against a world of 3 - while the record
// whose own calendar WAS that night carried no receipt at all.
//
// The identity is the receipt's own days, which is what `multiday-baseline.mjs` already reads: `day_before` is the
// engine's `TotalDays` the night ended on, and a day record's own calendar (`after.dayBefore`) is the same day in
// `dayOfMonth` terms - a record observes the day AFTER its night. So this module asks the baseline's own
// `nightReceiptPairings` which record each night's calendar names (`namedBy`) and files the receipt there, and it takes
// the receipt off a record it does not name. The two readers then agree by construction rather than by the coincidence
// that the freshest receipt happened to be the right one.
import { NIGHT_CAUSE_SLEEP, nightReceiptPairings, parseReceiptEvidence } from "../../lib/multiday-baseline.mjs";

/**
 * The Mod's own word for a lifecycle that carried its night across (`succeeded/day_advanced`).
 *
 * Spelled here rather than imported because `multiday-baseline.mjs` keeps it private as one half of
 * `CROSSING_OUTCOME`; this module only asks whether a receipt CLAIMS a crossing, never whether the claim held.
 */
const CROSSING_REASON = "day_advanced";

/** The day a receipt's own evidence says the night ENDED on - the engine's `TotalDays` - or `null` when it names none. */
function endedDayOf(receipt) {
  const day = Number.parseInt(parseReceiptEvidence(receipt?.evidence).day_before ?? "", 10);
  return Number.isInteger(day) ? day : null;
}

/** Does this receipt CLAIM that a night crossed? A lifecycle that ended without the crossing is not one. */
function isCrossingClaim(receipt) {
  return receipt !== null && typeof receipt === "object" && receipt.reasonCode === CROSSING_REASON;
}

/**
 * The crossing receipt for each night the world said it had, keyed by the night's own day.
 *
 * THE POPULATION IS THE BASELINE'S OWN ENDINGS, not a second list of receipts: a night the ledger attributed to her
 * sleep names a day, and this keeps the receipt that declares exactly that day. A receipt for a day no ending names is
 * left out, because filing one would give a record a night the ledger does not count.
 */
function crossingReceiptsByNight({ receipts, worldNightEndings }) {
  const nights = new Set(
    (Array.isArray(worldNightEndings) ? worldNightEndings : [])
      .filter((ending) => ending?.cause === NIGHT_CAUSE_SLEEP && Number.isInteger(ending.day))
      .map((ending) => ending.day),
  );
  const byNight = new Map();
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!isCrossingClaim(receipt)) continue;
    const day = endedDayOf(receipt);
    if (day === null || !nights.has(day) || byNight.has(day)) continue;
    byNight.set(day, receipt);
  }
  return byNight;
}

/**
 * Remove one night's crossing claim from a record whose own calendar is a different night, returning how many fields
 * carried it (0 when none did).
 *
 * BOTH FIELDS ARE READ, because the runner fills both from the same receipt when the crossing IS the night's terminal
 * (`watchNightRollover`), and a `sleepReceipt` left behind would keep the night's cause attributed to the wrong record.
 * A record with no calendar at all is never touched: `nightReceiptPairings` derives that record's night FROM the receipt
 * it carries, so it is named by it and never reaches this function.
 */
function takeNightReceiptOff(record, day) {
  if (record === null || typeof record !== "object") return 0;
  let taken = 0;
  for (const field of ["terminal", "sleepReceipt"]) {
    const receipt = record[field];
    if (!isCrossingClaim(receipt) || endedDayOf(receipt) !== day) continue;
    record[field] = null;
    taken += 1;
  }
  return taken;
}

/**
 * File each night's crossing receipt on the day record whose own calendar IS that night, in place.
 *
 * THE RECORDS ARE MUTATED, not copied: `runMultiDayLoop` publishes these objects, `reconcileDaysWithTheWorld` reads
 * them, and the artifact is assembled from them, so a copy would leave the artifact describing the misfiled night.
 *
 * THE ORDER IS CLEAR-THEN-FILE, and it is not interchangeable: a record that wrongly holds night N's receipt is often
 * the record that rightly holds night N+1's, so filing first and clearing second would take the right one away.
 *
 * `filed` counts NIGHTS, not fields, and `cleared` counts FIELDS, because the two numbers answer different questions:
 * "did every night get its receipt" and "how many copies were lying on the wrong night". A night whose record has not
 * been minted yet - the CLOSING night, which `reconcileDaysWithTheWorld` adds afterwards - is not filed here, and needs
 * no filing: the assessment pairs it by that record's own `endedDayOfMonth`.
 */
export function fileNightReceiptsOnTheirOwnNights({ dayRecords = [], worldNightEndings = null, receipts = [] } = {}) {
  const records = Array.isArray(dayRecords) ? dayRecords : [];
  if (records.length === 0 || !Array.isArray(worldNightEndings)) {
    return Object.freeze({ examined: 0, filed: 0, cleared: 0, nights: Object.freeze([]) });
  }
  const pairings = nightReceiptPairings({ dayRecords: records, worldNightEndings });
  let cleared = 0;
  for (const entry of pairings.entries) {
    for (const [index, record] of records.entries()) {
      if (entry.namedBy.includes(index)) continue;
      cleared += takeNightReceiptOff(record, entry.day);
    }
  }
  const byNight = crossingReceiptsByNight({ receipts, worldNightEndings });
  const filed = [];
  for (const entry of pairings.entries) {
    // TWO RECORDS CLAIMING ONE NIGHT IS A READING THIS CANNOT RESOLVE, and guessing between them would file the receipt
    // on whichever came first in the array - the arrival-order mistake this module exists to remove. Left as it is, the
    // baseline's `a_night_receipt_is_paired_by_its_own_day` names both records.
    if (entry.namedBy.length !== 1) continue;
    const receipt = byNight.get(entry.day);
    if (receipt === undefined) continue;
    const record = records[entry.namedBy[0]];
    if (record === null || typeof record !== "object") continue;
    record.terminal = receipt;
    // THE NIGHT'S OWN SLEEP WITNESS IS ONLY REPLACED WHEN IT IS ANOTHER NIGHT'S CLAIM. A receipt that did NOT carry the
    // crossing is how a night her own sleep ended is attributed (`NIGHT_CAUSE_SLEEP_UNSETTLED`), so overwriting it with
    // the crossing receipt would erase the one fact that answers "how did the night start".
    if (record.sleepReceipt === null || record.sleepReceipt === undefined || isCrossingClaim(record.sleepReceipt))
      record.sleepReceipt = receipt;
    filed.push(entry.day);
  }
  return Object.freeze({ examined: pairings.examined, filed: filed.length, cleared, nights: Object.freeze(filed) });
}
