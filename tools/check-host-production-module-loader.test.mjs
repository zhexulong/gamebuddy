import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, ".");
const moduleLoader = await readFile(join(root, "lib", "host-production-module.mjs"), "utf8");
// The only tool allowed to name the mutable production generation root directly:
// it carries `host/dist/` as a literal deny-list string, not a loader or import.
const allowedProductionRootReferences = new Set(["check-text-hygiene.mjs"]);

// The mutable production root is exactly `host/dist`. `host/dist-test` and
// `host/dist-reference-check` are test infrastructure, not the generation
// pointer, so a live gate that loads the emitted test client is not a direct
// reference to production. Match the root itself, never a hyphenated sibling:
// the previous `includes("../host/dist")` test also matched `../host/dist-test/`
// and pinned the allowlist to the handful of files that existed when it was
// written, so thirteen later live gates each looked like new violations.
const PRODUCTION_ROOT_REFERENCE = /\.\.\/host\/dist(?![-\w])|["']host\/dist\//;

async function toolsReferencingProductionRoot() {
  const direct = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!(entry.isFile() && entry.name.endsWith(".mjs"))) continue;
    const source = await readFile(join(root, entry.name), "utf8");
    if (PRODUCTION_ROOT_REFERENCE.test(source)) direct.push(entry.name);
  }
  return direct.filter((name) => name !== "check-host-production-module-loader.test.mjs").sort();
}

test("normal Host runners resolve inventory-pinned production modules instead of the mutable host/dist root", async () => {
  assert.match(moduleLoader, /resolveProductionEntry/);
  assert.match(moduleLoader, /recheckProductionEntry/);
  assert.match(moduleLoader, /resolveProductionModule/);
  // Derived from the tree rather than pinned to a count or a stale name list: a
  // tool that starts reaching into the mutable production root fails here until
  // it is accounted for, and an allowance cannot outlive the reference it excuses.
  assert.deepEqual(await toolsReferencingProductionRoot(), [...allowedProductionRootReferences].sort());
});

test("the production module loader does not reconstruct current.json or a generation path", () => {
  assert.doesNotMatch(moduleLoader, /current\.json/);
  assert.doesNotMatch(moduleLoader, /generations\//);
  assert.doesNotMatch(moduleLoader, /host\/dist\//);
});
