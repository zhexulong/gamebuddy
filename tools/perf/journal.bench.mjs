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
 *
 * `maxOps` bounds the case instead of the clock, because the journal refuses writes past its own
 * record budget (4096) and its `prepared` records owe recovery, so they cannot be evicted: an
 * unbounded op count would end in `recovery_journal_budget_exceeded` on a fast machine instead of
 * in a number.
 */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadHostModule, measure, report } from "./harness.mjs";

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

for (const { size, settledHistory } of SIZES) {
  test(`${CASE} ${size}`, async () => {
    const directory = await tempDirectory();
    try {
      const journal = await StardewLogicalActionRecoveryJournal.open({
        directory,
        scope: SCOPE,
        ...JOURNAL_BUDGET,
      });
      try {
        for (let index = 1; index <= settledHistory; index += 1) await journal.prepare(dispatchMaterial(index));
        let next = settledHistory + 1;
        const before = recoveryJournalWriteProfile();
        const result = await measure({
          id: CASE,
          size,
          maxOps: MAX_OPS,
          run: () => journal.prepare(dispatchMaterial(next++)),
        });
        const after = recoveryJournalWriteProfile();
        const appends = after.appends - before.appends;
        const compactions = after.compactions - before.compactions;
        assert.equal(appends, result.ops, "every measured transition must still cost exactly one durable append");
        assert.equal(
          compactions,
          0,
          `the window compacted ${compactions} time(s): a compaction reserialises the whole journal, so these ops are not transitions`,
        );
        report({
          ...result,
          detail: {
            settledHistory,
            bytesPerOp: Math.round((after.serialisedBytes - before.serialisedBytes) / result.ops),
          },
        });
      } finally {
        await journal.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
