import assert from "node:assert/strict";
import test from "node:test";
import { inspectBundleText, isBuildMachinePath } from "./check-vendored-bundle-leaks.mjs";

/**
 * The gate is only worth its lines if it finds the real defect and nothing else. Both directions are measured here, because
 * the first version of the matcher had exactly one of each wrong: it missed a path a bundler writes with doubled
 * separators, and it reported 352 wasm byte escapes as absolute paths.
 */

const REPOSITORY = "E:\\projects\\ai-game-companion";
const HOME = "C:\\Users\\long";

const inspect = (text) => inspectBundleText({ text, file: "bundle.js", home: HOME, repository: REPOSITORY });

test("a build-machine path written with doubled separators is blocking", () => {
  // This is the shape `bun build` produced, and the shape the first matcher missed entirely.
  const line =
    'var __filename = "E:\\\\projects\\\\ai-game-companion\\\\vendor\\\\magic-context\\\\node_modules\\\\.bun\\\\index.js";';
  const result = inspect(line);
  assert.equal(result.blocking.length, 1, JSON.stringify(result));
  assert.match(result.blocking[0].value, /ai-game-companion/u);
});

test("a raw single-separator build-machine path is blocking too", () => {
  const result = inspect('var __dirname = "E:\\projects\\ai-game-companion\\vendor\\x";');
  assert.equal(result.blocking.length, 1, JSON.stringify(result));
});

test("wasm byte escapes are not paths, and are neither blocking nor reported", () => {
  // Measured noise: 352 findings of this shape before the escape filter existed.
  const result = inspect('var s = "r:\\x00\\f \\x03 \\x066\\x02\\x04 \\x03A\\x016";');
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.reported, []);
});

test("a regex literal is not a path, so it is not reported at all", () => {
  // After normalisation the pattern's `[` ends the segment run, so nothing path-shaped remains. A library matching user
  // paths is not a defect of this product, and reporting it would teach the reader to ignore the gate.
  const result = inspect("var strip = /C:\\\\Users\\\\[^\\\\]+/u;");
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.reported, []);
});

test("an absolute path outside the repository and home is reported, not blocking", () => {
  // A Steam library path is a fact about a machine, but not *this* build machine's layout; a human decides.
  const result = inspect('const root = "D:\\steam\\steamapps\\common\\Stardew Valley";');
  assert.deepEqual(result.blocking, []);
  assert.equal(result.reported.length, 1, JSON.stringify(result.reported));
});

test("a template hole is not an inlined path", () => {
  const result = inspect("const p = `C:\\Users\\${user}\\AppData`;");
  assert.deepEqual(result.blocking, []);
  assert.deepEqual(result.reported, []);
});

test("the blocking classes are the ones that never mean anything useful in shipped code", () => {
  assert.equal(isBuildMachinePath(`${REPOSITORY}\\vendor\\x`, { repository: REPOSITORY, home: HOME }), true);
  assert.equal(isBuildMachinePath(`${HOME}\\AppData`, { repository: REPOSITORY, home: HOME }), true);
  assert.equal(isBuildMachinePath("C:\\x\\node_modules\\y", { repository: REPOSITORY, home: HOME }), true);
  assert.equal(isBuildMachinePath("/home/runner/work/x", { repository: REPOSITORY, home: HOME }), false);
  assert.equal(isBuildMachinePath("D:\\steam\\steamapps\\common", { repository: REPOSITORY, home: HOME }), false);
});

test("a POSIX runner home is reported, since no path there can be the player's", () => {
  const result = inspect('const p = "/home/runner/work/gamebuddy/gamebuddy/src";');
  assert.equal(result.reported.length + result.blocking.length, 1, JSON.stringify(result));
});
