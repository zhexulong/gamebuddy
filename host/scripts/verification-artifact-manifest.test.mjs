import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertHostVerificationArtifactManifest, writeHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

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
