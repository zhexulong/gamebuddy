import type { HostDeploymentManifest } from "./deployment-manifest.js";
import type {
  ConstructedUnmountedGameSemanticFacade,
} from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import { createKnownSemanticGameFacadeFromReceiptBackedBinding } from "./continuity-semantic-game-operator-selection/continuity-semantic-game-operator-selection.internal.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";
import type { StardewPrivateFarmhandBridgeConnection } from "./stardew-private-bootstrap-composer.core.js";
import { createGameRuntimeBindingFromReceiptBackedLaunch } from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";

export type StardewOwnedFarmhandGameSessionMaterializer = Readonly<{
  materialize(
    connection: StardewPrivateFarmhandBridgeConnection,
    deadlineMs: number,
  ): Promise<ConstructedUnmountedGameSemanticFacade>;
}>;

/**
 * Stardew production construction seam for the exact private Farmhand bridge.
 * It returns an unmounted semantic facade; the lifecycle coordinator remains the
 * only owner of entry, ingress activation, attachment projection, and teardown.
 */
export function createStardewOwnedFarmhandGameSessionMaterializer(
  manifest: HostDeploymentManifest,
): StardewOwnedFarmhandGameSessionMaterializer {
  return Object.freeze({
    materialize: async (
      connection: StardewPrivateFarmhandBridgeConnection,
      deadlineMs: number,
    ): Promise<ConstructedUnmountedGameSemanticFacade> => {
      const bridge = await LocalStardewBridgeClient.connectFarmhand(
        connection.scope,
        connection.pipeName,
        connection.token,
        connection.launchGeneration,
        deadlineMs,
      );
      const launch = await createStardewIntegrationLaunchHandleFromAuthenticatedBridge(
        bridge,
        Object.freeze({
          playerId: manifest.principal.playerId,
          companionId: manifest.principal.companionId,
          saveId: connection.scope.saveId,
          worldId: connection.scope.worldId,
        }),
      );
      const binding = await createGameRuntimeBindingFromReceiptBackedLaunch(
        Object.freeze({
          manifest,
          launcher: STARDEW_INTEGRATION_LAUNCHER,
          launch,
          expectedWorld: Object.freeze({
            saveId: connection.scope.saveId,
            worldId: connection.scope.worldId,
          }),
        }),
      );
      return createKnownSemanticGameFacadeFromReceiptBackedBinding(manifest, binding);
    },
  });
}
