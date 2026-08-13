import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { assertCompleteProductionArtifact } from "./production-artifact.mjs";
const hostRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
console.log(JSON.stringify(await assertCompleteProductionArtifact({ hostRoot, outputRoot: resolve(hostRoot, "dist") }), null, 2));
