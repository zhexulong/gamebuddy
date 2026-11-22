#!/usr/bin/env node
/**
 * The gate for "a test froze a count the product owns" - as a POPULATION question.
 *
 * WHY (four instances in one night, 2026-11-05; provenance for the primitive in tools/lib/member-diff.mjs)
 *
 *   `expected 28 to equal 15`  a test froze "15 registered seams that all nine predicates reject" and the
 *                              authority held 28; the failure quoted two numbers and no member.
 *   `13 -> 15`                 a frozen key table grew by two keys.
 *   `66 of 68`                 a legal growth became 67 of 69.
 *   `advance_day -> sleep`     a rename left the assertion pointing at the old name.
 *
 * The class is one shape: an assertion whose expected side is a NUMBER LITERAL of a `.length`. The number goes stale the
 * moment the authority behind it grows or renames, and the diff it produces - "Expected 15, got 13" - names neither the
 * members that arrived nor the one that left. So a literal must not be the expected side OF A POPULATION:
 *
 *   assert.deepEqual(new Set(actual), new Set(AUTHORITY))      // the assertion
 *   describeMemberDiff("registered seams", actual, AUTHORITY)  // its message, naming the drift
 *
 * Two derived sides are fine: `assert.equal(snapshot.seams.length, AUTHORITY.length)` names an authority on both sides,
 * so it cannot go stale on its own - it reports the drift instead of freezing it.
 *
 * WHY THE COUNT WAS NOT THE PREDICATE (2026-11-13; this is what kept the gate off at `violations 1222`, 88% of them
 * noise). The first rule flagged EVERY literal `.length` comparison, and most of what it found was not the class:
 *
 *   `assert.equal(fixture.spawnCalls.length, 1)`   a spy the test declared five lines above it
 *                                                 (host/src/stardew-production-lifecycle-coordinator-game-create.internal.test.ts:129)
 *   `assert.equal(calls.length, 1)`                `const calls: unknown[] = []`, in the same test body
 *                                                 (host/src/composed-reference-game-browser.test.ts:690)
 *   `assert.equal(bytes.length, 11082)`            a capture fixture's byte count
 *
 * None of those can go stale from a product edit. The finding is real only where the population is DECLARED somewhere
 * other than the test that counts it, so the judgement is the counted value's PROVENANCE - three verdicts:
 *
 *   TEST_BUILT     this file builds the collection inside a test (`const calls = []` appended to as the run happens, a
 *                  fixture object the file bound itself, a literal, a local function over fixture arguments).
 *   NOT_A_MEMBERS  the value is text (`root` from `mkdtempSync`, `line.trim()`, a capture's bytes). A string's `.length`
 *                  counts characters; it has no members for `new Set(actual)` to name, so this class does not apply.
 *   PRODUCT        the value is a population declared outside the test that counts it: an import, a product function's
 *                  output over product input, or a collection THIS file declares at module level. Only this is a finding.
 *
 * The walk follows a declaration through its initializer (bounded), answers a member access from its root binding, reads
 * the file's own functions through their `return` expressions, and answers a call from its receiver - except two named
 * property sets: COLLECTION_PROJECTIONS (a filter of a set cannot grow a member the set did not have) and
 * OWN_KEY_READERS (`Object.keys(T)` measures T, not `Object`). A product function called ONLY on fixture input is a
 * function of that fixture; an argument that NAMES a product declaration (`readActionSurface(read(SOURCES.surface))`) is
 * not. Everything unanswered stays PRODUCT, so an unreadable shape keeps its finding rather than losing it.
 *
 * WHAT THE READING DOES NOT KNOW, stated rather than hidden: a fixture handed in as a parameter, a member of a name
 * nothing here binds, and a local helper that loads a product artifact (`const seams = loadSeams()`) all read as
 * TEST_BUILT or PRODUCT by the rules above and not by what they mean. That is the `unresolved` residual below.
 *
 * THE COUNT WAS NOT THE WHOLE PREDICATE EITHER (2026-11-16). The class is an ASSERTION whose expected side is a frozen
 * number, so a comparison is read only where it is one: `assert.equal`/`assert.strictEqual`, or a bare `===`/`==`
 * written INSIDE an `assert`/`t` call (`assert.ok(list.length === 15)`). The unscoped reading flagged every bare
 * comparison, and 29 of the 30 it found were the population's BUILDER rather than its frozen size:
 *
 *   lines.filter((line) => line.writers.length === 0);      the filter that decides WHICH members a later
 *                                                          `assert.deepEqual(members, [])` reports
 *   if (appeared.length === 0) continue;                   a paging loop's branch condition
 *   m.parameters?.length === 1 && ...                      a predicate inside `.find(...)`
 *
 * Every one of those already carried a `[not-a-population] ... a control-flow guard ... not an assertion` reason in
 * the baseline, so the record and the reading disagreed about the same 29 sites. Flagging them did not teach a fix: the
 * cheapest way to green one is `!line.writers.length`, which is worse code than the line it replaces, and the one real
 * assertion among the 30 (`assert.ok(finals.length === 1)`) sat in the baseline as debt. A comparison inside a callback
 * handed to an assertion stays out of scope too - `assert.throws(() => ...)` takes the code under test, not an
 * assertion's own expression.
 *
 * THE RESIDUAL IS RECORDED, NOT SILENCED (measured 2026-11-16, this tree):
 *
 *   examined 1112 · sites 39 · findings 0 · baseline 32 entries · unread 0
 *   residual by shape: 0 declaration_site · 19 call_result · 20 unresolved
 *   residual by verdict: 19 derivable-now · 13 not-a-population · 0 needs-a-decision
 *   set aside: 1137 test-built · 4 not-members
 *
 * Each shape is closeable, and each failure message says which one it is:
 *
 *   declaration_site  the counted value is an import or a table this file declares at module level - close it by
 *                     deriving the members from that declaration. (`INTEGRATION_REQUIREMENTS`)
 *   call_result       the value is a product function's output whose inputs name a product declaration - close it by
 *                     asserting the returned members against the declaration that fed the call.
 *   unresolved        the walk could not attribute the value - close it by naming the fixture the count belongs to, or by
 *                     teaching this reading that shape.
 *
 * EVERY ENTRY STATES WHICH KIND OF RESIDUE IT IS, in its own `reason`, opened with one of three verdicts. An entry that
 * states none fails as `literal_population_baseline_unexplained`, because a record that cannot say why a row is there is
 * indistinguishable from one nobody read:
 *
 *   [derivable-now]      an authority exists that both sides could read. The reason names the derivation; the row is debt
 *                        with a known fix, and clearing it is the work.
 *   [not-a-population]   there is no member set here to name: a string's character count, a control-flow or anti-vacuity
 *                        guard, a ternary in a fixture builder, a recorder the test seeded itself, a b-tree read off the
 *                        filesystem. `new Set(actual)` has nothing to print, so the gate's prescription cannot apply.
 *   [needs-a-decision]   the two readings disagree about WHAT the fact is, not merely its value. Named so a later lane
 *                        merges them only after deciding, instead of quietly collapsing one into the other.
 *
 * `tools/derived-population-baseline.json` holds those entries. The recorded residual MAY ONLY SHRINK: a site the
 * baseline does not hold is new debt and fails, a site that gained copies fails, and a site the tree no longer has is
 * `literal_population_baseline_stale` and fails. Identity is file + authority + literal, never the line, so a reformat
 * is the same site - a line-numbered identity reports a change that did not happen.
 *
 * THE `unread` ROW READ ONE FILE UNTIL THIS LANE, and the file was closed rather than the reading: it declared
 * `catalogRegistrations: readonly import("../../tools/protocol.js").ActionRegistration[]`, and the typescript wasm this seam loads
 * (0.3.1, the newest published build of that package) leaves one ERROR node at the alias's closing brace for a `readonly`
 * import type - one node, and the file's 8 comparisons were invisible. The grammar cannot be taught that shape from here,
 * so the file names the type through `import type { ActionRegistration }`, the form every other reader of `./protocol.js`
 * already uses; the new reading adds no finding, because all 8 counts belong to the fixture the test builds itself. A file
 * the grammar still cannot read is named with the position of the node that stopped it, on stdout and on stderr, and it
 * fails the run: unmeasured is not the same as clean.
 *
 * WHAT IS READ, and why syntax rather than a grep: this file's own fixtures spell the defect inside string and template
 * literals, and a comment could spell it too. A line scanner cannot tell those from code, so the reading is the syntax
 * tree (tools/lib/javascript-ast.mjs): comments and strings are never descended into, and the line is the node's own.
 *
 * Usage:
 *   node tools/check-derived-population.mjs             # the gate; exit 1 on a new/stale site, an unread file or an empty population
 *   node tools/check-derived-population.mjs --json      # the reading, machine-readable, including every site
 *   node tools/check-derived-population.mjs --root <dir>  # the gate's own fixture
 *
 * red-proof: inject  `const SURFACES = ["water_crop", "cut_weeds"]` with `assert.equal(SURFACES.length, 2)` appended to
 *            tools/check-refusal-informativeness.test.mjs, the file that consumes the derived surface, read
 *            `literal_population_assertion:tools/check-refusal-informativeness.test.mjs:584:2 — use SURFACES.length or`
 *            `assert.deepEqual(new Set(actual), new Set(AUTHORITY))` (shape `declaration_site`) with `status failed`
 *            and `examined 997`; removed, the same command reads `findings 0`. It read `findings 1` on
 *            `tools/check-spec-waiver-comments.test.mjs:110` - a site the injection did not create - until that
 *            count was derived from the comment lines the test builds. Measured 2026-11-13 on this checkout.
 *
 * red-proof: `--root` over a fixture whose baseline entry carries no `reason` reads `findings 1` and
 *            `literal_population_baseline_unexplained:host/src/a.test.ts:3 — `list` is recorded with no verdict, so the
 *            record cannot say whether it is debt or not one fact`; giving that entry
 *            `reason: "[derivable-now] list is the seams table"` reads `findings 0 status passed` and
 *            `residual by verdict: 1 derivable-now · 0 not-a-population · 0 needs-a-decision`. Measured 2026-11-14.
 *
 * red-proof: fixture  `--root` over a fixture test file carrying `readonly import("../../tools/protocol.js").ActionRegistration[]`
 *            reads `derived_population examined 1 sites 0 findings 0 baseline 0 unread 1 status failed`, exit 1, and the
 *            unread row names the ERROR node's line and column on stdout as well as on stderr; the same fixture with that
 *            declaration spelled through a named `import type` reads the frozen count it carries as
 *            `literal_population_assertion` - and before this lane the first run read `status passed`, because an unread
 *            file used to leave the run green. Measured 2026-11-15.
 *
 * red-proof: history  the scoping lane replayed the finding this checkout actually carried. Before it,
 *            `node tools/check-derived-population.mjs` read `sites 68 findings 1 status failed`, the finding being
 *            `literal_population_assertion:host/src/framework-roleplay-gate.test.ts:1064:0 — use line.writers.length`,
 *            on a `filter((line) => line.writers.length === 0)` whose asserted members three lines below already read
 *            `assert.deepEqual(members, [])` - the gate red on a line doing the right thing. After it the same command
 *            reads `examined 1112 sites 39 findings 0 baseline 32 unread 0 status passed`, exit 0, and the reading did
 *            not go blind: with the `finals` entry dropped from the baseline in memory, the assertion form still reds as
 *            `literal_population_assertion:host/src/native-companion-pacing-delivery.test.ts:130:1 — use finals.length`
 *            (an `assert.ok(finals.length === 1)`). Measured 2026-11-16 on this checkout.
 *
 * Also injected, each seen red once (tools/check-derived-population.test.mjs): `assert.equal(list.length, 15)` on a
 * test file's own array, the same literal on the left of the assertion, an `assert.ok(list.length === 15)` beside a
 * `filter((line) => line.writers.length === 0)` that builds the population a correct `assert.deepEqual` reads, the same
 * pair inside/around `assert.throws`'s callback, two derived sides reported as a literal, every file in a directory
 * treated as a test, an unsorted member diff, an empty population treated as a pass, a raw-text sweep in place of the
 * syntax tree, a count of a test's own recorder, a count of a string, a new site, a stale baseline entry, and a file the
 * grammar cannot read.
 */

export const gateDeclaration = {
  id: "check-derived-population",
  domain: "data",
  tier: "l1",
  kind: "totality",
};

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJavaScript } from "../../tools/lib/javascript-ast.mjs";
import { rootFromArgv } from "../../tools/lib/gate-preamble.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The directories whose tests can freeze a population, and the suffix that makes a file one of them.
 * `under` narrows a directory whose tests live in a `tests/` segment (`integrations/<integration>/tests`).
 */
export const POPULATION_SCOPE = Object.freeze([
  { directory: "host/src", suffix: ".test.ts" },
  { directory: "dialogue-web/tests", suffix: ".ts" },
  { directory: "tools", suffix: ".test.mjs" },
  { directory: "integrations", suffix: ".mjs", under: "tests" },
]);

/** The assertion helpers that compare a value with an expectation. */
const ASSERTING_METHODS = new Set(["equal", "strictEqual"]);

/** The operators that compare directly, without a helper. */
const COMPARING_OPERATORS = new Set(["===", "=="]);

/** Node types whose text is data, not code: descending into them is how a gate starts reading prose. */
const OPAQUE = new Set(["comment", "string", "template_string", "regex"]);

/** Whether a file under `scope.directory` is one of that scope's tests: its suffix, and its `under` segment. */
function isPopulationFile(relativePath, scope) {
  if (!relativePath.endsWith(scope.suffix)) return false;
  if (scope.under === undefined) return true;
  return relativePath.split("/").slice(0, -1).includes(scope.under);
}

/** Every file in the scope, sorted so the reading is the same on every run. */
export function populationFiles({ root = REPOSITORY_ROOT, scope = POPULATION_SCOPE } = {}) {
  const found = new Set();
  for (const candidate of scope) {
    const walk = (directory, relativePath) => {
      let entries;
      try {
        entries = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = `${directory}/${entry.name}`;
        const relative = `${relativePath}/${entry.name}`;
        if (entry.isDirectory()) {
          // A checked-out revision, a capture root or an installed dependency is not this tree's tests.
          if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
          walk(path, relative);
        } else if (isPopulationFile(relative, candidate)) {
          found.add(path);
        }
      }
    };
    walk(`${root}/${candidate.directory}`, candidate.directory);
  }
  return [...found].sort();
}

/** A `x.length` access, whose expected side must never be a literal. */
function lengthOf(node) {
  if (node?.type !== "member_expression") return null;
  const property = node.childForFieldName("property");
  if (property?.type !== "property_identifier" || property.text !== "length") return null;
  const object = node.childForFieldName("object");
  return { node, object, authority: object === null ? node.text.slice(0, -".length".length) : object.text };
}

/**
 * What a counted value IS, which is the whole discrimination this gate was missing.
 *
 * `TEST_BUILT`      - the file builds the collection it counts, inside the test: `const calls = []` appended to as the
 *                     run happens, a fixture object the file bound itself. Its size is this file's business, and no
 *                     product edit can make the literal wrong.
 * `NOT_A_MEMBERS`   - the value is text (`root` from `mkdtempSync`, a capture's bytes, `line.trim()`). A string's
 *                     `.length` counts characters; it has no members to grow, so `new Set(...)` cannot name its drift.
 * `PRODUCT`         - the value is a population declared outside the test that counts it: an import, a product
 *                     function's output, or a collection this file declares at module level. Its members live in
 *                     another declaration, so a literal here freezes a set this file does not own - the finding.
 *
 * The reading is a provenance walk with three deliberate limits, because a syntax tree cannot see what a function
 * returns: a declaration made inside a test is followed through its initializer (bounded by `seen`), a member access is
 * answered by its root binding, and a call is answered by its receiver except for the two named property sets below.
 * Everything unanswered is `PRODUCT`, so an unreadable shape keeps its finding rather than losing it.
 */
const TEST_BUILT = "test_built";
const NOT_A_MEMBERS = "not_a_members";
const PRODUCT = "product_declared";

/** Properties whose result is a projection of the receiver, so the receiver owns the population being counted. */
const COLLECTION_PROJECTIONS = new Set([
  "concat",
  "filter",
  "flat",
  "flatMap",
  "map",
  "reverse",
  "slice",
  "sort",
  "splice",
  "toReversed",
  "toSorted",
  "toSpliced",
]);

/** Properties only a string, a Map or an array of strings has: whatever the receiver is, the result is text. */
const TEXT_PROJECTIONS = new Set([
  "charAt",
  "join",
  "normalize",
  "padEnd",
  "padStart",
  "repeat",
  "replace",
  "replaceAll",
  "substring",
  "toLocaleLowerCase",
  "toLocaleUpperCase",
  "toLowerCase",
  "toString",
  "toUpperCase",
  "toWellFormed",
  "trim",
  "trimEnd",
  "trimStart",
]);

/** The own-key readers: their result is a projection of the ARGUMENT, not of the receiver they are called on. */
const OWN_KEY_READERS = new Map([
  ["Array", new Set(["from", "of"])],
  ["Object", new Set(["entries", "getOwnPropertyNames", "getOwnPropertySymbols", "keys", "values"])],
  ["Reflect", new Set(["ownKeys"])],
]);

/** The globals that turn a value into text. */
const TEXT_PRODUCERS = new Set(["JSON.stringify", "String"]);

/**
 * The standard readers that hand back file text or a machine's paths, whose `.length` is a character count. Named here
 * rather than guessed: every one of them comes from `node:fs`, `node:os` or `node:path`, never from this product.
 */
const TEXT_FUNCTIONS = new Set([
  "basename",
  "dirname",
  "homedir",
  "readFile",
  "readFileSync",
  "realpathSync",
  "resolve",
  "tmpdir",
]);

/** A member path whose value is always text, whatever the object is. */
const TEXT_MEMBERS = new Set(["LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]);

/** Node types that only carry a type assertion or a wrap: the value is the inner expression. */
const TRANSPARENT = new Set([
  "as_expression",
  "await_expression",
  "non_null_expression",
  "parenthesized_expression",
  "satisfies_expression",
]);

/** The expression inside a wrapper. `type_assertion` puts its type first (`<T>x`), the others put the value first. */
function unwrap(node) {
  let current = node;
  for (;;) {
    if (current === null || current === undefined) return null;
    if (current.type === "type_assertion") {
      current = current.namedChildren.at(-1) ?? null;
      continue;
    }
    if (!TRANSPARENT.has(current.type)) return current;
    current = current.namedChildren[0] ?? null;
  }
}

/** The identifier whose value a member chain, a subscript or a call ultimately reads. */
function rootIdentifier(node) {
  let current = unwrap(node);
  while (current !== null) {
    if (current.type === "identifier") return current;
    if (current.type === "member_expression" || current.type === "subscript_expression") {
      current = unwrap(current.childForFieldName("object"));
      continue;
    }
    if (current.type === "call_expression") {
      current = unwrap(current.childForFieldName("function"));
      continue;
    }
    return null;
  }
  return null;
}

/** Every name a declarator's pattern binds: `x`, `{ a, b: c }`, `[d, ...e]`. */
function declaredNamesDeclaration(node) {
  const names = [];
  const visit = (candidate) => {
    if (candidate === null) return;
    if (candidate.type === "identifier") names.push(candidate.text);
    else if (candidate.type === "shorthand_property_identifier_pattern") names.push(candidate.text);
    else for (const child of candidate.namedChildren) visit(child);
  };
  visit(node);
  return names;
}

/** The local names an `import` statement binds. */
function importedNames(statement) {
  const names = [];
  const visit = (node) => {
    if (node.type === "string") return;
    if (node.type === "identifier") names.push(node.text);
    for (const child of node.namedChildren) visit(child);
  };
  visit(statement);
  return names;
}

const FUNCTION_VALUES = new Set([
  "arrow_function",
  "function",
  "function_declaration",
  "generator_function_declaration",
]);

/**
 * The names this file binds, in source order, and where each one's value comes from. An `import` binds another
 * module's declaration; a declaration binds its initializer, which the provenance walk follows; `moduleLevel` says
 * whether that declaration is a declaration site of this file (a table, a list) or a construction inside a test.
 *
 * A name is kept as a LIST rather than as one entry because a test file legitimately declares `const { violations }`
 * in nine different test bodies and once more from an imported gate at the bottom of the file; the last declaration
 * in the file has nothing to do with the binding the ninth assertion reads.
 */
function fileBindings(tree) {
  const bindings = new Map();
  const record = (name, entry) => {
    const existing = bindings.get(name);
    if (existing === undefined) bindings.set(name, [entry]);
    else existing.push(entry);
  };
  const visit = (node, moduleLevel) => {
    if (OPAQUE.has(node.type)) return;
    if (node.type === "import_statement") {
      for (const name of importedNames(node)) {
        record(name, { kind: "import", value: null, moduleLevel, startIndex: node.startIndex });
      }
      return;
    }
    if (node.type === "variable_declarator") {
      const value = node.childForFieldName("value");
      for (const name of declaredNamesDeclaration(node.childForFieldName("name"))) {
        record(name, { kind: "value", value, moduleLevel, startIndex: node.startIndex });
      }
      if (value !== null) visit(value, false);
      return;
    }
    if (node.type === "function_declaration" || node.type === "generator_function_declaration") {
      const name = node.childForFieldName("name");
      if (name !== null) record(name.text, { kind: "value", value: node, moduleLevel, startIndex: node.startIndex });
    }
    // A declaration inside a body is a test's own construction; a declaration at the top level of the module - even one
    // wrapped in `export` or a plain `const` statement - is this file's declaration site.
    for (const child of node.namedChildren) visit(child, moduleLevel && !entersBody(node));
  };
  for (const child of tree.rootNode.namedChildren) visit(child, true);
  return bindings;
}

/** Whether a node opens a body, so a declaration inside it is not a declaration site of the module. */
function entersBody(node) {
  return (
    FUNCTION_VALUES.has(node.type) ||
    node.type === "function_expression" ||
    node.type === "method_definition" ||
    node.type === "class_body" ||
    node.type === "statement_block"
  );
}

/** The declaration a reference at `node` reads: the nearest one written above it, else the outermost. */
function bindingAt(bindings, name, node) {
  const declared = bindings.get(name);
  if (declared === undefined) return undefined;
  const above = declared.filter((entry) => entry.startIndex <= node.startIndex);
  return above.length > 0 ? above.at(-1) : declared[0];
}

/** Whether a bound value is the file's own function, so calling it returns something the file wrote. */
function isFunctionValue(binding) {
  if (binding === undefined || binding.kind !== "value" || binding.value === null) return false;
  const unwrapped = unwrap(binding.value);
  return unwrapped !== null && FUNCTION_VALUES.has(unwrapped.type);
}

/**
 * Every `return` expression a function hands back, without descending into functions declared inside it. A file's own
 * helper is read rather than assumed: `const read = (p) => readFileSync(join(ROOT, p), "utf8")` returns TEXT, and a
 * count of what a parser made of that text is a count of a product artifact - not a fixture's.
 */
function returnedExpressions(fn, found = []) {
  const body = fn.childForFieldName("body");
  if (body === null) return found;
  if (body.type !== "statement_block") {
    found.push(body);
    return found;
  }
  const visit = (node) => {
    if (FUNCTION_VALUES.has(node.type) || node.type === "method_definition") return;
    if (node.type === "return_statement") {
      const expression = node.namedChildren[0];
      if (expression !== undefined) found.push(expression);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(body);
  return found;
}

/** What a call to one of the file's own functions hands back, read from its own `return` expressions. */
function returnVerdict(binding, bindings, seen) {
  const fn = unwrap(binding.value);
  const expressions = returnedExpressions(fn);
  if (expressions.length === 0) return NOT_A_MEMBERS;
  let verdict = TEST_BUILT;
  for (const expression of expressions) {
    const resolved = provenanceOf(expression, bindings, seen);
    if (resolved === PRODUCT) return PRODUCT;
    if (resolved === NOT_A_MEMBERS) verdict = NOT_A_MEMBERS;
  }
  return verdict;
}

/** The verdict for a name this file declares at module level: a declaration site is a population, text is not. */
function declaredHere(binding, bindings, seen) {
  if (binding.value === null) return NOT_A_MEMBERS;
  const resolved = isFunctionValue(binding)
    ? returnVerdict(binding, bindings, seen)
    : provenanceOf(binding.value, bindings, seen);
  return resolved === NOT_A_MEMBERS ? NOT_A_MEMBERS : PRODUCT;
}

/** Whether any name inside `node` resolves to a declaration this file did not make (an import, a module-level table). */
function mentionsProductName(node, bindings) {
  if (node === null) return false;
  if (OPAQUE.has(node.type)) return false;
  if (node.type === "identifier") {
    const binding = bindingAt(bindings, node.text, node);
    return binding !== undefined && (binding.kind === "import" || binding.moduleLevel);
  }
  return node.namedChildren.some((child) => mentionsProductName(child, bindings));
}

/** Whether an argument set is the test's own input: every argument built here, and no product name among them. */
function isFixtureInput(args, bindings, seen) {
  if (args.length === 0) return false;
  if (args.some((arg) => mentionsProductName(arg, bindings))) return false;
  return args.every((arg) => {
    const verdict = provenanceOf(arg, bindings, seen);
    return verdict === TEST_BUILT || verdict === NOT_A_MEMBERS;
  });
}

/** Where the value of `node` comes from, as one of `TEST_BUILT` / `NOT_A_MEMBERS` / `PRODUCT`. */
function provenanceOf(node, bindings, seen = new Set()) {
  const current = unwrap(node);
  if (current === null) return PRODUCT;
  if (current.type === "identifier") {
    const binding = bindingAt(bindings, current.text, current);
    if (binding === undefined || binding.kind === "import") return PRODUCT;
    if (binding.moduleLevel) return declaredHere(binding, bindings, seen);
    if (binding.value === null) return TEST_BUILT;
    if (isFunctionValue(binding)) return NOT_A_MEMBERS;
    if (seen.has(binding.value.id)) return TEST_BUILT;
    seen.add(binding.value.id);
    return provenanceOf(binding.value, bindings, seen);
  }
  if (current.type === "member_expression" || current.type === "subscript_expression") {
    const property = current.childForFieldName("property")?.text;
    if (property !== undefined && TEXT_MEMBERS.has(property)) return NOT_A_MEMBERS;
    // A field of a name this file bound is this file's state, whatever produced the object: the file decided to read
    // `fixture.spawnCalls`, and only `fixture` names the thing a product edit could grow.
    const root = rootIdentifier(current);
    if (root !== null && bindingAt(bindings, root.text, root) !== undefined) return TEST_BUILT;
    return provenanceOf(current.childForFieldName("object"), bindings, seen);
  }
  if (current.type === "call_expression") {
    const callee = unwrap(current.childForFieldName("function"));
    const arguments_ = current.childForFieldName("arguments")?.namedChildren ?? [];
    const argument = arguments_[0] ?? null;
    if (callee?.type === "member_expression" || callee?.type === "subscript_expression") {
      const receiver = unwrap(callee.childForFieldName("object"));
      const property = callee.childForFieldName("property")?.text;
      if (receiver?.type === "identifier" && OWN_KEY_READERS.get(receiver.text)?.has(property)) {
        return provenanceOf(argument, bindings, seen);
      }
      if (receiver?.type === "identifier" && TEXT_PRODUCERS.has(`${receiver.text}.${property}`)) return NOT_A_MEMBERS;
      if (TEXT_PROJECTIONS.has(property)) return NOT_A_MEMBERS;
      if (COLLECTION_PROJECTIONS.has(property)) return provenanceOf(receiver, bindings, seen);
      const root = rootIdentifier(callee);
      if (root !== null && bindingAt(bindings, root.text, root) !== undefined) return TEST_BUILT;
      return provenanceOf(receiver, bindings, seen);
    }
    // An identifier callee: the file's own function is read through its return expressions; anything else is another
    // module's output.
    if (TEXT_PRODUCERS.has(callee?.text)) return NOT_A_MEMBERS;
    if (TEXT_FUNCTIONS.has(callee?.text)) return NOT_A_MEMBERS;
    const ownFunction = bindingAt(bindings, callee?.text, callee);
    if (isFunctionValue(ownFunction)) return returnVerdict(ownFunction, bindings, seen);
    // A product function called on a fixture is a function OF THAT FIXTURE: `runGate({ overrides })` over one injected
    // defect answers one finding because the test injected one, and no product edit can make that literal wrong. An
    // argument that NAMES a product declaration is not that: `readActionSurface(read(SOURCES.surface))` reads a
    // generated artifact's members, and their count is the artifact's.
    if (isFixtureInput(arguments_, bindings, seen)) return TEST_BUILT;
    return PRODUCT;
  }
  if (current.type === "string" || current.type === "template_string") return TEST_BUILT;
  if (current.type === "ternary_expression") {
    const branches = [current.childForFieldName("consequence"), current.childForFieldName("alternative")];
    const verdicts = branches.map((branch) => provenanceOf(branch, bindings, seen));
    if (verdicts.includes(PRODUCT)) return PRODUCT;
    return verdicts.includes(NOT_A_MEMBERS) ? NOT_A_MEMBERS : TEST_BUILT;
  }
  if (current.type === "binary_expression") {
    // `x ?? []` and `x || y` hand back one of their sides; `+` builds a string (or a number), never a set of members.
    const operator = operatorOf(current);
    if (operator !== "??" && operator !== "||" && operator !== "&&") return NOT_A_MEMBERS;
    const left = provenanceOf(current.childForFieldName("left"), bindings, seen);
    return left === TEST_BUILT ? TEST_BUILT : provenanceOf(current.childForFieldName("right"), bindings, seen);
  }
  if (current.type === "array" || current.type === "number" || current.type === "object") return TEST_BUILT;
  if (current.type === "new_expression") {
    const constructor = unwrap(current.childForFieldName("constructor"));
    return constructor?.type === "identifier" && bindingAt(bindings, constructor.text, constructor) === undefined
      ? TEST_BUILT
      : PRODUCT;
  }
  return PRODUCT;
}

/**
 * The three shapes a surviving site can have. This is the residual's vocabulary: the count of each is printed on every run
 * and recorded beside every baseline entry, so "89 sites" is a measurement with a size per shape rather than one number.
 *
 * `declaration_site` - the counted value is an import or a table this file declares at module level. Closes by deriving
 *                      the members from that declaration (`new Set(actual)` against it), which is what this gate's own
 *                      message prescribes.
 * `call_result`     - the counted value is a product function's output whose inputs name a product declaration (a
 *                      generated artifact's path, an imported table). Closes by asserting the returned members against
 *                      the declaration that fed the call - a reader that drops an entry then goes red naming it.
 * `unresolved`      - the walk could not attribute the value: a fixture handed in as a parameter, a member of a name
 *                      nothing here binds, or a shape this reading does not model. Closes by naming the fixture the
 *                      count belongs to, or by extending this reading to the shape.
 */
const DECLARATION_SITE = "declaration_site";
const CALL_RESULT = "call_result";
const UNRESOLVED = "unresolved";

/** Which residual shape a surviving site is, from the expression that produced the counted value. */
export function shapeOf(node, bindings) {
  let spine = unwrap(node);
  while (spine !== null && (spine.type === "member_expression" || spine.type === "subscript_expression")) {
    spine = unwrap(spine.childForFieldName("object"));
  }
  if (spine === null) return UNRESOLVED;
  if (spine.type === "call_expression") return CALL_RESULT;
  if (spine.type !== "identifier") return UNRESOLVED;
  const binding = bindingAt(bindings, spine.text, spine);
  if (binding === undefined) return UNRESOLVED;
  return binding.kind === "import" || binding.moduleLevel ? DECLARATION_SITE : UNRESOLVED;
}

function isLiteralCount(node) {
  return node?.type === "number" && /^\d[\d_]*$/u.test(node.text);
}

function isAssertObject(node) {
  if (node === null) return false;
  if (node.type === "identifier") return node.text === "assert";
  if (node.type === "member_expression") return node.childForFieldName("property")?.text === "assert";
  return false;
}

function operatorOf(node) {
  return node.children
    .filter((child) => !child.isNamed)
    .map((child) => child.text)
    .join("");
}

/**
 * One comparison whose expected side is a literal: `side` is the `.length` access and `literal` the number it
 * is compared with, in either order. Two `.length` sides are an authority comparison and say nothing here.
 */
function literalComparison([left, right], operator) {
  for (const [side, other] of [
    [lengthOf(left), right],
    [lengthOf(right), left],
  ]) {
    if (side === null || !isLiteralCount(other)) continue;
    return { ...side, literal: other.text, operator };
  }
  return null;
}

/**
 * The surfaces an assertion is spelled on: `node:assert`'s `assert`, called or through a method, and `node:test`'s test
 * context `t` (`t.ok`, `t.equal`). A comparison anywhere else is a predicate.
 */
const ASSERTION_RECEIVERS = new Set(["assert", "t"]);

/** Whether a call expression is one of those, so what it compares is an assertion and not a branch condition. */
function isAssertionCall(node) {
  if (node.type !== "call_expression") return false;
  const callee = node.childForFieldName("function");
  if (callee === null) return false;
  const receiver = callee.type === "member_expression" ? callee.childForFieldName("object") : callee;
  return receiver?.type === "identifier" && ASSERTION_RECEIVERS.has(receiver.text);
}

/** The literal comparison a node makes, if it is one: an assertion call, or a bare `===`/`==` inside one. */
function comparisonIn(node, asserting) {
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    if (callee?.type !== "member_expression") return null;
    const method = callee.childForFieldName("property")?.text;
    if (!ASSERTING_METHODS.has(method)) return null;
    if (!isAssertObject(callee.childForFieldName("object"))) return null;
    return literalComparison(node.childForFieldName("arguments")?.namedChildren ?? [], method);
  }
  if (node.type !== "binary_expression" || !asserting) return null;
  const operator = operatorOf(node);
  if (!COMPARING_OPERATORS.has(operator)) return null;
  return literalComparison([node.childForFieldName("left"), node.childForFieldName("right")], operator);
}

/**
 * Every literal comparison in a file, in source order.
 *
 * A bare `===`/`==` counts only INSIDE an assertion. `assert.ok(list.length === 15)` freezes a count, but
 * `lines.filter((line) => line.writers.length === 0)` decides WHICH members a later assertion reads - it is the
 * population's builder, not its frozen size, so it is the opposite of this class and the gate that flagged it was
 * cheaper to satisfy by writing `!line.writers.length` than by fixing anything. Measured on this tree: of the 30 bare
 * comparisons the unscoped reading found, 29 were predicates (a `filter`, an `if (x.length === 0) return`, a ternary)
 * and 1 was an assertion. A callback handed to an assertion is the code under test, so the scope stops where a body
 * begins.
 */
function literalComparisons(tree) {
  const found = [];
  const visit = (node, asserting) => {
    if (OPAQUE.has(node.type)) return;
    const comparison = comparisonIn(node, asserting);
    if (comparison !== null) found.push(comparison);
    const inner = asserting || isAssertionCall(node);
    for (const child of node.namedChildren) visit(child, inner && !entersBody(child));
  };
  visit(tree.rootNode, false);
  return found;
}

const messageOf = ({ file, line, literal, authority }) =>
  `literal_population_assertion:${file}:${line}:${literal} — use ${authority}.length or ` +
  `assert.deepEqual(new Set(actual), new Set(AUTHORITY))`;

const hintOf = ({ authority }) =>
  `name the drift instead of counting it: describeMemberDiff("${authority}", actual, AUTHORITY) reads ` +
  `"+ newly added: [...]" and "- missing: [...]" (tools/lib/member-diff.mjs)`;

/**
 * The node where the grammar stopped reading, which is what makes an unread file actionable: tree-sitter tends to place
 * its recovery `ERROR` node after the construct it could not accept, so the earliest one in source order is as close as
 * this reading can get to the declaration that broke it.
 */
function firstErrorNode(root) {
  let earliest = null;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "ERROR" || node.isMissing) {
      if (earliest === null || node.startIndex < earliest.startIndex) earliest = node;
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return earliest;
}

/**
 * The whole reading: every test file in the scope, parsed, and every comparison between a `.length` and a number literal
 * in it whose counted value the walk could not prove this file built. `examined` is the population, so a reading that
 * measured nothing is visible as `examined 0` rather than as a clean run; `unparsed` is a file the grammar could not
 * read, which is not the same as a file with no finding: it is named with the node that stopped the grammar and it fails
 * the run; `setAside` counts what the discrimination removed, so it is a measurement rather than a claim; each site
 * carries the residual `shape`.
 */
export async function auditDerivedPopulation({ root = REPOSITORY_ROOT, scope = POPULATION_SCOPE } = {}) {
  const files = populationFiles({ root, scope });
  const violations = [];
  const unparsed = [];
  const setAside = { [NOT_A_MEMBERS]: 0, [TEST_BUILT]: 0 };
  for (const path of files) {
    const file = path.slice(root.length + 1);
    const source = readFileSync(path, "utf8");
    let tree;
    try {
      tree = await parseJavaScript(source, path);
    } catch (error) {
      unparsed.push(`${file}: ${error.message}`);
      continue;
    }
    if (tree.rootNode.hasError) {
      const at = firstErrorNode(tree.rootNode);
      const line = at === null ? 0 : at.startPosition.row + 1;
      const column = at === null ? 0 : at.startPosition.column + 1;
      unparsed.push(`${file}:${line}:${column}: the grammar left an ERROR node, so its comparisons were not all read`);
      continue;
    }
    const bindings = fileBindings(tree);
    for (const found of literalComparisons(tree)) {
      const provenance = provenanceOf(found.object, bindings);
      if (provenance !== PRODUCT) {
        setAside[provenance] += 1;
        continue;
      }
      const entry = {
        file,
        line: found.node.startPosition.row + 1,
        literal: found.literal,
        authority: found.authority,
        operator: found.operator,
        shape: shapeOf(found.object, bindings),
      };
      violations.push({
        code: "literal_population_assertion",
        ...entry,
        message: messageOf(entry),
        hint: hintOf(entry),
      });
    }
  }
  violations.sort(byFileThenLine);
  return { examined: files.length, violations, unparsed, setAside };
}

/** Where the recorded residual lives, relative to the root the gate was pointed at. */
export const BASELINE_PATH = "tools/derived-population-baseline.json";

/** How many sites of each shape a set of sites holds, in a fixed key order so two readings print the same line. */
export function shapeCounts(sites) {
  const counts = { [DECLARATION_SITE]: 0, [CALL_RESULT]: 0, [UNRESOLVED]: 0 };
  for (const site of sites) counts[site.shape] += 1;
  return counts;
}

/**
 * The three verdicts a recorded site can carry, and the only ones: the enum the residual's `reason` opens with.
 *
 * `derivable-now`     an authority exists that both sides could read - the reason names the derivation.
 * `not-a-population`  there is no member set to name - a character count, a guard, a fixture the test seeded.
 * `needs-a-decision`  the two readings disagree about what the fact IS, so merging them is a decision, not a cleanup.
 */
export const RESIDUAL_BUCKETS = Object.freeze(["derivable-now", "not-a-population", "needs-a-decision"]);

/** The verdict a recorded site's reason opens with, or `null` when it states none this reading recognises. */
export function verdictOf(entry) {
  const match = /^\[([a-z-]+)\]/u.exec(typeof entry.reason === "string" ? entry.reason.trim() : "");
  return match !== null && RESIDUAL_BUCKETS.includes(match[1]) ? match[1] : null;
}

/** How many recorded sites of each verdict the baseline holds, so the residual is a measurement per kind. */
export function verdictCounts(baseline) {
  const counts = Object.fromEntries(RESIDUAL_BUCKETS.map((bucket) => [bucket, 0]));
  for (const entry of baseline?.sites ?? []) {
    const verdict = verdictOf(entry);
    if (verdict !== null) counts[verdict] += 1;
  }
  return counts;
}

/**
 * A site's identity, which is content and never position: the file, the expression that produced the value, and the
 * literal. A reflow that moves the assertion down forty lines is the same site; a third copy beside two others is not.
 */
const siteKey = (site) => `${site.file}\u0000${site.authority}\u0000${site.literal}`;

/**
 * The ratchet: a site the baseline does not record is new debt and fails; a recorded site that has more copies than
 * recorded has grown and fails; a recorded site the tree no longer has - or has fewer of - is stale and fails, because
 * the recorded residual can only shrink. That last rule is what makes this an expiring record instead of an accept list.
 */
export function compareWithBaseline({ violations, baseline }) {
  if (baseline === null) return { findings: violations, baselineSites: 0 };
  const findings = [];
  for (const entry of baseline.sites) {
    if (verdictOf(entry) !== null) continue;
    findings.push({
      code: "literal_population_baseline_unexplained",
      file: entry.file,
      line: 0,
      literal: entry.literal,
      authority: entry.authority,
      operator: "baseline",
      shape: entry.shape,
      message:
        `literal_population_baseline_unexplained:${entry.file}:${entry.literal} — \`${entry.authority}\` is recorded ` +
        "with no verdict, so the record cannot say whether it is debt or not one fact",
      hint:
        `open the entry's \`reason\` with one of ${RESIDUAL_BUCKETS.map((bucket) => `[${bucket}]`).join(", ")} ` +
        `in ${BASELINE_PATH}, and say why`,
    });
  }
  const current = new Map();
  for (const violation of violations) {
    const key = siteKey(violation);
    const bucket = current.get(key);
    if (bucket === undefined) current.set(key, { site: violation, sites: [violation] });
    else bucket.sites.push(violation);
  }
  const recorded = new Map();
  for (const entry of baseline.sites) recorded.set(siteKey(entry), entry);

  for (const [key, { site, sites }] of current) {
    const entry = recorded.get(key);
    if (entry === undefined) {
      findings.push(
        ...sites.map((each) => ({
          ...each,
          code: "literal_population_assertion",
          message: each.message ?? messageOf(each),
          hint: each.hint ?? hintOf(each),
        })),
      );
      continue;
    }
    if (sites.length > entry.sites) {
      const extra = sites.slice(entry.sites);
      findings.push({
        code: "literal_population_baseline_grew",
        ...site,
        sites: extra.length,
        message:
          `literal_population_baseline_grew:${site.file}:${site.line}:${site.literal} — ${site.authority} now has ` +
          `${sites.length} copies, the baseline recorded ${entry.sites}`,
        hint: hintOf(site),
      });
    }
  }

  for (const [key, entry] of recorded) {
    const bucket = current.get(key);
    const now = bucket?.sites.length ?? 0;
    // More copies than recorded is `..._grew` above and nothing else; fewer - including none - is the stale side.
    if (now >= entry.sites) continue;
    findings.push({
      code: "literal_population_baseline_stale",
      file: entry.file,
      line: 0,
      literal: entry.literal,
      authority: entry.authority,
      operator: "baseline",
      shape: entry.shape,
      message:
        `literal_population_baseline_stale:${entry.file}:${entry.literal} — the baseline recorded ${entry.sites} ` +
        `site(s) for \`${entry.authority}\`, the tree has ${now}`,
      hint: `lower or delete this entry in ${BASELINE_PATH}; the recorded residual may only shrink`,
    });
  }
  return { findings, baselineSites: baseline.sites.length };
}

/** The recorded residual, or `null` when this root has no baseline (a fixture tree, or a tree that owes one). */
export function readBaseline(root = REPOSITORY_ROOT) {
  const path = `${root}/${BASELINE_PATH}`;
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Source order: the file, then the line, so two runs over one tree print the same list. */
function byFileThenLine(left, right) {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  return left.line - right.line;
}

/** Per-file counts, which is how a debt of this size is handed to the lanes that own the files. */
export function byFile(violations) {
  const counts = new Map();
  for (const violation of violations) counts.set(violation.file, (counts.get(violation.file) ?? 0) + 1);
  return [...counts.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1));
}

/**
 * The verdict: a reading that examined nothing cannot pass, and neither can one that could not read a file it was there
 * to measure - an unread file is unmeasured, not a file with nothing wrong in it.
 */
function statusOf({ examined, findings, unparsed }) {
  if (examined === 0) return "blocked";
  if (findings.length > 0 || unparsed.length > 0) return "failed";
  return "passed";
}

const shapeLine = (counts) =>
  Object.entries(counts)
    .map(([shape, count]) => `${count} ${shape}`)
    .join(" · ");

function main(argv) {
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
  const json = argv.includes("--json");
  auditDerivedPopulation({ root })
    .then(({ examined, violations, unparsed, setAside }) => {
      const baseline = readBaseline(root);
      const { findings, baselineSites } = compareWithBaseline({ violations, baseline });
      const status = statusOf({ examined, findings, unparsed });
      const counts = shapeCounts(violations);
      const verdicts = verdictCounts(baseline);
      const reading = {
        gate: "derived-population",
        examined,
        sites: violations,
        shapes: counts,
        verdicts,
        baselineSites,
        setAside,
        findings,
        unparsed,
        status,
      };
      if (json) process.stdout.write(`${JSON.stringify(reading)}\n`);
      else {
        process.stdout.write(
          `derived_population examined ${examined} sites ${violations.length} findings ${findings.length} ` +
            `baseline ${baselineSites} unread ${unparsed.length} status ${status}\n`,
        );
        process.stdout.write(`  residual by shape: ${shapeLine(counts)}\n`);
        if (baseline !== null) process.stdout.write(`  residual by verdict: ${shapeLine(verdicts)}\n`);
        process.stdout.write(
          `  set aside: ${setAside[TEST_BUILT]} test-built · ${setAside[NOT_A_MEMBERS]} not-members\n`,
        );
        for (const [file, count] of byFile(findings)) process.stdout.write(`  ${file}: ${count}\n`);
        for (const entry of unparsed) process.stdout.write(`  unread ${entry}\n`);
        process.stdout.write(`${JSON.stringify(reading)}\n`);
      }
      for (const finding of findings) process.stderr.write(`${finding.message}\n  ${finding.hint}\n`);
      for (const line of unparsed) process.stderr.write(`derived_population_unparsed: ${line}\n`);
      if (examined === 0) {
        process.stderr.write(
          "derived_population: no test file was examined, so nothing can be judged; a green run reads examined>=1\n",
        );
      }
      process.exitCode = status === "passed" ? 0 : 1;
    })
    .catch((error) => {
      process.stderr.write(`derived_population: ${error.stack ?? error.message}\n`);
      process.exitCode = 1;
    });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2));
