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
 *                   `tools/lib/x.mjs` is read as one that reads what that module reads. A read call is recognised by
 *                   the name it is CALLED by, which is not always the name it is imported under: `read = readFile`
 *                   (a parameter default), `const list = readdirSync` and `import { readFile as read }` all arrive
 *                   under another name, and `await import(url)` / `require(path)` load a file with no read call at
 *                   all. Both are followed here, because a gate that reaches its population that way reads it just
 *                   as much as one that names `readFileSync`.
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
 * THE GREEN-WITH-ZERO BUCKET IS THE NEXT ONE, and half of it would pass on an empty set for a reason nobody wrote down.
 * That bucket conflates four causes, and they have four different owners, so each member is recorded in
 * `tools/gate-inputs-zero-read.json` with the cause and what would settle it:
 *
 *   `empty-is-correct`     nothing may be there, and green is the right answer (`git diff --check` over no diff).
 *   `reader-blind`         the READING cannot see which members the gate judges - the root arrives as a function
 *                          parameter, or the call the gate reads through was one this model did not follow. The fix is
 *                          in this file.
 *   `unmeasurable`         the input is not in this tree (the operator's path, a built artifact, an installed game) or
 *                          the gate reads no file at all: nothing here can construct the empty case.
 *   `unguarded-population` the GATE has no zero branch over a population this tree owns, so a filter that moved reads
 *                          as a clean run. `guard` names the branch that would settle it - debt with an owner, kept
 *                          apart from the reading's blind spots because a read-model fix must never relabel a missing
 *                          guard as a blind reading, which is how debt disappears by being renamed.
 *
 * The population is derived (every `green-with-zero` gate), a missing row fails naming the gate and its reading, a row
 * whose gate left the bucket fails as stale, and the four causes are counted in the census line on every run. The rows
 * are authored because a cause is a judgement; the population never is.
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
 *   - a read that takes its path from a function parameter (`readdirSync(directory)` inside `walk`, a walker a lib
 *     exports) is NAMED in `because` (`root is directory, a parameter of walk`) and its path list stays empty. This
 *     reading carries no call graph, so it cannot hand the walker its argument; saying which parameter it stopped at
 *     is the difference between a measured blind spot and an empty list that looks like one.
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
 *            On a REAL member: `tools/check-dist-runtime-exports.mjs` loads `dist/index.js` with `await import(url)`,
 *            and this reading called it `no_file_read_reachable` until the load and the aliased reader were modelled
 *            (measured 2026-11-16: HEAD's reading over today's tree prints `unknown: tools/check-dist-runtime-exports.mjs`
 *            at `unknown 41 · green-with-zero 180`, this one names the load at `unknown 33 · green-with-zero 177`).
 *            With its row deleted, the zero-read gate fails naming it: `gate_input_green_with_zero_undeclared:
 *            tools/check-dist-runtime-exports.mjs — module_load:tools/check-dist-runtime-exports.mjs:import`.
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

/** Where each `green-with-zero` gate's cause is recorded. The rows are authored; the population is derived. */
export const ZERO_READ_POPULATION_PATH = "tools/gate-inputs-zero-read.json";
export const ZERO_READ_POPULATION_SCHEMA = "gamebuddy-gate-inputs-zero-read/v1";

/**
 * Why a gate that reads a set reports the same verdict over none of it. Four causes, because four different owners
 * have to act on them:
 *
 *   `empty-is-correct`     nothing may be there, and green is the right reading (`because` says why).
 *   `reader-blind`         the READING cannot see which members the gate judges: the fix is in the read model below,
 *                          or in the shared reader the gate hands its root to.
 *   `unmeasurable`         the input is not in this tree (the operator's path, a built artifact, an installed game) or
 *                          reads no file at all: nothing here settles the empty case.
 *   `unguarded-population` the GATE has no zero branch over a population this tree owns: `guard` names the branch
 *                          that would settle it. Naming them separately is the point - a reader fix must not
 *                          relabel a missing guard as a blind reading, because then the debt disappears unnamed.
 */
export const ZERO_READ_CAUSES = Object.freeze([
  "empty-is-correct",
  "reader-blind",
  "unmeasurable",
  "unguarded-population",
]);

/** The reading's blind spots a `reader-blind` row may name, each checked against what the reading now reports. */
export const BLIND_KINDS = Object.freeze(["root", "call_style", "member_predicate"]);

/** The shortest cause a row may carry: "no guard" alone is a row the next reader cannot act on. */
const MIN_REASON = 40;

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

/**
 * Calls that LOAD a file into this process instead of reading its bytes: `await import(url)`, `require(path)`.
 *
 * A module loaded this way is read as surely as one opened with `readFileSync` - a gate that inspects what
 * `dist/index.js` exports has that file as its population - and it was the one call style through which a gate that
 * reads real files was reported as reading nothing at all. `node:` specifiers are excluded where the load is recorded:
 * a built-in is not a file this repository carries.
 */
const LOAD_CALLS = new Set(["require"]);

/** Every call that reaches a file or a other program by name: the names an alias in the source can stand for. */
const READER_CALLS = new Set([...READ_CALLS, ...SCAN_CALLS, ...SPAWN_CALLS]);

/** Programs whose reading of this tree IS a derived population: `git` reads the index and the tree. */
const INDEX_PROGRAMS = new Set(["git"]);

/** The runtimes that execute this repository's own gate scripts: a command naming one of these is read by its file. */
const JAVASCRIPT_RUNTIMES = new Set(["node", "node.exe", "bun", "bun.exe", "deno", "deno.exe"]);

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

/** `true` for `await import(url)`: the one call whose callee is a keyword, so it has no identifier to match a set on. */
const isDynamicImport = (node) => node.childForFieldName("function")?.type === "import";

/** The reader a value expression stands for: `readFileSync`, `fs.readFileSync`, or `null` for anything else. */
function readerNamed(node) {
  if (node === null) return null;
  if (node.type === "identifier") return READER_CALLS.has(node.text) ? node.text : null;
  const property = node.type === "member_expression" ? node.childForFieldName("property")?.text : null;
  return property !== null && property !== undefined && READER_CALLS.has(property) ? property : null;
}

/**
 * The names this file calls a reader by, mapped to the reader: `import { readFile as read }`, `const list =
 * readdirSync`, `async function load(p, read = readFile)`. A gate does not have to spell the imported name at the call
 * site, and two of them (`tools/generate-sbom.mjs`, `tools/audit-preset-macro-frequency.mjs`) read their whole
 * population through a name bound this way - which the reading called `no_file_read_reachable` until it was followed.
 */
function readerAliases(tree) {
  const aliases = new Map();
  const visit = (node) => {
    if (node.type === "import_specifier") {
      const name = node.childForFieldName("name")?.text;
      const alias = node.childForFieldName("alias")?.text;
      if (name !== undefined && alias !== undefined && READER_CALLS.has(name)) aliases.set(alias, name);
    } else if (
      node.type === "variable_declarator" ||
      node.type === "assignment_pattern" ||
      node.type === "object_assignment_pattern"
    ) {
      const local = node.childForFieldName(node.type === "variable_declarator" ? "name" : "left");
      const reader = readerNamed(node.childForFieldName("value") ?? node.childForFieldName("right"));
      // `{ read = readFile } = {}` binds the reader as a destructured default: a dependency-injected reader, which is
      // the same alias under a shaping node this reading has to name separately.
      const bindsName = local?.type === "identifier" || local?.type === "shorthand_property_identifier_pattern";
      if (bindsName && reader !== null) aliases.set(local.text, reader);
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(tree.rootNode);
  return aliases;
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
    loads: [],
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
  const aliases = readerAliases(tree);
  const comments = [];
  // A population written down as a table (`const FILES = ["a", "b"]`) is hand-listed even when the read call that
  // consumes it names a loop variable: only a MODULE-LEVEL table counts, because one inside a function body is that
  // function's own list and says nothing about what the gate reads.
  let inBody = 0;
  const visit = (node, depth = 0, enclosing = null) => {
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
      const frame = functionFrame(node) ?? enclosing;
      for (const child of node.namedChildren) visit(child, depth + 1, frame);
      inBody -= 1;
      return;
    }
    // An arrow function assigned to a name takes that name: `const walk = (directory) => …` is the `walk` a caller
    // hands its root to, so the frame is resolved here and its body visited under it.
    const declaredFrame = node.type === "variable_declarator" ? functionFrame(node) : null;
    const frame = declaredFrame ?? enclosing;
    if (declaredFrame !== null) {
      for (const child of node.childForFieldName("value").namedChildren) visit(child, depth + 1, frame);
      return;
    }
    if (node.type === "call_expression") {
      const named = calleeName(node);
      const argument = node.childForFieldName("arguments")?.text ?? "";
      // The reader the source CALLS may be a name it bound to the reader: `read(p)` where `read = readFile`.
      const via = named === null ? undefined : aliases.get(named);
      const name = READER_CALLS.has(named) ? named : (via ?? null);
      const literals = pathLiterals(argument, extensions);
      // The name the source CALLED the reader by, when it was not the reader's own: `read(p)` for `readFile`.
      const calledAs = named !== name ? named : null;
      // A read whose directory is the function's own parameter: named, so a reader can see what this cannot follow.
      const first = node.childForFieldName("arguments")?.namedChildren[0];
      const parameterRoot =
        first?.type === "identifier" && frame?.parameters.includes(first.text) === true
          ? { parameter: first.text, owner: frame.name }
          : null;
      if (isDynamicImport(node) || (name === null && LOAD_CALLS.has(named))) {
        // A built-in is loaded by name, not read: `await import("node:fs/promises")` reaches no file here.
        const [specifier] = quotedLiterals(argument);
        if (specifier?.startsWith("node:") !== true)
          reading.loads.push({
            file,
            call: isDynamicImport(node) ? "import" : named,
            argument,
            literals: literals.filter((path) => !path.startsWith("node:")),
          });
      } else if (name !== null && SCAN_CALLS.has(name))
        reading.scans.push({ file, call: name, via: calledAs, argument, literals, root: parameterRoot });
      else if (name !== null && READ_CALLS.has(name))
        reading.reads.push({
          file,
          call: name,
          via: calledAs,
          argument,
          literals,
          root: parameterRoot,
          fromImport: mentionedNames(argument).filter((word) => imports.has(word)),
        });
      else if (name !== null && SPAWN_CALLS.has(name)) {
        // The program is the first quoted string, whatever its shape: `spawnSync("git", …)` names a program, not a path.
        const [program] = quotedLiterals(argument);
        reading.spawns.push({ file, call: name, via: calledAs, argument, program: program ?? null });
        // A program in this repository is a delegated reader, not a different reading: follow the file it runs.
        const script = literals.find((path) => existsSync(join(root, path)) && grammarWasmFor(path) !== null);
        if (script !== undefined) reading.programFiles.push(script);
      }
    }
    for (const child of node.namedChildren) visit(child, depth + 1, frame);
  };
  visit(tree.rootNode);
  reading.flags = zeroReadFlags(blankRanges(source, comments));
  return reading;
}

/** Node types that open a body: an array inside one is that function's own list, not the file's population. */
const FUNCTION_BODIES = new Set(["arrow_function", "function", "function_expression", "method_definition"]);

/**
 * The name and parameters of the function a node sits in, for the one read shape this reading cannot follow: a walker
 * that takes its directory as an argument. `readdirSync(directory)` inside `listSources(root)` reads whatever the gate
 * hands `listSources`, and this reading does not carry a call graph to hand it anything - so it says which parameter it
 * stopped at instead of printing a path list that is empty for 154 of the 381 gates. Measured 2026-11-16.
 */
function functionFrame(node) {
  const declared = node.type === "variable_declarator" ? node.childForFieldName("name")?.text : undefined;
  const body = node.type === "variable_declarator" ? node.childForFieldName("value") : node;
  if (body === null || body === undefined || !FUNCTION_BODIES.has(body.type)) return null;
  const parameters = body
    .childForFieldName("parameters")
    ?.namedChildren.filter((child) => child.type === "identifier")
    .map((child) => child.text);
  return {
    name: body.childForFieldName("name")?.text ?? declared ?? null,
    parameters: parameters ?? [],
  };
}

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
  const reading = { files: [], reads: [], scans: [], spawns: [], loads: [], tables: [], flags: emptyFlags() };
  while (queue.length > 0 && seen.size <= MAX_CLOSURE_FILES) {
    const { file, depth } = queue.shift();
    if (!cache.has(file)) cache.set(file, await evidenceIn({ root, file, extensions }));
    const evidence = cache.get(file);
    if (file === entry) reading.entry = evidence;
    reading.files.push(file);
    reading.reads.push(...evidence.reads);
    reading.scans.push(...evidence.scans);
    reading.spawns.push(...evidence.spawns);
    reading.loads.push(...evidence.loads);
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
 * The suffix that says a call resolved its reader or its root through another name: `(as read)` for an alias, `(root
 * is a parameter: listSources(root))` for a walker this reading cannot hand anything to. Silence when it resolved both.
 */
function describeRoot(entry) {
  const parts = [];
  if (entry.via) parts.push(`as ${entry.via}`);
  if (entry.root)
    parts.push(`root is ${entry.root.parameter}, a parameter of ${entry.root.owner ?? "an anonymous function"}`);
  return parts.length === 0 ? "" : ` (${parts.join("); ")})`;
}

/**
 * Where the population comes from, for one set of evidence. `null` means this set names no read at all, so a caller
 * can fall back to the wider closure instead of calling the gate `unknown` for having delegated its reading.
 *
 * `authority`   a scan or an index read, a path the file does not name itself (an imported table, a descriptor), or
 *               a module it loads with `import()`/`require()`.
 * `hand-listed` every path it reads is a literal in its own closure.
 * `external`    the reading is a program this repository does not carry (`knip`, `eslint`, `dotnet test`, `jscpd`).
 */
export function classifyReading(reading) {
  if (reading.scans.length > 0) {
    const [scan] = reading.scans;
    return {
      source: "authority",
      because: `directory_scan:${scan.file}:${scan.call}${describeRoot(scan)}`,
      reads: namedPaths(reading.scans),
    };
  }
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
      because: `path_not_written_in_this_reading:${reading.reads[0].file}:${reading.reads[0].call}${describeRoot(reading.reads[0])}`,
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
  // A file loaded into this process rather than opened: the exports of `dist/index.js` ARE the population of a gate
  // that asserts what that barrel exports, and this is the call through which such a gate was read as reading nothing.
  const loads = reading.loads ?? [];
  if (loads.length > 0)
    return { source: "authority", because: `module_load:${loads[0].file}:${loads[0].call}`, reads: namedPaths(loads) };
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
  // `depcruise --config … host/src/main.ts` names a file here, and that file decides nothing: the gate's verdict is the
  // published program's. A command whose program is not a JavaScript runtime is decided elsewhere however many of its
  // arguments exist in this repository, so a reading that reached no file through the script is `external`, not
  // `unknown`. The program is the first word of the last chained segment: `cd host && bun test …` is `bun`.
  const program = gate.command
    .split(/(?:&&|\|\||[;|])/u)
    .map((segment) => segment.trim().split(/\s+/u)[0])
    .filter((word) => word !== undefined && word !== "")
    .at(-1);
  if (classified.source === "unknown" && !JAVASCRIPT_RUNTIMES.has(program))
    return {
      ...base,
      closure: reading.files,
      source: "external",
      because: `runs_a_program_this_repository_does_not_carry:${program}`,
      reads: [],
      zeroRead: "unseen",
    };
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
export function statusOf({
  examined,
  baselineMissing,
  unrecorded,
  stale,
  populationMissing = false,
  zeroReadFindings = [],
}) {
  if (examined === 0 || baselineMissing || populationMissing) return "blocked";
  return unrecorded.length === 0 && stale.length === 0 && zeroReadFindings.length === 0 ? "passed" : "failed";
}

/** The recorded causes, or `null` when this root has none (a fixture tree, or a tree that owes one). */
export function readZeroReadPopulation(root = REPOSITORY_ROOT) {
  const path = join(root, ZERO_READ_POPULATION_PATH);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Every `green-with-zero` gate judged against the row that explains it, in both directions: a member without a row is an
 * unexplained green, and a row whose gate left the bucket has outlived its cause. A row also has to carry something the
 * next reader can act on - a reason, the blind spot, or the guard - because "no guard" alone is not a finding.
 */
export function judgeZeroReadPopulation({ members, population }) {
  const rows = new Map((population?.members ?? []).map((row) => [row.gate, row]));
  const findings = [];
  const add = (code, gate, detail) => findings.push({ code, gate, detail });
  for (const member of members) {
    const row = rows.get(member.id);
    if (row === undefined) {
      add("gate_input_green_with_zero_undeclared", member.id, `${member.id} — ${member.because}`);
      continue;
    }
    if (!ZERO_READ_CAUSES.includes(row.class))
      add("gate_input_zero_read_cause_unknown", member.id, `${member.id} — ${JSON.stringify(row.class)}`);
    if (typeof row.because !== "string" || row.because.trim().length < MIN_REASON)
      add(
        "gate_input_zero_read_row_without_a_reason",
        member.id,
        `${member.id} — the row says ${JSON.stringify(row.because ?? "")}`,
      );
    if (row.class === "reader-blind") {
      if (!BLIND_KINDS.includes(row.blind))
        add("gate_input_reader_blind_row_without_a_kind", member.id, `${member.id} — ${JSON.stringify(row.blind)}`);
      else if (row.blind === "root" && !member.because.includes("root is "))
        add(
          "gate_input_reader_blind_row_stale",
          member.id,
          `${member.id} — the reading now names the root: ${member.because}`,
        );
      else if (row.blind === "call_style" && member.because === "no_file_read_reachable")
        add(
          "gate_input_reader_blind_row_stale",
          member.id,
          `${member.id} — the reading no longer follows the call this row names`,
        );
    }
    if (row.class === "unguarded-population" && (typeof row.guard !== "string" || row.guard.trim() === ""))
      add("gate_input_unguarded_row_without_a_guard", member.id, `${member.id} — the row names no guard`);
  }
  const present = new Set(members.map((member) => member.id));
  const staleRows = [...rows.keys()].filter((id) => !present.has(id)).sort();
  for (const id of staleRows)
    add("gate_input_zero_read_row_stale", id, `${id} — the gate is no longer green-with-zero, so the row outlived it`);
  return { rows: rows.size, staleRows, findings, causes: countZeroReadCauses({ members, population }) };
}

/**
 * The four causes counted over the members, with `undeclared` for a member whose row is missing or unclassifiable: the
 * numbers are printed every run, so the debt is a count in the output and not only a file. A row deleted without a fix
 * moves its gate into `undeclared` and fails, which is what stops the count shrinking by bookkeeping.
 */
export function countZeroReadCauses({ members, population }) {
  const rows = new Map((population?.members ?? []).map((row) => [row.gate, row]));
  const counts = Object.fromEntries([...ZERO_READ_CAUSES, "undeclared"].map((cause) => [cause, 0]));
  for (const member of members) {
    const cause = rows.get(member.id)?.class;
    counts[ZERO_READ_CAUSES.includes(cause) ? cause : "undeclared"] += 1;
  }
  return counts;
}

const EXIT_FOR_STATUS = Object.freeze({ passed: 0, failed: 1, blocked: 2 });

/** The census line: the sources and the zero-read verdicts as two partitions of `examined`, then the worst class. */
function describeCensus({ examined, sources, zeroRead, members, baseline, zeroReadCauses }) {
  const line = (counts) =>
    Object.entries(counts)
      .map(([name, count]) => `${name} ${count}`)
      .join(" · ");
  return [
    `gate_inputs examined ${examined} · ${line(sources)}`,
    `  zero-read: ${line(zeroRead)}`,
    `  green-with-zero by cause: ${line(zeroReadCauses)}`,
    `  worst class ${WORST_SOURCE}+${WORST_ZERO_READ} ${members.length} · baseline ${baseline?.members.length ?? 0}`,
  ].join("\n");
}

/** The report every gate-meta tool in this tree prints: an id, a status, the population, and one entry per rule. */
export function buildReport({ reading, members, baseline, unrecorded, stale, population = null, zeroReadJudgement }) {
  const sources = countBy(reading.gates, "source", INPUT_SOURCES);
  const zeroRead = countBy(reading.gates, "zeroRead", ZERO_READ_VERDICTS);
  const baselineMissing = baseline === null;
  const populationMissing = population === null;
  const zeroReadFindings = zeroReadJudgement.findings;
  const zeroReadCauses = zeroReadJudgement.causes;
  const status = statusOf({
    examined: reading.examined,
    baselineMissing,
    unrecorded,
    stale,
    populationMissing,
    zeroReadFindings,
  });
  return {
    gate: "gate_inputs/v1",
    status,
    examined: reading.examined,
    populationSource: reading.populationSource,
    sources,
    zeroRead,
    zeroReadCauses,
    worstClass: members.length,
    baseline: baseline?.members.length ?? 0,
    unrecorded: unrecorded.map((gate) => gate.id),
    stale,
    zeroReadStale: zeroReadJudgement.staleRows,
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
      {
        id: "zero_read_classified",
        status: populationMissing ? "blocked" : zeroReadFindings.length === 0 ? "passed" : "failed",
        detail: populationMissing
          ? `no ${ZERO_READ_POPULATION_PATH}, so a green over nothing cannot be told from an explained one`
          : `${members.length} member(s) · ${zeroReadJudgement.rows} row(s) · ${zeroReadCauses.undeclared} undeclared · ${zeroReadFindings.length} finding(s)`,
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
  const green = reading.gates.filter((gate) => gate.zeroRead === WORST_ZERO_READ);
  const population = readZeroReadPopulation(root);
  const zeroReadJudgement = judgeZeroReadPopulation({ members: green, population });
  const report = buildReport({ reading, members, baseline, unrecorded, stale, population, zeroReadJudgement });

  if (argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ...report, gates: reading.gates })}\n`);
  else {
    process.stdout.write(
      `${describeCensus({ examined: reading.examined, sources: report.sources, zeroRead: report.zeroRead, members, baseline, zeroReadCauses: report.zeroReadCauses })}\n`,
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
    for (const finding of zeroReadJudgement.findings) process.stderr.write(`${finding.code}: ${finding.detail}\n`);
    if (baseline === null) process.stderr.write(`gate_input_baseline_missing: ${BASELINE_PATH}\n`);
    if (population === null)
      process.stderr.write(`gate_input_zero_read_population_missing: ${ZERO_READ_POPULATION_PATH}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = EXIT_FOR_STATUS[report.status];
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`gate_inputs: ${error.stack ?? error.message}\n`);
    process.exitCode = 2;
  });
