/**
 * What a ratchet's population is, shared by the two ratchets that scan a directory: the index, not the directory.
 *
 * The population is the index because a baseline can only be recorded against a tree state that exists in history; a
 * file that is not in the index is not yet anyone's. `biome format` and `biome lint` both walk the working tree, so
 * without this a lane's half-written file is measured as repository content and moves somebody else's baseline.
 * Measured 2026-11-12: an untracked `tools/check-source-shape-readers.mjs` took the format ratchet from `files=2` to
 * `files=3` with no commit behind it, and an untracked `tools/check-test-await-deadlines.mjs` added a fourth site to a
 * baselined clone group. Both files were other lanes' work in flight.
 *
 * What this cannot see, stated rather than hidden: a brand-new file is invisible to these gates until it is staged, so
 * "green before staging" says nothing about it. That is the correct reading - a commit hook and a CI run judge what the
 * commit would carry - but it means the census line has to be read for `untracked_not_counted`, which is why the count
 * is published with the paths rather than swallowed.
 */
import { execFileSync } from "node:child_process";

/** How many paths the published complement names before it summarises the rest. */
const NAMED_LIMIT = 5;

/**
 * The files under `roots` that exist in the worktree but not in the index.
 *
 * A `throw` rather than an empty set when git cannot answer: an empty set claims "nothing is untracked", which is the
 * opposite of what an unreadable index means, and it would silently widen the population back to the directory. Both
 * callers run inside a `main` that turns a throw into exit 2, so the reading is blocked rather than green.
 */
export function untrackedSources({ roots, root }) {
  let output = "";
  try {
    output = execFileSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", ...roots], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (error) {
    if (typeof error.status !== "number")
      throw new Error(`could not ask git what ${root} has not staged: ${error.message}`);
    // Exit 1 is "nothing untracked"; anything else is a run failure, not a clean scan.
    if (error.status !== 1)
      throw new Error(`git ls-files failed (exit ${error.status}) in ${root}: ${error.stderr ?? ""}`);
    output = error.stdout ?? "";
  }
  return new Set(
    output
      .split("\0")
      .filter(Boolean)
      .map((file) => file.replace(/\\/gu, "/")),
  );
}

/** `N: path, path, … and K more` - the count alone would hide which file the gate cannot see. */
export function describeUntracked(files) {
  const sorted = [...files].sort();
  const shown = sorted.slice(0, NAMED_LIMIT).join(", ");
  const rest = sorted.length - NAMED_LIMIT;
  return `${sorted.length}: ${shown}${rest > 0 ? `, … and ${rest} more` : ""}`;
}
