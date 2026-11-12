/**
 * What the build is told to do, and what it emits.
 *
 * The config fixes the bundled runtime and bootstrap entry, names no fixture or template path,
 * admits exactly the frozen helper descriptor, and is exact v3 over the current verification
 * roots; the publisher has no ambient runtime fallback, and an incomplete fixture fails closed
 * instead of producing a current artifact. The TypeScript invocation is shell-free and
 * repository-resolved, the declared Magic Context artifact must be the freshly built one, and
 * the emitted closure is exactly the two roots that are reachable.
 */
import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveTypeScriptInvocation, verifyDeclaredMagicContextArtifact } from "./build-production-artifact.mjs";
import {
  hostRoot,
  BUNDLED_RUNTIME,
  productionConfig,
  fixture,
  withFixture,
  runChild,
  treeDigest,
  emit,
  windowsStaleLockReclaimerDescriptor,
} from "./production-artifact-fixtures.test-support.mjs";
import { createIncompleteRuntimeFixture } from "./production-artifact-runtime-test-support.mjs";
import { assertCompleteTestArtifact } from "./production-artifact-test-support.mjs";
import {
  assertCompleteProductionArtifact,
  readArtifactConfig,
  REQUIRED_VERIFICATION_ROOTS,
  publishProductionArtifact as publishProductionArtifactWithoutRuntime,
} from "./production-artifact.mjs";

test("current production config fixes the bundled Node runtime and bootstrap entry", async () => {
  const config = await readArtifactConfig(hostRoot);
  assert.equal(config.schema, "gamebuddy-host-production-artifact-config/v3");
  assert.deepEqual(config.bundledRuntime, {
    kind: "verified_host_bundled_node_runtime",
    sourceUrl: "https://nodejs.org/dist/v24.20.0/node-v24.20.0-win-x64.zip",
    archiveSha256: "6cac9ffbca8f6a47091e4b5c772e0606049c3871cb67d900c0cedde630e545ba",
    archiveRoot: "node-v24.20.0-win-x64",
    runtimePath: "runtime/node.exe",
    nodeSha256: "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5",
    bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
    runtimeVersion: "v24.20.0",
    runtimePlatform: "win32",
    runtimeArch: "x64",
  });
});


/**
 * The fixed save templates under `fixtures/stardew/templates/` are local
 * native-action test inputs (see fixtures/stardew/README.md) and must never
 * reach a published generation; a generation stages only what the
 * production-artifact config declares. The second assertion keeps the check
 * live by proving it catches a config that does declare the checked-in
 * navigation template.
 */
test("current production config declares no fixture or template path", async () => {
  const declaredPaths = (value) => typeof value === "string" ? [value]
    : Array.isArray(value) ? value.flatMap(declaredPaths)
      : value !== null && typeof value === "object" ? Object.values(value).flatMap(declaredPaths)
        : [];
  const forbiddenPaths = (values) => values.filter((value) => /(?:^|\/)(?:fixtures|templates)(?:\/|$)/i.test(value));
  const config = JSON.parse(await readFile(join(hostRoot, "production-artifact.config.json"), "utf8"));
  assert.deepEqual(forbiddenPaths(declaredPaths(config)), []);
  const declaredTemplate = "fixtures/stardew/templates/GameBuddyFixtureNavigation_447088730/GameBuddyFixtureNavigation_447088730";
  assert.deepEqual(forbiddenPaths(declaredPaths({ resources: [{ source: declaredTemplate, destination: "template.xml" }] })), [declaredTemplate]);
});


test("production publisher has no ambient runtime fallback when verified acquisition is unavailable", async () => withFixture(async (root) => {
  const outputRoot = join(root, "dist");
  await assert.rejects(
    publishProductionArtifactWithoutRuntime({ hostRoot: root, emittedRoot: await emit(root), outputRoot }),
    /verified_bundled_runtime_input_required/,
  );
  await assert.rejects(lstat(join(outputRoot, "test-generations")), { code: "ENOENT" });
}));


test("ordinary publisher and incomplete text fixture fail closed without generating a current production artifact", async () => withFixture(async (root) => {
  const outputRoot = join(root, "synthetic-runtime-dist");
  await assert.rejects(
    publishProductionArtifactWithoutRuntime({ hostRoot: root, emittedRoot: await emit(root, "first"), outputRoot }),
    /verified_bundled_runtime_input_required/,
  );
  await assert.rejects(lstat(join(outputRoot, "test-current.json")), { code: "ENOENT" });
  await assert.rejects(assertCompleteTestArtifact({ hostRoot: root, outputRoot }), /ENOENT/);
}));


test("runtime test support writes an explicit non-production marker rejected by standard artifact recheck", async () => withFixture(async (root) => {
  const fixture = await createIncompleteRuntimeFixture(root);
  assert.equal(await readFile(fixture.marker, "utf8"), "test-only runtime fixture; production admission must reject\n");
  await assert.rejects(assertCompleteProductionArtifact({ hostRoot: root, outputRoot: fixture.fixtureRoot }), /production_output_root_contains_direct_artifact|ENOENT/);
}));


test("production config is exact v3 and retains the current Chat/reference verification roots", async () => withFixture(async (root) => {
  const valid = productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  });
  for (const invalid of [
    { ...valid, schema: "gamebuddy-host-production-artifact-config/v1" },
    { ...valid, schema: "gamebuddy-host-production-artifact-config/v2" },
    (() => { const { verificationRoots, ...withoutRoots } = valid; return withoutRoots; })(),
    (() => { const { bundledRuntime, ...withoutRuntime } = valid; return withoutRuntime; })(),
    { ...valid, bundledRuntime: { ...BUNDLED_RUNTIME, runtimeVersion: "v24.20.1" } },
    { ...valid, bundledRuntime: { ...BUNDLED_RUNTIME, bootstrapPath: "desktop-runtime-bootstrap.internal.js" } },
    { ...valid, verificationRoots: [] },
    { ...valid, verificationRoots: ["main.js"] },
    { ...valid, verificationRoots: [REQUIRED_VERIFICATION_ROOTS[0]] },
    { ...valid, verificationRoots: [...REQUIRED_VERIFICATION_ROOTS].reverse() },
    { ...valid, verificationRoots: [...REQUIRED_VERIFICATION_ROOTS, "tavern/other.js"] },
    { ...valid, unexpected: true },
  ]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(invalid));
    await assert.rejects(readArtifactConfig(root), /invalid_(?:production_artifact_config|bundled_runtime_descriptor)/);
  }
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(valid));
  assert.deepEqual((await readArtifactConfig(root)).verificationRoots, REQUIRED_VERIFICATION_ROOTS);
}));


test("production config admits exactly the frozen Windows stale-lock reclaimer descriptor and rejects drift", async () => withFixture(async (root) => {
  const valid = productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    windowsStaleLockReclaimer: windowsStaleLockReclaimerDescriptor,
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  });
  for (const invalid of [
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, kind: "verified_windows_stale_lock_cleaner" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, destination: "native/other/win-x64" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, helper: "Other.exe" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, manifest: "other.manifest.json" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, probeEvidence: "extra.json" } },
    { ...valid, windowsStaleLockReclaimer: { ...windowsStaleLockReclaimerDescriptor, arbitrary: true } },
  ]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(invalid));
    await assert.rejects(readArtifactConfig(root), /invalid_windows_stale_lock_reclaimer_descriptor/);
  }
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(valid));
  assert.deepEqual((await readArtifactConfig(root)).windowsStaleLockReclaimer, windowsStaleLockReclaimerDescriptor);
}));


test("TypeScript build invocation is shell-free, argument-separated, and repository-resolved", async () => {
  const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.production.json" });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args.slice(1), ["--project", "tsconfig.production.json"]);
  assert.equal(Object.hasOwn(invocation, "shell"), false);
  assert.equal(invocation.args.some((argument) => argument.includes(" && ") || argument.includes(";")), false);
  assert.equal(invocation.args[0], await realpath(join(hostRoot, "node_modules", "typescript", "lib", "tsc.js")));
});


test("declared Magic Context package resolves to the freshly built approved artifact", async () => {
  const verified = await verifyDeclaredMagicContextArtifact();
  assert.match(verified.entry, /@cortexkit[\\/]pi-magic-context[\\/]dist[\\/]index\.js$/);
  assert.match(verified.sha256, /^[a-f0-9]{64}$/);
});


test("production build refuses a stale declared Magic Context package artifact", async () =>
  withFixture(async (root) => {
    const mismatchedSource = join(root, "different-magic-context-index.js");
    await writeFile(mismatchedSource, "export const stale = true;\n");
    await assert.rejects(
      verifyDeclaredMagicContextArtifact({ sourceEntry: mismatchedSource }),
      /magic_context_declared_package_artifact_stale/,
    );
  }));


test("default TypeScript project typechecks without emitting into an isolated output root", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "gamebuddy-default-typecheck-"));
  try {
    const before = await treeDigest(outputRoot);
    const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.json" });
    const result = await runChild(invocation.command, [...invocation.args, "--outDir", outputRoot], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    assert.equal(await treeDigest(outputRoot), before);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});


test("production TypeScript emits exactly the two roots' reachable closure", async () => {
  const emittedRoot = await mkdtemp(join(tmpdir(), "gamebuddy-production-tsc-"));
  try {
    const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.production.json" });
    const result = await runChild(invocation.command, [...invocation.args, "--outDir", emittedRoot], {
      cwd: invocation.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.equal(result.code, 0, result.stderr.toString("utf8"));
    const emitted = (await readdir(emittedRoot, { recursive: true })).map((path) => path.replaceAll("\\", "/"));
    for (const root of ["main.js", "stardew-attachment.js", "farmhand-companion-preview.js", ...REQUIRED_VERIFICATION_ROOTS]) assert.ok(emitted.includes(root));
    assert.ok(!emitted.includes("dialogue-web-main.js"), "removed entry must not be emitted");
    for (const required of [
      "tavern/player-turn-acceptance.internal.js",
      "tavern/provider-attempt-claim.internal.js",
      "continuity-semantic-provisioning/continuity-semantic-provisioning.internal.js",
      "continuity-semantic-store/continuity-semantic-production-store.js",
      "continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js",
    ]) assert.ok(emitted.includes(required));
    const provisioner = await readFile(
      join(emittedRoot, "continuity-semantic-provisioning", "continuity-semantic-provisioning.internal.js"),
      "utf8",
    );
    for (const forbiddenTestControl of [
      "setFreshPostMarkerHookForTest",
      "setProvisionCloseHookForTest",
      "setCanonicalAdmissionObserverForTest",
      "setAuthorityRootIdentityDerivationObserverForTest",
      "freshPostMarkerHookForTest",
      "provisionCloseHookForTest",
      "canonicalAdmissionObserverForTest",
      "authorityRootIdentityDerivationObserverForTest",
    ]) assert.ok(!provisioner.includes(forbiddenTestControl), `${forbiddenTestControl} leaked into production artifact`);
    for (const unreachable of [
      "continuity-authority-coordinator/continuity-authority-coordinator.js",
      "continuity-semantic-backend/continuity-semantic-backend.js",
          ]) assert.ok(!emitted.includes(unreachable));
  } finally {
    await rm(emittedRoot, { recursive: true, force: true });
  }
});

