/**
 * Reading a mounted journey as a document: the tests it declares, the assertions each one makes, and
 * the Host routes it replaces with a fixture.
 *
 * Three gates ask three questions of the same files - does a declared surface have a journey that
 * asserts on it (`tools/check-surface-journeys.mjs`), is a journey only asserting that a control
 * exists (`tools/check-assertion-substance.mjs`), and does a journey stub the thing its title claims
 * to test (`tools/check-stub-subject-collision.mjs`) - so the reading lives here once. A second
 * parser would be a second answer to "what does this spec assert", and the two would disagree the
 * first time either was edited.
 *
 * The parse is deliberately shallow: a test is its title plus the body between its braces, and an
 * assertion is the `expect(...)` call with the matcher chained to it. That is enough to answer all
 * three questions mechanically, and it does not need a TypeScript parse: a spec's assertions are
 * calls in its own text, and the gates judge those calls, not a type.
 *
 * UNTRACKED FILES ARE NOT PART OF THE COMMIT. A worktree where several lanes run holds specs
 * somebody is still writing; judging one would fail another lane's in-flight work, and letting one
 * witness a surface would make that surface look covered by a file that is not in the commit. Both
 * directions are the same rule, so it is applied once, here.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanOutputLines } from "./subprocess-output.mjs";

const JOURNEY_DIRECTORY = "dialogue-web/tests";

const toPosix = (path) => path.split(sep).join("/");

/** Files git reports as untracked; a directory that is not a worktree reports none. */
export function untrackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  if (result.status !== 0) return new Set();
  return new Set(cleanOutputLines(result.stdout).filter(Boolean).map(toPosix));
}

/** Every `.spec.ts` under `directory`, as repo-relative paths, sorted. */
function scanSpecs(directory, root, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) scanSpecs(path, root, out);
    else if (entry.name.endsWith(".spec.ts")) out.push(toPosix(relative(root, path)));
  }
  return out.sort();
}

/** The commit's journeys, each with its source. A tree with no spec directory yields an empty list. */
export function journeySpecs({ root, directory = JOURNEY_DIRECTORY }) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  const untracked = untrackedFiles(root);
  return scanSpecs(absolute, root)
    .filter((file) => !untracked.has(file))
    .map((file) => ({ file, source: readFileSync(join(root, file), "utf8") }));
}

/** The title of a `test(...)` call, tolerating a title written across lines. `.describe` is a group. */
const TEST_CALL =
  /^[ \t]*test(?:\.(?:skip|only|fixme|fail|slow|concurrent))*\s*\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/gmu;

/** A character after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDERS = new Set([
  "(",
  ",",
  "=",
  ":",
  "[",
  "!",
  "&",
  "|",
  "?",
  "{",
  ";",
  "+",
  "-",
  "*",
  "%",
  "<",
  ">",
  "~",
  "^",
]);

/** Index just past the regex literal and its flags at `index`, or null when that `/` divides. */
function regexEnd(source, index) {
  let previous = index - 1;
  while (previous >= 0 && /\s/u.test(source[previous])) previous -= 1;
  if (previous >= 0 && !REGEX_PRECEDERS.has(source[previous])) return null;
  let inClass = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor];
    if (character === "\\") cursor += 1;
    else if (character === "\n") return null;
    else if (character === "[") inClass = true;
    else if (character === "]") inClass = false;
    else if (character === "/" && !inClass) {
      for (cursor += 1; cursor < source.length && /[a-z]/u.test(source[cursor]); cursor += 1);
      return cursor;
    }
  }
  return null;
}

/**
 * The region of the source a test's assertions live in: its own `test(` call up to the next one.
 *
 * The region is not the call's bracket span. Matching brackets through a spec means matching them
 * through regex literals (`value.match(/rgba?\(([^)]+)\)/u)` is unbalanced as text) and through
 * comments full of apostrophes, and every miss ends the span early - which reads as a test that
 * asserts nothing, the exact opposite of the truth. Splitting on the next `test(` has no such edge:
 * the population is the file's own declaration order.
 */
export function parseTests(source) {
  const starts = [...source.matchAll(TEST_CALL)].map((match) => ({
    title: match[2],
    index: match.index,
    line: source.slice(0, match.index).split("\n").length,
  }));
  return starts.map((entry, order) => ({
    title: entry.title,
    line: entry.line,
    body: source.slice(entry.index, starts[order + 1]?.index ?? source.length),
  }));
}

/**
 * Index just past the `)` matching the `(` at `open`.
 *
 * Comments, quoted text and regex literals are skipped rather than counted: an apostrophe in a comment
 * (`the strip's worst case`) or a regex like `/rgba?\(([^)]+)\)/u` is not balanced text, and counting
 * its parentheses walks the scan out of the call.
 */
function callEnd(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      if (newline === -1) return source.length;
      index = newline;
      continue;
    }
    if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      if (close === -1) return source.length;
      index = close + 1;
      continue;
    }
    if (character === "/") {
      const skipped = regexEnd(source, index);
      if (skipped !== null) {
        index = skipped - 1;
        continue;
      }
    }
    if (character === '"' || character === "'" || character === "`") {
      for (index += 1; index < source.length; index += 1) {
        if (source[index] === "\\") index += 1;
        else if (source[index] === character) break;
      }
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return source.length;
}

/** `expect(` / `expect.soft(` / `expect.poll(`, with the index of the call's own `(`. */
const EXPECT = /\bexpect(?:\.\w+)?\s*\(/gu;
/** The matcher chained to a resolved `expect(...)`, allowing `.not`, `.resolves` and `.rejects`. */
const MATCHER = /^\s*(?:\.\s*(?:not|resolves|rejects)\s*)*\.\s*(to[A-Za-z]+)\s*\(/u;

/**
 * Every assertion in a body: the matcher's name, whether it was negated, and the whole call's text.
 *
 * `text` runs from `expect` to the end of the matcher's own call, because that is the span that names
 * the control, the text and the matcher together - the unit the three gates above judge.
 */
export function assertionsOf(body) {
  const assertions = [];
  for (const match of body.matchAll(EXPECT)) {
    const openParen = match.index + match[0].length - 1;
    const closeParen = callEnd(body, openParen);
    const chained = MATCHER.exec(body.slice(closeParen));
    if (chained === null) continue;
    const matcherOpen = closeParen + chained[0].length - 1;
    const matcherClose = callEnd(body, matcherOpen);
    assertions.push({
      matcher: chained[1],
      negated: /\.\s*not\s*\./u.test(chained[0]),
      text: body.slice(match.index, matcherClose),
    });
  }
  return assertions;
}
