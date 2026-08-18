import { createReclaimerCapability, type SpawnHelper, type WindowsStaleLockReclaimerCapability } from "./internal.js";

/** Test-compilation-only capability factory; production entry neither imports nor exposes it. */
export function createTestWindowsStaleLockReclaimer(spawnHelper: SpawnHelper): WindowsStaleLockReclaimerCapability {
  return createReclaimerCapability({ executable: "test-only-helper", reclaimOnNonWindows: true, spawnHelper });
}
