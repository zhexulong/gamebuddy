import type { HostDeploymentManifest } from "./deployment-manifest.js";
import {
  createStardewProductionLifecycleCoordinatorFromTestingComposition,
  type StardewProductionLifecycleCoordinator,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import { createStardewPrivateBootstrapCompositionForTesting } from "./stardew-private-bootstrap-composer.test-support-internal.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./stardew-private-bootstrap-composer.test-support-internal.js";
import type { StopOwnedAiClientResult } from "./stardew-ai-client-process-owner.js";
import type { StopOwnedPlayerHostResult } from "./stardew-player-host-process-owner.js";

export type StardewLifecycleCoordinatorTestingOverrides = Readonly<{
  closeBroker?(underlying: () => void): void;
  stopAiClient?(underlying: () => StopOwnedAiClientResult): StopOwnedAiClientResult;
  stopPlayerHost?(underlying: () => StopOwnedPlayerHostResult): StopOwnedPlayerHostResult;
}>;

/** Dedicated deterministic adapter; production factory accepts no dependencies. */
export function createStardewProductionLifecycleCoordinatorForTesting(
  manifest: HostDeploymentManifest,
  dependencies: StardewPrivateBootstrapCoreDependencies,
  overrides: StardewLifecycleCoordinatorTestingOverrides = {},
): StardewProductionLifecycleCoordinator {
  const internal = createStardewPrivateBootstrapCompositionForTesting(dependencies);
  const base = internal.composition;
  const broker = Object.freeze({
    ...base.broker,
    close: () => {
      if (overrides.closeBroker !== undefined) overrides.closeBroker(() => base.broker.close());
      else base.broker.close();
    },
  });
  const aiClientProcessOwner = Object.freeze({
    ...base.aiClientProcessOwner,
    stopOwnedAiClient: () => overrides.stopAiClient !== undefined
      ? overrides.stopAiClient(() => base.aiClientProcessOwner.stopOwnedAiClient())
      : base.aiClientProcessOwner.stopOwnedAiClient(),
  });
  const playerHostProcessOwner = Object.freeze({
    ...base.playerHostProcessOwner,
    stopOwnedPlayerHost: () => overrides.stopPlayerHost !== undefined
      ? overrides.stopPlayerHost(() => base.playerHostProcessOwner.stopOwnedPlayerHost())
      : base.playerHostProcessOwner.stopOwnedPlayerHost(),
  });
  return createStardewProductionLifecycleCoordinatorFromTestingComposition(
    manifest,
    Object.freeze({
      ...internal,
      composition: Object.freeze({
        ...base,
        broker,
        aiClientProcessOwner,
        playerHostProcessOwner,
      }),
    }),
  );
}
