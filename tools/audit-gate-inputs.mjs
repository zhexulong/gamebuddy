#!/usr/bin/env node
/**
 * Every gate reads a population. This says, for each one, WHAT it reads, WHERE that population comes from, and WHAT
 * happens when it reads nothing - because tonight produced five green readings that were green about the wrong set.
 *
 * WHY (measured 2026-11-14, one night, five instances of one shape):
 *
 *   `RECONCILIATION`            counted failures and exited 0: the count reached the report and never the verdict.
 *   four populations, one word  `check-ci-coverage` 129 · `check-prelive-gate-registry` 143 · the census 371 · the tool
 *                               corpus 169, each calling itself "every gate", nothing asserting they agree.
 *   `[aria-modal]`              an assertion on a selector that stopped matching when the drawer became a `<dialog>`:
 *                               it read nothing, and read nothing as agreement.
 *   the assertion reader        could not see a multi-line `expect` or a node `assert` - and two spec comments said so
 *                               ("a node assertion here is a claim nothing reads"): the hole was known and lived in.
 *   two unassessed gates        `report:clones` and `test:voice-protocol` run no file this repository owns, and nothing
 *                               said so where a reader would look.
 *
 * None of those is a wrong rule. Each is a gate whose POPULATION was not the one the reader believed. So the question
 * this gate asks is not "is the rule right" but "what set did the rule run over, and what did an empty set produce".
 *
 * THE THREE FACTS, per gate, and how each is derived (nothing here is hand-listed):
 *
 *   a. `reads`      the paths the gate's own code names in a read position, collected from the entry file and the
 *                   relative imports it reads through (depth 2, bounded) - so a gate whose reading lives in
 *                   `tools/lib/x.mjs` is read as one that reads what that module reads.
 *   b. `source`     `authority` (a directory scan, the index through `git`, a glob, or a path built from a name the
 *                   gate does not declare) · `hand-listed` (every path it reads is a literal in its own closure) ·
 *                   `external` (the command names no file here, or runs a program whose reading this repository does
 *                   not carry) · `unreadable` (the entry file's language is not one this reading parses: `.py`, `.ps1`)
 *                   · `unknown` (no file read is reachable: named, never guessed).
 *   c. `zeroRead`   `blocked` (the shared judge `assertNonVacuous`/`reportBlockedInput`, or a zero comparison whose
 *                   branch exits/blocks) · `unmeasured` (a stated `allowEmpty` reason or a `not_measured` outcome) ·
 *                   `green-with-zero` (nothing above: a run over zero objects prints what a run over nine hundred does)
 *                   · `unseen` (`external`/`unreadable`: the code that decides is not here to read).
 *
 * THE WORST CLASS IS THE PAIR, and it fails: a gate that `hand-listed` its population is a gate whose members live in
 * its own source, and a gate that is `green-with-zero` reports nothing wrong when those members are gone. Put together
 * they cannot tell "there was nothing to check" from "everything is fine" - which is exactly the `[aria-modal]`
 * assertion. The pair is gated here, naming the gate and the population it hand-lists, with `examined N` printed beside
 * it and a zero population blocked (exit 2). The members already in that class are recorded in
 * `tools/gate-inputs-baseline.json`, written by `--update` from a real reading and never by hand; the ratchet turns
 * both ways - a new member fails, and a recorded member that is no longer in the class fails too, so a row cannot
 * outlive the debt it describes.
 *
 * WHAT THIS READING CANNOT SEE, stated rather than hidden (each is a `source` or a bucket a reader can act on):
 *
 *   - a gate whose reading is a program this repository does not carry is `external`, not green: knip, eslint,
 *     depcruise, jscpd, `dotnet test`, `pnpm --dir vendor/…`. It is counted, named, and its `zeroRead` is `unseen`.
 *   - a gate whose entry file is `.py`/`.ps1` is `unreadable`: this reading has no grammar for it.
 *   - a gate that reads no file through any call this reading models is `unknown`: the count is printed and the members
 *     are named, so `unknown` is a measurement of this reading's reach, never an agreement.
 *   - a zero-guard found in a dead branch reads the same as one on the verdict path, and a population computed under a
 *     name this reading does not model (`runsJudged`) is not seen. Both are why the members are printed rather than
 *     merely counted: each finding is a gate to inspect, not a proven defect.
 *
 * USAGE:
 *   node tools/audit-gate-inputs.mjs             # the reading and the gate; exit 1 on an unrecorded/stale member
 *   node tools/audit-gate-inputs.mjs --json      # machine-readable: every gate with its three facts
 *   node tools/audit-gate-inputs.mjs --root DIR  # read another tree (the red proofs use this)
 *   node tools/audit-gate-inputs.mjs --update    # rewrite the baseline from this reading
 *
 * red-proof: inject  a gate that hand-lists two paths and prints its verdict from its findings alone, added to a
 *            throwaway tree by the falsifier in tools/audit-gate-inputs.test.mjs -> the reading prints
 *            `gate_input_hand_listed_and_green_with_zero:` naming the gate and both paths, exit 1. Recorded in the
 *            baseline, the same reading is green; a row the tree outgrew is `gate_input_baseline_stale:`, exit 1.
 *            Measured 2026-11-14 on this checkout.
 *
 * No game, no network, no model: it parses this repository's sources with the shared tree-sitter seam.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { grammarWasmFor, parseJavaScript } from "./lib/javascript-ast.mjs";
import { deriveGatePopulation } from "./lib/gate-population.mjs";
import { describeUntracked, indexedGatePopulation } from "./lib/indexed-sources.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Where the recorded debt lives, relative to the root the gate was pointed at. */
export const BASELINE_PATH = "tools/gate-inputs-baseline.json";
export const BASELINE_SCHEMA = "gamebuddy-gate-inputs-baseline/v1";

/** Where a population comes from. A closed vocabulary: a new member has to mean one of these or say why. */
export const INPUT_SOURCES = Object.freeze(["authority", "hand-listed", "external", "unreadable", "unknown"]);

/** What a gate does when the set it reads is empty. `unseen` is the honest answer for code this reading cannot read. */
export const ZERO_READ_VERDICTS = Object.freeze(["blocked", "unmeasured", "green-with-zero", "unseen"]);

/** The pair that cannot tell "nothing to check" from "all good". */
export const WORST_SOURCE = "hand-listed";
export const WORST_ZERO_READ = "green-with-zero";

/** Calls that read a file or a directory. The name is the whole rule: this reading does not model a wrapper. */
const READ_CALLS = new Set([
  "createReadStream",
  "existsSync",
  "openSync",
  "readFile",
  "readFileSync",
  "readdir",
  "readdirSync",
  "opendirSync",
  "statSync",
]);

/** Calls that enumerate a directory: the population is derived at run time, not written down. */
const SCAN_CALLS = new Set(["glob", "globSync", "opendirSync", "readdir", "readdirSync"]);

/** Calls that hand the reading to another program. */
const SPAWN_CALLS = new Set(["execFile", "execFileSync", "execSync", "spawn", "spawnSync"]);

/** Programs whose reading of this tree IS a derived population: `git` reads the index and the tree. */
const INDEX_PROGRAMS = new Set(["git"]);

/** Node types whose text is data, not code: descending into them is how a gate starts reading prose. */
const OPAQUE = new Set(["comment", "string", "template_string", "regex"]);

/** A file whose evidence is folded into a gate's reading: the entry file plus its relative imports. */
const MAX_CLOSURE_FILES = 24;
const MAX_IMPORT_DEPTH = 2;

/** How many hand-listed paths a baseline row names before it summarises: enough to see the set, not the whole tree. */
const NAMED_LIMIT = 8;

/** A quoted string inside a reader's arguments, in either quote style, single-line. */
const QUOTED = /"([^"\\\n]+)"|'([^'\\\n]+)'|`([^`\n$]+)`/gu;

/** An identifier inside a reader's arguments, for the "the path comes from a name this file did not declare" case. */
const IDENTIFIER = /[A-Za-z_$][\w$]*/gu;

/** `import ... from "specifier"`, with or without a binding list. */
const IMPORT_SPECIFIER = /import\s+(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gu;

/** `import { a, b as c } from "..."`: the local names an import binds. */
const IMPORT_BINDINGS = /import\s*\{([^}]*)\}\s*from/gu;

const readText = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/**
 * The file extensions this repository actually carries, read from the index.
 *
 * A path-shaped string has to be recognised without a hand-written extension list: `"distractor.clean"` is an event
 * name in an array, `"package.json"` is a file, and the tree itself is the only authority that can tell them apart. So
 * a bare name counts as a path when its suffix is one the index carries; a name with a slash counts either way.
 */
function repositoryExtensions(root) {
  try {
    const listed = execFileSync("git", ["ls-files", "-z"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    const extensions = new Set();
    for (const path of listed.split("\0")) {
      const extension = extname(path).toLowerCase();
      if (extension !== "") extensions.add(extension);
    }
    return extensions;
  } catch {
    // A fixture tree is not a repository: a path with no slash then cannot be told from a word, so it is not one.
    return new Set();
  }
}

/** Whether a quoted string is a path rather than an encoding or an option: a slug with a slash, or a known suffix. */
function isPathShaped(text, extensions) {
  if (text.includes("/")) return true;
  return extensions.has(extname(text).toLowerCase());
}

/** Every quoted string inside an argument list, in either quote style, single-line. */
function quotedLiterals(argument) {
  const found = [];
  for (const match of String(argument ?? "").matchAll(QUOTED)) {
    const text = match[1] ?? match[2] ?? match[3] ?? "";
    if (text !== "") found.push(text);
  }
  return found;
}

/** The callee a call expression names: `f(x)` -> `f`, `a.b(x)` -> `b`. */
function calleeName(node) {
  const callee = node.childForFieldName("function");
  if (callee === null) return null;
  if (callee.type === "identifier") return callee.text;
  if (callee.type === "member_expression") return callee.childForFieldName("property")?.text ?? null;
  return null;
}

/** The path-shaped literals inside an argument list, in source order, deduplicated. */
function pathLiterals(argument, extensions) {
  const found = new Set();
  for (const text of quotedLiterals(argument)) if (isPathShaped(text, extensions)) found.add(text);
  return [...found];
}

/** Every name a reader's argument mentions, for the "the path is a name this file did not declare" test. */
function mentionedNames(argument) {
  return [...new Set([...String(argument ?? "").matchAll(IDENTIFIER)].map((match) => match[0]))];
}

/** The local names the file's own imports bind. */
function importedNames(source) {
  const names = new Set();
  for (const match of source.matchAll(IMPORT_BINDINGS))
    for (const part of match[1].split(",")) {
      const local = part
        .trim()
        .split(/\s+as\s+/u)
        .pop()
        ?.trim();
      if (local !== undefined && local !== "") names.add(local);
    }
  return names;
}

/** The relative specifiers the file imports, in source order: the only ones this reading follows. */
function relativeImports(source) {
  const specifiers = [];
  for (const match of source.matchAll(IMPORT_SPECIFIER)) if (match[1].startsWith(".")) specifiers.push(match[1]);
  return specifiers;
}

/**
 * What one file contributes to a gate's reading: the calls that read, scan or hand the reading to a program, the
 * relative imports followed, and the zero-read flags of its code (comments blanked, because a gate's own prose says
 * `not_measured` far more often than its verdict does).
 */
async function evidenceIn({ root, file, extensions }) {
  const source = readText(join(root, file));
  const reading = {
    file,
    reads: [],
    scans: [],
    spawns: [],
    tables: [],
    imports: [],
    programFiles: [],
    flags: emptyFlags(),
  };
  if (source === null) return reading;
  if (grammarWasmFor(file) === null) return reading;
  const imports = importedNames(source);
  reading.imports = relativeImports(source);
  const tree = await parseJavaScript(source, file);
  const comments = [];
  // A population written down as a table (`const FILES = ["a", "b"]`) is hand-listed even when the read call that
  // consumes it names a loop variable: only a MODULE-LEVEL table counts, because one inside a function body is that
  // function's own list and says nothing about what the gate reads.
  let inBody = 0;
  const visit = (node, depth = 0) => {
    if (node.type === "comment") {
      comments.push([node.startIndex, node.endIndex]);
      return;
    }
    if (node.type === "variable_declarator" && inBody === 0) {
      const value = node.childForFieldName("value");
      // A table is an array of STRINGS this file declares: reading the array's whole text would take a regex or a
      // fragment of code for a path, which is how the first version of this rule reported `).matchAll(/, /`.
      if (value !== null && value.type === "array") {
        const paths = value.namedChildren
          .filter((child) => child.type === "string")
          .map((child) => child.text.slice(1, -1))
          .filter((text) => isPathShaped(text, extensions));
        if (paths.length > 0) reading.tables.push({ file, paths });
      }
    }
    if (FUNCTION_BODIES.has(node.type)) {
      inBody += 1;
      for (const child of node.namedChildren) visit(child, depth + 1);
      inBody -= 1;
      return;
    }
    if (node.type === "call_expression") {
      const name = calleeName(node);
      const argument = node.childForFieldName("arguments")?.text ?? "";
      if (name !== null && SCAN_CALLS.has(name))
        reading.scans.push({ file, call: name, argument, literals: pathLiterals(argument, extensions) });
      else if (name !== null && READ_CALLS.has(name))
        reading.reads.push({
          file,
          call: name,
          argument,
          literals: pathLiterals(argument, extensions),
          fromImport: mentionedNames(argument).filter((word) => imports.has(word)),
        });
      else if (name !== null && SPAWN_CALLS.has(name)) {
        // The program is the first quoted string, whatever its shape: `spawnSync("git", …)` names a program, not a path.
        const [program] = quotedLiterals(argument);
        reading.spawns.push({ file, call: name, argument, program: program ?? null });
        // A program in this repository is a delegated reader, not a different reading: follow the file it runs.
        const script = pathLiterals(argument, extensions).find(
          (path) => existsSync(join(root, path)) && grammarWasmFor(path) !== null,
        );
        if (script !== undefined) reading.programFiles.push(script);
      }
    }
    for (const child of node.namedChildren) visit(child, depth + 1);
  };
  visit(tree.rootNode);
  reading.flags = zeroReadFlags(blankRanges(source, comments));
  return reading;
}

/** Node types that open a body: an array inside one is that function's own list, not the file's population. */
const FUNCTION_BODIES = new Set(["arrow_function", "function", "function_expression", "method_definition"]);

/** The flags the zero-read verdict is read from, in the three shapes the repository already uses. */
function emptyFlags() {
  return { allowEmpty: false, sharedJudge: false, actingZeroGuard: false, notMeasured: false };
}

/** A gate's zero-population handling, from its code with every comment blanked out. */
export function zeroReadFlags(code) {
  return {
    allowEmpty: /\ballowEmpty\b/u.test(code),
    sharedJudge: /\bassertNonVacuous\b|\breportBlockedInput\b/u.test(code),
    actingZeroGuard: ACTING_ZERO_GUARD.test(code),
    notMeasured: /\bnot_measured\b/u.test(code),
  };
}

/**
 * A zero comparison that ACTS: an `if` whose condition compares something with `0` and whose body exits, blocks or
 * throws. A comparison with no branch that changes the verdict is the shape of the defect, not its fix - which is why
 * `report.findings.length === 0` (the pass condition every gate has) is not matched here.
 */
const ACTING_ZERO_GUARD = new RegExp(
  "\\bif\\s*\\([^)]{0,160}?(?:===|==|<=|<)\\s*0\\b[^)]{0,80}?\\)\\s*[{]?[\\s\\S]{0,240}?" +
    "(?:process\\.exitCode\\s*=|process\\.exit\\(|\\bthrow\\b|\\bblocked\\b|\\bnot_measured\\b)",
  "u",
);

/** `source` with each `[start, end)` range blanked, offsets and newlines preserved. */
function blankRanges(source, ranges) {
  if (ranges.length === 0) return source;
  const out = source.split("");
  for (const [start, end] of ranges)
    for (let index = start; index < end && index < out.length; index += 1) if (out[index] !== "\n") out[index] = " ";
  return out.join("");
}

/** The file a relative specifier names, or `null` when this reading cannot follow it. */
function resolveSpecifier({ root, file, specifier }) {
  const base = normalize(join(dirname(file), specifier));
  for (const candidate of [base, `${base}.mjs`, `${base}.ts`, `${base}.js`, `${base}/index.mjs`])
    if (existsSync(join(root, candidate)) && grammarWasmFor(candidate) !== null) return candidate;
  return null;
}

/**
 * Everything the gate reads through, as one reading: its entry file, the relative imports it follows, and the files of
 * programs it runs that live in this repository. `files` is the closure and `flags` the OR of every member's - a
 * blocked branch anywhere in the code the gate reads through is a blocked zero.
 */
async function closureEvidence({ root, entry, cache, extensions }) {
  const seen = new Set([entry]);
  const queue = [{ file: entry, depth: 0 }];
  const reading = { files: [], reads: [], scans: [], spawns: [], tables: [], flags: emptyFlags() };
  while (queue.length > 0 && seen.size <= MAX_CLOSURE_FILES) {
    const { file, depth } = queue.shift();
    if (!cache.has(file)) cache.set(file, await evidenceIn({ root, file, extensions }));
    const evidence = cache.get(file);
    if (file === entry) reading.entry = evidence;
    reading.files.push(file);
    reading.reads.push(...evidence.reads);
    reading.scans.push(...evidence.scans);
    reading.spawns.push(...evidence.spawns);
    reading.tables.push(...evidence.tables);
    for (const [key, value] of Object.entries(evidence.flags)) reading.flags[key] = reading.flags[key] || value;
    if (depth >= MAX_IMPORT_DEPTH) continue;
    for (const next of [...evidence.imports, ...evidence.programFiles]) {
      const resolved = next.startsWith(".") ? resolveSpecifier({ root, file, specifier: next }) : next;
      if (resolved === null || seen.has(resolved)) continue;
      seen.add(resolved);
      queue.push({ file: resolved, depth: depth + 1 });
    }
  }
  return reading;
}

/** The paths a reading names, deduplicated and sorted, so two runs print the same row. */
function namedPaths(entries) {
  const found = new Set();
  for (const entry of entries) for (const literal of entry.literals ?? []) found.add(literal);
  return [...found].sort();
}

/**
 * Where the population comes from, for one set of evidence. `null` means this set names no read at all, so a caller
 * can fall back to the wider closure instead of calling the gate `unknown` for having delegated its reading.
 *
 * `authority`   a scan or an index read, or a path the file does not name itself (an imported table, a descriptor).
 * `hand-listed` every path it reads is a literal in its own closure.
 * `external`    the reading is a program this repository does not carry (`knip`, `eslint`, `dotnet test`, `jscpd`).
 */
export function classifyReading(reading) {
  if (reading.scans.length > 0)
    return {
      source: "authority",
      because: `directory_scan:${reading.scans[0].file}:${reading.scans[0].call}`,
      reads: namedPaths(reading.scans),
    };
  const index = reading.spawns.find((spawn) => INDEX_PROGRAMS.has(spawn.program ?? ""));
  if (index !== undefined)
    return { source: "authority", because: `index_read:${index.file}:${index.call}(${index.program})`, reads: [] };
  // A population the gate ENUMERATES itself is hand-listed: a module-level table a loop reads through, or two or more
  // paths written out in its own code. One path is not a population - it is a declaration the gate points at (a
  // `package.json`, a generated contract), and the members it holds are that declaration's, not this file's.
  const written = [
    ...new Set([...namedPaths(reading.reads), ...reading.tables.flatMap((table) => table.paths)]),
  ].sort();
  if (written.length >= 2 || reading.tables.length > 0)
    return {
      source: "hand-listed",
      because:
        reading.tables.length > 0
          ? `module_level_path_table:${reading.tables[0].file}`
          : `literal_paths:${written.length}`,
      reads: written,
    };
  if (written.length === 1) return { source: "authority", because: `fixed_input:${written[0]}`, reads: written };
  const imported = reading.reads.filter((read) => read.literals.length === 0 && read.fromImport.length > 0);
  if (imported.length > 0)
    return {
      source: "authority",
      because: `path_from_a_name_this_reading_does_not_declare:${imported[0].file}:${imported[0].call}`,
      reads: [],
    };
  // A read whose path is written nowhere in this closure is a path the gate derives at run time: that is a population
  // from an authority, and the reason names the call so a reader can check the claim instead of trusting it.
  if (reading.reads.length > 0)
    return {
      source: "authority",
      because: `path_not_written_in_this_reading:${reading.reads[0].file}:${reading.reads[0].call}`,
      reads: [],
    };
  if (reading.spawns.length > 0) {
    // A spawn whose program is a VALUE (`process.execPath`, a resolved constant) is this repository's own code being
    // run through a name this reading does not follow: that is a gap in the reading, not an external rule.
    const named = reading.spawns.find((spawn) => typeof spawn.program === "string" && spawn.program !== "");
    if (named === undefined)
      return {
        source: "unknown",
        because: `spawn_without_a_literal_program:${reading.spawns[0].file}:${reading.spawns[0].call}`,
        reads: [],
      };
    return {
      source: "external",
      because: `runs_a_program_this_repository_does_not_carry:${named.program}`,
      reads: [],
    };
  }
  return { source: "unknown", because: "no_file_read_reachable", reads: [] };
}

/** What the gate does when the set it reads is empty, from the code it reads through. */
export function zeroReadVerdict({ source, flags }) {
  if (source === "external" || source === "unreadable") return "unseen";
  if (flags.allowEmpty || flags.notMeasured) return "unmeasured";
  if (flags.sharedJudge || flags.actingZeroGuard) return "blocked";
  return "green-with-zero";
}

/** One gate's three facts. A gate whose command names no file here is `external`, and says so rather than passing. */
async function judgeGate({ root, gate, cache, extensions }) {
  const entry = gate.entryFiles[0] ?? null;
  const base = { id: gate.id, kind: gate.kind, command: gate.command, entry, closure: [] };
  if (entry === null || !existsSync(join(root, entry)))
    return {
      ...base,
      source: "external",
      because: "command_names_no_file_in_this_repository",
      reads: [],
      zeroRead: "unseen",
    };
  if (grammarWasmFor(entry) === null)
    return {
      ...base,
      source: "unreadable",
      because: `entry_language_not_parsed_here:${extname(entry)}`,
      reads: [],
      zeroRead: "unseen",
    };
  const reading = await closureEvidence({ root, entry, cache, extensions });
  // The population's provenance is decided by the code the command NAMES, and the closure only when that code
  // delegates its reading to a module: a shared helper's scan must not relabel a gate that reads a table of its own.
  const own = classifyReading(reading.entry ?? reading);
  const classified = own.source === "unknown" ? classifyReading(reading) : own;
  return {
    ...base,
    closure: reading.files,
    source: classified.source,
    because: classified.because,
    reads: classified.reads,
    zeroRead: zeroReadVerdict({ source: classified.source, flags: reading.flags }),
  };
}

/** The population: the ONE derivation, restricted to the index when git can answer. */
function gatePopulation(root) {
  try {
    return { ...indexedGatePopulation({ root }), populationSource: "index" };
  } catch {
    const derived = deriveGatePopulation({ root });
    return {
      gates: derived.gates,
      untrackedNotCounted: [],
      examined: derived.examined,
      dropped: derived.dropped,
      populationSource: "directory",
    };
  }
}

/**
 * The reading: every gate with its three facts. Sequential on purpose - one parse at a time keeps a 380-gate census
 * inside the memory a CI step has, and the per-file cache means a module twenty gates share is parsed once.
 */
export async function readGateInputs({ root = REPOSITORY_ROOT } = {}) {
  const population = gatePopulation(root);
  const extensions = repositoryExtensions(root);
  const cache = new Map();
  const gates = [];
  for (const gate of population.gates) gates.push(await judgeGate({ root, gate, cache, extensions }));
  return {
    gates,
    examined: gates.length,
    populationSource: population.populationSource,
    untrackedNotCounted: population.untrackedNotCounted,
  };
}

/** How many gates landed in each source, in the vocabulary's order. */
export function countBy(gates, key, vocabulary) {
  const counts = Object.fromEntries(vocabulary.map((member) => [member, 0]));
  for (const gate of gates) counts[gate[key]] += 1;
  return counts;
}

/** The members of the pair that cannot tell "nothing to check" from "all good". */
export function worstClass(gates) {
  return gates.filter((gate) => gate.source === WORST_SOURCE && gate.zeroRead === WORST_ZERO_READ);
}

/** A member's baseline row: its id, and the population it hand-lists. Identity is the id, never the line. */
export function baselineRow(gate) {
  const named = gate.reads.slice(0, NAMED_LIMIT).join(", ");
  const rest = gate.reads.length - NAMED_LIMIT;
  return `${gate.id} :: ${named}${rest > 0 ? `, … and ${rest} more` : ""}`;
}

/** The row's gate id: the part a ratchet compares, because the paths are the fact and the id is the member. */
const rowGate = (row) => row.split(" :: ")[0].trim();

/** The baseline document, from a real reading: `--update` writes this, nobody types it. */
export function baselineDocument(members) {
  return {
    schema: BASELINE_SCHEMA,
    note:
      "Gates that hand-list the population they read AND report nothing wrong when it is empty at this commit. A record " +
      "of debt, not an acceptance of it: delete a row by deriving the population or by blocking on zero, never by " +
      "adding one by hand. `--update` writes this file; the ratchet fails on a row the tree has outgrown.",
    members: members.map(baselineRow).sort(),
  };
}

/** The recorded debt, or `null` when this root has no baseline (a fixture tree, or a tree that owes one). */
export function readBaseline(root = REPOSITORY_ROOT) {
  const path = join(root, BASELINE_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * The ratchet. A member the baseline does not record is new debt and fails; a recorded member that is no longer in the
 * class fails too, because the record may only shrink. Both directions are what make this an expiring document rather
 * than a list of exemptions.
 */
export function compareWithBaseline({ members, baseline }) {
  const current = new Set(members.map((gate) => gate.id));
  const recorded = new Set((baseline?.members ?? []).map(rowGate));
  return {
    unrecorded: members.filter((gate) => !recorded.has(gate.id)),
    stale: [...recorded].filter((id) => !current.has(id)).sort(),
  };
}

/** The verdict, in the three words the rest of the tree uses: a reading that examined nothing cannot pass. */
export function statusOf({ examined, baselineMissing, unrecorded, stale }) {
  if (examined === 0 || baselineMissing) return "blocked";
  return unrecorded.length === 0 && stale.length === 0 ? "passed" : "failed";
}

const EXIT_FOR_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** The census line: the sources and the zero-read verdicts as two partitions of `examined`, then the worst class. */
function describeCensus({ examined, sources, zeroRead, members, baseline }) {
  const line = (counts) =>
    Object.entries(counts)
      .map(([name, count]) => `${name} ${count}`)
      .join(" · ");
  return [
    `gate_inputs examined ${examined} · ${line(sources)}`,
    `  zero-read: ${line(zeroRead)}`,
    `  worst class ${WORST_SOURCE}+${WORST_ZERO_READ} ${members.length} · baseline ${baseline?.members.length ?? 0}`,
  ].join("\n");
}

/** The report every gate-meta tool in this tree prints: an id, a status, the population, and one entry per rule. */
export function buildReport({ reading, members, baseline, unrecorded, stale }) {
  const sources = countBy(reading.gates, "source", INPUT_SOURCES);
  const zeroRead = countBy(reading.gates, "zeroRead", ZERO_READ_VERDICTS);
  const baselineMissing = baseline === null;
  const status = statusOf({ examined: reading.examined, baselineMissing, unrecorded, stale });
  return {
    gate: "gate_inputs/v1",
    status,
    examined: reading.examined,
    populationSource: reading.populationSource,
    sources,
    zeroRead,
    worstClass: members.length,
    baseline: baseline?.members.length ?? 0,
    unrecorded: unrecorded.map((gate) => gate.id),
    stale,
    untrackedNotCounted: [...reading.untrackedNotCounted].sort(),
    checks: [
      {
        id: "every_gate_classified",
        status: sources.unknown === 0 ? "passed" : "not_measured",
        detail:
          sources.unknown === 0
            ? "every gate's reading reached a source"
            : `${sources.unknown} gate(s) read no file through any call this reading models`,
      },
      {
        id: "baseline_current",
        status: baselineMissing ? "blocked" : unrecorded.length === 0 && stale.length === 0 ? "passed" : "failed",
        detail: baselineMissing
          ? `no ${BASELINE_PATH}, so no member of the worst class can be told from a new one`
          : `${unrecorded.length} unrecorded · ${stale.length} stale`,
      },
    ],
  };
}

/** The gates whose source this reading could not turn into a fact, named one per line so the count is actionable. */
function unclassified(gates) {
  return gates.filter((gate) => gate.source === "unknown");
}

async function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex < 0 ? REPOSITORY_ROOT : resolve(argv[rootIndex + 1] ?? "");
  const reading = await readGateInputs({ root });

  // Zero is blocked before anything is written: a census over no gates agrees with itself, and `--update` must not
  // record that agreement as the baseline.
  if (reading.examined === 0) {
    process.stderr.write(`gate_inputs: no gate was read, so nothing can be judged\n`);
    process.exitCode = 2;
    return;
  }

  const members = worstClass(reading.gates);
  if (argv.includes("--update")) {
    writeFileSync(join(root, BASELINE_PATH), `${JSON.stringify(baselineDocument(members), null, 2)}\n`);
    process.stdout.write(`gate_inputs: recorded ${members.length} member(s) of the worst class in ${BASELINE_PATH}\n`);
    return;
  }

  const baseline = readBaseline(root);
  const { unrecorded, stale } = compareWithBaseline({ members, baseline });
  const report = buildReport({ reading, members, baseline, unrecorded, stale });

  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ...report, gates: reading.gates })}\n`);
  else {
    process.stdout.write(
      `${describeCensus({ examined: reading.examined, sources: report.sources, zeroRead: report.zeroRead, members, baseline })}\n`,
    );
    if (report.untrackedNotCounted.length > 0)
      process.stdout.write(`  untracked_not_counted ${describeUntracked(new Set(report.untrackedNotCounted))}\n`);
    for (const gate of unclassified(reading.gates))
      process.stdout.write(`  unknown: ${gate.id} — ${gate.entry ?? "no entry file"}\n`);
    for (const gate of unrecorded)
      process.stderr.write(
        `gate_input_hand_listed_and_green_with_zero: ${gate.id} — ${gate.reads.join(", ") || "no path"}\n`,
      );
    for (const id of stale)
      process.stderr.write(`gate_input_baseline_stale: ${id} — the worst class no longer holds it\n`);
    if (baseline === null) process.stderr.write(`gate_input_baseline_missing: ${BASELINE_PATH}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = EXIT_FOR_STATUS[report.status];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`gate_inputs: ${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
