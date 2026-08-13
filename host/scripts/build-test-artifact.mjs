import { withTestArtifactLock } from "./test-artifact-lock.mjs";

await withTestArtifactLock(async () => {
  await import("./build-test-artifact-locked.mjs");
});
