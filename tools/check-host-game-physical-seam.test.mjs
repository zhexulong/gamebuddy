import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkHostGamePhysicalSeam } from "./check-host-game-physical-seam.mjs";

async function withFixture(files, run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-game-seam-"));
  try {
    await Promise.all(Object.entries(files).map(async ([path, source]) => {
      const target = join(root, path);
      await mkdir(target.slice(0, target.lastIndexOf("/")), { recursive: true });
      await writeFile(target, source);
    }));
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const roots = {
  "host/src/bootstrap/entry.ts": "export { value } from '../games/stardew/value.js';\n",
  "host/src/containment/reverse.ts": "import '../games/stardew/value.js';\n",
  "host/src/composition/reverse.ts": "export * from '../games/stardew/value.js';\n",
    "host/src/games/stardew/value.ts": "export const value = 1;\n",
};

test("passes the relocated production graph and allows the narrow Stardew containment contract", () => {
  const report = checkHostGamePhysicalSeam();
  assert.equal(report.verdict, "passed");
  assert.equal(report.violations.length, 0);
});

test("reports exact generic-to-game and Stardew raw-module violations", async () => {
  await withFixture({
    ...roots,
    "host/src/games/stardew/raw.ts": [
      "import '../../windows-stardew-bootstrap-guardian/index.js';",
      "import 'node:child_process';",
    ].join("\n"),
    "host/src/windows-stardew-bootstrap-guardian/index.ts": "export const raw = true;\n",
  }, (root) => {
    const report = checkHostGamePhysicalSeam({ root });
    assert.equal(report.verdict, "blocked");
    assert.deepEqual(report.violations.map(({ kind, importer, specifier, line, detail }) => ({ kind, importer: importer.replace(/^.*?host\//, "host/"), specifier, line, detail })), [
      { kind: "game_imports_desktop_raw_module", importer: "host/src/games/stardew/raw.ts", specifier: "node:child_process", line: 2, detail: "stardew_must_not_import_desktop_guardian_process_or_native_modules" },
      { kind: "generic_layer_imports_game", importer: "host/src/bootstrap/entry.ts", specifier: "../games/stardew/value.js", line: 1, detail: "bootstrap_containment_and_composition_must_not_import_games" },
      { kind: "generic_layer_imports_game", importer: "host/src/composition/reverse.ts", specifier: "../games/stardew/value.js", line: 1, detail: "bootstrap_containment_and_composition_must_not_import_games" },
      { kind: "generic_layer_imports_game", importer: "host/src/containment/reverse.ts", specifier: "../games/stardew/value.js", line: 1, detail: "bootstrap_containment_and_composition_must_not_import_games" },
      { kind: "game_imports_desktop_raw_module", importer: "host/src/games/stardew/raw.ts", specifier: "../../windows-stardew-bootstrap-guardian/index.js", line: 1, detail: "stardew_must_not_import_desktop_guardian_process_or_native_modules" },
    ]);
  });
});

test("excludes test and test-support sources from production traversal", async () => {
  await withFixture({
    "host/src/games/stardew/real.ts": "export const value = 1;\n",
    "host/src/games/stardew/ignored.test.ts": "import '../../bootstrap/entry.js';\n",
    "host/src/games/stardew/ignored.test-support.ts": "import '../../bootstrap/entry.js';\n",
    "host/src/games/stardew/ignored.test-support-internal.ts": "import '../../bootstrap/entry.js';\n",
  }, (root) => {
    const report = checkHostGamePhysicalSeam({ root });
    assert.equal(report.verdict, "passed");
    assert.deepEqual(report.inspectedFiles, ["host/src/games/stardew/real.ts"]);
  });
});

test("resolves supported source extensions, index modules, require and import-equals edges", async () => {
  await withFixture({
    "host/src/games/stardew/entry.ts": [
      "import value from './folder/index.mjs';",
      "import alias = require('./alias.cjs');",
      "export { value as other } from './other.jsx';",
      "const loaded = require('./loaded.mts');",
    ].join("\n"),
    "host/src/games/stardew/folder/index.mjs": "export default 1;\n",
    "host/src/games/stardew/alias.cjs": "module.exports = 1;\n",
    "host/src/games/stardew/other.jsx": "export const value = 1;\n",
    "host/src/games/stardew/loaded.mts": "export const value = 1;\n",
  }, (root) => assert.equal(checkHostGamePhysicalSeam({ root }).verdict, "passed"));
});

test("fails closed for unresolved, ambiguous, escaped, and non-relative internal edges", async () => {
  await withFixture({
    "host/src/games/stardew/entry.ts": [
      "import './missing.js';",
      "import './ambiguous.js';",
      "import '../../../outside.js';",
      "import 'host/internal.js';",
    ].join("\n"),
    "host/src/games/stardew/ambiguous.ts": "export const a = 1;\n",
    "host/src/games/stardew/ambiguous.js": "export const a = 1;\n",
  }, (root) => {
    const report = checkHostGamePhysicalSeam({ root });
    assert.equal(report.verdict, "blocked");
    assert.deepEqual(report.violations.map(({ kind }) => kind), [
      "unresolved_relative_import", "ambiguous_relative_import", "relative_import_escapes_source_root", "unresolved_non_relative_import",
    ]);
  });
});

test("fails closed on dynamic imports and require calls in the inspected production seam", async () => {
  await withFixture({
    "host/src/games/stardew/dynamic.ts": "export async function load(name: string) { return import(name); }\n",
  }, (root) => {
    const report = checkHostGamePhysicalSeam({ root });
    assert.deepEqual(report.violations.map(({ importer, ...rest }) => ({ importer: importer.replace(/^.*?host\//, "host/"), ...rest })), [{ kind: "unresolved_dynamic_import", importer: "host/src/games/stardew/dynamic.ts", specifier: null, target: null, line: 1, detail: "dynamic_imports_are_not_statically_resolvable" }]);
  });
});
