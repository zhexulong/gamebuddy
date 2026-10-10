import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

/**
 * The worklist for converging the forked admission sites has to be MEASURED, not remembered: a hand-kept list
 * under-reported one of the two spellings as zero, which is why this pins both the count and the shape.
 *
 * The real tree now reports ZERO - the convergence wave finished - so the detection itself is pinned on a
 * SYNTHETIC tree instead. Asserting only "the real tree has no forks" would leave the detector untested and the
 * suite vacuous: a detector that always returns zero would pass it.
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

/** A source root holding one file with all three forked spellings. */
function withSyntheticForks(run) {
  const root = mkdtempSync(join(tmpdir(), "fork-delta-"));
  const dir = join(root, "integrations", "stardew");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "farmhandexecutioncontroller.synthetic.cs"),
    [
      "internal sealed partial class ExecutionManager",
      "{",
      "    public void ExactTriple(string requestId, long requestedDeadlineMs, long nowMs)",
      "    {",
      "        if (Game1.activeClickableMenu is not null || Game1.eventUp || !Game1.player.CanMove)",
      "            return;",
      "    }",
      "",
      "    public void ActorVariant(string requestId, long requestedDeadlineMs, long nowMs)",
      "    {",
      "        if (Game1.activeClickableMenu is not null || Game1.eventUp || !actor.CanMove)",
      "            return;",
      "    }",
      "",
      "    public void SplitSpelling(string requestId, long requestedDeadlineMs, long nowMs)",
      "    {",
      "        if (Game1.activeClickableMenu is not null)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_menu_open", null);',
      "        if (Game1.eventUp)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_event_active", null);',
      "        if (!Game1.player.CanMove)",
      '            return this.RememberTerminal(requestId, executionId, ExecutionState.Rejected, "player_cannot_move", null);',
      "    }",
      "}",
      "",
    ].join("\n"),
  );
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the converged tree has no forked admission sites left", () => {
  const report = measure();
  assert.equal(report.artifactKind, "stardew_admission_fork_delta");
  // The wave is finished. This number is expected to be 0 and stay 0: a new fork is what it catches.
  assert.equal(report.siteCount, 0);
  assert.equal(report.exactTripleCount, 0);
  assert.equal(report.splitSpellingCount, 0);
  assert.deepEqual(report.sites, []);
});

test("the detector still finds a fork in all three spellings, and names the handler", () => {
  withSyntheticForks((root) => {
    const report = measure(["--source-root", root]);
    assert.equal(report.siteCount, 3, "two triple spellings plus the split one");
    // `exactTripleCount` counts ONLY the verbatim spelling; the `actor.CanMove` variant is reported as its own
    // spelling, which is why the three numbers sum to the site count rather than overlapping.
    assert.equal(report.exactTripleCount, 1);
    assert.equal(report.splitSpellingCount, 1);
    assert.equal(report.sites.filter((site) => site.spelling === "actor.CanMove variant").length, 1);
    // The method name is what an implementer acts on, so "(unknown)" would make the list useless.
    for (const site of report.sites) {
      assert.match(site.file, /^farmhandexecutioncontroller\..*\.cs$/);
      assert.ok(Number.isSafeInteger(site.line) && site.line > 0);
      assert.ok(
        site.method.startsWith("public ") || site.method.startsWith("private "),
        `unnamed site: ${JSON.stringify(site)}`,
      );
    }
    const spellings = report.sites.map((site) => site.spelling).sort();
    assert.deepEqual(spellings, [
      "actor.CanMove variant",
      "exact triple",
      "three separate guards (player_menu_open / player_event_active / player_cannot_move)",
    ]);
  });
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
  withSyntheticForks((root) => {
    const synthetic = measure(["--source-root", root]);
    for (const site of synthetic.sites) {
      assert.equal(site.newlyRefused.length, report.newlyRefusedStates.length);
      assert.equal(site.sharedAdmissionAlsoRequires, "disposition == Idle");
    }
  });
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
