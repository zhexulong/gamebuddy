import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, ".");
const moduleLoader = await readFile(join(root, "lib", "host-production-module.mjs"), "utf8");
const allowedDirectReferences = new Set([
  "check-text-hygiene.mjs", // literal deny-list strings, not a loader/import
  "run-stardew-portfolio-observe-smoke.mjs", // dedicated dist-portfolio topology
]);

test("normal Host runners resolve inventory-pinned production modules instead of mutable host/dist", async () => {
  assert.match(moduleLoader, /resolveProductionEntry/);
  assert.match(moduleLoader, /recheckProductionEntry/);
  assert.match(moduleLoader, /resolveProductionModule/);
  const direct = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
    const source = await readFile(join(root, entry.name), "utf8");
    if (source.includes("../host/dist") || source.includes('"host/dist/') || source.includes("'host/dist/"))
      direct.push(entry.name);
  }
  assert.deepEqual(
    direct.filter((name) => name !== "check-host-production-module-loader.test.mjs").sort(),
    [...allowedDirectReferences].sort(),
  );
});

test("the production module loader does not reconstruct current.json or a generation path", () => {
  assert.doesNotMatch(moduleLoader, /current\.json/);
  assert.doesNotMatch(moduleLoader, /generations\//);
  assert.doesNotMatch(moduleLoader, /host\/dist\//);
});
