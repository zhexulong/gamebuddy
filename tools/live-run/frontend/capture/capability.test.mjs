/*
 * red-proof: inject  `transcriptShapeFindings` is driven with four hand-built transcripts and the
 * worldbook reader with a hand-built book.
 *
 * The two rules this file pins were both WRONG in the first version, and both were caught by running
 * them against a real chat rather than by reading them:
 *
 *   "companion count must equal player count"   false for every chat with an opening greeting - the
 *                                              `first_mes` row makes companion = player + 1 before
 *                                              anyone types. Measured: a healthy chat reported
 *                                              `companion_duplicate_reply` on its very first turn.
 *   "a player row may not be the last row"     false DURING a turn: the player's line commits before
 *                                              the reply arrives. Measured: a probe that waited on the
 *                                              settled mark read the transcript mid-repaint and
 *                                              reported `player_line_unanswered`.
 *
 * So the assertions below are about the rules that survive contact: a player line is answered by
 * exactly one companion row, and that is asked only once the caller says the turn is over.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { transcriptShapeFindings, worldbookExpectation } from "./capability.cjs";

const row = (role, text = "x") => ({ role, text });

test("a chat with an opening greeting is healthy, not duplicated", () => {
  const rows = [row("companion", "opening"), row("player", "hi"), row("companion", "hello")];
  assert.deepEqual(
    transcriptShapeFindings(rows, { expectedPlayerLines: 1 }),
    [],
    "companion = player + 1 is what an opening greeting looks like; calling it a duplicate reply is the bug",
  );
});

test("a player line answered twice is named", () => {
  const rows = [row("companion", "opening"), row("player", "hi"), row("companion", "a"), row("companion", "b")];
  const findings = transcriptShapeFindings(rows, { expectedPlayerLines: 1 });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "companion_double_reply");
});

test("an unanswered player line is reported only when the caller says the turn is over", () => {
  const rows = [row("companion", "opening"), row("player", "hi")];
  assert.deepEqual(
    transcriptShapeFindings(rows, { expectedPlayerLines: 1 }),
    [],
    "a turn in flight leaves the player's line last; that is not a defect",
  );
  const settled = transcriptShapeFindings(rows, { expectedPlayerLines: 1, settled: true });
  assert.equal(settled[0]?.code, "player_line_unanswered");
});

test("the worldbook reader takes the always-on entries from the file, not from a list here", () => {
  const directory = mkdtempSync(join(tmpdir(), "capability-"));
  const path = join(directory, "worldbook.json");
  writeFileSync(
    path,
    JSON.stringify({
      entries: [
        { entryId: "a", title: "always", constant: true, keys: ["农场", "伙伴"] },
        { entryId: "b", title: "gated", constant: false, keys: ["下雨"] },
        { entryId: "c", title: "neither", constant: false },
      ],
    }),
  );
  const expectation = worldbookExpectation(path);
  assert.deepEqual(
    expectation.alwaysOn.map((entry) => entry.entryId),
    ["a"],
    "only the constant entry is always-on",
  );
  assert.deepEqual(
    expectation.gated.map((entry) => entry.entryId),
    ["b"],
    "an entry with no keys and no constant flag gates nothing, so it is in neither list",
  );
});
