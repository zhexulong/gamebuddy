/**
 * Target-publication manifest producer for the package-owned static verifier.
 *
 * This is the independent handoff of the target-version build gate: it turns
 * the real compiled Mod/Core/contract sibling closure from one exact build
 * into the versioned target-publication manifest that `verify-production.mjs`
 * later admits and verifies. The producer derives every fact it publishes:
 * SHA-256 digests come from the actual artifact bytes, assembly identities
 * come from the actual artifact metadata (via the caller-supplied identity
 * reader), and the same-build provenance is one explicit buildId shared by
 * the manifest and every artifact.
 *
 * The producer never builds, never verifies, and never claims live or release
 * evidence. It only composes and atomically publishes the manifest; a failure
 * to derive any fact must abort before any manifest is written.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  PUBLICATION_ARTIFACTS,
  TARGET_PUBLICATION_MANIFEST_SCHEMA,
  PRODUCTION_VERIFIER_ID,
  TARGET_PUBLICATION_SCOPE,
  validateTargetPublicationManifest,
} from "./production-schema.mjs";

function fail(code) {
  throw new Error(`stardew_target_publication_producer_${code}`);
}

function requireRecord(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value;
}

function requireHex64(value, code) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) fail(code);
  return value;
}

function requireString(value, code) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) fail(code);
  return value;
}

function closureArtifactsById(artifacts) {
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  for (const expected of PUBLICATION_ARTIFACTS) {
    const artifact = byId.get(expected.id);
    if (artifact === undefined) fail("artifact_missing");
    requireString(artifact.assemblyIdentity, "artifact_identity");
    requireHex64(artifact.sha256, "artifact_sha256");
  }
  if (byId.size !== PUBLICATION_ARTIFACTS.length) fail("artifact_unknown");
  return byId;
}

/**
 * Deterministic same-build provenance derived from the exact closure bytes:
 * a `closure-<hex>` buildId that changes whenever any artifact changes and is
 * shared verbatim by the manifest and every artifact. A caller may override
 * it with an explicit buildId, which the producer then applies uniformly.
 */
export function closureBuildId(artifacts) {
  const byId = closureArtifactsById(artifacts);
  const joined = PUBLICATION_ARTIFACTS
    .map((artifact) => `${artifact.id}:${byId.get(artifact.id).sha256}`)
    .join("|");
  return `closure-${createHash("sha256").update(joined).digest("hex").slice(0, 16)}`;
}

function defaultPublicationId(buildId) {
  const suffix = buildId.replace(/^closure-/, "");
  return `farmhand-capability-${suffix}`;
}

/**
 * Compose the versioned target-publication manifest for an exact real
 * Mod/Core/contract closure and validate it against the production schema
 * before returning the frozen manifest. `artifacts` pairs each frozen
 * publication artifact id with the identity and digest derived from the real
 * artifact bytes; role/relativePath come from the frozen identity table and
 * can never drift from the caller.
 *
 * @param {object} input
 * @param {string} input.artifactRoot absolute or package-anchored closure root
 * @param {[{id:string, assemblyIdentity:string, sha256:string}]} input.artifacts
 * @param {string} [input.publicationId]
 * @param {string} [input.buildId]
 */
export async function composeTargetPublicationManifest(input) {
  requireRecord(input, "input_shape");
  requireString(input.artifactRoot, "artifact_root");
  const byId = closureArtifactsById(input.artifacts);
  const buildId = input.buildId === undefined
    ? closureBuildId([...byId.values()])
    : requireString(input.buildId, "build_id");
  const publicationId = input.publicationId === undefined
    ? defaultPublicationId(buildId)
    : requireString(input.publicationId, "publication_id");
  const artifacts = PUBLICATION_ARTIFACTS.map((expected) => ({
    id: expected.id,
    role: expected.role,
    relativePath: expected.relativePath,
    assemblyIdentity: byId.get(expected.id).assemblyIdentity,
    buildId,
    sha256: byId.get(expected.id).sha256,
  }));
  return validateTargetPublicationManifest({
    schema: TARGET_PUBLICATION_MANIFEST_SCHEMA,
    verifierId: PRODUCTION_VERIFIER_ID,
    scope: TARGET_PUBLICATION_SCOPE,
    publicationId,
    artifactRoot: input.artifactRoot,
    provenance: { buildId },
    artifacts,
  });
}

/**
 * Publish the manifest atomically: the JSON is written to a unique sibling
 * temporary file and renamed over the target only after the write completes.
 * A failed or interrupted publication never leaves a partial manifest at the
 * target path, and readers never observe a half-written file.
 */
export async function writeTargetPublicationManifestAtomic(targetPath, manifest) {
  requireString(targetPath, "output_path");
  await mkdir(path.dirname(path.resolve(targetPath)), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(path.resolve(targetPath)),
    `.${path.basename(targetPath)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporaryPath, path.resolve(targetPath));
  } catch (error) {
    try { await rename(temporaryPath, temporaryPath); } catch { /* best-effort */ }
    throw error;
  }
}