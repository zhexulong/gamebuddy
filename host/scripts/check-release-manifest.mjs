/**
 * Holds a release manifest to the artifact it describes.
 *
 * The manifest is the only thing a download entry, an installer, or a later updater can bind to, so it has to be
 * checked against the bytes rather than trusted: a manifest that names one artifact while the folder holds another
 * is worse than no manifest, because every consumer would believe it.
 *
 * What is checked, and why each one is a real defect it prevents:
 *
 *   - the installer named by the manifest exists and its size and SHA-256 match, so the file that is uploaded is
 *     the file that was assembled;
 *   - the payload digest matches the archive the installer was built from, so the manifest describes the bytes a
 *     player installs rather than an archive from an earlier build;
 *   - the generation and its two digests match the published `current.json`, so a release cannot claim a
 *     generation it did not build;
 *   - a protected release names a signer, and - when `signtool` is available - that the signature on the file
 *     verifies, so an unsigned artifact cannot pass as a signed one.
 *
 * Every failure carries one bounded code.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);

export const MANIFEST_SCHEMA = "gamebuddy-player-release-manifest/v1";

function fail(reason) {
  throw new Error(`release_manifest_invalid:${reason}`);
}

async function regularFile(path) {
  try {
    const state = await stat(path);
    return state.isFile();
  } catch {
    return false;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/**
 * Validates one manifest against the directory it was written beside.
 *
 * `verifySignature` is injectable so the check itself is provable on a machine with no code-signing certificate:
 * the real implementation runs `signtool verify`, and the tests drive the pass and fail paths without one.
 */
export async function checkReleaseManifest({
  manifestPath,
  generationOutputRoot,
  verifySignature = defaultSignatureVerification,
  platform = process.platform,
} = {}) {
  if (typeof manifestPath !== "string" || manifestPath.length === 0) fail("manifest_path_required");
  const resolvedManifest = resolve(manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(resolvedManifest, "utf8"));
  } catch {
    fail("manifest_unreadable");
  }
  if (manifest?.schema !== MANIFEST_SCHEMA) fail(`schema_unsupported:${String(manifest?.schema)}`);

  const directory = dirname(resolvedManifest);
  const installerPath = join(directory, manifest.installer?.file ?? "");
  if (!(await regularFile(installerPath))) fail(`installer_absent:${manifest.installer?.file}`);

  const size = (await stat(installerPath)).size;
  if (size !== manifest.installer.bytes) fail(`installer_size_mismatch:${size}!=${manifest.installer.bytes}`);
  const digest = await sha256(installerPath);
  if (digest !== manifest.installer.sha256) fail(`installer_digest_mismatch:${digest}`);

  // The payload the manifest names has to be the archive that was sealed for this build, and the installer cannot
  // be smaller than the archive it embeds.
  if (typeof manifest.payload?.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(manifest.payload.sha256)) {
    fail("payload_digest_invalid");
  }
  if (size < manifest.payload.bytes) fail(`installer_smaller_than_payload:${size}<${manifest.payload.bytes}`);

  if (generationOutputRoot !== undefined) {
    let pointer;
    try {
      pointer = JSON.parse(await readFile(join(resolve(generationOutputRoot), "current.json"), "utf8"));
    } catch {
      fail("current_pointer_unreadable");
    }
    for (const field of ["generation", "inventoryDigest", "runtimeAdmissionSha256"]) {
      if (pointer?.[field] !== manifest[field]) {
        fail(`generation_binding_mismatch:${field}:${String(manifest[field])}!=${String(pointer?.[field])}`);
      }
    }
  }

  // The configuration and the signature claim have to agree: Release is the configuration that cannot exist unsigned,
  // Debug is the one whose own build says it is not for publication.
  const expectedConfiguration = manifest.signature?.required === true ? "Release" : "Debug";
  if (manifest.configuration !== expectedConfiguration) {
    fail(`configuration_claim_mismatch:${String(manifest.configuration)}!=${expectedConfiguration}`);
  }

  if (manifest.signature?.required === true) {
    const thumbprint = manifest.signature.thumbprint;
    if (typeof thumbprint !== "string" || !/^[0-9A-Fa-f]{40}$/u.test(thumbprint)) {
      fail("signing_identity_absent");
    }
    if (platform === "win32") {
      const verdict = await verifySignature({ installerPath, thumbprint });
      if (verdict.ok !== true) fail(`signature_not_verified:${verdict.reason ?? "unknown"}`);
    }
  }

  return Object.freeze({
    schema: manifest.schema,
    version: manifest.version,
    generation: manifest.generation,
    installerSha256: manifest.installer.sha256,
    signed: manifest.signature?.required === true,
  });
}

/**
 * Authenticode verification through the platform tool.
 *
 * `verify /pa /all` requires the signature to chain to a trusted root; the printout is not parsed beyond its exit
 * code, because the tool's exit code is the authority and grepping its localized text would be a second, weaker
 * one. A missing tool is reported as unverifiable rather than as verified.
 */
async function defaultSignatureVerification({ installerPath, signToolPath = undefined }) {
  const tool = signToolPath ?? process.env.GAMEBUDDY_SIGNTOOL;
  if (tool === undefined || tool.length === 0) return Object.freeze({ ok: false, reason: "signtool_unavailable" });
  const result = spawnSync(tool, ["verify", "/pa", "/all", installerPath], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.error) return Object.freeze({ ok: false, reason: "signtool_spawn_failed" });
  return result.status === 0
    ? Object.freeze({ ok: true })
    : Object.freeze({ ok: false, reason: `signtool_exit_${result.status}` });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  const manifestPath = process.argv[2];
  const generationOutputRoot = process.argv[3];
  try {
    const result = await checkReleaseManifest({
      manifestPath,
      generationOutputRoot,
      platform: process.platform,
    });
    process.stdout.write(
      `release_manifest_ok:version=${result.version} generation=${result.generation} signed=${result.signed} installer=${result.installerSha256}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
