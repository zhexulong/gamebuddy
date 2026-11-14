#!/usr/bin/env node
/**
 * What an assertion hook may be, checked over the whole directory instead of one file.
 *
 * WHY. `tools/run-native-action-slice.mjs` runs a contract's hook at the END of a live run, after the game has
 * already been mutated. A hook that imports a module can fail to resolve inside that run; one that is `async`
 * hands the engine a promise where a list of failures belongs; one that takes two parameters is called with a
 * single object and silently receives `undefined` for the second; one that returns something other than a list
 * reports nothing at all, which reads exactly like a pass. None of those is visible by reading one hook, and each
 * is a defect of the CLASS rather than of a file - so the population is the directory and a hook added tomorrow is
 * measured by existing.
 *
 * WHAT IT CHECKS, per file in `tools/assertions/` (`*.test.mjs` is that hook's own falsifier suite, not a hook, and
 * the exclusion is printed rather than assumed):
 *   - it imports nothing, statically or dynamically      `assertion_hook_imports:<file>:<specifier>`
 *   - no exported function is `async` and nothing awaits  `assertion_hook_is_async:<file>`
 *   - every exported function takes exactly one parameter `assertion_hook_parameters:<file>:<n>`
 *   - it exports exactly one function                     `assertion_hook_functions:<file>:<n>`
 *   - it exports `asserts`, a non-empty clause list       `assertion_hook_asserts:<file>`
 *   - called with an empty world it returns a LIST       `assertion_hook_returns:<file>`
 *   - and it does not throw on that input                 `assertion_hook_throws:<file>`
 *   - the file parses                                     `assertion_hook_unparsed:<file>`
 *
 * The last two are the same discipline every hand-written runner in this tree already carries: "I could not look"
 * must never read as "there was nothing to find", so a hook handed a world with no pond returns a named failure
 * rather than an empty list or a crash.
 *
 * ZERO POPULATION IS BLOCKED, not green: a directory that read nothing is not a directory whose hooks are sound.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseJavaScript } from "./lib/javascript-ast.mjs";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
export const ASSERTION_DIRECTORY = resolve(ROOT, "tools/assertions");
const TEST_SUFFIX = ".test.mjs";
/** The one input the structure of a hook is measured with: a world it cannot know anything about. */
const PROBE_INPUT = Object.freeze({ before: Object.freeze({}), after: Object.freeze({}), evidence: new Map() });

/** A finding, named by the rule it broke and the file it broke it in, with the reason a reader needs. */
function finding(name, file, why = null, suffix = "") {
  return Object.freeze({ name, file, label: `${name}:${file}${suffix}`, why });
}

/** Every function an `export` statement binds, in source order. Re-exports (`export { x }`) bind none here. */
function exportedFunctions(root) {
  const found = [];
  for (const statement of root.namedChildren) {
    if (statement.type !== "export_statement") continue;
    const declaration = statement.childForFieldName("declaration") ?? null;
    if (declaration === null) continue;
    if (declaration.type === "function_declaration") {
      found.push({ name: declaration.childForFieldName("name")?.text ?? null, node: declaration });
      continue;
    }
    if (declaration.type !== "lexical_declaration") continue;
    for (const declarator of declaration.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const value = declarator.childForFieldName("value");
      if (value?.type !== "arrow_function" && value?.type !== "function_expression") continue;
      found.push({ name: declarator.childForFieldName("name")?.text ?? null, node: value });
    }
  }
  return found;
}

/** The module specifiers one hook asks for, static and dynamic, as written. */
function importsOf(root) {
  const specifiers = [];
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "import_statement") {
      const source = node.namedChildren.find((child) => child.type === "string");
      specifiers.push(source === undefined ? node.text.split(/\s/u).slice(0, 2).join(" ") : unquote(source.text));
      continue;
    }
    if (node.type === "call_expression" && node.childForFieldName("function")?.text === "import")
      specifiers.push("import()");
    for (const child of node.namedChildren) stack.push(child);
  }
  return specifiers;
}

function unquote(text) {
  return text.replace(/^["'`]/u, "").replace(/["'`]$/u, "");
}

function awaitsSomething(root) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "await_expression") return true;
    for (const child of node.namedChildren) stack.push(child);
  }
  return false;
}

/** One hook file, against every rule above. Structural rules read the tree; the rest call the hook for real. */
async function inspectHook(path, file) {
  const findings = [];
  const tree = await parseJavaScript(readFileSync(path, "utf8"), file);
  const root = tree.rootNode;
  if (root.hasError) {
    findings.push(finding("assertion_hook_unparsed", file, "the file does not parse as this tree's grammar does"));
    return findings;
  }
  for (const specifier of importsOf(root))
    findings.push(
      finding("assertion_hook_imports", file, `it imports ${specifier}; a live hook imports nothing`, `:${specifier}`),
    );
  const functions = exportedFunctions(root);
  if (functions.length !== 1)
    findings.push(
      finding(
        "assertion_hook_functions",
        file,
        `it exports ${functions.length} functions; the engine calls the one, so a second is a hook it cannot reach`,
        `:${functions.length}`,
      ),
    );
  const asynchronous = functions.filter((entry) => entry.node.children.some((child) => child.type === "async"));
  // `async` is an anonymous token on the function node rather than a named field, and an `await` ANYWHERE in the
  // file - top level included - means a live run's engine is handed a promise whatever the declaration says.
  if (asynchronous.length > 0 || awaitsSomething(root))
    findings.push(
      finding(
        "assertion_hook_is_async",
        file,
        asynchronous.length > 0
          ? `${asynchronous.map((entry) => entry.name ?? "(anonymous)").join(",")} is async; the engine reads a returned list`
          : `the file awaits; a hook that resolves a promise returns one where a list of failures belongs`,
      ),
    );
  for (const entry of functions) {
    const name = entry.name ?? "(anonymous)";
    const parameters = entry.node.childForFieldName("parameters")?.namedChildren.length ?? 0;
    if (parameters !== 1)
      findings.push(
        finding(
          "assertion_hook_parameters",
          file,
          `${name} takes ${parameters} parameters; the engine passes one object`,
          `:${parameters}`,
        ),
      );
  }
  const module = await import(pathToFileURL(path).href);
  const asserted = module.asserts;
  if (!Array.isArray(asserted) || asserted.length === 0 || asserted.some((clause) => typeof clause !== "string"))
    findings.push(
      finding(
        "assertion_hook_asserts",
        file,
        "it exports no non-empty `asserts` list, so the coverage gate cannot count the clause it answers",
      ),
    );
  const exported = Object.entries(module).filter(([, value]) => typeof value === "function");
  for (const [name, run] of exported) {
    let result;
    try {
      result = run(PROBE_INPUT);
    } catch (error) {
      findings.push(
        finding("assertion_hook_throws", file, `${name} threw on an empty world: ${String(error?.message ?? error)}`),
      );
      continue;
    }
    if (!Array.isArray(result))
      findings.push(
        finding(
          "assertion_hook_returns",
          file,
          `${name} answered ${result === null ? "null" : typeof result} instead of a list of failures`,
        ),
      );
  }
  return findings;
}

/**
 * Every hook in `directory`, measured. The reading names its own population (`examined`, `testFiles`), because
 * "0 findings" over "0 hooks" is a reading that agrees with itself.
 */
export async function checkAssertionHooks({ directory = ASSERTION_DIRECTORY } = {}) {
  const entries = readdirSync(directory).sort();
  const files = entries.filter((name) => name.endsWith(".mjs") && !name.endsWith(TEST_SUFFIX));
  const testFiles = entries.filter((name) => name.endsWith(TEST_SUFFIX));
  const findings = [];
  for (const file of files) findings.push(...(await inspectHook(join(directory, file), file)));
  return Object.freeze({
    directory,
    examined: files.length,
    files: Object.freeze(files),
    testFiles: Object.freeze(testFiles),
    findings: Object.freeze(findings),
    labels: Object.freeze(findings.map((entry) => entry.label)),
  });
}

/** The corpus guard: a directory that read nothing is blocked with its reason, and so is any finding. */
export function assertAssertionHooks(reading) {
  if (reading.examined === 0)
    throw new Error(
      `assertion_hooks_examined_nothing:${reading.directory}: a directory that read no hook is not a directory whose hooks are sound`,
    );
  if (reading.findings.length > 0)
    throw new Error(`assertion_hook_findings:${reading.findings.map((entry) => entry.label).join(" ")}`);
  return reading;
}

export async function main(argv = []) {
  const directory = argv[0] === "--directory" ? argv[1] : ASSERTION_DIRECTORY;
  const reading = await checkAssertionHooks({ directory });
  for (const entry of reading.findings)
    process.stderr.write(`${entry.label}${entry.why === null ? "" : ` - ${entry.why}`}\n`);
  process.stdout.write(
    `hooks examined ${reading.examined} · test files ${reading.testFiles.length} · findings ${reading.findings.length}\n`,
  );
  try {
    assertAssertionHooks(reading);
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main(process.argv.slice(2));
