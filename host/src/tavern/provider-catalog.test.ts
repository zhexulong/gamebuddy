import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import { TAVERN_PI_API_SHAPES, isTavernPiApi } from "./provider-catalog.js";

/**
 * The catalog claims its shape list IS the set of APIs Pi can speak, and a player relies on
 * that claim when they pick a shape for their own endpoint (design/28 §1). A hand-copied list
 * makes that claim false the moment pi adds or removes an adapter — which is how
 * `azure-openai-responses` and `pi-messages` went missing and left Azure users unable to
 * configure their endpoint at all.
 *
 * So the list is pinned against the installed runtime instead of trusted: pi-ai registers
 * each adapter it actually builds in `BUILTIN_APIS`, and that registry is the authority.
 */

/** The package root of a file or directory, found by walking up to its `package.json`. */
function packageRootOf(entry: string): string {
  // A directory IS a candidate root; a file's root is above it. Checking the path itself
  // first covers both, so a directory never starts the walk one level too high.
  let directory = entry;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(directory, "package.json"))) return directory;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`no package.json at or above ${entry}`);
}

/**
 * The installed package directory, found by the ordinary `node_modules` lookup.
 *
 * `require.resolve` cannot be used: pi-coding-agent's `exports` map has no root entry, so
 * Node refuses the bare specifier ("No \"exports\" main defined"). Searching the ancestor
 * `node_modules` directories is exactly how Node itself finds it, without consulting the
 * map that blocks the resolver.
 */
function installedPackage(name: string): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, "node_modules", name);
    if (existsSync(candidate)) return packageRootOf(realpathSync(candidate));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error(`cannot find installed package ${name}`);
}

/** The installed pi-ai package, which pi-coding-agent links beside itself in the store. */
function piAiDirectory(): string {
  // pnpm links a package's dependencies beside it, so pi-ai is a sibling of pi-coding-agent
  // inside the store entry — this needs no store-hash knowledge.
  return packageRootOf(realpathSync(join(installedPackage("@earendil-works/pi-coding-agent"), "..", "pi-ai")));
}

/** The API ids pi-ai registers adapters for at runtime. */
function piAiRegisteredApis(): readonly string[] {
  const compat = readFileSync(join(piAiDirectory(), "dist", "compat.js"), "utf8");
  const start = compat.indexOf("const BUILTIN_APIS = [");
  assert.notEqual(start, -1, "pi-ai no longer declares a BUILTIN_APIS registry; the shape list has no authority to pin against");
  const end = compat.indexOf("];", start);
  assert.notEqual(end, -1, "pi-ai's BUILTIN_APIS registry is malformed");
  const ids = [...compat.slice(start, end).matchAll(/\["([a-z0-9-]+)",/gu)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  assert.ok(ids.length > 0, "pi-ai's BUILTIN_APIS registry parsed to zero ids");
  return ids;
}

test("the catalog's API shapes are exactly the ones the installed Pi runtime registers", () => {
  const registered = piAiRegisteredApis();
  assert.deepEqual(
    [...TAVERN_PI_API_SHAPES].sort(),
    [...registered].sort(),
    "the catalog's shape list drifted from the installed pi-ai adapters",
  );
});

test("every catalog shape is admitted by the catalog's own guard, and nothing else is", () => {
  for (const shape of TAVERN_PI_API_SHAPES) {
    assert.equal(isTavernPiApi(shape), true, `${shape} must be admitted`);
  }
  for (const rejected of ["", "openai", "OPENAI-COMPLETIONS", "openai_completions", "not-a-shape"]) {
    assert.equal(isTavernPiApi(rejected), false, `${JSON.stringify(rejected)} must be refused`);
  }
});
