import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { publishFixedReleaseProductionArtifact } from "./node-runtime-release-acquisition.mjs";

const scriptPath = fileURLToPath(import.meta.url);
export async function buildReleaseProductionArtifact() { return publishFixedReleaseProductionArtifact(); }
if (resolve(process.argv[1] ?? "") === scriptPath) await buildReleaseProductionArtifact();
