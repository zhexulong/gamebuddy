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
  console.error(`pre-commit: the formatter failed\n${error.stdout ?? ""}${error.stderr ?? ""}`);
  process.exit(1);
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
