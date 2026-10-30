import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { archiveInvocation, packageGenerationForDistribution, readLauncherBundle } from "./package-player-distribution.mjs";

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const GENERATION = "g-package-test";

/**
 * The publisher's output root shape, with everything the packaging assertion
 * names: a pointer, the generation's runtime/Host/Mod payload, and the declared
 * package. Deliberately synthetic - the archive step is stubbed, so this file
 * never needs a Node distribution or a real Mod build.
 */
async function publishFixture({ generationLeak = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-package-fixture-"));
  const generationRoot = join(root, "generations", GENERATION);
  const files = new Map([
    [join(generationRoot, "package.json"), JSON.stringify({ name: "gamebuddy-host-generation", private: true, type: "module", dependencies: {} })],
    [join(generationRoot, "main.js"), "export {};\n"],
    [join(generationRoot, "host-runtime-admission.json"), "{}\n"],
    [join(generationRoot, "runtime", "node.exe"), "runtime-bytes"],
    [join(generationRoot, "runtime", "README.md"), "pinned node runtime\n"],
    [join(generationRoot, "bootstrap", "entry", "desktop-host-entry.internal.js"), "export {};\n"],
    [join(generationRoot, "native", "stardew-mod", "GameBuddy", "GameBuddy.Stardew.dll"), "mod"],
    // The mod-loader payload a player's game folder is brought to by one click, and the licence
    // its LGPL terms require beside it. The publisher refuses a generation without them, so the
    // fixture has to carry what a real one carries.
    [join(generationRoot, "native", "smapi", "win-x64", "StardewModdingAPI.exe"), "loader"],
    [join(generationRoot, "native", "smapi", "payload-manifest.json"), "{}\n"],
    [join(generationRoot, "native", "smapi", "SMAPI-LICENSE.txt"), "GNU LESSER GENERAL PUBLIC LICENSE\n"],
    [join(generationRoot, "node_modules", "typebox", "package.json"), JSON.stringify({ name: "typebox" })],
  ]);
  if (generationLeak) files.set(join(generationRoot, "leak.js"), `const at = ${JSON.stringify(repositoryRoot)};\n`);
  for (const [path, content] of files) {
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(join(root, "current.json"), JSON.stringify({ schema: "gamebuddy-host-production-current/v2", generation: GENERATION, inventoryDigest: "a".repeat(64), runtimeAdmissionSha256: "b".repeat(64) }));
  return root;
}

/** The launcher bundle is a plain build output directory; only its entry matters here. */
async function launcherFixture({ withEntry = true } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-package-launcher-"));
  if (withEntry) await writeFile(join(root, "GameBuddy.Desktop.exe"), "apphost");
  await writeFile(join(root, "GameBuddy.Desktop.runtimeconfig.json"), "{}\n");
  await writeFile(join(root, "GameBuddy.Desktop.pdb"), "symbols");
  return root;
}

function recordingSpawn() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: "", stderr: "", error: undefined, signal: null };
  };
  return { spawn, calls };
}

test("a published generation plus the launcher bundle seals the payload GameBuddy.Setup embeds", async () => {
  const outputRoot = await publishFixture();
  const launcherBundleRoot = await launcherFixture();
  const scratchRoot = await mkdtemp(join(tmpdir(), "gamebuddy-package-scratch-"));
  const artifactPath = join(scratchRoot, "GameBuddy-payload.zip");
  const { spawn, calls } = recordingSpawn();
  try {
    const result = await packageGenerationForDistribution({ generationOutputRoot: outputRoot, artifactPath, launcherBundleRoot, scratchRoot, spawn });
    assert.equal(result.schema, "gamebuddy-player-distribution-package/v1");
    assert.equal(result.ok, true);
    assert.equal(result.generation, GENERATION);
    // The launcher entry is the piece the generation itself does not carry.
    assert.equal(result.launcherEntry, "GameBuddy.Desktop.exe");
    assert.deepEqual(result.packaging, {
      offlineRuntime: `generations/${GENERATION}/runtime/node.exe`,
      hostBuild: `generations/${GENERATION}/main.js`,
      modBuild: `generations/${GENERATION}/native/stardew-mod/GameBuddy/GameBuddy.Stardew.dll`,
      desktopBundle: "GameBuddy.Desktop.exe",
      // The one-click mod-loader install reads these three by name, so the package that ships
      // them is what makes the button work at all.
      smapiLoader: `generations/${GENERATION}/native/smapi/win-x64/StardewModdingAPI.exe`,
      smapiManifest: `generations/${GENERATION}/native/smapi/payload-manifest.json`,
      smapiLicense: `generations/${GENERATION}/native/smapi/SMAPI-LICENSE.txt`,
    });
    assert.equal(result.static.generation.verdict.ok, true);
    assert.equal(result.static.launcher.verdict.ok, true);
    // The archive is this step's own, from the payload root. It is also the artifact the
    // installer embeds, so nothing re-archives this tree afterwards.
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args.slice(0, 3), ["-a", "-c", "-f"]);
    assert.deepEqual(calls[0].args.slice(3), [artifactPath, "-C", join(scratchRoot, "payload"), "."]);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(launcherBundleRoot, { recursive: true, force: true });
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test("a launcher bundle without its entry is refused by name", async () => {
  const launcherBundleRoot = await launcherFixture({ withEntry: false });
  try {
    await assert.rejects(
      () => readLauncherBundle(launcherBundleRoot),
      /player_distribution_package_failed:missing_launcher_entry:GameBuddy\.Desktop\.exe/,
    );
  } finally {
    await rm(launcherBundleRoot, { recursive: true, force: true });
  }
});

test("a generation that names the build machine never reaches an archive", async () => {
  const outputRoot = await publishFixture({ generationLeak: true });
  const launcherBundleRoot = await launcherFixture();
  const scratchRoot = await mkdtemp(join(tmpdir(), "gamebuddy-package-scratch-"));
  const { spawn, calls } = recordingSpawn();
  try {
    await assert.rejects(
      () => packageGenerationForDistribution({ generationOutputRoot: outputRoot, artifactPath: join(scratchRoot, "x.zip"), launcherBundleRoot, scratchRoot, spawn }),
      /player_distribution_package_failed:package_leak:repository_path/,
    );
    assert.equal(calls.length, 0, "a refused package must not have been archived");
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
    await rm(launcherBundleRoot, { recursive: true, force: true });
    await rm(scratchRoot, { recursive: true, force: true });
  }
});

test("the archive step refuses a non-zip destination", () => {
  const invocation = archiveInvocation({ archivePath: "C:\\out\\payload.zip", payloadRoot: "C:\\payload" });
  assert.deepEqual(invocation.args, ["-a", "-c", "-f", "C:\\out\\payload.zip", "-C", "C:\\payload", "."]);
  assert.throws(() => archiveInvocation({ archivePath: "C:\\out\\payload.tar", payloadRoot: "C:\\payload" }), /archive_must_be_zip/);
});

test("the packaging default reads the directory the launcher build actually publishes to", async () => {
  // The defect this pins, found by trying to build a real installer: adding
  // `RuntimeIdentifier` for a self-contained Release moved `dotnet build` output under
  // `bin/Release/net8.0-windows/win-x64/`, while the packaging script still read
  // `bin/Release/net8.0-windows/` - a directory that still existed and still held an
  // apphost, so the publisher silently had no launcher of the shape it ships (243 files
  // instead of one), and `build:player-distribution` could only fail `launcher_bundle_missing`.
  //
  // The two facts are now one: the build script publishes to a fixed directory and the
  // packager reads that same directory. Asserted against the build script itself, because a
  // hard-coded path in either place is exactly how they drifted apart.
  const { readFile } = await import("node:fs/promises");
  const root = repositoryRoot;
  const scripts = JSON.parse(await readFile(join(root, "package.json"), "utf8")).scripts;
  const publishScript = scripts["build:desktop-launcher"];
  assert.equal(typeof publishScript, "string");
  assert.match(publishScript, /dotnet publish /u);
  assert.match(publishScript, /-c Release/u);
  const published = /-o\s+(\S+)/u.exec(publishScript);
  assert.notEqual(published, null, "the launcher build must publish to an explicit directory");
  // The packager's default bundle is the same directory, resolved from the same root.
  const module = await import("./package-player-distribution.mjs");
  assert.equal(
    module.launcherBundleDefaultForTesting,
    resolve(root, published[1].replaceAll("/", sep)),
    "the packager's default launcher directory drifted from the build script's publish directory",
  );
});
