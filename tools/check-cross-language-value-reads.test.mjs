#!/usr/bin/env node
/**
 * The falsifier for `tools/check-cross-language-value-reads.mjs`.
 *
 * Three kinds of case, because the gate answers three questions:
 *
 *   - HISTORY. The class is not hypothetical: `SweepTargetRefusalNamingTests.cs` at `1b7d933d` read
 *     `host/src/fact-brief.ts` for `evidence:\s*(?<chars>[0-9]+)`, and `67ce595a`'s rename made the reading silent
 *     (`e34023f2` is the fix). The test builds that tree out of the commit itself and requires the finding to name the
 *     file and the value; at HEAD the same file reads `host/src/model-field-budget.published.json` and leaves the
 *     population, which is the fix's shape.
 *   - THE THREE CLAUSES, one at a time. A reader of its OWN language, a read of a published `.json` artifact, and a
 *     pattern asserted to exist are each a synthetic tree of their own, so a clause that stopped excluding cannot be
 *     covered by a sibling clause still working.
 *   - THE RATCHET, in both directions. An unrecorded value site is a finding; the same site recorded is green; the
 *     recorded site with a pattern nothing matches is `value_read_baseline_stale`, so an entry cannot outlive its
 *     subject.
 *
 * Every case runs the gate as a child on its own `--root`, so the population is what the gate itself derives.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-cross-language-value-reads.mjs");
const BASELINE = "tools/baselines/value-read-from-source.json";
const HISTORY = "1b7d933d";
const HISTORY_FILE = "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/SweepTargetRefusalNamingTests.cs";
const HISTORY_TARGET = "host/src/fact-brief.ts";

/** One throwaway tree per case: `{ path: text }` in, a root out, removed when the case ends. */
function withTree(files, body) {
  const root = mkdtempSync(join(tmpdir(), "value-reads-"));
  try {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(root, dirname(path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
    return body(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The gate's full report for a tree, with the exit code its `--json` run produced. */
function read(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root, "--json"], { encoding: "utf8" });
  return { status: result.status, stdout: String(result.stdout ?? ""), report: JSON.parse(String(result.stdout)) };
}

/** The DEFAULT run: the last line it prints is the report a harness reads, so that line is what this returns. */
function printed(root) {
  const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
  const lines = String(result.stdout ?? "")
    .trim()
    .split("\n")
    .filter(Boolean);
  return { status: result.status, lines, report: JSON.parse(lines.at(-1)) };
}

const codes = (report) => report.findings.map((finding) => finding.code);
const findingsAbout = (report, file) => report.findings.filter((finding) => finding.file === file);

test("the class fires on the commit before its fix, naming the file and the value", () => {
  const file = spawnSync("git", ["show", `${HISTORY}:${HISTORY_FILE}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "buffer",
    maxBuffer: 1 << 26,
  });
  const target = spawnSync("git", ["show", `${HISTORY}:${HISTORY_TARGET}`], {
    cwd: REPOSITORY_ROOT,
    encoding: "buffer",
    maxBuffer: 1 << 26,
  });
  assert.equal(file.status, 0, `the history this falsifier replays must be readable: ${HISTORY}:${HISTORY_FILE}`);
  assert.equal(target.status, 0, `the file that commit read must be readable: ${HISTORY}:${HISTORY_TARGET}`);

  withTree({ [HISTORY_FILE]: String(file.stdout), [HISTORY_TARGET]: String(target.stdout) }, (root) => {
    const { status, report } = read(root);
    assert.equal(status, 1, "a tree carrying this reader is red");
    const about = findingsAbout(report, HISTORY_FILE);
    assert.equal(about.length, 1, `one finding for the file, got ${JSON.stringify(report.findings)}`);
    assert.equal(about[0].code, "value_read_from_another_languages_source");
    assert.equal(
      about[0].value,
      "evidence",
      "the value it takes out is `evidence`, not the ceilings block the outer match reached first",
    );
    assert.match(about[0].detail, /evidence:/u, "the finding names the expression it read");
    assert.equal(report.counts.value, 1, "and it is the only value site in that tree");
  });
});

test("the fix leaves the population: HEAD reads the published artifact, not the TypeScript", () => {
  const atHead = readFileSync(join(REPOSITORY_ROOT, HISTORY_FILE), "utf8");
  const published = readFileSync(join(REPOSITORY_ROOT, "host", "src", "model-field-budget.published.json"), "utf8");
  withTree(
    {
      [HISTORY_FILE]: atHead,
      "host/src/model-field-budget.published.json": published,
      "host/src/model-field-budget.ts": readFileSync(
        join(REPOSITORY_ROOT, "host", "src", "model-field-budget.ts"),
        "utf8",
      ),
    },
    (root) => {
      const { report } = read(root);
      assert.deepEqual(
        findingsAbout(report, HISTORY_FILE),
        [],
        "the same file at HEAD reads an artifact and is not a site",
      );
      assert.equal(report.counts.nonSourceTarget, 1, "the artifact read is COUNTED, so the exclusion is visible");
    },
  );
});

const DETECTOR = `import { readFileSync } from "node:fs";

export function ceiling(): number {
  const source = readFileSync("../src/limits.ts", "utf8");
  const found = source.match(/evidence:\\s*(\\d+)/u);
  return Number(found[1]);
}
`;

test("a new value site is a finding with the code the class is named by", () => {
  withTree(
    { "src/limits.ts": "export const LIMITS = Object.freeze({ evidence: 376 });\n", "src/detector.test.mjs": DETECTOR },
    (root) => {
      const { status, report } = read(root);
      assert.equal(status, 1);
      assert.deepEqual(codes(report), ["value_read_from_another_languages_source"]);
      assert.equal(
        `${report.findings[0].code}:${report.findings[0].file}:${report.findings[0].value}`,
        "value_read_from_another_languages_source:src/detector.test.mjs:evidence",
      );
    },
  );
});

test("the recorded site is green, and the recording expires when the pattern it names stops matching", () => {
  const tree = {
    "src/limits.ts": "export const LIMITS = Object.freeze({ evidence: 376 });\n",
    "src/detector.test.mjs": DETECTOR,
  };
  withTree(tree, (root) => {
    const site = read(root).report.values[0];
    const entry = {
      file: site.file,
      target: site.target,
      value: site.value,
      pattern: site.pattern,
      owed: "a test entry",
    };

    mkdirSync(join(root, dirname(BASELINE)), { recursive: true });
    writeFileSync(join(root, BASELINE), `${JSON.stringify({ sites: [entry] })}\n`);
    const recorded = printed(root);
    assert.equal(recorded.status, 0, "a recorded site is not a finding");
    assert.equal(recorded.report.status, "passed");
    assert.equal(recorded.report.population, 1, "and the default run still reports the population it measured");

    const drifted = { ...entry, pattern: "evidence:\\s*\\[(\\d+)\\]" };
    writeFileSync(join(root, BASELINE), `${JSON.stringify({ sites: [drifted] })}\n`);
    const stale = read(root);
    assert.equal(stale.status, 1);
    assert.deepEqual(
      codes(stale.report).sort(),
      ["value_read_baseline_stale", "value_read_from_another_languages_source"],
      "the entry whose pattern moved is stale AND the site it no longer covers is a finding - neither hides the other",
    );
    assert.equal(findingsAbout(stale.report, "src/detector.test.mjs").length, 2);
  });
});

test("a reader of its own language is outside the class", () => {
  withTree(
    {
      "src/limits.ts": "export const LIMITS = Object.freeze({ evidence: 376 });\n",
      "src/own.test.ts":
        'import { readFileSync } from "node:fs";\nconst s = readFileSync("limits.ts", "utf8");\nconst n = Number(s.match(/evidence:\\s*(\\d+)/u)[1]);\n',
      "src/ForeignTests.cs":
        'using System.IO;\nusing System.Text.RegularExpressions;\nclass ForeignTests {\n  void A() {\n    string source = File.ReadAllText("limits.ts");\n    Match found = Regex.Match(source, @"evidence:\\s*(\\d+)");\n    int.Parse(found.Groups[1].Value).Should().Be(376);\n  }\n}\n',
    },
    (root) => {
      const { report } = read(root);
      assert.deepEqual(
        findingsAbout(report, "src/own.test.ts"),
        [],
        "a TypeScript reader of TypeScript is not this class",
      );
      assert.equal(
        findingsAbout(report, "src/ForeignTests.cs").length,
        1,
        "and the cross-language reader of the same file in the same tree is a finding",
      );
      assert.equal(report.counts.sameLanguage, 1, "the same-language read is COUNTED, so the exclusion is visible");
    },
  );
});

test("an artifact read and a shape assertion are counted, classified and not judged", () => {
  withTree(
    {
      "src/limits.ts": "export const LIMITS = Object.freeze({ evidence: 376 });\n",
      "src/limits.published.json": '{ "evidence": 376 }\n',
      "src/ArtifactTests.cs":
        'using System.IO;\nclass ArtifactTests {\n  void A() { var text = File.ReadAllText("limits.published.json"); Use(text); }\n}\n',
      "src/ShapeTests.cs":
        'using System.IO;\nusing System.Text.RegularExpressions;\nclass ShapeTests {\n  void A() { string source = File.ReadAllText("limits.ts"); Regex.IsMatch(source, "evidence").Should().BeTrue(); }\n}\n',
    },
    (root) => {
      const { report } = read(root);
      assert.deepEqual(report.findings, [], "neither an artifact read nor a presence assertion is a value site");
      assert.equal(report.counts.nonSourceTarget, 1, "the `.json` read is counted as a non-source target");
      const shape = report.sites.find((site) => site.file === "src/ShapeTests.cs");
      assert.equal(shape?.siteClass, "shape", "a presence probe is `shape`, so the value class cannot absorb it");
    },
  );
});

test("the three classes partition the population, and this tree records every value site it has", () => {
  const { report, status } = read(REPOSITORY_ROOT);
  const byClass = report.sites.reduce(
    (tally, site) => ({ ...tally, [site.siteClass]: (tally[site.siteClass] ?? 0) + 1 }),
    {},
  );
  assert.equal(
    (byClass.value ?? 0) + (byClass.shape ?? 0) + (byClass.content ?? 0),
    report.counts.foreignSource,
    "a site is exactly one of value / shape / content - a class quietly dropped would unbalance this sum",
  );
  assert.ok(report.counts.readers > 1000, `the census read ${report.counts.readers} reader(s), which is this tree`);
  assert.ok(report.counts.unresolved > 0, "unresolved reads are counted rather than assumed away");
  assert.equal(status, 0, "every value site on this tree is recorded in the baseline");
  assert.ok(report.values.length > 0, "a green run over zero value sites would agree with itself");
});

test("a tree with no reader is blocked, not green", () => {
  withTree({ "README.md": "# nothing to read here\n" }, (root) => {
    const { status, report, lines } = printed(root);
    assert.equal(status, 2, "zero population is a blocked reading");
    assert.equal(report.status, "blocked");
    assert.equal(report.population, 0);
    assert.match(lines[0], /value_reads_blocked/u, "a blocked run says so in words as well as in its report");
  });
});
