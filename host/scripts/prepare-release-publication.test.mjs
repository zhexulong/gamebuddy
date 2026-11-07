import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MANIFEST_SCHEMA } from "./check-release-manifest.mjs";
import { preparePublication } from "./prepare-release-publication.mjs";

/**
 * The publication step is where a mistake becomes public, so each refusal below names a fact that would otherwise let a
 * release ship under the wrong name, or ship a build nobody signed.
 */

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const THUMBPRINT = "A".repeat(40);

async function assembledRelease({ version = "0.1.0", overrides = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-publication-"));
  const output = join(root, "release");
  await mkdir(output, { recursive: true });
  const pointer = {
    generation: "g-mvv0x7l0-5804-8da51661227b48afb71fce58dd723b4a",
    inventoryDigest: "b".repeat(64),
    runtimeAdmissionSha256: "c".repeat(64),
  };
  await writeFile(join(root, "current.json"), JSON.stringify(pointer), "utf8");
  const payload = Buffer.from("payload-archive");
  const installer = Buffer.from("installer-with-embedded-payload-and-a-signature");
  await writeFile(join(output, "payload.zip"), payload);
  await writeFile(join(output, "GameBuddy.Setup.exe"), installer);
  const manifest = {
    schema: MANIFEST_SCHEMA,
    version,
    repository: "zhexulong/gamebuddy",
    downloadUrl: `https://github.com/zhexulong/gamebuddy/releases/download/v${version}/GameBuddy.Setup.exe`,
    generation: pointer.generation,
    inventoryDigest: pointer.inventoryDigest,
    runtimeAdmissionSha256: pointer.runtimeAdmissionSha256,
    payload: { sha256: sha256(payload), bytes: payload.length },
    configuration: "Release",
    installer: { file: "GameBuddy.Setup.exe", bytes: installer.length, sha256: sha256(installer) },
    signature: { required: true, scheme: "authenticode+timestamp/v1", thumbprint: THUMBPRINT },
    ...overrides,
  };
  const manifestPath = join(output, "release-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { root, output, manifestPath };
}

const signed = async () => ({ ok: true });

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, new RegExp(`release_publication_refused:${code}`, "u"));
    return true;
  });
}

test("a signed release published under its own tag prepares the asset list and the notes", async () => {
  const fixture = await assembledRelease();
  const publication = await preparePublication({
    manifestPath: fixture.manifestPath,
    tag: "v0.1.0",
    generationOutputRoot: fixture.root,
    verifySignature: signed,
    platform: "win32",
  });
  assert.equal(publication.version, "0.1.0");
  assert.equal(publication.assets.length, 3);
  assert.ok(publication.assets.some((asset) => asset.endsWith("GameBuddy.Setup.exe")));
  assert.ok(publication.assets.some((asset) => asset.endsWith("release-manifest.json")));
  assert.ok(publication.assets.some((asset) => asset.endsWith("payload.zip")));
  // The notes carry the digest a player can check by hand, not just the version.
  assert.match(publication.body, /certutil -hashfile GameBuddy\.Setup\.exe SHA256/u);
  assert.match(publication.body, new RegExp(publication.installerSha256, "u"));
});

test("a tag that disagrees with the manifest version is refused, so a release cannot be mislabelled", async () => {
  const fixture = await assembledRelease({ version: "0.1.0" });
  await expectFailure(
    preparePublication({
      manifestPath: fixture.manifestPath,
      tag: "v0.2.0",
      generationOutputRoot: fixture.root,
      verifySignature: signed,
      platform: "win32",
    }),
    "tag_version_mismatch:0.2.0!=0.1.0",
  );
});

test("a tag that is not a version is refused rather than published under a branch name", async () => {
  const fixture = await assembledRelease();
  await expectFailure(
    preparePublication({
      manifestPath: fixture.manifestPath,
      tag: "main",
      generationOutputRoot: fixture.root,
      verifySignature: signed,
    }),
    "tag_invalid:main",
  );
});

test("an unsigned release is never published, even with a valid manifest", async () => {
  const fixture = await assembledRelease({
    overrides: { configuration: "Debug", signature: { required: false, scheme: "none", thumbprint: null } },
  });
  await expectFailure(
    preparePublication({
      manifestPath: fixture.manifestPath,
      tag: "v0.1.0",
      generationOutputRoot: fixture.root,
      verifySignature: signed,
    }),
    "publication_requires_signature",
  );
});
