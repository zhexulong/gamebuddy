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
 *
 * Continuity (the second half of the file) was proved the same way - one violation injected at a time,
 * the named case red, then restored: ignoring `removedHandles`, dropping the duplicate-handle check,
 * skipping the relative-order comparison, and skipping the order monotonicity check each reddened
exactly the case that names it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  continuityLine,
  transcriptContinuityFindings,
  transcriptShapeFindings,
  worldbookExpectation,
} from "./capability.cjs";

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

/**
 * The worldbook's own `enabled: false`, as an expectation that flips with the flag.
 *
 * The book is ONE fixture and the flag is its only changing field: the same file is rewritten with
 * `enabled` flipped and the expectation has to follow. That is the falsifier for the world-book half of
 * the injection proof - a reader that ignored the flag would return the same list for both books and
 * neither reading would mean anything.
 */
test("an entry the book switches off is expected to reach nothing, and flipping the flag changes that", () => {
  const directory = mkdtempSync(join(tmpdir(), "capability-enabled-"));
  const path = join(directory, "worldbook.json");
  const book = (enabled) => ({
    entries: [
      { entryId: "on", title: "reaches", constant: true, keys: ["农场"] },
      { entryId: "off", title: "switched off", constant: true, keys: ["灯塔"], enabled },
    ],
  });
  const expectationOf = (enabled) => {
    writeFileSync(path, JSON.stringify(book(enabled)));
    return worldbookExpectation(path);
  };

  const switchedOff = expectationOf(false);
  assert.deepEqual(
    switchedOff.alwaysOn.map((entry) => entry.entryId),
    ["on"],
    "a disabled constant entry reaches nothing, so the prompt must not be expected to carry it",
  );
  assert.deepEqual(
    switchedOff.disabled.map((entry) => entry.entryId),
    ["off"],
    "the switched-off entry is named rather than dropped: its absence from the request is the other half of the claim",
  );

  const switchedOn = expectationOf(true);
  assert.deepEqual(
    switchedOn.alwaysOn.map((entry) => entry.entryId),
    ["on", "off"],
    "the same book with the flag flipped must now expect the entry - otherwise the flag is not being read",
  );
  assert.deepEqual(switchedOn.disabled, [], "nothing is switched off in this reading");

  const absentFlag = expectationOf(undefined);
  assert.deepEqual(
    absentFlag.alwaysOn.map((entry) => entry.entryId),
    ["on", "off"],
    "an entry with no `enabled` field is enabled - the product's own rule (`WorldBookEntry.enabled`, host/src/worldbook.ts)",
  );
});

/* ---------- continuity across turns ---------- */

const rowOf = (order, role, handle) => ({ order, role, handle, text: handle });

/** A conversation as the Host keeps it: the opening greeting, then one exchange per turn. */
const conversation = (turnCount) => [
  rowOf(0, "companion", "m0"),
  ...Array.from({ length: turnCount }, (_, index) => index + 1).flatMap((n) => [
    rowOf(2 * n - 1, "player", `p${n}`),
    rowOf(2 * n, "companion", `c${n}`),
  ]),
];

test("a second turn appends its own rows and keeps the first turn's", () => {
  const findings = transcriptContinuityFindings([
    { label: "after turn 1", rows: conversation(1) },
    { label: "after turn 2", rows: conversation(2) },
  ]);
  assert.deepEqual(findings, [], "two turns on one conversation are append-only; nothing here is a count");
});

test("a row lost between turns is named with the handle that went missing", () => {
  const before = conversation(2);
  const after = before.filter((row) => row.handle !== "c1");
  const findings = transcriptContinuityFindings([
    { label: "after turn 1", rows: before },
    { label: "after turn 2", rows: after },
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "row_lost");
  assert.match(findings[0].message, /"c1"/u, "the finding must name the row that vanished, not a count difference");
});

test("a declared removal is not a lost row, and an undeclared one still is", () => {
  const before = conversation(2);
  const declared = transcriptContinuityFindings([
    { label: "before the delete", rows: before },
    { label: "after the delete", rows: before.filter((row) => row.handle !== "c1"), removedHandles: ["c1"] },
  ]);
  assert.deepEqual(declared, [], "the delete driver says which row it removed, so that row leaving is not a finding");

  const surplus = transcriptContinuityFindings([
    { label: "before the delete", rows: before },
    {
      label: "after the delete",
      rows: before.filter((row) => row.handle !== "c1" && row.handle !== "p2"),
      removedHandles: ["c1"],
    },
  ]);
  assert.equal(surplus.length, 1, "a declared removal does not license a second row to disappear");
  assert.equal(surplus[0].code, "row_lost");
  assert.match(surplus[0].message, /"p2"/u);
});

test("the same message committed twice is reported as a duplicated row", () => {
  const rows = conversation(1);
  const doubled = [...rows, rowOf(3, "companion", "c1")];
  const findings = transcriptContinuityFindings([{ label: "after turn 1", rows: doubled }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "row_duplicated");
  assert.match(findings[0].message, /"c1"/u);
});

test("rows that survive in a different relative order are reported as reordered", () => {
  const before = conversation(2);
  const reordered = [before[0], before[2], before[1], before[3], before[4]];
  const findings = transcriptContinuityFindings([
    { label: "after turn 1", rows: before },
    { label: "after turn 2", rows: reordered },
  ]);
  assert.ok(
    findings.some((finding) => finding.code === "row_reordered"),
    "an inserted row that lands before an older one is a reorder, not an append",
  );
});

test("an order that goes backwards is reported even inside one snapshot", () => {
  const rows = conversation(2);
  const shuffled = [rows[0], rows[2], rows[1], rows[3], rows[4]];
  const findings = transcriptContinuityFindings([{ label: "now", rows: shuffled }]);
  assert.equal(findings[0].code, "order_not_monotonic");
  assert.match(findings[0].message, /row 2 carries order 1 after row 1's 2/u);
});

test("a row the Host did not give a handle is named rather than silently skipped", () => {
  const findings = transcriptContinuityFindings([
    { label: "now", rows: [{ order: 0, role: "companion", handle: null }] },
  ]);
  assert.equal(findings[0].code, "row_without_handle");
});

test("the facts-file line says ok or names every finding, and never reports a count as if it were the check", () => {
  const ok = continuityLine("n before->after", [
    { label: "a", rows: conversation(1) },
    { label: "b", rows: conversation(2) },
  ]);
  assert.match(ok, /^ok /u);
  const bad = continuityLine("p", [
    { label: "a", rows: conversation(1) },
    { label: "b", rows: [] },
  ]);
  assert.match(bad, /^FAIL /u);
  assert.match(bad, /row_lost/u);
});
