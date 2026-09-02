import { recheckProductionEntry, resolveProductionEntry } from "./production-artifact.mjs";
import { startArtifact } from "./start-artifact.internal.mjs";

await startArtifact({ resolveEntry: resolveProductionEntry, recheckEntry: recheckProductionEntry });
