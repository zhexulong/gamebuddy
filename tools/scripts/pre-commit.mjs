import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cleanOutputLines } from "../lib/subprocess-output.mjs";

/**
 * Pre-commit hook: format what is being committed, so the formatting ratchet in CI stops seeing new
 * violations from authors who never ran the formatter.
 *
 * WHAT IT FORMATS IS THE INDEX, AND NOTHING ELSE. Each staged blob is read out of the object database, formatted as a
 * file in a scratch root under the OS temp directory, and the result goes back with `git update-index --cacheinfo`.
 * The scratch root holds a copy of `biome.json` and the blob mirrored at its own repository-relative path, so the
 * configuration's rules and its `files.includes` filter select exactly what they select in this checkout. The hook
 * never writes a worktree file and never runs `git add`.
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
 * Formatting the blob instead of the worktree file is also the more accurate reading: the bytes the formatter sees are
 * the bytes the commit will carry (LF, as `.gitattributes` normalises), not whatever line endings the checkout happens
 * to hold. And it is a file rather than the formatter's stdin mode for a measured reason: `--stdin-file-path` on biome
 * 2.2.4 rewrites every `✖` (U+2716) in the text it is handed to `×` (U+00D7), so the stdin shape of this fix
 * committed a package.json whose red-proof prose had been changed - a formatter may reformat bytes, never alter them.
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
const staged = execFileSync("git", ["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMR"], {
  encoding: "utf8",
  maxBuffer: 1 << 26,
})
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
 * The staged blob of one entry, formatted by this checkout's own configuration and filter.
 *
 * The blob is materialised in a scratch root at its own repository-relative path, because that is the form the
 * configuration's `files.includes` is written against: mirrored there, exactly the files the format ratchet measures
 * are the files this formats, and a directory the project excludes stays excluded. Returns null when the filter does
 * not select the path (an excluded directory, a file above `files.maxSize`), which is not a failure - `biome format
 * --write <path>` over this checkout would also have processed nothing.
 *
 * NOT the formatter's stdin mode. Measured on biome 2.2.4: `--stdin-file-path` rewrites every `✖` (U+2716) in the text
 * it is handed to `×` (U+00D7) - a package.json carrying red-proof prose came back changed in a way no formatter has
 * any business changing - so the first shape of this fix committed a package.json that no author wrote. A formatting
 * hook may not alter content, and the file path is byte-exact.
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
    // Biome exits 1 when every given path is one its configuration ignores (for example `dialogue-web/tests/**`).
    // That is not a formatting failure, and blocking a commit on it would stop anyone from committing under an
    // excluded directory - so it passes, with the reason printed.
    if (/were provided but ignored|No files were processed/i.test(detail)) return null;
    rmSync(scratch, { recursive: true, force: true });
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
  for (const entry of entries) {
    if (!REGULAR_FILE_MODES.has(entry.mode)) continue;
    const staged = execFileSync("git", ["cat-file", "blob", entry.blob], { maxBuffer: 1 << 26 });
    const formatted = formatStagedBlob(staged, entry.path, scratch);
    if (formatted === null) {
      excluded.push(entry.path);
      continue;
    }
    if (formatted.equals(staged)) continue;
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { input: formatted }).toString("utf8").trim();
    git(["update-index", "--cacheinfo", entry.mode, blob, entry.path]);
    rewritten.push(entry.path);
  }
  rmSync(scratch, { recursive: true, force: true });
  return { rewritten, excluded };
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
  const { rewritten, excluded } = rewriteFormattedBlobs(indexEntries(targets));
  if (rewritten.length === 0) {
    console.log(`pre-commit: the staged content of ${targets.length - excluded.length} file(s) is already formatted`);
  } else {
    console.log(`pre-commit: formatted ${rewritten.length} staged file(s) in the index: ${rewritten.join(", ")}`);
    console.log(
      "pre-commit: the worktree copy is untouched - run `node node_modules/@biomejs/biome/bin/biome format --write <paths>` if you want it to match what was committed",
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
