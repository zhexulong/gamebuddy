import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { corpusFiles, corpusMembers } from "./run-tool-test-corpus.mjs";

// red-proof: inject  a failing assertion into one member's suite in a copy of the tree -> `members_failed:1`,
//                    `corpus_responsible:<that member>` and one `member … · exit 1 · <U+2716> <test>` line, with
//                    `corpus_derivation:ok`; a script renamed out of the `test:`/`suite:` namespace -> a green
//                    member run (`members_failed:0`) beside `corpus_derivation:defect`, so neither reading can
//                    stand in for the other. Both injections are pinned below on synthetic trees.

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "run-tool-test-corpus.mjs");
const roots = [];

const PASSING_SUITE = 'import test from "node:test";\ntest("holds", () => {});\n';
const FAILING_SUITE =
  'import test from "node:test";\ntest("the injected suite breaks", () => {\n  throw new Error("injected");\n});\n';

/**
 * One synthetic checkout: the manifest the corpus is derived from, one suite per path, and whatever else the
 * case needs - the quarantine, and the workflow whose `run:` steps name the scripts another entry point runs.
 */
function makeTree({ scripts, suites = {}, quarantine = [], workflow = [] }) {
  const root = mkdtempSync(join(tmpdir(), "tool-test-corpus-"));
  roots.push(root);
  const files = {
    "package.json": JSON.stringify({ scripts }, null, 2),
    "tools/tool-test-corpus-quarantine.json": JSON.stringify(
      { schema: "gamebuddy-tool-test-corpus-quarantine/v1", exclusions: quarantine },
      null,
      2,
    ),
    ".github/workflows/ci.yml": [...workflow, ""].join("\n"),
    ...suites,
  };
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

/** The aggregate's own run against one tree, which is the reading under test: stdout, stderr, exit status. */
function runAggregate(root) {
  const run = spawnSync(process.execPath, [RUNNER, "--root", root], { encoding: "utf8", timeout: 120_000 });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const lines = (text) => text.split("\n").filter((line) => line !== "");

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a member is one package.json script, however many suites it runs", () => {
  const root = makeTree({
    scripts: {
      "test:one": "node --test tools/one.test.mjs",
      "suite:pair": "node --test tools/two.test.mjs tools/three.test.mjs",
      "check:not-a-test": "node tools/check-something.mjs",
    },
    suites: {
      "tools/one.test.mjs": PASSING_SUITE,
      "tools/two.test.mjs": PASSING_SUITE,
      "tools/three.test.mjs": PASSING_SUITE,
    },
  });
  const { members, notTaken } = corpusMembers({ root });
  assert.deepEqual(
    members.map((member) => member.name),
    ["test:one", "suite:pair"],
  );
  assert.deepEqual(members[1].files, ["tools/two.test.mjs", "tools/three.test.mjs"]);
  assert.deepEqual(corpusFiles({ root }), ["tools/one.test.mjs", "tools/three.test.mjs", "tools/two.test.mjs"]);
  assert.deepEqual(notTaken, []);
});

test("a red member fails the step and is named once, with the derivation still ok", () => {
  const root = makeTree({
    scripts: {
      "test:held": "node --test tools/held.test.mjs",
      "test:broken": "node --test tools/broken.test.mjs",
    },
    suites: { "tools/held.test.mjs": PASSING_SUITE, "tools/broken.test.mjs": FAILING_SUITE },
  });
  const run = runAggregate(root);
  assert.equal(run.status, 1);
  assert.match(
    run.stdout,
    /^corpus_population:2 members \(2 suite files\) elsewhere:0 package:0 untaken:0 quarantined:0 run:2$/m,
  );
  assert.match(run.stdout, /^corpus_derivation:ok$/m);
  assert.match(run.stdout, /^members_failed:1$/m);
  assert.match(run.stdout, /^corpus_responsible:test:broken$/m);
  const details = lines(run.stdout).filter((line) => line.startsWith("  member test:broken · "));
  assert.equal(details.length, 1, "the responsible member is named once, not once per failing test");
  assert.match(details[0], /exit 1 · \u2716 the injected suite breaks$/);
  assert.doesNotMatch(run.stdout, /corpus_derivation:defect/);
});

test("a script renamed out of test:/suite: is a derivation defect, not a silent exclusion", () => {
  const root = makeTree({
    scripts: {
      "test:held": "node --test tools/held.test.mjs",
      "held-suite": "node --test tools/renamed.test.mjs",
    },
    suites: { "tools/held.test.mjs": PASSING_SUITE, "tools/renamed.test.mjs": PASSING_SUITE },
  });
  const run = runAggregate(root);
  assert.equal(run.status, 1, "a suite the corpus no longer takes must not leave a green step");
  assert.match(run.stdout, /^corpus_population:1 members \(1 suite files\)/m);
  assert.match(run.stdout, /^corpus_derivation:defect:1 script\(s\) the corpus does not take$/m);
  assert.match(
    run.stdout,
    /^ {2}untaken held-suite: it runs a `tools\/` suite but is not a `test:`\/`suite:` script \(node --test tools\/renamed\.test\.mjs\)$/m,
  );
  assert.match(run.stdout, /^members_failed:0$/m);
});

test("a corpus with no members is a defect, never a pass", () => {
  const root = makeTree({ scripts: { "test:aggregate": "node tools/run-tool-test-corpus.mjs" } });
  const run = runAggregate(root);
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^corpus_population:0 members \(0 suite files\)/m);
  assert.match(run.stdout, /^corpus_derivation:defect:2 script\(s\) the corpus does not take$/m);
  assert.match(run.stdout, /no members: no `test:`\/`suite:` script in package\.json runs/);
  assert.match(run.stdout, /untaken test:aggregate: its command runs no `node --test` suite this step can take/);
});

test("a suite another entry point runs is not a member", () => {
  const root = makeTree({
    scripts: {
      "test:held": "node --test tools/held.test.mjs",
      "test:already-run": "node --test tools/already-run.test.mjs",
    },
    suites: { "tools/held.test.mjs": PASSING_SUITE, "tools/already-run.test.mjs": PASSING_SUITE },
    workflow: ["jobs:", "  quality:", "    steps:", "      - run: pnpm test:already-run"],
  });
  const { members, notTaken } = corpusMembers({ root });
  assert.deepEqual(
    members.map((member) => member.name),
    ["test:held"],
  );
  assert.deepEqual(notTaken, []);
});

test("five member details are printed and the rest are counted", () => {
  const scripts = {};
  const suites = {};
  for (let index = 0; index < 7; index += 1) {
    scripts[`test:broken-${index}`] = `node --test tools/broken-${index}.test.mjs`;
    suites[`tools/broken-${index}.test.mjs`] = FAILING_SUITE;
  }
  const run = runAggregate(makeTree({ scripts, suites }));
  assert.equal(run.status, 1);
  assert.match(run.stdout, /^members_failed:7$/m);
  assert.match(run.stdout, /^corpus_responsible:(test:broken-\d,){6}test:broken-\d$/m);
  assert.equal(lines(run.stdout).filter((line) => line.startsWith("  member ")).length, 5);
  assert.match(run.stdout, /^ {2}… and 2 more members failed, run them individually$/m);
});

test("a quarantined suite that is still red holds, and one that passes now fails the step", () => {
  const stillRed = makeTree({
    scripts: {
      "test:held": "node --test tools/held.test.mjs",
      "test:quarantined": "node --test tools/quarantined.test.mjs",
    },
    suites: { "tools/held.test.mjs": PASSING_SUITE, "tools/quarantined.test.mjs": FAILING_SUITE },
    quarantine: [{ file: "tools/quarantined.test.mjs", owner: "a lane", reason: "injected for this case" }],
  });
  const held = runAggregate(stillRed);
  assert.equal(held.status, 0);
  assert.match(held.stdout, /quarantined:1 run:1$/m);
  assert.match(held.stdout, /^members_failed:0$/m);

  const goneGreen = makeTree({
    scripts: {
      "test:held": "node --test tools/held.test.mjs",
      "test:quarantined": "node --test tools/quarantined.test.mjs",
    },
    suites: { "tools/held.test.mjs": PASSING_SUITE, "tools/quarantined.test.mjs": PASSING_SUITE },
    quarantine: [{ file: "tools/quarantined.test.mjs", owner: "a lane", reason: "injected for this case" }],
  });
  const green = runAggregate(goneGreen);
  assert.equal(green.status, 1, "an exclusion outliving its defect must fail the step");
  assert.match(green.stderr, /tool_test_corpus_quarantine_stale:tools\/quarantined\.test\.mjs/);
  assert.match(green.stdout, /^members_failed:0$/m);
});

test("a quarantined file leaves its member's run, it does not remove the member", () => {
  const root = makeTree({
    scripts: { "suite:pair": "node --test tools/held.test.mjs tools/quarantined.test.mjs" },
    suites: { "tools/held.test.mjs": PASSING_SUITE, "tools/quarantined.test.mjs": FAILING_SUITE },
    quarantine: [{ file: "tools/quarantined.test.mjs", owner: "a lane", reason: "injected for this case" }],
  });
  const run = runAggregate(root);
  assert.equal(run.status, 0);
  assert.match(
    run.stdout,
    /^corpus_population:1 members \(2 suite files\) elsewhere:0 package:0 untaken:0 quarantined:1 run:1$/m,
  );
  assert.match(run.stdout, /^members_failed:0$/m);
});

test("a quarantine entry naming no corpus file fails the step", () => {
  const root = makeTree({
    scripts: { "test:held": "node --test tools/held.test.mjs" },
    suites: { "tools/held.test.mjs": PASSING_SUITE },
    quarantine: [{ file: "tools/gone.test.mjs", owner: "a lane", reason: "injected for this case" }],
  });
  const run = runAggregate(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /tool_test_corpus_quarantine_unknown_file:tools\/gone\.test\.mjs/);
});
