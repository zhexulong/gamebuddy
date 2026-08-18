import { existsSync, readFileSync, realpathSync } from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const requireFromHost = createRequire(resolve(import.meta.dirname, "../host/package.json"));
const ts = requireFromHost("typescript");

const here = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(here, "..");
export const DEFAULT_ROOTS = Object.freeze(["host/src/main.ts", "host/src/dialogue-web-main.ts"]);
/** P4 is a production composition island, not an application entry root. */
export const P4_COMPOSITION_ROOTS = Object.freeze([
  "host/src/tavern/p4-durable-turn-acceptance.ts",
  "host/src/tavern/p4-durable-turn-acceptance.internal.ts",
  "host/src/tavern/p4-provider-attempt.ts",
  "host/src/tavern/p4-provider-attempt.internal.ts",
  "host/src/tavern/p4-provider-start.ts",
  "host/src/tavern/p4-provider-start.internal.ts",
  "host/src/tavern/p5-presentation-commit.ts",
  "host/src/tavern/p5-presentation-commit.internal.ts",
]);
export function validateHostProductionImportBoundaryBaseline(report) {
  return report?.verdict === "passed"
    ? { accepted: true, mode: "clean" }
    : { accepted: false, reason: "production_import_boundary_violations" };
}
export const LEGACY_ADOPTION_FUNCTIONS = Object.freeze([
  "adoptLegacyPartition",
  "collectQuiescentLegacyContinuitySnapshot",
  "createQuiescentLegacyContinuitySnapshot",
  "validateQuiescentLegacyContinuitySnapshot",
]);
const LEGACY_MODULES = Object.freeze([
  "continuity.ts",
  "continuity-production-migration/",
  "continuity-authority-coordinator/",
  "continuity-authority-routing/",
  "game-origin-authority/",
  "game-surface-lease.ts",
  "game-surface-recovery.ts",
  "game-surface-lifecycle/",
]);
const SEMANTIC_AUTHORITY_MODULES = Object.freeze(["continuity-semantic-provisioning/", "continuity-semantic-store/"]);
const SEMANTIC_PRODUCTION_COORDINATOR = "continuity-semantic-production-coordinator/";
const SEMANTIC_PRODUCTION_COORDINATOR_PUBLIC_MODULE =
  "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.ts";
const SEMANTIC_PRODUCTION_COORDINATOR_INTERNAL_MODULE =
  "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.ts";
const SEMANTIC_BACKEND_MODULE = "continuity-semantic-backend/";
const P4_FACADE_MODULE = "tavern/p4-durable-turn-acceptance.ts";
const P4_BRIDGE_MODULE = "tavern/p4-durable-turn-acceptance.internal.ts";
const P4B_FACADE_MODULE = "tavern/p4-provider-attempt.ts";
const P4B_BRIDGE_MODULE = "tavern/p4-provider-attempt.internal.ts";
const P4C_FACADE_MODULE = "tavern/p4-provider-start.ts";
const P4C_BRIDGE_MODULE = "tavern/p4-provider-start.internal.ts";
const P4C_EXECUTION_MODULE = "tavern/p4-provider-start-execution.ts";
const P5_FACADE_MODULE = "tavern/p5-presentation-commit.ts";
const P5_BRIDGE_MODULE = "tavern/p5-presentation-commit.internal.ts";
const P4_STORE_MODULE = "tavern/chat-thread-store.ts";
const P4_P5_TRANSITION_AUTHORITY_MODULE = "tavern/chat-thread-store.p4-p5-transition-authority.internal.ts";
const P4_COORDINATOR_IMPORTS = new Set(["acceptMountedP4DurableTurn", "consumeMountedP4Admission"]);
const P4B_COORDINATOR_IMPORTS = new Set([
  "claimMountedP4Attempt",
  "consumeMountedP4AttemptAdmission",
  "consumeMountedP4AttemptInvocationAdmission",
]);
const P4C_COORDINATOR_IMPORTS = new Set([
  "startMountedP4Attempt",
  "consumeMountedP4AttemptInvocationAdmission",
]);
const P4_STORE_IMPORTS = new Set([
  "acceptP4MountedPlayerMessage",
  "claimP4MountedAttempt",
  "transitionP4MountedProviderStart",
  "transitionP5MountedPresentation",
]);
const P4_SENSITIVE_IMPORTS = new Set([...P4_COORDINATOR_IMPORTS, ...P4_STORE_IMPORTS]);
const LEGACY_BACKEND_MINT_IDENTIFIERS = Object.freeze([
  "createSemanticProductionBackend",
  "SemanticProductionBackend",
  "SemanticProductionBackendOperations",
]);
const SOURCE_EXTENSIONS = Object.freeze([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const PERMITTED_NODE_BUILTIN_SPECIFIERS = new Set(
  builtinModules.flatMap((specifier) => [specifier, `node:${specifier}`]),
);

function lineAt(source, index) {
  return source.slice(0, index).split("\n").length;
}
function display(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

/** Tokenizes just enough TypeScript/JavaScript to avoid treating comments and
 * ordinary strings as import syntax, while retaining string literal locations. */
function quotedEnd(source, index, end) {
  const quote = source[index++];
  while (index < end && source[index] !== quote) {
    if (source[index] === "\\") index += 1;
    index += 1;
  }
  return index < end ? index + 1 : end;
}
function interpolationEnd(source, index, end) {
  let depth = 1;
  while (index < end) {
    const char = source[index];
    if (char === "'" || char === '"') {
      index = quotedEnd(source, index, end);
      continue;
    }
    if (char === "`") {
      index = templateEnd(source, index, end);
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return index;
    index += 1;
  }
  return end;
}
function templateEnd(source, index, end) {
  index += 1;
  while (index < end && source[index] !== "`") {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "$" && source[index + 1] === "{") {
      index = interpolationEnd(source, index + 2, end) + 1;
      continue;
    }
    index += 1;
  }
  return index < end ? index + 1 : end;
}

/** Tokenizes just enough TypeScript/JavaScript to avoid treating comments and
 * ordinary strings as import syntax, while retaining string literal locations. */
function tokens(source, start = 0, end = source.length, result = []) {
  let index = start;
  const add = (type, value, offset) => result.push({ type, value, offset, line: lineAt(source, offset) });
  while (index < end) {
    const char = source[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      index = source.indexOf("\n", index + 2);
      if (index < 0 || index >= end) break;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 || close >= end ? end : close + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      const tokenStart = index;
      const quote = char;
      index += 1;
      let value = "";
      while (index < end && source[index] !== quote) {
        if (source[index] === "\\") {
          index += 1;
          if (index < end) value += source[index++];
          continue;
        }
        value += source[index++];
      }
      if (source[index] === quote) index += 1;
      add("string", value, tokenStart);
      continue;
    }
    if (char === "`") {
      const tokenStart = index++;
      while (index < end && source[index] !== "`") {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "$" && source[index + 1] === "{") {
          const expressionStart = index + 2;
          const expressionEnd = interpolationEnd(source, expressionStart, end);
          tokens(source, expressionStart, expressionEnd, result);
          index = expressionEnd + 1;
          continue;
        }
        index += 1;
      }
      if (source[index] === "`") index += 1;
      add("template", "", tokenStart);
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      const tokenStart = index++;
      while (/[A-Za-z0-9_$]/.test(source[index] ?? "")) index += 1;
      add("word", source.slice(tokenStart, index), tokenStart);
      continue;
    }
    add("punctuation", char, index++);
  }
  return result;
}

function matchingToken(all, index, open, close) {
  let depth = 0;
  for (let cursor = index; cursor < all.length; cursor += 1) {
    if (all[cursor].value === open) depth += 1;
    if (all[cursor].value === close && --depth === 0) return cursor;
  }
  return -1;
}
function isMethodDeclaration(all, index) {
  let cursor = index + 1;
  if (all[cursor]?.value === "<") {
    cursor = matchingToken(all, cursor, "<", ">");
    if (cursor < 0) return false;
    cursor += 1;
  }
  if (all[cursor]?.value !== "(") return false;
  cursor = matchingToken(all, cursor, "(", ")");
  if (cursor < 0) return false;
  const next = all[cursor + 1]?.value;
  // A return-type annotation can stand between a method's parameters and body.
  // A dynamic import expression cannot be followed by one, so this remains
  // fail-closed for actual dynamic imports (including import(`...`)).
  return next === "{" || next === ":";
}
/**
 * TypeScript represents erased `import("x").T` and `typeof import("x")`
 * syntax as `ImportType` AST nodes, while executable `import("x").then()`
 * remains a CallExpression. Token adjacency cannot make that distinction
 * safely, so ask the same pinned TypeScript compiler used by Host.
 */
function erasedImportTypeOffsets(source) {
  const file = ts.createSourceFile("production-boundary.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const offsets = new Set();
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.ImportType) {
      const start = node.getStart(file, false);
      // `getStart()` may include `typeof`; find the actual `import` keyword
      // within this exact ImportTypeNode, never beyond it.
      const offset = source.indexOf("import", start);
      if (offset >= start && offset < node.end) offsets.add(offset);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return offsets;
}

function importedBindings(all, start, end) {
  const bindings = [];
  let inBraces = false;
  for (let cursor = start; cursor < end; cursor += 1) {
    const token = all[cursor];
    if (token.value === "{") { inBraces = true; continue; }
    if (token.value === "}") { inBraces = false; continue; }
    if (token.value === "*") { bindings.push("*"); continue; }
    if ((token.type !== "word" && token.type !== "string") || token.value === "type" || token.value === "as") continue;
    if (
      inBraces &&
      ["{", ","].includes(all[cursor - 1]?.value) &&
      all[cursor - 1]?.value !== "type"
    )
      // ES module bindings may be string-named (for example
      // `import { "acceptP4MountedPlayerMessage" as raw }`). Those are
      // executable bindings just like identifier-named imports.
      bindings.push(token.value);
    else if (!inBraces && cursor === start && token.type === "word") bindings.push("default");
  }
  return bindings;
}
function isDeclaredExternalPackage(specifier, externalPackages) {
  return [...externalPackages].some((pkg) => specifier === pkg || specifier.startsWith(`${pkg}/`));
}
/** Parses the bridge's deliberately tiny runtime export surface. Type-only
 * imports/exports are erased, so they cannot leak a runtime ingress. */
function p4BridgeRuntimeExports(source) {
  const all = tokens(source);
  const sensitiveLocals = new Set();
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].value !== "import" || all[index + 1]?.value === "type") continue;
    let from = -1;
    for (let cursor = index + 1; cursor < all.length && all[cursor].value !== ";"; cursor += 1)
      if (all[cursor].value === "from" && all[cursor + 1]?.type === "string") { from = cursor; break; }
    if (from < 0) continue;
    const specifier = all[from + 1].value;
    const sensitive = specifier.includes("continuity-semantic-production-coordinator.internal") || specifier.includes("/chat-thread-store");
    if (!sensitive) continue;
    for (let cursor = index + 1; cursor < from; cursor += 1) {
      if (all[cursor].value === "*") { if (all[cursor + 1]?.value === "as") sensitiveLocals.add(all[cursor + 2]?.value); continue; }
      if (all[cursor].value === "{") {
        const close = matchingToken(all, cursor, "{", "}");
        for (let item = cursor + 1; item < close; item += 1) {
          if ((all[item].type !== "word" && all[item].type !== "string") || all[item].value === "type") continue;
          if (["{", ","].includes(all[item - 1]?.value))
            sensitiveLocals.add(all[item + 1]?.value === "as" ? all[item + 2]?.value : all[item].value);
        }
        cursor = close;
      } else if (all[cursor].type === "word" && cursor === index + 1) sensitiveLocals.add(all[cursor].value);
    }
  }
  // The pinned TypeScript AST is the authority for whether a variable's
  // initializer emits as a bare identifier. Only a small, explicitly erased
  // wrapper set preserves sensitive provenance; calls, member access,
  // destructuring, assignments, and every other initializer remain outside
  // this deliberately narrow graph.
  const ast = ts.createSourceFile("p4-bridge.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const erasedAliasSource = (expression) => {
    let current = expression;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current)
    )
      current = current.expression;
    return ts.isIdentifier(current) ? current.text : null;
  };
  const simpleAliases = [];
  const collectAliases = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const sourceLocal = erasedAliasSource(node.initializer);
      if (sourceLocal !== null) simpleAliases.push([node.name.text, sourceLocal]);
    }
    ts.forEachChild(node, collectAliases);
  };
  collectAliases(ast);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [local, sourceLocal] of simpleAliases) {
      if (sensitiveLocals.has(sourceLocal) && !sensitiveLocals.has(local)) {
        sensitiveLocals.add(local);
        changed = true;
      }
    }
  }
  const exports = [];
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].value !== "export" || all[index + 1]?.value === "type") continue;
    if (all[index + 1]?.value === "default") {
      const local = all[index + 2]?.value;
      exports.push({ name: "default", sensitive: sensitiveLocals.has(local) });
      continue;
    }
    if (all[index + 1]?.value === "{") {
      const close = matchingToken(all, index + 1, "{", "}");
      for (let item = index + 2; item < close; item += 1) {
        if (all[item].type !== "word" || all[item].value === "type" || !["{", ","].includes(all[item - 1]?.value)) continue;
        exports.push({ name: all[item + 1]?.value === "as" ? all[item + 2]?.value : all[item].value, sensitive: sensitiveLocals.has(all[item].value) });
      }
      continue;
    }
    if (all[index + 1]?.value === "*") { exports.push({ name: "*", sensitive: true }); continue; }
    if (["const", "let", "var", "function", "class", "async"].includes(all[index + 1]?.value)) {
      const name = all[index + 1]?.value === "async" ? all[index + 3]?.value : all[index + 2]?.value;
      exports.push({ name, sensitive: sensitiveLocals.has(name) });
    }
  }
  return exports;
}
function isExactP4BridgeImplementation(source, shape = Object.freeze({
  facade: "acceptMountedP4DurableTurnFromFacade",
  runner: "acceptMountedP4DurableTurn",
  consumer: "consumeMountedP4Admission",
  store: "acceptP4MountedPlayerMessage",
  command: true,
})) {
  const file = ts.createSourceFile("p4-bridge.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runtimeImports = new Map();
  const addRuntimeImport = (module, name, local) => {
    const entries = runtimeImports.get(module) ?? [];
    entries.push({ name, local });
    runtimeImports.set(module, entries);
  };
  let implementation;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return false;
      for (const entry of clause.namedBindings.elements) {
        if (entry.isTypeOnly) continue;
        addRuntimeImport(statement.moduleSpecifier.text, entry.propertyName?.text ?? entry.name.text, entry.name.text);
      }
      continue;
    }
    if (
      ts.isTypeAliasDeclaration(statement) ||
      ts.isInterfaceDeclaration(statement) ||
      (ts.isExportDeclaration(statement) && statement.isTypeOnly)
    )
      continue;
    if (ts.isFunctionDeclaration(statement)) {
      if (implementation !== undefined) return false;
      implementation = statement;
      continue;
    }
    return false;
  }
  const hasExactRuntimeImports = (module, expected) => {
    const actual = runtimeImports.get(module) ?? [];
    return actual.length === expected.length && expected.every(({ name, local }) => actual.some((entry) => entry.name === name && entry.local === local));
  };
  if (
    runtimeImports.size !== 2 ||
    !hasExactRuntimeImports("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", [
      { name: shape.runner, local: shape.runner },
      { name: shape.consumer, local: shape.consumer },
      ...(shape.invocationConsumer === undefined ? [] : [{ name: shape.invocationConsumer, local: shape.invocationConsumer }]),
    ]) ||
    !hasExactRuntimeImports("./chat-thread-store.js", [{ name: shape.store, local: shape.store }]) ||
    implementation === undefined ||
    implementation.name?.text !== shape.facade ||
    !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    implementation.parameters.length !== (shape.command ? 3 : 2) ||
    implementation.parameters.some(
      (parameter, index) =>
        parameter.name.kind !== ts.SyntaxKind.Identifier ||
        parameter.name.getText(file) !== (shape.command ? ["manifest", "lease", "command"][index] : ["manifest", "lease"][index]) ||
        parameter.initializer !== undefined ||
        parameter.dotDotDotToken !== undefined ||
        parameter.questionToken !== undefined ||
        (parameter.modifiers?.length ?? 0) !== 0,
    ) ||
    implementation.body === undefined ||
    implementation.body.statements.length !== 1 ||
    !ts.isReturnStatement(implementation.body.statements[0]) ||
    implementation.body.statements[0].expression === undefined
  )
    return false;
  const outer = implementation.body.statements[0].expression;
  if (!ts.isCallExpression(outer) || !ts.isIdentifier(outer.expression) || outer.expression.text !== shape.runner || outer.arguments.length !== (shape.invocationConsumer === undefined ? 3 : 4)) return false;
  if (!ts.isIdentifier(outer.arguments[0]) || outer.arguments[0].text !== "manifest" || !ts.isIdentifier(outer.arguments[1]) || outer.arguments[1].text !== "lease") return false;
  const firstCallback = outer.arguments[2];
  if (!ts.isArrowFunction(firstCallback) || firstCallback.parameters.length !== 1 || !ts.isIdentifier(firstCallback.parameters[0].name)) return false;
  const admission = firstCallback.parameters[0].name.text;
  const firstBody = ts.isBlock(firstCallback.body)
    ? firstCallback.body.statements.length === 1 && ts.isReturnStatement(firstCallback.body.statements[0])
      ? firstCallback.body.statements[0].expression
      : undefined
    : firstCallback.body;
  if (!firstBody || !ts.isCallExpression(firstBody) || !ts.isIdentifier(firstBody.expression) || firstBody.expression.text !== shape.consumer || firstBody.arguments.length !== 2 || !ts.isIdentifier(firstBody.arguments[0]) || firstBody.arguments[0].text !== admission) return false;
  const secondCallback = firstBody.arguments[1];
  if (!ts.isArrowFunction(secondCallback) || secondCallback.parameters.length !== 1 || !ts.isIdentifier(secondCallback.parameters[0].name)) return false;
  const binding = secondCallback.parameters[0].name.text;
  const secondBody = ts.isBlock(secondCallback.body)
    ? secondCallback.body.statements.length === 1 && ts.isReturnStatement(secondCallback.body.statements[0])
      ? secondCallback.body.statements[0].expression
      : undefined
    : secondCallback.body;
  const exactStoreCall = !!(
    secondBody &&
    ts.isCallExpression(secondBody) &&
    ts.isIdentifier(secondBody.expression) &&
    secondBody.expression.text === shape.store &&
    secondBody.arguments.length === (shape.command ? 2 : 1) &&
    ts.isIdentifier(secondBody.arguments[0]) &&
    secondBody.arguments[0].text === binding &&
    (!shape.command || (ts.isIdentifier(secondBody.arguments[1]) && secondBody.arguments[1].text === "command"))
  );
  if (!exactStoreCall) return false;
  if (shape.invocationConsumer === undefined) return true;
  const observer = outer.arguments[3];
  if (!ts.isArrowFunction(observer) || observer.parameters.length !== 1 || !ts.isIdentifier(observer.parameters[0].name)) return false;
  const invocation = observer.parameters[0].name.text;
  const observerBody = observer.body;
  if (!ts.isCallExpression(observerBody) || !ts.isIdentifier(observerBody.expression) || observerBody.expression.text !== shape.invocationConsumer || observerBody.arguments.length !== 2 || !ts.isIdentifier(observerBody.arguments[0]) || observerBody.arguments[0].text !== invocation) return false;
  const callback = observerBody.arguments[1];
  return ts.isArrowFunction(callback) && callback.parameters.length === 0 && callback.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) === true && ts.isIdentifier(callback.body) && callback.body.text === "undefined";
}

/** P4c may only start an already durable P4b claim through its private scope. */
function isExactP4cBridgeImplementation(source) {
  const file = ts.createSourceFile("p4c-bridge.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runtimeImports = new Map();
  let implementation;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return false;
      runtimeImports.set(
        statement.moduleSpecifier.text,
        clause.namedBindings.elements.filter((entry) => !entry.isTypeOnly).map((entry) => ({
          name: entry.propertyName?.text ?? entry.name.text,
          local: entry.name.text,
        })),
      );
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.isTypeOnly)) continue;
    if (ts.isFunctionDeclaration(statement) && implementation === undefined) { implementation = statement; continue; }
    return false;
  }
  const exactImports = (module, expected) => {
    const actual = runtimeImports.get(module) ?? [];
    return actual.length === expected.length && expected.every(({ name, local }) => actual.some((entry) => entry.name === name && entry.local === local));
  };
  if (
    runtimeImports.size !== 2 ||
    !exactImports("../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.internal.js", [
      { name: "startMountedP4Attempt", local: "startMountedP4Attempt" },
      { name: "consumeMountedP4AttemptInvocationAdmission", local: "consumeMountedP4AttemptInvocationAdmission" },
    ]) ||
    !exactImports("./p4-provider-start-execution.js", [{ name: "runMountedP4ProviderStartLedger", local: "runMountedP4ProviderStartLedger" }]) ||
    implementation === undefined ||
    implementation.name?.text !== "startMountedP4ProviderStartFromFacade" ||
    !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    implementation.parameters.length !== 2 ||
    implementation.parameters.some((parameter, index) =>
      parameter.name.kind !== ts.SyntaxKind.Identifier ||
      parameter.name.getText(file) !== ["manifest", "lease"][index] ||
      parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined || parameter.questionToken !== undefined ||
      (parameter.modifiers?.length ?? 0) !== 0,
    ) ||
    implementation.body === undefined || implementation.body.statements.length !== 1 ||
    !ts.isReturnStatement(implementation.body.statements[0]) || implementation.body.statements[0].expression === undefined
  ) return false;
  const outer = implementation.body.statements[0].expression;
  if (!ts.isCallExpression(outer) || !ts.isIdentifier(outer.expression) || outer.expression.text !== "startMountedP4Attempt" || outer.arguments.length !== 3) return false;
  if (!ts.isIdentifier(outer.arguments[0]) || outer.arguments[0].text !== "manifest" || !ts.isIdentifier(outer.arguments[1]) || outer.arguments[1].text !== "lease") return false;
  const invocationCallback = outer.arguments[2];
  if (!ts.isArrowFunction(invocationCallback) || invocationCallback.parameters.length !== 1 || !ts.isIdentifier(invocationCallback.parameters[0].name)) return false;
  const invocation = invocationCallback.parameters[0].name.text;
  const invocationBody = invocationCallback.body;
  if (!ts.isCallExpression(invocationBody) || !ts.isIdentifier(invocationBody.expression) || invocationBody.expression.text !== "consumeMountedP4AttemptInvocationAdmission" || invocationBody.arguments.length !== 2 || !ts.isIdentifier(invocationBody.arguments[0]) || invocationBody.arguments[0].text !== invocation) return false;
  const scopeCallback = invocationBody.arguments[1];
  if (!ts.isArrowFunction(scopeCallback) || scopeCallback.parameters.length !== 1 || !ts.isIdentifier(scopeCallback.parameters[0].name)) return false;
  const scope = scopeCallback.parameters[0].name.text;
  return ts.isCallExpression(scopeCallback.body) && ts.isIdentifier(scopeCallback.body.expression) && scopeCallback.body.expression.text === "runMountedP4ProviderStartLedger" && scopeCallback.body.arguments.length === 1 && ts.isIdentifier(scopeCallback.body.arguments[0]) && scopeCallback.body.arguments[0].text === scope;
}

/** P5 has no independent ingress: its bridge may only delegate to P4c's facade. */
function isExactP5BridgeImplementation(source) {
  const file = ts.createSourceFile("p5-bridge.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const runtimeImports = new Map();
  let implementation;
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) return false;
      const clause = statement.importClause;
      if (clause === undefined || clause.isTypeOnly) continue;
      if (clause.name !== undefined || clause.namedBindings === undefined || !ts.isNamedImports(clause.namedBindings)) return false;
      runtimeImports.set(
        statement.moduleSpecifier.text,
        clause.namedBindings.elements.filter((entry) => !entry.isTypeOnly).map((entry) => ({
          name: entry.propertyName?.text ?? entry.name.text,
          local: entry.name.text,
        })),
      );
      continue;
    }
    if (ts.isTypeAliasDeclaration(statement) || ts.isInterfaceDeclaration(statement) || (ts.isExportDeclaration(statement) && statement.isTypeOnly)) continue;
    if (ts.isFunctionDeclaration(statement) && implementation === undefined) { implementation = statement; continue; }
    return false;
  }
  const imports = runtimeImports.get("./p4-provider-start.js") ?? [];
  if (
    runtimeImports.size !== 1 ||
    imports.length !== 1 ||
    imports[0]?.name !== "createP4ProviderStartFacade" ||
    imports[0]?.local !== "createP4ProviderStartFacade" ||
    implementation === undefined ||
    implementation.name?.text !== "startMountedP5PresentationCommitFromFacade" ||
    !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
    !implementation.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ||
    implementation.parameters.length !== 2 ||
    implementation.parameters.some((parameter, index) =>
      parameter.name.kind !== ts.SyntaxKind.Identifier ||
      parameter.name.getText(file) !== ["manifest", "lease"][index] ||
      parameter.initializer !== undefined || parameter.dotDotDotToken !== undefined || parameter.questionToken !== undefined ||
      (parameter.modifiers?.length ?? 0) !== 0,
    ) ||
    implementation.body === undefined || implementation.body.statements.length !== 1 ||
    !ts.isReturnStatement(implementation.body.statements[0]) || implementation.body.statements[0].expression === undefined
  ) return false;
  const returned = implementation.body.statements[0].expression;
  return (
    ts.isCallExpression(returned) &&
    ts.isPropertyAccessExpression(returned.expression) &&
    returned.expression.name.text === "start" &&
    ts.isCallExpression(returned.expression.expression) &&
    ts.isIdentifier(returned.expression.expression.expression) &&
    returned.expression.expression.expression.text === "createP4ProviderStartFacade" &&
    returned.expression.expression.arguments.length === 2 &&
    returned.expression.expression.arguments.every((argument, index) =>
      ts.isIdentifier(argument) && argument.text === ["manifest", "lease"][index],
    ) &&
    returned.arguments.length === 0
  );
}

function staticModuleMemberEnd(all, index, moduleBindings, property) {
  if (!moduleBindings.has(all[index]?.value)) return -1;
  if (all[index + 1]?.value === "." && all[index + 2]?.value === property) return index + 2;
  if (
    all[index + 1]?.value === "[" &&
    all[index + 2]?.type === "string" &&
    all[index + 2]?.value === property &&
    all[index + 3]?.value === "]"
  )
    return index + 3;
  return -1;
}

function staticReferences(source) {
  const result = [];
  const all = tokens(source);
  const erasedTypeOffsets = erasedImportTypeOffsets(source);
  const ast = ts.createSourceFile("production-source.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const inspectRuntimeLoaders = (node) => {
    const unwrapTransparentGlobalReceiver = (value) => {
      let current = value;
      while (
        ts.isParenthesizedExpression(current) ||
        ts.isAsExpression(current) ||
        ts.isSatisfiesExpression(current) ||
        ts.isNonNullExpression(current)
      )
        current = current.expression;
      return current;
    };
    const globalObject = (value) => {
      const unwrapped = unwrapTransparentGlobalReceiver(value);
      return ts.isIdentifier(unwrapped) && (unwrapped.text === "globalThis" || unwrapped.text === "global");
    };
    const globalSelfAliasAcquisition =
      (ts.isPropertyAccessExpression(node) && globalObject(node.expression) &&
        (node.name.text === "global" || node.name.text === "globalThis")) ||
      (ts.isElementAccessExpression(node) && globalObject(node.expression) &&
        ts.isStringLiteral(node.argumentExpression) &&
        (node.argumentExpression.text === "global" || node.argumentExpression.text === "globalThis"));
    const globalProcessPath = (value) => {
      const unwrapped = unwrapTransparentGlobalReceiver(value);
      return (
        (ts.isPropertyAccessExpression(unwrapped) && globalObject(unwrapped.expression) && unwrapped.name.text === "process") ||
        (ts.isElementAccessExpression(unwrapped) && globalObject(unwrapped.expression) &&
          ts.isStringLiteral(unwrapped.argumentExpression) && unwrapped.argumentExpression.text === "process")
      );
    };
    const hasGlobalProcessAcquisition =
      (ts.isPropertyAccessExpression(node) && globalObject(node.expression) && node.name.text === "process") ||
      (ts.isElementAccessExpression(node) && globalObject(node.expression) &&
        ts.isStringLiteral(node.argumentExpression) && node.argumentExpression.text === "process");
    const hasComputedGlobalMember =
      ts.isElementAccessExpression(node) &&
      globalObject(node.expression) &&
      !ts.isStringLiteral(node.argumentExpression);
    const processCapablePath = (value) => {
      const unwrapped = unwrapTransparentGlobalReceiver(value);
      return (ts.isIdentifier(unwrapped) && unwrapped.text === "process") || globalProcessPath(unwrapped);
    };
    // There is no approved production use of Node's runtime module-loader or
    // runtime reflection. Reject acquisition itself (including extraction):
    // otherwise an alias can postpone the unknown loader call beyond the
    // static scanner.
    const propertyName =
      ts.isPropertyAccessExpression(node)
        ? node.name.text
        : ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
          ? node.argumentExpression.text
          : ts.isBindingElement(node) && node.propertyName !== undefined
            ? ts.isIdentifier(node.propertyName) || ts.isStringLiteral(node.propertyName)
              ? node.propertyName.text
              : undefined
            : undefined;
    const hasComputedGlobalProcessMember =
      ts.isElementAccessExpression(node) &&
      globalProcessPath(node.expression) &&
      !ts.isStringLiteral(node.argumentExpression);
    // Do not permit a transparent direct `process` expression to be saved and
    // then used after this bounded syntax check. This is acquisition, not a
    // general provenance graph: only a declaration whose initializer itself
    // normalizes to the process capability is rejected.
    const isTransparentProcessAliasAcquisition =
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      processCapablePath(node.initializer);
    const isReflectGet =
      ts.isCallExpression(node) &&
      ((ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "Reflect" &&
        node.expression.name.text === "get") ||
        (ts.isElementAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Reflect" &&
          ts.isStringLiteral(node.expression.argumentExpression) &&
          node.expression.argumentExpression.text === "get"));
    const isObjectDescriptorOnProcess =
      ts.isCallExpression(node) &&
      node.arguments.length >= 1 &&
      processCapablePath(node.arguments[0]) &&
      (() => {
        const staticBuiltinProperty =
          node.arguments.length >= 2 &&
          ts.isStringLiteral(node.arguments[1]) &&
          node.arguments[1].text === "getBuiltinModule";
        if (
          ts.isPropertyAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Object"
        )
          return node.expression.name.text === "getOwnPropertyDescriptor" && staticBuiltinProperty;
        if (
          ts.isElementAccessExpression(node.expression) &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "Object"
        )
          return ts.isStringLiteral(node.expression.argumentExpression)
            ? node.expression.argumentExpression.text === "getOwnPropertyDescriptor" && staticBuiltinProperty
            : true;
        return false;
      })();
    if (propertyName === "getBuiltinModule" || globalSelfAliasAcquisition || hasGlobalProcessAcquisition || hasComputedGlobalMember || hasComputedGlobalProcessMember || isTransparentProcessAliasAcquisition || isReflectGet || isObjectDescriptorOnProcess)
      result.push({ kind: "dynamic_require", specifier: null, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    ts.forEachChild(node, inspectRuntimeLoaders);
  };
  const file = ast;
  inspectRuntimeLoaders(file);
  const factoryBindings = new Set();
  const requireBindings = new Set();
  const privateRequireBindings = new Set();
  const moduleBindings = new Set(["module"]);
  const requireCallIndexes = new Set();
  for (let index = 0; index < all.length; index += 1) {
    const token = all[index];
    if (token.type !== "word") continue;
    if (token.value === "import") {
      if (all[index + 1]?.value === "(" && all[index - 1]?.value !== "." && !isMethodDeclaration(all, index)) {
        const close = matchingToken(all, index + 1, "(", ")");
        const argument = all[index + 2];
        // Only a syntactically unambiguous TypeScript type query is erased.
        // Runtime member access such as `import("...").then(...)` stays
        // fail-closed as a dynamic ingress.
        if (!(argument?.type === "string" && close >= 0 && erasedTypeOffsets.has(token.offset))) {
          result.push({
            kind: "dynamic_import",
            specifier: null,
            line: token.line,
            expression: close < 0 ? null : source.slice(all[index + 1].offset + 1, all[close].offset).trim(),
          });
        }
        continue;
      }
      // TypeScript import-equals is a static CommonJS ingress, not an ES import.
      if (
        all[index + 1]?.type === "word" &&
        all[index + 2]?.value === "=" &&
        all[index + 3]?.value === "require" &&
        all[index + 4]?.value === "("
      ) {
        requireCallIndexes.add(index + 3);
        const argument = all[index + 5];
        result.push(
          argument?.type === "string"
            ? { kind: "require", specifier: argument.value, line: argument.line }
            : { kind: "dynamic_require", specifier: null, line: all[index + 3].line },
        );
        continue;
      }
      if (all[index + 1]?.type === "string") {
        result.push({ kind: "import", specifier: all[index + 1].value, line: all[index + 1].line });
        continue;
      }
      // Type-only imports are erased and therefore cannot form a production
      // authority ingress. Runtime named/default/namespace imports continue
      // through the ordinary static-import policy below.
      if (all[index + 1]?.value === "type") continue;
      for (let cursor = index + 1; cursor < all.length && all[cursor].value !== ";"; cursor += 1) {
        if (all[cursor].value === "from" && all[cursor + 1]?.type === "string") {
          const bindings = importedBindings(all, index + 1, cursor);
          if (bindings.length > 0)
            result.push({
              kind: "import",
              specifier: all[cursor + 1].value,
              line: all[cursor + 1].line,
              bindings,
            });
          if (all[cursor + 1].value === "node:module")
            for (let binding = index + 1; binding < cursor; binding += 1) {
              if (all[binding].value === "createRequire")
                factoryBindings.add(all[binding + 1]?.value === "as" ? all[binding + 2]?.value : "createRequire");
              // A direct default import is the module namespace object for this
              // scanner's createRequire/module.require member tracking.
              if (binding === index + 1 && all[binding]?.type === "word") moduleBindings.add(all[binding].value);
              if (all[binding].value === "*" && all[binding + 1]?.value === "as" && all[binding + 2]?.type === "word")
                moduleBindings.add(all[binding + 2].value);
            }
          break;
        }
      }
    }
    if (token.value === "export" && all[index + 1]?.value !== "type")
      for (let cursor = index + 1; cursor < all.length && all[cursor].value !== ";"; cursor += 1) {
        if (all[cursor].value === "from" && all[cursor + 1]?.type === "string") {
          const bindings = importedBindings(all, index + 1, cursor);
          if (bindings.length > 0)
            result.push({
              kind: "re_export",
              specifier: all[cursor + 1].value,
              line: all[cursor + 1].line,
              bindings,
            });
          break;
        }
      }
  }
  // Follow simple lexical aliases only. Anything more indirect is not recognized as a
  // require ingress; recognized factory calls with non-literals still fail closed below.
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 0; index < all.length; index += 1) {
      const name = all[index];
      const declaration = ["const", "let", "var"].includes(all[index - 1]?.value);
      // const { createRequire: factory } = require("node:module") or Module.
      if (
        name?.value === "createRequire" &&
        all[index - 1]?.value === "{" &&
        ["const", "let", "var"].includes(all[index - 2]?.value)
      ) {
        const close = matchingToken(all, index - 1, "{", "}");
        const binding = all[index + 1]?.value === ":" ? all[index + 2]?.value : "createRequire";
        const isNodeModuleRequire =
          all[close + 2]?.value === "require" &&
          all[close + 3]?.value === "(" &&
          all[close + 4]?.type === "string" &&
          all[close + 4].value === "node:module";
        const isModuleBinding = moduleBindings.has(all[close + 2]?.value);
        if (
          close >= 0 &&
          all[close + 1]?.value === "=" &&
          (isNodeModuleRequire || isModuleBinding) &&
          !factoryBindings.has(binding)
        ) {
          factoryBindings.add(binding);
          changed = true;
        }
      }
      // const { require: load } = module; follows the same policy as require().
      if (
        name?.value === "require" &&
        all[index - 1]?.value === "{" &&
        ["const", "let", "var"].includes(all[index - 2]?.value)
      ) {
        const close = matchingToken(all, index - 1, "{", "}");
        const binding = all[index + 1]?.value === ":" ? all[index + 2]?.value : "require";
        if (
          close >= 0 &&
          all[close + 1]?.value === "=" &&
          moduleBindings.has(all[close + 2]?.value) &&
          !requireBindings.has(binding)
        ) {
          requireBindings.add(binding);
          changed = true;
        }
      }
      if (name?.type !== "word" || all[index + 1]?.value !== "=") continue;
      // A private field only becomes a CommonJS ingress when it is explicitly
      // assigned an existing require binding. A private method named #require
      // is not a require call.
      if (all[index - 1]?.value === "#") {
        const rhs = all[index + 2];
        if ((rhs?.value === "require" || requireBindings.has(rhs?.value)) && all[index + 3]?.value !== "(")
          privateRequireBindings.add(name.value);
        continue;
      }
      // A declaration name or assignment target can only acquire a simple alias.
      if (!declaration && all[index - 1]?.value === ".") continue;
      const rhs = all[index + 2];
      if (!rhs) continue;
      const isNodeModuleRequire =
        rhs.value === "require" &&
        all[index + 3]?.value === "(" &&
        all[index + 4]?.type === "string" &&
        all[index + 4].value === "node:module";
      if (isNodeModuleRequire && !moduleBindings.has(name.value)) {
        moduleBindings.add(name.value);
        changed = true;
      }
      const factoryMemberEnd = staticModuleMemberEnd(all, index + 2, moduleBindings, "createRequire");
      const requireMemberEnd = staticModuleMemberEnd(all, index + 2, moduleBindings, "require");
      const isFactoryMember = factoryMemberEnd >= 0;
      const isRequireMember = requireMemberEnd >= 0;
      const isFactoryCall =
        (factoryBindings.has(rhs.value) && all[index + 3]?.value === "(") ||
        (isFactoryMember && all[factoryMemberEnd + 1]?.value === "(");
      if ((isFactoryCall || isRequireMember) && !requireBindings.has(name.value)) {
        requireBindings.add(name.value);
        changed = true;
      }
      if (!isFactoryCall && (factoryBindings.has(rhs.value) || isFactoryMember) && !factoryBindings.has(name.value)) {
        factoryBindings.add(name.value);
        changed = true;
      }
      if (moduleBindings.has(rhs.value) && all[index + 3]?.value !== "." && !moduleBindings.has(name.value)) {
        moduleBindings.add(name.value);
        changed = true;
      }
      if (
        (rhs.value === "require" || requireBindings.has(rhs.value)) &&
        all[index + 3]?.value !== "(" &&
        !requireBindings.has(name.value)
      ) {
        requireBindings.add(name.value);
        changed = true;
      }
    }
  }
  for (let index = 0; index < all.length; index += 1) {
    if (
      moduleBindings.has(all[index]?.value) &&
      all[index + 1]?.value === "[" &&
      all[index + 2]?.type !== "string"
    )
      result.push({ kind: "dynamic_require", specifier: null, line: all[index].line });
  }
  const addRequireCall = (open, line) => {
    const argument = all[open + 1];
    result.push(
      argument?.type === "string"
        ? { kind: "require", specifier: argument.value, line: argument.line }
        : { kind: "dynamic_require", specifier: null, line },
    );
  };
  for (let index = 0; index < all.length; index += 1) {
    const token = all[index];
    if (token.type !== "word") continue;
    const requireMemberEnd = staticModuleMemberEnd(all, index, moduleBindings, "require");
    if (requireMemberEnd >= 0 && all[requireMemberEnd + 1]?.value === "(") {
      const close = matchingToken(all, requireMemberEnd + 1, "(", ")");
      // module.require is an intended CommonJS ingress, except when it is a method declaration.
      if (close < 0 || all[close + 1]?.value !== "{") addRequireCall(requireMemberEnd + 1, token.line);
      continue;
    }
    const factoryMemberEnd = staticModuleMemberEnd(all, index, moduleBindings, "createRequire");
    if (factoryMemberEnd >= 0 && all[factoryMemberEnd + 1]?.value === "(") {
      const close = matchingToken(all, factoryMemberEnd + 1, "(", ")");
      if (close >= 0 && all[close + 1]?.value === "(") addRequireCall(close + 1, token.line);
      continue;
    }
    if (all[index - 1]?.value === "#") {
      if (privateRequireBindings.has(token.value) && all[index + 1]?.value === "(")
        addRequireCall(index + 1, token.line);
      continue;
    }
    if (all[index - 1]?.value === ".") continue;
    if (factoryBindings.has(token.value) && all[index + 1]?.value === "(") {
      const close = matchingToken(all, index + 1, "(", ")");
      if (close >= 0 && all[close + 1]?.value === "(") addRequireCall(close + 1, token.line);
      continue;
    }
    if (
      (token.value === "require" || requireBindings.has(token.value)) &&
      all[index + 1]?.value === "(" &&
      !requireCallIndexes.has(index)
    ) {
      const close = matchingToken(all, index + 1, "(", ")");
      // Object/class methods and function declarations are not CommonJS ingress.
      if (close < 0 || all[close + 1]?.value !== "{") addRequireCall(index + 1, token.line);
    }
  }
  const exportedBindings = [];
  for (let index = 0; index < all.length; index += 1) {
    if (all[index].value !== "export" || all[index + 1]?.value !== "{") continue;
    const close = matchingToken(all, index + 1, "{", "}");
    if (close >= 0) exportedBindings.push(...importedBindings(all, index + 1, close));
  }
  return { references: result, tokens: all, exportedBindings };
}

function isWithin(base, target) {
  const path = relative(base, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
function resolveRelative(importer, specifier) {
  const requested = resolve(dirname(importer), specifier.replaceAll("\\", "/"));
  const extension = extname(requested);
  // A dotted basename such as `*.test-support` is not a source extension;
  // always try appending recognized source extensions before replacement.
  const candidates = extension
    ? [
        requested,
        ...SOURCE_EXTENSIONS.map((item) => requested + item),
        ...SOURCE_EXTENSIONS.filter((item) => item !== extension).map(
          (item) => requested.slice(0, -extension.length) + item,
        ),
      ]
    : SOURCE_EXTENSIONS.map((item) => requested + item);
  candidates.push(...SOURCE_EXTENSIONS.map((item) => resolve(requested, `index${item}`)));
  const candidate = candidates.find(existsSync);
  return candidate ? realpathSync(candidate) : null;
}
function sourcePath(root, target) {
  const path = display(resolve(root, "host/src"), target);
  return path.endsWith(".ts") ? path : `${path}.ts`;
}
function isBanned(root, target) {
  const path = sourcePath(root, target);
  return LEGACY_MODULES.find((module) => path === module || path.startsWith(module)) ?? null;
}
function semanticAuthorityModule(root, target) {
  const path = sourcePath(root, target);
  return SEMANTIC_AUTHORITY_MODULES.find((module) => path.startsWith(module)) ?? null;
}
function isExactModule(root, path, module) {
  return sourcePath(root, path).replace(/\.ts$/, "") === module.replace(/\.ts$/, "");
}
function isP4Facade(root, path) { return isExactModule(root, path, P4_FACADE_MODULE); }
function isP4Bridge(root, path) { return isExactModule(root, path, P4_BRIDGE_MODULE); }
function isP4BFacade(root, path) { return isExactModule(root, path, P4B_FACADE_MODULE); }
function isP4BBridge(root, path) { return isExactModule(root, path, P4B_BRIDGE_MODULE); }
function isP4CFacade(root, path) { return isExactModule(root, path, P4C_FACADE_MODULE); }
function isP4CBridge(root, path) { return isExactModule(root, path, P4C_BRIDGE_MODULE); }
function isP5Facade(root, path) { return isExactModule(root, path, P5_FACADE_MODULE); }
function isP5Bridge(root, path) { return isExactModule(root, path, P5_BRIDGE_MODULE); }
function isAnyP4Bridge(root, path) { return isP4Bridge(root, path) || isP4BBridge(root, path) || isP4CBridge(root, path); }
function isAnyP4Facade(root, path) { return isP4Facade(root, path) || isP4BFacade(root, path) || isP4CFacade(root, path); }
function isP4Store(root, path) { return isExactModule(root, path, P4_STORE_MODULE); }
function isP4P5TransitionAuthorityModule(root, path) { return isExactModule(root, path, P4_P5_TRANSITION_AUTHORITY_MODULE); }
function isSemanticProductionCoordinatorAuthorityInternal(root, importer) {
  return (
    sourcePath(root, importer).replace(/\.ts$/, "") ===
    SEMANTIC_PRODUCTION_COORDINATOR_INTERNAL_MODULE.replace(/\.ts$/, "")
  );
}
function isSemanticProductionCoordinatorPublic(root, importer) {
  return (
    sourcePath(root, importer).replace(/\.ts$/, "") ===
    SEMANTIC_PRODUCTION_COORDINATOR_PUBLIC_MODULE.replace(/\.ts$/, "")
  );
}
function isSemanticProductionCoordinatorInternal(root, target) {
  return (
    sourcePath(root, target).replace(/\.ts$/, "") ===
    SEMANTIC_PRODUCTION_COORDINATOR_INTERNAL_MODULE.replace(/\.ts$/, "")
  );
}
function isTestOnlyPath(root, target) {
  return /(?:^|\/)[^/]*\.(?:test|test-support)(?:\.[^/]+)?$/.test(sourcePath(root, target));
}
function isSemanticBackend(root, target) {
  return sourcePath(root, target).startsWith(SEMANTIC_BACKEND_MODULE);
}
function violation(kind, importer, specifier, line, detail) {
  return { kind, importer, specifier, line, detail };
}

export function checkHostProductionImportBoundary({
  root = repositoryRoot,
  roots = DEFAULT_ROOTS,
  readFile = (path) => readFileSync(path, "utf8"),
} = {}) {
  const canonicalSourceRoot = realpathSync(resolve(root, "host/src"));
  const configPath = resolve(root, "host/production-artifact.config.json");
  let externalPackages = new Set();
  let declaredDynamicImports = [];
  let configError;
  if (existsSync(configPath)) {
    try {
      const closure = JSON.parse(readFile(configPath)).externalRuntimeClosure;
      if (!Array.isArray(closure?.packages) || !Array.isArray(closure.dynamicExternalImports)) throw new Error();
      externalPackages = new Set(closure.packages.filter((entry) => typeof entry === "string"));
      declaredDynamicImports = closure.dynamicExternalImports.filter(
        (entry) =>
          typeof entry?.package === "string" &&
          typeof entry.module === "string" &&
          typeof entry.expression === "string" &&
          Number.isSafeInteger(entry.occurrence) &&
          entry.occurrence >= 0 &&
          entry.package === "@cortexkit/pi-magic-context" &&
          externalPackages.has(entry.package),
      );
    } catch {
      configError = "invalid_external_runtime_closure";
    }
  }
  // The P4 facade and private bridge are mandatory production inspection roots
  // whenever present, even though ordinary application roots do not import them.
  const allRoots = [...new Set([...roots, ...P4_COMPOSITION_ROOTS.filter((path) => existsSync(resolve(root, path)))])];
  const absoluteRoots = allRoots.map((path) => resolve(root, path));
  const pending = [];
  const visited = new Set();
  const violations = [];
  if (configError)
    violations.push(
      violation("invalid_production_artifact_config", "host/production-artifact.config.json", null, 1, configError),
    );
  const dynamicOccurrences = new Map();
  for (const suppliedRoot of absoluteRoots) {
    if (!existsSync(suppliedRoot)) {
      violations.push(violation("invalid_root", display(root, suppliedRoot), null, 1, "root_source_not_found"));
      continue;
    }
    let canonicalRoot;
    try {
      canonicalRoot = realpathSync(suppliedRoot);
    } catch {
      violations.push(violation("invalid_root", display(root, suppliedRoot), null, 1, "root_source_unreadable"));
      continue;
    }
    if (!isWithin(canonicalSourceRoot, canonicalRoot)) {
      violations.push(violation("invalid_root", display(root, suppliedRoot), null, 1, "root_outside_host_src"));
      continue;
    }
    pending.push(canonicalRoot);
  }
  while (pending.length > 0) {
    const importer = pending.pop();
    if (visited.has(importer)) continue;
    visited.add(importer);
    let source;
    try {
      source = readFile(importer);
    } catch {
      violations.push(violation("unresolved_root", display(root, importer), null, 1, "root_source_unreadable"));
      continue;
    }
    const parsed = staticReferences(source);
    for (const reference of parsed.references) {
      const shownImporter = display(root, importer);
      if (reference.kind === "dynamic_import") {
        const module = sourcePath(root, importer).replace(/\.ts$/, ".js");
        const occurrenceKey = `${module}\u0000${reference.expression}`;
        const occurrence = dynamicOccurrences.get(occurrenceKey) ?? 0;
        dynamicOccurrences.set(occurrenceKey, occurrence + 1);
        const declared = declaredDynamicImports.find(
          (entry) =>
            entry.module === module && entry.expression === reference.expression && entry.occurrence === occurrence,
        );
        if (declared === undefined) {
          violations.push(
            violation(
              "unresolved_dynamic_import",
              shownImporter,
              null,
              reference.line,
              "dynamic_imports_are_not_statically_resolvable",
            ),
          );
        }
        continue;
      }
      if (reference.kind === "dynamic_require") {
        violations.push(
          violation(
            "unresolved_dynamic_require",
            shownImporter,
            null,
            reference.line,
            "dynamic_requires_are_not_statically_resolvable",
          ),
        );
        continue;
      }
      if (!reference.specifier.startsWith(".")) {
        if (PERMITTED_NODE_BUILTIN_SPECIFIERS.has(reference.specifier) || isDeclaredExternalPackage(reference.specifier, externalPackages))
          continue;
        violations.push(
          violation(
            reference.kind === "require" ? "unresolved_require_style_import" : "unresolved_nonrelative_import",
            shownImporter,
            reference.specifier,
            reference.line,
            reference.kind === "require"
              ? "require_style_specifier_not_permitted"
              : "nonrelative_specifier_not_permitted",
          ),
        );
        continue;
      }
      const requested = resolve(dirname(importer), reference.specifier.replaceAll("\\", "/"));
      if (!isWithin(canonicalSourceRoot, requested)) {
        violations.push(
          violation(
            "relative_import_escapes_host_source",
            shownImporter,
            reference.specifier,
            reference.line,
            "relative_target_outside_host_src",
          ),
        );
        continue;
      }
      const target = resolveRelative(importer, reference.specifier);
      if (!target) {
        violations.push(
          violation(
            "unresolved_relative_import",
            shownImporter,
            reference.specifier,
            reference.line,
            "relative_source_not_found",
          ),
        );
        continue;
      }
      if (!isWithin(canonicalSourceRoot, target)) {
        violations.push(
          violation(
            "relative_import_escapes_host_source",
            shownImporter,
            reference.specifier,
            reference.line,
            "relative_target_outside_host_src",
          ),
        );
        continue;
      }
      if (isTestOnlyPath(root, target)) {
        violations.push(
          violation(
            "production_reaches_test_only_module",
            shownImporter,
            reference.specifier,
            reference.line,
            "test_only_module_in_production_closure",
          ),
        );
      }
      if (isAnyP4Bridge(root, target) && !isAnyP4Facade(root, importer)) {
        const requiredFacade = isP4BBridge(root, target) ? P4B_FACADE_MODULE : P4_FACADE_MODULE;
        violations.push(
          violation(
            "unauthorized_p4_bridge_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `p4_bridge_import_requires:${requiredFacade}`,
          ),
        );
      }
      if (isP5Bridge(root, target) && !isP5Facade(root, importer)) {
        violations.push(
          violation(
            "unauthorized_p5_bridge_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `p5_bridge_import_requires:${P5_FACADE_MODULE}`,
          ),
        );
      }
      if (
        isP4P5TransitionAuthorityModule(root, target) &&
        !isSemanticProductionCoordinatorAuthorityInternal(root, importer) &&
        !isP4Store(root, importer)
      ) {
        violations.push(
          violation(
            "unauthorized_p4_p5_transition_authority_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `p4_p5_transition_authority_import_requires:${SEMANTIC_PRODUCTION_COORDINATOR_INTERNAL_MODULE}_or:${P4_STORE_MODULE}`,
          ),
        );
      }
      if (
        isSemanticProductionCoordinatorInternal(root, target) &&
        !isSemanticProductionCoordinatorPublic(root, importer) &&
        !isAnyP4Bridge(root, importer)
      ) {
        violations.push(
          violation(
            "unauthorized_coordinator_internal_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `coordinator_internal_import_requires:${SEMANTIC_PRODUCTION_COORDINATOR_PUBLIC_MODULE}`,
          ),
        );
      }
      // CommonJS has no static named-binding clause. A require of this module
      // can obtain the raw ingress, so it is sensitive by construction rather
      // than silently becoming an untracked topology edge.
      const importsSensitiveP4Ingress =
        reference.kind === "require" ||
        reference.kind === "re_export" ||
        reference.bindings?.some((binding) => P4_SENSITIVE_IMPORTS.has(binding)) ||
        reference.bindings?.includes("*") ||
        reference.bindings?.includes("default");
      if (
        isP4Store(root, target) &&
        importsSensitiveP4Ingress &&
        !isAnyP4Bridge(root, importer) &&
        !isSemanticProductionCoordinatorAuthorityInternal(root, importer)
      ) {
        violations.push(
          violation(
            "unauthorized_p4_store_ingress_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `p4_store_ingress_import_requires:${P4_BRIDGE_MODULE}_or:${P4B_BRIDGE_MODULE}`,
          ),
        );
      }
      if (isAnyP4Bridge(root, importer) && isSemanticProductionCoordinatorInternal(root, target)) {
        const allowed = isP4CBridge(root, importer)
          ? P4C_COORDINATOR_IMPORTS
          : isP4BBridge(root, importer)
            ? P4B_COORDINATOR_IMPORTS
            : P4_COORDINATOR_IMPORTS;
        const invalid = reference.kind === "re_export" || reference.bindings?.some((binding) => !allowed.has(binding));
        if (invalid)
          violations.push(violation("invalid_p4_bridge_coordinator_edge", shownImporter, reference.specifier, reference.line, "p4_bridge_may_import_only_opaque_runner_and_consumer"));
      }
      if (isAnyP4Bridge(root, importer) && isP4Store(root, target)) {
        const expectedIngress = isP4BBridge(root, importer)
          ? "claimP4MountedAttempt"
          : isP4CBridge(root, importer)
            ? null
            : "acceptP4MountedPlayerMessage";
        const exactStoreIngress =
          expectedIngress !== null &&
          reference.kind === "import" &&
          reference.bindings?.length === 1 &&
          reference.bindings[0] === expectedIngress;
        if (!exactStoreIngress)
          violations.push(violation("invalid_p4_bridge_store_edge", shownImporter, reference.specifier, reference.line, "p4_bridge_may_import_only_exact_named_store_ingress"));
      }
      const banned = isBanned(root, target);
      if (banned)
        violations.push(
          violation(
            "banned_legacy_module",
            shownImporter,
            reference.specifier,
            reference.line,
            `legacy_authority_module:${banned}`,
          ),
        );
      const authorityModule = semanticAuthorityModule(root, target);
      if (
        authorityModule &&
        !isSemanticProductionCoordinatorAuthorityInternal(root, importer) &&
        semanticAuthorityModule(root, importer) === null
      ) {
        violations.push(
          violation(
            "unauthorized_semantic_authority_import",
            shownImporter,
            reference.specifier,
            reference.line,
            `semantic_authority_import_requires:${SEMANTIC_PRODUCTION_COORDINATOR}`,
          ),
        );
      }
      if (isSemanticBackend(root, target)) {
        violations.push(
          violation(
            "banned_semantic_backend_module",
            shownImporter,
            reference.specifier,
            reference.line,
            `semantic_authority_module:${SEMANTIC_BACKEND_MODULE}`,
          ),
        );
      }
      pending.push(target);
    }
    if (isP5Bridge(root, importer)) {
      const bridgeExports = p4BridgeRuntimeExports(source);
      if (
        bridgeExports.length !== 1 ||
        bridgeExports[0]?.name !== "startMountedP5PresentationCommitFromFacade" ||
        bridgeExports[0]?.sensitive ||
        !isExactP5BridgeImplementation(source)
      )
        violations.push(
          violation("invalid_p5_bridge_implementation", display(root, importer), null, 1, "p5_bridge_must_delegate_only_to_p4c_facade"),
        );
    }
    if (isAnyP4Bridge(root, importer)) {
      const isAttemptBridge = isP4BBridge(root, importer);
      const isStartBridge = isP4CBridge(root, importer);
      const expectedExport = isStartBridge
        ? "startMountedP4ProviderStartFromFacade"
        : isAttemptBridge
          ? "claimMountedP4ProviderAttemptFromFacade"
          : "acceptMountedP4DurableTurnFromFacade";
      const shape = isAttemptBridge
        ? Object.freeze({
            facade: "claimMountedP4ProviderAttemptFromFacade",
            runner: "claimMountedP4Attempt",
            consumer: "consumeMountedP4AttemptAdmission",
            store: "claimP4MountedAttempt",
            command: false,
          })
        : undefined;
      const bridgeExports = p4BridgeRuntimeExports(source);
      if (
        bridgeExports.length !== 1 ||
        bridgeExports[0]?.name !== expectedExport ||
        bridgeExports[0]?.sensitive
      )
        violations.push(
          violation("invalid_p4_bridge_runtime_export_surface", display(root, importer), null, 1, `p4_bridge_may_export_only_${expectedExport}`),
        );
      if (!(isStartBridge ? isExactP4cBridgeImplementation(source) : isExactP4BridgeImplementation(source, shape)))
        violations.push(
          violation("invalid_p4_bridge_implementation", display(root, importer), null, 1, "p4_bridge_must_use_exact_coordinator_admission_chain"),
        );
    }
    for (const token of parsed.tokens) {
      if (token.type !== "word") continue;
      if (LEGACY_ADOPTION_FUNCTIONS.includes(token.value)) {
        violations.push(
          violation(
            "banned_legacy_adoption_function",
            display(root, importer),
            token.value,
            token.line,
            "legacy_adoption_function",
          ),
        );
      }
      if (LEGACY_BACKEND_MINT_IDENTIFIERS.includes(token.value)) {
        violations.push(
          violation(
            "banned_legacy_backend_mint_identifier",
            display(root, importer),
            token.value,
            token.line,
            "legacy_backend_mint_identifier",
          ),
        );
      }
    }
  }
  violations.sort((left, right) =>
    `${left.importer}:${left.line}:${left.kind}:${left.specifier}`.localeCompare(
      `${right.importer}:${right.line}:${right.kind}:${right.specifier}`,
    ),
  );
  return {
    gate: "host_production_import_boundary/v1",
    verdict: violations.length === 0 ? "passed" : "blocked",
    roots: absoluteRoots.map((path) => display(root, path)),
    inspectedFiles: [...visited].map((path) => display(root, path)).sort(),
    violations,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = checkHostProductionImportBoundary();
  console.log(JSON.stringify(report, null, 2));
  if (report.verdict !== "passed") process.exitCode = 2;
}
