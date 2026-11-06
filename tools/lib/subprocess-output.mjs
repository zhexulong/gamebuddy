/**
 * The one reader for a child process's captured output, in lines.
 *
 * Measured 2026-11-05, `tools/check-draft-declaration-coverage.mjs`: the gate ran Playwright's `line` reporter and
 * parsed its stdout with `String(stdout).split("\n").map((line) => line.trim()).filter((line) =>
 * line.startsWith("MEASURE "))`. The reporter rewrites its progress line in place, so the real capture
 * (`scratch/gb-draft-captured.txt`: 11082 bytes, 61 LF, 0 CR, 62 ESC bytes) carried `ESC[1A ESC[2K` before every
 * MEASURE line. `trim()` strips whitespace, not control sequences, so that capture split into 0 matching lines -
 * where the same bytes read through this function split into 6. The gate reported `fields: 0` and passed.
 *
 * WHY THIS IS STRICTER THAN THE OBVIOUS SPELLING
 *
 * The tempting sanitation is `raw.replace(/\x1b\[[0-9;]*m/g, "")` and `raw.split(/\r?\n/)`. Both are wrong for the
 * bytes that actually arrived:
 *
 *   - `[0-9;]*m` matches only SGR (colour) sequences. `ESC[1A` (cursor up) and `ESC[2K` (erase line) end in letters
 *     that are not `m`, so the two escapes that caused this incident survive it untouched. The final letter is
 *     therefore matched as a class - `[A-Za-z]` - which covers cursor movement, erase, and colour alike.
 *   - `\r?\n` treats a carriage return only as part of CRLF. A progress line rewritten in place can end a line with a
 *     bare `\r` (and a `\r` at end of line is a line boundary in what a terminal displays), so `\r` is a separator in
 *     its own right: `/\r\n|\r|\n/u`, CRLF first so it is read as one boundary and not two.
 *
 * Every line is trimmed, because a line-oriented reader that compares prefixes is normally comparing a token at the
 * start of a line and would otherwise have to trim at each call site.
 */

/** Cursor movement, erase, colour and the rest of the CSI family - not only `…m`. */
const ANSI_ESCAPE = /\u001B\[[0-9;]*[A-Za-z]/gu;

/** CRLF, a bare CR, or an LF: every one of them ends a line in the text a child process hands back. */
const LINE_BOUNDARY = /\r\n|\r|\n/u;

/** The lines of captured child output, with terminal escapes removed and each line trimmed. */
export function cleanOutputLines(raw) {
  return String(raw ?? "")
    .replace(ANSI_ESCAPE, "")
    .split(LINE_BOUNDARY)
    .map((line) => line.trim());
}
