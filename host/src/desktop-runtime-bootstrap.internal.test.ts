import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const sourceRoot = findSourceRoot(sourceDirectory);

test("desktop bootstrap helper remains private and has no entrypoint", async () => {
  const source = await readFile(resolve(sourceRoot, "desktop-runtime-bootstrap.internal.ts"), "utf8");

  assert.match(source, /export async function runDesktopHostBootstrap\(moduleDirectory: string\)/);
  assert.doesNotMatch(source, /import.meta.main/);
  assert.doesNotMatch(source, /desktop-host-entry.internal.js/);
});

function findSourceRoot(directory: string): string {
  let candidate = directory;
  while (!existsSync(resolve(candidate, "src"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("desktop_bootstrap_helper_test_source_not_found");
    candidate = parent;
  }
  return resolve(candidate, "src");
}
