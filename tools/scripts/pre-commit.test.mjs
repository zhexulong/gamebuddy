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
 * red-proof: history  the pre-fix hook replayed from `d8567157^` in a copy of this tree, over the same scenario,
 *                     committed 210 insertions and 61 deletions - the neighbouring lane's whole rewrite - where the
 *                     index held 2 insertions -> `✖ a commit carries the staged bytes when the worktree holds a
 *                     foreign hunk`, exit 1 (tools/scripts/pre-commit.test.mjs)
 * red-proof: inject  a formatter that rewrites a character, and a hook that takes its output -> `✖ a character the
 *                     author wrote is not formatting`, the commit carries `×` where `✖` was staged (undo the guard in
 *                     `rewriteFormattedBlobs` to see it)
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCENARIO = "tools/scenario.mjs";
const FORMATTER_LOG = ".formatter-invocations";

/** The hook, and the library it imports, taken from this tree so the suite cannot agree with a hook that is not there. */
const COPIED_FILES = [
  "tools/git-hooks/pre-commit",
  "tools/scripts/pre-commit.mjs",
  "tools/scripts/check-file-complexity-gate.mjs",
  "tools/scripts/check-script-entry-existence.mjs",
  "tools/scripts/cli-entry.mjs",
  "tools/lib/subprocess-output.mjs",
];

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
  for (const step of STUBBED_STEPS) write(step, `process.stdout.write("${step}: stub\\n");\n`);
  write(".gitignore", "node_modules/\n.formatter-invocations\n");
  write("biome.json", "{}\n");

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
  ok(["commit", "-m", "fixture"]);
  rmSync(join(root, FORMATTER_LOG), { force: true });
  return { root, write, git, ok };
};

const combined = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

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

test("staged conflict markers and scratch debris paths refuse the commit", () => {
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

test("a staged lint error refuses the commit while an unstaged neighbor lint error does not", () => {
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

test("staging package.json checks script targets against the index, blocking dangling scripts and allowing paired additions", () => {
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
});
