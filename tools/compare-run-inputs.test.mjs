// Two runs are comparable only when a section that moved is named, with the line that moved.
//
// The comparison is the whole point of `input-manifest.json`: "she chose X" is not a finding until the input she was
// given has been read for the difference. These tests drive the differ with manifests written by hand, so a broken
// differ cannot hide behind a builder that agrees with it.
//
// red-proof: inject  the second manifest's text read as the first's in `compareSection`, so a rewritten line and a
//   section only the second run delivered are both reported unchanged -> `✖ one changed tool description line is
//   printed under that tool's name` (0 !== 1), 2 of 14 cases red
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { compareInputManifests, renderComparison, resolveManifestPath } from "./compare-run-inputs.mjs";

const TOOL = "node tools/compare-run-inputs.mjs";

function manifest(sections, extra = {}) {
  return { schema: "gamebuddy-run-input-manifest/v1", session: "session.jsonl", sections, problems: [], ...extra };
}

function withRoot(run) {
  const root = mkdtempSync(join(tmpdir(), "compare-run-inputs-"));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("two identical inputs compare as unchanged, and the summary says changed 0", () => {
  const sections = [
    { id: "prompt:floor", text: "You are 琥珀.\nNever explain how you work." },
    { id: "tool:stardew_plan_work", text: "Write one script.\nworld_lifecycle: sleep" },
  ];
  const report = compareInputManifests(manifest(sections), manifest(sections.map((s) => ({ ...s }))));

  assert.equal(report.changed, 0);
  assert.equal(report.compared, 2);
  for (const row of report.rows) {
    assert.deepEqual(
      { id: row.id, changed: row.changed, added: row.added, removed: row.removed },
      {
        id: row.id,
        changed: 0,
        added: 0,
        removed: 0,
      },
    );
  }
  assert.match(renderComparison(report).at(-1), /^sections compared 2 · changed 0$/u);
});

/**
 * FALSIFIER: one line inside one tool's description changes, and the reading must name that tool and print the line.
 * The mutated manifest is the only difference between the two sides, so a differ that reported nothing would be caught
 * here rather than by a live run.
 */
test("one changed tool description line is printed under that tool's name", () => {
  const before = [
    { id: "prompt:floor", text: "You are 琥珀." },
    {
      id: "tool:stardew_plan_work",
      text: "Write one script.\nworld_lifecycle: sleep\nfarming_crops: till_soil, water_crop",
    },
  ];
  const after = [
    { id: "prompt:floor", text: "You are 琥珀." },
    {
      id: "tool:stardew_plan_work",
      text: "Write one script.\nworld_lifecycle: sleep\nfarming_crops: till_soil({x,y}), water_crop({x,y})",
    },
  ];
  const report = compareInputManifests(manifest(before), manifest(after));
  const row = report.rows.find((entry) => entry.id === "tool:stardew_plan_work");

  assert.equal(row.changed, 1);
  assert.equal(row.unchanged, 2);
  assert.deepEqual(row.detail, [
    {
      kind: "changed",
      id: "tool:stardew_plan_work",
      was: "farming_crops: till_soil, water_crop",
      now: "farming_crops: till_soil({x,y}), water_crop({x,y})",
    },
  ]);
  assert.equal(report.changed, 1);

  const printed = renderComparison(report);
  const detail = printed.findIndex((line) => line.includes("farming_crops: till_soil({x,y}), water_crop({x,y})"));
  assert.ok(detail > printed.findIndex((line) => line.includes("tool:stardew_plan_work")), printed.join("\n"));
  assert.ok(
    printed.some((line) => line.includes("farming_crops: till_soil, water_crop")),
    "the line that was replaced has to be printed too, or the reader cannot tell what moved",
  );
});

test("a section delivered by one run only is named as such and counts as a change", () => {
  const before = [{ id: "prompt:floor", text: "You are 琥珀." }];
  const after = [
    { id: "prompt:floor", text: "You are 琥珀." },
    { id: "tool:stardew_action_program_status", text: "poll one program" },
  ];
  const report = compareInputManifests(manifest(before), manifest(after));

  assert.equal(report.changed, 1);
  const row = report.rows.find((entry) => entry.id === "tool:stardew_action_program_status");
  assert.equal(row.onlyIn, "b");
  assert.deepEqual(row.detail, [{ kind: "added", id: "tool:stardew_action_program_status", now: "poll one program" }]);
  assert.ok(renderComparison(report).some((line) => line.includes("only in b")));
});

test("a run is found from its label, its result path, its directory, or its manifest path", () => {
  withRoot((root) => {
    const tools = join(root, "tools");
    mkdirSync(tools, { recursive: true });
    const manifestPath = join(tools, "_multiday_routine-round54.input-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest([])), "utf8");

    const expected = { path: manifestPath, reason: null };
    assert.deepEqual(resolveManifestPath("round54", { repositoryRoot: root }), expected);
    assert.deepEqual(resolveManifestPath(join(tools, "_multiday_routine-round54.result.json")), expected);
    assert.deepEqual(resolveManifestPath(tools), { path: join(tools, "input-manifest.json"), reason: null });
    // A copy under a scratch name is the input a run was given, not a label.
    assert.deepEqual(resolveManifestPath(manifestPath), expected);
    assert.equal(resolveManifestPath("round99", { repositoryRoot: root }).path, null);
  });
});

/**
 * The code a reader must not be able to mistake for "no differences": a missing manifest exits 2 and names the run it
 * could not measure, on stderr, with nothing on stdout that reads as a comparison.
 */
test("a missing manifest exits 2 and names the run, never 'no differences'", () => {
  withRoot((root) => {
    const present = join(root, "a.input-manifest.json");
    const absent = join(root, "b.input-manifest.json");
    writeFileSync(present, JSON.stringify(manifest([{ id: "prompt:floor", text: "You are 琥珀." }])), "utf8");

    const child = spawnSync(process.execPath, ["tools/compare-run-inputs.mjs", present, absent], {
      cwd: join(import.meta.dirname, ".."),
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(child.status, 2, `${TOOL}: ${child.stdout}${child.stderr}`);
    assert.match(child.stderr, /input_manifest_not_measured:/u);
    assert.equal(child.stdout.includes("sections compared"), false);
  });
});
