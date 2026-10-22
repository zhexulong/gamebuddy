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
import type { IdentityProfile } from "./identity-profile.js";
import type { RunTrace } from "./run-trace.js";
import type { WorldBookBinding } from "./worldbook.js";

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
    /** Cross-surface BaseIdentityProfile plus reviewed persona, assembled by the Host; absent keeps the default. */
    initialProfile?: IdentityProfile;
    /** Host-owned reviewed WorldBook binding; absent keeps the default empty world book. */
    worldBook?: WorldBookBinding;
    /** This run's span recorder; absent traces nothing. */
    runTrace?: RunTrace;
    /**
     * Set by a composition whose action vocabulary is the plan builder's: the surface then mounts the plan tool's own
     * fixed tools instead of the adapter's per-action tools, whether or not the program surface could be mounted.
     */
    planActionSurface?: true;
  }>,
): Promise<RuntimeSession> {
  const actionExecutionOptions = Object.freeze({
    ...(attachment?.recoveryJournal === undefined ? {} : { recoveryJournal: attachment.recoveryJournal }),
    ...(attachment?.recoveryBinding === undefined ? {} : { recoveryBinding: attachment.recoveryBinding }),
    ...(attachment?.recoveryPort === undefined ? {} : { recoveryPort: attachment.recoveryPort }),
    ...(options.runTrace === undefined ? {} : { trace: options.runTrace }),
  });
  return createRuntimeWithFixedToolsCore(
    identity,
    root,
    integration,
    attachment?.modelConfig,
    undefined,
    undefined,
    attachment?.gameplaySubagentEnabled ?? false,
    options.initialProfile,
    gameSessionId,
    options.worldBook,
    "game",
    attachment?.disableMagicContextMemory === true
      ? Object.freeze({ loadExtension: false, memoryEnabled: false, historianEnabled: false })
      : undefined,
    undefined,
    gameOperationalGate,
    attachment?.hostBindingFactory ?? gameHostBindingFactory,
    actionExecutionOptions,
    options.fixedTools,
    options.resolvedPolicy,
    options.planActionSurface === true,
  );
}
