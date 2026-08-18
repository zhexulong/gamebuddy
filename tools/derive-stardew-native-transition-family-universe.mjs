#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { validateNativeTransitionFamilyUniverse } from "./lib/stardew-native-transition-family-universe.mjs";
import { collectCSharpSources, fileSha256, sourceManifestSha256 } from "./lib/stardew-native-source-attestation.mjs";

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function exactSpan(sourceFiles, relativePath, needle) {
  const source = sourceFiles[relativePath];
  if (!source) fail("transition_family_universe_source_missing", `Missing declared source: ${relativePath}`);
  const bytes = Buffer.from(source.text, "utf8");
  const needleBytes = Buffer.from(needle, "utf8");
  const startByte = bytes.indexOf(needleBytes);
  if (startByte < 0)
    fail("transition_family_universe_anchor_missing", `Required exact source text missing: ${relativePath}: ${needle}`);
  const endByte = startByte + needleBytes.length;
  return {
    relativePath,
    startByte,
    endByte,
    sliceSha256: awaitableSha(bytes.subarray(startByte, endByte)),
    sourceFileSha256: source.sha256,
  };
}
function awaitableSha(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
const args = process.argv.slice(2);
const take = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : null;
};
const sourceRoot = take("--source-root"),
  definitionsPath = take("--definitions"),
  assemblyPath = take("--assembly"),
  contentManifestPath = take("--content-manifest"),
  out = take("--out");
if (!sourceRoot || !definitionsPath || !assemblyPath || !contentManifestPath || !out)
  fail(
    "transition_family_universe_cli_usage",
    "Usage: --source-root <exact-decompile> --definitions <families.json> --assembly <Stardew Valley.dll> --content-manifest <ContentHashes.json> --out <report.json>",
  );
const [sourceFiles, definitions, targetAssemblySha256, contentManifestSha256] = await Promise.all([
  collectCSharpSources(sourceRoot),
  readFile(definitionsPath, "utf8").then(JSON.parse),
  fileSha256(assemblyPath),
  fileSha256(contentManifestPath),
]);
const exactSourceManifestSha256 = sourceManifestSha256(sourceFiles);
if (!Array.isArray(definitions?.families) || !definitions.attestation)
  fail("transition_family_universe_definitions_invalid", "Definitions must contain attested families.");
for (const [name, actual] of Object.entries({
  targetAssemblySha256,
  sourceManifestSha256: exactSourceManifestSha256,
  contentManifestSha256,
}))
  if (definitions.attestation[name] !== actual)
    fail("transition_family_universe_attestation_mismatch", `Definitions ${name} does not match exact supplied input.`);
const universe = {
  schemaVersion: 2,
  artifactKind: "native_transition_family_universe",
  attestation: { targetAssemblySha256, sourceManifestSha256: exactSourceManifestSha256, contentManifestSha256 },
  families: definitions.families.map((family) => ({
    ...family,
    regions: family.regions.map((region) => ({
      ...region,
      ownerAnchor: exactSpan(sourceFiles, region.owner.relativePath, region.owner.needle),
      exits: region.exits.map((exit) => ({
        ...exit,
        anchor: exactSpan(sourceFiles, exit.source.relativePath, exit.source.needle),
      })),
    })),
    gaps: family.gaps.map((gap) => ({
      ...gap,
      anchor: exactSpan(sourceFiles, gap.source.relativePath, gap.source.needle),
    })),
  })),
};
const validation = validateNativeTransitionFamilyUniverse(universe, { sourceFiles });
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, `${JSON.stringify({ ...universe, validation }, null, 2)}\n`);
console.log(
  JSON.stringify({
    artifactKind: universe.artifactKind,
    familyCount: validation.familyCount,
    blockingGapCount: validation.blockingGapCount,
    closureState: validation.closureState,
  }),
);
