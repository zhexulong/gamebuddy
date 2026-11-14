/**
 * The replay tool's own reading: the invocation it takes from the repository, the three zeroes it keeps
 * apart, and the ablation it exists to make re-runnable.
 *
 * The two end-to-end cases are the tree's own history, replayed the way a reviewer would replay them:
 * `tools/check-spec-waiver-comments.mjs` on the commit before its fix and on the fix, and
 * `dialogue-web/tests/selector-producer-gate.test.mjs` on the drawer conversion that deleted the two
 * selector spellings its assertions still read. A checkout without that history (a shallow clone, an
 * archive) skips them with the reason named, rather than passing on an empty population.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  readReportVerdict,
  readTestRunVerdict,
  registeredInvocations,
  specifiersOf,
} from "./replay-gate-on-history.mjs";

// red-proof: history  the waiver gate replayed on `930a031e^` reads `fired findings=4`, on `930a031e`
//            `did-not-fire findings=0 population=1626`, and expecting `did-not-fire@930a031e^` fails the run
//            (tools/replay-gate-on-history.test.mjs)

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TOOL = join(REPOSITORY_ROOT, "tools", "replay-gate-on-history.mjs");
const TEMP_PREFIX = "gamebuddy-gate-replay-";

function childEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

function replay(arguments_) {
  const result = spawnSync(process.execPath, [TOOL, ...arguments_], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    timeout: 300_000,
    env: childEnvironment(),
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function revExists(spec) {
  const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${spec}^{commit}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  });
  return result.status === 0;
}

const HISTORY = ["930a031e^", "930a031e", "294d22ab^", "294d22ab"].map(revExists);
const HISTORY_ABSENT = HISTORY.includes(false)
  ? { skip: "history absent: a shallow clone or an archive of this tree" }
  : {};

/** Real TAP from the real runner: the reading is tested against what node prints, not a hand-written sample. */
function tapOf(name, source) {
  const root = mkdtempSync(join(tmpdir(), "replay-tap-"));
  try {
    writeFileSync(join(root, name), source);
    const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", name], {
      cwd: root,
      encoding: "utf8",
      env: childEnvironment(),
    });
    return { exitCode: run.status, stdout: run.stdout, stderr: run.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the registered invocation is the one the repository runs, narrowed to the gate alone", () => {
  const [waiver] = registeredInvocations("tools/check-spec-waiver-comments.mjs");
  assert.equal(waiver.script, "check:spec-waiver-comments");
  assert.equal(waiver.packageFile, "package.json");
  assert.deepEqual(waiver.argv, ["node", "tools/check-spec-waiver-comments.mjs"]);

  const [selector] = registeredInvocations("dialogue-web/tests/selector-producer-gate.test.mjs");
  assert.equal(selector.script, "test:static");
  assert.equal(selector.packageFile, "dialogue-web/package.json");
  assert.equal(selector.packageDir, "dialogue-web");
  assert.deepEqual(
    selector.argv,
    ["node", "--test", "--test-reporter=tap", "--import", "tsx", "tests/selector-producer-gate.test.mjs"],
    "the flags the registration carries stay, the other 40 suite files do not, and the reporter is the only addition",
  );
});

test("a gate no script names has no invocation, so there is nothing to run", () => {
  assert.deepEqual(registeredInvocations("dialogue-web/tests/surface-navigation.spec.ts"), []);
});

test("a specifier is read from an import statement, not from prose or a block comment", () => {
  const source = [
    '// a gate that writes `from "not-a-module"` in prose names nothing',
    '/* import plain from "also-not-a-module"; */',
    // A one-line statement that mentions a module in its text is not an import either: the quotes here
    // belong to the words being searched for, which is how a gate is written.
    "export const HINT = 'the shape is import x from \"string-in-a-string\"';",
    'import assert from "node:assert/strict";',
    "import {",
    "  multi,",
    '} from "./lib/multi-line.mjs";',
    'import { extensionless } from "./viewport-policy";',
  ].join("\n");
  assert.deepEqual(
    specifiersOf(source).sort(),
    ["./lib/multi-line.mjs", "./viewport-policy", "node:assert/strict"].sort(),
  );
});

test("the three zeroes stay apart: findings, an empty population, and a report the reader cannot read", () => {
  const fired = readReportVerdict({
    exitCode: 1,
    stdout: "spec_waiver files=115 examined=1613 held=0 findings=4\n",
    stderr: "",
  });
  assert.equal(fired.verdict, "fired");
  assert.equal(fired.findings, 4);
  assert.equal(fired.population, 1613);

  const clean = readReportVerdict({
    exitCode: 0,
    stdout: "spec_waiver files=117 examined=1639 held=0 findings=0\n",
    stderr: "",
  });
  assert.equal(clean.verdict, "did-not-fire");
  assert.equal(clean.population, 1639);

  const empty = readReportVerdict({ exitCode: 0, stdout: "findings=0 examined=0\n", stderr: "" });
  assert.equal(empty.verdict, "not_measured");
  assert.equal(empty.reason, "population_empty");

  const unstated = readReportVerdict({ exitCode: 0, stdout: "findings=0\n", stderr: "" });
  assert.equal(unstated.verdict, "not_measured");
  assert.equal(unstated.reason, "population_unstated");

  const unreadable = readReportVerdict({
    exitCode: 1,
    stdout: "silent_failure: 2 undeclared · sites examined 23\n",
    stderr: "",
  });
  assert.equal(unreadable.verdict, "not_measured", "findings that are not stated as a count are not a reading");
  assert.equal(unreadable.reason, "findings_unreadable");
  assert.deepEqual(unreadable.details, ["silent_failure: 2 undeclared · sites examined 23"]);
});

test("a run whose report disagrees with its exit code is not a reading", () => {
  const disagreed = readReportVerdict({ exitCode: 0, stdout: "findings=2 examined=10\n", stderr: "" });
  assert.equal(disagreed.verdict, "not_measured");
  assert.equal(disagreed.reason, "exit_code_disagrees");

  const failed = readReportVerdict({
    exitCode: 2,
    stdout: "findings=0 examined=10\n",
    stderr: "blocked: no decoder root\n",
  });
  assert.equal(failed.verdict, "not_measured");
  assert.equal(failed.reason, "run_failed:exit 2");

  const absent = readReportVerdict({
    exitCode: 1,
    stdout: "",
    stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module 'typescript'\n",
  });
  assert.equal(absent.verdict, "not_measured");
  assert.equal(absent.reason, "dependencies_absent:typescript");
});

test("a test run's assertion failure is a finding, and a loader error is not", () => {
  const failing = readTestRunVerdict(
    tapOf(
      "gate.test.mjs",
      [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'test("names nothing writes", () => {',
        '  assert.deepEqual(["attr `aria-modal` is dead", "class `composed-drawer-backdrop` is dead"], []);',
        "});",
      ].join("\n"),
    ),
  );
  assert.equal(failing.verdict, "fired");
  assert.equal(failing.findings, 2);
  assert.deepEqual(failing.details, ["attr `aria-modal` is dead", "class `composed-drawer-backdrop` is dead"]);

  const passing = readTestRunVerdict(
    tapOf(
      "clean.test.mjs",
      ['import test from "node:test";', 'test("a name the product writes", () => {});'].join("\n"),
    ),
  );
  assert.equal(passing.verdict, "did-not-fire");
  assert.equal(passing.population, 1);

  const loader = readTestRunVerdict(tapOf("loader.test.mjs", 'import missing from "not-installed-anywhere";\n'));
  assert.equal(loader.verdict, "not_measured", "a gate that could not load is not a gate that passed");
  assert.equal(loader.reason, "dependencies_absent:not-installed-anywhere");
});

test("the waiver gate fires on the commit before its fix and not on the fix", HISTORY_ABSENT, () => {
  const held = replay([
    "--gate",
    "tools/check-spec-waiver-comments.mjs",
    "--rev-range",
    "930a031e^..930a031e",
    "--expect",
    "fired@930a031e^",
    "--expect",
    "did-not-fire@930a031e",
  ]);
  assert.equal(held.status, 0, held.output);
  assert.match(held.output, /expectation fired@\w+\s+actual=fired\s+held/u);
  assert.match(held.output, /expectation did-not-fire@\w+\s+actual=did-not-fire\s+held/u);
  assert.match(held.output, /2 expectation\(s\): 2 held, 0 violated/u);
});

test("an expectation that is false fails the replay, so the ablation has teeth", HISTORY_ABSENT, () => {
  const violated = replay([
    "--gate",
    "tools/check-spec-waiver-comments.mjs",
    "--at",
    "930a031e^",
    "--expect",
    "did-not-fire@930a031e^",
  ]);
  assert.equal(violated.status, 1, violated.output);
  assert.match(violated.output, /actual=fired\s+VIOLATED/u);
  assert.match(violated.output, /0 held, 1 violated/u);
});

test("the selector gate names the two spellings the drawer conversion deleted", HISTORY_ABSENT, () => {
  const replayed = replay([
    "--gate",
    "dialogue-web/tests/selector-producer-gate.test.mjs",
    "--at",
    "294d22ab^",
    "--at",
    "294d22ab",
  ]);
  assert.equal(replayed.status, 0, replayed.output);
  const [before, after] = replayed.output.split("== ").slice(1);
  assert.match(before, /verdict: fired  findings=6/u);
  assert.match(after, /verdict: fired  findings=8/u);
  assert.doesNotMatch(before, /aria-modal/u);
  assert.match(after, /attr `aria-modal` is asserted absent/u);
  assert.match(after, /class `composed-drawer-backdrop` is asserted absent/u);
});

test(
  "a replay leaves the worktree's installed packages and the temp directory as it found them",
  HISTORY_ABSENT,
  () => {
    const before = readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)).length;
    const replayed = replay(["--gate", "dialogue-web/tests/selector-producer-gate.test.mjs", "--at", "294d22ab"]);
    assert.equal(replayed.status, 0, replayed.output);
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith(TEMP_PREFIX)).length;
    assert.equal(after, before, "the archive tree is removed once its verdict is read");
    assert.ok(
      existsSync(join(REPOSITORY_ROOT, "dialogue-web", "node_modules", "typescript", "package.json")),
      "a linked package is a link to the worktree's copy, never a move of it",
    );
  },
);

test("the command line refuses what it cannot measure honestly", () => {
  const unregistered = replay(["--gate", "dialogue-web/tests/surface-navigation.spec.ts", "--at", "294d22ab"]);
  assert.equal(unregistered.status, 1, unregistered.output);
  assert.match(unregistered.output, /reason=gate_unregistered/u);
  assert.match(unregistered.output, /run: not run/u);

  const bothWays = replay([
    "--gate",
    "tools/check-spec-waiver-comments.mjs",
    "--at",
    "930a031e",
    "--rev-range",
    "930a031e^..930a031e",
  ]);
  assert.equal(bothWays.status, 2, bothWays.output);
  assert.match(bothWays.output, /--at and --rev-range are two ways to say the same thing/u);

  const twoGates = replay([
    "--gate",
    "tools/check-spec-waiver-comments.mjs",
    "--gate",
    "tools/check-spec-waiver-comments.test.mjs",
    "--at",
    "930a031e",
    "--expect",
    "did-not-fire@930a031e",
  ]);
  assert.equal(twoGates.status, 2, twoGates.output);
  assert.match(twoGates.output, /--expect needs one --gate/u);
});
