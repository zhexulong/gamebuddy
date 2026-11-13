import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { cleanOutputLines } from "../lib/subprocess-output.mjs";

/**
 * Pre-commit hook: format what is being committed, so the formatting ratchet in CI stops seeing new
 * violations from authors who never ran the formatter.
 *
 * WHAT IT FORMATS IS THE INDEX, AND NOTHING ELSE. Each staged blob is read out of the object database, that exact
 * text is formatted through the formatter's stdin mode, and the result goes back with `git update-index
 * --cacheinfo`. The hook never writes a worktree file and never runs `git add`.
 *
 * Both of those are the defect it exists for and the defect it caused. On 2026-11-13 a lane staged a 2-line hunk of
 * `tools/run-tool-test-corpus.mjs` through a private `GIT_INDEX_FILE` and the hook printed the file's 2 added lines,
 * so the staged set was right - and then the hook formatted the WORKTREE copy `--write` and `git add`ed every path
 * whose worktree bytes the formatter had changed. The worktree held a neighbour's uncommitted 209-insertion rewrite
 * of that file, the formatter rewrote it, and the rewrite landed in that lane's commit (`d8567157`, 258 lines where
 * the index held 2). A private index is a promise that only that index's bytes are committed; re-adding from the
 * worktree broke the promise, and it broke it for any lane's in-flight work, not just that one file.
 *
 * The question "may I re-index this" is therefore answered against the index: the staged blob is compared with the
 * formatted staged blob. It used to be answered by comparing the worktree file with itself, which measures "did the
 * formatter change something on disk" - a question about the checkout, in a repository where the checkout is
 * several lanes' work in flight at once.
 *
 * Formatting the blob instead of the file is also the more accurate reading: the bytes the formatter sees are the
 * bytes the commit will carry (LF, as `.gitattributes` normalises), not whatever line endings the checkout holds.
 *
 * WHAT IT MUST NOT DO: CHANGE A CHARACTER. Measured on biome 2.2.4 over every non-ASCII codepoint this tree contains
 * (2010 of them, 2610 tracked formattable files): its stdin mode rewrites exactly five, and one of them is the marker
 * every gate in this tree prints - `✖` (U+2716) becomes `×` (U+00D7), `✔` becomes `√`, `ℹ` becomes `e`, `⚠` becomes
 * `!`, and U+FE0F is dropped. The same blob formatted as a FILE comes back byte-identical. So the hook formats a copy
 * of the staged blob in a scratch root that carries this checkout's own `biome.json`, never the stdin mode - the same
 * shape this file had at `e8f9c02d`, which a later commit carrying a stale base overwrote with the stdin one, and the
 * damage landed twice: `0100ae9a` committed `tools/check-gameplay-capability-catalog.test.mjs` with `✖`=0/`×`=2, and
 * `a1389e75` - the commit that restored them - came out EMPTY, because the hook formatted the restored blob back into
 * the bytes its parent already had.
 *
 * AND IT REFUSES TO TRUST THE RESULT: whatever the formatter's mode, the non-ASCII characters of the staged bytes must
 * survive it unchanged, or the staged blob is committed as the author wrote it and the reason is printed. A formatter
 * may reformat; it may not rewrite what a gate prints.
 *
 * Scope is deliberately narrow, and deliberately NOT tree-wide:
 *   - It formats the STAGED files, in the index. That removes the cause of the recurring red.
 *   - It typechecks the test project when the commit touches `host/src` (see the block at the end). That is
 *     the one build-shaped step here, and it is conditional on the commit actually being able to affect it:
 *     a commit that touches no Host source pays nothing for it.
 *   - It does NOT run the tree-wide ratchets as blockers. Those ratchets fail on any new violation
 *     anywhere in the tree, so blocking a commit on them would block one author for a neighbour's
 *     file - the failure mode that gets hooks uninstalled. The ratchets stay CI's job; the total is
 *     printed here as information.
 *   - No tests, no builds, no network. A hook that is slow is a hook everyone bypasses.
 *     (The one exception is the conditional test-project typecheck below, added 2026-10-31 when a commit
 *     landed three test files that did not compile; it runs only for a commit that touches Host sources.)
 *   - It PRINTS the staged set before doing anything, because in a shared checkout that set is not always
 *     the author's own (see the comment at that block).
 *
 * The worktree is left exactly as the author left it. A staged file that the formatter changes is committed
 * formatted while the author's copy stays unformatted, so `git status` keeps showing it: that is honest (the file
 * really is not what this commit contains) and it is the price of never writing to a path this hook did not stage.
 *
 * Escape hatch is git's own: `git commit --no-verify`.
 */
const FORMATTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css|md)$/i;
const BIOME = "node_modules/@biomejs/biome/bin/biome";
/** The modes whose content is text a formatter may rewrite. A symlink's blob is a target path, a gitlink has no blob. */
const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

const git = (args, options = {}) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26, ...options }).trim();

// NUL-separated, because a path with a quote or a non-ASCII byte is otherwise printed by git in its escaped form and
// every later `git` call in this file would then name a path that does not exist.
const staged = execFileSync(
  "git",
  // `--ignore-submodules=all` because this checkout carries junctioned submodules whose `gitfile` can be unreadable
  // (`vendor/magic-context/.git`), and git then refuses the whole diff with `fatal: gitfile does not point to a valid
  // repository`. That made every commit in the tree print "this commit does not compile" while nothing was wrong with
  // the code - measured 2026-11-13, three separate lanes blocked by it in one day. A hook that cannot read its input
  // must say so (see the refusal below), not accuse the source.
  ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR", "--ignore-submodules=all"],
  {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  },
)
  .split("\0")
  .filter((path) => path.length > 0);

// What is actually about to be committed, printed before anything else. In this repository several
// sessions share one checkout and one index, so a `git add` can be followed by a neighbour's `git add`,
// and a `git commit` without a pathspec then carries both - five commits landed that way in one evening,
// one of which moved a finished fix into an unrelated commit message. The list is the step everyone
// skips (the last staged set is invisible by the time the message is written), so the hook shows it.
// It warns, and never refuses: a mixed set is sometimes deliberate, and a hook that blocks on a guess is
// a hook that gets uninstalled (`--no-verify` is right there).
const summary = staged
  .slice(0, 25)
  .map((path) => `  ${path}`)
  .join("\n");
console.log(
  `pre-commit: staging ${staged.length} file(s):\n${summary}${staged.length > 25 ? `\n  …and ${staged.length - 25} more` : ""}`,
);
const owners = [...new Set(staged.map((path) => path.split("/")[0]))];
if (owners.length > 1) {
  console.log(
    `pre-commit: this commit spans ${owners.length} top-level directories (${owners.join(", ")}) - if only some of them are yours, commit with an explicit pathspec (\`git commit -F <msg> -- <paths>\`)`,
  );
}

const targets = staged.filter((path) => FORMATTABLE.test(path));

/** The index's own record of each target: mode, blob id, path. Never a path resolved against the worktree. */
const indexEntries = (paths) => {
  if (paths.length === 0) return [];
  const listing = execFileSync("git", ["ls-files", "-s", "-z", "--", ...paths], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  return listing
    .split("\0")
    .filter((record) => record.length > 0)
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, blob] = record.slice(0, tab).split(" ");
      return { mode, blob, path: record.slice(tab + 1) };
    });
};

/**
 * One non-ASCII character changed by a formatter, as `<the character it was> -> <the character it became>`.
 *
 * The whole non-ASCII sequence is compared rather than a count, because `✖` -> `×` and `×` -> `✖` are both one
 * character and only one of them is damage. Null when the sequences are equal.
 */
const changedCharacter = (before, after) => {
  const from = [...before].filter((character) => character.codePointAt(0) > 0x7f);
  const to = [...after].filter((character) => character.codePointAt(0) > 0x7f);
  for (let index = 0; index < Math.max(from.length, to.length); index += 1) {
    if (from[index] === to[index]) continue;
    const describe = (character) =>
      character === undefined
        ? "nothing"
        : `U+${character.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")} (${character})`;
    return `${describe(from[index])} -> ${describe(to[index])}`;
  }
  return null;
};

/**
 * The staged blob of one entry, formatted as a FILE at its own repository-relative path in a scratch root.
 *
 * The mirror is what makes the formatter read this checkout's configuration the way it reads the real tree: the
 * configuration is copied to the scratch root, so `files.includes` selects exactly what it selects here and a
 * directory the project excludes stays excluded. Returns null when the filter does not select the path - not a
 * failure: `biome format --write <path>` over this checkout would also have processed nothing.
 *
 * Never the stdin mode: see the header (U+2716 -> U+00D7 and four more).
 */
const formatStagedBlob = (staged, path, scratch) => {
  const mirrored = join(scratch, path);
  mkdirSync(dirname(mirrored), { recursive: true });
  writeFileSync(mirrored, staged);
  try {
    execFileSync(
      "node",
      [BIOME, "format", "--write", "--max-diagnostics=none", `--config-path=${join(scratch, "biome.json")}`, mirrored],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    // Biome exits 1 when every given path is one its configuration ignores (for example `fixtures/**`). That is not a
    // formatting failure, and blocking a commit on it would stop anyone from committing under an excluded directory.
    if (/were provided but ignored|No files were processed/i.test(detail)) return null;
    console.error(`pre-commit: the formatter failed on ${path}\n${detail}`);
    process.exit(1);
  }
  return readFileSync(mirrored);
};

const rewriteFormattedBlobs = (entries) => {
  const scratch = mkdtempSync(join(tmpdir(), "pre-commit-format-"));
  copyFileSync("biome.json", join(scratch, "biome.json"));
  const rewritten = [];
  const excluded = [];
  const preserved = [];
  for (const entry of entries) {
    if (!REGULAR_FILE_MODES.has(entry.mode)) continue;
    const stagedBytes = execFileSync("git", ["cat-file", "blob", entry.blob], { maxBuffer: 1 << 26 });
    const text = stagedBytes.toString("utf8");
    // A blob that does not survive a UTF-8 round trip is not text, and a formatter can only corrupt it.
    if (!Buffer.from(text, "utf8").equals(stagedBytes)) continue;
    const formatted = formatStagedBlob(stagedBytes, entry.path, scratch);
    if (formatted === null) {
      excluded.push(entry.path);
      continue;
    }
    if (formatted.equals(stagedBytes)) continue;
    // THE INVARIANT, checked on the bytes rather than trusted from the formatter's mode: a character the author wrote
    // is not formatting. When one moved, the staged blob wins - the author's bytes are committed, unformatted, and the
    // next line says so - because a commit that quietly carries a character nobody typed is the defect this hook was
    // fixed for twice.
    const changed = changedCharacter(text, formatted.toString("utf8"));
    if (changed !== null) {
      preserved.push(`${entry.path} (${changed})`);
      continue;
    }
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: formatted }).toString("utf8").trim();
    git(["update-index", "--cacheinfo", entry.mode, blob, entry.path]);
    rewritten.push(entry.path);
  }
  rmSync(scratch, { recursive: true, force: true });
  return { rewritten, excluded, preserved };
};

// AN EMPTY LIST IS A SKIP, NEVER AN INSTRUCTION TO FORMAT THE PROJECT. `biome format --write` with no paths formats
// everything its configuration includes, so a commit that stages no formattable file used to hand the whole checkout to
// the formatter - including another lane's gitignored scratch copy, whose own `biome.json` is a nested root. That is how
// `.tmp/redproof/tree` blocked every commit on 2026-11-11 with `Found a nested root configuration`: the population was
// empty and the formatter silently widened it to the repository.
//
// No `process.exit(0)` either: this hook has two blocking jobs at the end, and an early exit would skip them for
// exactly the commits that stage no formattable file.
if (targets.length === 0) {
  console.log("pre-commit: nothing formattable staged");
} else {
  const { rewritten, excluded, preserved } = rewriteFormattedBlobs(indexEntries(targets));
  if (rewritten.length === 0) {
    console.log(`pre-commit: the staged content of ${targets.length - excluded.length} file(s) is already formatted`);
  } else {
    console.log(`pre-commit: formatted ${rewritten.length} staged file(s) in the index: ${rewritten.join(", ")}`);
    console.log(
      "pre-commit: the worktree copy is untouched - run `node node_modules/@biomejs/biome/bin/biome format --write <paths>` if you want it to match what was committed",
    );
  }
  for (const site of preserved) {
    console.log(
      `pre-commit: NOT reformatting ${site}: the formatter changed a character this file contains, so the staged bytes are committed as written`,
    );
  }
  if (excluded.length > 0) {
    console.log(
      `pre-commit: biome.json's files.includes does not select ${excluded.join(", ")} - there is nothing to format there`,
    );
  }
}

for (const ratchet of ["tools/scripts/check-format-ratchet.mjs", "tools/scripts/check-lint-ratchet.mjs"]) {
  try {
    const line = cleanOutputLines(
      execFileSync("node", [ratchet], { encoding: "utf8", maxBuffer: 1 << 26 }).trim(),
    ).slice(-1)[0];
    console.log(`pre-commit: ${line}`);
  } catch (error) {
    const line = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split(/\r?\n/).slice(-1)[0];
    console.log(`pre-commit: ${line} (CI decides; this commit is not blocked by a tree-wide delta)`);
  }
}

// THE ONE BLOCKING STEP, and it is blocking on purpose.
//
// Every ratchet above is a delta against a tree-wide total, so none of them can answer "does the commit I am making
// compile". 32a13440 added three wire-agreement gates and 26 type errors; `pnpm build:test` is `noEmitOnError`, so it
// kept republishing the last artifact that compiled, and for as long as that lasted every `node --test dist-test/...`
// reading described code that no longer existed. A tree-wide budget cannot catch that: the errors landed inside
// allowance the baseline had banked from earlier decreases in the same codes.
//
// The check is scoped to the files IN THIS COMMIT, so a neighbour's in-flight edit cannot block it, and it prints the
// file and the first errors rather than a count. `check-staged-test-typecheck.mjs` does the scoping; this only runs it.
try {
  const result = execFileSync("node", ["host/scripts/check-staged-test-typecheck.mjs"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(
    `pre-commit: ${
      cleanOutputLines(result.trim())
        .filter((line) => line.length > 0)
        .slice(-1)[0]
    }`,
  );
} catch (error) {
  const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  if (typeof error.status !== "number") {
    console.error(`pre-commit: could not check the test project\n${detail || error.message}`);
    process.exit(1);
  }
  console.error(`pre-commit: this commit does not compile\n${detail}`);
  process.exit(1);
}

// THE SECOND BLOCKING STEP. Same scoping rule as the typecheck above: it fires only when a lockfile is
// in THIS commit, so a neighbour's lockfile edit cannot block someone else's work, and a commit that
// touches no lockfile pays nothing. See the header of check-lockfile-freeze.mjs for why a commit that
// changes a lockfile and not the readings about it is the failure being prevented.
try {
  const output = execFileSync("node", ["tools/scripts/check-lockfile-freeze.mjs"], {
    encoding: "utf8",
    maxBuffer: 1 << 26,
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(
    `pre-commit: ${
      cleanOutputLines(output.trim())
        .filter((line) => line.length > 0)
        .slice(-1)[0]
    }`,
  );
} catch (error) {
  const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  if (typeof error.status !== "number") {
    console.error(`pre-commit: could not check the lockfile freeze\n${detail || error.message}`);
    process.exit(1);
  }
  console.error(`pre-commit: the lockfile freeze does not describe this tree\n${detail}`);
  process.exit(1);
}
