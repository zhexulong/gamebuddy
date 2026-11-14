// A failed phase's one line, carrying the refusal the phase named.
//
// Measured 2026-11-15: the operator's terminal said `Error: phase pin failed (exit 1)`. The cause -
// `DONE-PIN-FAIL (previous worktree could not be cleared)` and, before this change, a
// `pin_worktree_not_removed:` line - sat in `pin.log`, which nobody opened, because the terminal line
// read like a phase name plus a number and named neither what was wrong nor what to do. The kit's
// phases already name their refusals as `<snake_case_code>:<detail>`; this reads the last one out of
// the phase's OWN log and puts it on the line the operator actually sees.
import { readFileSync } from "node:fs";

/** A refusal code is a snake_case word and its colon; a path's drive letter or a sentence cannot match. */
const NAMED_REFUSAL = /\b[a-z][a-z0-9]{3,}(?:_[a-z0-9]+)+:/u;

/**
 * The last refusal a phase log names, from its code to the end of that line, or `null`.
 *
 * The LAST one, because a log is append-only across attempts: the failure being reported is the most
 * recent, and an earlier attempt's code would name a cause that has already moved.
 */
export function lastNamedRefusal(logPath) {
  let text;
  try {
    text = readFileSync(logPath, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = NAMED_REFUSAL.exec(lines[index]);
    if (match !== null) return lines[index].slice(match.index).trim();
  }
  return null;
}

/** The one-line failure a phase exit becomes, with the phase's own refusal on it when it named one. */
export function describePhaseFailure({ phase, code, logPath }) {
  const refusal = logPath === null || logPath === undefined ? null : lastNamedRefusal(logPath);
  return `phase ${phase} failed (exit ${code})${refusal === null ? "" : ` - ${refusal}`}`;
}
