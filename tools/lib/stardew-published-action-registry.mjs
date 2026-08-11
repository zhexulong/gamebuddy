import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// pnpm may hoist TypeScript to the workspace root rather than create a
// package-local host/node_modules symlink. Resolve through the workspace root
// while still retaining an explicit package anchor for direct Host installs.
const requireFromWorkspace = createRequire(resolve(root, "package.json"));
const requireFromHost = createRequire(resolve(root, "host", "package.json"));
let ts;
try {
  ts = requireFromWorkspace("typescript");
} catch (workspaceError) {
  try {
    ts = requireFromHost("typescript");
  } catch {
    throw workspaceError;
  }
}

function fail(code) {
  throw new Error(`stardew_published_action_registry_${code}`);
}

function isIdentifier(node, text) {
  return ts.isIdentifier(node) && node.text === text;
}

function stringArgument(call, index = 0) {
  const node = call.arguments[index];
  if (!node || !ts.isStringLiteral(node)) fail("invalid_action_identifier");
  return node.text;
}

function variableInitializer(source, name) {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (isIdentifier(declaration.name, name) && declaration.initializer) return declaration.initializer;
    }
  }
  fail(`missing_${name}`);
}

function objectFreezeArray(initializer, name) {
  if (!ts.isCallExpression(initializer)
    || !ts.isPropertyAccessExpression(initializer.expression)
    || !isIdentifier(initializer.expression.expression, "Object")
    || initializer.expression.name.text !== "freeze"
    || initializer.arguments.length !== 1
    || !ts.isArrayLiteralExpression(initializer.arguments[0])) fail(`invalid_${name}`);
  return initializer.arguments[0];
}

function assertPublishedProjection(initializer) {
  if (!ts.isCallExpression(initializer)
    || !ts.isPropertyAccessExpression(initializer.expression)
    || !isIdentifier(initializer.expression.expression, "Object")
    || initializer.expression.name.text !== "freeze"
    || initializer.arguments.length !== 1) fail("invalid_published_projection");
  const filter = initializer.arguments[0];
  if (!ts.isCallExpression(filter)
    || !ts.isPropertyAccessExpression(filter.expression)
    || !isIdentifier(filter.expression.expression, "STARDEW_ACTION_REGISTRY")
    || filter.expression.name.text !== "filter"
    || filter.arguments.length !== 1
    || !isIdentifier(filter.arguments[0], "isMaterializablePublishedAction")) fail("invalid_published_projection");
}

/**
 * Parse the real TypeScript registry AST instead of a source-text token/regex.
 * This is verification metadata only; it never grants a capability or accepts
 * a receipt. The caller must keep live closure evidence separate.
 */
export async function readPublishedStardewActionIds({ registryPath = resolve(root, "host", "src", "action-registry.ts") } = {}) {
  const sourceText = await readFile(registryPath, "utf8");
  const source = ts.createSourceFile(registryPath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (source.parseDiagnostics.length > 0) fail("parse_failed");
  assertPublishedProjection(variableInitializer(source, "PUBLISHED_STARDEW_ACTIONS"));
  const entries = objectFreezeArray(variableInitializer(source, "STARDEW_ACTION_REGISTRY"), "action_registry");
  const actionIds = [];
  for (const entry of entries.elements) {
    if (!ts.isCallExpression(entry) || !isIdentifier(entry.expression, "publishedAction")) continue;
    const actionId = stringArgument(entry);
    if (!/^[a-z][a-z0-9_]{1,127}$/.test(actionId)) fail("invalid_action_identifier");
    actionIds.push(actionId);
  }
  if (actionIds.length === 0 || new Set(actionIds).size !== actionIds.length) fail("invalid_published_set");
  return Object.freeze(actionIds);
}
