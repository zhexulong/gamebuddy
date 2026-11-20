// A failed phase's one line, carrying the refusal the phase named.
//
// Measured 2026-11-15: the operator's terminal said `Error: phase pin failed (exit 1)`. The cause -
// `DONE-PIN-FAIL (previous worktree could not be cleared)` and, before this change, a
// `pin_worktree_not_removed:` line - sat in `pin.log`, which nobody opened, because the terminal line
// read like a phase name plus a number and named neither what was wrong nor what to do. The kit's
// phases already name their refusals as `<snake_case_code>:<detail>`; this reads one out of the
// phase's OWN log and puts it on the line the operator actually sees.
//
// Measured 2026-11-20 (`.tmp/lane-livenow4.md`, r15): that line named the WRONG process. The capture
// phase exited 3 for `w-game-launch` and the operator read `z-game-disconnect`'s
// `game_never_reached_ready: the instance never reached instance=running` - a not-measured verdict
// about a driver that had not failed, because the reading took the last named code in an append-only
// log. A phase that runs one process per item says which item failed; the reason is kept in THAT
// item's own section, and the last code in the file belongs to whatever ran last.
import { readFileSync } from "node:fs";

/**
 * A refusal code is a snake_case word and its colon. Three characters is the shortest first segment the
 * kit uses (`cdp_port_held_by_pid`, `run_config_unreadable`, `pin_worktree_not_removed`), and a word
 * boundary never appears inside the identifier - so the rule is anchored on the START of the code and
 * not on a segment in its middle. A drive letter (`E:`), a `remedy:` sentence and a dashed flag carry no
 * underscore before their colon and cannot match.
 */
const NAMED_REFUSAL = /\b[a-z][a-z0-9]{2,}(?:_[a-z0-9]+)+:/u;

/** The header a phase writes before it runs one item, carrying that item's own key. */
const ITEM_SECTION = /^={3,}\s+(\S+)\s+={3,}$/u;

/** The phase's own record of an item it ran and that exited non-zero. */
const FAILED_ITEM = /\bDRIVER\s+(\S+)\s+FAILED\b/u;

/** A log's lines, or `null` when there is no log to read. */
function logLines(logPath) {
  if (logPath === null || logPath === undefined) return null;
  try {
    return readFileSync(logPath, "utf8").split("\n");
  } catch {
    return null;
  }
}

/**
 * The last refusal named in a set of lines, from its code to the end of that line, or `null`.
 *
 * The LAST one, because a log is append-only across attempts: the failure being reported is the most
 * recent, and an earlier attempt's code would name a cause that has already moved.
 */
function lastRefusalIn(lines) {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = NAMED_REFUSAL.exec(lines[index]);
    if (match !== null) return lines[index].slice(match.index).trim();
  }
  return null;
}

/**
 * The failing item a phase log records, with the refusal that item's own section named:
 * `{ item, refusal }`, where `refusal` is `null` when that item's section named no code.
 *
 * `null` when the log records no per-item failure at all - a phase that reports one refusal for the
 * whole run - so the caller keeps its plain reading instead of inventing an item.
 *
 * The LAST `DRIVER <key> FAILED` record wins, for the same reason the last refusal does: the log is
 * append-only across invocations, so the most recent failure is the one this exit is about.
 */
export function failingItemRefusal(logPath) {
  const lines = logLines(logPath);
  if (lines === null) return null;
  const sections = new Map();
  const failed = [];
  let section = null;
  for (const line of lines) {
    const header = ITEM_SECTION.exec(line);
    if (header !== null) {
      section = header[1];
      sections.set(section, []);
      continue;
    }
    const failure = FAILED_ITEM.exec(line);
    if (failure !== null) failed.push(failure[1]);
    // A line before any header belongs to the phase itself, not to an item: it is never that
    // item's refusal.
    if (section !== null) sections.get(section).push(line);
  }
  const item = failed.at(-1);
  if (item === undefined) return null;
  return Object.freeze({ item, refusal: lastRefusalIn(sections.get(item) ?? []) });
}

/** The last refusal a phase log names, from its code to the end of that line, or `null`. */
export function lastNamedRefusal(logPath) {
  const lines = logLines(logPath);
  return lines === null ? null : lastRefusalIn(lines);
}

/**
 * The one-line failure a phase exit becomes, with the phase's own refusal on it when it named one.
 *
 * The failing item is named first and its refusal second, because the two answer different
 * questions: which process this exit is about, and why that process ended. A phase whose log records
 * no per-item failure keeps the single refusal it named, exactly as before.
 */
export function describePhaseFailure({ phase, code, logPath }) {
  const head = `phase ${phase} failed (exit ${code})`;
  const lines = logLines(logPath);
  if (lines === null) return head;
  const failure = failingItemRefusal(logPath);
  if (failure !== null) return `${head} - ${failure.item}${failure.refusal === null ? "" : `: ${failure.refusal}`}`;
  const refusal = lastRefusalIn(lines);
  return `${head}${refusal === null ? "" : ` - ${refusal}`}`;
}
