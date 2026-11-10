/**
 * This attempt's result, or the reading that says the file on disk is a previous attempt's.
 *
 * A result bundle is named after the run, not after the attempt, so an attempt that crashed before writing one leaves
 * the previous attempt's file exactly where the reader looks for its own — and it reads it. Measured 2026-11-09
 * (`round40`): attempt 1 answered `crossings 0 of 2` from attempt 2's bundle. Two decisions fix that and they live here,
 * in one place, for every caller:
 *
 *   - a bundle already at that path is MOVED ASIDE before the launch, never deleted: it is the only record of a run that
 *     may have cost 34 minutes, so renaming keeps the evidence and removes the hazard;
 *   - a bundle whose write time precedes the launch is not this attempt's answer, whatever it says.
 *
 * The label and freshness rules are `tools/lib/live-run-bundle.mjs`' own; this module adds only the file operations and
 * the sentence a reader is given, so there is no second spelling of either rule.
 */
import { existsSync, lstatSync, renameSync, statSync } from "node:fs";
import { basename } from "node:path";
import { assessResultFreshness, supersededResultName } from "../../lib/live-run-bundle.mjs";

/** The reading a reader is given instead of a result that is not this attempt's. */
export const STALE_RESULT_PRECEDES_LAUNCH = "stale_result_precedes_launch";

/**
 * Move the bundle already at `resultPath` aside and return where it went, or `null` when there was none.
 *
 * A symlink or anything that is not a regular file is refused rather than moved: the rename would either follow a link
 * this tool does not own or replace a directory it cannot restore.
 */
export function supersedePreviousResult({ resultPath, nowMs = Date.now() }) {
  if (!existsSync(resultPath)) return null;
  const stat = lstatSync(resultPath);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error(`refusing to move a non-regular result aside: ${resultPath}`);
  const aside = supersededResultName(resultPath, nowMs);
  renameSync(resultPath, aside);
  return aside;
}

/**
 * What the bundle at `resultPath` says about THIS attempt: `absent` (nothing was written), `fresh` (written after the
 * launch, so it is this attempt's) or `stale` — with the sentence naming what was read and how far behind it was.
 */
export function judgeResultFreshness({ resultPath, launchedAtMs }) {
  if (!existsSync(resultPath)) return { state: "absent", behindMs: 0, reading: null };
  const { fresh, behindMs } = assessResultFreshness({ mtimeMs: statSync(resultPath).mtimeMs, launchedAtMs });
  if (fresh) return { state: "fresh", behindMs: 0, reading: null };
  return {
    state: "stale",
    behindMs,
    reading:
      `${STALE_RESULT_PRECEDES_LAUNCH}: ${basename(resultPath)} was written ` +
      `${String(Math.round(behindMs / 1000))}s before this attempt started`,
  };
}
