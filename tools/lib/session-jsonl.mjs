/**
 * A session record, read as entries.
 *
 * WHY THIS FILE EXISTS. A session JSONL is read by the A/B live runner and by the cost account, and each of them spelled
 * the same four-step preamble - split on newlines, skip the blank line, `JSON.parse` in a `try`, skip what does not
 * parse - three times in the runner and once in the reader. `tools/check-code-duplication.mjs` read two of those windows
 * as STRUCTURAL duplication at three sites each on the 2026-11-15 tree. The skip is not a decision either caller makes
 * differently: a killed run leaves a half-written last line, and the honest reading is to skip it rather than repair it.
 */

/** The parsed entries of a session JSONL, in file order. A blank or half-written line is skipped, never repaired. */
export function sessionEntries(raw) {
  const entries = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {}
  }
  return entries;
}
