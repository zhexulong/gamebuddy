import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = resolve(packageRoot, "package.json");
const lockfilePath = resolve(packageRoot, "..", "pnpm-lock.yaml");

const readPackageManifest = async () => JSON.parse(await readFile(packageManifestPath, "utf8"));
const readWorkspaceLockfile = async () => readFile(lockfilePath, "utf8");

test("Dialogue Web runtime boundary keeps the Vite toolchain build-only", async () => {
  const manifest = await readPackageManifest();
  const lockfile = await readWorkspaceLockfile();
  const runtimeDependencies = Object.keys(manifest.dependencies ?? {}).sort();
  const developmentDependencies = Object.keys(manifest.devDependencies ?? {}).sort();

  assert.deepEqual(runtimeDependencies, ["react", "react-dom"]);
  assert.deepEqual(
    developmentDependencies,
    ["@playwright/test", "@types/react", "@types/react-dom", "@vitejs/plugin-react", "typescript", "vite"].sort(),
  );

  // Vite and its PostCSS/nanoid transitive closure are used only by these
  // build/dev entrypoints; the Host serves the generated dist/ files.
  assert.match(manifest.scripts.build, /\bvite\s+build\b/);
  assert.match(manifest.scripts.dev, /\bvite\b/);
  for (const packageName of ["@vitejs/plugin-react", "vite", "postcss", "nanoid"]) {
    assert.equal(runtimeDependencies.includes(packageName), false, `${packageName} must not be runtime-installed`);
  }

  const importer = lockfile.match(/  dialogue-web:\n([\s\S]*?)(?=\n  host:)/)?.[1];
  assert.ok(importer, "pnpm lockfile must contain the Dialogue Web importer");
  const dependencySection = importer.match(/    dependencies:\n([\s\S]*?)(?=    devDependencies:)/)?.[1];
  const devDependencySection = importer.match(/    devDependencies:\n([\s\S]*)/)?.[1];
  assert.ok(dependencySection, "pnpm importer must contain runtime dependencies");
  assert.ok(devDependencySection, "pnpm importer must contain development dependencies");
  assert.match(dependencySection, /      react:/);
  assert.doesNotMatch(dependencySection, /      (?:'@vitejs\/plugin-react'|vite):/);
  assert.match(devDependencySection, /      '@vitejs\/plugin-react':/);
  assert.match(devDependencySection, /      vite:/);
});
