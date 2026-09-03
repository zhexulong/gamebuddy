import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveTypeScriptInvocation } from "./build-production-artifact.mjs";
import { runBoundedChild } from "@gamebuddy/game-action-devkit/process-supervisor";
import { writeHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(hostRoot, "dist-test");

/**
 * Test-artifact-only overlay. The production source has no test-support edge;
 * after TypeScript emits it, this injects observation into the test copy alone.
 * It observes an already-materialized runtime and cannot construct or mint any
 * production binding/capability.
 */
async function applyGameRuntimeMaterializerTestOverlay() {
  const relativeModule = "continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
  const target = resolve(outputRoot, relativeModule);
  const source = await readFile(target, "utf8");
  const importMarker = 'import { materializeExactEnter, } from "./continuity-semantic-game-runtime-materializer.internal.js";';
  const runtimeMarker = "                const runtime = constructed.runtime;";
  const materializeMarker = "            return await materializeExactEnter(reservation, permit, async (execution, admission) => {";
  const closeMarker = "            });\n        },\n    });\n}";
  if (!source.includes(importMarker) || !source.includes(runtimeMarker) || !source.includes(materializeMarker) || !source.includes(closeMarker))
    throw new Error("test_materializer_overlay_source_shape_changed");
  const overlaid = source
    .replace(importMarker, `${importMarker}\nimport { forgetMaterializedProductionRuntimeForTest, recordMaterializedProductionRuntimeForTest, } from "./continuity-semantic-game-runtime-materializer.test-support.js";`)
    .replace(materializeMarker, "            let observedRuntime;\n            const materialized = await materializeExactEnter(reservation, permit, async (execution, admission) => {")
    .replace("                let ingressActivated = false;", "                observedRuntime = runtime;\n                let ingressActivated = false;")
    .replace(closeMarker, `            });\n            if (observedRuntime === undefined) return materialized;\n            let observed;\n            observed = Object.freeze({\n                ...materialized,\n                close: async () => {\n                    try { await materialized.close(); }\n                    finally { forgetMaterializedProductionRuntimeForTest(observed); }\n                },\n                teardownClose: async (closePermit) => {\n                    try { return await materialized.teardownClose(closePermit); }\n                    finally { forgetMaterializedProductionRuntimeForTest(observed); }\n                },\n            });\n            recordMaterializedProductionRuntimeForTest(observed, observedRuntime);\n            return observed;\n        },\n    });\n}`);
  await writeFile(target, overlaid);
}

await rm(outputRoot, { recursive: true, force: true });
await runBoundedChild({
  ...(await resolveTypeScriptInvocation({ project: "tsconfig.test.json" })),
  stdio: "inherit",
});
await applyGameRuntimeMaterializerTestOverlay();
for (const entry of ["main.js", "dialogue-web-main.js"]) {
  try { await access(resolve(outputRoot, entry)); throw new Error(`test_artifact_contains_production_entry:${entry}`); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
}
// TypeScript fixture workers are emitted by the test compiler. Copy only the
// PowerShell assets that cannot be emitted, so dist-test never mixes source
// .ts files with its compiled test artifact.
for (const source of [
  "src/test-fixtures/windows-named-mutex-abandon-child.ps1",
  "src/test-fixtures/windows-named-mutex-broker-test-sidecar.ps1",
  "src/test-fixtures/windows-named-mutex-retained-abandon.ps1",
]) {
  const destination = resolve(outputRoot, source.slice("src/".length));
  await mkdir(dirname(destination), { recursive: true });
  await cp(resolve(hostRoot, source), destination, { force: true, verbatimSymlinks: true });
}
await cp(resolve(hostRoot, "resources/windows-named-mutex-broker.ps1"), resolve(outputRoot, "windows-named-mutex-broker.ps1"), { force: true, verbatimSymlinks: true });
await writeHostVerificationArtifactManifest({ root: hostRoot, outputRoot });
