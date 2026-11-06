/**
 * The JavaScript/TypeScript parsing seam the static gates share.
 *
 * Two gates now read this tree's sources as syntax trees (`check-scope-references`, `check-failure-reason-codes`), and a
 * second copy of the tree-sitter bootstrap would be a second answer to "which grammar parses `.mjs`" - the kind of
 * duplicate that agrees until one of them is edited. The grammar table and the wasm lookup therefore live here once.
 *
 * A file whose extension is absent from the table THROWS rather than falling back to the JavaScript grammar: a `.tsx`
 * file parsed as JavaScript is a tree full of recovery nodes, and a gate that reads it reports on a shape nobody wrote.
 */
import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";

/** Extension -> grammar wasm, for every extension this tree's static gates parse. */
export const JAVASCRIPT_GRAMMARS = Object.freeze({
  ".cjs": "tree-sitter-javascript.wasm",
  ".js": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cts": "tree-sitter-typescript.wasm",
  ".mts": "tree-sitter-typescript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
});

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

/** The grammar wasm for a file name, or `null` when this seam does not parse that extension. */
export function grammarWasmFor(fileName) {
  return JAVASCRIPT_GRAMMARS[path.extname(fileName).toLowerCase()] ?? null;
}

/** Parse `source` with the grammar its file name selects. The caller owns the tree it receives. */
export async function parseJavaScript(source, fileName) {
  const grammarWasm = grammarWasmFor(fileName);
  if (grammarWasm === null) throw new Error(`no grammar for ${JSON.stringify(fileName)}`);
  const parser = await parserFor(grammarWasm);
  return parser.parse(source);
}
