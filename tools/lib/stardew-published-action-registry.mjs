import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(resolve(root, "host", "package.json"));
const ts = require("typescript");

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

function unwrapExpression(node) {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
  return node;
}

function objectFreezeArray(initializer, name) {
  initializer = unwrapExpression(initializer);
  if (
    !ts.isCallExpression(initializer) ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    !isIdentifier(initializer.expression.expression, "Object") ||
    initializer.expression.name.text !== "freeze" ||
    initializer.arguments.length !== 1 ||
    !ts.isArrayLiteralExpression(initializer.arguments[0])
  )
    fail(`invalid_${name}`);
  return initializer.arguments[0];
}

function assertPublishedProjection(initializer) {
  initializer = unwrapExpression(initializer);
  if (
    !ts.isCallExpression(initializer) ||
    !ts.isPropertyAccessExpression(initializer.expression) ||
    !isIdentifier(initializer.expression.expression, "Object") ||
    initializer.expression.name.text !== "freeze" ||
    initializer.arguments.length !== 1
  )
    fail("invalid_published_projection");
  const filter = initializer.arguments[0];
  if (
    !ts.isCallExpression(filter) ||
    !ts.isPropertyAccessExpression(filter.expression) ||
    !isIdentifier(filter.expression.expression, "STARDEW_ACTION_REGISTRY") ||
    filter.expression.name.text !== "filter" ||
    filter.arguments.length !== 1
  )
    fail("invalid_published_projection");
  const predicate = filter.arguments[0];
  if (
    !ts.isArrowFunction(predicate) ||
    predicate.parameters.length !== 1 ||
    !ts.isCallExpression(predicate.body) ||
    !isIdentifier(predicate.body.expression, "isMaterializablePublishedAction") ||
    predicate.body.arguments.length !== 1 ||
    !ts.isIdentifier(predicate.body.arguments[0]) ||
    !ts.isIdentifier(predicate.parameters[0].name) ||
    predicate.body.arguments[0].text !== predicate.parameters[0].name.text
  )
    fail("invalid_published_projection");
}

/**
 * Parse the real TypeScript registry AST instead of a source-text token/regex.
 * This is verification metadata only; it never grants a capability or accepts
 * a receipt. The caller must keep live closure evidence separate.
 */
export async function readPublishedStardewActionIds({
  registryPath = resolve(root, "host", "src", "action-registry.ts"),
} = {}) {
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
