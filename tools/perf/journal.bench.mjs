/**
 * The recovery journal's durable write, at two journal sizes.
 *
 * A live run's span tree put 28.179 s of one action family's 46.9 s in `journal.write`, paid on 45
 * of 45 actions. The property that has to hold is that one transition costs one line, whatever the
 * journal already holds: an append stays flat as the log grows, while a read-modify-rewrite of the
 * whole document grows with it. Both sizes are measured here so a regression to the document
 * cannot hide behind the small one.
 *
 * The op is one `prepare()`: one record written into existence, which is one durable append, one
 * flush and one `stat` - the same cost profile as the `mark*` transitions that follow it. The
 * write profile is read around the whole case, so the case itself proves what it measured:
 * appends must equal the ops performed and no compaction may happen inside the window (a
 * compaction reserialises every live record, and its cost is the document's, not a transition's).
 * The bytes per op are read off the log file's own growth, because that is the durable cost a
 * transition adds, whatever the module calls its counters this week.
 *
 * `maxOps` bounds the case instead of the clock, because the journal refuses writes past its own
 * record budget (4096) and its `prepared` records owe recovery, so they cannot be evicted: an
 * unbounded op count would end in `recovery_journal_budget_exceeded` on a fast machine instead of
 * in a number.
 */
import assert from "node:assert/strict";
import { mkdtemp, readdir, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadHostModule, measure, measureRatio, report, reportScaling, scalingRequested } from "./harness.mjs";

const CASE = "journal.write";

const { StardewLogicalActionRecoveryJournal, recoveryJournalWriteProfile } = await loadHostModule(
  "stardew-logical-action-recovery-journal.js",
);

const SCOPE = Object.freeze({ save: "bench" });

/** How much settled history the journal holds before the measured writes start. */
const SIZES = Object.freeze([
  Object.freeze({ size: "small", settledHistory: 8 }),
  Object.freeze({ size: "large", settledHistory: 400 }),
]);

/**
 * What one transition's cost may do with the journal it joins, and why.
 *
 * The claim this case exists to protect is FLATNESS: an append writes one line and touches nothing
 * else, so 50x the settled history must not move the per-op cost at all. Measured on this machine the
 * pair (8 -> 400 records, 50x) read 379.92 -> 368.91 µs/op, ratio 0.97 idle, and 610.34 -> 604.38,
 * ratio 0.99, on a later run. A regression to a read-modify-rewrite of the document would grow this
 * op's append part 50x over again - it writes 400 records where it wrote 8 - and read ~48 here; a
 * compaction inside the window is refused by the assertion below rather than absorbed into a ratio.
 *
 * WHY THE CEILING IS 8 AND NOT 2: this op's cost IS a durable write, so the machine's I/O contention
 * lands inside the ratio, not on both sides of it. Under 24 competing processes on 32 cpus - with a
 * neighbouring lane's suite running as well - the same pair read 17 552.53 -> 51 241.65 µs/op, ratio
 * 2.92: the only case of the seven whose ratio left its band under load, and it left it in the
 * direction of the log's size, because the two appends were queued differently, not because the code
 * changed. 8 is 2.7x that loaded reading and 6x below what a document rewrite reads, so the shape
 * claim still holds where it matters. The floor is 0.5, not 1: an append that got FASTER at the larger
 * size is still flat, and only a ratio that collapsed means the case stopped writing.
 */
const SCALING_BAND = Object.freeze({
  min: 0.5,
  max: 8,
  reason:
    "50x the settled history measured 0.97 idle and 2.92 under I/O contention (one append, one flush, one " +
    "stat, whatever the log holds); a read-modify-rewrite of the document reads ~48",
});

/** The journal's own caps (4096 records, 21 MiB); both sizes and the op cap stay inside them. */
const JOURNAL_BUDGET = Object.freeze({ maxRecords: 4096, maxBytes: 21 * 1024 * 1024 });
const MAX_OPS = 1500;

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
  return mkdtemp(join(root, "gamebuddy-perf-journal-"));
}

/** The journal log's size: the directory holds that one file, so its name is not assumed here. */
async function logBytes(directory) {
  const [name] = await readdir(directory);
  return (await stat(join(directory, name))).size;
}

/**
 * One journal size's op: the log `settledHistory` left behind, and the next append into it. Both
 * branches of this file build their journal here so a ratio and a budget reading are the same write.
 */
async function caseFor({ settledHistory }) {
  const directory = await tempDirectory();
  const journal = await StardewLogicalActionRecoveryJournal.open({ directory, scope: SCOPE, ...JOURNAL_BUDGET });
  try {
    for (let index = 1; index <= settledHistory; index += 1) await journal.prepare(dispatchMaterial(index));
  } catch (error) {
    await journal.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  let next = settledHistory + 1;
  return {
    directory,
    input: Object.freeze({ settledHistory }),
    run: () => journal.prepare(dispatchMaterial(next++)),
    close: async () => {
      await journal.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/**
 * One case's measurement, at module scope rather than inside the `test()` that reports it:
 * `prepare()` awaits a file handle per op, and `node:test` instruments the async work a test body
 * awaits, so a body that ran these windows would charge the runner to a durable append. See
 * `measure`'s contract.
 *
 * The write profile and the log's size are read around the whole case, so the test below can
 * assert on what ran instead of trusting the number: the counters are facts, the timing is the
 * measurement.
 */
async function measureCase(size) {
  const point = await caseFor(size);
  try {
    const before = recoveryJournalWriteProfile();
    const bytesBefore = await logBytes(point.directory);
    const measured = await measure({ id: CASE, size: size.size, maxOps: MAX_OPS, run: point.run });
    const after = recoveryJournalWriteProfile();
    const bytesAfter = await logBytes(point.directory);
    // The counters straddle the warmup as well as the windows, so the count they are compared
    // against is both named numbers the harness reports.
    const executed = measured.ops + measured.warmupOps;
    return {
      measured,
      settledHistory: size.settledHistory,
      executed,
      appends: after.appends - before.appends,
      compactions: after.compactions - before.compactions,
      bytesPerOp: Math.round((bytesAfter - bytesBefore) / executed),
    };
  } finally {
    await point.close();
  }
}

if (scalingRequested()) {
  const points = [];
  try {
    for (const size of SIZES) points.push({ size: size.size, maxOps: MAX_OPS, ...(await caseFor(size)) });
    const before = recoveryJournalWriteProfile();
    const bytesBefore = await Promise.all(points.map((point) => logBytes(point.directory)));
    // No warmup: it would spend appends the case's own counters would then have to explain, and
    // both points run the same code against a different log, so round 1 warms them together.
    const ratio = await measureRatio({ id: CASE, axis: "settledHistory", points, warmupMs: 0 });
    const after = recoveryJournalWriteProfile();
    const bytesAfter = await Promise.all(points.map((point) => logBytes(point.directory)));
    const counters = {
      executed: ratio.points.reduce((sum, point, index) => sum + point.ops, 0),
      appends: after.appends - before.appends,
      compactions: after.compactions - before.compactions,
      bytesPerOp: ratio.points.map((point, index) => Math.round((bytesAfter[index] - bytesBefore[index]) / point.ops)),
    };
    test(`${CASE} scaling`, () => {
      assert.equal(
        counters.appends,
        counters.executed,
        "every transition the case ran must cost exactly one durable append, so the ratio is about transitions",
      );
      assert.equal(
        counters.compactions,
        0,
        `the window compacted ${counters.compactions} time(s): a compaction reserialises the whole journal, so these ops are not transitions`,
      );
      reportScaling(ratio, SCALING_BAND);
    });
  } finally {
    for (const point of points) await point.close();
  }
} else {
  const outcomes = new Map();
  for (const size of SIZES) {
    try {
      outcomes.set(size.size, await measureCase(size));
    } catch (error) {
      // The case that could not be measured fails its own test below, instead of taking the other
      // size's finished measurement down with the file's module load.
      outcomes.set(size.size, { error });
    }
  }

  for (const { size, settledHistory } of SIZES) {
    test(`${CASE} ${size}`, () => {
      const outcome = outcomes.get(size);
      if (outcome.error !== undefined) throw outcome.error;
      assert.equal(
        outcome.appends,
        outcome.executed,
        "every transition the case ran must cost exactly one durable append, warmup included",
      );
      assert.equal(
        outcome.compactions,
        0,
        `the window compacted ${outcome.compactions} time(s): a compaction reserialises the whole journal, so these ops are not transitions`,
      );
      report({
        ...outcome.measured,
        detail: { settledHistory, bytesPerOp: outcome.bytesPerOp },
      });
    });
  }
}
