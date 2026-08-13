import { type KnowledgeBundle } from "./knowledge.js";
import { type LocalStardewBridgeClient } from "./local-stardew-bridge.js";
import {
  connectIntegrationCompanion,
  disconnectIntegrationCompanion,
  type ConnectedIntegrationCompanion,
} from "./integration-bootstrap.js";
import { STARDEW_INTEGRATION_LAUNCHER } from "./stardew-integration-launcher.js";
import { type WorldBookBinding } from "./worldbook.js";
import { type GameCompanionIdentity, type CompanionModelConfig } from "./runtime.js";
import { type IntegrationActionPolicy } from "./integration-module.js";
import { type CompanionTextPort, type PresentationProfile } from "./presentation.js";
import { type VoiceSpeechPort } from "./voice.js";
import type { ContinuitySurfaceCoordinator } from "./continuity-surface-coordinator/continuity-surface-coordinator.js";
export { recoverStoppedGameSurface } from "./game-surface-recovery.js";

/**
 * Stardew compatibility bootstrap. New integrations use
 * connectIntegrationCompanion with their own receipt-backed launcher; this
 * wrapper preserves the existing operator-facing local configuration shape.
 */
export type LocalStardewConnection = Readonly<{
  identity: GameCompanionIdentity;
  pipeName: string;
  bridgeToken: string;
  runtimeRoot?: string;
  modelConfig?: CompanionModelConfig;
  knowledge?: KnowledgeBundle;
  gameVersion?: string;
  actionPolicy?: IntegrationActionPolicy;
  gameplaySubagent?: boolean;
  presentationProfile?: PresentationProfile;
  textPort?: CompanionTextPort;
  speechPort?: VoiceSpeechPort;
  continuityCoordinator?: ContinuitySurfaceCoordinator;
  surfaceSessionId?: string;
  worldBook?: WorldBookBinding;
}>;

export type ConnectedCompanion = ConnectedIntegrationCompanion &
  Readonly<{
    /** Compatibility alias; generic callers use launch.connection instead. */
    bridge: LocalStardewBridgeClient;
  }>;

export async function connectLocalCompanion(connection: LocalStardewConnection): Promise<ConnectedCompanion> {
  const connected = await connectIntegrationCompanion({
    identity: connection.identity,
    launcher: STARDEW_INTEGRATION_LAUNCHER,
    launcherConfig: {
      pipeName: connection.pipeName,
      bridgeToken: connection.bridgeToken,
      ...(connection.knowledge === undefined ? {} : { knowledge: connection.knowledge }),
      ...(connection.gameVersion === undefined ? {} : { gameVersion: connection.gameVersion }),
    },
    runtimeRoot: connection.runtimeRoot,
    modelConfig: connection.modelConfig,
    actionPolicy: connection.actionPolicy,
    gameplaySubagent: connection.gameplaySubagent,
    presentationProfile: connection.presentationProfile,
    textPort: connection.textPort,
    speechPort: connection.speechPort,
    continuityCoordinator: connection.continuityCoordinator,
    surfaceSessionId: connection.surfaceSessionId,
    worldBook: connection.worldBook,
  });
  return Object.freeze({ ...connected, bridge: connected.launch.connection as LocalStardewBridgeClient });
}

export const disconnectLocalCompanion = disconnectIntegrationCompanion;
