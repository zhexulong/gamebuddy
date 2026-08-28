import assert from "node:assert/strict";
import test from "node:test";

import { createStardewProductionLifecycleCoordinator } from "./stardew-production-lifecycle-coordinator.internal.js";

test("production lifecycle construction is fail-closed off Windows", async () => {
  if (process.platform !== "win32") {
    await assert.rejects(
      () => Promise.resolve(createStardewProductionLifecycleCoordinator()),
      /stardew_private_bootstrap_composition_requires_windows/,
    );
    return;
  }

  const coordinator = createStardewProductionLifecycleCoordinator();
  assert.equal(Object.isFrozen(coordinator), true);
  assert.deepEqual(Object.keys(coordinator).sort(), ["close", "lifecycleReader"]);
  assert.equal(Object.isFrozen(coordinator.lifecycleReader), true);
  assert.deepEqual(Object.keys(coordinator.lifecycleReader), ["readRoleLifecycleView"]);
  assert.deepEqual(await coordinator.lifecycleReader.readRoleLifecycleView(), {
    schemaVersion: 1,
    playerHost: { state: "not_started", ownership: "none" },
    aiClient: { state: "not_started", ownership: "none" },
  });
  await coordinator.close();
  await coordinator.close();
  await assert.rejects(
    () => coordinator.lifecycleReader.readRoleLifecycleView(),
    /stardew_lifecycle_closed/,
  );
});
