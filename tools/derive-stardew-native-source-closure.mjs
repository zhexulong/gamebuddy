#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { collectCSharpSources, fileSha256, sourceManifestSha256 } from "./lib/stardew-native-source-attestation.mjs";
import { validateNativeSourceClosure } from "./lib/stardew-native-source-closure.mjs";
import { validateNativeTransitionFamilyUniverse } from "./lib/stardew-native-transition-family-universe.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}
function fail(message) {
  console.error(message);
  process.exitCode = 2;
}
function anchorReference(anchor) {
  return {
    relativePath: anchor.relativePath,
    startByte: anchor.startByte,
    endByte: anchor.endByte,
    sliceSha256: anchor.sliceSha256,
    sourceFileSha256: anchor.sourceFileSha256,
  };
}

const universePath = arg("--universe"),
  boundaryModelPath = arg("--boundary-model"),
  sourceRoot = arg("--source-root"),
  assemblyPath = arg("--assembly"),
  contentManifestPath = arg("--content-manifest"),
  outPath = arg("--out");
if (!universePath || !boundaryModelPath || !sourceRoot || !assemblyPath || !contentManifestPath || !outPath) {
  fail(
    "Usage: node tools/derive-stardew-native-source-closure.mjs --universe <universe.json> --boundary-model <scope.json> --source-root <exact-decompile> --assembly <Stardew Valley.dll> --content-manifest <ContentHashes.json> --out <certificate.json>",
  );
} else {
  try {
    const [universeText, boundaryText, sourceFiles, targetAssemblySha256, contentManifestSha256] = await Promise.all([
      readFile(resolve(universePath), "utf8"),
      readFile(resolve(boundaryModelPath), "utf8"),
      collectCSharpSources(sourceRoot),
      fileSha256(assemblyPath),
      fileSha256(contentManifestPath),
    ]);
    const universe = JSON.parse(universeText),
      boundaryModel = JSON.parse(boundaryText),
      exactSourceManifestSha256 = sourceManifestSha256(sourceFiles);
    if (universe.schemaVersion !== 2 || universe.artifactKind !== "native_transition_family_universe")
      throw new Error("closure derivation requires schema-v2 transition universe");
    if (
      universe.attestation.targetAssemblySha256 !== targetAssemblySha256 ||
      universe.attestation.sourceManifestSha256 !== exactSourceManifestSha256 ||
      universe.attestation.contentManifestSha256 !== contentManifestSha256
    )
      throw new Error("closure derivation input attestation mismatch");
    validateNativeTransitionFamilyUniverse(universe, { sourceFiles });
    const mechanisms = universe.families.map((family) => {
      const regionEdges = family.regions.flatMap((region) =>
        region.exits.map((exit) => ({
          edgeId: exit.exitId,
          disposition: "source_resolved",
          sourceAnchor: anchorReference(exit.anchor),
        })),
      );
      const gapEdges = family.gaps.map((gap) => ({
        edgeId: gap.gapId,
        disposition: "unknown_blocking",
        sourceAnchor: anchorReference(gap.anchor),
      }));
      return {
        mechanismId: family.familyId,
        terminal: gapEdges.length ? "unknown_blocking" : "native_transition",
        edges: [...regionEdges, ...gapEdges],
      };
    });
    const certificate = {
      schemaVersion: 2,
      artifactKind: "native_source_closure",
      attestation: {
        targetAssemblySha256,
        sourceManifestSha256: exactSourceManifestSha256,
        contentManifestSha256,
        boundaryModelSha256: sha256(boundaryText),
      },
      boundaryModel: {
        schemaVersion: boundaryModel.schemaVersion,
        scope: boundaryModel.scope,
        sha256: sha256(boundaryText),
      },
      closureState: mechanisms.some((mechanism) => mechanism.terminal === "unknown_blocking")
        ? "partial_with_unknown_blocking"
        : "bounded_source_closure_complete",
      mechanisms,
    };
    const summary = validateNativeSourceClosure(certificate, { sourceFiles });
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(resolve(outPath), `${JSON.stringify(certificate, null, 2)}\n`);
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(JSON.stringify({ error: error.code ?? "source_closure_derivation_failed", message: error.message }));
    process.exitCode = 1;
  }
}
