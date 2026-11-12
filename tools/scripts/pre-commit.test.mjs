/**
 * A commit carries the bytes that were staged, and the pre-commit hook may not put any other bytes there.
 *
 * The hook formats what is being committed. It used to do that by running the formatter `--write` over the STAGED
 * PATHS as the worktree resolves them, and then `git add`ing every path whose worktree bytes the formatter had
 * changed. In this repository the worktree is several lanes' work in flight, so "the formatter changed this file"
 * was answered about a file that a neighbour was editing: on 2026-11-13 a lane staged a 2-line hunk of the tool-test
 * corpus runner through a private index, a neighbour's 258-line rewrite of that file sat in the worktree, the
 * formatter rewrote two characters of it, and `git add` put the whole rewrite into that lane's commit (`d8567157`).
 * A private index promised only the lane's hunks; the re-stage broke the promise.
 *
 * The suite runs the REAL hook (the tracked hook wrapper and the script it execs, copied out of this tree) in a
 * fixture repository, and asserts on what the commit contains. The formatter is a stand-in for one reason: it is
 * another process, and its CLI is a boundary this suite does not own. The stand-in reproduces both of its modes -
 * `--write` rewrites files, `--stdin-file-path=<path>` formats stdin to stdout, with the character defect the real
 * stdin mode has - so a hook that goes back to rewriting worktree files, or to the stdin mode that changed a
 * committed mark to another one, fails these tests on their substance rather than on a missing feature.
 *
 * red-proof: inject  the hook's pre-fix shape restored - the formatter run `--write` over the staged paths as the
 *                    worktree resolves them, then `git add` on every path whose worktree bytes it changed ->
 *                    `✖ a commit carries the staged bytes when the worktree holds a foreign hunk` and
 *                    `✖ with GIT_INDEX_FILE the hook formats that index and leaves the shared one alone`,
 *                    with the neighbour's whole rewrite committed where the index held 2 insertions
 * red-proof: inject  the formatter's stdin mode substituted for the file it formats (biome 2.2.4 rewrites one mark to
 *                    another there) -> the same test: the committed blob reads the rewritten mark where the staged
 *                    blob reads the author's
 *
 * Red on the pre-fix hook, measured in a copy of this tree at `d8567157^`: with the same scenario the old hook
 * committed 210 insertions and 61 deletions (the neighbour's rewrite) where the index held 2 insertions.
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
const COPIED_FILES = ["tools/git-hooks/pre-commit", "tools/scripts/pre-commit.mjs", "tools/lib/subprocess-output.mjs"];

/** The steps the hook runs after formatting. None of them is this suite's subject, and each one must not block here. */
const STUBBED_STEPS = [
  "host/scripts/check-staged-test-typecheck.mjs",
  "tools/scripts/check-format-ratchet.mjs",
  "tools/scripts/check-lint-ratchet.mjs",
  "tools/scripts/check-lockfile-freeze.mjs",
];

/**
 * A formatter process: both CLI modes, and a record of every invocation so "no formatter ran" is observable.
 *
 * The stdin mode keeps the one defect the real binary has (measured on biome 2.2.4): it rewrites `✖` to `×` in the
 * text it hands back. A hook that formats through stdin must fail these tests for the same reason - a commit that
 * carries characters no author wrote is the defect this suite measures.
 */
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
if (subcommand !== "format") {
  process.stderr.write("formatter fixture: only the format subcommand is reproduced, got " + subcommand + "\\n");
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
process.stdout.write(format_(readFileSync(0, "utf8")).replaceAll("✖", "×"));
`;

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "pre-commit-hook-"));
  const write = (relative, content) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
  };
  for (const file of COPIED_FILES) write(file, readFileSync(join(REPOSITORY_ROOT, file)));
  write("node_modules/@biomejs/biome/bin/biome", FORMATTER);
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
  write(SCENARIO, "export const base = { a: 1 };\n// ✖ marks the step node's reporter failed\n");
  ok(["add", "-A"]);
  ok(["commit", "-m", "fixture"]);
  rmSync(join(root, FORMATTER_LOG), { force: true });
  return { root, write, git, ok };
};

const combined = (result) => `${result.stdout ?? ""}${result.stderr ?? ""}`;

test("a commit carries the staged bytes when the worktree holds a foreign hunk", () => {
  const { root, write, git, ok } = fixture();
  write(
    SCENARIO,
    "export const base = { a: 1 };\nexport const lane = { b: 2 };\n// ✖ marks the step node's reporter failed\n",
  );
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
  write(SCENARIO, "export const lane = {p:8};\n// ✖ stays as written\n");
  ok(["add", "--", SCENARIO]);

  const commit = git(["commit", "-m", "unformatted"]);
  assert.equal(commit.status, 0, combined(commit));
  assert.equal(ok(["show", `HEAD:${SCENARIO}`]), "export const lane = { p: 8 };\n// ✖ stays as written\n");
  assert.equal(
    readFileSync(join(root, SCENARIO), "utf8"),
    "export const lane = {p:8};\n// ✖ stays as written\n",
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
