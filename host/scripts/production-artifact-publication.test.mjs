/**
 * What a published generation contains, and what it refuses to contain.
 *
 * Only the entry-reachable semantic closure is published, under the fixed Desktop formal
 * entry, with no public entry root; a failed publication preserves the previous verified
 * current generation and concurrent publishers serialize. The browser artifact is admitted
 * only from its manifest-verified subtree, an inventory mismatch names the entry and field
 * that differ, and the local-iteration seam is inert unless its root variable is set.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  hostRoot,
  productionConfig,
  withFixture,
  publishTestArtifactForFixture,
  validRootSource,
  emit,
  addBrowserArtifact,
  browserArtifactDescriptor,
  configureBrowserArtifact,
} from "./production-artifact-fixtures.test-support.mjs";
import {
  assertCompleteTestArtifact,
  resolveTestArtifactEntry,
  resolveTestArtifactModule,
} from "./production-artifact-test-support.mjs";
import {
  copyApprovedResources,
  createBrowserArtifactSnapshot,
  createInventory,
  describeInventoryDifference,
  readArtifactConfig,
  recheckProductionEntry,
  REQUIRED_VERIFICATION_ROOTS,
  resolveProductionEntry,
  verifyArtifact,
} from "./production-artifact.mjs";

test("publisher retains only the fixed Desktop formal entry closure without exposing a public entry root", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root);
  await mkdir(join(emitted, "bootstrap", "wire"), { recursive: true });
  await writeFile(join(emitted, "bootstrap", "entry", "desktop-host-entry.internal.js"), 'import "../wire/desktop-runtime-bootstrap.internal.js";\n');
  await writeFile(join(emitted, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js"), "export const privateHelper = true;\n");

  const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  for (const module of ["bootstrap/entry/desktop-host-entry.internal.js", "bootstrap/wire/desktop-runtime-bootstrap.internal.js"])
    assert.ok(published.entries.some((entry) => entry.path === module), `${module} must be retained`);
  const config = await readArtifactConfig(root);
  assert.equal(config.entryRoots.includes("desktop-runtime-bootstrap.internal.js"), false);

  await mkdir(join(emitted, "unreachable"));
  await writeFile(join(emitted, "unreachable/otherwise-valid.js"), "export const unreachable = true;\n");
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_module_unreachable_from_entry_roots:unreachable\/otherwise-valid\.js/,
  );
  await rm(join(emitted, "unreachable"), { recursive: true });

  await writeFile(join(emitted, "desktop-runtime-bootstrap.internal.js"), "export {};\n");
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_module_unreachable_from_entry_roots:desktop-runtime-bootstrap\.internal\.js/,
  );
}));


test("publishes only the entry-reachable semantic implementation closure", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root, 'import "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";');
  const required = [
    "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    "continuity-semantic-deployment-composition/continuity-semantic-deployment-composition.js",
    "continuity-semantic-store/continuity-semantic-production-store.js",
    "continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.js",
    "continuity-semantic-chat-runtime-materializer/continuity-semantic-chat-runtime-materializer.js",
    "continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js",
    "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js",
  ];
  for (const module of required) {
    await mkdir(join(emitted, module, ".."), { recursive: true });
    await writeFile(join(emitted, module), "export {};\n");
  }
  await writeFile(join(emitted, "main.js"), `import "typebox";\n${required.map((module) => `import "./${module}";`).join("\n")}\n`);
  await mkdir(join(emitted, "unreachable"));
  await writeFile(join(emitted, "unreachable", "otherwise-valid.js"), "export const unreachable = true;\n");
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_module_unreachable_from_entry_roots:unreachable\/otherwise-valid\.js/,
  );
  await rm(join(emitted, "unreachable"), { recursive: true });
  const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  for (const module of required) assert.ok(published.entries.some((entry) => entry.path === module));
  await writeFile(join(emitted, "main.js"), 'import "./missing.js";');
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_relative_module_missing_from_artifact:main\.js:\.\/missing\.js/,
  );
}));


test("a failed publication preserves the previous verified current generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "known-good"), outputRoot: dist });
  const before = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await writeFile(join(root, "emitted", "physical-fixture-worker.js"), "forbidden");
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: join(root, "emitted"), outputRoot: dist }), /(?:test_artifact|unreachable)/);
  const after = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.equal(after.artifactRoot, before.artifactRoot);
  assert.equal(await readFile(after.entryPath, "utf8"), 'import "typebox";\nknown-good');
}));


test("rejects fixture workers broadly, tampering, orphans, symlinks, and invalid start entry names", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root);
  for (const forbidden of ["helper.test.js", "test-fixtures/worker.js", "continuity-physical-fixture-worker.js", "fixture-worker.js"]) {
    await mkdir(join(emitted, "test-fixtures"), { recursive: true }); await writeFile(join(emitted, forbidden), "");
    await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }), /(?:test_artifact|unreachable)/);
    await rm(join(emitted, forbidden), { force: true });
  }
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const current = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await writeFile(join(current.artifactRoot, "orphan.js"), 'import "typebox";'); await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }), /(?:mismatch_or_orphan|module_unreachable_from_entry_roots:orphan\.js)/);
  await rm(join(current.artifactRoot, "orphan.js")); await writeFile(current.entryPath, 'import "typebox";\ntampered'); await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }), /mismatch_or_orphan/);
  for (const invalid of ["../main.js", "nested/main.js", "/main.js", "unknown.js", "main.js/.."]) await assert.rejects(resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: invalid }), /test_entry_not_configured/);
  const target = join(root, "outside.ps1"); await writeFile(target, "outside");
  try { await rm(join(root, "resources/windows-named-mutex-broker.ps1")); await symlink(target, join(root, "resources/windows-named-mutex-broker.ps1")); } catch (error) { t.skip(`symlink unavailable: ${error.code}`); return; }
  await assert.rejects(copyApprovedResources({ hostRoot: root, stagingRoot: join(root, "staging"), config: await readArtifactConfig(root) }), /symbolic_link/);
}));


test("a starter retains the verified generation selected before a concurrent publisher changes current", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, validRootSource("old")), outputRoot: dist });
  const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, validRootSource("new")), outputRoot: dist });
  assert.equal(await readFile(selected.entryPath, "utf8"), `import "typebox";\n${validRootSource("old")}`);
}));


test("resolves only inventoried, untampered JavaScript modules from a selected immutable generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root, 'import "./support.js"; export {};');
  await writeFile(join(emitted, "support.js"), "export const trusted = true;\n");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const resolved = await resolveTestArtifactModule({ selected, module: "support.js" });
  assert.equal(await readFile(resolved.modulePath, "utf8"), "export const trusted = true;\n");
  for (const module of ["../support.js", "support.mjs", "missing.js", "test-fixtures/worker.js"]) {
    await assert.rejects(resolveTestArtifactModule({ selected, module }), /test_module_(?:not_configured|escapes_generation|integrity_mismatch)/);
  }
  await writeFile(resolved.modulePath, "tampered");
  await assert.rejects(resolveTestArtifactModule({ selected, module: "support.js" }), /test_module_integrity_mismatch/);
}));


test("concurrent publishers serialize, preserve current, and reject stale direct root artifacts", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true }); await writeFile(join(dist, "stale-main.js"), "stale");
  const first = join(root, "first"); const second = join(root, "second");
  for (const emitted of [first, second]) await mkdir(join(emitted, "tavern"), { recursive: true });
  await writeFile(join(first, "main.js"), 'import "typebox"; "first";');
  await writeFile(join(second, "main.js"), 'import "typebox"; "second";');
  for (const emitted of [first, second]) {
    await mkdir(join(emitted, "bootstrap", "entry"), { recursive: true });
    await writeFile(join(emitted, "bootstrap", "entry", "desktop-host-entry.internal.js"), "export {};\n");
  }
  for (const verificationRoot of REQUIRED_VERIFICATION_ROOTS) {
    await mkdir(dirname(join(first, verificationRoot)), { recursive: true });
    await mkdir(dirname(join(second, verificationRoot)), { recursive: true });
    await writeFile(join(first, verificationRoot), "export {};\n");
    await writeFile(join(second, verificationRoot), "export {};\n");
  }
  if (process.platform === "win32") { await addBrowserArtifact(root, first); await addBrowserArtifact(root, second); }
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: first, outputRoot: dist }), /test_artifact_output_root_invalid/);
  assert.equal(await readFile(join(dist, "stale-main.js"), "utf8"), "stale");
  await rm(join(dist, "stale-main.js"));
  const published = await Promise.all([publishTestArtifactForFixture({ hostRoot: root, emittedRoot: first, outputRoot: dist }), publishTestArtifactForFixture({ hostRoot: root, emittedRoot: second, outputRoot: dist })]);
  assert.notEqual(published[0].generation, published[1].generation);
  assert.deepEqual((await readdir(dist)).sort(), ["TEST_ONLY_NOT_A_PRODUCTION_ARTIFACT.txt", "test-current.json", "test-generations"]);
  const current = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.ok(['import "typebox"; "first";', 'import "typebox"; "second";'].includes(await readFile(current.entryPath, "utf8")));
  await assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist });
}));


test("publisher admits only the fixed manifest-verified browser artifact subtree with stable provenance", async () => withFixture(async (root) => {
  await configureBrowserArtifact(root);
  const emitted = await emit(root);
  await addBrowserArtifact(root, emitted);
  const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: join(root, "dist") });
  const browserEntries = published.entries.filter((entry) => entry.path.startsWith("browser/tavern/v1/"));
  assert.deepEqual(browserEntries.map((entry) => entry.path), [
    "browser/tavern/v1/assets/app-abcdef12.js",
    "browser/tavern/v1/index.html",
    "browser/tavern/v1/tavern-browser-artifact-manifest.json",
  ]);
  assert.deepEqual(browserEntries[0].origin, {
    kind: "verified_tavern_browser_artifact",
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.tavern.browser.v1",
    manifest: "tavern-browser-artifact-manifest.json",
    destination: "browser/tavern/v1",
  });
  assert.notEqual(browserEntries[0].origin.kind, "typescript_emit");
  await assertCompleteTestArtifact({ hostRoot: root, outputRoot: join(root, "dist") });
}));


test("browser artifact descriptor and tree fail closed for extra, escaping, identity, and inventory mismatches", async () => withFixture(async (root) => {
  for (const descriptor of [
    { ...browserArtifactDescriptor, destination: "browser/tavern/v2" },
    { ...browserArtifactDescriptor, source: "arbitrary" },
    { ...browserArtifactDescriptor, entryRoots: ["main.js"] },
    { ...browserArtifactDescriptor, dynamicExternalImports: [] },
    { ...browserArtifactDescriptor, profileId: "other" },
    { kind: browserArtifactDescriptor.kind },
  ]) {
    await configureBrowserArtifact(root, descriptor);
    await assert.rejects(readArtifactConfig(root), /invalid_browser_artifact_descriptor/);
  }
  await configureBrowserArtifact(root);
  for (const options of [
    { extra: true },
    { assetPath: "assets/../escape-abcdef12.js" },
    { profileId: "wrong.browser" },
    { schemaVersion: 2 },
  ]) {
    const emitted = await emit(root);
    await addBrowserArtifact(root, emitted, options);
    await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: join(root, "dist") }), /production_browser_artifact_(?:tree_mismatch|asset_mismatch)|invalid_browser_artifact_manifest/);
  }
  const emitted = await emit(root);
  await addBrowserArtifact(root, emitted);
  await writeFile(join(emitted, "browser", "outside.js"), "unreachable browser escape");
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: join(root, "dist") }),
    /production_browser_artifact_outside_fixed_subtree:browser\/outside\.js/,
  );
  await rm(join(emitted, "browser", "outside.js"));
  const outputRoot = join(root, "dist");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot });
  const selected = await resolveTestArtifactEntry({ hostRoot: root, outputRoot, entry: "main.js" });
  await writeFile(join(selected.artifactRoot, "browser", "tavern", "v1", "assets", "app-abcdef12.js"), "tampered");
  await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot }), /production_browser_artifact_asset_mismatch/);
}));


test("a browser snapshot rejects mutation after its initial verification before inventory can pass", async () => withFixture(async (root) => {
  await configureBrowserArtifact(root);
  const emitted = await emit(root);
  await addBrowserArtifact(root, emitted);
  const config = await readArtifactConfig(root);
  const snapshot = (await createBrowserArtifactSnapshot({ artifactRoot: emitted, descriptor: config.browserArtifact })).snapshot;
  await writeFile(join(emitted, "browser", "tavern", "v1", "index.html"), "mutated after snapshot");
  await assert.rejects(
    verifyArtifact({ artifactRoot: emitted, hostRoot: root, config, browserArtifactSnapshot: snapshot }),
    /production_browser_artifact_snapshot_mismatch/,
  );
  await assert.rejects(
    createInventory({ artifactRoot: emitted, hostRoot: root, origins: new Map(), entryRoots: config.entryRoots, externalRuntimeClosure: config.externalRuntimeClosure, browserArtifactDescriptor: config.browserArtifact, browserArtifactSnapshot: snapshot }),
    /production_browser_artifact_snapshot_mismatch/,
  );
}));


test("rejects test, fixture, and legacy resource declarations before source I/O", async () => withFixture(async (root) => {
  for (const source of ["resources/example.test.ps1", "src/test-fixtures/missing.ps1", "resources/legacy-writer-fixture.ps1"]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source, destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
    await assert.rejects(readArtifactConfig(root), /production_resource_source_forbidden/);
  }
}));


test("the local-iteration seam is inert unless GAMEBUDDY_HOST_PRODUCTION_ROOT is set", async (t) => {
  // Production verification can only be satisfied by a generation the protected
  // release CI published, so a local two-process run cannot complete on a dev
  // machine at all (measured 2026-10-05). The seam lets a LOCAL run use a locally
  // built generation - and it must be inert by default, or the production
  // guarantee would silently disappear.
  const previous = process.env.GAMEBUDDY_HOST_PRODUCTION_ROOT;
  const root = await mkdtemp(join(tmpdir(), "production-artifact-local-seam-"));
  t.after(async () => {
    if (previous === undefined) delete process.env.GAMEBUDDY_HOST_PRODUCTION_ROOT;
    else process.env.GAMEBUDDY_HOST_PRODUCTION_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  });
  const generation = "g-local-seam-1";
  const artifactRoot = join(root, "generations", generation);
  await mkdir(artifactRoot, { recursive: true });
  await writeFile(join(artifactRoot, "main.js"), "export {};\n");
  await writeFile(
    join(root, "current.json"),
    JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation }),
  );
  const args = { hostRoot, outputRoot: root, entry: "main.js" };

  // Default: OFF. The unpublished root is rejected by the production path, so
  // nothing about local iteration can leak into a normal resolution.
  delete process.env.GAMEBUDDY_HOST_PRODUCTION_ROOT;
  await assert.rejects(() => resolveProductionEntry(args), /production_/);

  // Opt-in: the local generation is selected directly, and the re-attestation is
  // a no-op (nothing local can satisfy it).
  process.env.GAMEBUDDY_HOST_PRODUCTION_ROOT = root;
  const selected = await resolveProductionEntry(args);
  assert.equal(selected.generation, generation);
  assert.equal(selected.artifactRoot, artifactRoot);
  await recheckProductionEntry({ hostRoot, selected });

  // A pointer that tries to escape the opt-in root still fails closed.
  await writeFile(join(root, "current.json"), JSON.stringify({ generation: "../escape" }));
  await assert.rejects(() => resolveProductionEntry(args), /local_generation_pointer_invalid/);
});


test("an inventory mismatch names the entry and the field that differ", () => {
  // A published generation failed re-verification and the error said only
  // "production_inventory_mismatch_or_orphan", which cannot distinguish a tampered artifact from one that
  // predates a config change. The second case is ordinary: the bundled runtime archive's hash lives in
  // production-artifact.config.json, so updating that config makes every already-published generation fail
  // every run that needs the production Host.
  const entry = (path, archiveSha256, sha256 = "a".repeat(64)) => ({
    path,
    type: "file",
    mode: "666",
    sha256,
    origin: { kind: "verified_host_bundled_node_runtime", sourceUrl: "https://nodejs.org/dist/x.zip", archiveSha256 },
  });
  const expected = { entries: [entry("runtime/CHANGELOG.md", "977ae99b"), entry("main.js", "cc", "b".repeat(64))] };

  assert.match(
    describeInventoryDifference({ entries: [entry("runtime/CHANGELOG.md", "6cac9ffb"), entry("main.js", "cc", "b".repeat(64))] }, expected),
    /^published-runtime-archive-superseded:runtime\/CHANGELOG\.md \(origin:/,
  );
  assert.match(
    describeInventoryDifference({ entries: [entry("runtime/CHANGELOG.md", "977ae99b"), entry("main.js", "cc", "d".repeat(64))] }, expected),
    /^changed-entry:main\.js \(sha256: published="b+"/,
  );
  assert.match(
    describeInventoryDifference({ entries: [entry("runtime/CHANGELOG.md", "977ae99b")] }, expected),
    /^missing-entry:main\.js$/,
  );
  assert.match(
    describeInventoryDifference({ entries: [...expected.entries, entry("extra.js", "ee")] }, expected),
    /^unexpected-entry:extra\.js$/,
  );
});
