/**
 * The bundled Node runtime: how it is copied, published, and admitted into a generation.
 *
 * The copier binds the synthetic acquisition's own file-list digests before it copies the
 * exact closure; the publisher emits that closure in lexical order and rejects tampering; and
 * the canonical admission/current bindings are what the recheck reads. A generation whose
 * runtime or bootstrap facts no longer match fails closed before a selected generation passes.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withSyntheticVerifiedReleaseBundledRuntimeForTest } from "./node-runtime-release-acquisition.mjs";
import {
  BUNDLED_RUNTIME,
  productionConfig,
  withFixture,
  testHash,
  syntheticRuntimeZip,
  publishTestArtifactForFixture,
  withProductionRuntimeContractProbe,
  emit,
  windowsBootstrapGuardianDescriptor,
  addCanonicalWindowsBootstrapGuardian,
} from "./production-artifact-fixtures.test-support.mjs";
import {
  assertCompleteTestArtifact,
  resolveTestArtifactEntry,
  stageFixtureRuntimeClosure,
} from "./production-artifact-test-support.mjs";
import { recheckProductionEntry } from "./production-artifact.mjs";

test("production runtime copier binds synthetic acquisition file-list digests before copying its exact closure", async () => {
  const { bytes, node } = syntheticRuntimeZip();
  const descriptor = { sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip", archiveSha256: testHash(bytes), archiveRoot: "node-v24.20.0-win-x64", nodeSha256: testHash(node) };
  await withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes: bytes }, async (source) =>
    withProductionRuntimeContractProbe(async ({ copyVerifiedBundledRuntimeSource }) => {
      const staging = await mkdtemp(join(tmpdir(), "gamebuddy-runtime-copy-staging-"));
      try {
        const origins = await copyVerifiedBundledRuntimeSource({ stagingRoot: staging, descriptor, source });
        assert.deepEqual([...origins], [["runtime/node.exe", { kind: undefined, sourceUrl: descriptor.sourceUrl, archiveSha256: descriptor.archiveSha256 }]]);
        // Each tamper is fail-closed under the split error vocabulary: invalid
        // file lists are rejected before the fixed node digest is consulted;
        // a list without an exact matching node.exe hits the digest check.
        const invalidListReasons = [
          [{ ...source.files[0] }, { ...source.files[0] }],
          [{ sourcePath: "z.dll", sha256: "a".repeat(64) }, { ...source.files[0] }],
          [{ ...source.files[0], sha256: "not-a-sha256" }],
        ];
        for (const files of invalidListReasons) {
          const invalidStaging = await mkdtemp(join(tmpdir(), "gamebuddy-runtime-copy-invalid-"));
          try {
            await assert.rejects(
              copyVerifiedBundledRuntimeSource({ stagingRoot: invalidStaging, descriptor, source: { ...source, files } }),
              /verified_bundled_runtime_closure_files_invalid/,
            );
            await assert.rejects(lstat(join(invalidStaging, "runtime")), { code: "ENOENT" });
          } finally { await rm(invalidStaging, { recursive: true, force: true }); }
        }
        // A valid list without the exact pinned node.exe disappears the fixed
        // executable fact before any tree is copied (renamed or missing).
        for (const files of [
          [{ sourcePath: "other.dll", sha256: "a".repeat(64) }],
          [{ ...source.files[0], sourcePath: "../node.exe" }],
        ]) {
          const invalidStaging = await mkdtemp(join(tmpdir(), "gamebuddy-runtime-copy-invalid-"));
          try {
            await assert.rejects(
              copyVerifiedBundledRuntimeSource({ stagingRoot: invalidStaging, descriptor, source: { ...source, files } }),
              /verified_bundled_runtime_node_digest_mismatch/,
            );
            await assert.rejects(lstat(join(invalidStaging, "runtime")), { code: "ENOENT" });
          } finally { await rm(invalidStaging, { recursive: true, force: true }); }
        }
        await writeFile(join(source.extractedRoot, descriptor.archiveRoot, "foreign.dll"), "foreign");
        await assert.rejects(
          copyVerifiedBundledRuntimeSource({ stagingRoot: staging, descriptor, source }),
          /verified_bundled_runtime_closure_mismatch/,
        );
      } finally { await rm(staging, { recursive: true, force: true }); }
    }));
});


test("production-private runtime publisher emits a lexicographically ordered multi-file runtime closure and rejects closure tampering", async () => withFixture(async (root) => {
  const files = [
    { path: "node.exe", bytes: Buffer.from("test node runtime") },
    { path: "a.dll", bytes: Buffer.from("a runtime dependency") },
    { path: "nested/z.dll", bytes: Buffer.from("nested runtime dependency") },
  ];
  const { bytes, node } = syntheticRuntimeZip(files);
  const descriptor = { ...BUNDLED_RUNTIME, archiveSha256: testHash(bytes), nodeSha256: testHash(node) };
  await withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes: bytes }, async (runtimeSource) =>
    withProductionRuntimeContractProbe(async ({ copyVerifiedBundledRuntimeSource, publishProductionArtifactWithRuntimeCopier, verifyRuntimeAdmission }) => {
      const outputRoot = join(root, "production-runtime-closure-dist");
      const published = await publishProductionArtifactWithRuntimeCopier(
        { hostRoot: root, emittedRoot: await emit(root, "production-runtime-closure"), outputRoot, voiceDistRoot: join(root, "voice-gateway", ".dist") },
        async (stagingRoot, runtimeDescriptor) => copyVerifiedBundledRuntimeSource({ stagingRoot, descriptor: runtimeDescriptor, source: runtimeSource }),
        descriptor,
        undefined,
        stageFixtureRuntimeClosure,
      );
      const artifactRoot = join(outputRoot, "generations", published.generation);
      const sidecarPath = join(artifactRoot, "host-runtime-admission.json");
      const sidecar = JSON.parse(await readFile(sidecarPath, "utf8"));
      const expectedClosure = [
        { path: "runtime/a.dll", sha256: testHash(files[1].bytes) },
        { path: "runtime/nested/z.dll", sha256: testHash(files[2].bytes) },
      ];
      assert.deepEqual(sidecar.runtimeClosure, { schema: "host-bundled-runtime-closure/v1", files: expectedClosure });
      for (const replacement of [
        { ...sidecar, runtimeClosure: { ...sidecar.runtimeClosure, files: [...expectedClosure].reverse() } },
        { ...sidecar, runtimeClosure: { ...sidecar.runtimeClosure, files: [expectedClosure[0], expectedClosure[0]] } },
        { ...sidecar, runtimeClosure: { ...sidecar.runtimeClosure, files: expectedClosure.slice(1) } },
        { ...sidecar, runtimeClosure: { ...sidecar.runtimeClosure, files: [...expectedClosure, { path: "runtime/foreign.dll", sha256: "a".repeat(64) }] } },
      ]) {
        await writeFile(sidecarPath, `${JSON.stringify(replacement)}\n`);
        await assert.rejects(verifyRuntimeAdmission({ artifactRoot, inventory: published, generation: published.generation, descriptor }), /runtime_admission_invalid/);
      }
    }),
  );
}));


test("production-private runtime publisher emits canonical admission/current bindings and removes a post-rename cleanup failure candidate", async () => withFixture(async (root) => {
  const { bytes, node } = syntheticRuntimeZip();
  const descriptor = {
    ...BUNDLED_RUNTIME,
    archiveSha256: testHash(bytes),
    nodeSha256: testHash(node),
  };
  await withSyntheticVerifiedReleaseBundledRuntimeForTest({ descriptor, zipBytes: bytes }, async (runtimeSource) =>
    withProductionRuntimeContractProbe(async ({
      copyVerifiedBundledRuntimeSource,
      publishProductionArtifactWithRuntimeCopier,
      currentGeneration,
      verifyCurrentRuntimeAdmissionAssociation,
      verifyRuntimeAdmission,
    }) => {
      const outputRoot = join(root, "production-runtime-contract-dist");
      const copyRuntime = async (stagingRoot, runtimeDescriptor) =>
        copyVerifiedBundledRuntimeSource({ stagingRoot, descriptor: runtimeDescriptor, source: runtimeSource });
      const published = await publishProductionArtifactWithRuntimeCopier(
        { hostRoot: root, emittedRoot: await emit(root, "production-private-first"), outputRoot, voiceDistRoot: join(root, "voice-gateway", ".dist") },
        copyRuntime,
        descriptor,
        undefined,
        stageFixtureRuntimeClosure,
      );
      const artifactRoot = join(outputRoot, "generations", published.generation);
      const sidecarPath = join(artifactRoot, "host-runtime-admission.json");
      const sidecarBytes = await readFile(sidecarPath);
      const sidecar = JSON.parse(sidecarBytes);
      const expectedSidecar = {
        schema: "host-runtime-admission/v1",
        inventoryDigest: published.digest,
        generation: published.generation,
        runtimePath: "runtime/node.exe",
        runtimeSha256: testHash(node),
        bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
        bootstrapSha256: testHash(Buffer.from("export {};\n")),
        runtimeVersion: "v24.20.0",
        runtimePlatform: "win32",
        runtimeArch: "x64",
        runtimeClosure: { schema: "host-bundled-runtime-closure/v1", files: [] },
      };
      assert.deepEqual(Object.keys(sidecar), Object.keys(expectedSidecar));
      assert.deepEqual(sidecar, expectedSidecar);
      assert.deepEqual(sidecarBytes, Buffer.from(`${JSON.stringify(expectedSidecar)}\n`));

      const pointerPath = join(outputRoot, "current.json");
      const pointerBytes = await readFile(pointerPath);
      const expectedPointer = {
        schema: "gamebuddy-host-production-current/v2",
        generation: published.generation,
        inventoryDigest: published.digest,
        runtimeAdmissionSha256: testHash(sidecarBytes),
      };
      assert.deepEqual(JSON.parse(pointerBytes), expectedPointer);
      assert.deepEqual(pointerBytes, Buffer.from(`${JSON.stringify(expectedPointer)}\n`));
      const pointer = await currentGeneration(outputRoot);
      assert.deepEqual(pointer, expectedPointer);
      await verifyCurrentRuntimeAdmissionAssociation({ artifactRoot, pointer });
      await verifyRuntimeAdmission({ artifactRoot, inventory: published, generation: published.generation, descriptor });
      const selectedWithoutRuntimeAdmission = { ...published, artifactRoot, entryPath: join(artifactRoot, "main.js") };
      await assert.rejects(
        recheckProductionEntry({ hostRoot: root, selected: selectedWithoutRuntimeAdmission }),
        /production_selected_runtime_admission_required/,
      );

      await assert.rejects(
        publishProductionArtifactWithRuntimeCopier(
          { hostRoot: root, emittedRoot: await emit(root, "production-private-rejected"), outputRoot, voiceDistRoot: join(root, "voice-gateway", ".dist") },
          copyRuntime,
          descriptor,
          async () => { throw new Error("injected_runtime_cleanup_failure"); },
          stageFixtureRuntimeClosure,
        ),
        /injected_runtime_cleanup_failure/,
      );
      assert.deepEqual(await readFile(pointerPath), pointerBytes);
      assert.deepEqual(await currentGeneration(outputRoot), expectedPointer);
      await verifyCurrentRuntimeAdmissionAssociation({ artifactRoot, pointer: expectedPointer });
      await verifyRuntimeAdmission({ artifactRoot, inventory: published, generation: published.generation, descriptor });
      const generationsAfterCleanupFailure = await readdir(join(outputRoot, "generations"));
      assert.equal(generationsAfterCleanupFailure.length, 1);
      assert.ok(generationsAfterCleanupFailure.includes(published.generation));
      assert.deepEqual(await readdir(outputRoot), ["current.json", "generations"]);
    }),
  );
}));


test("publishes immutable versioned generations and an atomically replaced current pointer", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const first = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "first"), outputRoot: dist });
  const firstEntry = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const second = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "second"), outputRoot: dist });
  const secondEntry = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.notEqual(first.generation, second.generation);
  assert.notEqual(firstEntry.artifactRoot, secondEntry.artifactRoot);
  assert.equal(await readFile(firstEntry.entryPath, "utf8"), 'import "typebox";\nfirst');
  assert.equal(await readFile(secondEntry.entryPath, "utf8"), 'import "typebox";\nsecond');
  assert.deepEqual(second.entries.find((entry) => entry.path === "windows-named-mutex-broker.ps1")?.origin, { kind: "allowlisted_resource", source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1", config: "production-artifact.config.json" });
  await assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist });
  const pointer = JSON.parse(await readFile(join(dist, "test-current.json"), "utf8"));
  assert.deepEqual(Object.keys(pointer), ["schema", "generation", "inventoryDigest", "testRuntimeAdmissionSha256"]);
  assert.equal(pointer.schema, "gamebuddy-host-test-current/v1");
  assert.equal(pointer.generation, second.generation);
  assert.equal(pointer.inventoryDigest, second.digest);
  assert.equal(pointer.testRuntimeAdmissionSha256, createHash("sha256").update(await readFile(join(secondEntry.artifactRoot, "test-runtime-admission.json"))).digest("hex"));
  assert.equal(second.entries.some((entry) => entry.path === "test-runtime-admission.json"), false);
}));


test("current pointer rejects malformed runtime-admission digest fields before inventory verification", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist });
  const pointerPath = join(dist, "test-current.json");
  const valid = JSON.parse(await readFile(pointerPath, "utf8"));
  for (const pointer of [
    (() => { const { testRuntimeAdmissionSha256, ...without } = valid; return without; })(),
    { ...valid, testRuntimeAdmissionSha256: "not-a-sha256" },
    { ...valid, unexpected: true },
  ]) {
    await writeFile(pointerPath, `${JSON.stringify(pointer)}\n`);
    await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }), /invalid_test_current_pointer/);
  }
}));


test("synthetic publisher sidecar binds exact fixed runtime/bootstrap facts and rejects noncanonical or foreign self-consistent bytes", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const first = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "first"), outputRoot: dist });
  const second = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "second"), outputRoot: dist });
  const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const sidecarPath = join(selected.artifactRoot, "test-runtime-admission.json");
  const canonical = await readFile(sidecarPath);
  const sidecar = JSON.parse(canonical);
  assert.deepEqual(Object.keys(sidecar), ["schema", "inventoryDigest", "generation", "runtimePath", "runtimeSha256", "bootstrapPath", "bootstrapSha256"]);
  assert.deepEqual(sidecar, {
    schema: "gamebuddy-host-test-runtime-admission/v1",
    inventoryDigest: second.digest,
    generation: second.generation,
    runtimePath: "runtime/node.exe",
    runtimeSha256: testHash(Buffer.from("test node runtime")),
    bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
    bootstrapSha256: testHash(Buffer.from("export {};\n")),
  });
  for (const replacement of [
    Buffer.from("replacement sidecar\n"),
    Buffer.from(`${JSON.stringify({ ...sidecar, unknown: true })}\n`),
    Buffer.from(`${JSON.stringify(((value) => { const { bootstrapSha256, ...without } = value; return without; })(sidecar))}\n`),
    Buffer.from(`${JSON.stringify(Object.fromEntries(Object.entries(sidecar).reverse()))}\n`),
    Buffer.concat([canonical, Buffer.from(" ")]),
  ]) {
    await writeFile(sidecarPath, replacement);
    await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }), /test_runtime_admission_invalid/);
    await writeFile(sidecarPath, canonical);
  }
  const firstSidecar = await readFile(join(dist, "test-generations", first.generation, "test-runtime-admission.json"));
  const pointerPath = join(dist, "test-current.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  await writeFile(sidecarPath, firstSidecar);
  await writeFile(pointerPath, `${JSON.stringify({ ...pointer, testRuntimeAdmissionSha256: testHash(firstSidecar) })}\n`);
  await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }), /test_runtime_admission_invalid/);
}));


test("synthetic publisher recheck fails closed for fixed runtime/bootstrap mutations before a selected generation can pass", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  for (const [path, content] of [
    ["runtime/node.exe", "replaced runtime"],
    ["bootstrap/entry/desktop-host-entry.internal.js", "replaced bootstrap"],
  ]) {
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist });
    const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
    await writeFile(join(selected.artifactRoot, path), content);
    await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }), /production_inventory_mismatch_or_orphan|test_runtime_admission_invalid|production_module_lexical_parse_failed/);
  }
}));


test("Host atomically emits the fixed Guardian admission contract after pair verification",  async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-specific Guardian admission publication");
  await withFixture(async (root) => {
    await addCanonicalWindowsBootstrapGuardian(root);
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
      entryRoots: ["main.js"],
      resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
      windowsBootstrapGuardian: windowsBootstrapGuardianDescriptor,
      externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
    })));
    const outputRoot = join(root, "dist");
    const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot });
    const contract = JSON.parse(await readFile(join(outputRoot, "test-generations", published.generation, "guardian-admission.json"), "utf8"));
    const helperSha256 = createHash("sha256").update(Buffer.from("canonical Windows bootstrap Guardian")).digest("hex");
    assert.deepEqual(contract, {
      schema: "gamebuddy-host-guardian-admission/v1",
      inventoryDigest: published.digest,
      helperPath: "native/windows-bootstrap-guardian/win-x64/GameBuddy.WindowsBootstrapGuardian.exe",
      manifestPath: "native/windows-bootstrap-guardian/win-x64/windows-bootstrap-guardian.manifest.json",
      helperSha256,
      manifestSha256: createHash("sha256").update(Buffer.from(`{\"schemaVersion\":1,\"protocolVersion\":1,\"rid\":\"win-x64\",\"helperFileName\":\"GameBuddy.WindowsBootstrapGuardian.exe\",\"sha256\":\"${helperSha256}\"}\n`)).digest("hex"),
      manifestSchemaVersion: 1,
      manifestProtocolVersion: 1,
      manifestRid: "win-x64",
      manifestHelperFileName: "GameBuddy.WindowsBootstrapGuardian.exe",
    });
  });
});

