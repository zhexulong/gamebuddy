import { execFileSync } from "node:child_process";

/**
 * Pre-commit hook: format what is being committed, so the formatting ratchet in CI stops seeing new
 * violations from authors who never ran the formatter.
 *
 * Scope is deliberately narrow, and deliberately NOT tree-wide:
 *   - It formats the STAGED files and re-stages them. That removes the cause of the recurring red.
 *   - It does NOT run the tree-wide ratchets as blockers. Those ratchets fail on any new violation
 *     anywhere in the tree, so blocking a commit on them would block one author for a neighbour's
 *     file - the failure mode that gets hooks uninstalled. The ratchets stay CI's job; the total is
 *     printed here as information.
 *   - No tests, no builds, no network. A hook that is slow is a hook everyone bypasses.
 *   - It PRINTS the staged set before doing anything, because in a shared checkout that set is not always
 *     the author's own (see the comment at that block).
 *
 * Escape hatch is git's own: `git commit --no-verify`.
 */
const FORMATTABLE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|jsonc|css|md)$/i;
const BIOME = "node_modules/@biomejs/biome/bin/biome";

const git = (args, options = {}) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 26, ...options }).trim();

const staged = git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"])
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

try {
  const output = execFileSync("node", [BIOME, "format", "--write", "--max-diagnostics=none", ...targets], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  console.log(`pre-commit: ${output.trim().split(/\r?\n/).slice(-1)[0] ?? "formatted"}`);
} catch (error) {
  const detail = `${error.stdout ?? ""}${error.stderr ?? ""}`;
  // Biome exits 1 when every given path is one its configuration ignores (for example
  // `dialogue-web/tests/**`). That is not a formatting failure, and blocking a commit on it would
  // stop anyone from committing under an ignored directory - so it passes, with the reason printed.
  if (/were provided but ignored|No files were processed/i.test(detail)) {
    console.log("pre-commit: nothing to format (the formatter ignores these paths)");
  } else {
    console.error(`pre-commit: the formatter failed\n${detail}`);
    process.exit(1);
  }
}

// Re-stage only the files this hook was allowed to touch: a formatting change must ride along with
// the commit it belongs to, and nothing else may be added to the index.
const changed = git(["diff", "--name-only", "--", ...targets])
  .split(/\r?\n/)
  .filter((path) => path.length > 0);
if (changed.length > 0) {
  execFileSync("git", ["add", "--", ...changed], { stdio: "inherit" });
  console.log(`pre-commit: re-staged ${changed.length} formatted file(s)`);
}

for (const ratchet of ["tools/scripts/check-format-ratchet.mjs", "tools/scripts/check-lint-ratchet.mjs"]) {
  try {
    const line = execFileSync("node", [ratchet], { encoding: "utf8", maxBuffer: 1 << 26 })
      .trim()
      .split(/\r?\n/)
      .slice(-1)[0];
    console.log(`pre-commit: ${line}`);
  } catch (error) {
    const line = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split(/\r?\n/).slice(-1)[0];
    console.log(`pre-commit: ${line} (CI decides; this commit is not blocked by a tree-wide delta)`);
  }
}
