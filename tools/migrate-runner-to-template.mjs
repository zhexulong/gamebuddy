#!/usr/bin/env node
/**
 * MOVE A `run-stardew-native-local-*.mjs` SMOKE RUNNER ONTO THE TEMPLATE - or refuse, by name.
 *
 * WHY. `tools/lib/native-local-runner-scaffold.mjs` owns the lifecycle every one of these runners used to spell for
 * itself. Nine of them use it. The other hundred and thirteen were migrated by hand, one at a time, at roughly the cost
 * of writing the runner: read the copy, find which statements are the lifecycle, lift the judgement into a definition,
 * rewrite the tests that asserted the old shape. Doing that a hundred times is how a migration stalls at nine.
 *
 * WHAT THIS IS. Two things, and the first decides what the second may touch:
 *
 *   1. THE CENSUS (`--census`): for every runner the scaffold baseline records as hand-written, decide whether its
 *      lifecycle has the template's shape. The shape is not a list written here - it is what the template's
 *      `defineSmokeScenario` contract can express, read as five properties over the runner's own statements:
 *
 *        one_request            exactly one positive `executeFresh` for the action under test
 *        one_frame              exactly one post-terminal observation, and no observation inside a loop
 *        standard_stale_re_send at most one further request, sent against the post-run world and asserted refused
 *        no_equip_first         no request for any other action before the one under test
 *        no_second_re_send_that_must_succeed   nothing sent after the stale re-send
 *
 *      A runner that does not match is NOT migrated: forcing it is a behaviour change, and `bait-crab-pot` already
 *      demonstrated what that costs.
 *
 *   2. THE CODEMOD (per file, dry run by default): rewrite a matching runner into a `defineSmokeScenario` definition,
 *      lifting its judgement verbatim, and REFUSE - `not_migratable:<file>:<why>`, exit 1 - whenever a statement cannot
 *      be accounted for. The single rule that makes this safe: EVERY top-level statement of the old run function is
 *      either matched by a canonical lifecycle step (which the template now owns) or copied into one of the
 *      definition's fields. A statement that is neither is a refusal, not a guess. A codemod that produces a
 *      plausible-but-wrong runner is worse than a hundred and thirteen hand-written ones.
 *
 * WHAT IT REFUSES, and each of these is a real case in this tree:
 *
 *   shape_does_not_match:<property>          the census said no; the migration is not attempted
 *   fixture_scenario_unresolved:<why>        the action's fixture world is not resolvable from ONE action key
 *   action_under_test_unresolved             the runner's `ACTION` is not a literal, or is sent under another name
 *   request_not_the_canonical_step           the `executeFresh` call is not the shape the template submits
 *   post_terminal_frame_missing              the runner never re-reads the world after the terminal, so the template's
 *                                            `after` would be a frame it did not have (a refusal, not a strengthening)
 *   judgement_statement_unaccounted:<text>   a statement that is neither lifecycle nor a liftable judgement
 *   stale_block_not_the_canonical_shape      the negative arm is present but is not the standard re-send
 *   result_object_unliftable:<key>           the passing result carries a key the measured spread cannot carry
 *   options_default_differs:<name>:<value>   the runner's default would change
 *
 * IDEMPOTENT. A runner that already defines a scenario is a no-op with exit 0 and the word `already_migrated`, so the
 * pass can be re-run over the whole set without a second output for the files it already rewrote.
 *
 * WHAT IT DOES NOT DO, said out loud: it does not run the runner, and it does not prove the rewritten file's tests
 * pass. The caller runs `node --test <runner>.test.mjs` per file and reads the exit code; the dry-run diff is the
 * review, and `--write` is not evidence on its own. It also cannot invent a domain justification for an action whose
 * copy had no stale re-send - it records the omission as what it is, with `negative: "not_declared:<reason>"` visible
 * in every result the migrated runner publishes.
 *
 * USAGE
 *   node tools/migrate-runner-to-template.mjs --census
 *   node tools/migrate-runner-to-template.mjs tools/run-stardew-native-local-player-toggle-tool-light-smoke.mjs
 *   node tools/migrate-runner-to-template.mjs tools/run-stardew-native-local-player-toggle-tool-light-smoke.mjs --write
 *   node tools/migrate-runner-to-template.mjs --all --write
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  STARDEW_EXPERIMENTAL_ACTION_RUNNERS,
  STARDEW_PUBLISHED_ACTION_GATES,
} from "./stardew-action-gate-descriptors.mjs";
import { fixtureActions, fixtureScenario } from "./lib/stardew-native-local-player-fixture.mjs";
import { readBaseline, runnerFiles, readRunner } from "./check-native-local-runner-scaffold.mjs";

const ROOT = resolve(import.meta.dirname, "..");

/** The one import a migrated runner keeps from the template. */
const TEMPLATE_IMPORT = "./lib/native-local-runner-scaffold.mjs";

/* ---------------------------------------------------------------------------------------------------------------
 * A TEXT SCANNER JUST BIG ENOUGH FOR THIS TREE.
 *
 * The codemod must decide, statement by statement, whether a line is the lifecycle or the action's judgement, so it
 * needs the function body's TOP-LEVEL statements and nothing finer. Node ships no JavaScript parser, the tree has no
 * parser dependency (`package.json` devDependencies), and a syntax-aware parse would be a second authority over a file
 * this tool is about to rewrite anyway. What is needed is a scanner that skips strings, template literals, comments and
 * regular-expression literals so that `;`, `{` and `}` inside them are not statement boundaries.
 *
 * The refusal rule covers ASI: a statement that ends in neither `;` nor `}` is refused by the caller rather than
 * guessed at, so a body this scanner cannot segment is a named refusal and never a silent mis-split.
 * ------------------------------------------------------------------------------------------------------------- */

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);
/** After these, a `/` opens a regular expression rather than dividing. */
const REGEX_PRECEDERS = new Set([
  "(",
  "[",
  "{",
  ",",
  ";",
  ":",
  "=",
  "!",
  "&",
  "|",
  "?",
  "+",
  "-",
  "*",
  "%",
  "^",
  "~",
  "<",
  ">",
  "return",
  "typeof",
  "case",
  "in",
  "of",
  "instanceof",
  "new",
  "delete",
  "void",
  "do",
  "else",
  "yield",
  "await",
]);

/** `source` with every comment replaced by spaces, so offsets and line numbers survive verbatim. */
export function blankComments(source) {
  const text = String(source ?? "");
  const out = text.split("");
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      const stop = end < 0 ? text.length : end;
      for (let i = index; i < stop; i++) out[i] = " ";
      index = stop;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end < 0 ? text.length : end + 2;
      for (let i = index; i < stop; i++) if (out[i] !== "\n") out[i] = " ";
      index = stop;
      continue;
    }
    index++;
  }
  return out.join("");
}

/** The index just past the string literal that starts at `start`. */
function skipString(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (quote === "`" && char === "$" && text[index + 1] === "{") {
      index = skipInterpolation(text, index + 2);
      continue;
    }
    if (char === quote) return index + 1;
    index++;
  }
  return text.length;
}

/** The index just past a `${ ... }` interpolation body, nested braces and all. */
function skipInterpolation(text, start) {
  let depth = 1;
  let index = start;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return index + 1;
    }
    index++;
  }
  return text.length;
}

/** The index just past the regular-expression literal that starts at `start`. */
function skipRegex(text, start) {
  let index = start + 1;
  let inClass = false;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index++;
      while (index < text.length && /[a-z]/u.test(text[index])) index++;
      return index;
    } else if (char === "\n") return index;
    index++;
  }
  return text.length;
}

/** Whether the `/` at `index` opens a regular expression, decided by the last significant character before it. */
function regexAllowed(text, index) {
  let at = index - 1;
  while (at >= 0 && /\s/u.test(text[at])) at--;
  if (at < 0) return true;
  if (REGEX_PRECEDERS.has(text[at])) return true;
  const wordEnd = at + 1;
  while (at >= 0 && /[\w$]/u.test(text[at])) at--;
  const word = text.slice(at + 1, wordEnd);
  return REGEX_PRECEDERS.has(word);
}

/**
 * The top-level statements of a JavaScript body, in order, each with the line it started on.
 *
 * A statement ends at a `;` at depth zero, or at a `}` at depth zero that is not followed by `else`, `catch`, `finally`,
 * `while`, `.`, `?.`, `)`, `,` or an operator - the continuations a formatted block statement can have. A body with a
 * statement that ends in neither is published as `unterminated` rather than dropped, and the caller refuses it.
 */
export function splitStatements(source, { firstLine = 1 } = {}) {
  const text = blankComments(source);
  const statements = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  const push = (end) => {
    const raw = source.slice(start, end);
    if (raw.trim().length === 0) return;
    statements.push({
      text: raw.trim(),
      code: blankComments(raw).trim().replace(/\s+/gu, " "),
      raw,
      line: firstLine + countNewlines(source.slice(0, start)),
    });
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === "/" && regexAllowed(text, index)) {
      index = skipRegex(text, index);
      continue;
    }
    if (OPENERS.has(char)) {
      depth++;
      index++;
      continue;
    }
    if (CLOSERS.has(char)) {
      depth--;
      index++;
      if (depth === 0 && char === "}" && opensABlockStatement(text, start) && !continuesBlock(text, index)) {
        push(index);
        start = index;
      }
      continue;
    }
    if (char === ";" && depth === 0) {
      index++;
      push(index);
      start = index;
      continue;
    }
    index++;
  }
  const tail = source.slice(start);
  const unterminated = tail.trim().length > 0 ? tail.trim() : null;
  return { statements, unterminated };
}

/**
 * Whether the statement that began at `start` is one whose `}` closes it.
 *
 * A `}` at depth zero ends a statement only when it closes a BLOCK - an `if`, a loop, a `try`, a function. When it
 * closes an object literal it does not: `const args = { a: 1 };`, `import { a, b } from "m"` and `export { x };` all
 * carry a `}` that is followed by more of the same statement. Reading this from the statement's own opening keyword is
 * what keeps the import list from being cut in half at its own closing brace, which is exactly what a naive reader did
 * to every runner in this tree.
 */
function opensABlockStatement(text, start) {
  const head = blankComments(text.slice(start)).trim();
  return /^(?:if|for|while|do|try|else|switch|function|class|async\s+function|export\s+(?:default\s+)?(?:async\s+)?(?:function|class))\b/u.test(
    head,
  );
}

/** Whether a `}` at depth zero is followed by something that keeps the same statement open. */
function continuesBlock(text, index) {
  let at = index;
  while (at < text.length && /\s/u.test(text[at])) at++;
  if (at >= text.length) return false;
  const rest = text.slice(at);
  if (/^(else|catch|finally|while)\b/u.test(rest)) return true;
  return /^[.?,)\]}]/u.test(rest);
}

function countNewlines(text) {
  let count = 0;
  for (const char of text) if (char === "\n") count++;
  return count;
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE RUN FUNCTION AND ITS STATEMENTS
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * The exported smoke function: `export async function run<X>Smoke(...) { ... }`.
 *
 * Every runner in this family exports exactly one, and the launcher reads its parameter names to choose the call
 * shape, so the export name and arity are load-bearing. A file whose run function is spelled another way (an arrow
 * const, two of them, a wrapper that delegates to a sibling) is not a runner this codemod rewrites.
 */
export function findRunFunction(source) {
  const clean = blankComments(source);
  const matches = [...clean.matchAll(/export\s+(?:async\s+)?function\s+(\w+)\s*\(/gu)];
  const runners = matches.filter((match) => /^run[A-Z]\w*Smoke$/u.test(match[1]));
  if (runners.length !== 1)
    return {
      ok: false,
      why:
        runners.length === 0
          ? `no_exported_run_function:${matches.map((match) => match[1]).join(",") || "none"}`
          : `two_exported_run_functions:${runners.map((match) => match[1]).join(",")}`,
    };
  const match = runners[0];
  const name = match[1];
  const paren = clean.indexOf("(", match.index + match[0].length - 1);
  const paramEnd = matchingClose(clean, paren);
  if (paramEnd < 0) return { ok: false, why: "run_parameters_unterminated" };
  const params = clean.slice(paren + 1, paramEnd).trim();
  let at = paramEnd + 1;
  while (at < clean.length && /\s/u.test(clean[at])) at++;
  if (clean[at] !== "{") return { ok: false, why: "run_body_missing" };
  const bodyEnd = matchingClose(clean, at);
  if (bodyEnd < 0) return { ok: false, why: "run_body_unterminated" };
  return {
    ok: true,
    name,
    params,
    body: source.slice(at + 1, bodyEnd),
    bodyStart: at + 1,
    bodyEnd,
    headerEnd: at + 1,
    line: 1 + countNewlines(source.slice(0, at)),
  };
}

function matchingClose(text, openIndex) {
  const open = text[openIndex];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  let index = openIndex;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(text, index);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end < 0 ? text.length : end + 2;
      continue;
    }
    if (char === open) depth++;
    else if (char === close) {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE CENSUS: does this runner's lifecycle have the template's shape?
 * ------------------------------------------------------------------------------------------------------------- */

/** The five properties, and the one-line reason each is a property of the template rather than of taste. */
export const SHAPE_PROPERTIES = Object.freeze([
  ["one_request", "`defineSmokeScenario` submits exactly one positive request, with the action's own args"],
  ["one_frame", "the template reads the post-terminal world once, bounded by the terminal's revision"],
  [
    "standard_stale_re_send",
    "the optional negative arm is the same request re-sent against the post-run world and refused",
  ],
  ["no_equip_first", "the template has no prepare-leg request; a second action before the request is not expressible"],
  [
    "no_second_re_send_that_must_succeed",
    "the template ends at the refused re-send; a second success is not expressible",
  ],
]);

const LIFECYCLE_CALLS = Object.freeze({
  observe: /\b(observeFresh|waitForFreshSnapshot)\s*\(/u,
  execute: /\b(executeFresh|execute)\s*\(/u,
  wait: /\bwaitForTerminal\s*\(/u,
});

/** `text` with every string literal's characters replaced by `#`, so structure can be matched without its words. */
export function blankStrings(text) {
  const source = String(text ?? "");
  const out = source.split("");
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const end = skipString(source, index);
      for (let i = index + 1; i < end - 1; i++) if (out[i] !== "\n") out[i] = "#";
      index = end;
      continue;
    }
    index++;
  }
  return out.join("");
}

/**
 * The census reading for ONE runner source.
 *
 * `template` is the scaffold module's source, handed in so the properties are read against the template that exists
 * rather than against a description of it: a template whose `run` stops submitting one request would make every
 * matching runner a lie, and this reader would not notice. It is not needed for the per-property decisions here - the
 * properties ARE the template's contract - but the caller passes it so the census and the codemod read one template.
 */
export function readLifecycle(source) {
  const blanked = blankComments(source);
  const already = readRunner(source);
  if (already.conforming) return { migrated: true, match: null, reason: null, facts: null };
  const found = readRunBody(source);
  if (!found.ok) return { migrated: false, match: false, reason: found.why, facts: null };
  const action = actionUnderTest(blanked, found.statements);
  const statements = found.statements;
  const facts = {
    statements: statements.length,
    observations: statements.filter((entry) => LIFECYCLE_CALLS.observe.test(entry.text)).length,
    executes: statements.filter((entry) => LIFECYCLE_CALLS.execute.test(entry.text)).length,
    waits: statements.filter((entry) => LIFECYCLE_CALLS.wait.test(entry.text)).length,
    sends: statements
      .filter((entry) => LIFECYCLE_CALLS.execute.test(entry.text))
      .map((entry) => sentAction(entry.text)),
    loops: statements.filter((entry) => /^(for|while|do)\b/u.test(entry.text)).length,
    localExecuteHelper: statements.some((entry) => /^(?:async\s+)?function\s+execute\s*\(/u.test(entry.code)),
    action,
  };

  const failure = shapeFailure(facts, statements, found);
  return { migrated: false, match: failure === null, reason: failure, facts };
}

/**
 * The action under test: the runner's own `const ACTION`, or - for the older copies that never declared one - the last
 * action named inside a request statement, which is the one whose terminal the run judges.
 */
export function actionUnderTest(blankedSource, statements) {
  const match = /const\s+ACTION\s*=\s*["']([a-z0-9_]+)["']/u.exec(blankedSource);
  if (match !== null) return match[1];
  const sent = (statements ?? [])
    .filter((entry) => LIFECYCLE_CALLS.execute.test(entry.text))
    .map((entry) => sentAction(entry.text))
    .filter((name) => name !== "unreadable" && name !== "<ACTION>");
  return sent.length === 0 ? null : sent[sent.length - 1];
}

/** The action a request statement sends: `action: ACTION` resolves to the constant, a literal stays itself. */
function sentAction(statementText) {
  if (/\baction\s*:\s*ACTION\b/u.test(statementText)) return "<ACTION>";
  const literals = [...statementText.matchAll(/\baction\s*:\s*["']([a-z0-9_]+)["']/gu)].map((found) => found[1]);
  if (literals.length > 0) return literals[literals.length - 1];
  const viaHelper = /\bexecute\s*\(\s*[\w$]+\s*,\s*[\w$]+\s*,\s*["'][^"']*["']\s*,\s*["']([a-z0-9_]+)["']/u.exec(
    statementText,
  );
  if (viaHelper !== null) return viaHelper[1];
  const plainHelper = /\bexecute\s*\(\s*(?:phase\s*,\s*)?["']([a-z0-9_]+)["']/u.exec(statementText);
  if (plainHelper !== null) return plainHelper[1];
  return "unreadable";
}

/** The first property this runner's lifecycle breaks, or null when it has the template's shape. */
function shapeFailure(facts, statements, found) {
  if (facts.action === null)
    return facts.localExecuteHelper
      ? "one_request:request_is_submitted_by_a_runner_local_execute_helper"
      : "one_request:action_under_test_unresolved";
  const kinds = facts.sends.map((sent) => (sent === "<ACTION>" ? facts.action : sent));
  if (kinds.includes("unreadable")) return "one_request:request_action_unreadable";
  const before = kinds.slice(0, -1).filter((kind) => kind !== facts.action);
  if (before.length > 0)
    return before[0].startsWith("equip")
      ? `no_equip_first:${before[0]}`
      : `no_prepare_request_before_the_action:${before[0]}`;
  if (kinds.length > 2) return `no_second_re_send_that_must_succeed:${kinds.length}`;

  const allText = statements.map((entry) => entry.text).join("\n");
  const sends = statements.filter((entry) => LIFECYCLE_CALLS.execute.test(entry.text));
  const lastIsStale =
    kinds.length === 2 &&
    sends.length === 2 &&
    /\bsnapshot\s*:\s*(after|settled|latest)\b/u.test(sends[1].text) &&
    /["']rejected["']/u.test(allText);
  if (kinds.length === 2 && !lastIsStale) {
    if (!/\bsnapshot\s*:\s*(after|settled|latest)\b/u.test(sends[1].text))
      return "standard_stale_re_send:not_sent_against_the_post_run_world";
    return "standard_stale_re_send:refusal_not_asserted";
  }
  const positives = kinds.filter((kind) => kind === facts.action).length - (lastIsStale ? 1 : 0);
  if (positives !== 1) return `one_request:${positives}`;

  const waitAt = statements.findIndex((entry) => LIFECYCLE_CALLS.wait.test(entry.text));
  if (waitAt < 0) return "one_frame:no_terminal_wait";
  const afterTerminal = statements.slice(waitAt + 1);
  const frames = afterTerminal.filter((entry) => LIFECYCLE_CALLS.observe.test(entry.text));
  if (frames.length === 0) {
    // A post-terminal read through a runner-local helper is not "no frame": it is a frame with semantics of its own,
    // which the template's `waitForFreshSnapshot(minRevision, requireActionable)` cannot be assumed to reproduce.
    const helper = afterTerminal
      .map((entry) => /= await ([A-Za-z_$][\w$]*)\(client/u.exec(entry.text))
      .find((match) => match !== null && match[1] !== "observeFresh" && match[1] !== "waitForFreshSnapshot");
    if (helper != null) return `one_frame:runner_local_helper:${helper[1]}`;
  }
  if (frames.length !== 1) return `one_frame:${frames.length}`;
  if (facts.loops > 0) return "one_frame:observation_in_a_loop";
  if (kinds.length === 2) {
    const negative = statements.filter((entry) => LIFECYCLE_CALLS.execute.test(entry.text))[1];
    const body = negative.text;
    const sentAgainstPostRunWorld = /\bsnapshot\s*:\s*(after|settled|latest)\b/u.test(body);
    if (!sentAgainstPostRunWorld) return "standard_stale_re_send:not_sent_against_the_post_run_world";
    const assertedRefused = /["']rejected["']/u.test(statements.map((entry) => entry.text).join("\n"));
    if (!assertedRefused) return "standard_stale_re_send:refusal_not_asserted";
  }
  if (found.params.split(",").length < 3) return "one_frame:run_does_not_take_the_config";
  return null;
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE POPULATION
 * ------------------------------------------------------------------------------------------------------------- */

/** The runners the scaffold baseline records as hand-written, in path order. */
export function censusPopulation({ root = ROOT } = {}) {
  const baseline = readBaseline({ root });
  const onDisk = new Set(runnerFiles({ root }));
  const files = baseline
    .map((entry) => entry.file)
    .filter((file) => onDisk.has(file))
    .sort();
  return { files, missing: baseline.map((entry) => entry.file).filter((file) => !onDisk.has(file)) };
}

/** `runners examined N · shape matches M · does not match K`, and one line per non-match naming its reason. */
export function census({ root = ROOT, files } = {}) {
  const population = censusPopulation({ root });
  const list = files ?? population.files;
  const rows = [];
  for (const file of list) {
    const source = readFileSync(resolve(root, file), "utf8");
    const reading = readLifecycle(source);
    rows.push({ file, ...reading });
  }
  const matched = rows.filter((row) => row.match === true);
  const mismatched = rows.filter((row) => row.match !== true);
  const migrated = rows.filter((row) => row.migrated === true);
  return {
    examined: rows.length,
    matched: matched.map((row) => row.file),
    mismatched: mismatched.map((row) => ({ file: row.file, reason: row.migrated ? "already_migrated" : row.reason })),
    alreadyMigrated: migrated.map((row) => row.file),
    missing: population.missing,
    rows,
  };
}

export function renderCensus(result) {
  const lines = [
    `runners examined ${result.examined} · shape matches ${result.matched.length} · does not match ${result.mismatched.length}` +
      (result.alreadyMigrated.length > 0 ? ` · already on the template ${result.alreadyMigrated.length}` : ""),
  ];
  for (const row of result.mismatched) lines.push(`  does not match ${row.file} · ${row.reason}`);
  return lines;
}

/** The `{ ... }` body of the first statement that starts with `try`, and the catch body after it. */
export function splitGuardedBody(statements) {
  const at = statements.findIndex((entry) => /^try\s*\{/u.test(entry.text));
  if (at < 0) return null;
  const guarded = statements[at].text;
  const open = guarded.indexOf("{");
  const close = matchingClose(guarded, open);
  if (close < 0) return null;
  const rest = guarded.slice(close + 1);
  const catchAt = rest.indexOf("catch");
  const catchOpen = catchAt < 0 ? -1 : rest.indexOf("{", catchAt);
  return {
    prologue: statements.slice(0, at),
    epilogue: statements.slice(at + 1),
    body: guarded.slice(open + 1, close),
    bodyLine: statements[at].line + countNewlines(guarded.slice(0, open + 1)),
    catchBody: catchOpen < 0 ? null : rest.slice(catchOpen + 1, matchingClose(rest, catchOpen)),
  };
}

/**
 * The statements the LIFECYCLE is made of: inside the `try` when the runner guards its body, and the function's own
 * statements when it does not.
 */
export function readRunBody(source) {
  const found = findRunFunction(source);
  if (!found.ok) return found;
  const outer = splitStatements(found.body, { firstLine: found.line });
  if (outer.unterminated !== null) return { ok: false, why: "run_body_statement_unterminated" };
  const guarded = splitGuardedBody(outer.statements);
  if (guarded === null)
    return {
      ok: true,
      ...found,
      statements: outer.statements,
      prologue: [],
      epilogue: [],
      guarded: false,
      catchBody: null,
    };
  const inner = splitStatements(guarded.body, { firstLine: guarded.bodyLine });
  if (inner.unterminated !== null) return { ok: false, why: "try_body_statement_unterminated" };
  return {
    ok: true,
    ...found,
    statements: inner.statements,
    prologue: guarded.prologue,
    epilogue: guarded.epilogue,
    guarded: true,
    catchBody: guarded.catchBody,
  };
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE CODEMOD
 *
 * The planner walks the old run function's statements in order against the canonical sequence. Each statement is
 * either MATCHED (the template owns it now), LIFTED (copied verbatim into one of the definition's fields), or a
 * REFUSAL. There is no third path: a statement the planner does not recognise stops the migration with its own text
 * in the reason, because a rewritten runner that quietly drops a check is the failure this tool exists to avoid.
 * ------------------------------------------------------------------------------------------------------------- */

const refuse = (why) => ({ ok: false, why: why.length > 200 ? `${why.slice(0, 200)}…` : why });

/** Split at `separator` where it appears at depth zero, skipping strings, comments and regular expressions. */
export function splitTopLevelPieces(text, separator) {
  const source = String(text ?? "");
  const pieces = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skipString(source, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const end = source.indexOf("\n", index);
      index = end < 0 ? source.length : end;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "/" && regexAllowed(source, index)) {
      index = skipRegex(source, index);
      continue;
    }
    if (OPENERS.has(char)) depth++;
    else if (CLOSERS.has(char)) depth--;
    else if (char === separator && depth === 0) {
      pieces.push(source.slice(start, index));
      start = index + 1;
    }
    index++;
  }
  pieces.push(source.slice(start));
  return pieces.map((piece) => piece.trim()).filter((piece) => piece.length > 0);
}

/** The index of the first `char` at depth zero, or -1. */
function indexAtTopLevel(text, char) {
  const source = String(text ?? "");
  let depth = 0;
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    if (current === '"' || current === "'" || current === "`") {
      index = skipString(source, index);
      continue;
    }
    if (OPENERS.has(current)) depth++;
    else if (CLOSERS.has(current)) depth--;
    else if (current === char && depth === 0) return index;
    index++;
  }
  return -1;
}

/** An object literal's own entries, `key: value` or shorthand, in source order. */
export function parseObjectLiteral(text) {
  const trimmed = String(text ?? "").trim();
  if (!(trimmed.startsWith("{") && trimmed.endsWith("}"))) return null;
  return splitTopLevelPieces(trimmed.slice(1, -1), ",").map((piece) => {
    const colon = indexAtTopLevel(piece, ":");
    return colon < 0
      ? { key: piece.trim(), value: piece.trim(), shorthand: true }
      : { key: piece.slice(0, colon).trim(), value: piece.slice(colon + 1).trim(), shorthand: false };
  });
}

/** The names a list of statements declares at its own top level. */
export function declaredNames(statements) {
  const names = new Set();
  for (const entry of statements) {
    const single = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/u.exec(entry.code);
    if (single !== null) names.add(single[1]);
    const destructured = /^(?:const|let|var)\s*\{([^}]*)\}\s*=/u.exec(entry.code);
    if (destructured !== null)
      for (const piece of destructured[1].split(",")) {
        const name = piece.split(":").pop().trim();
        if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.add(name);
      }
  }
  return names;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Whether `text` mentions the identifier `name` as itself and not as a property name. */
export function mentions(text, name) {
  return new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "u").test(text);
}

/** `text` with the identifier `from` replaced by `to`, as itself and never as a property name. */
export function renameIdentifier(text, from, to) {
  return text.replace(new RegExp(`(?<![\\w$.])${escapeRegExp(from)}(?![\\w$])`, "gu"), to);
}

/** The body of a named `function` in a source, by brace matching, or null. */
export function functionBody(source, name) {
  const clean = blankComments(source);
  const pattern = new RegExp(`function\\s+${escapeRegExp(name)}\\s*\\(`, "u");
  const found = pattern.exec(clean);
  if (found === null) return null;
  const at = clean.indexOf("{", found.index + found[0].length);
  if (at < 0) return null;
  const end = matchingClose(clean, at);
  return end < 0 ? null : source.slice(at + 1, end);
}

/** `text` without one layer of matching quotes or a template literal's backticks. */
const unquote = (text) =>
  String(text ?? "")
    .trim()
    .replace(/^(["'`])([\s\S]*)\1$/u, "$2");

const normalizeCode = (text) =>
  String(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();

/**
 * Whether a copy's evidence parser IS the template's, read from the two sources rather than assumed.
 *
 * Every copy of this parser is the `a349cc48b39c` clone group, and the template now owns it. A copy whose parser
 * differs in any character is a refusal: the definition receives the template's parse, and a stricter copy would have
 * refused evidence the run now accepts.
 */
export function parserMatchesTemplate(copyBody, templateBody) {
  return normalizeCode(copyBody) === normalizeCode(templateBody);
}

/**
 * The definition's fields, read from `defineSmokeScenario`'s OWN validators in the template.
 *
 * This is the one thing that keeps a codemod honest across a template change. The rewrite below writes a definition
 * with a fixed set of fields; if the template starts requiring one more, a codemod that keeps writing the old set would
 * produce a file that throws `native_local_scenario_definition_invalid:<field>` at import - loud, but only where someone
 * runs it. Reading the required set from the template's own `requireField`/`requireList` calls turns that into a refusal
 * here, with the field named, at the moment the template moves.
 */
export function templateDefinitionContract(templateSource) {
  const body = functionBody(templateSource ?? "", "defineSmokeScenario");
  if (body === null) return { ok: false, why: "template_defineSmokeScenario_unreadable" };
  const required = new Set(
    [...body.matchAll(/require(?:Field|List)\(definition,\s*"([A-Za-z]+)"/gu)].map((match) => match[1]),
  );
  if (required.size === 0) return { ok: false, why: "template_definition_contract_unreadable" };
  const readable = new Set([...required, ...[...body.matchAll(/definition\.([A-Za-z]+)/gu)].map((match) => match[1])]);
  return { ok: true, required, readable };
}

/** The definition fields this codemod writes. Anything else is not a definition. */
export const EMITTED_FIELDS = Object.freeze([
  "action",
  "fixtureScenario",
  "successCode",
  "refusesConfig",
  "requiredCapabilities",
  "requiredActions",
  "experimentalActions",
  "negative",
  "negativeOmittedBecause",
  "prepare",
  "request",
  "assertPostcondition",
]);

/** Every field this codemod writes is one the template reads, and every field it requires is one this codemod writes. */
export function contractFailure(contract) {
  if (!contract.ok) return contract.why;
  const emitted = new Set(EMITTED_FIELDS);
  for (const field of contract.required)
    if (!emitted.has(field)) return `template_definition_required_field_not_written:${field}`;
  for (const field of EMITTED_FIELDS)
    if (!contract.readable.has(field)) return `template_definition_field_unknown:${field}`;
  return null;
}

/**
 * Plan one runner's migration.
 *
 * `scenario` is the fixture world the action's gate arms, resolved by the caller from the action's own descriptor; it
 * is a parameter rather than something this planner works out for itself, because a runner cannot know it and a
 * guessed world is a run that arms something nobody asked for.
 */
export function planMigration(source, { scenario, templateSource }) {
  const drift = contractFailure(templateDefinitionContract(templateSource));
  if (drift !== null) return refuse(drift);
  if (readRunner(source).conforming) return { ok: true, alreadyMigrated: true, output: source };
  const reading = readLifecycle(source);
  if (reading.match !== true) return refuse(`shape_does_not_match:${reading.reason}`);
  const body = readRunBody(source);
  if (!body.ok) return refuse(body.why);
  if (!body.guarded)
    return refuse("run_body_is_not_guarded: a throw would escape the runner instead of reporting blocked");
  if (body.epilogue.length > 0) return refuse(`epilogue_statement_unaccounted:${body.epilogue[0].text}`);
  const statements = body.statements.map((entry) => ({ ...entry, flat: normalizeCode(entry.code) }));
  const bodyText = statements.map((entry) => entry.raw).join("\n");
  const inherited = [];
  const findings = [];
  /** The helper a statement hands the config to, when that helper really refuses the fixture topology. */
  const configRefusal = (entry) => {
    const call = /^(?:const\s+([A-Za-z_$][\w$]*)\s*=\s*)?([A-Za-z_$][\w$]*)\(\s*config\s*\);$/u.exec(
      entry.flat ?? normalizeCode(entry.code),
    );
    if (call === null) return null;
    const helper = functionBody(source, call[2]);
    if (helper === null || !/\bNativeLocalPlayerFixture\b/u.test(helper)) return null;
    if (call[1] !== undefined && mentions(bodyText, call[1])) return null;
    return call[2];
  };
  for (const entry of body.prologue.map((entry) => ({ ...entry, flat: normalizeCode(entry.code) }))) {
    if (/^(?:const trace = \[\];|const startedAt = Date\.now\(\);|let lastSnapshot = null;)$/u.test(entry.flat))
      continue;
    const refusal = configRefusal(entry);
    if (refusal !== null) {
      inherited.push(refusal);
      continue;
    }
    return refuse(`prologue_statement_unaccounted:${entry.text}`);
  }
  if (body.catchBody !== null) {
    const catchCode = normalizeCode(body.catchBody);
    if (!(/state: "blocked"/u.test(catchCode) && /reasonCode: [^,}]*error/u.test(catchCode)))
      return refuse("catch_block_is_not_the_canonical_blocked_return");
  }

  let at = 0;
  const take = () => statements[at++];
  const peek = () => statements[at];

  while (peek() !== undefined) {
    const refusal = configRefusal(peek());
    if (refusal === null) break;
    inherited.push(refusal);
    take();
  }
  if (inherited.length === 0)
    findings.push(
      "config_refusal_missing: this copy never read its fixture config, so the definition declares " +
        "refusesConfig: false and the template runs no refusal - a caller that hands it an invalid config gets the " +
        "copy's behaviour, which is that nothing checks one",
    );

  const observed = /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+observeFresh\(client,/u.exec(peek()?.code ?? "");
  if (observed === null)
    return refuse(`first_statement_is_not_the_opening_observation:${peek()?.text ?? "empty_body"}`);
  const observedName = observed[1];
  take();

  const capabilities = /^assertRequiredCapabilities\(\s*([A-Za-z_$][\w$]*)\s*,\s*([^)]+?)\s*\);$/u.exec(
    peek()?.code ?? "",
  );
  if (capabilities === null || capabilities[1] !== observedName)
    return refuse(`second_statement_is_not_the_capability_check:${peek()?.text ?? "none"}`);
  const capabilitiesText = capabilities[2];
  take();

  const prepare = [];
  while (at < statements.length && !/^const requestId = /u.test(statements[at].code)) {
    const entry = statements[at];
    if (LIFECYCLE_CALLS.execute.test(entry.code)) return refuse(`prepare_region_submits_a_request:${entry.text}`);
    if (LIFECYCLE_CALLS.observe.test(entry.code)) return refuse(`prepare_region_observes_again:${entry.text}`);
    if (LIFECYCLE_CALLS.wait.test(entry.code)) return refuse(`prepare_region_waits_for_a_terminal:${entry.text}`);
    if (/\bawait\b/u.test(entry.code)) return refuse(`prepare_statement_is_a_phase:${entry.text}`);
    prepare.push(entry);
    take();
  }

  const mint = /^const requestId = `(native_local_[^`]*)`;$/u.exec(peek()?.flat ?? "");
  if (mint === null) return refuse(`request_id_mint_is_not_the_canonical_step:${peek()?.text ?? "none"}`);
  take();

  let argsExpression = null;
  const declaredArgs = /^const args = ([\s\S]*);$/u.exec(peek()?.code ?? "");
  if (declaredArgs !== null) {
    argsExpression = declaredArgs[1].trim();
    take();
  }

  const submitted = /^const accepted = await executeFresh\(client, ([\s\S]*)\);$/u.exec(peek()?.code ?? "");
  if (submitted === null) return refuse(`request_is_not_the_canonical_step:${peek()?.text ?? "none"}`);
  const envelope = parseObjectLiteral(submitted[1]);
  if (envelope === null) return refuse("request_envelope_is_not_an_object_literal");
  const field = (key) => envelope.find((entry) => entry.key === key)?.value ?? null;
  if (field("requestId") !== "requestId") return refuse(`request_envelope_requestId:${field("requestId")}`);
  if (unquote(field("idempotencyKey")) !== "${requestId}_idem")
    return refuse(`request_envelope_idempotencyKey:${field("idempotencyKey")}`);
  if (field("snapshot") !== observedName) return refuse(`request_envelope_snapshot:${field("snapshot")}`);
  const timeout = field("timeoutMs");
  if (timeout !== null && Number(String(timeout).replace(/_/gu, "")) !== 30_000)
    return refuse(`request_timeout_differs:${timeout}`);
  argsExpression = argsExpression ?? field("args");
  if (argsExpression === null) return refuse("request_envelope_has_no_args");
  take();

  while (peek() !== undefined && /^trace\.push\(/u.test(peek().code)) take();

  const waited = /^const terminal = await waitForTerminal\(receipts, accepted, terminalTimeoutMs\);$/u.exec(
    peek()?.code ?? "",
  );
  if (waited === null) return refuse(`terminal_wait_is_not_the_canonical_step:${peek()?.text ?? "none"}`);
  take();

  let successCode = null;
  const identity =
    /^if \(terminal\.(?:requestId|executionId) !== (?:requestId|accepted\.executionId) \|\| terminal\.(?:requestId|executionId) !== (?:requestId|accepted\.executionId)\) throw new Error\(/u.test(
      peek()?.flat ?? "",
    );
  if (identity) {
    take();
    const succeeded =
      /^if \(terminal\.state !== "succeeded" \|\| terminal\.reasonCode !== "([a-z0-9_]+)"\) throw new Error\(/u.exec(
        peek()?.flat ?? "",
      );
    if (succeeded === null) return refuse(`terminal_success_check_is_not_the_canonical_step:${peek()?.text ?? "none"}`);
    successCode = succeeded[1];
    take();
  } else {
    // The two checks behind one helper - read from the helper's own body, so a call is not taken as a licence to drop
    // whatever the helper does.
    const checked = /^assertTerminal\(terminal, accepted, requestId, "([a-z0-9_]+)"\);$/u.exec(peek()?.flat ?? "");
    if (checked === null) return refuse(`terminal_identity_check_is_not_the_canonical_step:${peek()?.text ?? "none"}`);
    const helper = functionBody(source, "assertTerminal");
    if (
      helper === null ||
      !/terminal\.requestId !== requestId/u.test(helper) ||
      !/terminal\.state !== "succeeded"/u.test(helper)
    )
      return refuse("terminal_check_helper_is_not_the_two_canonical_checks");
    successCode = checked[1];
    take();
  }

  const parsed = /^const ([A-Za-z_$][\w$]*) = ([A-Za-z_$][\w$]*)\(terminal\.evidence\);$/u.exec(peek()?.code ?? "");
  const templateParser = functionBody(templateSource ?? "", "parseEvidence");
  if (parsed === null)
    return refuse(
      "evidence_parse_missing: the template parses the terminal's evidence and this copy never did, so the migrated " +
        `runner would block on a receipt shape the copy accepted: ${peek()?.text ?? "none"}`,
    );
  const evidenceName = parsed[1];
  const copyParser = functionBody(source, parsed[2]);
  if (copyParser === null || templateParser === null) return refuse(`evidence_parser_unresolved:${parsed[2]}`);
  if (!parserMatchesTemplate(copyParser, templateParser)) return refuse(`evidence_parser_differs:${parsed[2]}`);
  take();

  while (peek() !== undefined && /^trace\.push\(/u.test(peek().code)) take();

  const frame =
    /^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:observeFresh|waitForFreshSnapshot)\(client,/u.exec(
      peek()?.code ?? "",
    );
  if (frame === null) return refuse(`post_terminal_frame_missing:${peek()?.text ?? "none"}`);
  const frameName = frame[1];
  take();

  while (peek() !== undefined) {
    const entry = peek();
    if (/^assertRequiredCapabilities\(/u.test(entry.code)) {
      take();
      continue;
    }
    if (LIFECYCLE_CALLS.execute.test(entry.code)) return refuse(`stale_re_send_not_lifted:${entry.line}:${entry.text}`);
    if (LIFECYCLE_CALLS.wait.test(entry.code)) {
      take();
      continue;
    }
    if (
      /^(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*await\s+observeFresh\(client,/u.test(entry.code) &&
      !mentions(entry.code, frameName)
    ) {
      take();
      continue;
    }
    break;
  }

  const judgement = [];
  let resultStatement = null;
  while (peek() !== undefined) {
    const entry = peek();
    if (/^return /u.test(entry.code)) {
      resultStatement = take();
      break;
    }
    judgement.push(take());
  }
  if (resultStatement === null) return refuse("run_body_has_no_passing_return");

  const resultText = (() => {
    const blankRaw = blankComments(resultStatement.raw);
    const returnAt = blankRaw.indexOf("return");
    return resultStatement.raw
      .slice(returnAt)
      .replace(/^return\s+/u, "")
      .replace(/;\s*$/u, "");
  })();
  const result = parseObjectLiteral(resultText);
  if (result === null) return refuse("passing_result_is_not_an_object_literal");
  const stateEntry = result.find((entry) => entry.key === "state");
  const reasonEntry = result.find((entry) => entry.key === "reasonCode");
  if (stateEntry === undefined) return refuse("passing_result_has_no_state");

  const guardedBy = /^([A-Za-z_$][\w$]*)\s*\?\s*"passed"\s*:\s*"blocked"$/u.exec(stateEntry.value.trim());
  const alwaysPassed = stateEntry.value.trim() === '"passed"';
  if (!alwaysPassed && guardedBy === null) return refuse(`result_state_unliftable:${stateEntry.value}`);
  const passVariable = guardedBy === null ? null : guardedBy[1];
  if (passVariable !== null) {
    const declared = judgement.some((entry) =>
      new RegExp(`^const ${escapeRegExp(passVariable)} = `, "u").test(entry.code),
    );
    if (!declared) return refuse(`result_state_names_an_undeclared_judgement:${passVariable}`);
  }
  if (reasonEntry === undefined) return refuse("passing_result_has_no_reasonCode");
  let passedCode = null;
  let failureCode = null;
  if (passVariable === null) {
    passedCode = unquote(reasonEntry.value);
  } else {
    const value = reasonEntry.value.trim();
    const question = indexAtTopLevel(value, "?");
    const branches = question < 0 ? "" : value.slice(question + 1);
    const colon = indexAtTopLevel(branches, ":");
    if (question < 0 || colon < 0) return refuse(`result_reasonCode_unliftable:${reasonEntry.value}`);
    passedCode = unquote(branches.slice(0, colon));
    failureCode = branches.slice(colon + 1).trim();
  }
  if (passedCode === null) return refuse(`result_reasonCode_unliftable:${reasonEntry.value}`);
  if (passedCode !== successCode && passedCode !== "terminal.reasonCode")
    return refuse(`success_code_disagrees:${successCode}:${passedCode}`);
  if (passVariable !== null && (failureCode === null || failureCode.length === 0))
    return refuse(`result_failure_reason_unliftable:${reasonEntry.value}`);

  const owned = new Set(["state", "topology", "reasonCode", "trace", "durationMs"]);
  const measured = [];
  for (const entry of result) {
    if (owned.has(entry.key)) continue;
    if (entry.key === "receipt") {
      if (entry.value.replace(/\s+/gu, "") === "summarizeReceipt(terminal)") continue;
      return refuse(`result_object_unliftable:receipt:${entry.value}`);
    }
    if (entry.key === "evidence") {
      if (entry.value === evidenceName) continue;
      return refuse(`result_object_unliftable:evidence:${entry.value}`);
    }
    measured.push(entry);
  }

  const parse = /^const SCENARIO = ["']([^"']+)["'];/mu.exec(blankComments(source));
  if (parse !== null && parse[1] !== scenario) return refuse(`fixture_scenario_disagrees:${parse[1]}:${scenario}`);
  const scenarioConstant = parse === null ? null : "SCENARIO";

  const planned = declaredNames(prepare);
  const post = [];
  for (const entry of judgement) {
    let text = entry.raw.trim();
    if (mentions(text, observedName) && observedName !== "before")
      text = renameIdentifier(text, observedName, "before");
    if (frameName !== "after" && mentions(text, frameName)) text = renameIdentifier(text, frameName, "after");
    if (evidenceName !== "evidence" && mentions(text, evidenceName))
      text = renameIdentifier(text, evidenceName, "evidence");
    post.push(text);
  }
  const postDeclared = declaredNames([{ code: post.join("\n") }]);
  const postUsed = [...planned].filter((name) => post.some((text) => mentions(text, name)) && !postDeclared.has(name));

  const prepareText = prepare.map((entry) =>
    observedName === "snapshot" ? entry.raw.trim() : renameIdentifier(entry.raw.trim(), observedName, "snapshot"),
  );
  const argsUsed = [...planned].filter((name) => mentions(argsExpression, name));

  return {
    ok: true,
    alreadyMigrated: false,
    action: reading.facts.action,
    successCode,
    scenario,
    scenarioConstant,
    negativeOmittedBecause: "no_stale_re_send_in_the_hand_written_copy_this_migrated",
    refusesConfig: inherited.length > 0,
    findings,
    capabilitiesText,
    prepareText,
    planned,
    argsExpression,
    requestUsed: argsUsed,
    postText: post,
    postUsed,
    passVariable,
    failureCode,
    measured,
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  if (argv.includes("--census")) {
    const result = census();
    if (argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ examined: result.examined, matched: result.matched, mismatched: result.mismatched }, null, 2)}\n`,
      );
      process.exitCode = result.examined === 0 ? 2 : 0;
      return;
    }
    for (const line of renderCensus(result)) process.stdout.write(`${line}\n`);
    process.exitCode = result.examined === 0 ? 2 : 0;
    return;
  }

  const templateSource = readFileSync(resolve(ROOT, "tools/lib/native-local-runner-scaffold.mjs"), "utf8");
  const explicit = argv.filter((argument) => !argument.startsWith("--"));
  const files = argv.includes("--all") ? censusPopulation().files : explicit;
  if (files.length === 0) {
    process.stdout.write(
      "usage: node tools/migrate-runner-to-template.mjs --census | --all [--write] | <runner> [--write]\n",
    );
    process.exitCode = 2;
    return;
  }

  let migrated = 0;
  let skipped = 0;
  for (const file of files) {
    const source = readFileSync(resolve(ROOT, file), "utf8");
    const result = migrateSource(source, { file, templateSource });
    if (!result.ok) {
      process.stdout.write(`not_migratable:${file}:${result.why}\n`);
      if (!argv.includes("--all")) process.exitCode = 1;
      continue;
    }
    if (result.alreadyMigrated) {
      process.stdout.write(`already_migrated:${file}\n`);
      skipped++;
      continue;
    }
    const before = source.split("\n").length;
    const after = result.output.split("\n").length;
    for (const finding of result.findings ?? []) process.stdout.write(`finding:${file}:${finding}\n`);
    if (write) {
      writeFileSync(resolve(ROOT, file), result.output, "utf8");
      process.stdout.write(`migrated:${file}:${before}->${after}\n`);
    } else {
      for (const line of lineDiff(source, result.output)) process.stdout.write(`${line}\n`);
      process.stdout.write(`\nwould_migrate:${file}:${before}->${after}\n`);
    }
    migrated++;
  }
  if (argv.includes("--all"))
    process.stdout.write(
      `\nbatch: examined ${files.length} · would migrate ${migrated} · already on the template ${skipped}\n`,
    );
  else process.exitCode = process.exitCode ?? 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

/* ---------------------------------------------------------------------------------------------------------------
 * RENDERING THE MIGRATED FILE
 * ------------------------------------------------------------------------------------------------------------- */

/** The file's leading comment block, verbatim, or "". */
export function leadingComments(source) {
  const text = String(source ?? "");
  let index = 0;
  while (index < text.length && /\s/u.test(text[index])) index++;
  let end = index;
  while (text.startsWith("//", end) || text.startsWith("/*", end)) {
    if (text.startsWith("//", end)) {
      const newline = text.indexOf("\n", end);
      end = newline < 0 ? text.length : newline + 1;
    } else {
      const close = text.indexOf("*/", end + 2);
      end = close < 0 ? text.length : close + 2;
      while (end < text.length && /[ \t]/u.test(text[end])) end++;
      if (text[end] === "\n") end++;
    }
    while (end < text.length && /[ \t]/u.test(text[end])) end++;
  }
  return text.slice(0, end);
}

/** The exported names of a module, in source order. */
export function exportedNames(source) {
  const clean = blankComments(source);
  return [...clean.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gu)]
    .map((match) => match[1])
    .sort();
}

/** `import { a, b } from "mod";` as `{ module, names }`, or null for a form this tool does not rewrite. */
export function readImport(code) {
  const named = /^import\s*\{([\s\S]*)\}\s*from\s*["']([^"']+)["']\s*;?$/u.exec(code.trim());
  if (named === null) return null;
  const names = splitTopLevelPieces(named[1], ",").map((piece) =>
    piece
      .split(/\s+as\s+/u)
      .pop()
      .trim(),
  );
  return { module: named[2], names };
}

/**
 * The migrated source: the copy's own comments, constants and helper functions, with the lifecycle replaced by the
 * template and the judgement lifted verbatim into the definition.
 */
export function renderMigratedSource(source, plan, { templateModule = TEMPLATE_IMPORT } = {}) {
  const header = leadingComments(source);
  const rest = source.slice(header.length);
  const chunks = splitStatements(rest);
  const kept = [];
  const imports = [];
  let replaced = 0;
  for (const entry of chunks.statements) {
    const code = entry.code;
    if (/^import\b/u.test(code)) {
      const parsed = readImport(code);
      if (parsed === null) return { ok: false, why: `import_form_not_rewritable:${entry.text.slice(0, 80)}` };
      imports.push(parsed);
      continue;
    }
    if (/^export\s+(?:async\s+)?function\s+run[A-Z]\w*Smoke\s*\(/u.test(code)) {
      replaced++;
      continue;
    }
    if (/^if \(import\.meta\.main\)/u.test(code)) {
      replaced++;
      continue;
    }
    const declared = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/u.exec(code);
    const isExported = /^export\b/u.test(code);
    kept.push({ text: entry.text, name: declared === null || isExported ? null : declared[1] });
  }
  if (replaced !== 2) return { ok: false, why: `expected_to_replace_the_run_function_and_the_bootstrap:${replaced}` };

  const exportName = /export\s+(?:async\s+)?function\s+(run[A-Z]\w*Smoke)\s*\(/u.exec(source);
  if (exportName === null) return { ok: false, why: "exported_run_function_name_unresolved" };

  const destructure = (names) => (names.length === 0 ? [] : [`    const { ${names.join(", ")} } = plan;`]);
  const plannedNames = [...plan.planned];
  // The judgement names its own parameters. Emitting all of them would leave unused bindings in every migrated file,
  // and emitting a fixed four is what made a verdict that reads `terminal.revision` throw `terminal is not defined`.
  const postText = plan.postText.join("\n");
  const measuredText = plan.measured.map((entry) => `${entry.key}: ${entry.value}`).join(", ");
  const postParameters = ["client", "receipts", "evidence", "terminal", "before", "after", "plan", "trace"]
    .filter((name) => name === "plan" || mentions(postText, name) || mentions(measuredText, name))
    .join(", ");
  const definition = [
    "const scenario = defineSmokeScenario({",
    "  action: ACTION,",
    plan.scenarioConstant === null
      ? "  fixtureScenario: FIXTURE_SCENARIO,"
      : `  fixtureScenario: ${plan.scenarioConstant},`,
    "  successCode: SUCCESS_CODE,",
    `  refusesConfig: ${plan.refusesConfig},`,
    `  requiredCapabilities: ${plan.capabilitiesText},`,
    ...(plan.refusesConfig ? ["  requiredActions: [ACTION],", "  experimentalActions: [ACTION],"] : []),
    `  negativeOmittedBecause: ${JSON.stringify(plan.negativeOmittedBecause)},`,
    "",
    "  prepare: ({ snapshot }) => {",
    ...plan.prepareText.map((line) => `    ${line}`),
    plannedNames.length === 0
      ? "    return { snapshot, plan: {} };"
      : `    return { snapshot, plan: { ${plannedNames.join(", ")} } };`,
    "  },",
    "",
    ...(plan.requestUsed.length === 0
      ? [`  request: () => ({ args: ${plan.argsExpression} }),`]
      : [
          "  request: (plan) => {",
          ...destructure(plan.requestUsed),
          `    return { args: ${plan.argsExpression} };`,
          "  },",
        ]),
    "",
    `  async assertPostcondition({ ${postParameters} }) {`,
    ...destructure(plan.postUsed),
    ...plan.postText.map((line) => `    ${line}`),
    ...(plan.passVariable === null
      ? []
      : [
          `    if (!(${plan.passVariable})) throw new Error(${/^["']/u.test(plan.failureCode) ? plan.failureCode : `String(${plan.failureCode})`});`,
        ]),
    `    return { ${plan.measured.map((entry) => (entry.shorthand ? entry.key : `${entry.key}: ${entry.value}`)).join(", ")} };`,
    "  },",
    "});",
    "",
    `export const ${exportName[1]} = (client, receipts, config, options) =>`,
    "  scenario.run(client, receipts, config, options);",
    "",
    "if (import.meta.main) await runSmokeScenarioMain(scenario);",
  ];

  const constants = plan.scenarioConstant
    ? []
    : [
        "/** The `NativeLocalPlayerFixture.FixtureScenario` the action's gate descriptor arms. */",
        `const FIXTURE_SCENARIO = ${JSON.stringify(plan.scenario)};`,
      ];
  constants.unshift(
    "/** The action's own success word, as the terminal check in the hand-written copy spelled it. */",
    `const SUCCESS_CODE = ${JSON.stringify(plan.successCode)};`,
  );

  const definitionText = definition;
  const assemble = (declarations) =>
    [header, ...declarations.map((entry) => entry.text), ...constants, ...definitionText].join("\n");
  let declarations = kept;
  for (;;) {
    const text = assemble(declarations);
    const next = declarations.filter(
      (entry) => entry.name === null || mentions(text.replace(entry.text, ""), entry.name),
    );
    if (next.length === declarations.length) break;
    declarations = next;
  }
  const assembled = assemble(declarations);
  const importLines = [`import { defineSmokeScenario, runSmokeScenarioMain } from ${JSON.stringify(templateModule)};`];
  for (const entry of imports) {
    const names = entry.names.filter((name) => mentions(assembled, name));
    if (names.length === 0) continue;
    importLines.push(`import { ${names.join(", ")} } from ${JSON.stringify(entry.module)};`);
  }
  return { ok: true, output: `${importLines.join("\n")}\n\n${assembled.trim()}\n` };
}

/* ---------------------------------------------------------------------------------------------------------------
 * A LINE DIFF, so a dry run is READ rather than trusted
 * ------------------------------------------------------------------------------------------------------------- */

export function lineDiff(before, after) {
  const left = String(before).split("\n");
  const right = String(after).split("\n");
  const longest = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0));
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      longest[i][j] = left[i] === right[j] ? longest[i + 1][j + 1] + 1 : Math.max(longest[i + 1][j], longest[i][j + 1]);
  const lines = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      lines.push(` ${left[i]}`);
      i++;
      j++;
    } else if (longest[i + 1][j] >= longest[i][j + 1]) {
      lines.push(`-${left[i]}`);
      i++;
    } else {
      lines.push(`+${right[j]}`);
      j++;
    }
  }
  while (i < left.length) lines.push(`-${left[i++]}`);
  while (j < right.length) lines.push(`+${right[j++]}`);
  return lines;
}

/* ---------------------------------------------------------------------------------------------------------------
 * THE FIXTURE WORLD, FROM THE ACTION'S OWN DESCRIPTOR
 * ------------------------------------------------------------------------------------------------------------- */

/**
 * The action keys that resolve to one runner file, and the fixture world each arms.
 *
 * The world is NOT something a runner knows: it is the gate descriptor's own record, and `fixtureScenario` in
 * `tools/lib/stardew-native-local-player-fixture.mjs` is the function that decides it from the action key. Both are
 * read here rather than copied, so a re-keyed gate moves its runner's world with it.
 */
export function actionKeysForRunner(
  fileName,
  { published = STARDEW_PUBLISHED_ACTION_GATES, experimental = STARDEW_EXPERIMENTAL_ACTION_RUNNERS } = {},
) {
  const rows = [];
  for (const row of published)
    if (row.runner === fileName) rows.push({ actionId: row.actionId, scenario: row.fixtureScenario });
  for (const [actionId, runner] of Object.entries(experimental))
    if (runner === fileName) rows.push({ actionId, scenario: null });
  return rows.map((row) => ({
    actionId: row.actionId,
    scenario: row.scenario ?? fixtureScenario(fixtureActions(row.actionId), row.actionId),
  }));
}

/** The one fixture world this runner arms, or the reason it is not one. */
export function resolveScenario(rows) {
  if (rows.length === 0) return { ok: false, why: "no_action_key_resolves_to_this_runner" };
  const worlds = [...new Set(rows.map((row) => row.scenario))].filter(
    (world) => typeof world === "string" && world.length > 0,
  );
  if (worlds.length === 0)
    return { ok: false, why: `fixture_scenario_empty:${rows.map((row) => row.actionId).join(",")}` };
  if (worlds.length > 1) return { ok: false, why: `fixture_scenario_ambiguous:${worlds.sort().join(",")}` };
  return { ok: true, scenario: worlds[0], actionIds: rows.map((row) => row.actionId) };
}

/** One runner's migration, from its file on disk to the text `--write` would put there. */
export function migrateSource(source, { file, templateSource }) {
  const resolved = resolveScenario(actionKeysForRunner(basename(file)));
  if (!resolved.ok) return refuse(resolved.why);
  const plan = planMigration(source, { scenario: resolved.scenario, templateSource });
  if (!plan.ok) return plan;
  if (plan.alreadyMigrated) return { ok: true, alreadyMigrated: true, output: source };
  const rendered = renderMigratedSource(source, plan);
  if (!rendered.ok) return refuse(rendered.why);
  const before = exportedNames(source);
  const after = exportedNames(rendered.output);
  if (before.join(",") !== after.join(","))
    return refuse(`exports_would_change:${before.join(",")}->${after.join(",")}`);
  return { ok: true, alreadyMigrated: false, output: rendered.output, plan, findings: plan.findings };
}
