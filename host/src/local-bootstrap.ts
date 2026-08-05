import { createCompanionRuntime, identityKey, resolveRuntimePaths, type GameCompanionIdentity, type CompanionModelConfig, type RuntimeSession } from "./runtime.js";
import { selectContinuitySession } from "./continuity.js";
import { type WorldBookBinding } from "./worldbook.js";
import { CompanionLoop } from "./companion-loop.js";
import { CompanionHostService } from "./host-service.js";
import { LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import { type KnowledgeBundle } from "./knowledge.js";
import { type CompanionTextPort, type PresentationProfile, type PresentationRuntime } from "./presentation.js";
import { type VoiceSpeechPort } from "./voice.js";

export type LocalStardewConnection = Readonly<{
  identity: GameCompanionIdentity;
  pipeName: string;
  bridgeToken: string;
  runtimeRoot?: string;
  /** Omit this for offline/replay mode; explicit config selects the real Agent model. */
  modelConfig?: CompanionModelConfig;
  /** Optional Host-owned, version-bound gameplay guidance. */
  knowledge?: KnowledgeBundle;
  /** Target Stardew/game version for the mounted knowledge bundle. */
  gameVersion?: string;
  /** Optional player deny policy; omitted means the Mod's filtered capability surface is authoritative. */
  actionPolicy?: import("./integration-module.js").IntegrationActionPolicy;
  gameplaySubagent?: boolean;
  presentationProfile?: PresentationProfile;
  textPort?: CompanionTextPort;
  speechPort?: VoiceSpeechPort;
  /** Host-selected explicit game surface session, never supplied by the game bridge. */
  surfaceSessionId?: string;
  /** Host-owned reviewed background; never supplied by the bridge. */
  worldBook?: WorldBookBinding;
}>;

export type ConnectedCompanion = Readonly<{
  bridge: LocalStardewBridgeClient;
  runtime: RuntimeSession;
  loop: CompanionLoop;
  host: CompanionHostService;
}>;

/**
 * Establish the Phase 2 local IPC session before creating the Pi runtime.
 * An initial authoritative observation is mandatory: the Host never starts an
 * Agent turn on a mere transport connection or a model-supplied world state.
 */
export async function connectLocalCompanion(connection: LocalStardewConnection): Promise<ConnectedCompanion> {
  // Connecting this surface is the explicit product action that enters Game.
  // No bridge callback or resource threshold may create/select a surface.
  const surfaceSessionId = connection.identity.continuityId === undefined
    ? connection.surfaceSessionId
    : (await selectContinuitySession(resolveRuntimePaths(connection.identity, connection.runtimeRoot), connection.identity, {
      surface: "game",
      ...(connection.surfaceSessionId === undefined ? {} : { sessionId: connection.surfaceSessionId }),
      world: { integrationId: "stardew", saveId: connection.identity.saveId, worldId: connection.identity.worldId },
    })).session.sessionId;
  const scope = {
    integrationId: "stardew",
    saveId: connection.identity.saveId,
    worldId: connection.identity.worldId,
    playerId: connection.identity.playerId,
    companionId: connection.identity.companionId,
  } as const;
  const bridge = await LocalStardewBridgeClient.connect(scope, connection.pipeName, connection.bridgeToken, connection.knowledge, connection.gameVersion);
  try {
    const initialSnapshot = await bridge.observe();
    const presentation = connection.presentationProfile === undefined ? undefined : {
      profile: connection.presentationProfile,
      sessionId: identityKey(connection.identity),
      textPort: connection.textPort,
      speechPort: connection.speechPort,
    } satisfies PresentationRuntime;
    const runtime = await createCompanionRuntime(connection.identity, connection.runtimeRoot, bridge, connection.modelConfig, connection.actionPolicy, presentation, connection.gameplaySubagent === true, undefined, surfaceSessionId, connection.worldBook, "game");
    const loop = new CompanionLoop(runtime.session);
    const host = new CompanionHostService(loop, bridge, (reasonCode) => runtime.gameplaySubagent?.cancel(`bridge_${reasonCode}`));
    // The public bootstrap contract always supplies its mandatory initial
    // authoritative observation to the same normal turn path. Consumers must
    // not need CLI-only duplicate plumbing to get Live World context.
    host.acceptInitialSnapshot({
      protocolVersion: 1, messageId: "bootstrap_snapshot", correlationId: "bootstrap_snapshot", timestampMs: Date.now(), scope,
      type: "snapshot", payload: initialSnapshot,
    });
    return { bridge, runtime, loop, host };
  } catch (error) {
    bridge.close();
    throw error;
  }
}

/** Dispose in reverse order so no Agent can see a bridge during teardown. */
export function disconnectLocalCompanion(connected: ConnectedCompanion): void {
  connected.host.close();
  connected.runtime.gameplaySubagent?.dispose();
  connected.runtime.session.dispose();
  connected.bridge.close();
}
