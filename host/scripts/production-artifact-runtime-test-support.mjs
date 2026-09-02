import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Creates deliberately incomplete text bytes for fixture-only assertions.
 * This helper never creates an executable, archive, runtime admission, or
 * current pointer, so its output cannot be mistaken for a production artifact.
 */
export async function createIncompleteRuntimeFixture(root) {
  const fixtureRoot = join(root, "non-production-runtime-fixture");
  await mkdir(fixtureRoot, { recursive: true });
  const marker = join(fixtureRoot, "TEST_ONLY_NOT_A_RUNTIME.txt");
  await writeFile(marker, "test-only runtime fixture; production admission must reject\n", { flag: "w" });
  return Object.freeze({ fixtureRoot, marker, testOnly: true });
}
