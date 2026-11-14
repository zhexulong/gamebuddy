/**
 * The falsifier suite for `tools/check-baseline-paths.mjs`: does every file a baseline names still exist?
 *
 * The gate exists because one retirement commit left three baselines naming six deleted runners, two of those baselines
 * noticed by themselves and the third silent - `tools/prelive-l3-baseline.json` is red at HEAD for `shake-tree` and
 * `take-pedestal-item` and nothing says why. So this suite has to prove the gate on the real history, on a fabricated
 * path, on the index-versus-worktree boundary, and on a population of nothing; a suite that only asserted the rule over
 * a synthetic baseline would pass while the real tree stayed red.
 *
 * `git init` in a temporary directory is the fixture, not a mock: the question is precisely "what does the index carry",
 * so the double for the index would be the thing under test.
 *
 * One copied constant, and it expires: `RETIRED_RUNNERS` is the debt today's tree carries. When
 * `tools/prelive-l3-baseline.json` drops its two entries, this suite's real-tree assertion becomes `[]` and the
 * population checks above it carry the verdict - the constant is a record of a defect with an owner, not a licence.
 *
 * No `t.skip()` here on purpose: a suite whose file mentions `.skip(` is `gate_skip_can_pass` in
 * `tools/check-gate-populations.mjs`, and a suite that can skip every test is a suite that can go green having measured
 * nothing. The history replay below therefore states its own not-measured reading in an assertion instead.
 *
 * red-proof: history  the index and the baselines at `b6128a58`, the commit that retired six runners ->
 *   `baseline_names_a_file_that_does_not_exist:tools/prelive-l3-baseline.json:...shake-tree...` and `...take-pedestal...`
 * red-proof: inject  a fabricated path added to a baseline in a fixture repository ->
 *   `baseline_names_a_file_that_does_not_exist:<baseline>:tools/fabricated-missing.mjs`, exactly one finding
 * red-proof: inject  a file written to the fixture's working tree and not added -> still one finding; `git add` -> green
 * red-proof: inject  a root whose only tracked json is not a baseline -> `baseline_gate_no_population`, exit 2
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  baselinePopulation,
  checkBaselinePaths,
  isPathReference,
  pathReferences,
  readIndex,
  renderBaselinePathsReport,
  resolves,
  runBaselinePathsGate,
} from "./check-baseline-paths.mjs";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const GATE = resolve(import.meta.dirname, "check-baseline-paths.mjs");

/** The two runner names `b6128a58` retired while `tools/prelive-l3-baseline.json` still recorded them. */
const RETIRED = "tools/prelive-l3-baseline.json";
const RETIRED_RUNNERS = Object.freeze([
  "run-stardew-native-local-player-shake-tree-smoke.mjs",
  "run-stardew-native-local-player-take-pedestal-item-smoke.mjs",
]);
const RETIRED_FINDINGS = RETIRED_RUNNERS.map(
  (runner) => `baseline_names_a_file_that_does_not_exist:${RETIRED}:${runner}`,
);

function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * A git repository holding `files`, with `baseline` written to `tools/probe-baseline.json`; `add` decides which of them
 * the index carries. Everything runs the real gate over the real `git ls-files`, so "in the index" is never simulated.
 */
function fixture({ files = [], baseline, add = true }) {
  const root = mkdtempSync(join(tmpdir(), "baseline-paths-"));
  git(root, "init", "-q");
  mkdirSync(join(root, "tools"), { recursive: true });
  writeFileSync(join(root, "tools/probe-baseline.json"), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  for (const file of files) {
    mkdirSync(resolve(root, file, ".."), { recursive: true });
    writeFileSync(resolve(root, file), "\n", "utf8");
  }
  if (add) git(root, "add", "-A");
  return root;
}

function withFixture(options, run) {
  const root = fixture(options);
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The gate's own command line, so the verdict, the census line and the exit code are the ones an operator sees. */
function runGate(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8", windowsHide: true });
  return { status: result.status, stdout: result.stdout, lines: result.stdout.trimEnd().split("\n") };
}

const members = (entries) => ({ entries: entries.map((file) => ({ file })) });

test("the real tree: the population is the index's baselines and no finding names a tracked path", () => {
  const report = runBaselinePathsGate({ root: REPOSITORY_ROOT });
  assert.equal(report.blocked, null, `${report.blocked}: ${report.detail}`);
  assert.ok(report.examined > 0, "a population of nothing would agree with every claim below");
  assert.ok(report.references > 0, "no reference read means the rule matched nothing");

  // Every baseline it judged is a baseline-named json git tracks under tools/ - read here through a second invocation
  // (`git ls-files -- tools`, not the whole-index read the gate makes) so a population that shrank is red.
  const tracked = git(REPOSITORY_ROOT, "ls-files", "-z", "--", "tools")
    .split("\0")
    .filter(Boolean)
    .filter((file) => file.endsWith(".json"))
    .filter((file) => file.slice(file.lastIndexOf("/") + 1).includes("baseline"));
  assert.ok(tracked.length > 0);
  const examined = new Set(report.baselines);
  for (const file of tracked) assert.ok(examined.has(file), `${file} is a tracked baseline the gate did not read`);

  const index = readIndex({ root: REPOSITORY_ROOT });
  for (const finding of report.findings) {
    const match = /^baseline_names_a_file_that_does_not_exist:([^:]+):(.+)$/u.exec(finding);
    assert.ok(match !== null, `a finding that names neither a baseline nor a path: ${finding}`);
    assert.ok(examined.has(match[1]), `${match[1]} is not a baseline in the population`);
    assert.ok(!index.has(match[2]), `${match[2]} is tracked, so it cannot be the file the gate says is missing`);
  }
  assert.equal(report.dangling, report.findings.length, "the census and the findings are the same count");
  assert.equal(report.ok, report.findings.length === 0, "ok is exactly the absence of findings");
  assert.match(renderBaselinePathsReport(report)[0], /^baselines examined \d+ · path references \d+ · dangling \d+$/u);
});

test("red (today's tree): the two runners one retirement commit deleted are named, with no third finding", () => {
  const report = runBaselinePathsGate({ root: REPOSITORY_ROOT });
  assert.deepEqual(
    report.findings,
    RETIRED_FINDINGS,
    `the recorded debt changed.${"\n"}  If a runner was restored, this is a real finding. If the two entries were ` +
      `deleted from ${RETIRED}, this constant must become [] - the population checks above then carry the verdict.`,
  );
  // The same reading with the two entries removed in memory: the gate goes green without the file being touched, which
  // is what tells the owner the fix is the entry and nothing else.
  const baselines = baselinePopulation({ index: readIndex({ root: REPOSITORY_ROOT }) }).map((file) => ({
    file,
    parsed: JSON.parse(readFileSync(resolve(REPOSITORY_ROOT, file), "utf8")),
  }));
  const recorded = baselines.find((entry) => entry.file === RETIRED);
  const repaired = checkBaselinePaths({
    baselines: baselines.map((entry) =>
      entry.file === RETIRED
        ? {
            file: entry.file,
            parsed: {
              ...entry.parsed,
              knownSites: entry.parsed.knownSites.filter((site) => !RETIRED_RUNNERS.includes(site.file)),
            },
          }
        : entry,
    ),
    index: readIndex({ root: REPOSITORY_ROOT }),
  });
  assert.ok(
    recorded.parsed.knownSites.some((site) => site.file === RETIRED_RUNNERS[0]),
    "the entries are there to remove",
  );
  assert.deepEqual(repaired.findings, [], "removing the two entries is what makes the gate green");
  assert.equal(repaired.ok, true);
});

test("red (history): the commit that retired the runners is caught, replaying its index and its baselines", () => {
  const revision = "b6128a58";
  let unavailable = null;
  let reading = null;
  try {
    const index = new Set(
      git(REPOSITORY_ROOT, "ls-tree", "-r", "--name-only", "-z", revision).split("\0").filter(Boolean),
    );
    const baselines = baselinePopulation({ index }).map((file) => ({
      file,
      parsed: JSON.parse(git(REPOSITORY_ROOT, "show", `${revision}:${file}`)),
    }));
    reading = checkBaselinePaths({ baselines, index });
  } catch (error) {
    unavailable = String(error?.message ?? error);
  }
  // A clone with no history - `actions/checkout`'s default is `fetch-depth: 1` - cannot replay the commit. That is a
  // reading that was not taken, and it says so instead of passing as if the gate had been shown red there.
  if (reading === null) {
    assert.match(unavailable, new RegExp(`${revision}|bad object|unknown revision|not a valid`, "u"));
    return;
  }
  assert.ok(reading.examined > 0, "the replayed population must not be empty");
  assert.deepEqual(reading.findings, RETIRED_FINDINGS, "the gate reds on the commit that shipped the defect");
});

test("red (inject): a fabricated path added to a baseline is exactly one finding, named", () => {
  withFixture({ files: ["tools/kept.mjs"], baseline: members(["tools/kept.mjs"]) }, (root) => {
    const green = runGate(root);
    assert.equal(green.status, 0, green.stdout);
    assert.deepEqual(green.lines, [
      "baselines examined 1 · path references 1 · dangling 0",
      "  green: every path the 1 baselines name is in the index",
    ]);

    // The flag path: the same baseline with one fabricated reference beside the real one.
    const fabricated = join(root, "tools/probe-baseline.json");
    writeFileSync(
      fabricated,
      `${JSON.stringify(members(["tools/kept.mjs", "tools/fabricated-missing.mjs"]), null, 2)}\n`,
    );
    git(root, "add", "tools/probe-baseline.json");
    const red = runGate(root);
    assert.equal(red.status, 1, red.stdout);
    assert.deepEqual(red.lines.slice(0, 2), [
      "baselines examined 1 · path references 2 · dangling 1",
      "baseline_names_a_file_that_does_not_exist:tools/probe-baseline.json:tools/fabricated-missing.mjs",
    ]);
    assert.equal(red.lines.filter((line) => line.startsWith("baseline_names_a_file_that_does_not_exist:")).length, 1);
  });
});

test("red (index, not worktree): a file on disk that git does not track is missing, and staging it is the fix", () => {
  withFixture(
    {
      files: ["tools/kept.mjs", "tools/untracked-only.mjs"],
      baseline: members(["tools/kept.mjs", "tools/untracked-only.mjs"]),
      add: false,
    },
    (root) => {
      git(root, "add", "tools/kept.mjs", "tools/probe-baseline.json");
      // The file exists in the working tree - `existsSync` would call it present - and the index does not carry it.
      assert.ok(readFileSync(resolve(root, "tools/untracked-only.mjs"), "utf8") === "\n", "the file is on disk");
      const red = runGate(root);
      assert.equal(red.status, 1, red.stdout);
      assert.deepEqual(red.lines.slice(0, 2), [
        "baselines examined 1 · path references 2 · dangling 1",
        "baseline_names_a_file_that_does_not_exist:tools/probe-baseline.json:tools/untracked-only.mjs",
      ]);

      git(root, "add", "tools/untracked-only.mjs");
      const green = runGate(root);
      assert.equal(green.status, 0, green.stdout);
      assert.deepEqual(green.lines, [
        "baselines examined 1 · path references 2 · dangling 0",
        "  green: every path the 1 baselines name is in the index",
      ]);
    },
  );
});

test("red (inject): a root with no baseline, and a baseline that does not parse, are blocked rather than green", () => {
  withFixture({ files: ["tools/notes.json"], baseline: { not: "a baseline" } }, (root) => {
    rmSync(resolve(root, "tools/probe-baseline.json"));
    writeFileSync(resolve(root, "tools/notes.json"), "{}\n");
    git(root, "add", "-A");
    const empty = runGate(root);
    assert.equal(empty.status, 2, empty.stdout);
    assert.match(empty.lines[0], /^baseline_gate_no_population: no tracked \*\.json/u);

    writeFileSync(resolve(root, "tools/probe-baseline.json"), "{ this is not json\n");
    git(root, "add", "-A");
    const unreadable = runGate(root);
    assert.equal(unreadable.status, 2, unreadable.stdout);
    assert.match(unreadable.lines[0], /^not_measured:baseline_gate_unreadable_baseline: tools\/probe-baseline\.json/u);
  });
});

test("the rule reads a member's own key, and a tail resolves against the index", () => {
  // The reference this gate reads, and the two shapes it must not read: an input key, a sentence, a label without a
  // source extension.
  assert.deepEqual(pathReferences({ entries: [{ file: "tools/a.mjs", reason: "tools/b.mjs is red" }] }), [
    { pointer: "$.entries[0].file", value: "tools/a.mjs" },
  ]);
  assert.deepEqual(pathReferences({ bundle: "tools/_run-round38.result.json" }), []);
  assert.deepEqual(pathReferences({ files: ["tools/a.mjs", "tools/b.json"] }), [
    { pointer: "$.files[0]", value: "tools/a.mjs" },
    { pointer: "$.files[1]", value: "tools/b.json" },
  ]);
  assert.equal(isPathReference("tools/a.mjs"), true);
  assert.equal(isPathReference("tools/a.mjs is red"), false);
  assert.equal(isPathReference("check:baseline-paths"), false);
  assert.equal(isPathReference("../../etc/passwd.json"), false);
  assert.equal(isPathReference("v1.0.0"), false, "a dotted version is not a path");

  // The docblock's example: the lifecycle-pin baseline names its C# tests relative to the package root the owning gate
  // reads from, so the tail is the identity - and a name that is not in the index stays a finding.
  const index = readIndex({ root: REPOSITORY_ROOT });
  assert.equal(resolves("GameBuddy.Stardew.Core.Tests/CandidateActionRegistrationTests.cs", { index }), true);
  assert.equal(resolves("GameBuddy.Stardew.Core.Tests/NotARealFile.cs", { index }), false);
});
