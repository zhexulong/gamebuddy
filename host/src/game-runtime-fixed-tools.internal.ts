import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createRuntimeWithFixedToolsCore,
  type GameCompanionIdentity,
  type GameCompanionRuntimeAttachment,
  type GameHostBindingFactory,
  type GameOperationalGateConfig,
  type RuntimeSession,
} from "./runtime-core.internal.js";
import type { IntegrationActionPolicy } from "./game-integration-adapter.js";
import type { GameConnection } from "./game-connection.js";

/** Construction-only fixed Pi tools. This module is not exported by any barrel. */
export async function createMaterializedGameCompanionRuntime(
  identity: GameCompanionIdentity,
  root: string,
  integration: GameConnection,
  gameSessionId: string,
  gameOperationalGate: GameOperationalGateConfig | undefined,
  gameHostBindingFactory: GameHostBindingFactory | undefined,
  attachment: GameCompanionRuntimeAttachment | undefined,
  options: Readonly<{
    fixedTools: readonly ToolDefinition[];
    resolvedPolicy: IntegrationActionPolicy;
  }>,
): Promise<RuntimeSession> {
  return createRuntimeWithFixedToolsCore(
    identity, root, integration, attachment?.modelConfig, undefined, undefined,
    attachment?.gameplaySubagentEnabled ?? false, undefined, gameSessionId,
    undefined, "game", attachment?.disableMagicContextMemory === true
      ? Object.freeze({ loadExtension: false, memoryEnabled: false, historianEnabled: false })
      : undefined,
    undefined, undefined, gameOperationalGate,
    attachment?.hostBindingFactory ?? gameHostBindingFactory,
    attachment?.recoveryJournal === undefined ? {} : Object.freeze({
      recoveryJournal: attachment.recoveryJournal,
      ...(attachment.recoveryBinding === undefined ? {} : { recoveryBinding: attachment.recoveryBinding }),
    }),
    options.fixedTools,
    options.resolvedPolicy,
  );
}
