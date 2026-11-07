import assert from "node:assert/strict";
import test from "node:test";
import { normaliseShim } from "./normalise-vendored-bundle-shims.mjs";

/**
 * The rewrite is a regex over generated code, so the cases that matter are the shapes bun emits and the shapes it does not.
 * A rewrite that touched ordinary source would be far worse than the leak it fixes.
 */

test("the pair bun emits for a bundled CommonJS dependency is rewritten", () => {
  const line =
    'var __dirname = "E:\\\\projects\\\\x\\\\node_modules\\\\.bun\\\\pkg\\\\dist", __filename = "E:\\\\projects\\\\x\\\\node_modules\\\\.bun\\\\pkg\\\\dist\\\\i.mjs";';
  const result = normaliseShim(line);
  assert.equal(result.changed, true);
  assert.match(result.text, /var __dirname = import\.meta\.dirname, __filename = import\.meta\.filename;/u);
  assert.match(result.text, /^var /u);
});

test("a lone __dirname or __filename is rewritten on its own", () => {
  assert.match(normaliseShim('var __dirname = "C:\\\\a\\\\b";').text, /import\.meta\.dirname/u);
  assert.match(normaliseShim('var __filename = "C:\\\\a\\\\b\\\\c.mjs";').text, /import\.meta\.filename/u);
});

test("a shim that is already normalised is left alone, so the step is idempotent", () => {
  const once = normaliseShim('var __dirname = "C:\\\\a\\\\b", __filename = "C:\\\\a\\\\b\\\\c.mjs";');
  const twice = normaliseShim(once.text);
  assert.equal(twice.changed, false);
  assert.equal(twice.text, once.text);
});

test("ordinary code that mentions __dirname without an inlined literal is not touched", () => {
  const source = "const here = __dirname;\nconst other = `${__dirname}/assets`;\nvar __dirname = path.dirname(file);";
  const result = normaliseShim(source);
  assert.equal(result.changed, false);
  assert.equal(result.text, source);
});
