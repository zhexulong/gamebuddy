#!/usr/bin/env node
/**
 * Wires the assembled release into the place a player downloads from, and refuses to publish a partial one.
 *
 * Three facts have to be true together before a release is published, and each has a different owner:
 *
 *   - the artifact exists and matches its manifest (the manifest gate), so the file and the claim are one thing;
 *   - the manifest is signed where the release is public (the installer's own MSBuild target, surfaced by the
 *     manifest's `signature.required`), so an unsigned build cannot be presented as a release;
 *   - the release is a tag, not a branch (the workflow's own trigger), so a download URL can name a version.
 *
 * This script performs the third check for the upload path and prints the exact asset list to publish. It does not
 * itself talk to a hosting API: the workflow uses the platform's own release action, and a release step that pushed
 * bytes through a third mechanism would be a second authority for what a published release is.
 */

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkReleaseManifest } from "./check-release-manifest.mjs";

function fail(reason) {
  throw new Error(`release_publication_refused:${reason}`);
}

/**
 * Validates one assembled release for publication and returns what the upload step should publish.
 *
 * `tag` is the workflow's `GITHUB_REF_NAME`; the version in the manifest has to be that same tag without its `v`, so a
 * manifest cannot be published under a release whose name disagrees with it.
 */
export async function preparePublication({
  manifestPath,
  tag,
  generationOutputRoot,
  verifySignature,
  platform,
  allowUnsigned = false,
}) {
  if (typeof tag !== "string" || !/^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(tag)) {
    fail(`tag_invalid:${String(tag)}`);
  }
  const verdict = await checkReleaseManifest({
    manifestPath,
    generationOutputRoot,
    ...(verifySignature === undefined ? {} : { verifySignature }),
    ...(platform === undefined ? {} : { platform }),
  });
  if (tag.slice(1) !== verdict.version) {
    fail(`tag_version_mismatch:${tag.slice(1)}!=${verdict.version}`);
  }
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));

  if (verdict.signed !== true) {
    // An unsigned artifact may only be published when the lane says so AND the manifest agrees it is unsigned. The
    // configuration check is what stops a signed build from being relabelled: Release cannot exist unsigned.
    if (!allowUnsigned) fail("publication_requires_signature");
    if (manifest.configuration !== "Debug") fail(`unsigned_but_configuration_is:${String(manifest.configuration)}`);
  }

  const directory = dirname(resolve(manifestPath));
  const assets = [join(directory, manifest.installer.file), resolve(manifestPath)];
  // The payload is uploaded alongside the installer so an upgrade path, or a player who wants to inspect what the
  // installer carries, can bind it to the manifest's digest without unpacking a 447 MB executable.
  const payload = join(directory, "payload.zip");
  const unsigned = verdict.signed !== true;
  return Object.freeze({
    tag,
    version: verdict.version,
    generation: verdict.generation,
    installerSha256: verdict.installerSha256,
    // Carried in the publication record, so "was this release signed?" is answerable from the record rather than by
    // reading a workflow.
    unsigned,
    assets: Object.freeze([...assets, payload]),
    body: [
      ...(unsigned
        ? [
            "> **This build is not code-signed.** Windows SmartScreen may warn on first run, and the publisher's",
            "> identity is not attested by this artifact. Verify the SHA-256 below before running it.",
            "",
          ]
        : []),
      `GameBuddy ${verdict.version}`,
      "",
      `- Installer: \`${manifest.installer.file}\` (${manifest.installer.bytes} bytes)`,
      `- SHA-256: \`${manifest.installer.sha256}\``,
      `- Generation: \`${verdict.generation}\``,
      `- Payload SHA-256: \`${manifest.payload.sha256}\``,
      ...(unsigned
        ? ["- Signature: none"]
        : [`- Signature: \`${manifest.signature.scheme}\`, thumbprint \`${manifest.signature.thumbprint}\``]),
      "",
      "Verify before running:",
      "",
      "```",
      `certutil -hashfile ${manifest.installer.file} SHA256`,
      "```",
    ].join("\n"),
  });
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [manifestPath, tag, generationOutputRoot] = process.argv
      .slice(2)
      .filter((value) => value !== "--allow-unsigned");
    const publication = await preparePublication({
      manifestPath,
      tag,
      generationOutputRoot,
      allowUnsigned: process.argv.includes("--allow-unsigned"),
    });
    process.stdout.write(`${JSON.stringify(publication, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
