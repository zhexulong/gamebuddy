/**
 * The external closure a generation may reach, and every ingress it must refuse.
 *
 * Declared packages resolve with Host-root-contained ESM semantics and only from the
 * generation's own tree; an unclaimed file under node_modules is still a violation, a scoped
 * namespace symlink or package-root escape is refused before a manifest is read, and the
 * closure claim exempts exactly what it claims. The dynamic-import, `process.getBuiltinModule`
 * and module-loader forms are refused even when a comment, a string or an unrelated reflection
 * makes them look like ingress, and the legacy continuity namespaces stay rejected by category.
 */
import assert from "node:assert/strict";
import { lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  productionConfig,
  withFixture,
  publishTestArtifactForFixture,
  emit,
} from "./production-artifact-fixtures.test-support.mjs";
import { createIncompleteRuntimeFixture } from "./production-artifact-runtime-test-support.mjs";
import { assertCompleteTestArtifact, resolveTestArtifactEntry } from "./production-artifact-test-support.mjs";
import { createInventory, parseEsmResolutionProbeResult } from "./production-artifact.mjs";

test("rejects unlisted, unused, unresolvable, and undocumented dynamic external closure ingress", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "unlisted";'), outputRoot: dist }), /external_package_unlisted/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "unused"] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /external_package_unused/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["missing"] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "missing";').then(async (emitted) => { await writeFile(join(emitted, "main.js"), 'import "missing";'); return emitted; }), outputRoot: dist }), /external_package_unresolvable/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
}));


test("resolves declared external runtime packages with Host-root-contained ESM import semantics", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const voiceProtocolRoot = join(root, "node_modules", "@gamebuddy", "voice-protocol");
  const importOnlyRoot = join(root, "node_modules", "@cortexkit", "pi-magic-context");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38", "@gamebuddy/voice-protocol": "workspace:*", "@cortexkit/pi-magic-context": "file:../vendor/magic-context/packages/pi-plugin" } }));
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@cortexkit/pi-magic-context", "@gamebuddy/voice-protocol", "typebox"] } })));
  await mkdir(voiceProtocolRoot, { recursive: true });
  await writeFile(join(voiceProtocolRoot, "package.json"), JSON.stringify({ name: "@gamebuddy/voice-protocol", exports: "./index.js" }));
  await writeFile(join(voiceProtocolRoot, "index.js"), "export {};\n");
  await mkdir(join(importOnlyRoot, "dist"), { recursive: true });
  await writeFile(join(importOnlyRoot, "package.json"), JSON.stringify({ name: "@cortexkit/pi-magic-context", type: "module", exports: { ".": { import: "./dist/index.js" } } }));
  await writeFile(join(importOnlyRoot, "dist", "index.js"), "export {};\n");
  const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "@gamebuddy/voice-protocol"; import "@cortexkit/pi-magic-context";'), outputRoot: dist });
  assert.deepEqual(published.externalRuntimeClosure.verifiedPackages, ["@cortexkit/pi-magic-context", "@gamebuddy/voice-protocol", "typebox"]);
  await rm(importOnlyRoot, { recursive: true });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@cortexkit/pi-magic-context", "typebox"] } })));
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "@cortexkit/pi-magic-context";'), outputRoot: dist }),
    /production_external_package_unresolvable:@cortexkit\/pi-magic-context/,
  );
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@gamebuddy/voice-protocol", "typebox"] } })));
  await rm(voiceProtocolRoot, { recursive: true });
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "@gamebuddy/voice-protocol";'), outputRoot: dist }),
    /production_external_package_unresolvable:@gamebuddy\/voice-protocol/,
  );
  const requireOnlyRoot = join(root, "node_modules", "require-only-esm");
  await mkdir(requireOnlyRoot, { recursive: true });
  await writeFile(join(requireOnlyRoot, "package.json"), JSON.stringify({ name: "require-only-esm", exports: { ".": { require: "./require.cjs" } } }));
  await writeFile(join(requireOnlyRoot, "require.cjs"), "module.exports = {};\n");
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { "require-only-esm": "1.0.0", typebox: "1.1.38" } }));
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["require-only-esm", "typebox"] } })));
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "require-only-esm";'), outputRoot: dist }),
    /production_external_package_unresolvable:require-only-esm/,
  );
  const nestedHostRoot = join(root, "nested-host");
  await mkdir(join(nestedHostRoot, "resources"), { recursive: true });
  await mkdir(join(nestedHostRoot, "node_modules"));
  await writeFile(join(nestedHostRoot, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(nestedHostRoot, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } })));
  await writeFile(join(nestedHostRoot, "resources", "windows-named-mutex-broker.ps1"), "broker");
  await createIncompleteRuntimeFixture(nestedHostRoot);
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: nestedHostRoot, emittedRoot: await emit(nestedHostRoot, "export {};"), outputRoot: join(nestedHostRoot, "dist") }),
    /production_external_package_unresolvable:typebox/,
  );
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "unlisted-runtime-package";'), outputRoot: dist }),
    /production_external_package_unlisted:unlisted-runtime-package:main\.js/,
  );
}));


test("resolver rejects a scoped namespace symlink before package manifest reads", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  const outside = `${root}-outside`;
  const scope = join(root, "node_modules", "@scope");
  try {
    await mkdir(join(outside, "pkg"), { recursive: true });
    await writeFile(join(outside, "pkg", "package.json"), JSON.stringify({ name: "@scope/pkg", exports: "./index.js" }));
    await writeFile(join(outside, "pkg", "index.js"), "export {};\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38", "@scope/pkg": "1.0.0" } }));
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["@scope/pkg", "typebox"] } })));
    try { await symlink(outside, scope, process.platform === "win32" ? "junction" : "dir"); }
    catch (error) { if (process.platform === "win32" && error?.code === "EPERM") { t.skip("Windows junction unavailable: EPERM"); return; } throw error; }
    await assert.rejects(
      publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "@scope/pkg";'), outputRoot: dist }),
      /production_external_package_unresolvable:@scope\/pkg/,
    );
  } finally { await rm(outside, { recursive: true, force: true }); }
}));


test("a generation resolves its declared closure from its own tree, so a repository-only package cannot stand in for it", async () => withFixture(async (root) => {
  // The defect Ruling 1 closes: resolution used to run from the developer
  // repository, so a generation could publish with NO closure of its own and
  // then fail with ERR_MODULE_NOT_FOUND once moved outside the repository.
  // Remove the fixture's package and assert publication now fails: the closure
  // must come from the artifact, not from wherever the publisher happens to run.
  const dist = join(root, "dist");
  const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist });
  const artifactRoot = join(dist, "test-generations", published.generation);
  assert.ok(
    published.entries.some((entry) => entry.path === "node_modules/typebox/package.json"
      && entry.origin?.kind === "declared_external_runtime_closure"),
    "the published generation must carry the declared closure as a claimed artifact tree",
  );
  assert.ok(published.entries.some((entry) => entry.path === "package.json"),
    "the generation must carry its own resolution manifest, or the closure is unresolvable in place");
  // A staged closure file is bound by the inventory, so tampering must fail.
  await writeFile(join(artifactRoot, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", main: "index.js", tampered: true }));
  await assert.rejects(
    assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }),
    /production_inventory_mismatch_or_orphan/,
  );
}));


test("the closure claim exempts only what it claims: an unclaimed file under node_modules is still rejected", async () => withFixture(async (root) => {
  // The exemption added for the staged closure is derived from the origin claim,
  // never from a `node_modules/` path prefix. A previous attempt widened it to a
  // prefix and silently admitted arbitrary files, so pin the boundary here.
  const dist = join(root, "dist");
  const published = await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist });
  const artifactRoot = join(dist, "test-generations", published.generation);
  // Claimed: the closure tree the publisher adopted.
  assert.ok(published.entries.some((entry) => entry.path.startsWith("node_modules/")
    && entry.origin?.kind === "declared_external_runtime_closure"));
  // Unclaimed: a module that no claim covers must not be admitted just because
  // it lives under the closure directory.
  await writeFile(join(artifactRoot, "node_modules", "foreign.js"), "export {};\n");
  await assert.rejects(
    assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }),
    /production_inventory_mismatch_or_orphan|production_module_unreachable_from_entry_roots/,
  );
  // An unclaimed non-JavaScript file is likewise not an allowlisted resource.
  await rm(join(artifactRoot, "node_modules", "foreign.js"));
  await writeFile(join(artifactRoot, "node_modules", "foreign.dat"), "not a resource");
  await assert.rejects(
    assertCompleteTestArtifact({ hostRoot: root, outputRoot: dist }),
    /production_inventory_mismatch_or_orphan|production_file_not_allowlisted_resource/,
  );
}));


test("resolver probe accepts only the exact JSON object and string tuple grammar", () => {
  const specifiers = ["typebox"];
  assert.deepEqual(parseEsmResolutionProbeResult(JSON.stringify({ schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", "file:///package/index.js"]] }), specifiers), [["typebox", "file:///package/index.js"]]);
  for (const value of [
    { schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", "file:///package/index.js"]], extra: true },
    { schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", "file:///package/index.js", "extra"]] },
    { schema: "gamebuddy-production-esm-resolution/v1", resolved: [["typebox", 1]] },
    ["gamebuddy-production-esm-resolution/v1", [["typebox", "file:///package/index.js"]]],
  ]) assert.throws(() => parseEsmResolutionProbeResult(JSON.stringify(value), specifiers), /invalid_esm_probe_result/);
});


test("fixed resolver probe never executes a Host-root collision, entry, or inherited NODE_OPTIONS preload", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const collision = join(root, ".production-artifact-esm-resolution-probe.mjs");
  const preload = join(root, "hostile-preload.cjs");
  const preloadSentinel = join(root, "preload-executed.txt");
  const entrySentinel = join(root, "entry-executed.txt");
  await writeFile(collision, "collision survives");
  await writeFile(preload, `require("node:fs").writeFileSync(${JSON.stringify(preloadSentinel)}, "executed");`);
  await writeFile(join(root, "node_modules", "typebox", "index.js"), `require("node:fs").writeFileSync(${JSON.stringify(entrySentinel)}, "executed");`);
  const saved = process.env.NODE_OPTIONS;
  try {
    process.env.NODE_OPTIONS = `--require=${preload}`;
    await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist });
  } finally { if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved; }
  await assert.rejects(lstat(preloadSentinel), { code: "ENOENT" });
  await assert.rejects(lstat(entrySentinel), { code: "ENOENT" });
  assert.equal(await readFile(collision, "utf8"), "collision survives");
}));


test("resolver rejects package entry escape and package-root symlink", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", exports: "../outside.js" }));
  await writeFile(join(root, "outside.js"), "export {};\n");
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /production_external_package_unresolvable:typebox/);
  const outside = join(root, "outside-package");
  await mkdir(outside); await writeFile(join(outside, "package.json"), JSON.stringify({ name: "typebox", exports: "./index.js" })); await writeFile(join(outside, "index.js"), "export {};\n");
  await rm(join(root, "node_modules", "typebox"), { recursive: true, force: true });
  try { await symlink(outside, join(root, "node_modules", "typebox"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) { if (process.platform === "win32" && error?.code === "EPERM") { t.skip("Windows symlink unavailable: EPERM"); return; } throw error; }
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /production_external_package_unresolvable:typebox/);
}));


test("rejects every dynamic import or require without an exact module, package, and expression rule", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");'), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "require(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, '/* import(process.env.MODULE) */ const text = "require(\\\"typebox\\\")";'), outputRoot: dist });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [{ package: "typebox", module: "wrong.js", expression: "process.env.MODULE" }] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const missingModuleRule = { package: "typebox", module: "missing.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [missingModuleRule] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /dynamic_external_module_missing/);
  const duplicateRule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href" };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [duplicateRule, duplicateRule] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const duplicateModule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "@cortexkit/pi-magic-context"], dynamicExternalImports: [duplicateModule, { ...duplicateModule, package: "@cortexkit/pi-magic-context" }] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const exactRule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [exactRule] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);\nawait import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist }), /rule_bijection_failed/);
  const outOfRangeRule = { ...exactRule, occurrence: 2 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [outOfRangeRule] } })));
  await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  const orderedRules = [{ ...exactRule, occurrence: 0 }, { ...exactRule, occurrence: 1 }];
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: orderedRules } })));
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);\nawait import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [exactRule] } })));
   await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist });
}));


test("accepts emitted string-literal dynamic imports declared in canonical JSON form with exact occurrences", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const literalRule = { package: "typebox", module: "main.js", expression: '"typebox"', occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [literalRule] } })));
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");'), outputRoot: dist });
  const orderedRules = [{ ...literalRule, occurrence: 0 }, { ...literalRule, occurrence: 1 }];
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: orderedRules } })));
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");\nawait import("typebox");'), outputRoot: dist });
  for (const expression of ['', '"typebox', '"typebox"x', 'typebox', '"', '"typebox" ']) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [{ package: "typebox", module: "main.js", expression, occurrence: 0 }] } })));
    await assert.rejects(publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");'), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  }
}));


test("accepts declared static external imports while rejecting the same module through dynamic import", async () => withFixture(async (root) => {
  const dist = join(root, "static-external-dist");
  const packageRoot = join(root, "node_modules", "typebox");
  await writeFile(join(packageRoot, "index.js"), "export const marker = 1;\\n");
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({
    entryRoots: ["main.js"],
    resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }],
    externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] },
  })));
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import { marker } from "typebox"; console.log(marker);'), outputRoot: dist });
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");'), outputRoot: join(root, "dynamic-external-dist") }),
    /dynamic_module_ingress_forbidden/,
  );
}));


test("rejects concrete process.getBuiltinModule loader ingress forms without treating comments, strings, or unrelated reflection as ingress", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  for (const source of [
    'const require = process.getBuiltinModule("module").createRequire(import.meta.url); require("unlisted");',
    'const module = process?.getBuiltinModule?.("module");',
    'const getBuiltinModule = process["getBuiltinModule"]; const module = getBuiltinModule("module");',
    'const { getBuiltinModule } = process; const module = getBuiltinModule("module");',
    'const { getBuiltinModule: loader } = process; const module = loader("module");',
    'const loader = Reflect.get(process, "getBuiltinModule"); const module = loader("module");',
    'const descriptor = Object.getOwnPropertyDescriptor?.(process, "getBuiltinModule"); const module = descriptor?.value("module");',
    'const loader = Reflect["get"](process, "getBuiltinModule"); const module = loader("module");',
    'const loader = Reflect["get"]?.(process, "getBuiltinModule"); const module = loader?.("module");',
    'const descriptor = Object["getOwnPropertyDescriptor"](process, "getBuiltinModule"); const module = descriptor.value("module");',
    'const descriptor = Object["getOwnPropertyDescriptor"]?.(process, "getBuiltinModule"); const module = descriptor?.value?.("module");',
    'const descriptor = Object["getOwn" + "PropertyDescriptor"](process, "getBuiltinModule"); const module = descriptor.value("module");',
    'const builtin = globalThis.process["getBuiltin" + "Module"]; const module = builtin("module");',
    'const processRef = globalThis["pro" + "cess"]; const descriptor = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule"); const module = descriptor.value("module");',
    'const processRef = globalThis["process"]; const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
    'const processRef = globalThis.global.process; const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
    'const processRef = (globalThis).global.process; const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
    'const processRef = (process); const builtin = Object.getOwnPropertyDescriptor(processRef, "getBuiltinModule").value; const raw = builtin("node:module").createRequire(import.meta.url)("./chat-thread-store.js").acceptP4MountedPlayerMessage; void raw;',
  ]) {
    await assert.rejects(
      publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, source), outputRoot: dist }),
      /production_process_get_builtin_module_ingress_forbidden:main\.js/,
    );
  }
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [{ package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 }] } })));
  await publishTestArtifactForFixture({
    hostRoot: root,
    emittedRoot: await emit(root, 'import "node:fs"; await import(pathToFileURL(magicContextEntry).href); /* process.getBuiltinModule("module") */ const text = "process.getBuiltinModule(\\\"module\\\")"; Reflect.get(process, "getBuiltinModuleName"); Object.getOwnPropertyDescriptor(process, "getBuiltinModuleName"); Reflect["get"]?.(process, "getBuiltinModuleName"); Object["getOwnPropertyDescriptor"]?.(process, "getBuiltinModuleName");'),
    outputRoot: dist,
  });
}));


test("accepts a literal builtin id that cannot carry a package ingress, and still rejects a computed one", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify(productionConfig({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [] } })));
  // The declared dependencies reach for Node builtins this way to stay browser-compatible; a literal id
  // names something the admitted runtime already carries, so it cannot introduce a package ingress.
  await publishTestArtifactForFixture({
    hostRoot: root,
    emittedRoot: await emit(root, 'import "typebox"; export const os = process.getBuiltinModule?.("node:os") ?? null; export const zlib = process.getBuiltinModule("node:zlib");'),
    outputRoot: dist,
  });
  for (const source of [
    'import "typebox"; const name = "node:os"; export const os = process.getBuiltinModule(name);',
    'import "typebox"; export const loader = process.getBuiltinModule("node:module");',
  ]) {
    await assert.rejects(
      publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, source), outputRoot: join(root, "rejected-dist") }),
      /production_process_get_builtin_module_ingress_forbidden:main\.js/,
    );
  }
}));


test("rejects node module-loader ingress and its bare alias before createRequire can bypass external closure", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  for (const source of [
    'import { createRequire } from "node:module"; const r = createRequire(import.meta.url); r("unlisted");',
    'import { createRequire } from "module"; const r = createRequire(import.meta.url); r("unlisted");',
    'export { createRequire } from "node:module";',
    'export { createRequire } from "module";',
  ]) {
    await assert.rejects(
      publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, source), outputRoot: dist }),
      /production_module_loader_ingress_forbidden:main\.js:(?:node:)?module/,
    );
  }
}));


test("requires every emitted relative module edge to resolve inside the selected immutable generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const valid = await emit(root, 'import "./support.js";\nexport {};');
  await writeFile(join(valid, "support.js"), "export {};\n");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: valid, outputRoot: dist });

  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "./missing.js";'), outputRoot: dist }),
    /production_relative_module_missing_from_artifact:main\.js:\.\/missing\.js/,
  );
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, 'import "../outside.js";'), outputRoot: dist }),
    /production_relative_module_escapes_artifact:main\.js:\.\.\/outside\.js/,
  );
}));


test("rejects reachable nested game-origin-authority artifacts by category and preserves current", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishTestArtifactForFixture({ hostRoot: root, emittedRoot: await emit(root, "known-good"), outputRoot: dist });
  const before = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const emitted = await emit(root, "candidate");
  const forbidden = "game-origin-authority/nested/authority.js";
  await mkdir(join(emitted, "game-origin-authority", "nested"), { recursive: true });
  await writeFile(join(emitted, forbidden), 'import "typebox"; export const reachable = true;');
  await writeFile(join(emitted, "main.js"), 'import "typebox"; import "./game-origin-authority/nested/authority.js";');
  await assert.rejects(
    publishTestArtifactForFixture({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }),
    /production_legacy_continuity_module_forbidden:game-origin-authority\/nested\/authority\.js/,
  );
  const after = await resolveTestArtifactEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.equal(after.artifactRoot, before.artifactRoot);
  assert.equal(await readFile(after.entryPath, "utf8"), 'import "typebox";\nknown-good');
}));


test("rejects every legacy continuity artifact namespace by category", async () => withFixture(async (root) => {
  const legacyModules = [
    "continuity-authority-coordinator/nested/reintroduced.js",
    "continuity-authority-routing/nested/reintroduced.js",
    "continuity-production-migration/nested/reintroduced.js",
    "continuity-semantic-backend/nested/reintroduced.js",
    "continuity.js",
    "game-origin-authority/nested/reintroduced.js",
    "game-surface-lease.js",
    "game-surface-recovery.js",
    "game-surface-lifecycle/nested/reintroduced.js",
    "integration-bootstrap.js",
    "local-bootstrap.js",
  ];
  for (const module of legacyModules) {
    const emitted = await emit(root, "candidate");
    await rm(join(emitted, "browser"), { recursive: true, force: true });
    await mkdir(dirname(join(emitted, module)), { recursive: true });
    await writeFile(join(emitted, module), "export {};\n");
    await assert.rejects(
      createInventory({
        artifactRoot: emitted,
        hostRoot: root,
        origins: new Map(),
        entryRoots: [],
        externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: [] },
      }),
      (error) => error?.message === `production_legacy_continuity_module_forbidden:${module}`,
    );
  }
}));

