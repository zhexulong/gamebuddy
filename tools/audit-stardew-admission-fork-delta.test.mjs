import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The worklist for converging the forked admission sites has to be MEASURED, not remembered: a hand-kept list
 * under-reported one of the two spellings as zero, which is why this pins both the count and the shape.
 */
const REPO = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/\/$/, "");

function measure(args = []) {
  const out = execFileSync(process.execPath, ["tools/audit-stardew-admission-fork-delta.mjs", "--json", ...args], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return JSON.parse(out);
}

test("the forked admission worklist is measured, with both spellings", () => {
  const report = measure();
  assert.equal(report.artifactKind, "stardew_admission_fork_delta");
  // 21 sites write the triple verbatim, 1 spells it with `actor.CanMove`, and 2 write the same three facts as
  // three separate guards with their own reason codes. An earlier version of the detector missed the split
  // spelling entirely and reported 0 for it.
  assert.equal(report.siteCount, 24);
  assert.equal(report.exactTripleCount, 21);
  assert.equal(report.splitSpellingCount, 2);
  assert.equal(report.sites.filter((site) => site.spelling === "actor.CanMove variant").length, 1);
});

test("every site names the handler method that has to move", () => {
  const report = measure();
  for (const site of report.sites) {
    assert.match(site.file, /^farmhandexecutioncontroller\..*\.cs$/);
    assert.ok(Number.isSafeInteger(site.line) && site.line > 0);
    // The method name is what an implementer acts on, so "(unknown)" would make the list useless.
    assert.ok(site.method.startsWith("public ") || site.method.startsWith("private "), `unnamed site: ${JSON.stringify(site)}`);
  }
});

test("the delta states are cited to the facts that produce them", () => {
  const report = measure();
  assert.ok(report.newlyRefusedStates.length >= 8, "the authority requires more than the triple tests");
  for (const state of report.newlyRefusedStates) {
    assert.ok(state.state.length > 0);
    // A state with no fact behind it would be an assertion rather than a measurement.
    assert.ok(state.fact.length > 0, `uncited state: ${JSON.stringify(state)}`);
    assert.equal(state.reachable, true);
  }
  // Every converging site is affected by all of them: they all test the same triple.
  for (const site of report.sites) {
    assert.equal(site.newlyRefused.length, report.newlyRefusedStates.length);
    assert.equal(site.sharedAdmissionAlsoRequires, "disposition == Idle");
  }
});

test("a source root that is not there is an error, not an empty worklist", () => {
  // "I could not look" and "there is nothing" must not be confused: the second reads as a clean worklist.
  assert.throws(
    () => measure(["--source-root", "docs"]),
    /stardew_source_root_missing/,
  );
});

test("a tree with no Mod sources reports zero rather than a default list", () => {
  // An existing directory that simply has no farmhandexecutioncontroller*.cs files IS an empty worklist.
  const empty = mkdtempSync(join(tmpdir(), "fork-delta-"));
  mkdirSync(join(empty, "integrations", "stardew"), { recursive: true });
  try {
    const report = measure(["--source-root", empty]);
    assert.equal(report.siteCount, 0);
    assert.deepEqual(report.sites, []);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the tool states what it does not guarantee", () => {
  const report = measure();
  assert.ok(report.nonGuarantees.length >= 3);
  // The decision this measurement exists for must travel WITH it, not live only in a conversation.
  assert.match(report.decisionQuestion, /refuse these actions uniformly/);
});
