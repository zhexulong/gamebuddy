import { recheckTestArtifactEntry, resolveTestArtifactEntry } from "./production-artifact-test-support.mjs";
import { startArtifact } from "./start-artifact.internal.mjs";

await startArtifact({ resolveEntry: resolveTestArtifactEntry, recheckEntry: recheckTestArtifactEntry });
