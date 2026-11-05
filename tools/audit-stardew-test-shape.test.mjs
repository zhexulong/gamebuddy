// Falsifier suite for the Stardew test-shape gate.
//
// WHY (measured 2026-11-04): `audit:stardew-test-shape` reported `mixed_unstated` for
// RefusalLayerNamingTests.cs and ToolPreconditionUniformityTests.cs, and reading the gate said it should
// have accepted them, because both files carried the marker. The reason was the PLACEMENT: the marker
// was the first line of each file, above the `using` directives and the namespace, and `classComments`
// walks up from the class declaration only, stopping at the first line that is neither `//` nor an
// attribute - so `{` of the namespace was where the walk ended and the marker was never in the block it
// read. The gate was right; the files were wrong; and nothing here noticed either way, because this
// suite did not exist.
//
// That is the shape this file pins: the marker is read from the comment block ATTACHED TO THE CLASS,
// anchored at the start of the comment line. Both halves are asserted below, each on a fixture that
// differs from the passing one in one respect, so a future simplification - scanning the whole file,
// accepting a blank line, or matching the marker anywhere in a comment - reddens a case here instead of
// silently passing every mixed file forever.
//
// `auditStardewTestShape({ directory })` takes the directory, so no case writes into the real tree.
//
// red-proof: history  the marker at the top of the file (where 92573d3c~1 put it, above `using`) ->
//                    `mixed_unstated` for both files; moved above the class, the same sources pass.
//                    Fixtures for each placement live in tools/audit-stardew-test-shape.test.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { MIXED_MARKER, auditStardewTestShape } from "./audit-stardew-test-shape.mjs";

/** The two files whose marker placement this suite was written for, in the real population. */
const REAL_FILES = ["RefusalLayerNamingTests.cs", "ToolPreconditionUniformityTests.cs"];

/** Enough of a why, by the gate's own 80-character bar. */
const WHY =
  "the pin keeps the Mod's refusal vocabulary closed while the behaviour test drives real tiles, so one of them guards invention and the other guards lying";

/** One pin: reads a repository file and asserts on its text. */
const PIN = `
    [Fact]
    public void PinsTheModRefusalText()
    {
        var text = File.ReadAllText(Path.Combine(RepositoryRoot, "ModEntry.cs"));
        text.Should().Contain("no_native_path");
    }
`;

/** One behaviour test: drives product code, reads no repository file. */
const BEHAVIOUR = `
    [Fact]
    public void NamesTheLayerFromRealTiles()
    {
        var layer = RefusalLayerProbe.Empty(4, 4);
        layer.Should().Be(RefusalLayerKind.Tools);
    }
`;

const CLASS = `public sealed class FixtureTests\n{\n${PIN}${BEHAVIOUR}}\n`;
const USINGS = "using FluentAssertions;\nusing Xunit;\n\nnamespace Fixture;\n\n";

/** A marker line, spelled from the gate's own constant so this suite cannot drift from it. */
const marker = (why, prefix = "") => `${prefix}${MIXED_MARKER} ${why}\n`;

const SOURCES = Object.freeze({
  /** The marker comment attached to the class - the only placement the gate accepts. */
  attached: USINGS + marker(WHY) + CLASS,
  /** Where the two files really put it: the first line of the file, above the `using` directives. */
  aboveUsings: marker(WHY) + USINGS + CLASS,
  /** Attached in spirit, but a blank line between it and the class ends the block the gate reads. */
  blankThenMarker: USINGS + marker(WHY) + "\n" + CLASS,
  /** The marker text inside a comment that does not start with it. */
  insideComment: USINGS + marker(WHY, "// see ") + CLASS,
  /** Attached, but says nothing about why. */
  noWhy: USINGS + marker("both kinds") + CLASS,
  /** No marker anywhere. */
  none: USINGS + CLASS,
});

const workspaces = [];
after(() => {
  for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
});

/** Audit one fixture file in a directory of its own, so no case can see another's marker. */
function audit(relative) {
  const directory = mkdtempSync(path.join(tmpdir(), "stardew-test-shape-"));
  workspaces.push(directory);
  writeFileSync(path.join(directory, "FixtureTests.cs"), SOURCES[relative]);
  return auditStardewTestShape({ directory });
}

const rules = (report) => report.findings.map((finding) => finding.rule);

test("the fixture is mixed: one pin beside one behaviour test", () => {
  const [row] = audit("attached").rows;
  assert.equal(row.kind, "mixed");
  assert.equal(row.pinCount, 1);
  assert.equal(row.testCount, 2);
});

test("a mixed file with no marker is reported as mixed_unstated", () => {
  assert.deepEqual(rules(audit("none")), ["mixed_unstated"]);
});

test("a marker above the using directives is not attached to the class, so the finding stands", () => {
  assert.deepEqual(rules(audit("aboveUsings")), ["mixed_unstated"]);
});

test("a blank line between the marker and the class ends the block, so the finding stands", () => {
  assert.deepEqual(rules(audit("blankThenMarker")), ["mixed_unstated"]);
});

test("the marker must start the comment, not appear inside it", () => {
  assert.deepEqual(rules(audit("insideComment")), ["mixed_unstated"]);
});

test("a marker with less than 80 characters of why is reported, not accepted", () => {
  assert.deepEqual(rules(audit("noWhy")), ["mixed_why_missing"]);
});

test("a marker attached to the class clears the finding", () => {
  assert.deepEqual(rules(audit("attached")), []);
});

test("the two real mixed files attach the marker to their class and produce no finding", () => {
  const report = auditStardewTestShape();
  for (const file of REAL_FILES) {
    const row = report.rows.find((candidate) => candidate.file === file);
    assert.ok(row, `${file} is part of the audited population`);
    assert.equal(row.kind, "mixed", `${file} holds both kinds`);
    assert.ok(
      row.classComments.some((comment) => comment.startsWith(MIXED_MARKER)),
      `${file} carries ${MIXED_MARKER} in the comment block above its class`,
    );
    assert.deepEqual(
      report.findings.filter((finding) => finding.file === file),
      [],
      `${file} produces no finding`,
    );
  }
});
