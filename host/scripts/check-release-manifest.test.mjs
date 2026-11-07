import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkReleaseManifest, MANIFEST_SCHEMA } from "./check-release-manifest.mjs";

/**
 * The manifest is the only artifact a download entry or an updater can bind to, so every field it carries has to be
 * held against the bytes. Each case below is one binding, and each is broken deliberately.
 */

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const THUMBPRINT = "A".repeat(40);

/** A release directory: a generation pointer, an installer, and a manifest describing both. */
async function releaseFixture({
  installerBytes = Buffer.from("installer-with-embedded-payload"),
  payloadBytes = Buffer.from("payload"),
  mutation = (manifest) => manifest,
  signatureRequired = true,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-release-manifest-"));
  const output = join(root, "release");
  await mkdir(output, { recursive: true });
  const pointer = {
    generation: "g-mvv0x7l0-5804-8da51661227b48afb71fce58dd723b4a",
    inventoryDigest: "b".repeat(64),
    runtimeAdmissionSha256: "c".repeat(64),
  };
  await writeFile(join(root, "current.json"), JSON.stringify(pointer), "utf8");
  await writeFile(join(output, "GameBuddy.Setup.exe"), installerBytes);
  await writeFile(join(output, "payload.zip"), payloadBytes);
  const manifest = mutation({
    schema: MANIFEST_SCHEMA,
    version: "0.1.0",
    repository: "zhexulong/gamebuddy",
    downloadUrl: "https://github.com/zhexulong/gamebuddy/releases/download/v0.1.0/GameBuddy.Setup.exe",
    generation: pointer.generation,
    inventoryDigest: pointer.inventoryDigest,
    runtimeAdmissionSha256: pointer.runtimeAdmissionSha256,
    payload: { sha256: sha256(payloadBytes), bytes: payloadBytes.length },
    installer: { file: "GameBuddy.Setup.exe", bytes: installerBytes.length, sha256: sha256(installerBytes) },
    configuration: signatureRequired ? "Release" : "Debug",
    signature: { required: signatureRequired, scheme: "authenticode+timestamp/v1", thumbprint: THUMBPRINT },
  });
  const manifestPath = join(output, "release-manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { root, output, manifestPath, manifest };
}

const verifyOk = async () => ({ ok: true });

async function expectFailure(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.match(error.message, new RegExp(`release_manifest_invalid:${code}`, "u"));
    return true;
  });
}

test("a consistent release passes, and reports what it verified", async () => {
  const fixture = await releaseFixture();
  const result = await checkReleaseManifest({
    manifestPath: fixture.manifestPath,
    generationOutputRoot: fixture.root,
    verifySignature: verifyOk,
    platform: "win32",
  });
  assert.equal(result.version, "0.1.0");
  assert.equal(result.generation, fixture.manifest.generation);
  assert.equal(result.signed, true);
});

test("an installer whose bytes changed after the manifest was written is refused", async () => {
  const fixture = await releaseFixture();
  await writeFile(join(fixture.output, "GameBuddy.Setup.exe"), Buffer.from("installer-with-DIFFERENT-payload"));
  await expectFailure(
    checkReleaseManifest({ manifestPath: fixture.manifestPath, verifySignature: verifyOk }),
    "installer_size_mismatch",
  );
});

test("an installer of the same size but different bytes is refused, so size alone is never the check", async () => {
  const fixture = await releaseFixture();
  const bytes = Buffer.from("installer-with-embedded-payload");
  bytes[0] = "I".charCodeAt(0);
  await writeFile(join(fixture.output, "GameBuddy.Setup.exe"), bytes);
  await expectFailure(
    checkReleaseManifest({ manifestPath: fixture.manifestPath, verifySignature: verifyOk }),
    "installer_digest_mismatch",
  );
});

test("a manifest that names a generation the published pointer does not is refused", async () => {
  const fixture = await releaseFixture({
    mutation: (manifest) => ({
      ...manifest,
      generation: "g-other-1-0123456789abcdef0123456789abcdef",
    }),
  });
  await expectFailure(
    checkReleaseManifest({
      manifestPath: fixture.manifestPath,
      generationOutputRoot: fixture.root,
      verifySignature: verifyOk,
    }),
    "generation_binding_mismatch:generation",
  );
});

test("an installer smaller than the payload it claims to embed is refused", async () => {
  const fixture = await releaseFixture({
    installerBytes: Buffer.from("tiny"),
    payloadBytes: Buffer.from("a payload much larger than the installer"),
  });
  await expectFailure(
    checkReleaseManifest({ manifestPath: fixture.manifestPath, verifySignature: verifyOk }),
    "installer_smaller_than_payload",
  );
});

test("a protected release with no signing identity is refused", async () => {
  const fixture = await releaseFixture({
    mutation: (manifest) => ({ ...manifest, signature: { ...manifest.signature, thumbprint: null } }),
  });
  await expectFailure(
    checkReleaseManifest({ manifestPath: fixture.manifestPath, verifySignature: verifyOk }),
    "signing_identity_absent",
  );
});

test("a protected release whose signature does not verify is refused", async () => {
  const fixture = await releaseFixture();
  await expectFailure(
    checkReleaseManifest({
      manifestPath: fixture.manifestPath,
      platform: "win32",
      verifySignature: async () => ({ ok: false, reason: "signtool_exit_1" }),
    }),
    "signature_not_verified:signtool_exit_1",
  );
});

test("an unsigned build that is not for publication does not require a signature", async () => {
  // The clean-machine check installs a locally built artifact; that build makes no publication claim, so the
  // signer check is skipped exactly when the manifest says it is not required.
  const fixture = await releaseFixture({
    signatureRequired: false,
    mutation: (manifest) => ({ ...manifest, signature: { ...manifest.signature, thumbprint: null } }),
  });
  const result = await checkReleaseManifest({
    manifestPath: fixture.manifestPath,
    platform: "win32",
    verifySignature: async () => ({ ok: false, reason: "must_not_be_called" }),
  });
  assert.equal(result.signed, false);
});

test("a manifest from another schema is refused rather than half-read", async () => {
  const fixture = await releaseFixture({
    mutation: (manifest) => ({ ...manifest, schema: "gamebuddy-player-release-manifest/v0" }),
  });
  await expectFailure(
    checkReleaseManifest({ manifestPath: fixture.manifestPath, verifySignature: verifyOk }),
    "schema_unsupported",
  );
});

test("a Debug installer presented as a signed release is refused", async () => {
  // The configuration is the evidence of the claim: Release cannot exist unsigned, Debug is not for publication.
  const fixture = await releaseFixture({
    mutation: (manifest) => ({ ...manifest, configuration: "Debug" }),
  });
  await expectFailure(
    checkReleaseManifest({ manifestPath: fixture.manifestPath, platform: "win32", verifySignature: verifyOk }),
    "configuration_claim_mismatch:Debug!=Release",
  );
});
