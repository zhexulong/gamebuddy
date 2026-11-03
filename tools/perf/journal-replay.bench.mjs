/**
 * The two journal costs that stayed O(document) after the append-only write: open/replay and
 * compaction.
 *
 * `journal.write` proves a transition costs one line whatever the log holds. These two cases cover
 * the work that still reads or rewrites every live record, so a long run's total is not the append
 * alone:
 *
 * - `journal.open-replay`: `open()` reads the whole log and folds every line back into the live set
 *   before the journal can answer anything. One open is one full replay, so its cost is the log's,
 *   and the op is an open plus its close (a bench cannot leave hundreds of handles open).
 * - `journal.compaction`: once superseded lines exceed the live set plus `COMPACTION_SLACK_LINES`
 *   (64), `#publish()` folds the log into a fresh file, writing every live record and renaming it
 *   into place. That fold is the journal's other O(document) write.
 *
 * HOW THE FOLD IS FORCED: the slack trigger needs `records + 64` appends before each fold, and an
 * append is a `sync` (~560 µs measured in `journal.write`), so a slack-triggered op would be 90 ms to
 * 0.6 s of appends with the fold buried inside it - a number about fsync, not about the fold. The
 * record budget reaches the same private `#publish()` with no preamble: with `maxRecords` set to
 * exactly the live set, one `prepare()` overflows the budget, evicts the oldest settled record and
 * folds the whole live set back out. So each measured op is exactly one fold of `records` records,
 * which is the unit whose cost and rewritten bytes this case reports.
 *
 * WHY THERE IS NO WARMUP AND THE OP BUDGET IS CAPPED: an eviction-triggered fold spends one settled
 * record, and only a settled record may be dropped, so one seeded log can fold at most `records`
 * times before the budget refusal is honest. The harness's warmup is bounded by the clock, not by an
 * op count, so a warmup here would spend folds the case can never repeat; `maxOps` keeps the case
 * inside the pool instead, well under it.
 *
 * MULTIPLYING BY REALITY: a 45-action run opens the journal once (production opens it per Game
 * runtime enter, `materializeEnter`, not per action) and pays one slack fold - three appended lines
 * per action against one live record per action crosses the 64-line slack during action 33, which
 * folds ~33 live records. So per-action replay is zero and the run pays one open plus one fold;
 * `microsPerRecord` is what turns either into a number for a bigger log. The profile's
 * `documentParses` is the open counter this relies on - the case asserts one parse per open, and a
 * 45-action run against a fresh log shows exactly one.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadHostModule, measure, measureRatio, report, reportScaling, scalingRequested } from "./harness.mjs";

const OPEN_CASE = "journal.open-replay";
const COMPACTION_CASE = "journal.compaction";

const { StardewLogicalActionRecoveryJournal, recoveryJournalWriteProfile } = await loadHostModule(
  "stardew-logical-action-recovery-journal.js",
);

const SCOPE = Object.freeze({ save: "bench" });

/** The journal's own caps (4096 records, 21 MiB); both sizes stay far inside them. */
const JOURNAL_BUDGET = Object.freeze({
  maxRecords: 4096,
  maxBytes: 21 * 1024 * 1024,
});

/**
 * Two document sizes: the log a short run leaves (45 actions at three lines each, with headroom) and
 * a long run's. Both cases measure both, so a cost that grows with the document cannot hide behind
 * the small one.
 *
 * `foldOps` and `foldWindowMs` bound one compaction case: at most `foldOps` folds - a fraction of the
 * pool of evictable records that each fold spends one of - in windows of `foldWindowMs`, so each
 * round stops on the clock and the case reports the fastest of them rather than one window that a
 * neighbour lane's build happened to share.
 */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", records: 100, foldOps: 50, foldWindowMs: 20 }),
  Object.freeze({
    size: "large",
    records: 1000,
    foldOps: 200,
    foldWindowMs: 40,
  }),
]);

/**
 * What a replay's cost may do with the log it reads, and why.
 *
 * A replay is a read of every line and a fold of every record, so 10x the records must cost about 10x
 * - unlike `journal.write`, which must stay flat. Measured on this machine the pair (100 -> 1 000
 * records, 10x) read 2 255.57 -> 14 683.71 µs/op, ratio 6.51: the replay is linear, with the open's
 * own file-handle work as a fixed part the short log pays in full. A quadratic replay would grow the
 * record part 10x over again and read ~62; one that stopped folding the log it opened would read ~1.
 * The ceiling of 13 is 2x the measured ratio.
 */
const OPEN_SCALING_BAND = Object.freeze({
  min: 2,
  max: 13,
  reason:
    "10x the records measured 6.51 (one read and one fold per line); " +
    "a quadratic replay reads ~62, a replay that stopped folding reads ~1",
});

/**
 * What a fold's cost may do with the live set it rewrites, and why.
 *
 * A fold writes every live record into a fresh file and renames it, so it is linear in the live set -
 * but the durable write that closes the fold is a fixed cost the short log pays in full, and it
 * dominates: measured on this machine the pair (100 -> 1 000 records, 10x) read 2 127.53 -> 3 118.55
 * µs/op, ratio 1.47. So this band claims a CEILING only. A quadratic fold would grow the record part
 * 10x over again and read ~6, and a fold that gave every rewritten record its own durable sync would
 * break this ceiling outright; a floor could not tell a fold that stopped writing the live set (~1)
 * from a fold that got faster, which is why there is none here and there is one on the replay above.
 */
const COMPACTION_SCALING_BAND = Object.freeze({
  min: 0,
  max: 3,
  reason:
    "10x the live set measured 1.47 (every live record rewritten once, behind one durable sync); " +
    "a quadratic fold reads ~6, a per-record durable sync breaks the ceiling outright",
});

function openOptions(directory, maxRecords) {
  return {
    directory,
    scope: SCOPE,
    maxRecords,
    maxBytes: JOURNAL_BUDGET.maxBytes,
  };
}

/** One action's immutable dispatch material, as the journal records it. */
function dispatchMaterial(index) {
  const id = `action-${index}`;
  return {
    logicalActionId: id,
    dispatchOrdinal: index,
    ownerId: "owner",
    epoch: 2,
    requestId: `request-${id}`,
    idempotencyKey: `key-${id}`,
    actionId: "move_to_tile",
    canonicalArgs: { x: 1, y: 2 },
    canonicalRequest: {
      requestId: `request-${id}`,
      idempotencyKey: `key-${id}`,
      action: "move_to_tile",
      args: { x: 1, y: 2 },
      expectedRevision: 3,
      deadlineMs: 9999,
    },
    expectedRevision: 3,
    deadlineMs: 9999,
    scope: SCOPE,
    bindingIdentity: { binding: "bench" },
  };
}

/** A temporary journal root under the platform's real temp directory. */
async function tempDirectory() {
  const parent = process.platform === "win32" ? process.env.LOCALAPPDATA : undefined;
  const root = await realpath(parent ?? tmpdir());
  return mkdtemp(join(root, "gamebuddy-perf-journal-replay-"));
}

/** The journal log's size: the directory holds that one file, so its name is not assumed here. */
async function logBytes(directory) {
  const [name] = await readdir(directory);
  return (await stat(join(directory, name))).size;
}

/**
 * The log a previous session left behind: `records` actions, each still owing recovery or already
 * settled history. Settled records are the ones the record budget may evict.
 */
async function seedLog(directory, { records, settled, maxRecords }) {
  const journal = await StardewLogicalActionRecoveryJournal.open(openOptions(directory, maxRecords));
  try {
    for (let index = 1; index <= records; index += 1) {
      await journal.prepare(dispatchMaterial(index));
      if (settled) await journal.markTerminalSettled(`action-${index}`);
    }
  } finally {
    await journal.close();
  }
}

function microsPerRecord(perOpMicros, records) {
  return Math.round((perOpMicros / records) * 1000) / 1000;
}

/**
 * `journal.open-replay`'s op for one log size: a replay of the log `seedLog` left behind, and the
 * directory it lives in. Both branches of this file build the log here.
 */
async function openReplayFor({ records }) {
  const directory = await tempDirectory();
  try {
    await seedLog(directory, { records, settled: false, maxRecords: JOURNAL_BUDGET.maxRecords });
    const logBytesBefore = await logBytes(directory);
    return {
      directory,
      logBytes: logBytesBefore,
      input: Object.freeze({ records }),
      run: async () => {
        const opened = await StardewLogicalActionRecoveryJournal.open(
          openOptions(directory, JOURNAL_BUDGET.maxRecords),
        );
        await opened.close();
      },
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * `journal.compaction`'s op for one live-set size: one budget-eviction fold of the whole live set per
 * op. The fold spends one settled record, so the op budget and the window are the case's rather than
 * the harness's defaults.
 */
async function compactionFor({ records, foldOps, foldWindowMs }) {
  const directory = await tempDirectory();
  try {
    await seedLog(directory, { records, settled: true, maxRecords: records });
    const journal = await StardewLogicalActionRecoveryJournal.open(openOptions(directory, records));
    let next = records + 1;
    return {
      journal,
      input: Object.freeze({ records }),
      maxOps: foldOps,
      windowMs: foldWindowMs,
      run: () => journal.prepare(dispatchMaterial(next++)),
      close: async () => {
        await journal.close();
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/**
 * `journal.open-replay`: one open plus its close, on the log `seedLog` left behind.
 *
 * At module scope rather than inside the `test()` that reports it: the open awaits a file handle, and
 * `node:test` instruments the async work a test body awaits, so a body that ran these windows would
 * charge the runner to the replay. See `measure`'s contract.
 */
async function measureOpenReplay(size) {
  const point = await openReplayFor(size);
  try {
    const before = recoveryJournalWriteProfile();
    const measured = await measure({ id: OPEN_CASE, size: size.size, run: point.run });
    const after = recoveryJournalWriteProfile();
    return {
      measured,
      records: size.records,
      // The counters straddle the warmup as well as the windows, so the count they are compared
      // against is both named numbers the harness reports.
      executed: measured.ops + measured.warmupOps,
      logBytes: point.logBytes,
      parses: after.documentParses - before.documentParses,
      appends: after.appends - before.appends,
      compactions: after.compactions - before.compactions,
    };
  } finally {
    await point.close();
  }
}

/**
 * `journal.compaction`: one budget-eviction fold of the whole live set per op, at module scope for the
 * same reason as above.
 */
async function measureCompaction(size) {
  const point = await compactionFor(size);
  try {
    const before = recoveryJournalWriteProfile();
    const measured = await measure({
      id: COMPACTION_CASE,
      size: size.size,
      maxOps: size.foldOps,
      windowMs: size.foldWindowMs,
      warmupMs: 0,
      run: point.run,
    });
    const after = recoveryJournalWriteProfile();
    const executed = measured.ops + measured.warmupOps;
    return {
      measured,
      records: size.records,
      executed,
      compactions: after.compactions - before.compactions,
      appends: after.appends - before.appends,
      bytesPerFold: Math.round((after.writtenBytes - before.writtenBytes) / executed),
      liveRecords: point.journal.records().length,
    };
  } finally {
    await point.close();
  }
}

if (scalingRequested()) {
  // No warmup on either case: it would spend folds and appends the counters below have to explain,
  // and both points run the same code, so round 1 warms them together.
  const openPoints = [];
  const foldPoints = [];
  try {
    for (const size of SIZES) openPoints.push({ size: size.size, ...(await openReplayFor(size)) });
    const openBefore = recoveryJournalWriteProfile();
    const openRatio = await measureRatio({ id: OPEN_CASE, axis: "records", points: openPoints, warmupMs: 0 });
    const openAfter = recoveryJournalWriteProfile();
    const openCounters = {
      executed: openRatio.points.reduce((sum, point) => sum + point.ops, 0),
      parses: openAfter.documentParses - openBefore.documentParses,
      appends: openAfter.appends - openBefore.appends,
      compactions: openAfter.compactions - openBefore.compactions,
    };

    for (const size of SIZES) foldPoints.push({ size: size.size, ...(await compactionFor(size)) });
    const liveRecords = foldPoints.map((point) => point.journal.records().length);
    const foldsBefore = recoveryJournalWriteProfile();
    const foldRatio = await measureRatio({ id: COMPACTION_CASE, axis: "records", points: foldPoints, warmupMs: 0 });
    const foldAfter = recoveryJournalWriteProfile();
    const foldCounters = {
      executed: foldRatio.points.reduce((sum, point) => sum + point.ops, 0),
      compactions: foldAfter.compactions - foldsBefore.compactions,
      appends: foldAfter.appends - foldsBefore.appends,
    };

    test(`${OPEN_CASE} scaling`, () => {
      assert.equal(
        openCounters.parses,
        openCounters.executed,
        "an open must read and fold the log exactly once, however long it is",
      );
      assert.equal(openCounters.appends, 0, "a replay appends nothing: the op must be read-only");
      assert.equal(openCounters.compactions, 0, "a replay must not fold the log into a new file");
      reportScaling(openRatio, OPEN_SCALING_BAND);
    });

    test(`${COMPACTION_CASE} scaling`, () => {
      assert.equal(
        foldCounters.compactions,
        foldCounters.executed,
        "every op the case ran must fold the log exactly once, so the ratio is the fold's",
      );
      assert.equal(foldCounters.appends, 0, "the budget fold appends nothing: its whole write is the fold");
      assert.deepEqual(
        liveRecords,
        SIZES.map((size) => size.records),
        "the fold must rewrite the journal's live set, not only the record this op touched",
      );
      reportScaling(foldRatio, COMPACTION_SCALING_BAND);
    });
  } finally {
    for (const point of openPoints) await point.close();
    for (const point of foldPoints) await point.close();
  }
} else {
  const outcomes = new Map();
  for (const size of SIZES) {
    try {
      outcomes.set(`${OPEN_CASE}/${size.size}`, await measureOpenReplay(size));
    } catch (error) {
      // The case that could not be measured fails its own test below, instead of taking the size's
      // other case down with the file's module load.
      outcomes.set(`${OPEN_CASE}/${size.size}`, { error });
    }
    try {
      outcomes.set(`${COMPACTION_CASE}/${size.size}`, await measureCompaction(size));
    } catch (error) {
      outcomes.set(`${COMPACTION_CASE}/${size.size}`, { error });
    }
  }

  for (const { size, records } of SIZES) {
    test(`${OPEN_CASE} ${size}`, () => {
      const outcome = outcomes.get(`${OPEN_CASE}/${size}`);
      if (outcome.error !== undefined) throw outcome.error;
      assert.equal(
        outcome.parses,
        outcome.executed,
        "an open must read and fold the log exactly once, however long it is",
      );
      assert.equal(outcome.appends, 0, "a replay appends nothing: the op must be read-only");
      assert.equal(outcome.compactions, 0, "a replay must not fold the log into a new file");
      report({
        ...outcome.measured,
        detail: {
          records,
          microsPerRecord: microsPerRecord(outcome.measured.perOpMicros, records),
          logBytes: outcome.logBytes,
        },
      });
    });

    test(`${COMPACTION_CASE} ${size}`, () => {
      const outcome = outcomes.get(`${COMPACTION_CASE}/${size}`);
      if (outcome.error !== undefined) throw outcome.error;
      assert.equal(
        outcome.compactions,
        outcome.executed,
        "every op the case ran must fold the log exactly once, so the number is the fold's",
      );
      assert.equal(outcome.appends, 0, "the budget fold appends nothing: its whole write is the fold");
      assert.equal(
        outcome.liveRecords,
        records,
        "the fold must rewrite the journal's live set, not only the record this op touched",
      );
      report({
        ...outcome.measured,
        detail: {
          records,
          bytesPerFold: outcome.bytesPerFold,
          microsPerRecord: microsPerRecord(outcome.measured.perOpMicros, records),
        },
      });
    });
  }
}
