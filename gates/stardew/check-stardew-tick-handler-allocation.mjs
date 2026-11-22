#!/usr/bin/env node
/**
 * Guard: a handler the Mod registers on the game loop's tick allocates nothing per frame.
 *
 * WHY. `Game1`'s update runs sixty times a second and a registered `UpdateTicked` handler runs inside it. An
 * allocation there is a garbage-collection pause at a rate the player feels: a LINQ chain over a backpack, a `new[]`
 * built to call one native method, a format call on a value that changed nought times this tick. None of these is a
 * bug a test catches, because the result is correct - the cost is the frame, and this tree has already lost live runs
 * to a mod-side stall that no receipt could name.
 *
 * THE POPULATION IS THE REGISTRATION, NOT A NAME. Handlers are derived from the Mod's own subscriptions:
 * `…GameLoop.UpdateTicked += <handler>` and `…UpdateTicking += <handler>`. The handler is then resolved to the
 * declaration the subscription names - a local function inside the subscribing method where the Mod uses one
 * (`OnTick`), otherwise the method of that name in the same file. A handler the Mod stops registering leaves the
 * population; a new subscription is measured the moment it is written. Measured at this commit: 8 subscriptions, 3
 * allocating handlers, 5 clean. The pattern that fires most is not necessarily the one you expect: the fixtures'
 * per-tick eligibility probes are the heaviest, and the production handler's one hit is
 * `passOutTimeOfDay.ToString("D4")` - a string built sixty times a second for a value that changes once per ten
 * game-minutes.
 *
 * WHAT COUNTS AS ALLOCATING is a closed, decidable set, because a rule that cannot be checked is a rule nobody keeps:
 *
 *   linq                 a LINQ operator that materialises or enumerates (`.Where(`, `.Any(`, `.ToArray()`, …)
 *   collection           `new List`/`Dictionary`/`HashSet`/`Queue`/`Stack`/… bounded by `<`
 *   array                `new[]`
 *   serializer           `JsonSerializer.`, `JsonDocument.Parse`
 *   format               `.ToString("<format>")`, `string.Format(`, `string.Create(`, `string.Join(`
 *   string_concatenation_in_loop   a `+` with a string literal, an interpolated string or a `.ToString()` on either
 *                        side, inside a `for`/`foreach`/`while`/`do` of the same handler
 *
 * Not in the set, and said rather than implied: a closure capture, a boxed struct, an iterator behind a `yield`, and
 * any allocation made one call below the handler. Those are the handler's callees, and this gate's unit is the
 * handler; a check that followed calls would have to bound itself somewhere, and the bound chosen here is stated.
 *
 * WHY A BASELINE, SINCE A RATCHET IS THE WORSE OF TWO DESIGNS UNTIL IT IS NOT. The honest reading of this commit is
 * `3 of 8 handlers allocate`, and a gate that is red at HEAD fails the CI job for every lane, which is how a gate
 * stops being run. So the measured debt is recorded in `tools/stardew-tick-allocation-baseline.json` by CONTENT -
 * file, handler, pattern - and never by line number, because a site keyed by position reports changes that did not
 * happen. The ratchet turns both ways: an allocating handler the baseline does not record is
 * `tick_handler_allocates` (a new one cannot arrive quietly), and a recorded entry whose site is gone is
 * `tick_allocation_baseline_stale` (the debt must be deleted as it is paid, so the list cannot outlive it).
 *
 * OUTPUT. `handlers examined N · clean C · allocating A · recorded R`, then one line per finding. Exit 0 clean, 1 on
 * any finding, 2 when nothing was registered (a run that examined no handler is blocked, never green).
 *
 * Usage:
 *   node tools/check-stardew-tick-handler-allocation.mjs              # the reading, exit 1 on a finding
 *   node tools/check-stardew-tick-handler-allocation.mjs --json       # machine report
 *   node tools/check-stardew-tick-handler-allocation.mjs --list       # every handler and every hit, with the line
 *   node tools/check-stardew-tick-handler-allocation.mjs --root DIR   # read another tree (the falsifier suite)
 *   node tools/check-stardew-tick-handler-allocation.mjs --update     # record the current allocations as debt
 *
 * red-proof: inject  `this.cache = new List<string>();` added to the clean `OnTick` in a copy of the tree ->
 *                    `tick_handler_allocates:<file>:OnTick:collection`, exit 1; deleting a baseline entry whose
 *                    handler still allocates -> `tick_allocation_baseline_stale:<file>:<handler>:<pattern>`
 *                    (tools/check-stardew-tick-handler-allocation.test.mjs)
 */

export const gateDeclaration = {
  id: "check-stardew-tick-handler-allocation",
  domain: "stardew",
  tier: "l0",
  kind: "ratchet",
};

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, Parser } from "web-tree-sitter";
import { stripComments } from "./audit-stardew-test-shape.mjs";
import { describeUntracked, untrackedSources } from "../../tools/lib/indexed-sources.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const require = createRequire(import.meta.url);

export const MARKER = "\u2716";

const ROOT = repositoryRoot(import.meta.url);

/** The Mod's sources: this directory minus build output and the test projects. */
export const SOURCE_ROOT = join(ROOT, "integrations", "stardew");

/** The recorded debt: allocations that exist at this commit. See WHY A BASELINE above. */
export const BASELINE_PATH = join(ROOT, "tools", "stardew-tick-allocation-baseline.json");

const EXCLUDED_DIRECTORIES = new Set(["bin", "obj", "tests"]);

/**
 * The allocation patterns, as the closed set the header declares. Every one is a lexical property of the handler's
 * own body, so a reviewer can check any single line the gate reports.
 */
export const ALLOCATION_PATTERNS = Object.freeze({
  linq: /\.(?:Select|SelectMany|Where|Any|All|First|FirstOrDefault|Single|SingleOrDefault|ToArray|ToList|Concat|OfType|OrderBy|OrderByDescending|ThenBy|GroupBy|ToDictionary|Distinct|Skip|Take|Aggregate|Sum|Average|Min|Max|Cast|Zip|Count)\s*[<(]/u,
  collection:
    /new\s+(?:List|Dictionary|HashSet|SortedDictionary|SortedSet|Queue|Stack|LinkedList|ConcurrentQueue|ConcurrentDictionary|ConcurrentBag)\s*</u,
  array: /new\s*\[/u,
  serializer: /JsonSerializer\s*\.|JsonDocument\s*\.\s*Parse|JsonSerializerOptions/u,
  format: /(?:\.ToString\s*\(\s*"|string\s*\.\s*Format\s*\(|string\s*\.\s*Create\s*\(|string\s*\.\s*Join\s*\()/u,
});

const DECLARATION_KINDS = new Set([
  "method_declaration",
  "constructor_declaration",
  "operator_declaration",
  "local_function_statement",
]);
const LOOP_KINDS = new Set(["for_statement", "foreach_statement", "while_statement", "do_statement"]);

let parserPromise;

async function csharpParser() {
  parserPromise ??= (async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(await Language.load(require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm")));
    return parser;
  })();
  return parserPromise;
}

/** Every tracked C# file of the Mod, absolute. */
export function sourceFiles(root = SOURCE_ROOT, { exclude = new Set() } = {}) {
  const found = [];
  const walk = (directory) => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
        walk(full);
      } else if (entry.name.endsWith(".cs") && !exclude.has(full.split("\\").join("/"))) found.push(full);
    }
  };
  walk(root);
  return found.sort();
}

/**
 * A `+` whose operand is text, inside a loop of the same handler.
 *
 * `a + b` on two ints is not an allocation and a lexical `+` cannot tell them apart; a string literal, an interpolated
 * string or an explicit `.ToString()` on either side can, and that is the reading taken.
 */
function concatenatesTextInLoop(left, right, operator) {
  if (operator !== "+") return false;
  const isText = (text) => /^(?:\$?"|@")/u.test(text) || /\.ToString\s*\(/u.test(text);
  return isText(left) || isText(right);
}

export async function readTickHandlers({ root = SOURCE_ROOT, exclude = new Set() } = {}) {
  const parser = await csharpParser();
  const files = sourceFiles(root, { exclude });
  const declarations = [];
  const registrations = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const relativePath = relative(resolve(root, "..", ".."), file)
      .split("\\")
      .join("/");
    collectTickFile(parser.parse(source).rootNode, source, relativePath, declarations, registrations);
  }
  return { files: files.length, registrations, ...resolveHandlers(declarations, registrations) };
}

const sliceOf = (source, node) => (node === null ? "" : source.slice(node.startIndex, node.endIndex));

/** A declaration's record while the file is being walked, carrying what the body scan collects. */
function openedDeclaration(node, source, relativePath, parent) {
  if (!DECLARATION_KINDS.has(node.type)) return null;
  const nameNode = node.childForFieldName("name");
  const bodyNode = node.childForFieldName("body");
  return {
    name: nameNode === null ? "(anonymous)" : sliceOf(source, nameNode),
    file: relativePath,
    line: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    parent,
    body: bodyNode === null ? "" : stripComments(sliceOf(source, bodyNode)),
    textConcatenationInLoop: false,
  };
}

/**
 * The subscription a node makes, or `null` for a node that makes none.
 *
 * `+=` adds a member and `-=` removes one, so only `+=` is read: the operator between the event and the handler is the
 * authority for "the Mod registers this handler".
 */
function recordedRegistration(node, source, owner, relativePath) {
  if (node.type !== "assignment_expression") return null;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left === null || right === null) return null;
  if (!/GameLoop\s*\.\s*UpdateTick(?:ed|ing)$/u.test(sliceOf(source, left).trim())) return null;
  if (!source.slice(left.endIndex, node.endIndex).trimStart().startsWith("+=")) return null;
  return {
    file: relativePath,
    line: node.startPosition.row + 1,
    handler: sliceOf(source, right)
      .trim()
      .replace(/^this\s*\.\s*/u, ""),
    owner,
  };
}

/** Whether a `+` inside a loop joins text, which the text-concatenation pattern reads. */
function joinsTextInLoop(node, source) {
  if (node.type !== "binary_expression") return false;
  const left = node.childForFieldName("left");
  const right = node.childForFieldName("right");
  if (left === null || right === null) return false;
  const operator = source.slice(left.endIndex, right.startIndex).trim();
  return concatenatesTextInLoop(sliceOf(source, left), sliceOf(source, right), operator);
}

/** One file's declarations and subscriptions. Loop depth is tracked so a `+` is read in its context. */
function collectTickFile(rootNode, source, relativePath, declarations, registrations) {
  const stack = [];
  const walk = (node, loopDepth) => {
    const record = openedDeclaration(node, source, relativePath, stack.at(-1) ?? null);
    if (record !== null) {
      declarations.push(record);
      stack.push(record);
    }
    const registration = stack.length === 0 ? null : recordedRegistration(node, source, stack.at(-1), relativePath);
    if (registration !== null) registrations.push(registration);
    if (loopDepth > 0 && stack.length > 0 && joinsTextInLoop(node, source)) stack.at(-1).textConcatenationInLoop = true;
    const deeper = LOOP_KINDS.has(node.type) ? loopDepth + 1 : loopDepth;
    for (const child of node.namedChildren) walk(child, deeper);
    if (record !== null) stack.pop();
  };
  walk(rootNode, 0);
}

/**
 * Resolve each subscription to the declaration it names: a local function inside the subscribing method where the Mod
 * uses one, otherwise the same-file method of that name.
 */
function resolveHandlers(declarations, registrations) {
  const handlers = [];
  const unresolved = [];
  for (const registration of registrations) {
    const candidates = declarations.filter(
      (declaration) => declaration.file === registration.file && declaration.name === registration.handler,
    );
    const local = candidates.filter(
      (declaration) => declaration.parent === registration.owner && declaration.parent !== null,
    );
    const named = candidates.filter((declaration) => declaration.parent === null);
    const picked = pickHandler(local, named, candidates);
    if (picked === null) unresolved.push(registration);
    else handlers.push({ registration, handler: picked });
  }
  return { handlers, unresolved };
}

/** The one declaration a subscription names: a local function in the subscribing method, else the same-file method. */
function pickHandler(local, named, candidates) {
  if (local.length === 1) return local[0];
  if (named.length === 1) return named[0];
  if (candidates.length === 1) return candidates[0];
  return null;
}

/** What one handler's body allocates, as `[{ pattern, line }]`. */
export function allocationsOf(handler) {
  const hits = [];
  const lines = handler.body.split("\n");
  for (const [pattern, expression] of Object.entries(ALLOCATION_PATTERNS)) {
    for (let index = 0; index < lines.length; index += 1) {
      if (expression.test(lines[index])) hits.push({ pattern, line: handler.line + index });
    }
  }
  if (handler.textConcatenationInLoop) hits.push({ pattern: "string_concatenation_in_loop", line: handler.line });
  return hits;
}

/** The baseline, or an empty one when the tree under test has none. */
export function readBaseline(path = BASELINE_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const parsed = JSON.parse(raw);
  return Array.isArray(parsed.allocations) ? parsed.allocations : [];
}

const keyOf = (entry) => `${entry.file}:${entry.handler}:${entry.pattern}`;

/** The reading: the population, every allocation, and the two ratchet verdicts. */
export async function readTickAllocations({ root = SOURCE_ROOT, baselinePath = BASELINE_PATH } = {}) {
  const untracked =
    root === SOURCE_ROOT ? untrackedSources({ roots: ["integrations/stardew"], root: ROOT }) : new Set();
  const exclude = new Set([...untracked].map((path) => join(ROOT, path).split("\\").join("/")));
  const measured = await readTickHandlers({ root, exclude });
  const recorded = new Map(readBaseline(baselinePath).map((entry) => [keyOf(entry), entry]));
  const findings = [];

  const seen = new Set();
  const allocating = [];
  for (const { registration, handler } of measured.handlers) {
    const hits = allocationsOf(handler);
    if (hits.length === 0) continue;
    allocating.push({ registration, handler, allocations: hits });
    for (const pattern of new Set(hits.map((hit) => hit.pattern))) {
      const key = keyOf({ file: registration.file, handler: registration.handler, pattern });
      seen.add(key);
      if (!recorded.has(key))
        findings.push({
          code: "tick_handler_allocates",
          detail: `${registration.file}:${registration.handler}:${pattern}`,
        });
    }
  }
  for (const key of recorded.keys()) {
    if (seen.has(key)) continue;
    const entry = recorded.get(key);
    findings.push({
      code: "tick_allocation_baseline_stale",
      detail: `${entry.file}:${entry.handler}:${entry.pattern}`,
    });
  }
  for (const registration of measured.unresolved)
    findings.push({
      code: "tick_handler_unresolved",
      detail: `${registration.file}:${registration.line}:${registration.handler}`,
    });

  return {
    files: measured.files,
    registrations: measured.registrations.length,
    handlers: measured.handlers.map((entry) => ({
      registration: entry.registration,
      handler: entry.handler,
      allocations: allocationsOf(entry.handler),
    })),
    allocating,
    recorded: recorded.size,
    clean: measured.handlers.length - allocating.length,
    untracked: [...untracked],
    findings,
  };
}

/** The self-verification report, built from the reading. */
export function report(reading) {
  const count = (code) => reading.findings.filter((finding) => finding.code === code).length;
  const outcome = (code) => (count(code) === 0 ? "passed" : "failed");
  return {
    gate: "check-stardew-tick-handler-allocation",
    status: reading.findings.length === 0 ? "passed" : "failed",
    examined: reading.handlers.length,
    files: reading.files,
    registrations: reading.registrations,
    clean: reading.clean,
    allocating: reading.allocating.length,
    recorded: reading.recorded,
    untrackedNotCounted: reading.untracked.length,
    checks: [
      {
        id: "tick_handler_allocates",
        status: outcome("tick_handler_allocates"),
        detail: `${count("tick_handler_allocates")} allocation(s) the baseline does not record`,
      },
      {
        id: "tick_allocation_baseline_stale",
        status: outcome("tick_allocation_baseline_stale"),
        detail: `${count("tick_allocation_baseline_stale")} recorded allocation(s) that no longer exist`,
      },
      {
        id: "tick_handler_unresolved",
        status: outcome("tick_handler_unresolved"),
        detail: `${count("tick_handler_unresolved")} subscription(s) whose handler declaration could not be found`,
      },
    ],
    findings: reading.findings,
  };
}

/** The baseline document this reading would record, so `--update` and the gate cannot disagree. */
export function baselineFrom(reading) {
  const allocations = [];
  for (const entry of reading.allocating)
    for (const pattern of [...new Set(entry.allocations.map((hit) => hit.pattern))].sort())
      allocations.push({ file: entry.registration.file, handler: entry.registration.handler, pattern });
  return { allocations };
}

async function main(argv) {
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at === -1 ? fallback : argv[at + 1];
  };
  const root = resolve(option("--root", SOURCE_ROOT));
  const baselinePath = resolve(option("--baseline", BASELINE_PATH));
  const reading = await readTickAllocations({ root, baselinePath });

  if (reading.handlers.length === 0) throw new Error(`stardew_tick_handlers_no_population:${root}`);

  if (argv.includes("--update")) {
    writeFileSync(baselinePath, `${JSON.stringify(baselineFrom(reading), null, 2)}\n`);
    console.log(
      `stardew_tick_allocations_baseline_recorded allocations=${reading.allocating.length} into ${baselinePath}`,
    );
    return 0;
  }

  const summary = report(reading);
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    return summary.status === "passed" ? 0 : 1;
  }
  console.log(
    `handlers examined ${summary.examined} · clean ${summary.clean} · allocating ${summary.allocating} · recorded ${summary.recorded}`,
  );
  console.log(`files examined ${summary.files} · registrations ${summary.registrations}`);
  console.log(
    `untracked_not_counted ${summary.untrackedNotCounted}${summary.untrackedNotCounted === 0 ? "" : `: ${describeUntracked(new Set(reading.untracked))}`}`,
  );
  if (argv.includes("--list"))
    for (const entry of reading.handlers)
      console.log(
        `${entry.registration.file}:${entry.registration.line}:${entry.registration.handler}` +
          `${entry.allocations.length === 0 ? " clean" : ` ${entry.allocations.map((hit) => `${hit.pattern}@${hit.line}`).join(", ")}`}`,
      );
  for (const finding of summary.findings) console.log(`${MARKER} ${finding.code}:${finding.detail}`);
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary.status === "passed" ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(`${MARKER} ${error.message}`);
      process.exitCode = 2;
    },
  );
}
