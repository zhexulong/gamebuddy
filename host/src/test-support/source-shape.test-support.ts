import { readFileSync } from "node:fs";

/**
 * A file read twice over: the bytes as committed, and the same text with every whitespace run OUTSIDE a string
 * literal collapsed to one space.
 *
 * An assertion about code reads better across tokens than in fragments - "this function takes exactly these three
 * parameters, in this order" is one claim, while `launchRole\(` beside `RoleLaunchOperation` is three fragments a
 * reader has to reassemble. But a pattern that spans tokens with literal whitespace between them is a claim about
 * LAYOUT: `launchRole(role, launchOperation: RoleLaunchOperation, ...)` matches while the signature sits on one line
 * and stops matching the moment the formatter folds it, with the product unchanged. That happened on 2026-11-12 to
 * `host/src/containment/runtime/contained-game-runtime.internal.test.ts`, and the assertion was right.
 *
 * So a test that needs to match across tokens matches against `shape`, where the line breaking no longer exists;
 * a test that genuinely needs the committed bytes - line numbers, a function body sliced between two markers, an
 * assertion that a `}` sits in column 0 - names `raw` and says by that choice what it is measuring. `tools/
 * check-source-shape-readers.mjs` derives its population from the reads that match across tokens and requires each
 * to be `shape`, so the next one of these cannot be written quietly.
 */
export type SourceShape = {
  /** The path or URL this text was read from. */
  readonly source: string | URL;
  /** The text as committed, newlines and indentation intact. */
  readonly raw: string;
  /** The same text with every whitespace run outside a string literal collapsed to one space. */
  readonly shape: string;
};

const WHITESPACE = /\s/u;
const QUOTES = new Set(['"', "'", "`"]);

/**
 * Where a line break can sit in formatted code: no space is written before these, or after these.
 *
 * This is the formatter's own single-line spelling, not a choice of this module: `f(a)` has no space inside its
 * parentheses and `a.b` none around its dot, while `{ a, b }` keeps one inside its braces. Without those rules the
 * reading would still depend on the line width - `launchRole(` followed by a newline and `role` would normalise to
 * `launchRole( role`, which is exactly the spelling no one writes on one line.
 */
const NO_SPACE_BEFORE = new Set([")", "]", ",", ";", "."]);
const NO_SPACE_AFTER = new Set(["(", "[", "."]);
const CLOSERS = new Set([")", "]", "}"]);

function needsSpace(previous: string, next: string): boolean {
  if (NO_SPACE_BEFORE.has(next) || NO_SPACE_AFTER.has(previous)) return false;
  return !(previous === "{" && next === "}");
}

/**
 * The index just past the string literal that starts at `start`, or the end of the text when it never closes.
 *
 * The literal's contents are copied whole by the caller, so an escape can skip two characters and a quote inside one
 * cannot end it early.
 */
function literalEnd(text: string, start: number): number {
  const quote = text[start]!;
  let index = start + 1;
  while (index < text.length && text[index] !== quote) index += text[index] === "\\" ? 2 : 1;
  return Math.min(index + 1, text.length);
}

/** The index where the comment starting at `start` ends: its line break for `//`, its `*\/` for a block comment. */
function commentEnd(text: string, start: number): number {
  const found = text.indexOf(text[start + 1] === "/" ? "\n" : "*/", start);
  return found === -1 ? text.length : found;
}

/** Append code text character by character, applying the spacing rules; returns the pending-whitespace state. */
function appendCode(out: string[], text: string, pending: boolean): boolean {
  let pendingSpace = pending;
  for (const character of text) {
    if (WHITESPACE.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace && out.length > 0 && needsSpace(out[out.length - 1]!, character)) out.push(" ");
    pendingSpace = false;
    if (CLOSERS.has(character) && out[out.length - 1] === ",") out.pop();
    out.push(character);
  }
  return pendingSpace;
}

/** Append a string literal whole: its contents are data, and the trailing comma rule never reaches inside it. */
function appendLiteral(out: string[], literal: string, pendingSpace: boolean): boolean {
  if (pendingSpace && out.length > 0 && needsSpace(out[out.length - 1]!, literal[0]!)) out.push(" ");
  out.push(literal);
  return false;
}

/**
 * The text as a formatter would write it on one line: every whitespace run outside a string literal collapsed, and
 * the two spellings a line width chooses between made identical.
 *
 * The trailing comma before a closing bracket goes for the same reason - the formatter writes it only when the list
 * is broken, so keeping it would make `f(a, b,)` and `f(a, b)` two shapes for one signature. String literals are
 * copied verbatim because their contents are data, not layout. Comments are read as text, before any quote in them is
 * mistaken for the start of a literal: an apostrophe in `the attempt's facts` opened a "string" that ran to the next
 * apostrophe and left every line break inside it uncollapsed, which is how the first version of this helper reproduced
 * the very defect it exists to remove. A regex literal holding an unbalanced quote can still open a string, and the
 * effect is one-directional: that region keeps its line breaks, so a one-line pattern fails to match it (visible) - it
 * cannot make a layout-sensitive pattern match text it would otherwise miss.
 */
export function collapseWhitespace(text: string): string {
  const out: string[] = [];
  let pendingSpace = false;
  let index = 0;
  while (index < text.length) {
    const character = text[index]!;
    const literal = QUOTES.has(character);
    const comment = !literal && character === "/" && (text[index + 1] === "/" || text[index + 1] === "*");
    if (literal || comment) {
      const end = literal ? literalEnd(text, index) : commentEnd(text, index);
      const span = text.slice(index, end);
      pendingSpace = literal ? appendLiteral(out, span, pendingSpace) : appendCode(out, span, pendingSpace);
      index = end;
      continue;
    }
    pendingSpace = appendCode(out, character, pendingSpace);
    index += 1;
  }
  return out.join("");
}

/** Both readings of the file at `source`, which the caller resolves. */
export function readSourceShape(source: string | URL): SourceShape {
  const raw = readFileSync(source, "utf8");
  return Object.freeze({ source, raw, shape: collapseWhitespace(raw) });
}
