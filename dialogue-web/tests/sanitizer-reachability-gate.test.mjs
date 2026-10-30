/**
 * The sanitisation two DOMPurify advisories need is not the sanitisation we run.
 *
 * GHSA-cg2g-xh64-v4q7 (critical, 3.4.4 - 3.4.16): `SAFE_FOR_TEMPLATES` splits `{{…}}`,
 * `${…}` and `<%…%>` into separate text nodes before the walk, and the merge-and-rescrub
 * pass that puts them back never descends into a shadow root. A call that opts into
 * `SAFE_FOR_TEMPLATES` *and* returns DOM (`RETURN_DOM`, `RETURN_DOM_FRAGMENT`, `IN_PLACE`)
 * can therefore hand back a live template expression - provided something downstream
 * evaluates it.
 *
 * GHSA-mrv2-3pqr-j5jr (high): in `IN_PLACE` mode, a hook that removes a parent or a
 * sibling (not the node itself) leaves that detached subtree's event handlers armed, so an
 * `<img onerror>` that was already loading fires after `sanitize()` has returned.
 *
 * Both are opt-in shapes, and this product is not in either:
 *
 *   config shape   `MarkdownMessage` passes a deny-by-default allowlist and nothing else.
 *                  No `SAFE_FOR_TEMPLATES`, no DOM-returning mode, and its one hook only
 *                  calls `setAttribute` - it removes nothing at all.
 *   input shape    the sanitizer is handed the Markdown parse's `string` and hands back a
 *                  `string`. Nothing in this product ever passes a DOM node in, so there is
 *                  no shadow root for a rescrub pass to fail to descend into.
 *   output consumer the sanitised string is rendered through React's
 *                  `dangerouslySetInnerHTML`, which is an `innerHTML` assignment: the
 *                  browser *parses* it. No template engine, no `new Function`, no `eval`.
 *                  A `{{name}}` left in a paragraph would be three characters of text.
 *
 * The output consumer is the link that decides whether the critical advisory is live or
 * theoretical here, and it is invisible from the sanitizer call itself - which is why this
 * is a gate and not a comment beside `sanitize()`. Both facts are properties of a *pair*:
 * someone can add `SAFE_FOR_TEMPLATES: true` and a `{{…}}` survives, and that is still
 * inert until the second half - a template engine downstream - is turned on too. A comment
 * rots, moves, and asserts nothing; these tests fail by name when either half changes.
 *
 * Population, deliberately derived: every tracked source file in this repository that
 * really imports `dompurify`. A new call site anywhere is judged the day it lands, and a
 * module that imports the sanitizer in a shape this file cannot read is a finding rather
 * than a skip - a gate that silently narrows its population is a gate that has stopped
 * working.
 *
 * The dependency side is not re-asserted here: `manifest-boundary.test.mjs` already pins the
 * renderer's runtime dependency list to exactly five packages, so a template engine added as
 * a dependency fails there. What this file pins is the *sink*, which is the half a dependency
 * list cannot see.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

/** The package whose two advisories this file is about. */
const SANITIZER_PACKAGE = "dompurify";

/** `SAFE_FOR_TEMPLATES` is what splits a template expression across text nodes. */
const TEMPLATE_SPLITTER = "SAFE_FOR_TEMPLATES";

/** Returning DOM is what preserves a shadow root the rescrub pass never visits. */
const DOM_RETURNING_MODES = ["RETURN_DOM", "RETURN_DOM_FRAGMENT", "IN_PLACE"];

/**
 * Calls that detach markup *inside* the sanitised tree. The advisory's boundary is exact: it
 * needs a hook that removes something other than the node itself.
 */
const DETACHING_CALLS = new Set(["removeChild", "replaceChild", "replaceWith"]);

/** Sources whose extension makes them parseable TypeScript/JavaScript. */
const SOURCE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/u;

function scriptKindOf(fileName) {
  if (fileName.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (fileName.endsWith(".jsx")) return ts.ScriptKind.JSX;
  if (/\.(?:js|mjs|cjs)$/u.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function parse(text, fileName) {
  return ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKindOf(fileName));
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, (child) => walk(child, visit));
}

/** Repo-relative `file:line`, so a finding is a route. */
function at(node, sourceFile) {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return `${sourceFile.fileName.replace(/\\/gu, "/")}:${line + 1}`;
}

/** An object member's key as written, without quotes. */
function keyName(property, sourceFile) {
  const name = property.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return name.getText(sourceFile);
}

/** The nearest function-like ancestor: where a sanitize call's own types live. */
function enclosingFunction(node) {
  for (let current = node.parent; current !== undefined; current = current.parent) {
    if (ts.isFunctionDeclaration(current) || ts.isFunctionExpression(current) || ts.isArrowFunction(current))
      return current;
  }
  return null;
}

/**
 * Everything this file needs from one module: the local names bound to the sanitizer, and
 * its `sanitize`/`addHook` calls. `null` when the module does not import the package at all.
 */
export function readSanitizerModule(text, fileName) {
  const sourceFile = parse(text, fileName);
  const bindings = new Set();
  walk(sourceFile, (node) => {
    if (!ts.isImportDeclaration(node)) return;
    if (!ts.isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== SANITIZER_PACKAGE) return;
    const clause = node.importClause;
    if (clause === undefined) return;
    if (clause.name !== undefined) bindings.add(clause.name.text);
    const named = clause.namedBindings;
    if (named !== undefined && ts.isNamedImports(named))
      for (const element of named.elements) bindings.add(element.name.text);
  });
  if (bindings.size === 0) return null;

  const sanitizeCalls = [];
  const hookCalls = [];
  walk(sourceFile, (node) => {
    if (!ts.isCallExpression(node)) return;
    const callee = node.expression;
    // `DOMPurify.sanitize(…)` and `sanitize(…)` are the same call; a named import is how a
    // module binds the function directly.
    if (ts.isIdentifier(callee) && bindings.has(callee.text)) {
      if (callee.text === "sanitize") sanitizeCalls.push(node);
      else if (callee.text === "addHook") hookCalls.push(node);
      return;
    }
    if (!ts.isPropertyAccessExpression(callee) || !ts.isIdentifier(callee.expression)) return;
    if (!bindings.has(callee.expression.text)) return;
    if (callee.name.text === "sanitize") sanitizeCalls.push(node);
    else if (callee.name.text === "addHook") hookCalls.push(node);
  });
  return { sourceFile, bindings, sanitizeCalls, hookCalls };
}

/**
 * The sanitize() options as the object literal they resolve to. A module-level constant is
 * the honest spelling of a shared config, so a bare identifier is followed to its one
 * `const X = { … }` declaration. Anything else - a spread, a computed member, a second
 * declaration of the same name, a value built elsewhere - cannot be proven to lack two keys,
 * so it is returned as an error and reported rather than skipped.
 */
function resolveOptions(node, sourceFile) {
  if (ts.isObjectLiteralExpression(node)) return { object: node };
  if (!ts.isIdentifier(node)) return { error: "is neither an inline object literal nor a config constant" };

  const declarations = [];
  walk(sourceFile, (candidate) => {
    if (!ts.isVariableDeclaration(candidate) || !ts.isIdentifier(candidate.name)) return;
    if (candidate.name.text !== node.text) return;
    declarations.push(candidate);
  });
  if (declarations.length !== 1)
    return {
      error:
        declarations.length === 0
          ? `names ${node.text}, which has no declaration in this file`
          : `names ${node.text}, which is declared ${declarations.length} times in this file`,
    };
  const initializer = declarations[0].initializer;
  if (initializer === undefined || !ts.isObjectLiteralExpression(initializer))
    return { error: `names ${node.text}, whose initializer is not an object literal` };
  return { object: initializer };
}

/**
 * The config each call passes, read as structure. A call whose options cannot be resolved to
 * an object literal is reported rather than guessed at: the whole point of the assertion is
 * the absence of two keys, and a spread could put them back.
 */
export function sanitizerConfigFindings(text, fileName) {
  const module = readSanitizerModule(text, fileName);
  if (module === null) return [];
  const { sourceFile } = module;
  if (module.sanitizeCalls.length === 0)
    return [`${fileName} imports ${SANITIZER_PACKAGE} but calls no sanitize(); the gate cannot read a call it cannot see`];

  const findings = [];
  for (const call of module.sanitizeCalls) {
    const options = call.arguments[1];
    if (options === undefined) {
      findings.push(`${at(call, sourceFile)} sanitize() passes no options; the allowlist is not in the source`);
      continue;
    }
    const resolved = resolveOptions(options, sourceFile);
    if (resolved.error !== undefined) {
      findings.push(
        `${at(options, sourceFile)} sanitize() options ${resolved.error}; ` +
          `the gate cannot prove ${TEMPLATE_SPLITTER} and the DOM-returning modes are off`,
      );
      continue;
    }
    for (const property of resolved.object.properties) {
      if (!ts.isPropertyAssignment(property)) {
        findings.push(
          `${at(property, sourceFile)} sanitize() options hold a spread or computed member; the gate cannot read it`,
        );
        continue;
      }
      const name = keyName(property, sourceFile);
      const value = property.initializer.getText(sourceFile);
      // `false` is the off position and is a shape the advisories cannot reach through.
      if (value === "false") continue;
      if (name === TEMPLATE_SPLITTER)
        findings.push(
          `${at(property, sourceFile)} ${TEMPLATE_SPLITTER}: ${value} splits \`{{…}}\`/\`\${…}\`/\`<%…%>\` ` +
            `across text nodes and the rescrub pass does not descend into a shadow root (GHSA-cg2g-xh64-v4q7)`,
        );
      else if (DOM_RETURNING_MODES.includes(name))
        findings.push(
          `${at(property, sourceFile)} ${name}: ${value} returns DOM, which is what carries a shadow root past ` +
            `the sanitizer (GHSA-cg2g-xh64-v4q7; GHSA-mrv2-3pqr-j5jr in IN_PLACE mode)`,
        );
    }
  }
  return findings;
}

/**
 * Whether a hook detaches a node other than itself. `node.remove()` on the hook's own node
 * is allowed - the advisory is about a *parent or sibling* whose subtree keeps its handlers.
 */
export function sanitizerHookFindings(text, fileName) {
  const module = readSanitizerModule(text, fileName);
  if (module === null) return [];
  const { sourceFile } = module;
  const findings = [];
  for (const hook of module.hookCalls) {
    const callback = hook.arguments[1];
    if (callback === undefined) continue;
    const self = new Set();
    if (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))
      for (const parameter of callback.parameters) self.add(parameter.name.getText(sourceFile));

    walk(callback, (node) => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const name = node.expression.name.text;
      const receiver = node.expression.expression;
      if (name === "remove") {
        const isSelf = ts.isIdentifier(receiver) && self.has(receiver.text);
        if (!isSelf)
          findings.push(
            `${at(node, sourceFile)} a hook calls .remove() on something that is not its own node; ` +
              `the detached subtree keeps its event handlers armed (GHSA-mrv2-3pqr-j5jr)`,
          );
        return;
      }
      if (DETACHING_CALLS.has(name))
        findings.push(
          `${at(node, sourceFile)} a hook calls .${name}() on the sanitised tree; ` +
            `a subtree a hook detaches keeps its event handlers armed (GHSA-mrv2-3pqr-j5jr)`,
        );
    });
  }
  return findings;
}

/**
 * The sanitizer's own boundary: `string` in, `string` out. A node accepted here is the shape
 * both advisories need, and a node returned here is what carries a shadow root.
 */
export function sanitizerSignatureFindings(text, fileName) {
  const module = readSanitizerModule(text, fileName);
  if (module === null) return [];
  const { sourceFile } = module;
  const findings = [];
  for (const call of module.sanitizeCalls) {
    const owner = enclosingFunction(call);
    if (owner === null) {
      findings.push(`${at(call, sourceFile)} sanitize() sits outside any function; the gate cannot read the input's type`);
      continue;
    }
    const name = owner.name?.getText(sourceFile) ?? "(anonymous)";
    for (const parameter of owner.parameters) {
      const type = parameter.type?.getText(sourceFile) ?? "untyped";
      if (type !== "string")
        findings.push(
          `${at(parameter, sourceFile)} ${name} takes \`${type}\`; a DOM node can carry a shadow root into the ` +
            `sanitizer (GHSA-cg2g-xh64-v4q7) - the entry point must take a string`,
        );
    }
    const returns = owner.type?.getText(sourceFile) ?? "untyped";
    if (returns !== "string")
      findings.push(
        `${at(owner, sourceFile)} ${name} returns \`${returns}\`; sanitised output must be a string, ` +
          `not DOM the consumer could evaluate`,
      );
  }
  return findings;
}

/** True when any identifier in the subtree is one of `names`. */
function referencesAny(node, names) {
  let found = false;
  walk(node, (child) => {
    if (found) return;
    if (ts.isIdentifier(child) && names.has(child.text)) found = true;
  });
  return found;
}

/**
 * What eats the sanitised string. `dangerouslySetInnerHTML` is an `innerHTML` assignment -
 * a DOM parse - so a surviving `{{…}}` is inert text. A template engine, `new Function` or
 * `eval` downstream is the half that would make the critical advisory live.
 */
export function sanitizerConsumerFindings(text, fileName) {
  const module = readSanitizerModule(text, fileName);
  if (module === null) return [];
  const { sourceFile } = module;
  const findings = [];

  walk(sourceFile, (node) => {
    if (ts.isNewExpression(node) && /Function$/u.test(node.expression.getText(sourceFile)))
      findings.push(`${at(node, sourceFile)} the sanitizer's module builds code at runtime (new Function)`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : "";
      if (name === "eval") findings.push(`${at(node, sourceFile)} the sanitizer's module evaluates code at runtime (eval)`);
      if (name === "write" || name === "writeln") {
        const receiver = ts.isPropertyAccessExpression(callee) ? callee.expression.getText(sourceFile) : "";
        if (receiver === "document")
          findings.push(`${at(node, sourceFile)} the sanitizer's module writes into the document (document.${name})`);
      }
    }
  });

  // The values that carry sanitised HTML: the functions that call the sanitizer, and every
  // variable initialised from one of them (a memo, a helper chain, a rename).
  const produced = new Set();
  for (const call of module.sanitizeCalls) {
    const owner = enclosingFunction(call);
    if (owner?.name !== undefined) produced.add(owner.name.getText(sourceFile));
  }
  walk(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return;
    if (!ts.isIdentifier(node.name) || !referencesAny(node.initializer, produced)) return;
    produced.add(node.name.text);
  });

  let sinks = 0;
  walk(sourceFile, (node) => {
    if (!ts.isJsxAttribute(node) || node.name.getText(sourceFile) !== "dangerouslySetInnerHTML") return;
    if (node.initializer !== undefined && referencesAny(node.initializer, produced)) sinks += 1;
  });
  if (sinks === 0)
    findings.push(
      `${fileName} renders no \`dangerouslySetInnerHTML\` from the sanitised value; the output consumer is no longer ` +
        `provably a DOM parse - if a template engine now evaluates it, ${TEMPLATE_SPLITTER} becomes live ` +
        `(GHSA-cg2g-xh64-v4q7)`,
    );

  return findings;
}

/**
 * Every tracked source file. Tracked, not untracked: several lanes share one checkout, and a
 * gate that reddens on a neighbour's half-written file is a gate that gets bypassed. A new call
 * site is committed before CI sees it, so nothing escapes - and `sanitizer.1` fails loudly if the
 * population ever collapses to zero, which is the way this scan could quietly stop watching.
 */
const TRACKED_SOURCES = (() => {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached"], {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  return listed.split("\0").filter((path) => path.length > 0 && SOURCE_EXTENSION.test(path));
})();

/**
 * Every module in `paths` that really imports the sanitizer, with its source text. `paths` is
 * a parameter so `sanitizer.6` can drive the derivation with a list it controls: a scan that
 * silently matched nothing and one that matched everything are both proved to be reported.
 */
export function sanitizerModules(paths = TRACKED_SOURCES) {
  const modules = [];
  for (const relative of paths) {
    const text = readFileSync(join(REPO, relative), "utf8");
    if (!text.includes(SANITIZER_PACKAGE)) continue;
    if (readSanitizerModule(text, relative) === null) continue;
    modules.push({ relative, text });
  }
  return modules;
}

const MODULES = sanitizerModules();

/** One assertion's findings across the whole population. */
function findingsOf(analyze) {
  return MODULES.flatMap(({ relative, text }) => analyze(text, relative));
}

test("sanitizer.1: the population is every tracked module that really imports the sanitizer, and it is not empty", (t) => {
  assert.ok(
    MODULES.length > 0,
    `no module imports ${SANITIZER_PACKAGE}; the population is empty because the scan broke, not because the product stopped sanitising`,
  );
  const summaries = MODULES.map(({ text, relative }) => {
    const module = readSanitizerModule(text, relative);
    return `${relative} (${module.sanitizeCalls.length} sanitize(), ${module.hookCalls.length} addHook())`;
  });
  assert.deepEqual(
    MODULES.filter(({ text, relative }) => readSanitizerModule(text, relative).sanitizeCalls.length === 0).map(({ relative }) => relative),
    [],
    "a module importing the sanitizer must expose a readable sanitize call",
  );
  // The derivation is a name match on one package, so it is proved in both directions: a list
  // with no importer yields nothing, a file that merely names the package in a string is not an
  // importer, and the real renderer is found. An empty population above can therefore only mean
  // the scan changed, which is exactly what must be loud.
  assert.deepEqual(sanitizerModules([]), [], "an empty path list derives no module; the population comes from the files");
  assert.deepEqual(
    sanitizerModules(["dialogue-web/tests/sanitizer-reachability-gate.test.mjs"]),
    [],
    "a file that names the package in a string literal does not import it",
  );
  assert.deepEqual(
    sanitizerModules(["dialogue-web/src/components/MarkdownMessage.tsx"]).map(({ relative }) => relative),
    ["dialogue-web/src/components/MarkdownMessage.tsx"],
    "the renderer is derived from the files, not from a list in this test",
  );
  t.diagnostic(`sanitizer.1: ${summaries.length} sanitizer module(s): ${summaries.join(", ")}`);
});

test("sanitizer.2: no call opts into SAFE_FOR_TEMPLATES or a DOM-returning mode", (t) => {
  const findings = findingsOf(sanitizerConfigFindings);
  t.diagnostic(`sanitizer.2: ${findings.length} reachable config shape(s)`);
  assert.deepEqual(findings, [], "both advisories need an option this product does not pass");
});

test("sanitizer.3: no hook detaches a parent or a sibling inside the sanitised tree", (t) => {
  const findings = findingsOf(sanitizerHookFindings);
  t.diagnostic(`sanitizer.3: ${findings.length} detaching hook call(s)`);
  assert.deepEqual(findings, [], "a detached subtree keeps its event handlers armed until the browser collects it");
});

test("sanitizer.4: the sanitizer's entry point is string in, string out", (t) => {
  const findings = findingsOf(sanitizerSignatureFindings);
  t.diagnostic(`sanitizer.4: ${findings.length} non-string sanitizer boundary(ies)`);
  assert.deepEqual(findings, [], "a DOM node in is the shape the critical advisory needs; DOM out is what carries a shadow root");
});

test("sanitizer.5: the sanitised string is consumed by a DOM parse, not a template engine", (t) => {
  const findings = findingsOf(sanitizerConsumerFindings);
  t.diagnostic(`sanitizer.5: ${findings.length} evaluating consumer(s)`);
  assert.deepEqual(
    findings,
    [],
    "`{{…}}` surviving the sanitizer is inert text only while the consumer parses rather than evaluates it",
  );
});

test("sanitizer.6 (mutation): each adversarial shape is reported, and the live config is not", (t) => {
  const module = (config, extra = "") => [
    'import DOMPurify from "dompurify";',
    extra,
    "export function render(text: string): string {",
    `  return DOMPurify.sanitize(text, ${config});`,
    "}",
    'export const View = ({ html }: { html: string }) => <div dangerouslySetInnerHTML={{ __html: html }} />;',
  ].join("\n");
  const NAME = "src/components/Mutation.tsx";

  // The live shape: an allowlist and nothing else, rendered through a parse.
  assert.deepEqual(sanitizerConfigFindings(module('{ ALLOWED_TAGS: ["p"], ALLOWED_ATTR: [] }'), NAME), []);
  assert.deepEqual(sanitizerConfigFindings(module('{ SAFE_FOR_TEMPLATES: false, IN_PLACE: false }'), NAME), []);

  const splitter = sanitizerConfigFindings(module('{ SAFE_FOR_TEMPLATES: true, RETURN_DOM: true }'), NAME);
  assert.equal(splitter.length, 2, "both the template splitter and the DOM-returning mode are reported");
  assert.match(splitter[0], /Mutation\.tsx:4 SAFE_FOR_TEMPLATES: true/u);
  assert.match(splitter[1], /RETURN_DOM: true/u);

  assert.match(
    sanitizerConfigFindings(module('{ IN_PLACE: true }'), NAME).join("\n"),
    /IN_PLACE: true .*GHSA-mrv2-3pqr-j5jr/u,
  );

  // An options object the gate cannot read is a finding, not a skip. A named config is
  // followed to its one declaration; an undeclared name, an ambiguous name and a spread are
  // each reported.
  const opaque = module("options");
  assert.equal(sanitizerConfigFindings(opaque, NAME).length, 1);
  assert.match(sanitizerConfigFindings(opaque, NAME)[0], /names options, which has no declaration/u);
  const named = [
    'import DOMPurify from "dompurify";',
    'const CONFIG = { ALLOWED_TAGS: ["p"] };',
    "export function render(text: string): string {",
    "  return DOMPurify.sanitize(text, CONFIG);",
    "}",
  ].join("\n");
  assert.deepEqual(sanitizerConfigFindings(named, NAME), []);
  assert.match(
    sanitizerConfigFindings(named.replace('ALLOWED_TAGS: ["p"]', "SAFE_FOR_TEMPLATES: true"), NAME).join("\n"),
    /SAFE_FOR_TEMPLATES: true/u,
    "a named config is read, so turning the splitter on behind a constant is still caught",
  );
  const twice = [named, 'const CONFIG = { ALLOWED_TAGS: [] };'].join("\n");
  assert.match(sanitizerConfigFindings(twice, NAME).join("\n"), /declared 2 times/u);
  assert.match(sanitizerConfigFindings(module("{ ...options }"), NAME).join("\n"), /spread or computed member/u);

  // A hook's own node is allowed; a parent or a sibling is the defect.
  const withHook = (body) =>
    `import DOMPurify from "dompurify";\nDOMPurify.addHook("afterSanitizeAttributes", (node) => {\n${body}\n});`;
  assert.deepEqual(sanitizerHookFindings(withHook(`  node.remove();`), NAME), []);
  assert.deepEqual(sanitizerHookFindings(withHook(`  node.setAttribute("class", "beat");`), NAME), []);
  assert.match(sanitizerHookFindings(withHook(`  node.parentNode.removeChild(node);`), NAME).join("\n"), /removeChild\(\)/u);
  assert.match(sanitizerHookFindings(withHook(`  node.nextSibling.remove();`), NAME).join("\n"), /\.remove\(\)/u);

  // A node-shaped boundary is the critical advisory's precondition.
  const nodeIn = [
    'import DOMPurify from "dompurify";',
    "export function render(node: Node): string {",
    '  return DOMPurify.sanitize(node, { ALLOWED_TAGS: ["p"] });',
    "}",
  ].join("\n");
  assert.match(sanitizerSignatureFindings(nodeIn, NAME).join("\n"), /render takes `Node`/u);
  assert.deepEqual(sanitizerSignatureFindings(module("{ ALLOWED_TAGS: [] }"), NAME), []);

  // A consumer that evaluates instead of parsing is the half that makes `{{…}}` live.
  const evaluating = module("{ ALLOWED_TAGS: [] }", "const run = (html: string) => new Function(html);");
  assert.match(sanitizerConsumerFindings(evaluating, NAME).join("\n"), /new Function/u);
  const templated = [
    'import DOMPurify from "dompurify";',
    "export function render(text: string): string {",
    "  return DOMPurify.sanitize(text, { ALLOWED_TAGS: [] });",
    "}",
    "export const View = ({ html }: { html: string }) => <p>{html}</p>;",
  ].join("\n");
  assert.match(sanitizerConsumerFindings(templated, NAME).join("\n"), /renders no `dangerouslySetInnerHTML`/u);

  t.diagnostic(
    "sanitizer.6: SAFE_FOR_TEMPLATES+RETURN_DOM (2), IN_PLACE, an unresolvable or ambiguous options name, a spread, " +
      "removeChild, sibling .remove(), `Node` input, new Function and a non-parsing consumer are each reported; " +
      "the live shape, a readable named config and a hook's own `node.remove()` are not",
  );
});
