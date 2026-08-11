#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { validateNativeSourceClosure } from "./lib/stardew-native-source-closure.mjs";
import { validateNativeTransitionFamilyUniverse } from "./lib/stardew-native-transition-family-universe.mjs";
import { collectCSharpSources, fileSha256, sourceManifestSha256 } from "./lib/stardew-native-source-attestation.mjs";

const args = process.argv.slice(2).filter((value) => value !== "--");
const take = (flag) => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : null; };
const certificatePath = take("--certificate"), universePath = take("--universe"), boundaryPath = take("--boundary-model"), sourceRoot = take("--source-root"), assemblyPath = take("--assembly"), contentManifestPath = take("--content-manifest");
if (!certificatePath || !universePath || !boundaryPath || !sourceRoot || !assemblyPath || !contentManifestPath || args.length !== 12) { console.error("Usage: node tools/check-stardew-native-source-closure.mjs --certificate <file> --universe <file> --boundary-model <file> --source-root <exact-decompile> --assembly <Stardew Valley.dll> --content-manifest <ContentHashes.json>"); process.exitCode = 2; }
else try {
  const [certificateText, universeText, boundaryText, sourceFiles, targetAssemblySha256, contentManifestSha256] = await Promise.all([readFile(resolve(certificatePath), "utf8"), readFile(resolve(universePath), "utf8"), readFile(resolve(boundaryPath), "utf8"), collectCSharpSources(sourceRoot), fileSha256(assemblyPath), fileSha256(contentManifestPath)]);
  const certificate = JSON.parse(certificateText), universe = JSON.parse(universeText), manifest = sourceManifestSha256(sourceFiles);
  validateNativeTransitionFamilyUniverse(universe, { sourceFiles });
  for (const [name, actual] of Object.entries({ targetAssemblySha256, sourceManifestSha256: manifest, contentManifestSha256 })) if (universe.attestation?.[name] !== actual || certificate.attestation?.[name] !== actual) throw new Error(`exact ${name} mismatch`);
  const boundaryHash = (await import("node:crypto")).createHash("sha256").update(boundaryText).digest("hex"); if (certificate.attestation?.boundaryModelSha256 !== boundaryHash) throw new Error("boundary model hash mismatch");
  const universeExits = new Set(universe.families.flatMap((family) => family.regions.flatMap((region) => region.exits.map((exit) => exit.exitId)))); const universeGaps = new Set(universe.families.flatMap((family) => family.gaps.map((gap) => gap.gapId)));
  for (const edge of certificate.mechanisms.flatMap((mechanism) => mechanism.edges)) if (!universeExits.has(edge.edgeId) && !universeGaps.has(edge.edgeId)) throw new Error(`certificate edge not in validated universe: ${edge.edgeId}`);
  console.log(JSON.stringify(validateNativeSourceClosure(certificate, { sourceFiles })));
} catch (error) { console.error(JSON.stringify({ error: error.code ?? "source_closure_check_failed", message: error.message })); process.exitCode = 1; }
