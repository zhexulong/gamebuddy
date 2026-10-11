#!/usr/bin/env node
/**
 * Committer's pre-flight: does the staged set match the paths this commit names?
 *
 * The defect this exists for is a process one, not a code one. A lane ran a bare
 * `git commit` and swept another lane's staged files into its own commit: the
 * extra paths were not named by the commit, so the other lane's work landed under
 * a headline that did not describe it. A bare `git commit` cannot tell
 * "the files I edited" from "the files that happened to be staged"; naming the
 * paths is the only form that can, so this script checks the name against the
 * index.
 *
 *   node tools/check-commit-staging.mjs --explain             # inventory, never fails on content
 *   node tools/check-commit-staging.mjs -- <path> [<path>...] # the staged set must be exactly these
 *   node tools/check-commit-staging.mjs                       # inventory + staged-with-no-content
 *
 * Named-path mode is the exact check: it fails when the staged set and the named
 * set differ in either direction, and it names every difference. Use it before
 * `git commit -- <the same paths>`.
 *
 * Default mode is the fallback the owner asked for: it prints every staged path
 * with its status and fails when a staged path carries no content change at all
 * (staged bookkeeping that is not part of the change being committed). Paths that
 * are staged *and* still being edited in the working tree are printed as a
 * warning: they are the shape a collision takes right before it happens.
 *
 * This is deliberately a script a human runs, not a git hook. A hook would block
 * every other lane silently; whether to install one is the owner's call.
 */
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);

function git(...argv) {
  return execFileSync("git", argv, { encoding: "utf8" }).trim();
}

function splitNul(text) {
  return text.length === 0 ? [] : text.split("\0").filter((entry) => entry.length > 0);
}

/** `{ status, path }` for every staged path, from `git diff --cached --name-status -z`. */
function stagedEntries() {
  const tokens = splitNul(git("diff", "--cached", "--name-status", "-z"));
  const entries = [];
  for (let index = 0; index < tokens.length; ) {
    const status = tokens[index++];
    if (status.startsWith("R") || status.startsWith("C")) {
      // rename/copy: the source path follows the destination path
      const from = tokens[index++];
      const to = tokens[index++];
      entries.push({ status, path: to, from });
    } else {
      entries.push({ status, path: tokens[index++] });
    }
  }
  return entries.map((entry) => ({ ...entry, path: entry.path.replace(/\\/gu, "/") }));
}

function numstatByPath() {
  const map = new Map();
  for (const line of git("diff", "--cached", "--numstat").split("\n")) {
    if (line.trim().length === 0) continue;
    const [added, deleted, ...rest] = line.split("\t");
    map.set(rest.join("\t").replace(/\\/gu, "/"), { added, deleted });
  }
  return map;
}

function worktreePaths(command) {
  return new Set(splitNul(git(...command)).map((path) => path.replace(/\\/gu, "/")));
}

const staged = stagedEntries();
if (staged.length === 0) {
  console.log("nothing is staged");
  process.exit(0);
}

const numstat = numstatByPath();
const unstaged = worktreePaths(["diff", "--name-only", "-z"]);
const untracked = worktreePaths(["ls-files", "--others", "--exclude-standard", "-z"]);

/** A staged path that carries no content: staged bookkeeping, not authored change. */
function carriesNoContent(path) {
  const stat = numstat.get(path);
  return stat !== undefined && stat.added === "0" && stat.deleted === "0";
}

function report(headline) {
  console.log(headline);
  for (const entry of staged) {
    const marks = [entry.status.padEnd(2)];
    if (entry.from !== undefined) marks.push(`from ${entry.from}`);
    if (carriesNoContent(entry.path)) marks.push("NO CONTENT");
    if (unstaged.has(entry.path)) marks.push("also edited in the working tree");
    if (untracked.has(entry.path)) marks.push("untracked");
    console.log(`  ${entry.path}  [${marks.join(" | ")}]`);
  }
}

if (args.length > 0 && args[0] !== "--explain" && args[0] !== "--") {
  console.error("usage: node tools/check-commit-staging.mjs [--explain | -- <path> [<path>...]]");
  process.exit(2);
}

if (args[0] === "--") {
  const named = [...new Set(args.slice(1).map((path) => path.replace(/\\/gu, "/")))].sort();
  if (named.length === 0) {
    console.error("named-path mode needs at least one path after --");
    process.exit(2);
  }
  const stagedPaths = staged.map((entry) => entry.path).sort();
  const inStaged = new Set(stagedPaths);
  const inNamed = new Set(named);
  const notStaged = named.filter((path) => !inStaged.has(path));
  const notNamed = stagedPaths.filter((path) => !inNamed.has(path));
  report(
    notStaged.length === 0 && notNamed.length === 0
      ? `check-commit-staging: the staged set is exactly the ${named.length} named path(s)`
      : "check-commit-staging: the staged set and the named paths differ",
  );
  if (notStaged.length > 0) console.error(`named but not staged: ${notStaged.join(", ")}`);
  if (notNamed.length > 0) {
    console.error(`staged but not named by this commit (another lane's work?): ${notNamed.join(", ")}`);
    console.error("Name every path, or commit with an explicit pathspec: git commit -- <path> [<path>...]");
  }
  process.exit(notStaged.length === 0 && notNamed.length === 0 ? 0 : 1);
}

const empty = staged.filter((entry) => carriesNoContent(entry.path)).map((entry) => entry.path);
report(
  empty.length === 0
    ? "check-commit-staging: every staged path carries a content change"
    : "check-commit-staging: staged paths that carry no content change",
);
if (args[0] === "--explain") process.exit(0);
if (empty.length > 0) {
  console.error(`\nStaged with no content change: ${empty.join(", ")}`);
  console.error("That is index bookkeeping, not the change being committed. Unstage it, or name it explicitly.");
  process.exit(1);
}
console.log("(this mode cannot see the commit's intent; named-path mode can: -- <path> [<path>...])");
