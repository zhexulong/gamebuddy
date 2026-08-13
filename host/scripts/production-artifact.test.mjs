import assert from "node:assert/strict";
import { cp, lstat, mkdtemp, mkdir, readFile, readdir, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { DEFAULT_SUITE_TIMEOUT_MS, runBoundedChild } from "./test-supervisor.mjs";
import { resolveTypeScriptInvocation, verifyDeclaredMagicContextArtifact } from "./build-production-artifact.mjs";
import { assertCompleteProductionArtifact, copyApprovedResources, createInventory, publishProductionArtifact, readArtifactConfig, resolveProductionEntry, resolveProductionModule } from "./production-artifact.mjs";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-production-artifact-"));
  await mkdir(join(root, "resources"), { recursive: true });
  await mkdir(join(root, "node_modules", "typebox"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { typebox: "1.1.38" } }));
  await writeFile(join(root, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox", main: "index.js" }));
  await writeFile(join(root, "node_modules", "typebox", "index.js"), "export {};\n");
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } }));
  await writeFile(join(root, "resources/windows-named-mutex-broker.ps1"), "broker");
  return root;
}
async function withFixture(run) { const root = await fixture(); try { await run(root); } finally { await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } }

const scriptRoot = join(fileURLToPath(new URL(".", import.meta.url)), "");

async function runChild(command, args, options) {
  return runBoundedChild({
    command,
    args,
    cwd: options.cwd,
    stdio: options.stdio,
    timeoutMs: DEFAULT_SUITE_TIMEOUT_MS,
  });
}

async function treeDigest(root) {
  const digest = createHash("sha256");
  async function visit(path, relative) {
    let entry;
    try { entry = await lstat(path); } catch (error) {
      if (error?.code === "ENOENT") { digest.update(`absent:${relative}\n`); return; }
      throw error;
    }
    if (entry.isSymbolicLink()) { digest.update(`link:${relative}:${await readlink(path)}\n`); return; }
    if (entry.isFile()) { digest.update(`file:${relative}:`).update(await readFile(path)).update("\n"); return; }
    if (!entry.isDirectory()) throw new Error(`unexpected_artifact_entry:${relative}`);
    digest.update(`directory:${relative}\n`);
    for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`);
  }
  await visit(root, ".");
  return digest.digest("hex");
}

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

test("default TypeScript project typechecks without publishing or staging a production generation", async () => {
  const outputRoot = join(hostRoot, "dist");
  const before = await treeDigest(outputRoot);

  const invocation = await resolveTypeScriptInvocation({ project: "tsconfig.json" });
  const result = await runChild(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(result.code, 0, result.stderr.toString("utf8"));
  assert.equal(await treeDigest(outputRoot), before);
});

function validRootSource(label) {
  return `import "typebox";\nexport const generation = ${JSON.stringify(label)};\n`;
}

async function emit(root, content = "export {};\n") {
  const emitted = join(root, "emitted");
  await rm(emitted, { recursive: true, force: true }); await mkdir(emitted); await writeFile(join(emitted, "main.js"), `import "typebox";\n${content}`);
  return emitted;
}

test("publishes immutable versioned generations and an atomically replaced current pointer", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const first = await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "first"), outputRoot: dist });
  const firstEntry = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const second = await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "second"), outputRoot: dist });
  const secondEntry = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.notEqual(first.generation, second.generation);
  assert.notEqual(firstEntry.artifactRoot, secondEntry.artifactRoot);
  assert.equal(await readFile(firstEntry.entryPath, "utf8"), 'import "typebox";\nfirst');
  assert.equal(await readFile(secondEntry.entryPath, "utf8"), 'import "typebox";\nsecond');
  assert.deepEqual(second.entries.find((entry) => entry.path === "windows-named-mutex-broker.ps1")?.origin, { kind: "allowlisted_resource", source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1", config: "production-artifact.config.json" });
  await assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist });
}));

test("rejects unlisted, unused, unresolvable, and undocumented dynamic external closure ingress", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "unlisted";'), outputRoot: dist }), /external_package_unlisted/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "unused"] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /external_package_unused/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["missing"] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "missing";').then(async (emitted) => { await writeFile(join(emitted, "main.js"), 'import "missing";'); return emitted; }), outputRoot: dist }), /external_package_unresolvable/);
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
}));

test("rejects every dynamic import or require without an exact module, package, and expression rule", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'await import("typebox");'), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "require(process.env.MODULE);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, '/* import(process.env.MODULE) */ const text = "require(\\\"typebox\\\")";'), outputRoot: dist });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [{ package: "typebox", module: "wrong.js", expression: "process.env.MODULE" }] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(process.env.MODULE);"), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const missingModuleRule = { package: "typebox", module: "missing.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [missingModuleRule] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /dynamic_external_module_missing/);
  const duplicateRule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href" };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [duplicateRule, duplicateRule] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const duplicateModule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox", "@cortexkit/pi-magic-context"], dynamicExternalImports: [duplicateModule, { ...duplicateModule, package: "@cortexkit/pi-magic-context" }] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root), outputRoot: dist }), /invalid_declared_external_runtime_closure/);
  const exactRule = { package: "typebox", module: "main.js", expression: "pathToFileURL(magicContextEntry).href", occurrence: 0 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [exactRule] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);\nawait import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist }), /rule_bijection_failed/);
  const outOfRangeRule = { ...exactRule, occurrence: 2 };
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [outOfRangeRule] } }));
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist }), /dynamic_module_ingress_forbidden/);
  const orderedRules = [{ ...exactRule, occurrence: 0 }, { ...exactRule, occurrence: 1 }];
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: orderedRules } }));
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);\nawait import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist });
  await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"], dynamicExternalImports: [exactRule] } }));
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "await import(pathToFileURL(magicContextEntry).href);"), outputRoot: dist });
}));

test("requires every emitted relative module edge to resolve inside the selected immutable generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const valid = await emit(root, 'import "./support.js";\nexport {};');
  await writeFile(join(valid, "support.js"), "export {};\n");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: valid, outputRoot: dist });

  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "./missing.js";'), outputRoot: dist }),
    /production_relative_module_missing_from_artifact:main\.js:\.\/missing\.js/,
  );
  await assert.rejects(
    publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, 'import "../outside.js";'), outputRoot: dist }),
    /production_relative_module_escapes_artifact:main\.js:\.\.\/outside\.js/,
  );
}));

test("a failed publication preserves the previous verified current generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, "known-good"), outputRoot: dist });
  const before = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await writeFile(join(root, "emitted", "physical-fixture-worker.js"), "forbidden");
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: join(root, "emitted"), outputRoot: dist }), /test_artifact/);
  const after = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.equal(after.artifactRoot, before.artifactRoot);
  assert.equal(await readFile(after.entryPath, "utf8"), 'import "typebox";\nknown-good');
}));

test("rejects fixture workers broadly, tampering, orphans, symlinks, and invalid start entry names", async (t) => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root);
  for (const forbidden of ["helper.test.js", "test-fixtures/worker.js", "continuity-physical-fixture-worker.js", "fixture-worker.js"]) {
    await mkdir(join(emitted, "test-fixtures"), { recursive: true }); await writeFile(join(emitted, forbidden), "");
    await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist }), /test_artifact/);
    await rm(join(emitted, forbidden), { force: true });
  }
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const current = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await writeFile(join(current.artifactRoot, "orphan.js"), 'import "typebox";'); await assert.rejects(assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist }), /mismatch_or_orphan/);
  await rm(join(current.artifactRoot, "orphan.js")); await writeFile(current.entryPath, 'import "typebox";\ntampered'); await assert.rejects(assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist }), /mismatch_or_orphan/);
  for (const invalid of ["../main.js", "nested/main.js", "/main.js", "unknown.js", "main.js/.."]) await assert.rejects(resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: invalid }), /production_entry_not_configured/);
  const target = join(root, "outside.ps1"); await writeFile(target, "outside");
  try { await rm(join(root, "resources/windows-named-mutex-broker.ps1")); await symlink(target, join(root, "resources/windows-named-mutex-broker.ps1")); } catch (error) { t.skip(`symlink unavailable: ${error.code}`); return; }
  await assert.rejects(copyApprovedResources({ hostRoot: root, stagingRoot: join(root, "staging"), config: await readArtifactConfig(root) }), /symlink_or_reparse/);
}));

test("a starter retains the verified generation selected before a concurrent publisher changes current", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, validRootSource("old")), outputRoot: dist });
  const selected = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  await publishProductionArtifact({ hostRoot: root, emittedRoot: await emit(root, validRootSource("new")), outputRoot: dist });
  assert.equal(await readFile(selected.entryPath, "utf8"), `import "typebox";\n${validRootSource("old")}`);
}));

test("resolves only inventoried, untampered JavaScript modules from a selected immutable generation", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  const emitted = await emit(root, 'import "./support.js"; export {};');
  await writeFile(join(emitted, "support.js"), "export const trusted = true;\n");
  await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
  const selected = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  const resolved = await resolveProductionModule({ selected, module: "support.js" });
  assert.equal(await readFile(resolved.modulePath, "utf8"), "export const trusted = true;\n");
  for (const module of ["../support.js", "support.mjs", "missing.js", "test-fixtures/worker.js"]) {
    await assert.rejects(resolveProductionModule({ selected, module }), /production_module_(?:not_configured|escapes_generation|missing_from_inventory)/);
  }
  await writeFile(resolved.modulePath, "tampered");
  await assert.rejects(resolveProductionModule({ selected, module: "support.js" }), /production_module_integrity_mismatch/);
}));

test("concurrent publishers serialize, preserve current, and reject stale direct root artifacts", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true }); await writeFile(join(dist, "stale-main.js"), "stale");
  const first = join(root, "first"); const second = join(root, "second");
  await mkdir(first); await mkdir(second); await writeFile(join(first, "main.js"), 'import "typebox"; "first";'); await writeFile(join(second, "main.js"), 'import "typebox"; "second";');
  await assert.rejects(publishProductionArtifact({ hostRoot: root, emittedRoot: first, outputRoot: dist }), /production_output_root_contains_direct_artifact/);
  assert.equal(await readFile(join(dist, "stale-main.js"), "utf8"), "stale");
  await rm(join(dist, "stale-main.js"));
  const published = await Promise.all([publishProductionArtifact({ hostRoot: root, emittedRoot: first, outputRoot: dist }), publishProductionArtifact({ hostRoot: root, emittedRoot: second, outputRoot: dist })]);
  assert.notEqual(published[0].generation, published[1].generation);
  assert.deepEqual((await readdir(dist)).sort(), ["current.json", "generations"]);
  const current = await resolveProductionEntry({ hostRoot: root, outputRoot: dist, entry: "main.js" });
  assert.ok(['import "typebox"; "first";', 'import "typebox"; "second";'].includes(await readFile(current.entryPath, "utf8")));
  await assertCompleteProductionArtifact({ hostRoot: root, outputRoot: dist });
}));

test("starter accepts exactly one configured root then forwards config arguments", async () => withFixture(async (root) => {
  const dist = join(root, "dist");
  await mkdir(join(root, "scripts"));
  for (const script of ["production-artifact.mjs", "start-production-artifact.mjs"]) await cp(join(scriptRoot, script), join(root, "scripts", script));
  // The real verifier intentionally parses artifact modules with TypeScript.
  // Link the repository dependency into this synthetic standalone Host root so
  // its child process exercises the exact shipped startup code.
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  await symlink(join(hostRoot, "node_modules"), join(root, "node_modules"), "junction");
  const start = join(root, "scripts", "start-production-artifact.mjs");
  for (const entry of ["main.js", "dialogue-web-main.js"]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: [entry], resources: [{ source: "resources/windows-named-mutex-broker.ps1", destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } }));
    const emitted = join(root, `emitted-${entry}`); await mkdir(emitted); await writeFile(join(emitted, entry), 'import "typebox"; process.stdout.write(JSON.stringify(process.argv.slice(2)));');
    await publishProductionArtifact({ hostRoot: root, emittedRoot: emitted, outputRoot: dist });
    const child = await runChild(process.execPath, [start, entry, "--config", `${entry}.json`], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    assert.equal(child.code, 0, child.stderr.toString());
    assert.equal(child.stdout.toString(), JSON.stringify(["--config", `${entry}.json`]));
  }
  for (const entry of ["../main.js", "nested/main.js", "unknown.js"]) {
    await assert.rejects(runChild(process.execPath, [start, entry], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }), /test_runner_failed:code=1/);
  }
}));

test("rejects test, fixture, and legacy resource declarations before source I/O", async () => withFixture(async (root) => {
  for (const source of ["resources/example.test.ps1", "src/test-fixtures/missing.ps1", "resources/legacy-writer-fixture.ps1"]) {
    await writeFile(join(root, "production-artifact.config.json"), JSON.stringify({ entryRoots: ["main.js"], resources: [{ source, destination: "windows-named-mutex-broker.ps1" }], externalRuntimeClosure: { kind: "declared_external_runtime_closure", packages: ["typebox"] } }));
    await assert.rejects(readArtifactConfig(root), /production_resource_source_forbidden/);
  }
}));
