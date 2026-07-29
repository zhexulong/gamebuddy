import { createCompanionRuntime, type CompanionIdentity, type CompanionModelConfig, type RuntimeSession } from "./runtime.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";

export type LocalStardewConnection = Readonly<{
  identity: CompanionIdentity;
  pipeName: string;
  bridgeToken: string;
  runtimeRoot?: string;
  /** Omit this for offline/replay mode; explicit config selects the real Agent model. */
  modelConfig?: CompanionModelConfig;
}>;

export type ConnectedCompanion = Readonly<{
  bridge: LocalStardewBridgeClient;
  runtime: RuntimeSession;
}>;

/**
 * Establish the Phase 2 local IPC session before creating the Pi runtime.
 * An initial authoritative observation is mandatory: the Host never starts an
 * Agent turn on a mere transport connection or a model-supplied world state.
 */
export async function connectLocalCompanion(connection: LocalStardewConnection): Promise<ConnectedCompanion> {
  const scope = {
    integrationId: "stardew",
    saveId: connection.identity.saveId,
    worldId: connection.identity.worldId,
    playerId: connection.identity.playerId,
    companionId: connection.identity.companionId,
  } as const;
  const bridge = await LocalStardewBridgeClient.connect(scope, connection.pipeName, connection.bridgeToken);
  try {
    await bridge.observe();
    const runtime = await createCompanionRuntime(connection.identity, connection.runtimeRoot, bridge, connection.modelConfig);
    return { bridge, runtime };
  } catch (error) {
    bridge.close();
    throw error;
  }
}

/** Dispose in reverse order so no Agent can see a bridge during teardown. */
export function disconnectLocalCompanion(connected: ConnectedCompanion): void {
  connected.runtime.session.dispose();
  connected.bridge.close();
}
