#!/usr/bin/env node
/**
 * Attribution gate: an assertion in a journey spec that no test runs is a claim nothing grades.
 *
 * WHY (measured 2026-11-14, at cc941b4d)
 *
 * `tools/check-assertion-substance.mjs` grades every assertion inside a `test(` body - 4507 of them here. The
 * reader behind it (`tools/lib/journey-source.mjs`) slices a spec from each `test(` call to the next one, so
 * everything before the file's first `test(` is inside no slice at all: 127 `expect` calls in 50 of the 117
 * specs were graded by nothing. They are not all the same thing, and the difference is the whole gate:
 *
 *   INSIDE A HELPER A TEST REACHES - 127 of them at this commit, and not a defect. `stageCard`, `openDrawer`,
 *   `expectPresetReadout` and 38 more wait for a surface or assert a fixture precondition at the top of a
 *   journey, and the test that calls them fails if they fail. 10 of the 127 sit in a `page.route(...)` handler
 *   a reachable helper passes in, which runs when the application makes that request. Attributing these to a
 *   test would be wrong - many are setup, not the claim - so they are named here and left alone.
 *
 *   AT MODULE LEVEL, OR IN A `describe` BODY - runs before any test exists: once per worker at import, or
 *   while Playwright collects the file. Its failure is reported with no test name, and for the import-time
 *   case whether it runs at all depends on worker ordering. There are 0 in this tree, which is why this shape
 *   is a gate rather than a repair: the next one must not arrive quietly.
 *
 *   IN A FUNCTION NONE CALLS - dead code. The assertion, its message and the work around it are unreachable,
 *   and nothing says so. 0 in this tree; same reason for the gate.
 *
 * The distinction cannot be read from the text the substance gate parses, because "who calls this helper, and
 * is that caller a test?" is a question about the call graph. So this gate parses each spec with the
 * TypeScript grammar (`tools/lib/javascript-ast.mjs`) and answers it over the graph, while taking the
 * assertion vocabulary - `expect(...)`, `expect.poll(...)`, and the `node:assert` methods the spec imports -
 * from `tools/lib/journey-source.mjs`, so the two gates cannot disagree about what counts as an assertion.
 *
 * WHAT COUNTS AS REACHED. A function is reached when it is a callback of a runner registration (`test`, `it`,
 * `beforeAll`, `beforeEach`, `afterAll`, `afterEach`), or is called by name from a reached function, or is
 * handed a body by a reached call - as an argument callback (`page.route(pattern, handler)`) or as an
 * immediately-invoked literal. That last rule is what makes the ten `page.route` handlers reached, which a
 * plain name-call graph failed on. `describe` is NOT a registration: its body runs at collection time, so a
 * helper it calls and a `describe`-body assertion are reported as `assertion_runs_at_import` and not as clean.
 *
 * THE POPULATION is `journeySpecs({ root })` - the same commit-only set of mounted journeys the substance and
 * surface gates judge, so a new spec joins on its own and no list is maintained here. It is every assertion
 * call in every one of those specs; each one is classified, so `examined` here and the substance gate's
 * in-test count differ by exactly the assertions outside a test body, and that difference is the reading.
 *
 * THE THREE ZEROES. `examined 0` - no spec found, or no assertion call in any of them - is `blocked` and
 * exits 2, never a pass: a reading over zero journeys agrees with itself. A spec the grammar cannot parse is a
 * finding (`journey_not_parsed`) rather than a silent omission, because an assertion inside a recovery tree is
 * an assertion this gate did not read. Zero findings over a populated corpus is the healthy third answer, and
 * it prints the population it measured.
 *
 * WHAT IT CANNOT SEE, and this is a named residual rather than a guess: a helper reached only through a
 * computed member or a name built at runtime (`handlers[name]()`) is not reached by this graph. No assertion
 * in this tree is reached that way - every one of the 127 is named by a literal call or passed as a callback
 * argument - and when a function is reported unreached the finding says so if its name also appears as a
 * quoted string in the spec, so the reader sees the shape that would have fooled it.
 *
 * Usage:
 *   node tools/check-loose-assertions.mjs            # the gate; exit 1 on a finding, 2 when nothing was read
 *   node tools/check-loose-assertions.mjs --gaps     # every assertion that is not inside a test body
 *   node tools/check-loose-assertions.mjs --json     # the whole reading
 *   node tools/check-loose-assertions.mjs --root <dir>   # the gate's own fixture
 *
 * red-proof: inject  a module-level `expect(...)` added to a real mounted journey -> `assertion_runs_at_import`
 *                    naming that file:line, while the same journey's helper assertions stay green
 *                    (tools/check-loose-assertions.test.mjs, "an assertion at module level runs at import")
 * red-proof: inject  an `expect(...)` in a helper no test calls -> `assertion_in_an_unreached_function`
 *                    naming the helper, while the identical assertion in a called helper stays green
 *                    (tools/check-loose-assertions.test.mjs, "an assertion in a function no test reaches")
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseJavaScript } from "./lib/javascript-ast.mjs";
import { journeySpecs, nodeAssertBindings } from "./lib/journey-source.mjs";
import { assertNonVacuous } from "./lib/assert-non-vacuous.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * `test`, `it`, their modifiers, and the hooks: the calls whose callback runs because a test runs.
 *
 * `describe` is deliberately NOT here. A describe body executes while Playwright collects the file, before
 * any test exists, so an assertion there has no test name either - treating it as a test would be the exact
 * fail-open this gate exists to close. A `test(...)` nested inside a describe is still a registration in its
 * own right, so its body is seeded whether or not the describe is.
 */
const RUNNER_REGISTRATION =
  /^(?:(?:test|it)(?:\.(?:skip|only|fixme|fail|slow|concurrent|serial|parallel|use))*|beforeAll|beforeEach|afterAll|afterEach)$/u;

/** `describe` and `test.describe`: the calls whose callback runs at collection time, named in the finding. */
const COLLECTION_GROUP = /^(?:describe|test\.describe|test\.describe\.\w+)$/u;

/** The grammar's node types that hold a body a caller can reach. */
const FUNCTION_TYPES = new Set([
  "function_declaration",
  "function",
  "function_expression",
  "generator_function_declaration",
  "arrow_function",
  "method_definition",
]);

/** A callee written as a name or a member chain: what a call can be resolved to. */
const CALLEE_NAME = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/u;

/** The function literal inside `( ... )`, for a call whose callee is an immediately-invoked body. */
function unwrapParentheses(node) {
  return node?.type === "parenthesized_expression" ? (node.namedChildren[0] ?? node) : node;
}

/** The name a function is bound to, for a finding a reader can act on. */
function labelOf(node) {
  const named = node.childForFieldName("name");
  if (named !== null) return named.text;
  const parent = node.parent;
  if (parent?.type === "variable_declarator") return parent.childForFieldName("name")?.text ?? anonymous(node);
  if (parent?.type === "assignment_expression") return parent.childForFieldName("left")?.text ?? anonymous(node);
  return anonymous(node);
}

const anonymous = (node) => `(anonymous at line ${node.startPosition.row + 1})`;

/** The predicate "this call is an assertion", from the spec's own `node:assert` import. */
function assertionPredicate({ namespaces, methods }) {
  const asserted = new Set([...namespaces, ...methods]);
  return (callee) => {
    if (callee === "expect" || /^expect\.[A-Za-z]+$/u.test(callee)) return true;
    if (asserted.has(callee)) return true;
    const dot = callee.indexOf(".");
    return dot > 0 && namespaces.includes(callee.slice(0, dot));
  };
}

/**
 * Every function id reachable from the given roots, following a called name into every function bound to it
 * and a function value a live call hands a body to - an argument callback, or the literal it invokes.
 *
 * `moduleIsLive` decides whether top-level statements count as a caller, and `followRegistrationArguments`
 * decides whether a runner registration is a caller at all: in the import-time reading the registrations are
 * exactly what must NOT be followed, or every test body would make its helpers look import-reached.
 */
function reachableFunctions({ calls, byLabel, rootIds, moduleIsLive, followRegistrationArguments }) {
  const live = new Set(rootIds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const call of calls) {
      const callerLive = call.caller === null ? moduleIsLive : live.has(call.caller);
      if (!callerLive) continue;
      const registration = call.callee !== null && RUNNER_REGISTRATION.test(call.callee);
      if (registration && !followRegistrationArguments) continue;
      const targets = call.callee === null ? [] : (byLabel.get(call.callee) ?? []);
      for (const id of [...targets, ...call.invokedFunctions.map((fn) => fn.id)])
        if (!live.has(id)) {
          live.add(id);
          changed = true;
        }
    }
  }
  return live;
}

/** The callee a call names, or `null` when it is a computed member or a literal it invokes instead. */
function calleeOf(node) {
  const calleeNode = unwrapParentheses(node.childForFieldName("function"));
  const written = (calleeNode?.text ?? "").replace(/\s+/gu, "");
  return { calleeNode, callee: CALLEE_NAME.test(written) ? written : null };
}

/**
 * One call, read into the graph: an assertion under the function that encloses it, or an edge from that function
 * to the names it calls and the bodies it hands a live call.
 */
function readCall({
  node,
  spec,
  enclosing,
  isAssertion,
  assertions,
  calls,
  registrationCallbacks,
  collectionCallbacks,
}) {
  const { calleeNode, callee } = calleeOf(node);
  // The bodies this call runs: the callbacks it is handed, and the literal it immediately invokes.
  const invokedFunctions = [
    ...(node.childForFieldName("arguments")?.namedChildren ?? []),
    ...(calleeNode !== null && FUNCTION_TYPES.has(calleeNode.type) ? [calleeNode] : []),
  ].filter((child) => FUNCTION_TYPES.has(child.type));
  if (callee !== null && isAssertion(callee)) {
    assertions.push({
      file: spec.file,
      line: node.startPosition.row + 1,
      caller: enclosing,
      text: node.text.split("\n")[0].trim().slice(0, 120),
    });
    return;
  }
  calls.push({ caller: enclosing, callee, invokedFunctions });
  for (const fn of invokedFunctions) {
    if (callee !== null && RUNNER_REGISTRATION.test(callee)) registrationCallbacks.add(fn.id);
    if (callee !== null && COLLECTION_GROUP.test(callee)) collectionCallbacks.add(fn.id);
  }
}

/**
 * The whole reading: every assertion in every mounted journey, attributed to a test, to module-level code, or
 * to a function nothing reaches.
 */
export async function auditLooseAssertions({ root = REPOSITORY_ROOT } = {}) {
  const specs = journeySpecs({ root });
  const assertions = [];
  const findings = [];
  const unassessed = [];
  const byLabel = new Map();
  const calls = [];
  const registrationCallbacks = new Set();
  const collectionCallbacks = new Set();
  let parsed = 0;

  for (const spec of specs) {
    const tree = await parseJavaScript(spec.source, spec.file);
    if (tree.rootNode.hasError) {
      findings.push({
        code: "journey_not_parsed",
        file: spec.file,
        line: null,
        detail: "the TypeScript grammar produced a recovery tree, so any assertion inside it was not read",
      });
      tree.delete();
      continue;
    }
    parsed += 1;
    const isAssertion = assertionPredicate(nodeAssertBindings(spec.source));

    const walk = (node, enclosing) => {
      const ownsBody = FUNCTION_TYPES.has(node.type);
      if (ownsBody) {
        const label = labelOf(node);
        if (!byLabel.has(label)) byLabel.set(label, []);
        byLabel.get(label).push(node.id);
      }
      if (node.type === "call_expression")
        readCall({
          node,
          spec,
          enclosing,
          isAssertion,
          assertions,
          calls,
          registrationCallbacks,
          collectionCallbacks,
        });
      for (const child of node.namedChildren) walk(child, ownsBody ? node.id : enclosing);
    };
    walk(tree.rootNode, null);
    tree.delete();
  }

  const byTest = reachableFunctions({
    calls,
    byLabel,
    rootIds: [...registrationCallbacks],
    moduleIsLive: false,
    followRegistrationArguments: true,
  });
  const byImport = reachableFunctions({
    calls,
    byLabel,
    rootIds: [],
    moduleIsLive: true,
    followRegistrationArguments: false,
  });

  const names = new Map();
  for (const [label, ids] of byLabel) for (const id of ids) if (!names.has(id)) names.set(id, label);

  for (const assertion of assertions) {
    if (assertion.caller === null) {
      assertion.verdict = "runs_at_import";
      findings.push({
        code: "assertion_runs_at_import",
        file: assertion.file,
        line: assertion.line,
        detail:
          "an assertion outside every function runs once per worker before a test exists, and reports as a " +
          "file-level error with no test name; move it into the test that needs it, or make it a named " +
          '`test("the fixtures this file needs are valid", ...)`',
      });
      continue;
    }
    if (byTest.has(assertion.caller)) {
      assertion.verdict = registrationCallbacks.has(assertion.caller) ? "in_a_test" : "in_a_reachable_helper";
      continue;
    }
    const label = names.get(assertion.caller) ?? "(anonymous)";
    if (byImport.has(assertion.caller)) {
      assertion.verdict = "runs_at_import";
      findings.push({
        code: "assertion_runs_at_import",
        file: assertion.file,
        line: assertion.line,
        detail: collectionCallbacks.has(assertion.caller)
          ? "a `describe` body runs while Playwright collects the file, before any test exists, so this " +
            "assertion reports without a test name; move it into a test, or make it a named " +
            '`test("the fixtures this file needs are valid", ...)`'
          : `\`${label}\` is called from module-level code, not from a test, so this assertion also runs at import with no test name`,
      });
      continue;
    }
    assertion.verdict = "unreached";
    const source = specs.find((entry) => entry.file === assertion.file)?.source ?? "";
    const byName = label !== "(anonymous)" && new RegExp(`["'\`]${label}["'\`]`, "u").test(source);
    findings.push({
      code: "assertion_in_an_unreached_function",
      file: assertion.file,
      line: assertion.line,
      detail:
        `\`${label}\` is never called: dead code, and a claim nothing grades` +
        (byName
          ? "; its name also appears as a quoted string, so it may be reached by name - make that call explicit"
          : ""),
    });
  }

  if (specs.length === 0)
    unassessed.push("unassessed: dialogue-web/tests - no mounted journey found, so no assertion could be attributed");
  return { specs: specs.length, parsed, examined: assertions.length, assertions, findings, unassessed };
}

/** The verdict counts, so a report says where the 127 went instead of only how many findings there are. */
function summarise({ assertions }) {
  const count = (verdict) => assertions.filter((assertion) => assertion.verdict === verdict).length;
  return {
    in_a_test: count("in_a_test"),
    in_a_reachable_helper: count("in_a_reachable_helper"),
    runs_at_import: count("runs_at_import"),
    unreached: count("unreached"),
  };
}

function report({ reading, gaps }) {
  const counts = summarise(reading);
  process.stdout.write(
    `loose_assertions specs=${reading.specs} parsed=${reading.parsed} examined=${reading.examined} ` +
      `in_a_test=${counts.in_a_test} in_a_reachable_helper=${counts.in_a_reachable_helper} ` +
      `runs_at_import=${counts.runs_at_import} unreached=${counts.unreached}\n`,
  );
  for (const line of reading.unassessed) process.stdout.write(`  ${line}\n`);
  if (gaps)
    for (const assertion of reading.assertions)
      if (assertion.verdict !== "in_a_test")
        process.stdout.write(`  gap:${assertion.file}:${assertion.line} [${assertion.verdict}] ${assertion.text}\n`);
  for (const finding of reading.findings)
    process.stderr.write(
      `loose_assertion_${finding.code}:${finding.file}${finding.line === null ? "" : `:${finding.line}`}: ${finding.detail}\n`,
    );
  if (reading.findings.length > 0)
    process.stderr.write(
      "  fix: an assertion nothing runs is a claim nothing grades. Move it into the test that needs it,\n" +
        '       name it with `test("...", ...)`, or delete it with the code path it was protecting.\n',
    );
}

async function main(argv) {
  const rootIndex = argv.indexOf("--root");
  const root =
    rootIndex >= 0 && typeof argv[rootIndex + 1] === "string" ? resolve(argv[rootIndex + 1]) : REPOSITORY_ROOT;
  const reading = await auditLooseAssertions({ root });
  const counts = summarise(reading);

  const json = {
    gate: "loose_assertions/v1",
    status: reading.findings.length === 0 ? "passed" : "failed",
    examined: reading.examined,
    specs: reading.specs,
    parsed: reading.parsed,
    counts,
    checks: [
      { id: "assertion_runs_at_import", status: counts.runs_at_import === 0 ? "passed" : "failed" },
      { id: "assertion_in_an_unreached_function", status: counts.unreached === 0 ? "passed" : "failed" },
      {
        id: "journey_not_parsed",
        status: reading.findings.some((finding) => finding.code === "journey_not_parsed") ? "failed" : "passed",
      },
    ],
    findings: reading.findings,
  };

  // A reading over zero journeys, or over zero assertions, agrees with itself. That judgement is the shared one
  // (`tools/lib/assert-non-vacuous.mjs`), so this gate's empty run is read by the same rule the conformance suite
  // applies to the report it prints - not by a second opinion written here.
  if (assertNonVacuous(json)?.status === "blocked") {
    const why =
      reading.specs === 0
        ? `no \`.spec.ts\` under ${join(root, "dialogue-web", "tests")}, so no assertion could be attributed`
        : `${reading.specs} journey(s) read, but none of them makes an assertion call`;
    for (const check of json.checks) check.status = "blocked";
    json.status = "blocked";
    process.stdout.write(`blocked: ${why}\n`);
    process.stdout.write(`${JSON.stringify(json)}\n`);
    process.stderr.write(`loose_assertion_gate_blocked:no_assertion_examined: examined 0 assertions - ${why}\n`);
    return 2;
  }

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    return reading.findings.length === 0 ? 0 : 1;
  }
  report({ reading, gaps: argv.includes("--gaps") });
  process.stdout.write(`${JSON.stringify(json)}\n`);
  return reading.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await main(process.argv.slice(2));
