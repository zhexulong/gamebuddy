import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { browserBuildInvocation, buildProductionArtifact } from "./build-production-artifact.mjs";
import { assertCompleteProductionArtifact, resolveProductionEntry, verifyWindowsReparseInspectorPair } from "./production-artifact.mjs";

const hostRoot = fileURLToPath(new URL("..", import.meta.url));

async function files(root, prefix = "") {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) result.push(...await files(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error(`unexpected_composition_entry:${path}`);
  }
  return result.sort();
}

async function outputFixture() {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-build-composition-"));
  return { root, dispose: async () => await rm(root, { recursive: true, force: true }) };
}

test("Windows browser build command uses only the fixed system cmd.exe and repository vite.CMD", { skip: process.platform !== "win32" }, async () => {
  const stagingRoot = join(hostRoot, "..", "dialogue-web", ".build-staging", "a".repeat(32));
  const invocation = await browserBuildInvocation({ stagingRoot });
  assert.equal(invocation.command, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.match(invocation.args[3], /^call ".*dialogue-web\\node_modules\\\.bin\\vite\.CMD" "build" "--config" "vite\.config\.ts" "--outDir" ".*"$/i);
  assert.doesNotMatch(invocation.args[3], /pnpm|APPDATA|ComSpec/i);
  await assert.rejects(browserBuildInvocation({ stagingRoot: "E:\\build\\bad&leaf" }), /invalid_browser_staging_root/);
});

test("builder composes one verified private browser subtree into the published Host generation", { skip: process.platform === "win32" }, async () => {
  const fixture = await outputFixture();
  let observed;
  let requestedBrowserStagingRoot;
  try {
    const published = await buildProductionArtifact({
      outputRoot: fixture.root,
      onBrowserBuildInvocation: ({ stagingRoot, invocation }) => {
        requestedBrowserStagingRoot = stagingRoot;
        assert.match(relative(join(hostRoot, "..", "dialogue-web", ".build-staging"), stagingRoot), /^[a-f0-9]{32}$/);
        assert.equal(invocation.cwd, join(hostRoot, "..", "dialogue-web"));
      },
      onCompositionVerified: async (value) => {
        const manifest = JSON.parse(await readFile(join(value.browserRoot, "tavern-browser-artifact-manifest.json"), "utf8"));
        observed = { files: await files(value.browserRoot), manifest };
      },
    });
    const copiedManifest = observed.manifest;
    assert.deepEqual(copiedManifest, {
      schemaVersion: 1,
      browserContract: "tavern_browser_api/v1",
      profileId: "gamebuddy.tavern.browser.v1",
      entryHtml: "index.html",
      assets: copiedManifest.assets,
    });
    assert.deepEqual(observed.files, ["index.html", "tavern-browser-artifact-manifest.json", ...copiedManifest.assets.map((asset) => asset.path)].sort());
    assert.equal(observed.files.some((path) => /WindowsReparseInspector|windows-reparse-inspector/i.test(path)), false, "browser tree must not serve native helper provenance");
    assert.ok(copiedManifest.assets.length > 0);
    const complete = await assertCompleteProductionArtifact({ hostRoot, outputRoot: fixture.root });
    const browserEntries = complete.entries.filter((entry) => entry.path.startsWith("browser/"));
    assert.deepEqual(browserEntries.map((entry) => entry.path), observed.files.map((path) => `browser/tavern/v1/${path}`));
    assert.equal(published.generation, complete.generation);
    for (const path of ["tavern/player-turn-acceptance.js", "tavern/player-turn-acceptance.internal.js"])
      assert.ok(complete.entries.some((entry) => entry.path === path), `${path} must be retained as a verified mounted-turn composition module`);
    await assert.rejects(
      resolveProductionEntry({ hostRoot, outputRoot: fixture.root, entry: "tavern/player-turn-acceptance.js" }),
      /production_entry_not_configured/,
    );
    assert.ok(requestedBrowserStagingRoot);
  } finally {
    await fixture.dispose();
  }
});

async function assertRejectedBrowserComposition(mutate, expectedError) {
  const fixture = await outputFixture();
  try {
    await buildProductionArtifact({ outputRoot: fixture.root });
    const before = await assertCompleteProductionArtifact({ hostRoot, outputRoot: fixture.root });
    await assert.rejects(buildProductionArtifact({ outputRoot: fixture.root, afterBrowserBuild: mutate }), expectedError);
    const after = await assertCompleteProductionArtifact({ hostRoot, outputRoot: fixture.root });
    assert.equal(after.generation, before.generation);
  } finally {
    await fixture.dispose();
  }
}

test("browser composition rejects wrong manifest identity", { skip: process.platform === "win32" }, async () => {
  await assertRejectedBrowserComposition(async (browserStagingRoot) => {
    const path = join(browserStagingRoot, "tavern-browser-artifact-manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.profileId = "attacker.browser.v1";
    await writeFile(path, JSON.stringify(manifest), "utf8");
  }, /invalid identity|invalid_declared_browser_artifact/);
});

test("browser composition rejects stale manifest hashes", { skip: process.platform === "win32" }, async () => {
  await assertRejectedBrowserComposition(async (browserStagingRoot) => {
    const manifest = JSON.parse(await readFile(join(browserStagingRoot, "tavern-browser-artifact-manifest.json"), "utf8"));
    await writeFile(join(browserStagingRoot, manifest.assets[0].path), "stale", "utf8");
  }, /does not match its manifest/);
});

test("browser composition rejects extra browser files", { skip: process.platform === "win32" }, async () => {
  await assertRejectedBrowserComposition(async (browserStagingRoot) =>
    await writeFile(join(browserStagingRoot, "assets", "extra-abcdef12.js.map"), "{}", "utf8"),
  /source maps|unexpected file|invalid_tavern_static_artifact/);
});

test("browser composition rejects reparse/link staging entries", { skip: process.platform === "win32" }, async (t) => {
  const probe = await mkdtemp(join(tmpdir(), "gamebuddy-link-probe-"));
  try {
    const target = join(probe, "target");
    await writeFile(target, "probe", "utf8");
    try {
      await symlink(target, join(probe, "link"), "file");
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(error?.code)) {
        t.skip(`Windows link fixture unavailable: ${error.code}`);
        return;
      }
      throw error;
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
  await assertRejectedBrowserComposition(async (browserStagingRoot) => {
    const manifest = JSON.parse(await readFile(join(browserStagingRoot, "tavern-browser-artifact-manifest.json"), "utf8"));
    const asset = join(browserStagingRoot, manifest.assets[0].path);
    await unlink(asset);
    await symlink(join(browserStagingRoot, manifest.assets[1].path), asset, "file");
  }, /symlink|reparse|non-regular/);
});

test("Windows helper pair verifier fails closed for missing or invalid helper/manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-missing-reparse-pair-"));
  const descriptor = {
    kind: "verified_windows_reparse_inspector",
    destination: "win-x64",
    helper: "GameBuddy.WindowsReparseInspector.exe",
    manifest: "windows-reparse-inspector.manifest.json",
    probeEvidence: "windows-reparse-inspector.probe-evidence.json",
  };
  try {
    await assert.rejects(verifyWindowsReparseInspectorPair({ root, descriptor }), /windows_reparse_inspector_pair_invalid/);
    const pairRoot = join(root, descriptor.destination);
    await mkdir(pairRoot);
    await writeFile(join(pairRoot, descriptor.helper), "not the fixed helper", "utf8");
    await writeFile(join(pairRoot, descriptor.manifest), "not a canonical manifest\n", "utf8");
    await assert.rejects(verifyWindowsReparseInspectorPair({ root, descriptor }), /windows_reparse_inspector_pair_invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows composition accepts missing or audited probe JSON but publishes only the verified helper pair", { skip: process.platform !== "win32" }, async () => {
  const fixture = await outputFixture();
  const inspectorRoot = join(hostRoot, "native", "windows-reparse-inspector", ".dist", "win-x64");
  const probeEvidence = join(inspectorRoot, "windows-reparse-inspector.probe-evidence.json");
  try {
    let observedMissingProbeEvidence = false;
    await buildProductionArtifact({
      outputRoot: fixture.root,
      onBrowserBuildInvocation: async () => {
        await assert.rejects(lstat(probeEvidence), { code: "ENOENT" });
        observedMissingProbeEvidence = true;
        await writeFile(probeEvidence, "{\"handwritten\":\"audit-only\"}\n", "utf8");
      },
      onCompositionVerified: async ({ browserRoot }) => {
        assert.equal(observedMissingProbeEvidence, true);
        await assert.rejects(
          lstat(join(browserRoot, "..", "..", "..", "native", "windows-reparse-inspector", "win-x64", "windows-reparse-inspector.probe-evidence.json")),
          { code: "ENOENT" },
        );
      },
    });
    const complete = await assertCompleteProductionArtifact({ hostRoot, outputRoot: fixture.root });
    const paths = complete.entries.map((entry) => entry.path);
    assert.ok(paths.includes("native/windows-reparse-inspector/win-x64/GameBuddy.WindowsReparseInspector.exe"));
    assert.ok(paths.includes("native/windows-reparse-inspector/win-x64/windows-reparse-inspector.manifest.json"));
    assert.equal(paths.includes("native/windows-reparse-inspector/win-x64/windows-reparse-inspector.probe-evidence.json"), false);
  } finally {
    await rm(probeEvidence, { force: true });
    await fixture.dispose();
  }
});

test("browser composition failure leaves the existing published generation untouched", { skip: process.platform === "win32" }, async () => {
  const fixture = await outputFixture();
  try {
    await buildProductionArtifact({ outputRoot: fixture.root });
    const before = await assertCompleteProductionArtifact({ hostRoot, outputRoot: fixture.root });
    await assert.rejects(
      buildProductionArtifact({
        outputRoot: fixture.root,
        afterBrowserBuild: async (browserStagingRoot) =>
          await writeFile(join(browserStagingRoot, "assets", "extra-abcdef12.js.map"), "{}", "utf8"),
      }),
      /source maps|unexpected file|invalid_tavern_static_artifact/,
    );
    const after = await assertCompleteProductionArtifact({ hostRoot, outputRoot: fixture.root });
    assert.equal(after.generation, before.generation);
    assert.equal(relative(after.artifactRoot, before.artifactRoot), "");
  } finally {
    await fixture.dispose();
  }
});
