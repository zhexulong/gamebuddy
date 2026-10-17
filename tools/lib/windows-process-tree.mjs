/**
 * Windows process-tree reclamation, and the sandbox cleanup that must not follow a link.
 *
 * Both exist because the two obvious implementations are silently wrong here:
 *
 *   - `child.kill()` does NOT kill a tree on Windows. The game is `Stardew Valley.exe` launched by
 *     `StardewModdingAPI.exe`, so killing the SMAPI child leaves the game running; every run relied on a human
 *     noticing and killing it by hand, and the fixture layer then reported `fixture busy (game=none, lock=true)`
 *     with orphaned transactions (measured repeatedly 2026-10-16/17).
 *   - A recursive delete of a sandbox that CONTAINS a junction writes through to the real target. `cmd /c rmdir`
 *     was measured to fail on this machine (exit 255), so it is not offered as a detach.
 *
 * Everything here kills and identifies by EXACT PID. Nothing matches an image name or a wildcard: a stray
 * `Stardew Valley.exe` belonging to the player is not this harness's to terminate.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readlinkSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** `taskkill` reports this when the process is already gone. It is the one tolerated failure. */
export const TASKKILL_ALREADY_EXITED_STATUS = 128;

/** The two image names a Stardew run consists of, used only to VERIFY that nothing survived. */
const STARDEW_IMAGE_NAMES = Object.freeze(["StardewModdingAPI", "Stardew Valley"]);

/**
 * Kill one process and its children by exact PID.
 *
 * Returns `"killed"`, or `"already_exited"` when `taskkill` reported 128 (the process finished on its own, which
 * is normal for a game the run closed politely). Any other failure is rethrown: a cleanup step that cannot tell
 * "nothing to do" from "could not do it" turns into the fault it was meant to prevent.
 *
 * The classification is by EXIT STATUS, never by message text: a non-English Windows reports
 * `错误: 找不到进程 "1234"。`, which contains no `not found` at all.
 */
export function killProcessTree(pid, { exec = execFileSync, timeoutMs = 60_000 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`invalid_process_pid:${String(pid)}`);
  try {
    exec("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", timeout: timeoutMs, windowsHide: true });
    return "killed";
  } catch (error) {
    if (error?.status === TASKKILL_ALREADY_EXITED_STATUS) return "already_exited";
    throw error;
  }
}

/**
 * The PIDs of every live Stardew image, as a fact to ASSERT on.
 *
 * This is the one place an image name is used, and it is read-only: the result is compared against what the run
 * launched, so "the tree was reclaimed" is checked rather than assumed. Killing still happens by exact PID.
 */
export function listStardewProcessIds({ exec = execFileSync, timeoutMs = 60_000 } = {}) {
  const names = STARDEW_IMAGE_NAMES.map((name) => `'${name}'`).join(",");
  const output = exec(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Get-Process -Name ${names} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id`,
    ],
    { encoding: "utf8", timeout: timeoutMs, windowsHide: true },
  );
  return Object.freeze(
    String(output)
      .trim()
      .split(/\s+/u)
      .filter((value) => value.length > 0)
      .map((value) => Number.parseInt(value, 10))
      .filter((value) => Number.isSafeInteger(value)),
  );
}

/**
 * Assert that no Stardew process survived this run.
 *
 * A co-op run launches Host and Client through `Start-Process`, so the tree can break or be elevated away from
 * the spawned child; without this check an orphan is discovered by the NEXT run's fixture refusing to start,
 * which reads as an unrelated failure. `launchedPids` are the PIDs the run itself recorded, and a survivor is
 * reported by identity rather than silently killed: a process this harness did not launch is not its to kill.
 */
export function assertNoSurvivingStardewProcesses({ launchedPids = [], list = listStardewProcessIds } = {}) {
  const survivors = list();
  if (survivors.length === 0) return Object.freeze({ survivors: Object.freeze([]), ours: Object.freeze([]) });
  const launched = new Set(launchedPids);
  return Object.freeze({
    survivors,
    ours: Object.freeze(survivors.filter((pid) => launched.has(pid))),
  });
}

/** What a path is, for the pre-delete walk: a link must be detached, never descended into. */
export function classifyPathEntry(path) {
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (metadata === undefined) return "missing";
  // `isSymbolicLink()` is TRUE for a Windows junction as well as a directory symlink, and `readlink` returns the
  // link's target for both. That is the whole test: measured on this machine (Node v24.21.0) - a junction reports
  // `isSymbolicLink()=true, isDirectory()=false` and `readdirSync({withFileTypes})` marks it `isSymbolicLink()`.
  // No subprocess and no attribute parsing is needed, and an entry that cannot be stat'ed is treated as a link so
  // the walk detaches it rather than descending into it.
  return metadata.isSymbolicLink() ? "reparse_point" : metadata.isDirectory() ? "directory" : "file";
}

/** The link's target, for a reader that wants to know where a detach pointed. */
export function linkTarget(path) {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Delete a run's sandbox without ever following a link out of it.
 *
 * Two steps, both required:
 *   1. walk bottom-up and UNLINK every reparse point (a junction is a link to a directory the sandbox does not
 *      own - writing through it lands in the real Mods tree, which is the live hazard, and the delete behaviour
 *      of `Remove-Item`/`fs.rm` on reparse points varies by version);
 *   2. only then `rm -r` what is left.
 *
 * Returns every detach it performed, so a reader can see the walk happened instead of trusting that it did.
 */
export function removeSandboxTree(root, { walk = walkEntries } = {}) {
  const detached = [];
  for (const entry of walk(root)) {
    if (classifyPathEntry(entry.path) !== "reparse_point") continue;
    unlinkSync(entry.path);
    detached.push(entry.path);
  }
  rmSync(root, { recursive: true, force: true });
  return Object.freeze({ detached: Object.freeze(detached) });
}

/** Every path under `root`, deepest first, so children are detached before their parents. */
function walkEntries(root) {
  const found = [];
  const visit = (directory, depth) => {
    let names;
    try {
      names = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(directory, name.name);
      found.push({ path, depth });
      // Descend only into a REAL directory: a link's `isDirectory()` is false and descending would be exactly the
      // escape this walk exists to prevent.
      if (!name.isSymbolicLink() && name.isDirectory()) visit(path, depth + 1);
    }
  };
  visit(root, 0);
  return found.sort((left, right) => right.depth - left.depth || right.path.length - left.path.length);
}
