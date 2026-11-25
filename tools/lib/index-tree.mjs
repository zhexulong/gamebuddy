/**
 * THE TREE A COMMIT WILL CARRY, MATERIALISED ONCE, SO EVERY RATCHET READS THE SAME BYTES.
 *
 * WHY THIS EXISTS, measured 2026-11-25. Two commands measure the same ratchets and had picked different trees:
 * `node gates/arch/check-cognitive-complexity.mjs --update` measured the WORKTREE, while the pre-commit hook (which
 * judges the re-record) measures the INDEX, because the index is what the commit carries. In a shared checkout holding
 * 150 files from other lanes, the author ran `--update` - which recorded the directory it happened to stand in,
 * including those lanes' uncommitted `.cs` - staged the record, and the hook refused the commit with
 * `complexity_baseline_stale_for_this_commit:integrations/stardew/…/BodyProgramAuthorityTests.cs:…`. NO re-record could
 * ever satisfy it: one reading was of the directory, the other of the index. The author's next move was `--no-verify`,
 * which is how a ratchet gets switched off - and the cost of the defect was not a wrong number, it was a gate nobody can
 * use.
 *
 * THE INDEX IS THE TREE, and the reason is not symmetry, it is what a record is FOR. A baseline's numbers exist to be
 * compared with the tree a commit produces, on every commit, by the hook and by CI. A number measured anywhere else
 * describes something nobody will ever build. So `--update`, `--write-baseline` and `--record-shrinks` measure the index
 * exactly as the hook does, and the three cannot drift apart again because there is one implementation of "give me that
 * tree" and one implementation of "which measured paths are not in it".
 *
 * HOW. `git checkout-index` writes the index into a throwaway directory, honouring `GIT_INDEX_FILE`, so a lane with a
 * private index gets ITS index read rather than the shared one. `repository: true` additionally makes that directory a
 * repository (`git init` + `git add -N .`) for the duplication gate, which asks git which files the index does not hold
 * and would read an empty answer as "nothing is untracked" if the directory were not one.
 *
 * WHAT IT CANNOT SEE: nothing about the worktree. `git checkout-index` writes committed-or-staged bytes only, so a file a
 * lane has written and not staged does not exist in the tree at all, and a `.gitignore`d file never will. That is the
 * correct reading for a record, and it is also why `refuseUncommittedMeasurements` exists: an author who records without
 * staging has measured the index and *meant* their directory, so the recording says so out loud instead of writing a
 * number that will be refused at the commit.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

/** The one spelling of the refusal a recording prints when the worktree holds measured bytes the index does not. */
export const UNCOMMITTED_MEASUREMENT = "baseline_would_record_uncommitted_measurements";

/** One git command, with its status handed back rather than thrown: every caller here decides what a failure means. */
const git = (cwd, args, spawn) =>
  spawn("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1 << 26,
  });

const firstLine = (text) =>
  String(text ?? "")
    .trim()
    .split("\n")[0]
    .trim();

/**
 * Are these two readings of one directory the same tree? Resolved, and compared without case on Windows, because git
 * prints its own spelling of the path (`c:/users/...` for `C:\Users\...`) and a case-sensitive compare would call this
 * checkout "not the repository" and block every recording.
 */
const sameTree = (left, right) => {
  const [a, b] = [resolve(left), resolve(right)];
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
};

/**
 * The index of `root` as a directory on disk, and the disposal that removes it.
 *
 * `root` must BE the worktree root of the repository whose index is read, and the check is not pedantry: measured on this
 * machine, `git` run in a throwaway directory under `%TEMP%` resolves the repository at `C:\Users\long`, a real checkout
 * with its own index - so a fixture that meant "no repository" would have been recorded from a stranger's index, silently.
 * A tree git does not resolve to `root` is `git_index_unreadable:<root>` naming where git went instead.
 *
 * `repository` costs a measured 1.00-1.10 s on this checkout (`git init` 0.06 s + `git add -N .` 0.96 s, 4,300 tracked
 * files) and is asked for only by the gate that queries git inside the tree; a caller that just measures sources does not
 * pay it. The checkout itself is 1.8-2.9 s, resolving the repository 0.03 s and the disposal 0.30-0.52 s, so the whole
 * reading is 2.1-3.5 s - or 3.1-4.6 s with a repository - which is why `--update` builds this tree ONCE per run and never
 * a second time for its own verdict.
 */
export function materializeIndexTree({ root = process.cwd(), repository = false, spawn = spawnSync } = {}) {
  const tree = mkdtempSync(join(tmpdir(), "index-tree-"));
  const unreadable = (detail) => {
    rmSync(tree, { recursive: true, force: true });
    return { error: `git_index_unreadable:${root}${detail === "" ? "" : `:${detail}`}` };
  };
  const top = git(root, ["rev-parse", "--show-toplevel"], spawn);
  if (top.status !== 0) return unreadable(firstLine(top.stderr));
  const worktree = firstLine(top.stdout);
  if (!sameTree(worktree, root)) return unreadable(`git resolves the repository at ${worktree}, not this tree`);
  const checkout = git(root, ["checkout-index", "-a", `--prefix=${tree}${sep}`], spawn);
  if (checkout.status !== 0) return unreadable(firstLine(checkout.stderr));
  if (repository) {
    for (const args of [
      ["init", "-q"],
      ["add", "-N", "."],
    ]) {
      const outcome = git(tree, args, spawn);
      if (outcome.status !== 0) return unreadable(`git ${args[0]}: ${firstLine(outcome.stderr)}`);
    }
  }
  return { root: tree, dispose: () => rmSync(tree, { recursive: true, force: true }) };
}

/**
 * Every path whose worktree bytes are not the index's: the tracked paths `git diff` reports, plus the paths git does not
 * hold at all. Both halves are git's own answer, so no directory walk can disagree with the index about what a file is.
 *
 * A `Set` because a path can be named twice by one reading and its `\`-separated spelling must not make two candidates of
 * it; the paths are forward-slashed so they compare with the ones the gates derive from their own populations.
 */
export function worktreeChanges({ root = process.cwd(), spawn = spawnSync } = {}) {
  const changed = new Set();
  for (const args of [
    ["diff", "--name-only", "-z", "--no-color"],
    ["ls-files", "--others", "--exclude-standard", "-z"],
  ]) {
    const outcome = git(root, args, spawn);
    if (outcome.status !== 0) return { error: `git_index_unreadable:${root}` };
    for (const name of String(outcome.stdout ?? "").split("\0"))
      if (name !== "") changed.add(name.replaceAll("\\", "/"));
  }
  return { files: changed };
}

/**
 * The refusal, printed and named in one place: one `baseline_would_record_uncommitted_measurements:<path>` per measured
 * path whose worktree bytes the index does not hold, and one sentence saying what to do about them.
 *
 * `measures` is the calling gate's own population predicate, because what a ratchet measures is the gate's fact and not
 * this module's: a path outside it cannot make a recording wrong, and refusing on one would make the command unusable in
 * the shared checkout this module exists for - 150 files of other lanes' work is the normal state, and only the ones the
 * record reads are this author's problem.
 */
export function refuseUncommittedMeasurements({ root, measures, sink = console.error, spawn = spawnSync }) {
  const changes = worktreeChanges({ root, spawn });
  if (changes.error !== undefined) return { error: changes.error };
  const files = [...changes.files].filter(measures).sort();
  if (files.length === 0) return { refused: false };
  for (const file of files) sink(`${UNCOMMITTED_MEASUREMENT}:${file}`);
  sink(
    `${UNCOMMITTED_MEASUREMENT}: ${files.length} measured path(s) above hold worktree bytes the index does not. A record ` +
      "is measured on the index - the bytes a commit carries - so recording now would write numbers for code no commit " +
      "holds: `git add` these paths (or undo them) and record again",
  );
  return { refused: true };
}
