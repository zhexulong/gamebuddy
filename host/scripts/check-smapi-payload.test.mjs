/**
 * The SMAPI payload every generation ships, checked against the real bytes.
 *
 * This is the static half of the one-click install: the button is only honest if the
 * payload a player's machine will be given is actually in the repository, is the release
 * the manifest claims, and is accompanied by the licence its LGPL terms require. The
 * runtime half (deploying it into a game folder) is
 * `host/src/stardew-game-install/smapi-deployment.test.ts`.
 *
 * Nothing here restates the payload: the file set, digests and version all come from
 * `assets/smapi/payload-manifest.json`, so refreshing the payload by its own script is
 * the only way the population changes, and this gate follows it automatically.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readArtifactConfig } from "./production-artifact.mjs";
import { ensureSmapiPayload } from "./production-artifact.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(hostRoot, "..");
const payloadRoot = resolve(repositoryRoot, "assets", "smapi");
const manifestPath = resolve(payloadRoot, "payload-manifest.json");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function readManifest() {
  return JSON.parse(await readFile(manifestPath, "utf8"));
}

test("the vendored SMAPI payload matches its manifest byte for byte", async () => {
  const manifest = await readManifest();
  assert.equal(manifest.schema, "gamebuddy-smapi-payload-manifest/v1");
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.sourceUrl, /^https:\/\/github\.com\/Pathoschild\/SMAPI\/releases\/download\//);
  assert.match(manifest.sourceArchiveSha256, /^[a-f0-9]{64}$/);
  assert.ok(manifest.files.length > 0);

  const filesRoot = resolve(payloadRoot, manifest.root);
  const actual = await listRelativeFiles(filesRoot);
  assert.deepEqual(actual.sort(), manifest.files.map((file) => file.path).sort());
  for (const file of manifest.files) {
    const bytes = await readFile(resolve(filesRoot, ...file.path.split("/")));
    assert.equal(bytes.length, file.size, `size mismatch: ${file.path}`);
    assert.equal(digest(bytes), file.sha256, `digest mismatch: ${file.path}`);
  }
  // The mod loader is the file the whole one-click install exists to place.
  assert.ok(manifest.files.some((file) => file.path === "StardewModdingAPI.exe"));
  // SMAPI's own base mods travel with it; a payload that dropped them would load a
  // loader with none of the mods its installer always provides.
  assert.ok(manifest.files.some((file) => file.path === "Mods/SaveBackup/manifest.json"));
  assert.ok(manifest.files.some((file) => file.path.startsWith("smapi-internal/")));
});

test("the payload carries the LGPL text its licence requires", async () => {
  const manifest = await readManifest();
  const licenseBytes = await readFile(resolve(payloadRoot, manifest.license.file));
  assert.equal(digest(licenseBytes), manifest.license.sha256);
  const text = licenseBytes.toString("utf8");
  assert.match(text, /GNU LESSER GENERAL PUBLIC LICENSE/);
  assert.match(text, /Version 3, 29 June 2007/);
  // The provenance the licence and the LGPL's own source-availability term require.
  assert.match(text, /github\.com\/Pathoschild\/SMAPI/);
});

test("the production artifact config mounts exactly the payload the repository carries", async () => {
  const config = await readArtifactConfig(hostRoot);
  assert.deepEqual(config.smapiPayload, {
    kind: "verified_smapi_payload",
    destination: "native/smapi",
    manifest: "payload-manifest.json",
    license: "SMAPI-LICENSE.txt",
  });
});

test("the packager stages the payload into a generation and re-verifies the staged copy", async () => {
  const config = await readArtifactConfig(hostRoot);
  const manifest = await readManifest();
  const stagingRoot = await mkdtemp(join(tmpdir(), "gamebuddy-smapi-staging-"));
  try {
    const origins = await ensureSmapiPayload({ stagingRoot, descriptor: config.smapiPayload });
    // Every payload file plus the manifest and the licence is staged inside the generation
    // at the declared destination, and each carries its origin fact.
    const expected = manifest.files.length + 2;
    assert.equal(origins.size, expected);
    for (const file of manifest.files) {
      const staged = resolve(stagingRoot, "native", "smapi", manifest.root, ...file.path.split("/"));
      assert.equal(digest(await readFile(staged)), file.sha256, file.path);
      assert.ok(origins.has(`native/smapi/${manifest.root}/${file.path}`), file.path);
    }
    assert.ok(origins.has(`native/smapi/${config.smapiPayload.manifest}`));
    assert.ok(origins.has(`native/smapi/${config.smapiPayload.license}`));
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
});

test("a payload file whose bytes no longer match the manifest fails the publish", async () => {
  // The failure this pins: a payload edited in place (or a partial extraction) must not be
  // staged into a generation. The check runs against a copy of the real payload tree so the
  // repository's own bytes are never touched.
  const fixtureRoot = await mkdtemp(join(tmpdir(), "gamebuddy-smapi-tamper-"));
  try {
    const repositoryCopy = resolve(fixtureRoot, "assets", "smapi");
    await mkdir(repositoryCopy, { recursive: true });
    for (const name of await readdir(payloadRoot)) {
      const source = resolve(payloadRoot, name);
      const target = resolve(repositoryCopy, name);
      if ((await lstat(source)).isDirectory()) {
        for (const inner of await listRelativeFiles(source)) {
          await mkdir(resolve(target, dirname(inner)), { recursive: true });
          await copyFile(resolve(source, inner), resolve(target, inner));
        }
      } else {
        await copyFile(source, target);
      }
    }
    const manifest = JSON.parse(await readFile(resolve(repositoryCopy, "payload-manifest.json"), "utf8"));
    const loader = resolve(repositoryCopy, manifest.root, ...manifest.files.find((file) => file.path === "StardewModdingAPI.exe").path.split("/"));
    await writeFile(loader, "tampered");
    await assert.rejects(
      ensureSmapiPayload({
        stagingRoot: resolve(fixtureRoot, "staging"),
        descriptor: { kind: "verified_smapi_payload", destination: "native/smapi", manifest: "payload-manifest.json", license: "SMAPI-LICENSE.txt" },
        repositoryRoot: fixtureRoot,
      }),
      /smapi_payload_digest_mismatch/,
    );
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function listRelativeFiles(directory, prefix = "") {
  const entries = await readdir(join(directory, ...prefix.split("/").filter(Boolean)), { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) files.push(...(await listRelativeFiles(directory, path)));
    else files.push(path);
  }
  return files;
}
