/**
 * Scope-reference audit for JavaScript sources (JavaScript-level, `.mjs`/`.js`/`.cjs`;
 * TypeScript is a documented lower-confidence opt-in).
 *
 * THE BUG CLASS IT EXISTS TO CATCH
 *
 * A name is used outside the scope that declares it, so the reference throws at the
 * worst possible moment — inside a failure path or a result path — and the run then
 * produces no artifact at all, destroying the evidence of the failure it was reporting.
 * Three real instances in `tools/live-run/`:
 *
 *   1. a `catch` block reading a binding declared inside its `try` (a `let` inside a
 *      `try` block is scoped to the try) -> `ReferenceError` in the failure path;
 *   2. a top-level statement reading a `const` declared further down the same block
 *      (temporal dead zone) -> the run ended before reporting;
 *   3. a module-level function pushing into a buffer declared inside another function
 *      -> `ReferenceError` inside the run's own trace collector.
 *
 * TWO RULES
 *
 *   `out_of_scope_reference`
 *     A reference that resolves to no binding in any enclosing scope, while a binding
 *     of that name exists somewhere else in the same file. That "exists somewhere else"
 *     qualifier is what keeps the rule honest: true JS globals (`process`, `console`,
 *     `URL`, `setTimeout`, ...) are never declared in the file, so they are never
 *     reported. Instances 1 and 3 are this rule (the `try` block and the sibling
 *     function are simply scopes the reference is not inside of).
 *
 *   `read_before_declaration`
 *     A reference that resolves to a lexical (`let`/`const`/`class`) binding whose
 *     declaration is textually later, inside the SAME execution scope — the temporal
 *     dead zone. "Same execution scope" means the innermost function/program scope of
 *     the reference equals that of the declaration, so a closure that is merely defined
 *     before the declaration (and called after) is not reported. Instance 2 is this rule.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   - It is not a type checker, a linter, or a control-flow analysis. It never decides
 *     whether a branch is reachable or whether a binding is `undefined` at runtime.
 *   - It never reports a name that is not declared anywhere in the file, so it cannot
 *     see a typo of a global (`consle.log`), a deleted import, or a missing module.
 *     `no-undef`-style coverage is a linter's job, not this gate's.
 *   - `var` and function declarations are hoisted to the nearest function/program scope
 *     before resolution, so `for (var i ...)` / `if (c) { var v }` usage is not reported.
 *   - A reference inside a closure is only reported when the binding is in a scope that
 *     does not enclose that closure at all. Late-but-legal reads (a module-level function
 *     reading a `const` defined below it, called after) are not reported.
 *   - A closure that can never run because it sits after an unconditional `return` is
 *     not reported (no control-flow analysis).
 *   - `parse_error` is not a `node --check` replacement. The tree-sitter JavaScript
 *     grammar is a superset: it accepts a top-level `return` that V8 rejects as an
 *     early error. It does report structural breakage (an unmatched brace, a truncated
 *     function), and it skips the scope rules for such a file rather than reporting on
 *     a recovered tree. Early-error coverage stays with `node --check`.
 *   - TypeScript positions (`type_identifier`, `predefined_type`, ...) are different
 *     node types and are never treated as value references; `.ts` support is still
 *     opt-in and lower-confidence because the type grammar has more node shapes.
 *     Measured on this repo's `host/src` (423 files): all 13 reported references are type
 *     positions (8 `NodeJS.Timeout`, 5 `[key: string]` index signatures), and both
 *     `parse_error`s are valid TS the grammar cannot parse (`refs as readonly
 *     import("...").T[]`). The CLI prints a warning whenever TypeScript is in scope;
 *     do not gate on TypeScript output until type positions are classified.
 *
 * HOW IT WORKS
 *
 * `web-tree-sitter` plus the `@vscode/tree-sitter-wasm` JavaScript/TypeScript grammar
 * (both already devDependencies; no new dependency) produce a real AST. One walk builds
 * a scope tree with its bindings and collects every identifier reference, classifying
 * each `identifier` by the declaration construct that owns it rather than by a field
 * guess. A second pass resolves each reference against the scope chain. Files that do
 * not parse cleanly are reported as `parse_error` and their rules are skipped, so a
 * parse recovery can never manufacture a finding.
 *
 * Determinism: a pure function of file bytes. Findings are sorted by file, line,
 * column, then rule.
 */

import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";

/** Rule ids a caller may disable. `parse_error` is not disableable. */
export const SCOPE_REFERENCE_RULES = Object.freeze(["out_of_scope_reference", "read_before_declaration"]);

export const PARSE_ERROR_RULE = "parse_error";

/** Extensions this audit understands, mapped to their grammar's wasm file. */
export const SUPPORTED_EXTENSIONS = Object.freeze({
  ".cjs": "tree-sitter-javascript.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
});

const FUNCTION_LIKE = new Set([
  "arrow_function",
  "function_declaration",
  "function_expression",
  "generator_function",
  "generator_function_declaration",
  "method_definition",
]);

const SCOPE_NODES = new Set([
  "program",
  ...FUNCTION_LIKE,
  "catch_clause",
  "class",
  "class_declaration",
  "class_expression",
  "for_in_statement",
  "for_statement",
  "statement_block",
  "switch_body",
]);

const LEXICAL_DECLARATION_KINDS = new Set(["class", "const", "let"]);

/**
 * Names that the runtime always provides, so a reference to one of them is never a
 * scope bug even when the same file happens to declare that name as a parameter or
 * local somewhere else. Without this list, `function f(process, ...)` elsewhere in a
 * file would make every ordinary `process.env` reference look like a cross-scope leak.
 *
 * The cost is honest and bounded: a genuine typo of one of these names (or a deleted
 * local that used to shadow one) is not reported. `no-undef`-style coverage over
 * host globals belongs to a linter, not to this gate.
 */
export const HOST_GLOBALS = new Set([
  "AbortController",
  "AbortSignal",
  "AggregateError",
  "Array",
  "ArrayBuffer",
  "Atomics",
  "BigInt",
  "BigInt64Array",
  "BigUint64Array",
  "Blob",
  "Boolean",
  "BroadcastChannel",
  "Buffer",
  "CompressionStream",
  "DOMException",
  "DataView",
  "Date",
  "DecompressionStream",
  "DisposableStack",
  "Error",
  "EvalError",
  "Event",
  "EventTarget",
  "File",
  "FinalizationRegistry",
  "FormData",
  "Function",
  "Generator",
  "GeneratorFunction",
  "Headers",
  "Infinity",
  "Int16Array",
  "Int32Array",
  "Int8Array",
  "Intl",
  "Iterator",
  "JSON",
  "Map",
  "AsyncFunction",
  "AsyncGenerator",
  "AsyncIterator",
  "Math",
  "MessageChannel",
  "MessagePort",
  "NaN",
  "Number",
  "Object",
  "Promise",
  "Proxy",
  "RangeError",
  "ReadableStream",
  "ReferenceError",
  "Reflect",
  "RegExp",
  "Request",
  "Response",
  "Set",
  "SharedArrayBuffer",
  "String",
  "SuppressedError",
  "Symbol",
  "SyntaxError",
  "TextDecoder",
  "TextDecoderStream",
  "TextEncoder",
  "TextEncoderStream",
  "TransformStream",
  "TypeError",
  "URIError",
  "URL",
  "URLSearchParams",
  "Uint16Array",
  "Uint32Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "WeakMap",
  "WeakRef",
  "WeakSet",
  "WebAssembly",
  "WebSocket",
  "WritableStream",
  "__dirname",
  "__filename",
  "arguments",
  "atob",
  "btoa",
  "clearImmediate",
  "clearInterval",
  "clearTimeout",
  "console",
  "crypto",
  "decodeURI",
  "decodeURIComponent",
  "encodeURI",
  "encodeURIComponent",
  "escape",
  "eval",
  "exports",
  "fetch",
  "gc",
  "global",
  "globalThis",
  "isFinite",
  "isNaN",
  "module",
  "navigator",
  "parseFloat",
  "parseInt",
  "performance",
  "process",
  "queueMicrotask",
  "reportError",
  "require",
  "setImmediate",
  "setInterval",
  "setTimeout",
  "structuredClone",
  "undefined",
  "unescape",
]);

const require = createRequire(import.meta.url);
const wasmDirectory = path.join(path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")), "wasm");

const parserPromises = new Map();

function parserFor(grammarWasm) {
  let promise = parserPromises.get(grammarWasm);
  if (promise === undefined) {
    promise = (async () => {
      await Parser.init();
      const parser = new Parser();
      parser.setLanguage(await Language.load(path.join(wasmDirectory, grammarWasm)));
      return parser;
    })();
    parserPromises.set(grammarWasm, promise);
  }
  return promise;
}

function grammarFor(fileName) {
  return SUPPORTED_EXTENSIONS[path.extname(fileName).toLowerCase()] ?? null;
}

class Scope {
  constructor(parent, node, kind) {
    this.parent = parent;
    this.node = node;
    this.kind = kind;
    /** name -> { declarations: [{ node, kind }] } */
    this.bindings = new Map();
  }
}

function isIdentifierLike(node) {
  return (
    node.type === "identifier" ||
    node.type === "shorthand_property_identifier" ||
    node.type === "shorthand_property_identifier_pattern"
  );
}

// `web-tree-sitter` hands out a FRESH JS wrapper on every child access
// (`childForFieldName(...) === namedChildren[0]` is false; only `.equals()` is true),
// so node identity in a `Set` silently never matches. Key declarations by their span.
function spanKey(node) {
  return `${node.startIndex}:${node.endIndex}`;
}

function scopeKindOf(node) {
  if (node.type === "program") return "program";
  return FUNCTION_LIKE.has(node.type) ? "function" : "block";
}

function innermostFunctionScope(scope) {
  for (let current = scope; current !== null; current = current.parent) {
    if (current.kind === "function" || current.kind === "program") return current;
  }
  return scope;
}

/** The innermost function/program scope a node sits in, as a human label. */
function functionContextOf(scope) {
  return innermostFunctionScope(scope).label;
}

function hoistScope(scope) {
  for (let current = scope; current !== null; current = current.parent) {
    if (current.kind === "function" || current.kind === "program") return current;
  }
  return scope;
}

function scopeLabel(scope) {
  const node = scope.node;
  if (node === null) return "<module>";
  switch (node.type) {
    case "program":
      return "<module>";
    case "arrow_function":
      return "<arrow function>";
    case "function_expression":
      return node.childForFieldName("name")?.text ?? "<function expression>";
    case "generator_function":
      return node.childForFieldName("name")?.text ?? "<generator function>";
    case "generator_function_declaration":
    case "function_declaration":
      return `${node.childForFieldName("name")?.text ?? "<function>"}()`;
    case "method_definition":
      return `${node.childForFieldName("name")?.text ?? "<method>"}()`;
    case "class":
    case "class_declaration":
    case "class_expression":
      return node.childForFieldName("name")?.text ?? "<class>";
    case "catch_clause":
      return "<catch block>";
    case "for_in_statement":
    case "for_statement":
      return "<for loop>";
    case "switch_body":
      return "<switch block>";
    case "statement_block":
      return "<block>";
    default:
      return `<${node.type}>`;
  }
}

function collectPatternBindings(node, out) {
  if (node === null || node === undefined) return;
  switch (node.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(node);
      return;
    case "assignment_pattern":
    case "object_assignment_pattern":
      collectPatternBindings(node.childForFieldName("left"), out);
      return;
    case "pair_pattern":
      collectPatternBindings(node.childForFieldName("value"), out);
      return;
    default:
      for (const child of node.namedChildren) collectPatternBindings(child, out);
  }
}

function analyzeTree(root) {
  const scopes = [];
  const references = [];
  /** Span keys of identifier nodes that are declarations or non-reference naming positions. */
  const nonReferenceNodes = new Set();
  const allBindingNames = new Set();

  function declare(scope, node, kind) {
    nonReferenceNodes.add(spanKey(node));
    allBindingNames.add(node.text);
    const entry = scope.bindings.get(node.text);
    if (entry === undefined) scope.bindings.set(node.text, { declarations: [{ node, kind }] });
    else entry.declarations.push({ node, kind });
  }

  function declarePattern(node, scope, kind) {
    const targets = [];
    collectPatternBindings(node, targets);
    for (const target of targets) declare(scope, target, kind);
  }

  function declareLoopOrVariable(node, innerScope) {
    if (node.type === "for_in_statement") {
      const kind = node.childForFieldName("kind");
      const left = node.childForFieldName("left");
      if (kind === null || left === null) return;
      declarePattern(left, kind.text === "var" ? hoistScope(innerScope) : innerScope, kind.text);
      return;
    }
    const isVar = node.parent?.type === "variable_declaration";
    const kind = isVar ? "var" : (node.parent?.childForFieldName("kind")?.text ?? "let");
    declarePattern(node.childForFieldName("name"), isVar ? hoistScope(innerScope) : innerScope, kind);
  }

  function declareDeclarationName(node, outerScope, innerScope) {
    const name = node.childForFieldName("name");
    switch (node.type) {
      case "function_declaration":
      case "generator_function_declaration":
        declare(outerScope, name, "function");
        return;
      case "class_declaration":
        declare(outerScope, name, "class");
        return;
      case "class":
      case "class_expression":
        if (name !== null) declare(innerScope, name, "class");
        return;
      default:
        // A named function expression binds its own name inside its own body only.
        if (name !== null) declare(innerScope, name, "function");
    }
  }

  function declareParameterBindings(node, innerScope) {
    if (node.type === "formal_parameters") {
      for (const parameter of node.namedChildren) declarePattern(parameter, innerScope, "param");
      return;
    }
    const parameter = node.childForFieldName("parameter");
    if (parameter === null) return;
    declarePattern(parameter, innerScope, node.type === "catch_clause" ? "catch" : "param");
  }

  function handleDeclaration(node, outerScope, innerScope) {
    switch (node.type) {
      case "import_statement":
        handleImport(node, innerScope, declare, nonReferenceNodes);
        return;
      case "export_statement":
        handleExport(node, innerScope, declare, nonReferenceNodes);
        return;
      case "variable_declarator":
      case "for_in_statement":
        declareLoopOrVariable(node, innerScope);
        return;
      case "function_declaration":
      case "generator_function_declaration":
      case "function_expression":
      case "generator_function":
      case "class_declaration":
      case "class":
      case "class_expression":
        declareDeclarationName(node, outerScope, innerScope);
        return;
      case "formal_parameters":
      case "arrow_function":
      case "catch_clause":
        declareParameterBindings(node, innerScope);
        return;
      default:
    }
  }

  function visit(node, scope) {
    const inner = node !== root && SCOPE_NODES.has(node.type) ? createScope(scope, node) : scope;
    handleDeclaration(node, scope, inner);
    for (const child of node.namedChildren) {
      if (nonReferenceNodes.has(spanKey(child))) continue;
      if (isIdentifierLike(child)) {
        references.push({ name: child.text, node: child, scope: inner });
        continue;
      }
      visit(child, inner);
    }
  }

  function createScope(parent, node) {
    const scope = new Scope(parent, node, scopeKindOf(node));
    scope.label = scopeLabel(scope);
    scopes.push(scope);
    return scope;
  }

  const moduleScope = createScope(null, root);
  visit(root, moduleScope);

  return { allBindingNames, references, scopes };
}

function handleImport(node, scope, declare, nonReferenceNodes) {
  const clause = node.namedChildren.find((child) => child.type === "import_clause");
  if (clause === undefined) return;
  for (const child of clause.namedChildren) {
    if (child.type === "identifier") {
      declare(scope, child, "import");
      continue;
    }
    if (child.type === "named_imports") {
      for (const specifier of child.namedChildren) {
        if (specifier.type !== "import_specifier") continue;
        const name = specifier.childForFieldName("name");
        const alias = specifier.childForFieldName("alias");
        if (alias === null) declare(scope, name, "import");
        else {
          // `import { foreign as local }` — `foreign` is the other module's export.
          nonReferenceNodes.add(spanKey(name));
          declare(scope, alias, "import");
        }
      }
      continue;
    }
    if (child.type === "namespace_import") {
      const name = child.namedChildren.find((candidate) => candidate.type === "identifier");
      if (name !== undefined) declare(scope, name, "import");
    }
  }
}

function handleExport(node, scope, declare, nonReferenceNodes) {
  const hasSource = node.childForFieldName("source") !== null;
  const clause = node.namedChildren.find((child) => child.type === "export_clause");
  if (clause !== undefined) {
    for (const specifier of clause.namedChildren) {
      if (specifier.type !== "export_specifier") continue;
      const name = specifier.childForFieldName("name");
      const alias = specifier.childForFieldName("alias");
      if (hasSource) {
        // Re-export: neither side names a binding of this module.
        nonReferenceNodes.add(spanKey(name));
        if (alias !== null) nonReferenceNodes.add(spanKey(alias));
      } else if (alias !== null) {
        // `export { local as public }` — `public` is not a local reference.
        nonReferenceNodes.add(spanKey(alias));
      }
    }
  }
  const namespaceExport = node.namedChildren.find((child) => child.type === "namespace_export");
  if (namespaceExport !== undefined) {
    const name = namespaceExport.namedChildren.find((candidate) => candidate.type === "identifier");
    if (name !== undefined) declare(scope, name, "import");
  }
}

function resolve(scope, name) {
  for (let current = scope; current !== null; current = current.parent) {
    const entry = current.bindings.get(name);
    if (entry === undefined) continue;
    const lexical = entry.declarations.find((declaration) => LEXICAL_DECLARATION_KINDS.has(declaration.kind));
    return { scope: current, declaration: lexical ?? entry.declarations[0] };
  }
  return null;
}

function lineStarts(source) {
  const starts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

function positionOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= index) low = middle;
    else high = middle - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

function firstErrorNode(root) {
  // Report the EARLIEST error in source order: `tree-sitter` tends to place its
  // recovery `ERROR` node after the construct it could not accept.
  let earliest = null;
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node.type === "ERROR" || node.isMissing) {
      if (earliest === null || node.startIndex < earliest.startIndex) earliest = node;
    }
    for (const child of node.children) stack.push(child);
  }
  return earliest;
}

export async function analyzeSource(source, options = {}) {
  const fileName = options.fileName ?? "<source>";
  const enabled = new Set(options.rules ?? SCOPE_REFERENCE_RULES);
  const grammarWasm = grammarFor(fileName);
  if (grammarWasm === null) {
    throw new Error(`scope-reference audit does not support ${JSON.stringify(fileName)}`);
  }

  const parser = await parserFor(grammarWasm);
  const tree = parser.parse(source);
  const root = tree.rootNode;
  const starts = lineStarts(source);

  if (root.hasError) {
    const errorNode = firstErrorNode(root);
    const at = positionOf(starts, errorNode?.startIndex ?? 0);
    return {
      fileName,
      findings: [
        {
          rule: PARSE_ERROR_RULE,
          fileName,
          line: at.line,
          column: at.column,
          name: null,
          message: `source does not parse cleanly at ${at.line}:${at.column}; scope rules were skipped for this file`,
        },
      ],
      parsed: false,
    };
  }

  const { allBindingNames, references } = analyzeTree(root);
  const findings = [];

  for (const reference of references) {
    const { name, node, scope } = reference;
    const binding = resolve(scope, name);
    if (binding === null) {
      if (!allBindingNames.has(name)) continue;
      if (HOST_GLOBALS.has(name)) continue;
      if (!enabled.has("out_of_scope_reference")) continue;
      const at = positionOf(starts, node.startIndex);
      findings.push({
        rule: "out_of_scope_reference",
        fileName,
        line: at.line,
        column: at.column,
        name,
        message:
          `'${name}' is used here in ${functionContextOf(scope)} but no enclosing scope declares it; ` +
          `the only binding of that name is in another scope in this file`,
      });
      continue;
    }
    const declaration = binding.declaration;
    if (!LEXICAL_DECLARATION_KINDS.has(declaration.kind)) continue;
    if (declaration.node.startIndex <= node.startIndex) continue;
    if (innermostFunctionScope(binding.scope) !== innermostFunctionScope(scope)) continue;
    if (!enabled.has("read_before_declaration")) continue;
    const at = positionOf(starts, node.startIndex);
    const declaredAt = positionOf(starts, declaration.node.startIndex);
    findings.push({
      rule: "read_before_declaration",
      fileName,
      line: at.line,
      column: at.column,
      name,
      message:
        `'${name}' is read here before its '${declaration.kind}' declaration at ` +
        `${declaredAt.line}:${declaredAt.column} in the same execution scope (temporal dead zone)`,
    });
  }

  findings.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.rule.localeCompare(right.rule) ||
      (left.name ?? "").localeCompare(right.name ?? ""),
  );
  return { fileName, findings, parsed: true };
}

export async function analyzeFile(filePath, options = {}) {
  return analyzeSource(await readFile(filePath, "utf8"), {
    ...options,
    fileName: options.fileName ?? filePath,
  });
}
