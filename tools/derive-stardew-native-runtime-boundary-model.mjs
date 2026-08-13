#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  runtimeBoundaryModelDigest,
  validateNativeRuntimeBoundaryModel,
  validateToolContentRuntimeRecord,
} from "./lib/stardew-native-runtime-boundary-model.mjs";

function take(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : (process.argv[index + 1] ?? null);
}
function fail(message) {
  console.error(message);
  process.exitCode = 2;
}
function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

const surfacePath = take("--surface-report"),
  outPath = take("--out");
if (!surfacePath || !outPath) {
  fail(
    "Usage: node tools/derive-stardew-native-runtime-boundary-model.mjs --surface-report <exact-target-surface.json> --out <boundary-model.json>",
  );
} else
  try {
    const report = JSON.parse(await readFile(resolve(surfacePath), "utf8"));
    const targetAssemblySha256 = report?.assembly?.sha256,
      contentManifestSha256 = report?.content?.contentHashesSha256;
    const toolContent = report?.dataLoaderProbe?.toolContent;
    const toolRecord = validateToolContentRuntimeRecord(toolContent, { targetAssemblySha256, contentManifestSha256 });
    const model = {
      schemaVersion: 1,
      artifactKind: "native_runtime_boundary_model",
      attestation: { targetAssemblySha256, contentManifestSha256 },
      boundaries: [
        {
          boundaryId: "boundary:target-tool-content-snapshot",
          disposition: "runtime_modeled",
          kind: "runtime_content_snapshot",
          runtimeRecordSha256: toolRecord.toolRecordSha256,
        },
      ],
    };
    const summary = validateNativeRuntimeBoundaryModel(model, { targetAssemblySha256, contentManifestSha256 });
    await mkdir(dirname(resolve(outPath)), { recursive: true });
    await writeFile(resolve(outPath), `${JSON.stringify(model, null, 2)}\n`);
    console.log(
      JSON.stringify({
        ...summary,
        toolCount: toolRecord.toolCount,
        sourceSurfaceReportSha256: hash(await readFile(resolve(surfacePath), "utf8")),
      }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({ error: error.code ?? "runtime_boundary_model_derivation_failed", message: error.message }),
    );
    process.exitCode = 1;
  }
