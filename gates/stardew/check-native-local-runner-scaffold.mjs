#!/usr/bin/env node
/**
 * IS THIS SMOKE RUNNER STILL HAND-WRITTEN?
 *
 * WHY. `tools/lib/native-local-runner-scaffold.mjs` holds the lifecycle every `run-stardew-native-local-*.mjs` smoke
 * runner used to spell for itself - the fixture-config refusal, observe-fresh and the capability check, the requestId mint
 * and the execute, the terminal wait, the evidence parse, the stale reread, and the bootstrap with its exit code. Measured
 * 2026-11-14: the 127th runner (`fcc2c1b7`'s `run-stardew-native-local-player-sweep-scythe-smoke.mjs`) was a copy of a
 * sibling with the action's own words swapped, and `tools/check-code-duplication.mjs` recorded it as the fifth clone group
 * GROWING by one site. Five groups, one commit. The tree was not short of a helper library - it was short of a default,
 * and a default is a gate or it is a suggestion.
 *
 * THE QUESTION THIS ASKS is not "does this file define `parseEvidence`". That is a substring check wearing a rule's
 * clothes: an inline arrow, a renamed local, or the same three statements pasted into a `try` all slip past it, and the
 * copy the detector was written for is not the copy that arrives next. The question is whether the runner still OWNS THE
 * PROCESS - reads its own client config, connects its own client, mints its own request, prints its own result. So:
 *
 *   conforming  = imports the template AND supplies a `defineSmokeScenario(...)` definition AND does not read its own
 *                 config or connect its own client.
 *   hand-written = anything else, which owes a baseline entry.
 *
 * The three conditions are one property read from three sides, and each side is a thing the template would otherwise have
 * to trust: an import nobody calls proves nothing, and a call beside a hand-rolled `readNativeClientConfig()` is a runner
 * that still owns its own lifecycle and only borrows the helpers.
 *
 * THE POPULATION is every `run-stardew-native-local-*.mjs` under `tools/`, recursively, in the index - derived by a
 * directory scan, never by a list here, so the runner written tomorrow is judged the moment it exists. `tools/lib/**` is
 * not in it (a template is not a runner), and a file whose name carries `.test.` or `.mutation.` is a falsifier rather
 * than a runner. `tools/lib/indexed-sources.mjs`'s rule applies: a runner the index does not carry is another lane's work
 * in flight, so it is dropped from the population and PUBLISHED by name, never silently judged.
 *
 * THE BASELINE only shrinks. `tools/baselines/native-local-runner-scaffold.json` records the runners that predate the
 * template, each with the reason `predates_the_template`; this tree records 130. Three rules, and the direction of each:
 *
 *   * a hand-written runner NOT in the baseline is a finding - a new runner cannot enter the baseline, there is
 *     deliberately no flag that adds an entry;
 *   * a baseline entry whose runner now conforms, or whose runner is gone, is a finding - a migrated runner must leave,
 *     and `--record-shrinks` deletes exactly those entries and nothing else;
 *   * an entry whose reason is not `predates_the_template` is a finding - a baseline without its reason is a silencer.
 *
 * ZERO POPULATION IS BLOCKED, NEVER GREEN. An empty scan, an unreadable template module, or a git index git refuses to
 * answer all print `not_measured:<why>` and exit 2. "Every runner is on the template" is a claim about a population, and a
 * population of nothing agrees with it.
 *
 * WHAT THIS DOES NOT SEE, said out loud: whether a migrated runner USES the template correctly - a definition that omits
 * `assertPostcondition` throws at import (`native_local_scenario_definition_invalid:<field>`) and the runner's own suite
 * and live gate own that; and whether a baselined runner still works at all. This gate reads one fact per file, which is
 * the fact that was wrong 127 times.
 *
 * VERDICT. `runners examined N · on the template M · hand-written K · baselined B`, then one line per finding.
 * Exit 0 every runner conforms or is baselined, 1 a finding, 2 blocked.
 *
 * THE SECOND VERDICT LINE, for L1: `runners examined N · private copies M · importing K`. M counts (runner, primitive)
 * pairs whose body duplicates an export of `native-local-runner-primitives.mjs`, and K counts the runners that import that
 * module at all. Both are printed because "no findings" and "no population" must not read the same.
 *
 * red-proof: inject  a runner that reads its own `readNativeClientConfig()` beside the template import ->
 *   `runner_reimplements_the_scaffold:<injected runner>:hand_written_bootstrap:readNativeClientConfig`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: inject  a new hand-written runner not in the baseline -> `runner_reimplements_the_scaffold:<file>:...`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: history  the sweep-scythe runner at `fcc2c1b7`, before its migration, replayed into the population ->
 *   `runner_reimplements_the_scaffold:tools/run-stardew-native-local-player-sweep-scythe-smoke.mjs:...`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: inject  a baseline entry for a runner that now conforms, and one whose runner is gone ->
 *   `stale_baseline:<file>` twice, and `--record-shrinks` deletes both
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 * red-proof: inject  an empty population and an unreadable template -> `not_measured:*` at exit 2
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 *
 * THE SECOND LAYER's red proofs, in the same file:
 *
 * red-proof: inject  a runner that spells `parseEvidence` privately ->
 *   `runner_reimplements_a_scaffold_primitive:<injected runner>:parseEvidence`
 * red-proof: inject  the fixture-config refusal under the name `validateConfig` ->
 *   `runner_reimplements_a_scaffold_primitive:<injected runner>:validateNativeLocalFixtureConfig`
 *   (the copy a name check would miss)
 * red-proof: inject  a baseline entry for a copy that has been migrated -> `stale_primitive_copy:<file>:<primitive>`,
 *   and `--record-shrinks` deletes exactly it while keeping every lifecycle entry
 * red-proof: inject  an export with no detector, and a detector with no export ->
 *   `not_measured:primitive_without_a_detector:<name>`, `not_measured:detector_without_a_primitive:<name>`
 *   (tools/check-native-local-runner-scaffold.test.mjs)
 *
 * USAGE
 *   node tools/check-native-local-runner-scaffold.mjs
 *   node tools/check-native-local-runner-scaffold.mjs --json
 *   node tools/check-native-local-runner-scaffold.mjs --record-shrinks
 */

export const gateDeclaration = {
  id: "check-native-local-runner-scaffold",
  domain: "stardew",
  tier: "l0",
  kind: "ratchet",
};

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describeUntracked, untrackedSources } from "../../tools/lib/indexed-sources.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

const ROOT = repositoryRoot(import.meta.url);

/** The template's one path. A runner imports the lifecycle from it, or it owns the lifecycle. */
export const TEMPLATE_FILE = "tools/lib/native-local-runner-scaffold.mjs";

/** L1's one path. Every primitives a runner must not spell for itself is an export of this module. */
export const PRIMITIVES_FILE = "tools/lib/native-local-runner-primitives.mjs";

/** The one reason a primitive-copy baseline entry may carry. */
export const PRIMITIVE_BASELINE_REASON = "predates_the_primitives";

/** The template's exports a runner cannot do without: the definition and the bootstrap. */
export const TEMPLATE_EXPORTS = Object.freeze(["defineSmokeScenario", "runSmokeScenarioMain"]);

/** The runners this asks about: the native-local smoke family, minus its own falsifiers. */
export const RUNNER_FILE = /^run-stardew-native-local-.*\.mjs$/u;
const SIBLING_FALSIFIER = /\.(?:test\.mjs|mutation\.mjs)$/u;

/** The one reason a baseline entry may carry. Anything else is a silencer with a nicer name. */
export const BASELINE_REASON = "predates_the_template";

export const BASELINE_PATH = "tools/baselines/native-local-runner-scaffold.json";

/** The scan's root, relative to the repository, and the prefix every runner path is published under. */
const SCAN_ROOT = "tools";

const TEMPLATE_IMPORT = /from\s+["'](?:\.\/)?lib\/native-local-runner-scaffold\.mjs["']/u;
const SUPPLIES_DEFINITION = /\bdefineSmokeScenario\s*\(/u;
/** Two calls that mean the runner still owns its own process, whatever helpers it borrows beside them. */
const HANDS_WRITTEN_BOOTSTRAP = Object.freeze([
  ["readNativeClientConfig", /\breadNativeClientConfig\s*\(/u],
  ["connectNativeLocalClient", /\bconnectNativeLocalClient\s*\(/u],
  ["connectWithRetry", /\bconnectWithRetry\s*\(/u],
]);

/** Line and block comments stripped, so a comment that describes the old shape is not a finding. */
export function stripComments(source) {
  return String(source ?? "")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .map((line) => {
      const index = line.indexOf("//");
      return index < 0 ? line : line.slice(0, index);
    })
    .join("\n");
}

/**
 * THE SECOND LAYER: does this runner spell one of L1's primitives for itself?
 *
 * WHY A SECOND LAYER. `runner_reimplements_the_scaffold` above asks about the LIFECYCLE, and 87 of 110 runners answered
 * "no" to it. Most of those noes were about how many frames a runner sends, which has nothing to do with the fact that
 * `parseEvidence` was spelled privately in 49 of them, `parseStrictEvidence` in 32, the fixture-config refusal in 29 (under
 * three names) and the tile predicates in 37+14. Measuring the duplication against the lifecycle question under-reported
 * it: the shared plumbing is re-implemented in every runner, whatever its shape.
 *
 * THE PRIMITIVE LIST IS THE MODULE'S OWN EXPORTS, not a list kept here. `readPrimitiveExports` reads
 * `native-local-runner-primitives.mjs`, and a detector for a name it does not carry - or an export with no detector - is
 * `not_measured`, not a silent pass: an export added tomorrow would otherwise be invisible to this gate forever.
 *
 * DETECTION IS STRUCTURAL, NOT TEXTUAL, and that is the whole design. A name check misses the copies that were renamed:
 * `validateNativeLocalConfig` (5) and `validateConfig` (11) are the fixture refusal under other names, `parseDetailEntries`
 * is the strict evidence parse, `samePoint` is `sameTile`. So a copy is recognised by what its body DOES - the grammar it
 * reads, the calls it is allowed to make - under any name, and a body that does anything else (a target picker, a run
 * function, a topology classifier) is not a copy and is not a finding.
 */
export function readPrimitiveExports(source) {
  const names = [];
  for (const match of String(source ?? "").matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu))
    names.push(match[1]);
  return names;
}

/** The calls a pure tile predicate is allowed to make. A picker calls `filter`/`find`/`map`/`sort` and is not one. */
const TILE_CALLS = new Set(["abs", "max", "isInteger", "isSafeInteger", "isFinite", "Number", "Boolean"]);
/** The calls a fixture-config refusal is allowed to make - the harness's policy and topology readings included. */
const FIXTURE_CALLS = new Set([
  "Error",
  "RegExp",
  "test",
  "stringify",
  "some",
  "every",
  "keys",
  "isArray",
  "hasOwn",
  "String",
  "Boolean",
  "Number",
  "validateNativeLocalFixturePolicy",
  "validFixtureSlotRelationship",
  "validFixtureBinding",
  "classifyTopology",
]);

/**
 * A tile predicate: two tile-shaped parameters and nothing but coordinate arithmetic in the body.
 *
 * The `calls` restriction separates the duplicated predicates from the fifty target PICKERS that also read `.x`/`.y`
 * (`chooseAdjacentWeedTarget` and its siblings call `filter`/`find`/`sort`), and the parameter count separates them from
 * one-argument validators (`validItemTarget`) that merely look at a coordinate.
 */
function tilePredicate({ body, calls, params }) {
  return (
    params === 2 &&
    /\.x\b/u.test(body) &&
    /\.y\b/u.test(body) &&
    calls.every((name) => TILE_CALLS.has(name)) &&
    /Math\.(?:abs|max)\(|===/u.test(body) &&
    !/\b(?:for|while|switch)\b/u.test(body)
  );
}

/** How many `Math.abs(`/`Math.max(` a body makes, for telling the five predicates apart. */
const countOf = (body, call) => (body.match(new RegExp(`Math\\.${call}\\(`, "gu")) ?? []).length;

/**
 * The five tile primitives share ONE shape (two tiles, coordinate arithmetic) and differ in the comparison, so each
 * detector reads the comparison. Reporting them all as one name would be the same defect as reporting none: a migration
 * that replaced a Chebyshev distance with an adjacency test would compile.
 */
const TILE_KINDS = Object.freeze({
  // `Math.max(abs, abs)` with no comparison is the distance itself; with `=== 1` it is "exactly one step" (the 2 copies).
  tileChebyshevDistance: ({ body, params, calls }) =>
    tilePredicate({ body, params, calls }) &&
    countOf(body, "max") > 0 &&
    !/Math\.max\([^\n]*\)\s*(?:===|<=|>=)/u.test(body),
  tilesNeighbouring: ({ body, params, calls }) =>
    tilePredicate({ body, params, calls }) && countOf(body, "max") > 0 && /Math\.max\([^\n]*\)\s*===\s*1/u.test(body),
  // `abs(x)+abs(y) === 1` is the Manhattan (cardinal) predicate: the 5 `cardinalAdjacent` copies.
  tilesCardinallyAdjacent: ({ body, params, calls }) =>
    tilePredicate({ body, params, calls }) &&
    countOf(body, "max") === 0 &&
    /Math\.abs\([^\n]*\)\s*\+\s*Math\.abs\(/u.test(body),
  // Two `abs(...) <= 1` comparisons: adjacency including the tile itself.
  tilesAdjacent: ({ body, params, calls }) =>
    tilePredicate({ body, params, calls }) && countOf(body, "max") === 0 && /Math\.abs\([^\n]*\)\s*<=\s*1/u.test(body),
  // Coordinate equality with no distance at all.
  sameTile: ({ body, params, calls }) =>
    tilePredicate({ body, params, calls }) &&
    countOf(body, "max") === 0 &&
    countOf(body, "abs") === 0 &&
    /\.x\s*===\s*[\w$.?]+\.x/u.test(body),
});

/** The names a local function's body is allowed to call for each family, and the shape each family has. */
export const PRIMITIVE_DETECTORS = Object.freeze({
  // The three evidence grammars all split `a=1;b=2`; what separates them is what they do with a pair they cannot read.
  parseEvidence: ({ grammar, body }) => grammar && !/return \{\}/u.test(body) && !/hasOwn\(|!== undefined/u.test(body),
  parseStrictEvidence: ({ grammar, body }) =>
    grammar && !/return \{\}/u.test(body) && /hasOwn\(|!== undefined/u.test(body),
  parseCompleteEvidence: ({ grammar, body }) => grammar && /return \{\}/u.test(body),
  validateNativeLocalFixtureConfig: ({ body, calls }) =>
    /NativeLocalPlayerFixture/u.test(body) &&
    /Portfolio/u.test(body) &&
    /HostAutomation/u.test(body) &&
    calls.every((name) => FIXTURE_CALLS.has(name)),
  validFixtureSlotRelationship: ({ body }) => /GameBuddyFixture/u.test(body) && /\.test\(/u.test(body),
  sameTile: TILE_KINDS.sameTile,
  tilesAdjacent: TILE_KINDS.tilesAdjacent,
  tilesNeighbouring: TILE_KINDS.tilesNeighbouring,
  tilesCardinallyAdjacent: TILE_KINDS.tilesCardinallyAdjacent,
  tileChebyshevDistance: TILE_KINDS.tileChebyshevDistance,
  connectWithRetry: ({ body }) => /connectNativeLocalClient/u.test(body) && /ENOENT/u.test(body),
  waitForNavigationTerminal: ({ body, calls }) =>
    /waitForTerminal\(/u.test(body) &&
    /waitForFreshSnapshot\(/u.test(body) &&
    calls.every((name) => ["waitForTerminal", "waitForFreshSnapshot", "Error"].includes(name)),
});

/**
 * What one runner file does about the template: imports it, defines against it, and whether it still starts its own
 * process. Every reason is a finding on its own, because they are different mistakes with different fixes.
 */
export function readRunner(source) {
  const code = stripComments(source);
  const owns = HANDS_WRITTEN_BOOTSTRAP.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
  const importsTemplate = TEMPLATE_IMPORT.test(code);
  const suppliesDefinition = SUPPLIES_DEFINITION.test(code);
  const reasons = [];
  if (!importsTemplate) reasons.push("no_template_import");
  else if (!suppliesDefinition) reasons.push("imports_the_template_without_a_definition");
  for (const name of owns) reasons.push(`hand_written_bootstrap:${name}`);
  return { importsTemplate, suppliesDefinition, ownsBootstrap: owns, conforming: reasons.length === 0, reasons };
}

/** Every runner file under `tools/`, recursively, as repo-relative paths with forward slashes. */
export function runnerFiles({ root = ROOT, directory = SCAN_ROOT } = {}) {
  const found = [];
  const walk = (absolute, relative) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(absolute, entry.name), child);
        continue;
      }
      if (!RUNNER_FILE.test(entry.name) || SIBLING_FALSIFIER.test(entry.name)) continue;
      found.push(child);
    }
  };
  walk(resolve(root, directory), directory);
  return found.sort();
}

/**
 * `source` with every comment replaced by SPACES, so an offset into the result is an offset into the source.
 *
 * `stripComments` above is for readers that only ask a question (`does this text call X?`); a reader that hands back a
 * POSITION has to keep the source's geometry, or the position it hands back lands somewhere else. That difference ate a
 * `sameTile` predicate out of `run-stardew-native-local-player-water-pet-bowl-smoke.mjs` and returned three lines of a
 * neighbouring function instead - which is why the offsets below are computed on this mask and the migration is verified
 * by slicing its own source.
 */
export function maskComments(source) {
  const text = String(source ?? "");
  const out = text.split("");
  let index = 0;
  const skip = (at) => {
    const quote = text[at];
    let cursor = at + 1;
    while (cursor < text.length) {
      if (text[cursor] === "\\") cursor += 2;
      else if (text[cursor] === quote) return cursor + 1;
      else cursor++;
    }
    return text.length;
  };
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = skip(index);
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

/**
 * Every local function definition in a runner, with the body a detector reads and the offsets a migration needs.
 *
 * Function declarations only: a copy spelled as an arrow (`const parseEvidence = (e) => ...`) is not read here, and that
 * is stated rather than guessed. Measured on the tree at `3f660c7e`: every one of the copies that exist is a declaration,
 * so the blind spot is real but empty today, and the diff of a future arrow copy is a line this gate would miss - which is
 * why the population line prints `private copies M` rather than a bare pass.
 *
 * `start`/`end` index the ORIGINAL source: the scan runs over `maskComments(source)`, whose length and newlines are the
 * source's own, so a caller can slice the source with them.
 */
export function localFunctions(source) {
  const text = maskComments(source);
  const found = [];
  const declaration = /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gu;
  let match;
  while ((match = declaration.exec(text)) !== null) {
    let index = match.index + match[0].length;
    let depth = 1;
    while (index < text.length && depth > 0) {
      const char = text[index];
      if (char === "{") depth++;
      else if (char === "}") depth--;
      index++;
    }
    const body = text.slice(match.index, index);
    found.push({
      name: match[1],
      params: match[2].split(",").filter((entry) => entry.trim().length > 0).length,
      body,
      start: match.index,
      end: index,
      exported: /^export\s/u.test(match[0]) || new RegExp(`export\\s+\\{[^}]*\\b${match[1]}\\b`, "u").test(text),
      calls: callsIn(body, match[1]),
    });
  }
  return found;
}

/** The names `text` calls, minus `self` (a declaration names itself) and minus keywords that look like calls. */
function callsIn(text, self) {
  const keywords = new Set(["if", "for", "while", "switch", "catch", "function", "return", "typeof", "await"]);
  return [
    ...new Set(
      [...text.matchAll(/([A-Za-z_$][\w$]*)\s*\(/gu)]
        .map((match) => match[1])
        .filter((name) => name !== self && !keywords.has(name)),
    ),
  ];
}

/**
 * The primitives ONE runner spells for itself.
 *
 * `exports` is the L1 module's own export list. A local function whose name is one of them reports under that name even
 * when its body is the other grammar (`parseStrictEvidence` copying the lenient parse), because the finding is about what
 * the runner has to delete, and a migrated call site is renamed either way.
 */
export function detectPrimitiveCopies(source, exports) {
  const copies = [];
  for (const entry of localFunctions(source)) {
    const named = exports.includes(entry.name) ? entry.name : null;
    // A local function with a primitive's NAME is a copy whatever its body says: the runner owns that spelling.
    if (named !== null) {
      copies.push(named);
      continue;
    }
    const grammar = evidenceGrammar(entry.body);
    const matched = exports.filter((primitive) => PRIMITIVE_DETECTORS[primitive]({ ...entry, grammar }));
    // A tile body matches all five tile detectors (they share one shape); report the family once, under its own name.
    const distinct = matched.filter((primitive) => !TILE_DETECTORS.has(primitive));
    if (distinct.length > 0) copies.push(distinct[0]);
    else if (matched.length > 0) copies.push(matched[0]);
  }
  return [...new Set(copies)];
}

const TILE_DETECTORS = new Set([
  "sameTile",
  "tilesAdjacent",
  "tilesNeighbouring",
  "tilesCardinallyAdjacent",
  "tileChebyshevDistance",
]);

/** The one grammar all three evidence primitives read: `a=1;b=2`. */
function evidenceGrammar(body) {
  return /\.split\(";"\)/u.test(body) && /indexOf\("="\)/u.test(body);
}

/** The template's own exports, read from its source so a missing one is blocked rather than assumed. */
export function readTemplateExports(source) {
  const missing = TEMPLATE_EXPORTS.filter(
    (name) => !new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, "u").test(source),
  );
  return { missing, ok: missing.length === 0 };
}

/** A reading that could not be made. Blocked, exit 2, with the reason - never an empty population that agrees with itself. */
export function blocked(reason) {
  return Object.freeze({
    schema: "gamebuddy-native-local-runner-scaffold/v1",
    blocked: reason,
    examined: 0,
    conforming: 0,
    handWritten: 0,
    baselined: 0,
    privateCopies: 0,
    importing: 0,
    untracked: Object.freeze([]),
    rows: Object.freeze([]),
    primitiveCopies: Object.freeze([]),
    primitiveRows: Object.freeze([]),
    findings: Object.freeze([]),
    stale: Object.freeze([]),
    ok: false,
  });
}

/**
 * The verdict: every runner in the population, and what its baseline entry does or does not excuse.
 *
 * `runners` is `[{ file, source }]` and `baseline` is `[{ file, reason }]`. Both are handed in so a falsifier drives the
 * real rule over a synthetic tree instead of editing this repository. `primitiveCopies` is the second baseline section,
 * `[{ file, primitive, reason }]`, and `primitivesSource` is L1's own source: the primitive list is read from it, never
 * passed as a list of names this gate happened to remember.
 */
export function checkRunnerScaffold({
  runners,
  baseline,
  templateSource,
  primitiveCopies = [],
  primitivesSource = null,
}) {
  const template = readTemplateExports(templateSource);
  if (!template.ok) return blocked(`template_export_missing:${template.missing.join(",")}`);
  if (runners.length === 0) return blocked("runner_population_empty");

  const recorded = new Map();
  const findings = [];
  for (const entry of baseline) {
    if (recorded.has(entry.file)) {
      findings.push(`baseline_entry_duplicated:${entry.file}: two entries name one runner, delete one`);
      continue;
    }
    recorded.set(entry.file, entry);
    if (entry.reason !== BASELINE_REASON)
      findings.push(
        `baseline_entry_without_a_reason:${entry.file}: reason "${entry.reason ?? ""}" is not ${BASELINE_REASON}`,
      );
  }

  const rows = [];
  const stale = [];
  const live = new Set();
  for (const runner of runners) {
    live.add(runner.file);
    const reading = readRunner(runner.source);
    const entry = recorded.get(runner.file);
    rows.push({ file: runner.file, ...reading, baselined: entry !== undefined });
    if (!reading.conforming) {
      if (entry === undefined)
        findings.push(`runner_reimplements_the_scaffold:${runner.file}:${reading.reasons.join("+")}`);
      continue;
    }
    if (entry !== undefined)
      stale.push(
        `stale_baseline:${runner.file}: the baseline records it as ${entry.reason}, and it imports the template and ` +
          "defines a scenario now - delete the entry",
      );
  }
  for (const file of [...recorded.keys()].sort()) {
    if (live.has(file)) continue;
    stale.push(`stale_baseline:${file}: no runner of that name is in the tree - delete the entry`);
  }

  const census =
    primitivesSource === null
      ? { blocked: "primitives_source_absent", findings: [], stale: [], copies: [], rows: [] }
      : countPrimitiveCopies({ runners, primitiveCopies, primitivesSource });
  if (census.blocked !== null) return blocked(census.blocked);

  return Object.freeze({
    schema: "gamebuddy-native-local-runner-scaffold/v1",
    blocked: null,
    examined: rows.length,
    conforming: rows.filter((row) => row.conforming).length,
    handWritten: rows.filter((row) => !row.conforming).length,
    baselined: rows.filter((row) => row.baselined).length,
    untracked: Object.freeze([]),
    rows: Object.freeze(rows.map((row) => Object.freeze(row))),
    primitiveCopies: Object.freeze(census.copies),
    primitiveRows: Object.freeze(census.rows),
    privateCopies: census.copies.length,
    importing: census.importing,
    findings: Object.freeze([...findings, ...stale, ...census.findings, ...census.stale]),
    stale: Object.freeze([...stale, ...census.stale]),
    ok: findings.length === 0 && stale.length === 0 && census.findings.length === 0 && census.stale.length === 0,
  });
}

/**
 * The primitive census: which runners still spell an L1 export for themselves, and which of those are excused.
 *
 * Same two rules as the lifecycle baseline, in the same direction: a copy with no entry is a finding, and an entry whose
 * copy is gone is stale and must be deleted by `--record-shrinks`. The baseline has no writer that adds one, so a new copy
 * cannot be laundered through it.
 */
function countPrimitiveCopies({ runners, primitiveCopies, primitivesSource }) {
  const exports = readPrimitiveExports(primitivesSource);
  const missingDetector = exports.filter((name) => PRIMITIVE_DETECTORS[name] === undefined);
  const extraDetector = Object.keys(PRIMITIVE_DETECTORS).filter((name) => !exports.includes(name));
  // An export with no detector would be duplicated forever and never named; a detector with no export would fire on a
  // primitive that no longer exists. Both are readings that cannot be made, not passes.
  if (missingDetector.length > 0) return { blocked: `primitive_without_a_detector:${missingDetector.join(",")}` };
  if (extraDetector.length > 0) return { blocked: `detector_without_a_primitive:${extraDetector.join(",")}` };
  if (runners.length === 0) return { blocked: "runner_population_empty" };

  const recorded = new Map();
  const findings = [];
  for (const entry of primitiveCopies) {
    const key = `${entry.file}:${entry.primitive}`;
    if (recorded.has(key)) {
      findings.push(`primitive_copy_recorded_twice:${key}: two entries name one copy, delete one`);
      continue;
    }
    recorded.set(key, entry);
    if (entry.reason !== PRIMITIVE_BASELINE_REASON)
      findings.push(
        `primitive_copy_without_a_reason:${key}: reason "${entry.reason ?? ""}" is not ${PRIMITIVE_BASELINE_REASON}`,
      );
  }

  const IMPORTS_PRIMITIVES = /from\s+["'][^"']*native-local-runner-primitives\.mjs["']/u;
  const rows = [];
  const copies = [];
  const stale = [];
  let importing = 0;
  const live = new Set();
  for (const runner of runners) {
    const spelled = detectPrimitiveCopies(runner.source, exports);
    if (IMPORTS_PRIMITIVES.test(stripComments(runner.source))) importing++;
    rows.push({ file: runner.file, copies: spelled, imports: IMPORTS_PRIMITIVES.test(stripComments(runner.source)) });
    for (const primitive of spelled) {
      const key = `${runner.file}:${primitive}`;
      live.add(key);
      copies.push({ file: runner.file, primitive });
      if (!recorded.has(key)) findings.push(`runner_reimplements_a_scaffold_primitive:${key}`);
    }
  }
  for (const key of [...recorded.keys()].sort()) {
    if (live.has(key)) continue;
    stale.push(`stale_primitive_copy:${key}: the runner no longer spells it, or is gone - delete the entry`);
  }
  return { blocked: null, rows, copies, importing, findings, stale };
}

export function renderScaffoldReport(report) {
  if (report.blocked !== null) return [`not_measured:${report.blocked}`];
  const lines = [
    `runners examined ${report.examined} · on the template ${report.conforming} · ` +
      `hand-written ${report.handWritten} · baselined ${report.baselined}` +
      (report.untracked.length > 0 ? ` · untracked not counted ${describeUntracked(report.untracked)}` : ""),
    `runners examined ${report.examined} · private copies ${report.privateCopies} · importing ${report.importing}`,
  ];
  for (const finding of report.findings) lines.push(finding);
  lines.push(
    report.ok
      ? `  green: every runner either imports the template or is a recorded ${BASELINE_REASON} entry, and no runner ` +
          `spells an L1 primitive that is not a recorded ${PRIMITIVE_BASELINE_REASON} entry`
      : `  ${report.findings.length} finding(s)`,
  );
  return lines;
}

/** The baseline file, as the entries this gate compares against. */
export function readBaseline({ root = ROOT } = {}) {
  const parsed = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf8"));
  if (!Array.isArray(parsed.entries)) throw new Error("baseline has no `entries` array");
  return parsed.entries;
}

/** The baseline's second section: the private copies of L1 primitives that predate the module. */
export function readPrimitiveBaseline({ root = ROOT } = {}) {
  const parsed = JSON.parse(readFileSync(resolve(root, BASELINE_PATH), "utf8"));
  if (!Array.isArray(parsed.primitiveCopies)) throw new Error("baseline has no `primitiveCopies` array");
  return parsed.primitiveCopies;
}

/** The whole run over the real tree: the index decides the population, the scan decides what exists. */
export function runScaffoldGate({ root = ROOT, withIndex = true } = {}) {
  let templateSource;
  let primitivesSource;
  try {
    templateSource = readFileSync(resolve(root, TEMPLATE_FILE), "utf8");
    primitivesSource = readFileSync(resolve(root, PRIMITIVES_FILE), "utf8");
  } catch (error) {
    return { report: blocked(`template_unreadable:${error?.code ?? error}`), untracked: [] };
  }
  const onDisk = runnerFiles({ root });
  let untracked = [];
  if (withIndex) {
    try {
      const outside = untrackedSources({ roots: [SCAN_ROOT], root });
      untracked = onDisk.filter((file) => outside.has(file));
    } catch (error) {
      return { report: blocked(`runner_index_unreadable:${String(error?.message ?? error)}`), untracked: [] };
    }
  }
  const indexed = onDisk.filter((file) => !untracked.includes(file));
  const runners = indexed.map((file) => ({ file, source: readFileSync(resolve(root, file), "utf8") }));
  const baseline = readBaseline({ root });
  let primitiveCopies;
  try {
    primitiveCopies = readPrimitiveBaseline({ root });
  } catch (error) {
    return { report: blocked(`primitive_baseline_unreadable:${String(error?.message ?? error)}`), untracked: [] };
  }
  const report = checkRunnerScaffold({ runners, baseline, templateSource, primitiveCopies, primitivesSource });
  return { report: Object.freeze({ ...report, untracked: Object.freeze(untracked) }), untracked };
}

/**
 * Delete exactly the entries the report calls stale, in both sections, and nothing else.
 *
 * The primitive entries are keyed `file:primitive` while the lifecycle entries are keyed by file, so the two sections
 * cannot be shrunk by one regex: a lifecycle `stale_baseline:<file>` line and a `stale_primitive_copy:<file>:<primitive>`
 * line are different keys, and deleting one must never delete the other.
 */
export function recordShrinks({
  root = ROOT,
  stale,
  entries = readBaseline({ root }),
  primitiveCopies = readPrimitiveBaseline({ root }),
}) {
  const doomedFiles = new Set(stale.map((line) => /^stale_baseline:([^:]+):/u.exec(line)?.[1]).filter(Boolean));
  const doomedCopies = new Set(
    stale.map((line) => /^stale_primitive_copy:([^:]+:[a-zA-Z_$][\w$]*):/u.exec(line)?.[1]).filter(Boolean),
  );
  const kept = entries.filter((entry) => !doomedFiles.has(entry.file));
  const keptCopies = primitiveCopies.filter((entry) => !doomedCopies.has(`${entry.file}:${entry.primitive}`));
  return {
    path: resolve(root, BASELINE_PATH),
    kept,
    keptCopies,
    removed: entries.filter((entry) => doomedFiles.has(entry.file)).map((entry) => entry.file),
    removedCopies: primitiveCopies
      .filter((entry) => doomedCopies.has(`${entry.file}:${entry.primitive}`))
      .map((entry) => `${entry.file}:${entry.primitive}`),
  };
}

async function main() {
  if (process.argv.includes("--record-shrinks")) {
    const { report } = runScaffoldGate();
    if (report.blocked !== null) {
      process.stdout.write(`not_measured:${report.blocked}\n`);
      process.exitCode = 2;
      return;
    }
    const { path, kept, keptCopies, removed, removedCopies } = recordShrinks({ stale: report.stale });
    if (removed.length === 0 && removedCopies.length === 0) {
      process.stdout.write("record_shrinks: the baseline already describes the tree, nothing to delete\n");
      return;
    }
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, `${JSON.stringify({ entries: kept, primitiveCopies: keptCopies }, null, 2)}\n`, "utf8");
    process.stdout.write(`record_shrinks: deleted ${removed.length + removedCopies.length} entr(y|ies)\n`);
    for (const file of removed) process.stdout.write(`  ${file}\n`);
    for (const copy of removedCopies) process.stdout.write(`  ${copy}\n`);
    return;
  }

  const { report } = runScaffoldGate();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.blocked !== null ? 2 : Number(!report.ok);
    return;
  }
  for (const line of renderScaffoldReport(report)) process.stdout.write(`${line}\n`);
  process.exitCode = report.blocked !== null ? 2 : Number(!report.ok);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
