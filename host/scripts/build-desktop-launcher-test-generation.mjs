import { resolve } from "node:path";
import { rm } from "node:fs/promises";
import { buildWindowsStardewBootstrapGuardian } from "./build-windows-stardew-bootstrap-guardian.mjs";
import { buildProductionArtifact } from "./build-production-artifact.mjs";

// Test-only ingress. It deliberately delegates the complete publication to the
// production Host authority; it does not construct current.json or inventory.
const outputRoot = process.argv[2];
if (typeof outputRoot !== "string" || outputRoot.length === 0) {
  throw new Error("desktop_launcher_test_generation_output_required");
}

const canonicalOutputRoot = resolve(outputRoot);
await rm(canonicalOutputRoot, { recursive: true, force: true });
// The canonical publisher independently verifies the fixed pair. Rebuild it in
// this test-only route first so a prior parallel build cannot leave a transient
// replaced directory between its publication steps.
await buildWindowsStardewBootstrapGuardian();
await buildProductionArtifact({ outputRoot: canonicalOutputRoot });
