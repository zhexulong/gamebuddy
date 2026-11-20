import { readFileSync } from "node:fs";

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

/** The same, for a session FILE: the reader every tool holds is the one that skips rather than repairs. */
export function readSessionEntries(path) {
  return sessionEntries(readFileSync(path, "utf8"));
}

/**
 * The JSON a tool result carries.
 *
 * Measured on `round42`: two plan answers are a complete JSON object with a Magic Context `<system-reminder>` appended in
 * place of nothing - the reminder is a separate block after a blank line. Parsing the text whole therefore failed, and
 * those two calls read as "asked for a plan and received no answer", which was a refusal of the reader rather than a fact
 * about the run: 51 accepted and 7 refused answers, not 50 and 6. The reminder is stripped and nothing else is guessed.
 */
export function toolResultPayload(message) {
  const text = stripSystemReminder(
    (message.content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")).join(""),
  );
  if (!text.startsWith("{")) return null;
  try {
    const value = JSON.parse(text);
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    return null;
  }
}

function stripSystemReminder(text) {
  const at = text.indexOf("<system-reminder");
  return (at < 0 ? text : text.slice(0, at)).trim();
}
