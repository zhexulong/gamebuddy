import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

import {
  artifactZone,
  assertResolutionOutsideRepository,
  declaredPackagesOf,
  generationBuildInvocation,
  isolatedEnvironment,
  machineProfileAbsolutePaths,
  parseBootstrapStart,
  parseCurrentPointer,
  parseResolutionProbeOutput,
  parseRuntimeAdmission,
  reportPackagingCompleteness,
  repositoryAbsolutePaths,
  scanGenerationEnvironmentCoupling,
  staticGateVerdict,
  verifyGenerationStatic,
  verifySelfContainedGeneration,
} from "./verify-self-contained-generation.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GENERATION = "g-test-generation";

/**
 * Publishes a synthetic output root with every piece the assertion names. It is
 * deliberately not a real runtime: the produced generation's closure layout is
 * what the assertion reads, and the executor itself is stubbed so the test never
 * depends on a downloaded Node distribution.
 */
async function publishFixture({ entries = undefined, omit = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-self-contained-fixture-"));
  const generationRoot = join(root, "generations", GENERATION);
  const runtimeBytes = Buffer.from("fixture-runtime-binary");
  const runtimeAdmission = {
    schema: "host-runtime-admission/v1",
    runtimePath: "runtime/node.exe",
    runtimeSha256: sha256(runtimeBytes),
    bootstrapPath: "bootstrap/entry/desktop-host-entry.internal.js",
    runtimeClosure: { schema: "host-bundled-runtime-closure/v1", files: entries ?? [{ path: "runtime/README.md", sha256: sha256("readme") }] },
  };
  const files = new Map([
    [join(generationRoot, "package.json"), JSON.stringify({ name: "gamebuddy-host-generation", private: true, type: "module", dependencies: { typebox: "*" } })],
    [join(generationRoot, "production-inventory.json"), "{}\n"],
    [join(generationRoot, "main.js"), "export {};\n"],
    [join(generationRoot, "host-runtime-admission.json"), JSON.stringify(runtimeAdmission)],
    [join(generationRoot, "runtime", "node.exe"), runtimeBytes],
    [join(generationRoot, "runtime", "README.md"), "readme"],
    [join(generationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"), "export {};\n"],
    [join(generationRoot, "native", "stardew-mod", "GameBuddy", "GameBuddy.Stardew.dll"), "mod"],
    // The mod-loader payload the one-click install copies into a player's game folder, and the
    // licence its LGPL terms require beside it. A generation carries all three or the install
    // can only refuse after the player has already chosen their folder.
    [join(generationRoot, "native", "smapi", "win-x64", "StardewModdingAPI.exe"), "loader"],
    [join(generationRoot, "native", "smapi", "payload-manifest.json"), "{\n"],
    [join(generationRoot, "native", "smapi", "SMAPI-LICENSE.txt"), "licence\n"],
    [join(generationRoot, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox" })],
  ]);
  for (const path of omit) files.delete(path);
  for (const [path, content] of files) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(join(root, "current.json"), JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation: GENERATION, inventoryDigest: "a".repeat(64), runtimeAdmissionSha256: "b".repeat(64) }));
  return { root, generationRoot, runtimeAdmission };
}

function stubbedSpawn({ resolutionIntoRepository = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const probeIndex = args.findIndex((argument) => argument.endsWith("resolution-probe.mjs"));
    if (probeIndex >= 0) {
      const generationRoot = args[probeIndex + 1];
      const specifiers = args.slice(probeIndex + 2);
      const report = specifiers.map((specifier) => {
        const relative = specifier === "./main.js" ? "main.js" : join("node_modules", specifier, "package.json");
        const file = resolutionIntoRepository && specifier === "typebox"
          ? resolve(repositoryRoot, "package.json")
          : resolve(generationRoot, relative);
        return [specifier, pathToFileURL(file).href, true];
      });
      return { status: 0, stdout: JSON.stringify(report), stderr: "", error: undefined, signal: null };
    }
    return {
      status: 1,
      stdout: `${JSON.stringify({ schema: "gamebuddy-desktop-host-bootstrap-status/v1", protocolVersion: 1, stage: "bootstrap-frame" })}\n`,
      stderr: "desktop_runtime_bootstrap_unavailable\n",
      error: undefined,
      signal: null,
    };
  };
  return { spawn, calls };
}

test("a generation without the mod-loader payload or its licence is incomplete by name", async () => {
  // The defect this pins: the one-click install reads this payload by manifest, so a
  // generation that lost it - or kept the loader but dropped the LGPL text - can only refuse
  // the install, after the player already picked their game folder. The packaging report
  // names the missing piece instead of letting the download ship.
  for (const [omit, piece] of [
    [join("native", "smapi", "win-x64", "StardewModdingAPI.exe"), "smapiLoader"],
    [join("native", "smapi", "payload-manifest.json"), "smapiManifest"],
    [join("native", "smapi", "SMAPI-LICENSE.txt"), "smapiLicense"],
  ]) {
    const fixture = await publishFixture();
    try {
      await rm(join(fixture.generationRoot, omit));
      const packaging = await reportPackagingCompleteness({
        outputRoot: fixture.root,
        generationRoot: fixture.generationRoot,
      });
      assert.equal(packaging[piece], "absent", piece);
      // The pieces that were not omitted are still reported, so the failure names which one
      // is missing rather than "the package is broken".
      assert.notEqual(packaging.offlineRuntime, "absent");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("the assertion copies the generation outside the repository and starts it with the packaged runtime", async () => {
  const fixture = await publishFixture();
  const { spawn, calls } = stubbedSpawn();
  try {
    const result = await verifySelfContainedGeneration({ outputRoot: fixture.root, spawn });
    assert.equal(result.schema, "gamebuddy-self-contained-generation/v1");
    assert.equal(result.ok, true);
    assert.equal(result.generation, GENERATION);
    assert.equal(result.executor, "runtime/node.exe");
    assert.deepEqual(result.bootstrap, { reachedBootstrapFrame: true, boundedFailureCode: "desktop_runtime_bootstrap_unavailable" });
    assert.deepEqual(result.packaging, {
      offlineRuntime: `generations/${GENERATION}/runtime/node.exe`,
      hostBuild: `generations/${GENERATION}/main.js`,
      modBuild: `generations/${GENERATION}/native/stardew-mod/GameBuddy/GameBuddy.Stardew.dll`,
      desktopBundle: "absent",
      smapiLoader: `generations/${GENERATION}/native/smapi/win-x64/StardewModdingAPI.exe`,
      smapiManifest: `generations/${GENERATION}/native/smapi/payload-manifest.json`,
      smapiLicense: `generations/${GENERATION}/native/smapi/SMAPI-LICENSE.txt`,
    });
    // Both probes run the packaged runtime by absolute path, never a PATH node,
    // and both run from inside the moved tree.
    assert.equal(calls.length, 2);
    for (const call of calls) assert.match(call.command, /gamebuddy-self-contained-[^\\/]+.*runtime[\\/]node\.exe$/);
    const boot = calls.at(-1);
    assert.deepEqual(boot.options.stdio, ["ignore", "pipe", "pipe"]);
    assert.ok(!(boot.options.env.PATH ?? "").toLowerCase().includes("node"));
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a missing mod build, runtime, or closure file fails with the exact named reason", async () => {
  for (const [omit, reason] of [
    [[join("native", "stardew-mod", "GameBuddy", "GameBuddy.Stardew.dll")], "missing_stardew_mod_package"],
    [[join("runtime", "node.exe")], "missing_bundled_runtime"],
    [[join("bootstrap", "entry", "desktop-host-entry.internal.js")], "missing_host_bootstrap"],
    [[join("node_modules", "typebox", "package.json")], "missing_external_package:typebox"],
  ]) {
    const fixture = await publishFixture();
    try {
      await rm(join(fixture.generationRoot, ...omit));
      await assert.rejects(
        verifySelfContainedGeneration({ outputRoot: fixture.root, spawn: stubbedSpawn().spawn }),
        new RegExp(`self_contained_generation_failed:${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test("an incomplete bundled runtime closure names the missing path", async () => {
  const fixture = await publishFixture({ entries: [{ path: "runtime/absent.dll", sha256: sha256("x") }] });
  try {
    await assert.rejects(
      verifySelfContainedGeneration({ outputRoot: fixture.root, spawn: stubbedSpawn().spawn }),
      /self_contained_generation_failed:runtime_closure_incomplete:runtime\/absent\.dll$/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a resolution that lands inside the repository is refused by name", async () => {
  const fixture = await publishFixture();
  const { spawn } = stubbedSpawn({ resolutionIntoRepository: true });
  try {
    await assert.rejects(
      verifySelfContainedGeneration({ outputRoot: fixture.root, spawn }),
      /self_contained_generation_failed:resolution_probe_inside_repository:typebox:/,
    );
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a module-resolution failure is never reported as a bounded start", () => {
  const status = `${JSON.stringify({ schema: "gamebuddy-desktop-host-bootstrap-status/v1", protocolVersion: 1, stage: "bootstrap-frame" })}\n`;
  assert.throws(
    () => parseBootstrapStart(1, status, "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typebox'\n"),
    /self_contained_generation_failed:host_entry_module_resolution_failed$/,
  );
  assert.throws(
    () => parseBootstrapStart(1, "", "desktop_runtime_bootstrap_unavailable\n"),
    /self_contained_generation_failed:host_entry_did_not_reach_bootstrap_frame$/,
  );
  assert.throws(
    () => parseBootstrapStart(1, status, `${"Error: at /repo/host/src/main.ts:1:1\n".repeat(4)}`),
    /self_contained_generation_failed:host_entry_unbounded_failure$/,
  );
  assert.throws(
    () => parseBootstrapStart(0, status, "desktop_runtime_bootstrap_unavailable\n"),
    /self_contained_generation_failed:host_entry_unexpected_success$/,
  );
});

test("pointer, admission, dependency, and probe grammars are exact", () => {
  assert.equal(parseCurrentPointer(JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation: GENERATION })).generation, GENERATION);
  assert.throws(() => parseCurrentPointer(JSON.stringify({ schema: "gamebuddy-host-production-current/v1", generation: GENERATION })), /invalid_current_pointer$/);
  assert.throws(() => parseCurrentPointer(JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation: "../escape" })), /invalid_current_pointer$/);
  assert.equal(parseRuntimeAdmission(JSON.stringify({ schema: "host-runtime-admission/v1", runtimePath: "runtime/node.exe", runtimeSha256: "a".repeat(64), bootstrapPath: "b", runtimeClosure: { files: [] } })).runtimePath, "runtime/node.exe");
  assert.throws(() => parseRuntimeAdmission(JSON.stringify({ schema: "host-runtime-admission/v2" })), /invalid_runtime_admission$/);
  assert.deepEqual(declaredPackagesOf(JSON.stringify({ dependencies: { typebox: "*", zod: "*" } })), ["typebox", "zod"]);
  assert.throws(() => declaredPackagesOf("{}"), /missing_generation_dependencies$/);
  assert.throws(() => parseResolutionProbeOutput("not json", ["typebox"]), /resolution_probe_output_invalid$/);
  assert.throws(() => parseResolutionProbeOutput(JSON.stringify([["other", "file:///a.js", true]]), ["typebox"]), /resolution_probe_output_invalid$/);
  assert.deepEqual(parseResolutionProbeOutput(JSON.stringify([["typebox", "file:///a.js", true]]), ["typebox"]), [{ specifier: "typebox", url: "file:///a.js", exists: true }]);
});

test("resolution outside the generation or inside the repository is refused with the resolved path", () => {
  const outside = pathToFileURL(resolve(repositoryRoot, "..", "outside-generation", "index.js")).href;
  assert.throws(
    () => assertResolutionOutsideRepository({ entries: [{ specifier: "typebox", url: outside, exists: true }], generationRoot: resolve(repositoryRoot, "gen"), repository: repositoryRoot, label: "resolution_probe" }),
    /resolution_probe_outside_generation:typebox:/,
  );
  assert.throws(
    () => assertResolutionOutsideRepository({ entries: [{ specifier: "typebox", url: pathToFileURL(resolve(repositoryRoot, "package.json")).href, exists: true }], generationRoot: resolve(repositoryRoot, "gen"), repository: repositoryRoot, label: "resolution_probe" }),
    /resolution_probe_inside_repository:typebox:/,
  );
  assert.throws(
    () => assertResolutionOutsideRepository({ entries: [{ specifier: "typebox", url: "", exists: false }], generationRoot: resolve(repositoryRoot, "gen"), repository: repositoryRoot, label: "resolution_probe" }),
    /resolution_probe_unresolved:typebox$/,
  );
  assert.throws(
    () => assertResolutionOutsideRepository({ entries: [{ specifier: "typebox", url: "https://example.invalid/index.js", exists: true }], generationRoot: resolve(repositoryRoot, "gen"), repository: repositoryRoot, label: "resolution_probe" }),
    /resolution_probe_not_a_file:typebox$/,
  );
});

test("the packaged runtime is the only executor: PATH carries no node", () => {
  const environment = isolatedEnvironment({ SystemRoot: "D:\\Windows", Path: "C:\\dev\\node", NODE_OPTIONS: "--require=evil" });
  assert.equal(environment.PATH, "D:\\Windows\\System32");
  assert.equal(environment.Path, undefined);
  assert.equal(environment.NODE_OPTIONS, undefined);
});

test("the build step reuses the repository generator and refuses to invent an output root", () => {
  const invocation = generationBuildInvocation({ root: repositoryRoot, runtimeTree: resolve(repositoryRoot, "runtime-tree"), outputRoot: resolve(repositoryRoot, "out") });
  assert.equal(invocation.command, process.execPath);
  assert.equal(invocation.cwd, repositoryRoot);
  assert.deepEqual([...invocation.args], [resolve(repositoryRoot, "scripts", "build-desktop-launcher-test-generation.mjs"), resolve(repositoryRoot, "out"), resolve(repositoryRoot, "runtime-tree"), "--full-runtime-tree"]);
  assert.throws(() => generationBuildInvocation({ root: repositoryRoot, runtimeTree: resolve(repositoryRoot, "runtime-tree") }), /self_contained_generation_failed:build_output_root_required$/);
  assert.throws(() => generationBuildInvocation({ root: repositoryRoot, outputRoot: resolve(repositoryRoot, "out") }), /self_contained_generation_failed:runtime_tree_required$/);
});

test("desktop bundle completeness is reported from the tree rather than assumed", async () => {
  const fixture = await publishFixture();
  try {
    const outputRoot = fixture.root;
    assert.equal((await reportPackagingCompleteness({ outputRoot, generationRoot: fixture.generationRoot })).desktopBundle, "absent");
    await writeFile(join(outputRoot, "GameBuddy.Desktop.exe"), "exe");
    assert.equal((await reportPackagingCompleteness({ outputRoot, generationRoot: fixture.generationRoot })).desktopBundle, "GameBuddy.Desktop.exe");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------- *
 * Static half
 *
 * Each finding is planted into a real fixture generation and the gate is run
 * over the moved copy, so the mutation is the same shape a leftover absolute
 * path would take in a published generation.
 * ------------------------------------------------------------------------- */

/** Writes one extra file into the fixture's generation, to model a leak. */
async function plantFile(fixture, relativePath, content) {
  const target = join(fixture.generationRoot, ...relativePath.split("/"));
  await mkdir(resolve(target, ".."), { recursive: true });
  await writeFile(target, content);
}

test("a clean generation scans with no hits at all", async () => {
  const fixture = await publishFixture();
  try {
    const scan = await scanGenerationEnvironmentCoupling({ generationRoot: fixture.generationRoot, repositoryRoot });
    assert.equal(scan.files > 0, true);
    assert.deepEqual(scan.hits, []);
    assert.equal(staticGateVerdict(scan).ok, true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a repository-absolute path planted in a copy of the artifact turns the gate red", async () => {
  const fixture = await publishFixture();
  try {
    assert.equal((await verifyGenerationStatic({ outputRoot: fixture.root })).verdict.ok, true);
    await plantFile(fixture, "build-root.js", `export const buildRoot = ${JSON.stringify(join(repositoryRoot, "host", "src", "main.ts"))};\n`);
    const staticResult = await verifyGenerationStatic({ outputRoot: fixture.root });
    assert.equal(staticResult.verdict.ok, false);
    assert.equal(staticResult.scan.hits.length, 1);
    assert.equal(staticResult.scan.hits[0].class, "repository_path");
    assert.equal(staticResult.scan.hits[0].file, "build-root.js");
    assert.equal(staticResult.scan.hits[0].line, 1);
    const full = await verifySelfContainedGeneration({ outputRoot: fixture.root, spawn: stubbedSpawn().spawn });
    assert.equal(full.ok, false);
    assert.equal(full.static.verdict.blocking[0].class, "repository_path");
    assert.equal(full.static.verdict.blocking[0].file, "build-root.js");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a bare node spawn is blocking on the launch surface and informational inside a package", async () => {
  const fixture = await publishFixture();
  try {
    await plantFile(fixture, "start-host.js", 'import { spawn } from "node:child_process";\nspawn("node", ["main.js"]);\n');
    await plantFile(fixture, "node_modules/typebox/cli.js", "#!/usr/bin/env node\n");
    const staticResult = await verifyGenerationStatic({ outputRoot: fixture.root, environment: {}, home: "" });
    assert.equal(staticResult.verdict.ok, false);
    assert.deepEqual(staticResult.scan.counts, {
      repository_path: 0, machine_profile_path: 0, user_home_path: 0, launch_surface_interpreter: 1, vendored_interpreter_reference: 1,
    });
    assert.equal(staticResult.verdict.blocking.length, 1);
    assert.equal(staticResult.verdict.blocking[0].file, "start-host.js");
    assert.equal(staticResult.verdict.reported[0].file, "node_modules/typebox/cli.js");
    const full = await verifySelfContainedGeneration({ outputRoot: fixture.root, spawn: stubbedSpawn().spawn });
    assert.equal(full.ok, false);
    assert.equal(full.static.verdict.blocking[0].class, "launch_surface_interpreter");
    assert.equal(full.static.verdict.blocking[0].file, "start-host.js");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("an absolute build path baked into a bundled dependency is blocking, never a reported reference", async () => {
  const fixture = await publishFixture();
  try {
    // The exact shape a bundler emits when it shims `__filename` for a bundled
    // dependency: the build machine's own absolute path, into this repository,
    // carried inside a package the generation installs. Vendored files that
    // merely mention an interpreter name stay reported; a repository path does
    // not, because the artifact is unusable wherever that path does not exist.
    await plantFile(fixture, "node_modules/typebox/dist/baked.js",
      `var __filename = ${JSON.stringify(join(repositoryRoot, "vendor", "magic-context", "packages", "pi-plugin", "dist", "index.js"))};\n`);
    const staticResult = await verifyGenerationStatic({ outputRoot: fixture.root, environment: {}, home: "" });
    assert.equal(staticResult.verdict.ok, false);
    assert.equal(staticResult.scan.hits.length, 1);
    assert.equal(staticResult.scan.hits[0].class, "repository_path");
    assert.equal(staticResult.scan.hits[0].zone, "vendored");
    assert.deepEqual(staticResult.verdict.reported, []);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a machine-profile path planted in a copy of the artifact turns the gate red", async () => {
  const fixture = await publishFixture();
  const home = "C:\\Users\\tester";
  try {
    await plantFile(fixture, "state.json", JSON.stringify({ state: join(home, "AppData", "Local", "state") }));
    const staticResult = await verifyGenerationStatic({ outputRoot: fixture.root, environment: { USERPROFILE: home }, home });
    assert.equal(staticResult.verdict.ok, false);
    assert.equal(staticResult.scan.hits[0].class, "machine_profile_path");
    assert.equal(staticResult.scan.hits[0].file, "state.json");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("a concrete home path for another account blocks in generation code and is reported from a package", async () => {
  const fixture = await publishFixture();
  try {
    await plantFile(fixture, "notes.js", 'export const cache = "C:/Users/someoneelse/AppData/Local/cache";\n');
    await plantFile(fixture, "runtime/README.md", "docs mention C:/Users/other/AppData\n");
    const staticResult = await verifyGenerationStatic({ outputRoot: fixture.root, environment: {}, home: "" });
    assert.equal(staticResult.verdict.ok, false);
    assert.equal(staticResult.verdict.blocking[0].file, "notes.js");
    assert.deepEqual(staticResult.verdict.reported.map((hit) => hit.file), ["runtime/README.md"]);
    assert.deepEqual(staticResult.scan.counts, {
      repository_path: 0, machine_profile_path: 0, user_home_path: 2, launch_surface_interpreter: 0, vendored_interpreter_reference: 0,
    });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("static-only resolves the pointer and reports a missing one by name", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-self-contained-nopointer-"));
  try {
    await assert.rejects(verifyGenerationStatic({ outputRoot: root }), /self_contained_generation_failed:missing_current_pointer$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the artifact zones, path spellings, and gate severity are exact", () => {
  assert.equal(artifactZone("main.js"), "generation");
  assert.equal(artifactZone("runtime/node.exe"), "runtime");
  assert.equal(artifactZone("node_modules/typebox/package.json"), "vendored");

  const repositoryPaths = repositoryAbsolutePaths("E:\\projects\\ai-game-companion");
  assert.ok(repositoryPaths.includes("E:\\projects\\ai-game-companion"));
  assert.ok(repositoryPaths.includes("E:/projects/ai-game-companion"));
  assert.ok(repositoryPaths.includes("E:\\\\projects\\\\ai-game-companion"));
  assert.ok(repositoryPaths.includes("file:///E:/projects/ai-game-companion"));

  const profilePaths = machineProfileAbsolutePaths({ USERPROFILE: "C:\\Users\\tester" }, "C:\\Users\\tester");
  assert.ok(profilePaths.includes("C:\\Users\\tester"));
  assert.ok(profilePaths.includes("C:/Users/tester"));
  assert.ok(profilePaths.includes("C:\\\\Users\\\\tester"));

  const blocking = { class: "repository_path", classes: ["repository_path"], zone: "generation", file: "a.js", line: 1, snippet: "x" };
  const informational = { class: "vendored_interpreter_reference", classes: ["vendored_interpreter_reference"], zone: "vendored", file: "b.js", line: 1, snippet: "x" };
  const verdict = staticGateVerdict({ hits: [blocking, informational] });
  assert.equal(verdict.ok, false);
  assert.deepEqual(verdict.blocking, [blocking]);
  assert.deepEqual(verdict.reported, [informational]);
});

test("an inherited variable that still names the repository is dropped from the child environment", () => {
  const environment = isolatedEnvironment({ SystemRoot: "C:\\Windows", TEMP: resolve(repositoryRoot, "tmp") }, repositoryRoot);
  assert.equal(environment.TEMP, undefined);
  assert.equal(environment.PATH, "C:\\Windows\\System32");
});
