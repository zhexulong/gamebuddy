/**
 * The hotspot report's two numbers, tried on a real git work tree.
 *
 * What has to be true for the reading to be worth printing, and each one is a case here: a busy file outranks a calm
 * one of the same size, a file with no revision in the window scores 0 rather than vanishing, the ordering is
 * deterministic when the score ties, a window with no commits is BLOCKED rather than reported as "nothing busy", and
 * a test's relative import - written with a `.js` specifier, with no extension, or as a directory - is what makes the
 * `tests` column non-zero. The last three are fixture runs of the command itself, because a report that prints
 * `files examined 0` and exits 0 is the defect `tools/check-gate-populations.mjs` exists for.
 *
 * red-proof: inject  `score: commits * lines` -> `score: commits + lines` in rank() -> `rank.1`, `rank.2`, `locate.1`
 *   and `report.4` fail (the table and the located rank both stop being the product of the two numbers) while 10 of the
 *   14 cases stay green; unmodified, all fourteen pass (tools/audit-hotspots.test.mjs)
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { locate, measureChurn, measureTestImporters, rank, topDecile } from "./audit-hotspots.mjs";

const GATE = join(dirname(fileURLToPath(import.meta.url)), "audit-hotspots.mjs");
const IDENTITY = [
  "-c",
  "user.name=hotspots",
  "-c",
  "user.email=hotspots@example.invalid",
  "-c",
  "commit.gpgsign=false",
];

const git = (root, args, env = {}) =>
  execFileSync("git", [...IDENTITY, ...args], {
    cwd: root,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, ...env },
  });

const write = (root, files) => {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), text);
  }
};

const commit = (root, env = {}) => {
  git(root, ["add", "-A"], env);
  git(root, ["commit", "-m", "fixture"], env);
};

/** One git work tree holding `files`, committed once. The population is git's answer, so a fixture must be a repo. */
const repository = (files, env = {}) => {
  const root = mkdtempSync(join(tmpdir(), "gb-hotspots-"));
  git(root, ["init", "--initial-branch=main"]);
  write(root, files);
  commit(root, env);
  return root;
};

const at = (root, args) =>
  spawnSync(process.execPath, [GATE, "--root", root, ...args], { encoding: "utf8", windowsHide: true });

test("rank.1: at equal size the file with more revisions leads, and the score is the product", () => {
  const rows = rank({
    sizes: new Map([
      ["src/calm.ts", 100],
      ["src/busy.ts", 100],
    ]),
    revisions: new Map([
      ["src/busy.ts", 3],
      ["src/calm.ts", 1],
    ]),
  });
  assert.deepEqual(
    rows.map((row) => row.file),
    ["src/busy.ts", "src/calm.ts"],
  );
  assert.equal(rows[0].score, 300);
  assert.equal(rows[1].score, 100);
});

test("rank.2: a file with no revision in the window is a row worth 0, not a missing row", () => {
  const rows = rank({
    sizes: new Map([
      ["src/touched.ts", 10],
      ["src/idle.ts", 10],
    ]),
    revisions: new Map([["src/touched.ts", 2]]),
  });
  assert.deepEqual(
    rows.map((row) => [row.file, row.revisions, row.score]),
    [
      ["src/touched.ts", 2, 20],
      ["src/idle.ts", 0, 0],
    ],
  );
});

test("rank.3: equal score and equal revisions order by path, so two runs print the same table", () => {
  const rows = rank({
    sizes: new Map([
      ["src/b.ts", 10],
      ["src/a.ts", 10],
    ]),
    revisions: new Map([
      ["src/a.ts", 1],
      ["src/b.ts", 1],
    ]),
  });
  assert.deepEqual(
    rows.map((row) => row.file),
    ["src/a.ts", "src/b.ts"],
  );
});

test("topDecile.1: a decile of 20 rows is 2 rows down to the second score, and of 9 rows is no decile at all", () => {
  const rows = rank({
    sizes: new Map(Array.from({ length: 20 }, (_, index) => [`src/f${index}.ts`, 100 - index])),
    revisions: new Map(Array.from({ length: 20 }, (_, index) => [`src/f${index}.ts`, 20 - index])),
  });
  const decile = topDecile(rows);
  assert.equal(decile.count, 2);
  assert.equal(decile.threshold, rows[1].score);
  assert.deepEqual(topDecile(rows.slice(0, 9)), { count: 0, threshold: null });
});

test("locate.1: a busy file is placed by rank and by the two numbers that put it there", () => {
  const rows = rank({
    sizes: new Map([
      ["src/busy.ts", 50],
      ["src/calm.ts", 50],
    ]),
    revisions: new Map([
      ["src/busy.ts", 4],
      ["src/calm.ts", 1],
    ]),
  });
  const place = locate(rows, "src/calm.ts");
  assert.deepEqual(place, { file: "src/calm.ts", lines: 50, revisions: 1, score: 50, rank: 2, of: 2 });
  assert.equal(locate(rows, "src/absent.ts").rank, null);
});

test("measureChurn.1: revision counts come from the log, one per commit, over the commits that named the path", () => {
  const root = repository({ "src/a.ts": "// a\n", "src/b.ts": "// b\n" });
  try {
    write(root, { "src/a.ts": "// a\n// a2\n" });
    commit(root);
    write(root, { "src/a.ts": "// a\n// a2\n// a3\n" });
    commit(root);
    const { commits, revisions } = measureChurn(root, 30);
    assert.equal(commits, 3);
    assert.equal(revisions.get("src/a.ts"), 3);
    assert.equal(revisions.get("src/b.ts"), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measureChurn.2: the window ends at this tree's own HEAD, so a commit older than it does not count", () => {
  const root = repository(
    { "src/old.ts": "// old\n" },
    { GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" },
  );
  try {
    write(root, { "src/new.ts": "// new\n" });
    commit(root);
    const { anchor, commits, revisions } = measureChurn(root, 30);
    assert.ok(Date.parse(anchor) - Date.parse("2020-01-05T00:00:00Z") > 0, "the anchor is the newest commit's date");
    assert.equal(commits, 1);
    assert.equal(revisions.get("src/new.ts"), 1);
    assert.equal(revisions.get("src/old.ts"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measureChurn.3: an old tree is measured as of its own date, not as of today", () => {
  const old = { GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
  const root = repository({ "src/a.ts": "// a\n" }, old);
  try {
    write(root, { "src/a.ts": "// a2\n" });
    commit(root, { GIT_AUTHOR_DATE: "2020-01-10T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-10T00:00:00Z" });
    const { anchor, commits, revisions } = measureChurn(root, 30);
    assert.equal(anchor.slice(0, 10), "2020-01-10");
    assert.equal(commits, 2);
    assert.equal(revisions.get("src/a.ts"), 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("measureTestImporters.1: the three relative forms resolve, and a bare package specifier is not a source", () => {
  const root = repository({
    "src/with-extension.ts": "export const x = 1;\n",
    "src/extensionless.ts": "export const y = 1;\n",
    "src/dir/index.ts": "export const z = 1;\n",
    "src/nobody.ts": "export const w = 1;\n",
    "src/with-extension.test.mjs": 'import { x } from "./with-extension.js";\n',
    "src/extensionless.test.ts": 'import { y } from "./extensionless";\n',
    "src/dir/index.test.ts": 'import { z } from ".";\n',
    "src/bare.test.ts": 'import assert from "node:assert/strict";\nimport { w } from "some-package";\n',
  });
  try {
    const population = new Map([
      ["src/with-extension.ts", 1],
      ["src/extensionless.ts", 1],
      ["src/dir/index.ts", 1],
      ["src/nobody.ts", 1],
      ["src/with-extension.test.mjs", 1],
      ["src/extensionless.test.ts", 1],
      ["src/dir/index.test.ts", 1],
      ["src/bare.test.ts", 1],
    ]);
    const { importers, tests } = measureTestImporters({ root, population });
    assert.equal(tests, 4);
    assert.deepEqual(importers.get("src/with-extension.ts"), ["src/with-extension.test.mjs"]);
    assert.deepEqual(importers.get("src/extensionless.ts"), ["src/extensionless.test.ts"]);
    assert.deepEqual(importers.get("src/dir/index.ts"), ["src/dir/index.test.ts"]);
    assert.equal(importers.get("src/nobody.ts"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.1: the command prints its population and the busy file first", () => {
  const root = repository({ "src/calm.ts": "// calm\n", "src/busy.ts": "// busy\n" });
  try {
    write(root, { "src/busy.ts": "// busy\n// more\n" });
    commit(root);
    const run = at(root, []);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /files examined 2/u);
    assert.match(run.stdout, /with a revision in the window 2/u);
    const first = run.stdout.split("\n").find((line) => /^\s+1\s/u.test(line));
    assert.match(first, /src\/busy\.ts$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.2: a work tree with no file at all is blocked, never a pass over nothing", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-hotspots-empty-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    const run = at(root, []);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /hotspots_blocked:population_empty/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.3: a work tree with files but no commit at all is blocked, not reported as calm", () => {
  const root = mkdtempSync(join(tmpdir(), "gb-hotspots-uncommitted-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    write(root, { "src/a.ts": "// a\n" });
    const run = at(root, ["--window", "30"]);
    assert.equal(run.status, 2);
    assert.match(run.stderr, /hotspots_blocked:window_unreadable/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.4: --locate names the rank and both numbers for one file", () => {
  const root = repository({ "src/calm.ts": "// calm\n", "src/busy.ts": "// busy\n" });
  try {
    write(root, { "src/busy.ts": "// busy\n// more\n" });
    commit(root);
    const run = at(root, ["--locate", "src/busy.ts"]);
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /locate src\/busy\.ts · rank 1 of 2 · revisions 2 · lines 3 · score 6/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("report.5: --why-not-a-gate prints the retrospection and needs no repository", () => {
  const run = spawnSync(process.execPath, [GATE, "--why-not-a-gate"], { encoding: "utf8", windowsHide: true });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /precision 5\.3%/u);
  assert.match(run.stdout, /75 files enter and 75 leave/u);
});
