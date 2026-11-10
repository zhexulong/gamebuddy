#!/usr/bin/env node
/**
 * Gate for the "a run analysis printed a number nobody can re-derive" bug class.
 *
 * THE DEFECT THIS EXISTS FOR. On 2026-11-10 a verdict reported `plan_work=97` calls. The tool had been dispatched 26
 * times. The 97 came from `sessionText.split("plan_work").length - 1`: a count of a TOKEN in a TEXT BLOB, where the
 * population a reader hears ("calls") is not the population the counter examined ("occurrences of the name, including
 * the tool schema that lists it, the prompt that names it, and every mention in a tool result"). Every arithmetic in
 * that report was correct; the number was still wrong by 3.7x, and nothing in the report could have caught it because
 * the count arrived with no population, no method and no second reader.
 *
 * THE RULE. In an analysis script, a count of a token in a text blob is a `bare_reading` unless it is routed through
 * `tools/lib/reading.mjs` - the seam that cannot be constructed without a population, a source, a method and a window
 * (`reading`, `census`), whose formatter renders all four with the number (`format`, `formatCensus`), and whose
 * `crossCheck` puts two methods side by side instead of letting a caller pick one.
 *
 * WHAT COUNTS AS A TOKEN CENSUS: `<something>.split(<argument>).length`. Three shapes are NOT this rule, on purpose:
 *
 *   - `text.split("\n")` iterated in a `for` loop - no `.length` on the result, so it is not a count at all;
 *   - `source.slice(0, index).split("\n").length` - a LINE NUMBER derived from a prefix, i.e. a source position, not a
 *     count of anything in the run. A line-break argument is excluded for this reason and no other;
 *   - `text.split(fieldOfTheMoment).length` inside a per-message check - left to the two exemptions below, which are
 *     keyed by the expression text so they expire the moment that expression is rewritten.
 *
 * WHAT IT DOES NOT SEE, stated so a green run is not read as more than it is. It reads how a count is COUNTED, not how
 * a number is RENDERED: `seconds(ms)`, `percentOf(part, whole)` and `${a - b}` printed from named locals all pass,
 * because the gate would have to flag a tenth of `tools/` to reach them, and a gate red on a tenth of the tree is
 * turned off rather than fixed. A script that reads a run's artifacts but builds its counts some other way (a Map of
 * tallies not written as `split().length`) is likewise invisible here; that half of the class belongs to the seam's own
 * refusals - an unrouted number can no longer be given a population, formatted, or cross-checked at all.
 *
 * THE POPULATION is a directory scan, not a list: every `.mjs` under `tools/live-run/` and every `tools/audit-*.mjs`,
 * minus `*.test.mjs`. `tools/live-run/frontend/.tmp` and any other dot-directory are skipped because a gitignored
 * scratch tree would make the population - and therefore the verdict - differ per machine. A scan that matches nothing
 * is BLOCKED, never green: `scripts examined 0` says the scan broke, not that every script is clean.
 *
 * Usage: node tools/audit-run-reading-shape.mjs
 *
 * red-proof: `tools/audit-run-reading-shape.test.mjs` drives the rule red on the round43 expression itself
 * (`text.split("plan_work").length - 1`), on a stale exemption, and on an empty population.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJavaScript } from "./lib/javascript-ast.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the analysis scripts live. Directory rules only: a hand-maintained file list is a test, not a gate. */
const SCANNED_TREES = Object.freeze([
  Object.freeze({ directory: "tools/live-run", filePrefix: null }),
  Object.freeze({ directory: "tools", filePrefix: "audit-" }),
]);

const SKIPPED_DIRECTORIES = Object.freeze(new Set(["node_modules", "fixtures"]));

/** The seam a count has to come through, and the call sites that count as routing one. */
const READING_MODULE = /from\s+["'][^"']*lib\/reading\.mjs["']/u;
const ROUTING_CALLS = Object.freeze(new Set(["reading", "census", "format", "formatCensus", "verdictFrom"]));

/**
 * Line breaks, spelled as they appear inside the string literal: `split("\n").length` on a prefix is a source
 * position, not a count of anything in the run.
 */
const LINE_BREAK_LITERALS = Object.freeze(new Set(["\\n", "\\r\\n", "\\r"]));

/**
 * The two counts this gate does not own. Each is an occurrence count of a runtime FRAGMENT inside ONE message, used as
 * a predicate ("the card appears exactly once") rather than reported as a run reading, and the population it would need
 * - the fragments that could have appeared - is not enumerable. Converting them would change what the check proves, and
 * that check belongs to the chat lane. The expression text is the key: rewrite either line and the entry goes stale,
 * which turns this gate red until someone decides the new shape on purpose.
 */
const EXEMPTIONS = Object.freeze([
  Object.freeze({
    file: "tools/live-run/chat/check-post-history-instructions-live.mjs",
    expression: "text.split(field).length",
    reason: "a predicate over one request's text ('the card appears once'), with no enumerable population",
  }),
  Object.freeze({
    file: "tools/live-run/chat/run-post-history-live.mjs",
    expression: "text.split(field).length",
    reason: "a predicate over one request's text ('the card appears once'), with no enumerable population",
  }),
]);

function toPosix(path) {
  return path.split("\\").join("/");
}

/** Every analysis script under the scanned trees, as repo-relative file names with their source. */
export function collectScripts(root = ROOT) {
  const scripts = [];
  const walk = (absoluteDirectory) => {
    let entries;
    try {
      entries = readdirSync(absoluteDirectory);
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(absoluteDirectory, entry);
      const stat = statSync(path);
      if (stat.isDirectory()) {
        if (entry.startsWith(".") || SKIPPED_DIRECTORIES.has(entry)) continue;
        walk(path);
        continue;
      }
      if (!entry.endsWith(".mjs") || entry.endsWith(".test.mjs")) continue;
      scripts.push({ fileName: toPosix(relative(root, path)), source: readFileSync(path, "utf8") });
    }
  };
  for (const tree of SCANNED_TREES) {
    const directory = join(root, tree.directory);
    if (tree.filePrefix === null) {
      walk(directory);
      continue;
    }
    for (const entry of readdirSync(directory)) {
      if (!(entry.startsWith(tree.filePrefix) && entry.endsWith(".mjs")) || entry.endsWith(".test.mjs")) continue;
      scripts.push({
        fileName: toPosix(join(tree.directory, entry)),
        source: readFileSync(join(directory, entry), "utf8"),
      });
    }
  }
  return scripts.sort((left, right) => left.fileName.localeCompare(right.fileName));
}

function collapse(text) {
  return text.replace(/\s+/gu, " ").trim();
}

/** `<x>.split(<arg>).length`, or null. */
function tokenCensus(node) {
  if (node.type !== "member_expression") return null;
  if ((node.childForFieldName("property")?.text ?? "") !== "length") return null;
  const object = node.childForFieldName("object");
  if (object?.type !== "call_expression") return null;
  const callee = object.childForFieldName("function");
  if (callee?.type !== "member_expression") return null;
  if ((callee.childForFieldName("property")?.text ?? "") !== "split") return null;
  const argument = object.childForFieldName("arguments")?.namedChildren[0] ?? null;
  if (argument?.type === "string" && LINE_BREAK_LITERALS.has(argument.text.slice(1, -1))) return null;
  return node;
}

/**
 * Examine one script's syntax tree.
 *
 * `routed` counts call sites of the seam in a file that imports the seam - a local function named `format` in a script
 * that does not import `tools/lib/reading.mjs` is that script's own formatter and would be a false reading of "this
 * script routes its numbers".
 */
export async function examineScript(script) {
  const tree = await parseJavaScript(script.source, script.fileName);
  const importsSeam = READING_MODULE.test(script.source);
  const bare = [];
  let routed = 0;
  const walk = (node) => {
    const censusNode = tokenCensus(node);
    if (censusNode !== null)
      bare.push({
        file: script.fileName,
        line: censusNode.startPosition.row + 1,
        rule: "bare_reading",
        expression: collapse(censusNode.text),
      });
    if (importsSeam && node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee?.type === "identifier" && ROUTING_CALLS.has(callee.text)) routed += 1;
    }
    for (const child of node.namedChildren) walk(child);
  };
  walk(tree.rootNode);
  tree.delete();
  return { bare, routed, importsSeam };
}

/**
 * The whole scan: every script examined, its token censuses, and the exemptions that no longer match anything.
 *
 * An exemption that matches nothing is `stale_reading_exemption`: the expression it exempted was rewritten or removed,
 * so the reason attached to it may no longer be true and the gate refuses to carry it forward silently.
 */
export async function examineScripts(scripts, exemptions = EXEMPTIONS) {
  const findings = [];
  let routed = 0;
  for (const script of scripts) {
    const examined = await examineScript(script);
    routed += examined.routed;
    findings.push(...examined.bare);
  }
  const exempted = [];
  const stale = [];
  for (const exemption of exemptions) {
    const script = scripts.find((candidate) => candidate.fileName === exemption.file);
    const matching = findings.filter(
      (finding) => finding.file === exemption.file && finding.expression === collapse(exemption.expression),
    );
    if (script === undefined || matching.length === 0) {
      stale.push({ file: exemption.file, expression: collapse(exemption.expression), reason: exemption.reason });
      continue;
    }
    exempted.push(...matching);
  }
  const bare = findings.filter((finding) => !exempted.includes(finding));
  return { examined: scripts.length, routed, bare, exempted, stale };
}

/**
 * The gate's verdict for one tree: the lines it prints and the exit status that goes with them.
 *
 * Returned rather than written so the suite asserts on the same values the CLI prints - a test that re-implemented the
 * summary would agree with itself while the gate said something else.
 */
export async function gate(root = ROOT) {
  const scripts = collectScripts(root);
  if (scripts.length === 0)
    return {
      examined: 0,
      routed: 0,
      bare: [],
      exempted: [],
      stale: [],
      lines: [
        "reading-shape_blocked: the scan matched no analysis scripts, so nothing was examined - this is a broken " +
          "population, not a clean tree",
      ],
      exitCode: 1,
    };
  const result = await examineScripts(scripts);
  const lines = [];
  for (const finding of result.bare)
    lines.push(`${finding.rule}:${finding.file}:${finding.line}  ${finding.expression}`);
  for (const exemption of result.exempted)
    lines.push(`exempt_reading:${exemption.file}:${exemption.line}  ${exemption.expression}`);
  for (const stale of result.stale)
    lines.push(`stale_reading_exemption:${stale.file}  ${stale.expression} - ${stale.reason}`);
  lines.push(
    `scripts examined ${result.examined} · readings routed ${result.routed} · bare prints ${result.bare.length}`,
  );
  return { ...result, lines, exitCode: result.bare.length === 0 && result.stale.length === 0 ? 0 : 1 };
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const verdict = await gate();
  process.stdout.write(`${verdict.lines.join("\n")}\n`);
  process.exitCode = verdict.exitCode;
}
