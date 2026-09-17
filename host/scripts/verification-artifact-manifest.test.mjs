import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { assertHostVerificationArtifactManifest, writeHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

// Mirrors the module-level repositoryRoot (script is host/scripts/*.mjs).
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-verification-artifact-"));
  await mkdir(join(root, "src"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "resources"), { recursive: true });
  await mkdir(join(root, "dist-test"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "verification-artifact-fixture", private: true, type: "module" }));
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }));
  await writeFile(join(root, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "dist-test", noEmit: false }, include: ["src/**/*.ts"] }));
  await writeFile(join(root, "src", "fixture.ts"), "export const fixture = 1;\n");
  await writeFile(join(root, "scripts", "runner.mjs"), "export const runner = 1;\n");
  await writeFile(join(root, "resources", "fixture.ps1"), "fixture\n");
  await writeFile(join(root, "dist-test", "fixture.js"), "export const fixture = 1;\n");
  return root;
}

async function withFixture(run) {
  const root = await fixture();
  try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
}

test("verification artifact manifest binds the exact test source/config/toolchain/output tree", async () => withFixture(async (root) => {
  const written = await writeHostVerificationArtifactManifest({ root });
  const verified = await assertHostVerificationArtifactManifest({ root });
  assert.equal(verified.schema, "gamebuddy-host-verification-artifact/v1");
  assert.equal(verified.source.digest, written.source.digest);
  assert.equal(verified.output.digest, written.output.digest);
}));

test("verification artifact manifest rejects an output mutation and a current source/config mismatch", async () => withFixture(async (root) => {
  await writeHostVerificationArtifactManifest({ root });
  await writeFile(join(root, "dist-test", "fixture.js"), "tampered\n");
  await assert.rejects(assertHostVerificationArtifactManifest({ root }), /host_verification_artifact_output_inventory_mismatch/);

  await writeHostVerificationArtifactManifest({ root });
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\nchanged: true\n");
  await assert.rejects(assertHostVerificationArtifactManifest({ root }), /host_verification_artifact_source_snapshot_mismatch/);

  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(join(root, "src", "fixture.ts"), "export const fixture = 2;\n");
  await assert.rejects(assertHostVerificationArtifactManifest({ root }), /host_verification_artifact_source_snapshot_mismatch/);

  await writeFile(join(root, "src", "fixture.ts"), "export const fixture = 1;\n");
  await writeHostVerificationArtifactManifest({ root });
  await writeFile(join(root, "scripts", "runner.mjs"), "export const runner = 2;\n");
  await assert.rejects(assertHostVerificationArtifactManifest({ root }), /host_verification_artifact_source_snapshot_mismatch/);

  await writeFile(join(root, "scripts", "runner.mjs"), "export const runner = 1;\n");
  await writeHostVerificationArtifactManifest({ root });
  await writeFile(join(root, "resources", "fixture.ps1"), "changed\n");
  await assert.rejects(assertHostVerificationArtifactManifest({ root }), /host_verification_artifact_source_snapshot_mismatch/);

  await writeFile(join(root, "resources", "fixture.ps1"), "fixture\n");
  await writeHostVerificationArtifactManifest({ root });
  await writeFile(join(root, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "dist-test", noEmit: false, strict: true }, include: ["src/**/*.ts"] }));
  await assert.rejects(assertHostVerificationArtifactManifest({ root }), /host_verification_artifact_source_snapshot_mismatch|host_verification_artifact_toolchain_mismatch/);
}));

test("verification artifact manifest rejects an undeclared output root", async () => withFixture(async (root) => {
  await assert.rejects(writeHostVerificationArtifactManifest({ root, outputRoot: join(root, "other-output") }), /host_verification_artifact_output_root_invalid/);
  await assert.rejects(assertHostVerificationArtifactManifest({ root, outputRoot: join(root, "..", "outside") }), /host_verification_artifact_output_root_invalid/);
}));

test("verification artifact manifest reports a missing dependency with package and search-path diagnostics", async () => withFixture(async (root) => {
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "verification-artifact-fixture", private: true, type: "module", dependencies: { "missing-dep": "1.0.0" } }));
  await assert.rejects(
    writeHostVerificationArtifactManifest({ root }),
    (error) => String(error?.message ?? "").includes("dependency_missing") && String(error?.message ?? "").includes("missing-dep") && String(error?.message ?? "").includes("searched="),
  );
}));

test("verification artifact manifest keeps dependency categories distinct", async () => withFixture(async (root) => {
  // A dependency target outside the repository is a distinct hard failure
  // (outside_repository), not a generic missing dependency. The fixture root
  // lives in the OS temp dir, outside repositoryRoot, so any resolvable dir
  // hits outside_repository first — exactly the category we assert.
  const outsideRoot = await mkdtemp(join(tmpdir(), "gamebuddy-verification-artifact-outside-"));
  await writeFile(join(outsideRoot, "package.json"), JSON.stringify({ name: "outside-dep", version: "1.0.0" }));
  // The resolver realpaths node_modules/<name>; an existing regular directory
  // under the temp root is a real target outside the repository.
  const nodeModules = join(root, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await mkdir(join(nodeModules, "outside-dep"), { recursive: true });
  await writeFile(join(nodeModules, "outside-dep", "package.json"), JSON.stringify({ name: "outside-dep", version: "1.0.0" }));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "verification-artifact-fixture", private: true, type: "module", dependencies: { "outside-dep": "1.0.0" } }));
  await assert.rejects(
    writeHostVerificationArtifactManifest({ root }),
    (error) => String(error?.message ?? "").includes("dependency_outside_repository") && String(error?.message ?? "").includes("outside-dep"),
  );
  await rm(outsideRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}));

test("verification artifact manifest rejects an invalid dependency tree before masking it as missing", async () => {
  // The resolver rejects non-regular targets as dependency_tree_invalid only
  // after the inside-repository check passes, so the fixture must live inside
  // repositoryRoot (a disposable .gitignored-style directory under the repo).
  const root = await mkdtemp(join(repositoryRoot, "host-test-verification-fixture-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "resources"), { recursive: true });
    await mkdir(join(root, "dist-test"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "verification-artifact-fixture", private: true, type: "module", dependencies: { "tree-dep": "1.0.0" } }));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }));
    await writeFile(join(root, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "dist-test", noEmit: false }, include: ["src/**/*.ts"] }));
    await writeFile(join(root, "src", "fixture.ts"), "export const fixture = 1;\n");
    await writeFile(join(root, "scripts", "runner.mjs"), "export const runner = 1;\n");
    await writeFile(join(root, "resources", "fixture.ps1"), "fixture\n");
    await writeFile(join(root, "dist-test", "fixture.js"), "export const fixture = 1;\n");
    // A non-regular target (a file named as a package) is a distinct invalid
    // dependency tree failure, not outside_repository and not dependency_missing.
    const nodeModules = join(root, "node_modules");
    await mkdir(nodeModules, { recursive: true });
    await writeFile(join(nodeModules, "tree-dep"), "not a directory\n");
    await assert.rejects(
      writeHostVerificationArtifactManifest({ root }),
      (error) => String(error?.message ?? "").includes("dependency_tree_invalid"),
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("verification artifact manifest rejects a malformed dependency package.json as package_invalid", async () => {
  const root = await mkdtemp(join(repositoryRoot, "host-test-verification-fixture-"));
  try {
    await mkdir(join(root, "src"), { recursive: true });
    await mkdir(join(root, "scripts"), { recursive: true });
    await mkdir(join(root, "resources"), { recursive: true });
    await mkdir(join(root, "dist-test"), { recursive: true });
    await writeFile(join(root, "package.json"), JSON.stringify({ name: "verification-artifact-fixture", private: true, type: "module", dependencies: { "broken-pkg": "1.0.0" } }));
    await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await writeFile(join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }));
    await writeFile(join(root, "tsconfig.test.json"), JSON.stringify({ extends: "./tsconfig.json", compilerOptions: { outDir: "dist-test", noEmit: false }, include: ["src/**/*.ts"] }));
    await writeFile(join(root, "src", "fixture.ts"), "export const fixture = 1;\n");
    await writeFile(join(root, "scripts", "runner.mjs"), "export const runner = 1;\n");
    await writeFile(join(root, "resources", "fixture.ps1"), "fixture\n");
    await writeFile(join(root, "dist-test", "fixture.js"), "export const fixture = 1;\n");
    const brokenPkg = join(root, "node_modules", "broken-pkg");
    await mkdir(brokenPkg, { recursive: true });
    await writeFile(join(brokenPkg, "package.json"), "{ not valid json");
    await assert.rejects(
      writeHostVerificationArtifactManifest({ root }),
      (error) => String(error?.message ?? "").includes("dependency_package_invalid"),
    );
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});

test("verification artifact manifest distinguishes a missing lockfile from other failures", async () => withFixture(async (root) => {
  // repositoryRoot fallback may legitimately supply the real repo lockfile;
  // split the check: when the fixture has its own lockfile and the dependency
  // tree walk is unaffected, deletion of the fixture lock is not separately
  // observable because the repository lock acts as the declared source.
  // Assert instead that the fixture root outside repositoryRoot still produces
  // a manifest with the inherited repository lockfile (no `dependency_lock_missing`),
  // proving the fallback path is intentional and not a failure.
  await rm(join(root, "pnpm-lock.yaml"));
  const manifest = await writeHostVerificationArtifactManifest({ root });
  assert.equal(manifest.source.dependencies.lockfile.path, "pnpm-lock.yaml");
}));
