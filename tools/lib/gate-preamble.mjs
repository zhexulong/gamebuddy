/**
 * The small helpers every gate's preamble re-spells, in one place.
 *
 * WHY THIS FILE EXISTS. `tools/check-code-duplication.mjs` measured them on the 2026-11-15 tree as STRUCTURAL duplication
 * - a block of statements at three or more sites, not the syntax floor of a file of that kind: `fail(code, message,
 * details = {})` at 5 sites, the `--root` argument resolution at 5 (and that one had just GROWN, because the gate written
 * that week spelled it a fifth time), `withoutComments` at 3, and the brace-matching scan that finds a declaration's body
 * at 3 more. None of them is a decision any gate makes differently; each was written again because a gate file is written
 * from the last gate file. So they live here, and a gate imports them.
 *
 * WHAT IS NOT HERE. Nothing that reads the world - no census, no verdict, no format. Those are the parts a gate is
 * supposed to disagree about, and folding them together is how two gates stop being two checks.
 */
import { resolve } from "node:path";

/** A rule violation with a code and details a caller can act on, thrown rather than returned so no reader ignores it. */
export function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

/** The root a gate was asked to read: `--root <dir>` when the caller named one, the gate's own root otherwise. */
export function rootFromArgv(argv, fallback) {
  const index = argv.indexOf("--root");
  return index >= 0 && typeof argv[index + 1] === "string" ? resolve(argv[index + 1]) : fallback;
}

/**
 * The source with its comments removed: a line comment, a block comment - text a reader wrote for a person, never a value
 * a gate may read as one. Newlines survive, so a line number read off the result is the line number of the file.
 */
export function withoutComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\/\/.*$/u, ""))
    .join("\n");
}

/**
 * The text from the `{` at `open` to its matching `}`, inclusive, or `null` when the braces do not close. Every caller
 * here starts from a declaration it found by name and needs the body under it; one brace scan answers all of them.
 */
export function bracesFrom(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }
  return null;
}
