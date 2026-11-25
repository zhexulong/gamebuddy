/**
 * A commit carries the bytes that were staged, and the pre-commit hook may not put any other bytes there.
 *
 * The hook formats what is being committed. It used to do that by running the formatter `--write` over the STAGED
 * PATHS as the worktree resolves them, and then `git add`ing every path whose worktree bytes the formatter had
 * changed. In this repository the worktree is several lanes' work in flight, so "the formatter changed this file"
 * was answered about a file that a neighbour was editing: on 2026-11-13 a lane staged a 2-line hunk of
 * `tools/run-tool-test-corpus.mjs` through a private index, a neighbour's 258-line rewrite of that file sat in the
 * worktree, the formatter rewrote two characters of it, and `git add` put the whole rewrite into that lane's commit
 * (`d8567157`). A private index promised only the lane's hunks; the re-stage broke the promise.
 *
 * The suite runs the REAL hook (`tools/git-hooks/pre-commit` -> `tools/scripts/pre-commit.mjs`, copied out of this
 * tree) in a fixture repository, and asserts on what the commit contains. The formatter is a stand-in for one
 * reason: it is another process, and its CLI is a boundary this suite does not own. The stand-in reproduces both of
 * its modes - `--write` rewrites files, `--stdin-file-path=<path>` formats stdin to stdout - so a hook that goes
 * back to formatting files in the worktree fails these tests on their substance rather than on a missing feature.
 *
 * THE SECOND SUBJECT: A RECORD MAY NOT OUTLIVE ITS READING. The hook also reads the complexity and duplication ratchets
 * over the tree the index describes and refuses a commit whose change makes a record disagree with that tree - the case
 * `a staged growth that leaves its re-record behind is refused by name`. Both gates are the real ones, with a real
 * tree-sitter and a real jscpd, so what the cases prove is the gates' own verdict; only Biome is the stand-in, which is
 * why the fixture's TypeScript reading is empty and its Mod class carries the complexity cases.
 *
 * red-proof: history  the pre-fix hook replayed from `d8567157^` in a copy of this tree, over the same scenario,
 *                     committed 210 insertions and 61 deletions - the neighbouring lane's whole rewrite - where the
 *                     index held 2 insertions -> `✖ a commit carries the staged bytes when the worktree holds a
 *                     foreign hunk`, exit 1 (tools/scripts/pre-commit.test.mjs)
 * red-proof: inject  a formatter that rewrites a character, and a hook that takes its output -> `✖ a character the
 *                     author wrote is not formatting`, the commit carries `×` where `✖` was staged (undo the guard in
 *                     `rewriteFormattedBlobs` to see it)
 * red-proof: inject  a staged class growth with the record left where it was -> `✖ a staged growth that leaves its
 *                     re-record behind is refused by name`, refused with
 *                     `complexity_baseline_stale_for_this_commit:integrations/stardew/Fixture.cs:cs:Fixture:`
 *                     `<recorded>-><current>`; drop the `checkRatchetRecords` step from the hook and it goes green
 * red-proof: inject  a staged record that is not readable JSON -> `✖ a record that cannot be read refuses the commit
 *                     with the reason`, `ratchet_record_unreadable_for_this_commit:...`
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCENARIO = "tools/scenario.mjs";
const FORMATTER_LOG = ".formatter-invocations";
const HOST_SOURCE = "host/src/fixture.ts";
const MOD_CLASS = "integrations/stardew/Fixture.cs";
const COMPLEXITY_RECORD = "tools/cognitive-complexity-baseline.json";
const DUPLICATION_RECORD = "tools/duplicate-code-baseline.json";

/**
 * The Mod class the fixture's complexity record is about: `padding` comment lines inside the body, so a case can put the
 * class over the 1000-line ceiling and then grow it again with the same `parts` and `methods` - the difference between a
 * record that is stale and a class that grew.
 */
const modClass = (padding) =>
  `namespace Fixture;\n\npublic class Fixture\n{\n${Array.from(
    { length: padding },
    (_, index) => `    // recorded line ${index}`,
  ).join(
    "\n",
  )}\n\n    private readonly int seed;\n\n    public Fixture(int seed)\n    {\n        this.seed = seed;\n    }\n\n    public int Read(int scale)\n    {\n        if (scale <= 0)\n        {\n            return this.seed;\n        }\n        return this.seed * scale;\n    }\n}\n`;

/** The hook, and the library it imports, taken from this tree so the suite cannot agree with a hook that is not there. */
const COPIED_FILES = [
  "tools/git-hooks/pre-commit",
  "tools/scripts/pre-commit.mjs",
  "tools/scripts/check-file-complexity-gate.mjs",
  "tools/scripts/check-script-entry-existence.mjs",
  "tools/scripts/cli-entry.mjs",
  "tools/lib/subprocess-output.mjs",
  "tools/lib/assert-non-vacuous.mjs",
  "tools/lib/gate-population.mjs",
  "tools/lib/host-production-sources.mjs",
  "tools/lib/indexed-sources.mjs",
  "tools/lib/javascript-ast.mjs",
  "tools/lib/repository-root.mjs",
  "gates/directories.mjs",
  "gates/registry.mjs",
  "gates/meta/check-ci-coverage.mjs",
  "gates/arch/check-cognitive-complexity.mjs",
  "gates/arch/check-code-duplication.mjs",
  "gates/stardew/check-native-local-runner-scaffold.mjs",
];

/**
 * The packages the two complexity/duplication gates resolve from `node_modules`.
 *
 * A junction to each INSTALLED package, not to `node_modules/<name>`: the manager here is pnpm, whose entries are
 * relative symlinks into `.pnpm`, and a relative link reached through another link points nowhere. Biome is absent on
 * purpose - `node_modules/@biomejs/biome` is the formatter stand-in below, so the fixture's ts complexity reading is
 * this suite's, not a linter's.
 */
const LINKED_PACKAGES = ["@vscode/tree-sitter-wasm", "web-tree-sitter", "jscpd"];

/** The steps the hook runs conditionally on Host/lockfile changes. None of them is this suite's subject. */
const STUBBED_STEPS = ["host/scripts/check-staged-test-typecheck.mjs", "tools/scripts/check-lockfile-freeze.mjs"];

/** One formatter process: both CLI modes, and a record of every invocation so "no formatter ran" is observable. */
const FORMATTER = `#!/usr/bin/env node
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(FORMATTER_LOG)}, \`\${args.join(" ")}\\n\`);
const format_ = (text) => {
  if (text.includes("PARSE_ERROR")) {
    process.stderr.write("format: Code formatting aborted due to parsing errors.\\n");
    process.exit(1);
  }
  return text.replace(/\\{(\\w+):(\\w+)\\}/g, "{ $1: $2 }");
};
const [subcommand, ...paths] = args.filter((arg) => !arg.startsWith("--"));
if (subcommand === "lint") {
  const diagnostics = [];
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    if (!text.includes("LINT_ERROR")) continue;
    diagnostics.push({
      severity: "error",
      description: "fixture lint error (LINT_ERROR)",
      location: { path: { file: path }, span: [0, 1] },
    });
  }
  const report = {
    summary: { errors: diagnostics.length, warnings: 0, unchanged: paths.length - diagnostics.length, changed: diagnostics.length },
    diagnostics,
  };
  process.stdout.write(JSON.stringify(report));
  process.exit(diagnostics.length > 0 ? 1 : 0);
}
if (subcommand !== "format") {
  process.stderr.write("formatter fixture: unexpected subcommand " + subcommand + "\\n");
  process.exit(1);
}

if (args.includes("--write")) {
  for (const path of paths) writeFileSync(path, format_(readFileSync(path, "utf8")));
  process.exit(0);
}
if (!args.some((arg) => arg.startsWith("--stdin-file-path="))) {
  process.stderr.write("formatter fixture: neither --write nor --stdin-file-path was given\\n");
  process.exit(1);
}
// biome 2.2.4's stdin mode, reproduced: exactly the five substitutions measured over this tree's 2010 non-ASCII
// codepoints. FILE mode does not do this, which is the difference the hook has to care about.
const STDIN_SUBSTITUTIONS = [
  ["\\u2716", "\\u00d7"],
  ["\\u2714", "\\u221a"],
  ["\\u2139", "e"],
  ["\\u26a0", "!"],
  ["\\ufe0f", ""],
];
const stdinFormatted = STDIN_SUBSTITUTIONS.reduce(
  (text, [from, to]) => text.split(from).join(to),
  format_(readFileSync(0, "utf8")),
);
process.stdout.write(stdinFormatted);
`;

/**
 * A formatter that rewrites a character in FILE mode too - the shape the hook's invariant guard exists for, because no
 * measured formatter does this today and a future one can.
 */
const CHARACTER_REWRITING_FORMATTER = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [subcommand, ...paths] = args.filter((arg) => !arg.startsWith("--"));
if (subcommand === "lint") {
  process.stdout.write(
    JSON.stringify({ summary: { errors: 0, warnings: 0, unchanged: paths.length, changed: 0 }, diagnostics: [] }),
  );
  process.exit(0);
}
if (args.includes("--write")) {
  for (const path of paths) {
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replace(/\\{(\\w+):(\\w+)\\}/g, "{ $1: $2 }").split("\\u2716").join("\\u00d7"));
  }
  process.exit(0);
}
process.stdout.write(readFileSync(0, "utf8"));
`;

const fixture = ({ formatter = FORMATTER } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pre-commit-hook-"));
  const write = (relative, content) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
  };
  for (const file of COPIED_FILES) write(file, readFileSync(join(REPOSITORY_ROOT, file)));
  write("node_modules/@biomejs/biome/bin/biome", formatter);
  write(
    "node_modules/@biomejs/biome/package.json",
    `${JSON.stringify({ name: "@biomejs/biome", version: "2.2.4", bin: { biome: "./bin/biome" } }, null, 2)}\n`,
  );
  for (const packaged of LINKED_PACKAGES) {
    const link = join(root, "node_modules", packaged);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(join(REPOSITORY_ROOT, "node_modules", packaged)), link, "junction");
  }
  for (const step of STUBBED_STEPS) write(step, `process.stdout.write("${step}: stub\\n");\n`);
  write(".gitignore", "node_modules/\n.formatter-invocations\n");
  // The two ratchets read these: the ts bound from `biome.json`, the trees, formats and ignores from `jscpd.json`
  // (which the duplication gate cross-checks against its own constants), and one source per format so neither gate
  // reads an empty population - a gate that examined nothing is blocked, not passed.
  write(
    "biome.json",
    `${JSON.stringify(
      {
        linter: {
          rules: {
            complexity: { noExcessiveCognitiveComplexity: { level: "warn", options: { maxAllowedComplexity: 30 } } },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
  write("jscpd.json", readFileSync(join(REPOSITORY_ROOT, "jscpd.json")));
  write("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
  for (const tree of ["host/scripts", "dialogue-web/src", "packages", "desktop"]) write(`${tree}/.gitkeep`, "");
  write(
    HOST_SOURCE,
    `export type FixtureReading = Readonly<{ value: number; scale: number }>;\n\nexport function readFixture(reading: FixtureReading): number {\n  if (reading.scale <= 0) {\n    return reading.value;\n  }\n  return reading.value * reading.scale;\n}\n`,
  );
  write(MOD_CLASS, modClass(0));
  write(COMPLEXITY_RECORD, `${JSON.stringify({ members: [], classes: [], sizes: [] }, null, 2)}\n`);
  write(DUPLICATION_RECORD, `${JSON.stringify({ groups: [] }, null, 2)}\n`);

  const git = (args, env = {}) =>
    spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 26,
      env: { ...process.env, ...env },
    });
  const ok = (args, env) => {
    const result = git(args, env);
    assert.equal(result.status, 0, `git ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout;
  };

  ok(["init", "-q", "-b", "main"]);
  for (const [key, value] of [
    ["user.email", "hook-fixture@example.invalid"],
    ["user.name", "hook fixture"],
    ["commit.gpgsign", "false"],
    ["core.hooksPath", "tools/git-hooks"],
    ["core.autocrlf", "false"],
  ]) {
    ok(["config", key, value]);
  }
  write(SCENARIO, "export const base = { a: 1 };\n");
  ok(["add", "-A"]);
  // The starting tree is drawn, not committed through the hook: every case below is a commit through the hook, and this
  // one has nothing to prove about one - its subject would be the tree itself, not a change to it.
  ok(["commit", "--no-verify", "-m", "fixture"]);
  rmSync(join(root, FORMATTER_LOG), { force: true });
  return { root, write, git, ok };
};
const combined = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

/**
 * A case that commits more than once: every commit through the hook measures both ratchets over the tree, so the
 * runner's default five seconds is a reading of this machine's speed rather than of the hook. Node ignores the extra
 * argument and Bun reads it as the case's own budget.
 */
const testAcrossCommits = (name, body) => test(name, body, 60_000);

/** Re-record the way an author does: the gate's own `--update` over the fixture, then the record staged with the change. */
const rerecord = (root) => {
  const update = spawnSync("node", ["gates/arch/check-cognitive-complexity.mjs", "--update"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  assert.equal(update.status, 0, `the gate's --update failed:\n${combined(update)}`);
};

test("a commit carries the staged bytes when the worktree holds a foreign hunk", () => {
  const { root, write, git, ok } = fixture();
  write(SCENARIO, "export const base = { a: 1 };\nexport const lane = { b: 2 };\n");
  ok(["add", "--", SCENARIO]);
  const stagedBlob = ok(["show", `:${SCENARIO}`]);
  const foreignBytes = `${stagedBlob}export const neighbour={c:3};\n`;
  write(SCENARIO, foreignBytes);

  const commit = git(["commit", "-m", "lane A"]);
  assert.equal(commit.status, 0, combined(commit));
  assert.match(combined(commit), /pre-commit: staging 1 file\(s\)/, "the hook must run for this to prove anything");
  const committed = ok(["show", `HEAD:${SCENARIO}`]);
  assert.equal(committed, stagedBlob, "the commit must carry the staged blob, byte for byte");
  assert.doesNotMatch(committed, /neighbour/, "a hunk that was never staged must not reach the commit");
  assert.equal(
    readFileSync(join(root, SCENARIO), "utf8"),
    foreignBytes,
    "the hook must not write a path it did not stage",
  );
});

test("the hook still formats what it commits, in the index", () => {
  const { root, write, git, ok } = fixture();
  write(SCENARIO, "export const lane = {p:8};\n");
  ok(["add", "--", SCENARIO]);

  const commit = git(["commit", "-m", "unformatted"]);
  assert.equal(commit.status, 0, combined(commit));
  assert.equal(ok(["show", `HEAD:${SCENARIO}`]), "export const lane = { p: 8 };\n");
  assert.equal(
    readFileSync(join(root, SCENARIO), "utf8"),
    "export const lane = {p:8};\n",
    "formatting is the index's business; the author's bytes stay where they are",
  );
});

test("a commit with nothing formattable runs no formatter at all", () => {
  const { root, write, git, ok } = fixture();
  write("notes.txt", "nothing here is formattable\n");
  ok(["add", "--", "notes.txt"]);

  const commit = git(["commit", "-m", "text only"]);
  assert.equal(commit.status, 0, combined(commit));
  assert.equal(
    existsSync(join(root, FORMATTER_LOG)),
    false,
    "an empty population must skip the formatter, never widen it to the checkout",
  );
  assert.match(
    combined(commit),
    /ratchet records not checked: no touched path is measured by them \(files examined 0\)/,
    "a commit outside both gates' populations says it was not measured rather than printing a pass",
  );
});

test("a formatter failure refuses the commit", () => {
  const { write, git, ok } = fixture();
  write(SCENARIO, "export const broken = PARSE_ERROR;\n");
  ok(["add", "--", SCENARIO]);
  const head = ok(["rev-parse", "HEAD"]);

  const commit = git(["commit", "-m", "broken"]);
  assert.notEqual(commit.status, 0, combined(commit));
  assert.match(combined(commit), /pre-commit: the formatter failed/);
  assert.equal(ok(["rev-parse", "HEAD"]), head, "a refused commit must not move HEAD");
});

test("with GIT_INDEX_FILE the hook formats that index and leaves the shared one alone", () => {
  const { root, write, ok } = fixture();
  const laneIndex = join(root, ".git", "lane-index");
  const lane = { GIT_INDEX_FILE: laneIndex };
  ok(["read-tree", "HEAD"], lane);
  write(SCENARIO, "export const lane = {p:8};\n");
  ok(["add", "--", SCENARIO], lane);
  const sharedBlob = ok(["show", `:${SCENARIO}`]);
  const foreignBytes = "export const lane = {p:8};\nexport const neighbour={c:3};\n";
  write(SCENARIO, foreignBytes);

  ok(["commit", "-m", "lane A"], lane);
  assert.equal(
    ok(["show", `HEAD:${SCENARIO}`]),
    "export const lane = { p: 8 };\n",
    "the formatted blob must land in the index git is committing",
  );
  assert.equal(ok(["show", `:${SCENARIO}`]), sharedBlob, "the shared index holds another lane's staging");
  assert.equal(readFileSync(join(root, SCENARIO), "utf8"), foreignBytes);
});
test("the marker characters of a staged blob survive the hook", () => {
  const { write, git, ok } = fixture();
  const staged = "// red: \u2716 a gate prints this, and \u2714 marks a pass\nconst lane = {p:8};\n";
  write(SCENARIO, staged);
  ok(["add", "--", SCENARIO]);

  const commit = git(["commit", "-m", "red proof"]);
  assert.equal(commit.status, 0, combined(commit));
  const committed = ok(["show", `HEAD:${SCENARIO}`]);
  assert.equal(
    [...committed].filter((character) => character === "\u2716").length,
    1,
    "the marker the author staged must still be U+2716 in the commit",
  );
  assert.equal(
    [...committed].filter((character) => character === "\u00d7").length,
    0,
    "U+00D7 is what the formatter's stdin mode makes of the marker, and it may not reach a commit",
  );
  assert.match(committed, /\{ p: 8 \}/, "the file must still be formatted");
  assert.doesNotMatch(combined(commit), /NOT reformatting/);
});

test("a character the author wrote is not formatting", () => {
  const { write, git, ok } = fixture({ formatter: CHARACTER_REWRITING_FORMATTER });
  const staged = "// red: \u2716 a gate prints this\nconst lane = {p:8};\n";
  write(SCENARIO, staged);
  ok(["add", "--", SCENARIO]);

  const commit = git(["commit", "-m", "rewriting formatter"]);
  assert.equal(commit.status, 0, combined(commit));
  assert.equal(
    ok(["show", `HEAD:${SCENARIO}`]),
    staged,
    "when the formatter changes a character, the staged bytes are what the commit carries",
  );
  assert.match(
    combined(commit),
    /pre-commit: NOT reformatting tools\/scenario\.mjs \(U\+2716 \(\u2716\) -> U\+00D7 \(\u00d7\)\)/,
    "the hook must name the file and the character it refused to change",
  );
});

test("reformatted index hint names the exact paths that were rewritten", () => {
  const { write, git, ok } = fixture();
  write(SCENARIO, "export const lane = {p:8};\n");
  ok(["add", "--", SCENARIO]);

  const commit = git(["commit", "-m", "exact sync path"]);
  assert.equal(commit.status, 0, combined(commit));
  assert.match(
    combined(commit),
    /biome format --write tools\/scenario\.mjs/,
    "the worktree sync instruction should carry the concrete path(s) rather than literal `<paths>`",
  );
});

testAcrossCommits("staged conflict markers and scratch debris paths refuse the commit", () => {
  const { write, git, ok } = fixture();
  const head = ok(["rev-parse", "HEAD"]);

  write(
    SCENARIO,
    `${[
      "export const a = 1;",
      "<<<<<<< HEAD",
      "export const b = 2;",
      "=======",
      "export const b = 3;",
      ">>>>>>> branch",
    ].join("\n")}\n`,
  );
  ok(["add", "--", SCENARIO]);
  const conflictCommit = git(["commit", "-m", "conflict"]);
  assert.notEqual(conflictCommit.status, 0, combined(conflictCommit));
  assert.match(combined(conflictCommit), /conflict marker/i);
  assert.equal(ok(["rev-parse", "HEAD"]), head);

  ok(["reset", "HEAD", "--", SCENARIO]);
  write("diag-temp.mjs", "console.log('debris');\n");
  ok(["add", "--", "diag-temp.mjs"]);
  const debrisCommit = git(["commit", "-m", "debris"]);
  assert.notEqual(debrisCommit.status, 0, combined(debrisCommit));
  assert.match(combined(debrisCommit), /diag-temp\.mjs/);
  assert.equal(ok(["rev-parse", "HEAD"]), head);
});

test("a staged file that exceeds its extension line ceiling is refused on the staged blob", () => {
  const { write, git, ok } = fixture();
  const head = ok(["rev-parse", "HEAD"]);
  // `.py` ceiling in `CEILINGS_BY_EXTENSION` is 300; stage 305 lines while keeping worktree short.
  const longPy = `${Array.from({ length: 305 }, (_, i) => `x_${String(i)} = ${String(i)}`).join("\n")}\n`;
  write("tools/too_long.py", longPy);
  ok(["add", "--", "tools/too_long.py"]);
  write("tools/too_long.py", "x = 1\n");

  const commit = git(["commit", "-m", "oversized py"]);
  assert.notEqual(commit.status, 0, combined(commit));
  assert.match(
    combined(commit),
    /file_over_ceiling:tools\/too_long\.py:306:300|file_over_ceiling:tools\/too_long\.py:305:300/,
  );
  assert.equal(ok(["rev-parse", "HEAD"]), head);
});

testAcrossCommits("a staged lint error refuses the commit while an unstaged neighbor lint error does not", () => {
  const { write, git, ok } = fixture();
  write("tools/clean.mjs", "export const ok = 1;\n");
  write("tools/dirty-neighbour.mjs", "export const bad = LINT_ERROR;\n");
  ok(["add", "--", "tools/clean.mjs"]);

  const cleanCommit = git(["commit", "-m", "clean staged"]);
  assert.equal(cleanCommit.status, 0, combined(cleanCommit));
  const afterClean = ok(["rev-parse", "HEAD"]);

  write("tools/bad.mjs", "export const bad = LINT_ERROR;\n");
  ok(["add", "--", "tools/bad.mjs"]);
  const blocked = git(["commit", "-m", "bad staged"]);
  assert.notEqual(blocked.status, 0, combined(blocked));
  assert.match(combined(blocked), /tools\/bad\.mjs/);
  assert.equal(ok(["rev-parse", "HEAD"]), afterClean);
});

testAcrossCommits(
  "staging package.json checks script targets against the index, blocking dangling scripts and allowing paired additions",
  () => {
    const { write, git, ok } = fixture();
    write(".github/workflows/ci.yml", "steps:\n  - run: node tools/scenario.mjs\n");
    write(
      "package.json",
      `${JSON.stringify({ name: "fixture", scripts: { good: "node tools/scenario.mjs" } }, null, 2)}\n`,
    );
    ok(["add", "--", ".github/workflows/ci.yml", "package.json"]);
    ok(["commit", "-m", "add workflow and package"]);

    const beforeBroken = ok(["rev-parse", "HEAD"]);
    write(
      "package.json",
      `${JSON.stringify({ name: "fixture", scripts: { broken: "node tools/missing-script.mjs" } }, null, 2)}\n`,
    );
    ok(["add", "--", "package.json"]);
    const brokenCommit = git(["commit", "-m", "dangling script"]);
    assert.notEqual(brokenCommit.status, 0, combined(brokenCommit));
    assert.match(combined(brokenCommit), /tools\/missing-script\.mjs/);
    assert.equal(ok(["rev-parse", "HEAD"]), beforeBroken);

    // Now stage BOTH the new script file and the package.json referencing it in one commit -> must succeed.
    write("tools/new-script.mjs", "export const x = 1;\n");
    write(
      "package.json",
      `${JSON.stringify({ name: "fixture", scripts: { added: "node tools/new-script.mjs" } }, null, 2)}\n`,
    );
    ok(["add", "--", "tools/new-script.mjs", "package.json"]);
    const pairedCommit = git(["commit", "-m", "paired script and package"]);
    assert.equal(pairedCommit.status, 0, combined(pairedCommit));
  },
);

testAcrossCommits("a staged growth that leaves its re-record behind is refused by name", () => {
  const { root, write, git, ok } = fixture();

  // The class crosses its ceiling and the record that says so is staged in the same commit: allowed.
  write(MOD_CLASS, modClass(1002));
  ok(["add", "--", MOD_CLASS]);
  rerecord(root);
  ok(["add", "--", COMPLEXITY_RECORD]);
  const carried = git(["commit", "-m", "the class grows, and its record travels with it"]);
  assert.equal(carried.status, 0, combined(carried));
  const recordedHead = ok(["rev-parse", "HEAD"]);

  // The same kind of growth with the record left where it was: refused, and named with both numbers.
  write(MOD_CLASS, modClass(1022));
  ok(["add", "--", MOD_CLASS]);
  const refused = git(["commit", "-m", "the class grows, the record does not"]);
  assert.notEqual(refused.status, 0, combined(refused));
  assert.match(
    combined(refused),
    /complexity_baseline_stale_for_this_commit:integrations\/stardew\/Fixture\.cs:cs:Fixture:\d+ lines\/2 methods->\d+ lines\/2 methods/,
    "the refusal names the file, the entry and the two numbers",
  );
  assert.match(
    combined(refused),
    /re-record: node gates\/arch\/check-cognitive-complexity\.mjs --update, then `git add tools\/cognitive-complexity-baseline.json`/,
    "and the command that makes the commit possible",
  );
  assert.equal(ok(["rev-parse", "HEAD"]), recordedHead, "a refused commit must not move HEAD");

  // The same growth again, this time with the re-record staged: allowed, and the commit carries the record.
  rerecord(root);
  ok(["add", "--", COMPLEXITY_RECORD]);
  const rerecorded = git(["commit", "-m", "the same growth, with its re-record"]);
  assert.equal(rerecorded.status, 0, combined(rerecorded));
  assert.equal(
    ok(["show", `HEAD:${COMPLEXITY_RECORD}`]),
    readFileSync(join(root, COMPLEXITY_RECORD), "utf8"),
    "the commit carries the record the gate wrote, byte for byte",
  );
});

test("a record that cannot be read refuses the commit with the reason", () => {
  const { write, git, ok } = fixture();
  const head = ok(["rev-parse", "HEAD"]);
  write(COMPLEXITY_RECORD, '{"members": [\n');
  ok(["add", "--", COMPLEXITY_RECORD]);

  const commit = git(["commit", "-m", "an unreadable record"]);
  assert.notEqual(commit.status, 0, combined(commit));
  assert.doesNotMatch(combined(commit), /is not iterable/, "a blocked reading is reported, not a crash");
  assert.match(
    combined(commit),
    /ratchet_record_unreadable_for_this_commit:tools\/cognitive-complexity-baseline\.json is not readable JSON/,
    "a record that cannot be read is a refusal that says why, never a pass",
  );
  assert.equal(ok(["rev-parse", "HEAD"]), head);
});

/**
 * The same defect in the duplication record: a copy is removed, the record still counts it, and the next author finds a
 * red tree. The group here is real - jscpd matches the same eight lines in three files - so the case proves the
 * duplication half through the gate's own scan rather than through an injected finding.
 */
const FIXTURE_STEP = `export const runFixtureStep = async (session, key) => {
  const receipt = await session.client.request(key);
  if (receipt.state !== "accepted") {
    throw new Error(\`fixture_step_refused:\${key}:\${receipt.state}\`);
  }
  session.receipts.set(key, receipt);
  return receipt;
};
`;

testAcrossCommits(
  "a removed copy leaves the duplication record stale, and the commit is refused with the group",
  () => {
    const { root, write, git, ok } = fixture();
    const steps = ["a", "b", "c"].map((suffix) => `tools/run-fixture-step-${suffix}.mjs`);
    for (const step of steps) write(step, FIXTURE_STEP);
    ok(["add", "--", ...steps]);
    // The record this tree needs, written by the gate that owns it: the first write is the only one allowed to name
    // groups the record has never held.
    rmSync(join(root, DUPLICATION_RECORD), { force: true });
    const recorded = spawnSync("node", ["gates/arch/check-code-duplication.mjs", "--write-baseline"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
    assert.equal(recorded.status, 0, `--write-baseline failed:\n${combined(recorded)}`);
    ok(["add", "--", DUPLICATION_RECORD]);
    const carried = git(["commit", "-m", "three copies and the record that counts them"]);
    assert.equal(carried.status, 0, combined(carried));
    const recordedHead = ok(["rev-parse", "HEAD"]);

    // One copy is removed and the record still says three: refused, naming the group and both counts.
    rmSync(join(root, steps[0]));
    ok(["add", "--", steps[0]]);
    const refused = git(["commit", "-m", "one copy is gone, the record is not"]);
    assert.notEqual(refused.status, 0, combined(refused));
    assert.match(
      combined(refused),
      /duplication_baseline_stale_for_this_commit:tools\/run-fixture-step-[abc]\.mjs:[0-9a-f]{12}:3 sites->gone from the tree/,
      "the refusal names the site file, the group and both counts",
    );
    assert.match(
      combined(refused),
      /re-record the shrink: node gates\/arch\/check-code-duplication\.mjs --record-shrinks, then `git add tools\/duplicate-code-baseline\.json`/,
      "and the command that makes the commit possible",
    );
    assert.equal(ok(["rev-parse", "HEAD"]), recordedHead, "a refused commit must not move HEAD");
  },
);
