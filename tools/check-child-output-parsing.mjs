#!/usr/bin/env node
/**
 * Gate for "a child process's captured output was hand-parsed into lines".
 *
 * THE DEFECT CLASS
 *
 * A harness captures a child process's output and splits it by hand:
 *
 *   const lines = String(stdout).split("\n").map((line) => line.trim());
 *
 * That reads the bytes the child wrote, not the lines a terminal shows. A tool that rewrites a line in place - Playwright's
 * `line` reporter does, prefixing every rewritten line with `ESC[1A ESC[2K` - leaves control sequences inside the text, and
 * `trim()` removes whitespace, not escapes. Measured 2026-11-05: the real capture behind `tools/check-draft-declaration-coverage.mjs`
 * (`scratch/gb-draft-captured.txt`, 11082 bytes, 61 LF, 0 CR, 62 ESC bytes) split into **0** lines beginning `MEASURE `,
 * while the same bytes through `cleanOutputLines` (escapes removed) split into **6**. The gate that read those lines
 * reported `fields: 0` on a page that has fields, and passed: a check whose population is empty agrees with itself.
 * `3005803c` fixed that one gate; this gate exists so the next hand parse cannot be written silently.
 *
 * POPULATION, DERIVED
 *
 * Every `.mjs` file under `tools` and `integrations` whose syntax tree holds a capture call - `spawnSync(`, `execSync(`
 * or `execFileSync(`. The population is the filesystem: a new harness joins it by existing, with no entry here. A file
 * with no capture call cannot carry this defect and is not examined. A file that does not parse is a violation
 * (`source_unparsed`), never a clean file.
 *
 * THE RULE: A TAINTED HAND SPLIT
 *
 * The violation is not "this file splits strings". It is a `.split("\n")` / `.split('\n')` / `.split(/\r?\n/)`, or an
 * `.includes(...)` substring probe, whose RECEIVER carries a child process's output. Taint starts at the capture call and
 * at any local function that returns one (`function run() { return spawnSync(...); }`), and travels through
 *
 *   - declarators and assignments that hold it (`const executed = run(...)`, `` const output = `${executed.stdout}` ``);
 *   - `.stdout` / `.stderr` / `String(...)` / `.trim()` around it;
 *   - ONE HOP through a function's parameters: a call passing a tainted argument taints the parameter in that position
 *     (`inventory(output)` -> `readingLines(stdout)` -> `String(stdout).split("\n")`). That hop is what the real defect
 *     needed - the parse lived in a helper that received captured output as a parameter.
 *
 * Taint is resolved through the file's LEXICAL SCOPES, so a `candidate` or a `node` in an unrelated function is not
 * tainted by a name that happens to match somewhere else in the file.
 *
 * TWO BOUNDARIES, both deliberate:
 *
 *   - `cleanOutputLines(...)` is the SANITIZER: a receiver routed through it is clean, and taint does not travel out of it.
 *     A file that uses the shared reader goes green; spreading taint through it would make the gate unfixable.
 *   - `JSON.parse(...)` is a VALUE BOUNDARY: it turns bytes into a record or throws, so taint does not travel out of it
 *     either (an escape-laden document does not parse). A hand split INSIDE its argument is still read and still reported.
 *
 * A hand split over strictly non-child data - a `readFileSync(...)` source text, a launch log, `String(error)` - is not a
 * violation, and that is deliberate: `tools/check-text-hygiene.mjs` splits raw file bytes to report trailing whitespace,
 * and routing it through a trimming reader would delete the very whitespace it exists to report;
 * `tools/scripts/check-file-complexity-gate.mjs` counts raw lines the same way. A rule that named those files would have
 * one sane fix: blind a working gate. A file-level rule would also be satisfied by a dead import, which is why this gate
 * reads the LINE.
 *
 * DOCUMENTED FALSE NEGATIVES (this gate does not claim to be complete)
 *
 *   - Taint travels ONE hop through parameters. `parse(render(captured.stdout))`, where `parse` splits what `render`
 *     returned, is two hops and is NOT reported.
 *   - Taint is per file. Output captured in `run-live.mjs` and split by a helper module it imports is not reported: the
 *     helper has no capture call, so it is not in the population.
 *   - Taint is flow-insensitive: a binding whole-file taint, not per statement, so a name reassigned with clean data
 *     after holding captured output still counts as tainted.
 *   - `.includes(...)` is read as a substring probe on the receiver. Where a hand split on captured output produced the
 *     array, the split is reported and the probe on its result is not reported twice.
 *
 * Usage:
 *   node tools/check-child-output-parsing.mjs                  # tools + integrations
 *   node tools/check-child-output-parsing.mjs <dir> [<dir>]    # another scope, e.g. a pre-fix tree
 *   node tools/check-child-output-parsing.mjs --json
 *
 * Exit code is 1 on any violation, and 1 when the population is empty - a check that examined nothing cannot pass.
 *
 * red-proof: history  the pre-fix `tools/check-draft-declaration-coverage.mjs` (the bytes of 3005803c^) is fed to
 *   this gate and named at `:58` and `:83` - the two hand splits whose capture read 0 MEASURE lines. See
 *   `tools/check-child-output-parsing.test.mjs`.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseJavaScript } from "./lib/javascript-ast.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_SCOPES = Object.freeze(["tools", "integrations"]);
const SCANNED_EXTENSION = ".mjs";
const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);

/** The calls that run a child process and hand its output back as a value. */
export const CAPTURE_CALLS = Object.freeze(["spawnSync", "execSync", "execFileSync"]);

/** The shared reader: what comes out of it is lines, not bytes, so taint stops here. */
const SANITIZER = "cleanOutputLines";

/** A parse of bytes into a value (or a throw), so taint stops here too - but not inside its argument. */
const VALUE_TRANSFORMERS = new Set([SANITIZER, "JSON.parse"]);
/** Rule ids a finding can carry. `source_unparsed` is a finding: a file nobody could read was not examined. */
export const CHILD_OUTPUT_RULES = Object.freeze(["child_output_parsed_by_hand", "source_unparsed"]);

const CAPTURE_CALL_SOURCE = new RegExp(`\\b(?:${CAPTURE_CALLS.join("|")})\\s*\\(`, "u");

/** Function-like nodes: they open a scope, own their parameters, and can return captured output. */
const FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_expression",
  "arrow_function",
  "generator_function_declaration",
  "generator_function",
]);

function parseArguments(argv) {
  const options = { paths: [], json: false };
  for (const argument of argv) {
    if (argument === "--json") options.json = true;
    else if (argument.startsWith("--")) throw new Error(`unknown option ${argument}`);
    else options.paths.push(argument);
  }
  if (options.paths.length === 0) options.paths.push(...DEFAULT_SCOPES);
  return options;
}

function collectFiles(target, out) {
  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOTDIR") throw error;
    if (path.extname(target) === SCANNED_EXTENSION) out.add(target);
    return;
  }
  for (const entry of entries) {
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
      collectFiles(full, out);
      continue;
    }
    if (entry.isFile() && path.extname(entry.name) === SCANNED_EXTENSION) out.add(full);
  }
}

function relativeToRepository(absolutePath) {
  const relative = path.relative(REPOSITORY_ROOT, absolutePath);
  return relative.startsWith("..") ? absolutePath.split(path.sep).join("/") : relative.split(path.sep).join("/");
}

/** A syntax node's identity. Two wrappers for one CST node share a type and a span. */
function nodeKey(node) {
  return `${node.type}@${node.startIndex}-${node.endIndex}`;
}

/** Every named node under `root`, as a flat list. */
function nodes(root) {
  const all = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    all.push(node);
    for (const child of node.namedChildren) stack.push(child);
  }
  return all;
}

/** The name a call is written with - `spawnSync`, or `split` for `x.split` - and `null` for a computed callee. */
function calleeName(functionNode) {
  if (functionNode === null || functionNode === undefined) return null;
  if (functionNode.type === "identifier") return functionNode.text;
  if (functionNode.type === "member_expression") {
    const property = functionNode.childForFieldName("property");
    return property === null || property === undefined || property.type !== "property_identifier"
      ? null
      : property.text;
  }
  return null;
}

function calleeOf(call) {
  const functionNode = call.childForFieldName("function");
  return functionNode === null || functionNode === undefined ? null : functionNode;
}

function argumentsOf(call) {
  const args = call.childForFieldName("arguments");
  return args === null || args === undefined ? [] : args.namedChildren;
}

/** The identifier a binding or a parameter introduces, or `null` when it destructures. */
function boundName(node) {
  if (node === null || node === undefined) return null;
  if (node.type === "identifier") return node.text;
  if (node.type === "assignment_pattern" || node.type === "rest_pattern") return boundName(node.namedChildren[0]);
  return null;
}

function isSanitized(call) {
  return calleeName(calleeOf(call)) === SANITIZER;
}

/** The callee as written: `JSON.parse` keeps its receiver, so it can be told from an ordinary `parse` call. */
function calleeText(call) {
  const functionNode = calleeOf(call);
  return functionNode === null ? null : functionNode.text;
}

/** A newline split already ends the byte-text question: probing its result is that same defect, reported once. */
function isLineSplit(call) {
  const functionNode = calleeOf(call);
  if (functionNode === null || functionNode.type !== "member_expression") return false;
  if (calleeName(functionNode) !== "split") return false;
  return breaksLines(argumentsOf(call)[0]);
}

function isCaptureCallName(name) {
  return name !== null && CAPTURE_CALLS.includes(name);
}

/**
 * The file's bindings, functions and lexical scopes, from one walk.
 *
 * A scope is a function's parameters and the declarators written inside it, or the module's. Names resolve to the nearest
 * enclosing scope that declares them, so a `candidate` in one function cannot taint a differently-owned `candidate`.
 */
function readScopes(root) {
  const moduleScope = { parent: null, bindings: new Map() };
  const scopeByKey = new Map();
  const bindings = [];
  const functions = [];
  const functionByKey = new Map();
  const assignments = [];

  const declare = (scope, name, value, functionNode) => {
    if (name === null) return null;
    const existing = scope.bindings.get(name);
    if (existing !== undefined) return existing;
    const binding = { name, value, functionNode, tainted: false };
    scope.bindings.set(name, binding);
    bindings.push(binding);
    return binding;
  };

  const visit = (node, scope) => {
    let inner = scope;
    if (FUNCTION_TYPES.has(node.type)) {
      inner = { parent: scope, bindings: new Map() };
      const parameters = node.childForFieldName("parameters")?.namedChildren ?? [];
      const params = parameters.map((parameter) => declare(inner, boundName(parameter), null, null));
      const record = { node, params, returns: ownReturns(node) };
      functions.push(record);
      functionByKey.set(nodeKey(node), record);
      const nameNode = node.childForFieldName("name");
      const name = boundName(nameNode);
      if (name !== null) declare(scope, name, null, node);
    }
    scopeByKey.set(nodeKey(node), inner);
    if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      const name = boundName(node.childForFieldName("name"));
      const functionNode = value !== null && value !== undefined && FUNCTION_TYPES.has(value.type) ? value : null;
      declare(inner, name, value, functionNode);
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      // `let out = ""; ... out = execFileSync(...)` is the same carrier as a declarator holding the call.
      if (left !== null && right !== null && left.type === "identifier")
        assignments.push({ node, name: left.text, value: right });
    }
    for (const child of node.namedChildren) visit(child, inner);
  };

  visit(root, moduleScope);
  return { moduleScope, scopeByKey, bindings, functions, functionByKey, assignments };
}

function scopeAt(scopes, node) {
  return scopes.scopeByKey.get(nodeKey(node)) ?? scopes.moduleScope;
}

/** The binding a name refers to at this node, or `null` for a name this file does not declare (`String`, `process`). */
function resolveBinding(scopes, node, name) {
  for (let scope = scopeAt(scopes, node); scope !== null; scope = scope.parent) {
    const binding = scope.bindings.get(name);
    if (binding !== undefined) return binding;
  }
  return null;
}

/** Every `return` of this function itself - a nested function's return belongs to the nested function. */
function ownReturns(functionNode) {
  const own = nodeKey(functionNode);
  const values = [];
  for (const node of nodes(functionNode)) {
    if (node.type !== "return_statement") continue;
    const value = node.namedChildren[0];
    if (value === undefined) continue;
    let nested = false;
    for (let current = node.parent; current !== undefined && nodeKey(current) !== own; current = current.parent) {
      if (FUNCTION_TYPES.has(current.type)) {
        nested = true;
        break;
      }
    }
    if (!nested) values.push(value);
  }
  return values;
}

/** Does this expression carry a child process's output? */
function carriesCapture(node, scopes, tainted) {
  if (node === null || node === undefined) return false;
  if (node.type === "call_expression") {
    const text = calleeText(node);
    if (text !== null && VALUE_TRANSFORMERS.has(text)) return false;
    if (isLineSplit(node)) return false;
    const name = calleeName(calleeOf(node));
    if (isCaptureCallName(name)) return true;
    if (name !== null) {
      const binding = resolveBinding(scopes, node, name);
      const producer = binding?.functionNode;
      if (producer !== null && producer !== undefined && tainted.producers.has(nodeKey(producer))) return true;
    }
  }
  if (node.type === "identifier") {
    const binding = resolveBinding(scopes, node, node.text);
    return binding?.tainted === true;
  }
  return node.namedChildren.some((child) => carriesCapture(child, scopes, tainted));
}

/** Local functions whose own `return` hands captured output back to their caller. */
function taintProducers(scopes, tainted) {
  let changed = false;
  for (const record of scopes.functions) {
    const key = nodeKey(record.node);
    if (tainted.producers.has(key)) continue;
    if (!record.returns.some((value) => carriesCapture(value, scopes, tainted))) continue;
    tainted.producers.add(key);
    changed = true;
  }
  return changed;
}

/** Declarators and assignments that hold captured output. */
function taintBindings(scopes, tainted) {
  let changed = false;
  for (const binding of scopes.bindings) {
    if (binding.tainted || binding.value === null || binding.value === undefined) continue;
    if (!carriesCapture(binding.value, scopes, tainted)) continue;
    binding.tainted = true;
    changed = true;
  }
  for (const assignment of scopes.assignments) {
    if (!carriesCapture(assignment.value, scopes, tainted)) continue;
    const binding = resolveBinding(scopes, assignment.node, assignment.name);
    if (binding === null || binding.tainted) continue;
    binding.tainted = true;
    changed = true;
  }
  return changed;
}

/** Parameters tainted by a call site that passed captured output in that position - the one hop. */
function taintParameters(calls, scopes, tainted) {
  let changed = false;
  for (const call of calls) {
    const name = calleeName(calleeOf(call));
    if (name === null) continue;
    const producer = resolveBinding(scopes, call, name)?.functionNode;
    if (producer === null || producer === undefined) continue;
    const record = scopes.functionByKey.get(nodeKey(producer));
    if (record === undefined) continue;
    argumentsOf(call).forEach((argument, index) => {
      if (!carriesCapture(argument, scopes, tainted)) return;
      const parameter = record.params[index];
      if (parameter === null || parameter === undefined || parameter.tainted) return;
      parameter.tainted = true;
      changed = true;
    });
  }
  return changed;
}

/** The bindings and local functions that carry captured output in this file, to a fixed point. */
function captureTaint(root, scopes) {
  const tainted = { producers: new Set() };
  const calls = nodes(root).filter((node) => node.type === "call_expression");
  for (;;) {
    const producers = taintProducers(scopes, tainted);
    const bindings = taintBindings(scopes, tainted);
    const parameters = taintParameters(calls, scopes, tainted);
    if (producers || bindings || parameters) continue;
    return tainted;
  }
}

/** `"\n"`, `'\n'`, or a regular expression containing `\n`: the separators that cut captured output into lines. */
function breaksLines(separator) {
  if (separator === undefined) return false;
  if (separator.type === "string") return separator.text.slice(1, -1) === "\\n";
  if (separator.type === "regex") return separator.text.includes("\\n");
  return false;
}

/** Every hand parse of captured output in one file, one per line. */
function handParses(root, scopes) {
  const tainted = captureTaint(root, scopes);
  const found = [];
  const reported = new Set();
  for (const node of nodes(root)) {
    if (node.type !== "call_expression" || isSanitized(node)) continue;
    const functionNode = calleeOf(node);
    if (functionNode === null || functionNode.type !== "member_expression") continue;
    const method = calleeName(functionNode);
    if (method !== "split" && method !== "includes") continue;
    const receiver = functionNode.childForFieldName("object");
    if (receiver === null || receiver === undefined) continue;
    const separator = argumentsOf(node)[0];
    if (method === "split" && !breaksLines(separator)) continue;
    if (!carriesCapture(receiver, scopes, tainted)) continue;
    const form = method === "split" ? `split(${separator.text})` : "includes(...)";
    const line = node.startPosition.row + 1;
    if (reported.has(line)) continue;
    reported.add(line);
    found.push({ line, form, receiver: receiver.text });
  }
  return found;
}

/** The first node in a tree that did not parse, in source order. */
function firstErrorNode(root) {
  let earliest = null;
  for (const node of nodes(root)) {
    if (node.type !== "ERROR" && !node.isMissing) continue;
    if (earliest === null || node.startIndex < earliest.startIndex) earliest = node;
  }
  return earliest;
}

/** Whether this source, as syntax, calls one of the capture calls. */
function capturesChildOutput(root) {
  return nodes(root).some((node) => node.type === "call_expression" && isCaptureCallName(calleeName(calleeOf(node))));
}

/** One file's reading. `inPopulation` is the population question, answered from the syntax tree. */
export async function auditSource(source, fileName) {
  const root = (await parseJavaScript(source, fileName)).rootNode;
  if (root.hasError) {
    const at = firstErrorNode(root) ?? root;
    const line = at.startPosition.row + 1;
    return {
      fileName,
      inPopulation: CAPTURE_CALL_SOURCE.test(source),
      parsed: false,
      violations: [
        {
          id: `source_unparsed:${fileName}:${line}`,
          message: `does not parse at ${line}:${at.startPosition.column + 1}, so its captured output was never read`,
        },
      ],
    };
  }
  const scopes = readScopes(root);
  if (!capturesChildOutput(root)) return { fileName, inPopulation: false, parsed: true, violations: [] };
  const violations = handParses(root, scopes).map((parse) => ({
    id: `child_output_parsed_by_hand:${fileName}:${parse.line}`,
    message:
      `\`${parse.receiver.replace(/\s+/gu, " ").slice(0, 120)}\` holds captured child output and its ${parse.form} ` +
      "reads bytes, not lines (a reporter that rewrites a line in place leaves ESC[1A ESC[2K inside them); " +
      "use `cleanOutputLines(...)` from tools/lib/subprocess-output.mjs",
  }));
  return { fileName, inPopulation: true, parsed: true, violations };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const files = new Set();
  for (const target of options.paths) collectFiles(path.resolve(REPOSITORY_ROOT, target), files);

  const population = [];
  const violations = [];
  for (const file of [...files].sort()) {
    const fileName = relativeToRepository(file);
    const source = readFileSync(file, "utf8");
    // A file whose text never names a capture call cannot be in the population, and parsing every harness source in the
    // tree to learn that costs more than this prefilter does.
    if (!CAPTURE_CALL_SOURCE.test(source)) continue;
    const reading = await auditSource(source, fileName);
    if (!reading.inPopulation && reading.parsed) continue;
    population.push(fileName);
    violations.push(...reading.violations);
  }

  const examinedNothing = population.length === 0;
  let status = "passed";
  if (examinedNothing) status = "blocked";
  else if (violations.length > 0) status = "failed";
  const detail = examinedNothing
    ? `no scanned file under ${options.paths.join(", ")} holds a capture call (${CAPTURE_CALLS.join("/")}), so this gate examined nothing and cannot pass`
    : null;
  const report = {
    gate: "child-output-parsing",
    status,
    population: population.length,
    violations: violations.map((violation) => violation.id),
    detail,
  };

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    for (const violation of violations) process.stdout.write(`  ${violation.id}  ${violation.message}\n`);
    process.stdout.write(
      `child-output-parsing: examined ${population.length} files, violations ${violations.length}\n`,
    );
  }
  if (detail !== null) process.stderr.write(`child_output_parsing: ${detail}\n`);
  for (const violation of violations) process.stderr.write(`child_output_parsing: ${violation.id}\n`);
  process.exit(status === "passed" ? 0 : 1);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
