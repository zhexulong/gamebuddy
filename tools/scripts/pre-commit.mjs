import { execFileSync } from "node:child_process";

/**
 * Pre-commit hook: format what is being committed, so the formatting ratchet in CI stops seeing new
 * violations from authors who never ran the formatter.
 *
 * Scope is deliberately narrow, and deliberately NOT tree-wide:
 *   - It formats the STAGED content and writes the result back to the index. That removes the cause
 *     of the recurring red without touching the worktree.
 *   - It does NOT run the tree-wide ratchets as blockers. Those ratchets fail on any new violation
 *     anywhere in the tree, so blocking a commit on them would block one author for a neighbour's
 *     file - the failure mode that gets hooks uninstalled. The ratchets stay CI's job; the total is
 *     printed here as information.
 *   - No tests, no builds, no network. A hook that is slow is a hook everyone bypasses.
 *   - It PRINTS the staged set before doing anything, because in a shared checkout that set is not always
 *     the author's own (see the comment at that block).
 *
 * Why it formats the staged blob and not the file on disk: several sessions share one checkout, so a
 * file on disk routinely holds a neighbour's unstaged hunk. Running the formatter on the file and then
 * `git add`-ing it moves that neighbour's work into this commit - proven in
 * `tools/scratch/prove-precommit-absorbs.mjs`, and the reason a private index (`GIT_INDEX_FILE`) was
 * not enough on its own. Reading `:path`, formatting it through stdin and updating the index entry
 * leaves the worktree byte-for-byte as it was.
 *
 * Escape hatch is git's own: `git commit --no-verify`.
 */
const FORMATTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css|md)$/i;
const BIOME = "node_modules/@biomejs/biome/bin/biome";

const git = (args, options = {}) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26, ...options });

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
  .trim()
  .split(/\r?\n/)
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
if (targets.length === 0) {
  console.log("pre-commit: nothing formattable staged");
  process.exit(0);
}

const indexEntry = (path) => {
  // `<mode> <oid> <stage>\t<path>` - the stage is always 0 for a committed entry.
  const line = git(["ls-files", "-s", "--", path]).trim();
  if (line.length === 0) return null;
  const [meta] = line.split("\t");
  const [mode, oid] = meta.split(" ");
  return { mode, oid };
};

let rewritten = 0;
const failures = [];
for (const path of targets) {
  const entry = indexEntry(path);
  if (entry === null) continue;
  const original = git(["cat-file", "-p", entry.oid]);
  let formatted;
  try {
    formatted = execFileSync("node", [BIOME, "format", `--stdin-file-path=${path}`, "--max-diagnostics=none"], {
      input: original,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 1 << 26,
    });
  } catch (error) {
    const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    // Biome exits 1 when the path is one its configuration ignores, or when it has no formatter for
    // that language (`The content was not formatted because the formatter is currently disabled`).
    // Neither is a formatting failure, and blocking a commit on them would stop anyone from
    // committing under an ignored directory - so it passes, with the reason reported once.
    if (/were provided but ignored|No files were processed|not supported|formatter is currently disabled/i.test(detail))
      continue;
    failures.push(`${path}\n${detail}`);
    continue;
  }

  // The formatter's output is the staged blob's replacement. Compare through the object store so a
  // CRLF worktree, a trailing newline or the executable bit cannot make an identical file look newer.
  const next = execFileSync("git", ["hash-object", "-w", "--stdin"], {
    input: formatted,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  }).trim();
  if (next === entry.oid) continue;
  git(["update-index", "--cacheinfo", `${entry.mode},${next},${path}`]);
  rewritten += 1;
}

if (failures.length > 0) {
  console.error(`pre-commit: the formatter failed\n${failures.join("\n")}`);
  process.exit(1);
}

console.log(
  rewritten === 0
    ? "pre-commit: every staged file was already formatted"
    : `pre-commit: reformatted ${rewritten} staged file(s); the worktree was not touched`,
);

try {
  const ratchetLines = [];
  for (const ratchet of ["tools/scripts/check-format-ratchet.mjs", "tools/scripts/check-lint-ratchet.mjs"]) {
    try {
      const line = execFileSync("node", [ratchet], { encoding: "utf8", maxBuffer: 1 << 26 })
        .trim()
        .split(/\r?\n/)
        .slice(-1)[0];
      if (line !== undefined) ratchetLines.push(`  ${line}`);
    } catch (error) {
      const line = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split(/\r?\n/).slice(-1)[0];
      if (line !== undefined && line.length > 0) ratchetLines.push(`  ${line}`);
    }
  }
  if (ratchetLines.length > 0) console.log(`pre-commit: ratchets (information only)\n${ratchetLines.join("\n")}`);
} catch {
  // The ratchets are information. A hook that fails on them is a hook everyone bypasses.
}
