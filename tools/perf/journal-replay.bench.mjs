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

import { loadHostModule, measure, report } from "./harness.mjs";

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
 * `journal.open-replay`: one open plus its close, on the log `seedLog` left behind.
 *
 * At module scope rather than inside the `test()` that reports it: the open awaits a file handle, and
 * `node:test` instruments the async work a test body awaits, so a body that ran these windows would
 * charge the runner to the replay. See `measure`'s contract.
 */
async function measureOpenReplay({ size, records }) {
  const directory = await tempDirectory();
  try {
    await seedLog(directory, { records, settled: false, maxRecords: JOURNAL_BUDGET.maxRecords });
    const logBytesBefore = await logBytes(directory);
    const before = recoveryJournalWriteProfile();
    const measured = await measure({
      id: OPEN_CASE,
      size,
      run: async () => {
        const opened = await StardewLogicalActionRecoveryJournal.open(
          openOptions(directory, JOURNAL_BUDGET.maxRecords),
        );
        await opened.close();
      },
    });
    const after = recoveryJournalWriteProfile();
    return {
      measured,
      records,
      logBytes: logBytesBefore,
      parses: after.documentParses - before.documentParses,
      appends: after.appends - before.appends,
      compactions: after.compactions - before.compactions,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/**
 * `journal.compaction`: one budget-eviction fold of the whole live set per op, at module scope for the
 * same reason as above.
 */
async function measureCompaction({ size, records, foldOps, foldWindowMs }) {
  const directory = await tempDirectory();
  try {
    await seedLog(directory, { records, settled: true, maxRecords: records });
    let next = records + 1;
    const journal = await StardewLogicalActionRecoveryJournal.open(openOptions(directory, records));
    try {
      const before = recoveryJournalWriteProfile();
      const measured = await measure({
        id: COMPACTION_CASE,
        size,
        maxOps: foldOps,
        durationMs: foldWindowMs,
        warmupMs: 0,
        run: () => journal.prepare(dispatchMaterial(next++)),
      });
      const after = recoveryJournalWriteProfile();
      return {
        measured,
        records,
        compactions: after.compactions - before.compactions,
        appends: after.appends - before.appends,
        bytesPerFold: Math.round((after.writtenBytes - before.writtenBytes) / measured.ops),
        liveRecords: journal.records().length,
      };
    } finally {
      await journal.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

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
      outcome.measured.ops,
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
      outcome.measured.ops,
      "every op must fold the log exactly once, so the number is the fold's",
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
