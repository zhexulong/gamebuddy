import { selectContinuitySession } from "./continuity.js";
import { CompanionLoop } from "./companion-loop.js";
import { CompanionHostService } from "./host-service.js";
import { assertReceiptBackedLaunch, type IntegrationLauncher, type IntegrationLaunchHandle } from "./integration-launcher.js";
import { type IntegrationActionPolicy } from "./integration-module.js";
import { type PresentationProfile, type PresentationRuntime, type CompanionTextPort } from "./presentation.js";
import { identityKey, resolveRuntimePaths, type CompanionModelConfig, type GameCompanionIdentity } from "./runtime-core.js";
import { createGameCompanionRuntime, type GameRuntimeSession } from "./runtime-game.js";
import { type CompanionSpeechPort } from "./presentation-types.js";
import { type WorldBookBinding } from "./worldbook.js";

export type IntegrationCompanionConnection = Readonly<{
  identity: GameCompanionIdentity;
  launcher: IntegrationLauncher;
  /** Opaque adapter configuration, selected by the local operator/product flow. */
  launcherConfig: unknown;
  runtimeRoot?: string;
  modelConfig?: CompanionModelConfig;
  actionPolicy?: IntegrationActionPolicy;
  gameplaySubagent?: boolean;
  presentationProfile?: PresentationProfile;
  textPort?: CompanionTextPort;
  speechPort?: CompanionSpeechPort;
  surfaceSessionId?: string;
  worldBook?: WorldBookBinding;
}>;

export type ConnectedIntegrationCompanion = Readonly<{
  launch: IntegrationLaunchHandle;
  runtime: GameRuntimeSession;
  loop: CompanionLoop;
  host: CompanionHostService;
}>;

/**
 * Host-neutral explicit Game-surface bootstrap. Only receipt-backed adapters
 * with an initial authoritative state reach runtime/tool mounting.
 */
export async function connectIntegrationCompanion(connection: IntegrationCompanionConnection): Promise<ConnectedIntegrationCompanion> {
  const launch = await connection.launcher.launch({ identity: connection.identity, config: connection.launcherConfig });
  try {
    assertReceiptBackedLaunch(connection.launcher, launch, connection.identity);
    const worldScope = launch.connection.module.worldScope(launch.connection);
    if (connection.identity.continuityId !== undefined && worldScope === null) throw new Error("integration_world_scope_required");
    const surfaceSessionId = connection.identity.continuityId === undefined
      ? connection.surfaceSessionId
      : (await selectContinuitySession(resolveRuntimePaths(connection.identity, connection.runtimeRoot), connection.identity, {
        surface: "game",
        ...(connection.surfaceSessionId === undefined ? {} : { sessionId: connection.surfaceSessionId }),
        world: worldScope!,
      })).session.sessionId;
    const presentation = connection.presentationProfile === undefined ? undefined : {
      profile: connection.presentationProfile,
      sessionId: identityKey(connection.identity),
      textPort: connection.textPort,
      speechPort: connection.speechPort,
    } satisfies PresentationRuntime;
    const runtime = await createGameCompanionRuntime({
      identity: connection.identity, root: connection.runtimeRoot, integration: launch.connection, modelConfig: connection.modelConfig,
      actionPolicy: connection.actionPolicy, presentation, gameplaySubagentEnabled: connection.gameplaySubagent === true,
      surfaceSessionId, worldBook: connection.worldBook,
    });
    const loop = new CompanionLoop(runtime.session);
    const host = new CompanionHostService(loop, launch.events, (reasonCode) => {
      // Revoke before any adapter teardown so stale tool closures and the
      // gameplay worker cannot submit another execution after disconnect.
      launch.revoke(reasonCode);
      void runtime.gameplaySubagent?.cancel(`integration_${reasonCode}`);
    });
    host.acceptInitialFacts(launch.initialFacts);
    return Object.freeze({ launch, runtime, loop, host });
  } catch (error) {
    launch.close();
    throw error;
  }
}

/** Dispose in reverse order so no Agent can see an adapter during teardown. */
export function disconnectIntegrationCompanion(connected: ConnectedIntegrationCompanion): void {
  connected.host.close();
  connected.runtime.gameplaySubagent?.dispose();
  connected.runtime.session.dispose();
  connected.launch.close();
}
