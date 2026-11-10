/**
 * The reading-shape gate: `tools/audit-run-reading-shape.mjs`, over the seam in `tools/lib/reading.mjs`.
 *
 * WHAT THIS PROTECTS. On 2026-11-10 a verdict printed `plan_work=97` where 26 calls had been made, because the count was
 * `sessionText.split("plan_work").length - 1` - a token census over a text blob, reported as a count of events. The gate
 * exists so that shape cannot be written again without becoming red, and this suite drives it red on the expression
 * itself before asserting the tree is clean.
 *
 * The assertions are shaped so they cannot pass by accident:
 *
 *   - the red case is the round43 expression, verbatim, and the finding is asserted to NAME the file, the line and the
 *     expression - a gate that reported "1 problem" would pass this suite while telling the next reader nothing;
 *   - the green case is the same count routed through `census`, so routing - not deletion - is what turns it green;
 *   - the line-break exclusion is pinned from both sides: `split("\n").length` on a prefix is a source POSITION (no
 *     finding), while `split("\n").length` on a whole text is a line census once the tree contains one... and the
 *     exemption goes STALE when its expression is rewritten, which is the only thing keeping an exemption honest;
 *   - the real tree is scanned, and this suite asserts `bare prints 0` with a non-zero `scripts examined` and a
 *     non-zero `readings routed`: a gate that matched no scripts, or whose conversions were removed, fails here;
 *   - an empty scan is asserted BLOCKED, so `examined 0` can never read as a clean tree.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { collectScripts, examineScript, examineScripts, gate } from "./audit-run-reading-shape.mjs";

const ROUND43 = [
  "// the round43 counter, verbatim:",
  'const batches = sessionText.split("plan_work").length - 1;',
  "",
].join("\n");

const ROUTED = [
  'import { census } from "./lib/reading.mjs";',
  "",
  'const batches = census(sessionText.split("\\n"), (line) => (line.includes("plan_work") ? "plan_work" : null), {',
  '  unit: "session lines",',
  '  source: "session.jsonl",',
  '  method: "line scan for plan_work",',
  "  window: { wholeRun: true },",
  "});",
  "",
].join("\n");

const script = (fileName, source) => ({ fileName, source });

test("the round43 expression is reported, with the line and the expression named", async () => {
  const examined = await examineScript(script("tools/live-run/round43.mjs", ROUND43));
  assert.equal(examined.bare.length, 1);
  assert.equal(examined.bare[0].rule, "bare_reading");
  assert.equal(examined.bare[0].file, "tools/live-run/round43.mjs");
  assert.equal(examined.bare[0].line, 2);
  assert.equal(examined.bare[0].expression, 'sessionText.split("plan_work").length');
});

test("routing the same count through the census turns it green and is counted as routed", async () => {
  const examined = await examineScript(script("tools/live-run/routed.mjs", ROUTED));
  assert.deepEqual(examined.bare, []);
  assert.equal(examined.routed, 1);
  assert.equal(examined.importsSeam, true);
});

test("a script that does not import the seam cannot claim to have routed a number", async () => {
  const source = ["const format = (n) => `${n}`;", "process.stdout.write(format(3));", ""].join("\n");
  const examined = await examineScript(script("tools/live-run/local-format.mjs", source));
  assert.equal(examined.importsSeam, false);
  assert.equal(examined.routed, 0);
});

test("a line number derived from a prefix slice is a position, not a census of the run", async () => {
  const source = ['const at = source.slice(0, match.index).split("\\n").length;', ""].join("\n");
  const examined = await examineScript(script("tools/audit-position.mjs", source));
  assert.deepEqual(examined.bare, []);
});

test("an exemption whose expression was rewritten goes stale instead of covering the new one", async () => {
  const exemptions = [
    {
      file: "tools/live-run/chat/check-post-history-instructions-live.mjs",
      expression: "text.split(field).length",
      reason: "a predicate over one message's text",
    },
  ];
  const scripts = [script("tools/live-run/chat/check-post-history-instructions-live.mjs", ROUND43)];

  const live = await examineScripts(scripts, [
    { ...exemptions[0], expression: 'sessionText.split("plan_work").length' },
  ]);
  assert.equal(live.bare.length, 0);
  assert.equal(live.exempted.length, 1);
  assert.deepEqual(live.stale, []);

  const stale = await examineScripts(scripts, exemptions);
  assert.equal(stale.bare.length, 1);
  assert.equal(stale.exempted.length, 0);
  assert.equal(stale.stale.length, 1);
  assert.equal(stale.stale[0].file, exemptions[0].file);
  assert.equal(stale.stale[0].expression, "text.split(field).length");
});

test("an exemption for a file that is not in the scan is stale too", async () => {
  const stale = await examineScripts(
    [script("tools/live-run/round43.mjs", ROUND43)],
    [{ file: "tools/live-run/gone.mjs", expression: "gone.split(x).length", reason: "a deleted script" }],
  );
  assert.equal(stale.stale.length, 1);
  assert.equal(stale.stale[0].file, "tools/live-run/gone.mjs");
});

test("a scan that matches nothing is blocked, never green", async () => {
  const root = mkdtempSync(join(tmpdir(), "reading-shape-empty-"));
  try {
    mkdirSync(join(root, "tools", "live-run"), { recursive: true });
    assert.deepEqual(collectScripts(root), []);
    const verdict = await gate(root);
    assert.equal(verdict.exitCode, 1);
    assert.equal(verdict.examined, 0);
    assert.match(verdict.lines[0], /^reading-shape_blocked: /);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real tree is clean, examined a non-zero population, and routes its numbers through the seam", async () => {
  const verdict = await gate();
  assert.deepEqual(
    verdict.bare.map((finding) => `${finding.file}:${finding.line} ${finding.expression}`),
    [],
  );
  assert.deepEqual(
    verdict.stale.map((stale) => stale.file),
    [],
  );
  assert.ok(verdict.examined > 50, `expected the whole analysis tree, examined ${verdict.examined}`);
  assert.ok(verdict.routed > 0, "no script routes a number through tools/lib/reading.mjs");
  assert.equal(verdict.exitCode, 0);
  assert.match(verdict.lines.at(-1), /^scripts examined \d+ · readings routed \d+ · bare prints 0$/);
});

test("the population comes from the directory scan: a new token census under tools/live-run is caught", async () => {
  const root = mkdtempSync(join(tmpdir(), "reading-shape-"));
  try {
    mkdirSync(join(root, "tools", "live-run", "game"), { recursive: true });
    writeFileSync(join(root, "tools", "live-run", "game", "fresh-verdict.mjs"), ROUND43);
    writeFileSync(join(root, "tools", "live-run", "game", "ignored.test.mjs"), ROUND43);
    writeFileSync(join(root, "tools", "audit-something.mjs"), ROUND43);
    const verdict = await gate(root);
    assert.deepEqual(
      verdict.bare.map((finding) => finding.file),
      ["tools/audit-something.mjs", "tools/live-run/game/fresh-verdict.mjs"],
    );
    assert.equal(verdict.exitCode, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
