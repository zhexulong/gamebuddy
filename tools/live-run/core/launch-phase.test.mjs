import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readLaunchPhaseHandover, writeLaunchPhaseHandover } from "./launch-phase.mjs";

function scratch() {
  return mkdtempSync(join(tmpdir(), "launch-phase-"));
}

/**
 * The handover is a diagnostic, and on 2026-11-21 it killed two launches in a row: a Windows rename onto a path another
 * process held open throws `EPERM`, and `writeLaunchPhaseHandover` let it out. These pin the two properties that make
 * that impossible again - it always lands a readable document, and it leaves no `.tmp` behind.
 */
test("a_handover_lands_a_readable_document_and_leaves_no_temporary", (t) => {
  const directory = scratch();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "phases.json");
  const first = writeLaunchPhaseHandover({
    path,
    startedAtMs: 1_000,
    records: [{ phase: "launcher_start", elapsedMs: 0, atMs: 1_000 }],
  });
  assert.deepEqual(readLaunchPhaseHandover(path), first, "the document the writer returned is the one the reader gets");
  assert.equal(
    readdirSync(directory).filter((name) => name.endsWith(".tmp")).length,
    0,
    "the temporary file is removed on the way out, whether the rename landed or the write fell back to the destination",
  );
});

test("a_second_handover_replaces_the_first_whole", (t) => {
  const directory = scratch();
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "phases.json");
  writeLaunchPhaseHandover({ path, startedAtMs: 1_000, records: [{ phase: "launcher_start", elapsedMs: 0, atMs: 1_000 }] });
  const second = writeLaunchPhaseHandover({
    path,
    startedAtMs: 2_000,
    records: [{ phase: "game_launched", elapsedMs: 5, atMs: 2_005 }],
  });
  assert.deepEqual(readLaunchPhaseHandover(path), second, "the reader sees the second document, not a merge of the two");
  assert.equal(JSON.parse(readFileSync(path, "utf8")).records.length, 1, "one document, whole");
});
