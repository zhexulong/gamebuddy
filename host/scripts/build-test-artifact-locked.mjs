import { access, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { resolveTypeScriptInvocation } from "./build-production-artifact.mjs";
import { runBoundedChild } from "./child-process-tool.mjs";
import { readTestArtifactLock } from "./test-artifact-lock.mjs";
import { writeHostVerificationArtifactManifest } from "./verification-artifact-manifest.mjs";

const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = resolve(hostRoot, "dist-test");

/**
 * This module deletes and rewrites `dist-test`. It is the INTERNAL half of the build: it
 * assumes the caller already holds the test-artifact lock, because the public entry
 * (`pnpm build:test` -> `build-test-artifact.mjs`) is what acquires it, and the suite runner
 * holds it around its own build+tests.
 *
 * That assumption was only a convention, and it was broken repeatedly: a direct
 * `node scripts/build-test-artifact-locked.mjs` (which several pairs of hands, mine included,
 * ran while a suite was live) wipes the artifact out from under every running child, and the
 * symptom is not "a build error" - it is a handful of unrelated tests failing with
 * `materialized_runtime_test_observation_unavailable` (the overlay is gone) or with a budget
 * that expired while a rebuild happened. So the module now refuses to run unless the lock
 * belongs to this process.
 */
async function assertArtifactLockHeldByThisProcess() {
  let record;
  try {
    record = await readTestArtifactLock();
  } catch {
    throw new Error("host_test_artifact_lock_required:use `pnpm build:test` (it acquires the lock) instead of invoking this module directly");
  }
  if (record === undefined)
    throw new Error(
      "host_test_artifact_lock_required:no lock is held:use `pnpm build:test` (it acquires the lock) instead of invoking this module directly",
    );
  if (record.pid !== process.pid)
    throw new Error(
      `host_test_artifact_lock_required:held_by_pid=${record.pid}:use \`pnpm build:test\` (it waits for the lock) instead of invoking this module directly`,
    );
}

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

await assertArtifactLockHeldByThisProcess();
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
