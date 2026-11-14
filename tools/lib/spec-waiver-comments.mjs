/**
 * Reading a journey's prose: which comments explain the journey's shape with a product limitation,
 * and which of those say what would let them go.
 *
 * WHY (measured 2026-11-14, four cases in one night)
 *
 * A spec comment that explains why the test does the unnatural thing is a waiver, and a waiver is
 * invisible: the test is green, the reason reads like careful writing, and nothing in the tree reads
 * it. Four did that on one night, all of them green, all of them documented:
 *
 *   - `composed-profile-bootstrap.spec.ts` expected `pre === null` while the disclosure was shut,
 *     under "Closed, the dump's own DOM is not mounted at all" - so the spec asserted the mechanism
 *     that made the player's JSON unfindable by find-in-page (fixed in boot 55c772, whose own gate
 *     reads every closed `<details>` in the document).
 *   - `model-profile-freshness.spec.ts` closed the drawer with its Close button, "The close button
 *     is used rather than Escape: the Save button is disabled while saving, which drops focus to
 *     `<body>`, so Escape would have no drawer to reach".
 *   - `sending-and-composer.spec.ts` did the same, "the Save that just ran disabled itself and
 *     dropped focus to `<body>`".
 *   - `drawer-focus-trap.spec.ts` recovered focus by pointing at the drawer's heading, "because the
 *     upload's own busy state drops it to `<body>` ... it is reported rather than changed here".
 *
 * The last three were rewritten to press Escape and Tab (`930a031e`), which is what the player does.
 * The shape they shared is the one this module classifies: **a comment inside a journey that names a
 * capability the product denies as the reason the journey departs from what a player would do.**
 *
 * WHAT IS AND IS NOT IN THE POPULATION
 *
 * JSDoc (`/** ... *\/`) documents a test and is where this repository argues why an assertion exists;
 * it is not the risk zone, and reading it as one produced 67 candidates of which almost none was a
 * waiver. A `//` or `/* *\/` comment that follows a `test(` is prose about a step, and that is where
 * all four cases sat. Consecutive `//` lines are one comment: without that, "used rather than" and
 * "drops focus to `<body>`" land in two different findings and neither is a waiver.
 *
 * THE DECLARATION. A waiver is resolved by being written as one:
 *
 *     // spec-waiver: closes with its Close button rather than Escape, because a Save that
 *     // disabled itself parks focus on `<body>` and Escape reaches nothing.
 *     // expires when: dialogue-web/src/components/ContextDrawer.tsx no longer contains `disabled={busy}`
 *
 * The `expires when:` clause names the product code that causes the limitation and a literal in it,
 * so the exemption is read from the product's own source rather than from a second hand-written
 * claim: whoever removes that code makes this exemption go red, and the journey then asserts the
 * property the limitation denied. A declaration whose literal is gone is `waiver_expired`; one whose
 * file is gone is `waiver_expiry_unmeasurable`, because a rename is not a fix and a gate that cannot
 * read its own target must say so rather than pass.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { untrackedFiles } from "./journey-source.mjs";

const JOURNEY_DIRECTORY = "dialogue-web/tests";

const toPosix = (path) => path.split(sep).join("/");

/**
 * The move that departs from what a player would do: an alternative named, or one refused.
 *
 * Every one of the four cases carries one - "rather than Escape", "not Escape", "the close button is
 * used", "reported rather than changed". `not mounted` is the fourth's spelling and is listed under
 * denials, because the thing being denied there is the document's own content.
 */
export const DEVIATION_TERMS = Object.freeze([
  /\binstead of\b/iu,
  /\brather than\b/iu,
  /\bin place of\b/iu,
  /\bnot (?:Escape|Tab|a keyboard|this one|its own)\b/iu,
  /\bby pointing at\b/iu,
]);

/**
 * The capability the product denies: what is said to be impossible, absent or taken away.
 *
 * These are the four cases' own words - `<body>` as the place focus lands, `drops focus`,
 * `not mounted`, `no ... to reach` - widened only to the spellings the same claim takes.
 */
export const DENIAL_TERMS = Object.freeze([
  /<body>/u,
  /\bdrops? focus\b/iu,
  /\bdropped focus\b/iu,
  /\bdrops? it to\b/iu,
  /\bfalls? to <body>/iu,
  /\bparks? focus on\b/iu,
  /\bnot mounted\b/iu,
  /\bunmounted\b/iu,
  /\bnot in the document\b/iu,
  /\bno [^.;]{0,40} to reach\b/iu,
  /\bcannot reach\b/iu,
  /\bcannot be (?:reached|focused)\b/iu,
]);

/**
 * The clause that argues the denial is the right answer here - the fourth case's shape.
 *
 * `composed-profile-bootstrap.spec.ts` did not name an alternative: it justified the absence, "is not
 * mounted at all: a collapsed disclosure that keeps a few hundred lines of JSON in the document is
 * still a node the layout walks and an assistive technology can reach". A denial argued as acceptable
 * is the same waiver one move later, and `still a` / `not the ... this journey measures` are the two
 * spellings the four cases used.
 */
export const RATIONALISATION_TERMS = Object.freeze([
  /\bstill an? [^.;]{0,40}\b(?:node|state|stop|scroller|affordance)\b/iu,
  /\bnot (?:the|this) [^.;]{0,60}\b(?:measures|about|trap|defect|trap's)\b/iu,
  /\bby design\b/iu,
  /\bacceptable\b/iu,
]);

const DECLARATION = /^spec-waiver:/iu;
const EXPIRY = /expires when:?\s+(\S+)\s+no longer contains\s+`([^`]+)`/iu;

const REGEX_PRECEDERS = new Set([..."(,=: [!&|?{;+-*%<>~^"]);

/** Index just past the regex literal at `index`, or null when that `/` divides. */
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

/** Index just past the token at `index` when it is quoted text or a regex literal, not a comment. */
function pastNonComment(source, index) {
  const character = source[index];
  if (character === "/") {
    const skipped = regexEnd(source, index);
    return skipped === null ? index + 1 : skipped;
  }
  if (character !== '"' && character !== "'" && character !== "`") return index + 1;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") cursor += 1;
    else if (source[cursor] === character) return cursor + 1;
  }
  return source.length;
}

/**
 * Every comment in a spec, the consecutive `//` lines joined into one, with its 1-based start line.
 *
 * Quoted text and regex literals are skipped: a spec is full of `"/api/..."` and of apostrophes in
 * its own prose, and a scan that reads those as syntax finds comments that are not there.
 */
export function commentBlocksOf(source) {
  const found = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "/" && source[index + 1] === "/") {
      const newline = source.indexOf("\n", index);
      const stop = newline === -1 ? source.length : newline;
      const line = source.slice(0, index).split("\n").length;
      found.push({ kind: "line", line, index, end: stop, lines: 1, text: source.slice(index + 2, stop).trim() });
      index = stop;
    } else if (character === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      const stop = close === -1 ? source.length : close;
      const text = source.slice(index + 2, stop);
      found.push({
        kind: source[index + 2] === "*" ? "doc" : "block",
        line: source.slice(0, index).split("\n").length,
        index,
        end: stop + 2,
        lines: text.split("\n").length,
        text: text.trim(),
      });
      index = stop + 2;
    } else {
      index = pastNonComment(source, index);
    }
  }
  return groupConsecutive(found, source);
}

/** Runs of `//` lines with nothing but whitespace between them are one comment. */
function groupConsecutive(comments, source) {
  const grouped = [];
  for (const comment of comments) {
    const previous = grouped.at(-1);
    if (
      previous !== undefined &&
      comment.kind === "line" &&
      previous.kind === "line" &&
      source.slice(previous.end, comment.index).trim() === ""
    ) {
      previous.text = `${previous.text} ${comment.text}`.trim();
      previous.end = comment.end;
      previous.lines += 1;
      continue;
    }
    grouped.push({ ...comment });
  }
  return grouped;
}

/** A journey declaration starts here; a `describe` is a group and holds no step of its own. */
const JOURNEY_START = /^[ \t]*(?:test|describe)\b/dgmu;

/** The comments that follow a journey declaration, which is where prose about a step lives. */
export function stepCommentsOf(source) {
  const starts = [...source.matchAll(JOURNEY_START)].map((match) => match.index);
  if (starts.length === 0) return [];
  const first = starts[0];
  return commentBlocksOf(source).filter((comment) => {
    if (comment.kind === "doc") return false;
    return comment.index > first;
  });
}

const flatten = (text) => text.replace(/\s+/gu, " ").trim();

/** What one comment says: the deviation it makes, the capability it says is denied, and both. */
export function classifyComment(text) {
  const flat = flatten(text);
  const deviations = DEVIATION_TERMS.filter((term) => term.test(flat)).map(String);
  const denials = DENIAL_TERMS.filter((term) => term.test(flat)).map(String);
  const rationalisations = RATIONALISATION_TERMS.filter((term) => term.test(flat)).map(String);
  const expiry = EXPIRY.exec(flat);
  return {
    text: flat,
    deviations,
    denials,
    rationalisations,
    declared: DECLARATION.test(flat),
    expiry: expiry === null ? null : { path: expiry[1], literal: expiry[2] },
    isWaiver: denials.length > 0 && (deviations.length > 0 || rationalisations.length > 0),
  };
}

/**
 * One spec's reading: the waivers it states, the declarations that resolve them, and the findings.
 *
 * A declared waiver is not a finding until its expiry is read against the product, which needs the
 * repository; that half is `auditSpecWaivers`.
 */
export function readSpec(source) {
  const comments = stepCommentsOf(source).map((comment) => ({
    line: comment.line,
    ...classifyComment(comment.text),
  }));
  return {
    examined: comments.length,
    waivers: comments.filter((comment) => comment.isWaiver),
    declarations: comments.filter((comment) => comment.declared),
  };
}

/** Resolve one expiry clause against the tree: `held`, `expired` or `unmeasurable`. */
function resolveExpiry({ root, expiry }) {
  const path = expiry.path.replace(/^`|`$/gu, "").replace(/[,.;]$/u, "");
  const absolute = join(root, path);
  if (!existsSync(absolute)) return { verdict: "unmeasurable", path, literal: expiry.literal };
  const source = readFileSync(absolute, "utf8");
  return { verdict: source.includes(expiry.literal) ? "held" : "expired", path, literal: expiry.literal };
}

/**
 * The whole reading over the commit's journeys.
 *
 * `unassessed` names the tree that could not be read at all; `examined` is the population size, so a
 * run that recognised nothing is visible as `waivers=0` rather than as a clean result.
 */
export function auditSpecWaivers({ root, directory = JOURNEY_DIRECTORY }) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) {
    return {
      files: 0,
      examined: 0,
      waivers: [],
      findings: [],
      unassessed: [`unassessed: ${directory} - no spec directory, so no prose was read`],
    };
  }
  const untracked = untrackedFiles(root);
  const files = specFiles(absolute, root).filter((file) => !untracked.has(file));
  const waivers = [];
  const findings = [];
  let examined = 0;
  for (const file of files) {
    const reading = readSpec(readFileSync(join(root, file), "utf8"));
    examined += reading.examined;
    for (const comment of reading.waivers) {
      if (!comment.declared) {
        findings.push({
          code: "waiver_undocumented",
          file,
          line: comment.line,
          claim: comment.text,
          detail:
            "this comment explains a step with a capability the product denies, and nothing records that - " +
            "say what would retire it: `spec-waiver: <reason> expires when: <path> no longer contains `<literal>``",
        });
        continue;
      }
      if (comment.expiry === null) {
        findings.push({
          code: "waiver_without_expiry",
          file,
          line: comment.line,
          claim: comment.text,
          detail:
            "a `spec-waiver:` statement needs an `expires when: <repo-relative path> no longer contains `<literal>`` " +
            "clause naming the product code that causes the limitation",
        });
        continue;
      }
      const resolved = resolveExpiry({ root, expiry: comment.expiry });
      if (resolved.verdict === "held") {
        waivers.push({ file, line: comment.line, claim: comment.text, ...resolved });
        continue;
      }
      if (resolved.verdict === "expired") {
        findings.push({
          code: "waiver_expired",
          file,
          line: comment.line,
          claim: comment.text,
          detail:
            `${resolved.path} no longer contains \`${resolved.literal}\` - the workaround this declares is ` +
            "unnecessary now; assert what the player gets and delete the declaration",
        });
        continue;
      }
      findings.push({
        code: "waiver_expiry_unmeasurable",
        file,
        line: comment.line,
        claim: comment.text,
        detail:
          `${resolved.path} does not exist, so whether the limitation is still there cannot be read - ` +
          "point the clause at the file that causes it",
      });
    }
  }
  const unassessed =
    files.length === 0 ? [`unassessed: ${directory} - no tracked journey found, so no prose was read`] : [];
  return { files: files.length, examined, waivers, findings, unassessed };
}

function specFiles(directory, root, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) specFiles(path, root, out);
    else if (entry.name.endsWith(".spec.ts")) out.push(toPosix(relative(root, path)));
  }
  return out.sort();
}
