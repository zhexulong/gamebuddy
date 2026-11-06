/**
 * Parse a JavaScript source into a syntax tree, for the gates that read one.
 *
 * WHY A MODULE. `tools/check-failure-reason-codes.mjs` was shipped importing `parseJavaScript` from here and this
 * file was never committed, so the gate could not load at all - it exited 1 on `ERR_MODULE_NOT_FOUND` before reading a
 * single file, and nothing ran it, so the failure was invisible. The one authority for "where the tree-sitter wasm
 * grammars live" is this module; the gates ask it and do not each resolve the package for themselves.
 *
 * NO INSTALL, NO NETWORK. Both packages (`web-tree-sitter` and `@vscode/tree-sitter-wasm`) are already dependencies of
 * this repository, so the parser loads from `node_modules` and works offline - which is what the prelive ladder
 * requires of every gate it runs.
 *
 * THE NODE SHAPE. Callers walk `tree.rootNode`: `type`, `text`, `children`, `namedChildren`, `childForFieldName`,
 * `isMissing`, `hasError`, `startIndex` and `startPosition` (`{row, column}`, zero-based) are all web-tree-sitter's own.
 * One care is recorded where it bites `tools/lib/scope-reference-audit.mjs`: every child access hands out a FRESH JS
 * wrapper, so node identity never compares equal - key a node by its span, not by the object.
 */
import { createRequire } from "node:module";
import path from "node:path";

import { Language, Parser } from "web-tree-sitter";

const require = createRequire(import.meta.url);

/** Where `@vscode/tree-sitter-wasm` keeps its grammars, resolved once from the package rather than hard-coded. */
export const GRAMMAR_DIRECTORY = path.join(
  path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
  "wasm",
);

const parsers = new Map();

/** One initialized parser per grammar wasm, created on first use and reused afterwards. */
export function parserForGrammar(grammarWasm) {
  let parser = parsers.get(grammarWasm);
  if (parser === undefined) {
    parser = (async () => {
      await Parser.init();
      const instance = new Parser();
      instance.setLanguage(await Language.load(path.join(GRAMMAR_DIRECTORY, grammarWasm)));
      return instance;
    })();
    parsers.set(grammarWasm, parser);
  }
  return parser;
}

/**
 * `{ tree, rootNode }` for one JavaScript source.
 *
 * The tree is returned beside its root on purpose: the root node's text and spans are read out of the tree, so a
 * caller that kept only the node would be holding it past the object that owns it.
 */
export async function parseJavaScript(source, fileName = "source.mjs") {
  const parser = await parserForGrammar("tree-sitter-javascript.wasm");
  const tree = parser.parse(source);
  if (tree === null) throw new Error(`javascript_ast_parse_failed:${fileName}`);
  return { tree, rootNode: tree.rootNode };
}
