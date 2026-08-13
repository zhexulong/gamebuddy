import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);
const grammarWasmPath = require.resolve("@vscode/tree-sitter-wasm/wasm/tree-sitter-c-sharp.wasm");
const grammarPackagePath = require.resolve("@vscode/tree-sitter-wasm/package.json");
const grammarPackage = require(grammarPackagePath);
const runtimePackagePath = require.resolve("web-tree-sitter");
const runtimePackage = JSON.parse(await readFile(path.join(path.dirname(runtimePackagePath), "package.json"), "utf8"));

let parserPromise;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sourceBytes(source) {
  return Buffer.from(source, "utf8");
}

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

async function csharpParser() {
  parserPromise ??= (async () => {
    await Parser.init();
    const parser = new Parser();
    parser.setLanguage(await Language.load(grammarWasmPath));
    return parser;
  })();
  return parserPromise;
}

// `web-tree-sitter` reports JS-string offsets for this grammar/runtime, while
// report locators are deliberately UTF-8 byte offsets. Never feed a parser
// offset directly to Buffer.subarray: non-ASCII source before a node would
// otherwise shift the reported slice and its hash.
function byteOffset(source, stringOffset) {
  return Buffer.byteLength(source.slice(0, stringOffset), "utf8");
}

function span(node, source) {
  return Object.freeze({
    startByte: byteOffset(source, node.startIndex),
    endByte: byteOffset(source, node.endIndex),
    startPoint: Object.freeze({ row: node.startPosition.row, column: node.startPosition.column }),
    endPoint: Object.freeze({ row: node.endPosition.row, column: node.endPosition.column }),
  });
}

function syntaxLocator(relativePath, node, source) {
  return Object.freeze({
    relativePath,
    nodeKind: node.type,
    ...span(node, source),
    sliceSha256: sha256(slice(node, source)),
  });
}
function sourceLocator(relativePath, node, source) {
  const { nodeKind, ...locator } = syntaxLocator(relativePath, node, source);
  return Object.freeze(locator);
}

function field(node, name) {
  return node.childForFieldName(name) ?? null;
}

function slice(node, source) {
  return node ? source.slice(node.startIndex, node.endIndex) : null;
}

function declarationRecord(node, source, relativePath, owner = null) {
  const nameNode = field(node, "name");
  const bodyNode = field(node, "body");
  const typeNode = field(node, "type");
  const parametersNode = field(node, "parameters");
  const basesNode = field(node, "bases");
  const modifiers = node.children.filter((child) => child.type === "modifier").map((child) => slice(child, source));
  return Object.freeze({
    declarationSyntaxKind: node.type,
    locator: syntaxLocator(relativePath, node, source),
    ownerDeclarationLocator: owner,
    identifierSyntax: slice(nameNode, source),
    modifiersSyntax: Object.freeze(modifiers),
    typeSyntax: slice(typeNode, source),
    parametersSyntax: slice(parametersNode, source),
    baseListSyntax: slice(basesNode, source),
    bodyLocator: bodyNode ? syntaxLocator(relativePath, bodyNode, source) : null,
  });
}

const DECLARATION_KINDS = new Set([
  "namespace_declaration",
  "file_scoped_namespace_declaration",
  "class_declaration",
  "struct_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "method_declaration",
  "constructor_declaration",
  "property_declaration",
  "field_declaration",
  "event_declaration",
  "event_field_declaration",
]);

const CONTROL_KINDS = new Set(["if_statement", "switch_statement", "return_statement"]);

function isMemberAccess(node) {
  return node?.type === "member_access_expression";
}

function collectSyntax(root, source, relativePath) {
  const declarations = [];
  const controlSyntax = [];
  const invocationSyntax = [];
  const assignmentSyntax = [];
  const errors = [];
  const missing = [];

  function visit(node, ownerDeclaration = null) {
    if (node.isMissing) missing.push(syntaxLocator(relativePath, node, source));
    if (node.type === "ERROR") errors.push(syntaxLocator(relativePath, node, source));

    let nextOwner = ownerDeclaration;
    if (DECLARATION_KINDS.has(node.type)) {
      const declaration = declarationRecord(node, source, relativePath, ownerDeclaration);
      declarations.push(declaration);
      nextOwner = declaration.locator;
    }

    if (CONTROL_KINDS.has(node.type)) {
      controlSyntax.push(
        Object.freeze({
          syntaxKind: node.type,
          ownerDeclarationLocator: ownerDeclaration,
          locator: syntaxLocator(relativePath, node, source),
        }),
      );
    }

    if (node.type === "invocation_expression") {
      const functionNode = field(node, "function");
      const argumentsNode = field(node, "arguments");
      invocationSyntax.push(
        Object.freeze({
          syntaxKind: "invocation_expression",
          ownerDeclarationLocator: ownerDeclaration,
          locator: syntaxLocator(relativePath, node, source),
          calleeLocator: functionNode ? sourceLocator(relativePath, functionNode, source) : null,
          calleeSyntaxKind: functionNode?.type ?? null,
          calleeSyntaxSha256: functionNode ? sha256(slice(functionNode, source)) : null,
          argumentsSyntaxKind: argumentsNode?.type ?? null,
          argumentsSyntaxSha256: argumentsNode ? sha256(slice(argumentsNode, source)) : null,
          argumentSyntaxCount: argumentsNode?.namedChildCount ?? 0,
        }),
      );
    }

    if (node.type === "assignment_expression") {
      const targetNode = field(node, "left");
      const rightNode = field(node, "right");
      const operatorNode = node.children.find(
        (child) => /=$/.test(child.type) || ["+=", "-=", "*=", "/=", "%=", "??="].includes(slice(child, source)),
      );
      assignmentSyntax.push(
        Object.freeze({
          syntaxKind: "assignment_expression",
          ownerDeclarationLocator: ownerDeclaration,
          locator: syntaxLocator(relativePath, node, source),
          targetLocator: targetNode ? sourceLocator(relativePath, targetNode, source) : null,
          targetSyntaxKind: targetNode?.type ?? null,
          targetSyntaxSha256: targetNode ? sha256(slice(targetNode, source)) : null,
          memberAccessAssignmentTargetSyntax: isMemberAccess(targetNode),
          operatorSyntax: operatorNode ? slice(operatorNode, source) : null,
          rightSyntaxKind: rightNode?.type ?? null,
          rightSyntaxSha256: rightNode ? sha256(slice(rightNode, source)) : null,
        }),
      );
    }

    for (const child of node.namedChildren) visit(child, nextOwner);
  }

  visit(root);
  return Object.freeze({
    declarations: Object.freeze(declarations),
    controlSyntax: Object.freeze(controlSyntax),
    invocationSyntax: Object.freeze(invocationSyntax),
    assignmentSyntax: Object.freeze(assignmentSyntax),
    errorNodes: Object.freeze(errors),
    missingNodes: Object.freeze(missing),
  });
}

export async function parseCSharpSyntaxStructure({ source, relativePath = "<memory>" } = {}) {
  if (typeof source !== "string") fail("csharp_source_required", "source must be a string.");
  const parser = await csharpParser();
  const tree = parser.parse(source);
  const collected = collectSyntax(tree.rootNode, source, relativePath);
  return Object.freeze({
    parser: Object.freeze({
      runtime: "web-tree-sitter",
      runtimeVersion: runtimePackage.version,
      grammar: "@vscode/tree-sitter-wasm/tree-sitter-c-sharp.wasm",
      grammarPackageVersion: grammarPackage.version,
      grammarWasmSha256: sha256(await readFile(grammarWasmPath)),
    }),
    sourceFile: Object.freeze({
      relativePath,
      byteLength: Buffer.byteLength(source),
      sha256: sha256(sourceBytes(source)),
    }),
    parse: Object.freeze({
      rootSyntaxKind: tree.rootNode.type,
      hasError: tree.rootNode.hasError,
      errorNodes: collected.errorNodes,
      missingNodes: collected.missingNodes,
    }),
    declarations: collected.declarations,
    controlSyntax: collected.controlSyntax,
    invocationSyntax: collected.invocationSyntax,
    assignmentSyntax: collected.assignmentSyntax,
  });
}

export function assertCSharpSyntaxParseClean(report) {
  if (report.parse.hasError || report.parse.errorNodes.length > 0 || report.parse.missingNodes.length > 0) {
    fail("csharp_syntax_parse_invalid", "Tree-sitter reported syntax errors or missing nodes.", report.parse);
  }
}
