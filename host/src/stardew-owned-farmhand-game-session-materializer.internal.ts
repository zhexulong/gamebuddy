import type { ConstructedUnmountedGameSemanticFacade } from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import { constructKnownUnmountedGameSemanticFacade } from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import { createGameRuntimeBindingFromReceiptBackedLaunch } from "./continuity-semantic-game-runtime-binding/continuity-semantic-game-runtime-binding.js";
import { createHostGameRuntimeMaterializer } from "./continuity-semantic-game-runtime-materializer/continuity-semantic-game-runtime-materializer.js";
import type { SemanticGameProductionAuthority } from "./continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import type { StardewPrivateFarmhandBridgeConnection } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import {
  createStardewIntegrationLaunchHandleFromAuthenticatedBridge,
  STARDEW_INTEGRATION_LAUNCHER,
} from "./stardew-integration-launcher.js";

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
 *
 * The shared Game authority is injected by the reference-game composition. The
 * materializer never constructs its own authority; on construction failure it
 * closes only the runtime binding it created and preserves the injected
 * authority for its composition owner.
 *
 * Upstream connect/launch/binding factories close their own transport or
 * launch when they reject, so each post-connect failure preserves its primary
 * error without stacking a duplicate close in this slice. The injected Game
 * authority never appears in failure cleanup.
 */
export function createStardewOwnedFarmhandGameSessionMaterializer(
  manifest: HostDeploymentManifest,
  game: SemanticGameProductionAuthority,
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
      try {
        return constructKnownUnmountedGameSemanticFacade(binding, game, createHostGameRuntimeMaterializer());
      } catch (error) {
        // A failed construction owns only this binding; the injected shared
        // Game authority must remain live for the composition owner's close.
        try {
          await binding.close();
        } catch {
          /* preserve primary construction failure */
        }
        throw error;
      }
    },
  });
}
