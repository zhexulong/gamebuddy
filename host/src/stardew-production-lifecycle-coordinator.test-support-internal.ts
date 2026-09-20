import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ConstructedUnmountedGameSemanticFacade } from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import {
  createStardewProductionLifecycleCoordinatorFromTestingComposition,
  containedAiClientLaunchDecision,
  containedPlayerHostLaunchDecision,
  containedRuntimeTeardownFromCollaborator,
  type StardewGameSessionCreationAuthority,
  type StardewLifecycleAiClientLaunch,
  type StardewLifecyclePlayerHostLaunch,
  type StardewProductionLifecycleCoordinator,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import { createStardewPrivateBootstrapCompositionForTesting } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-support-internal.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.test-support-internal.js";
import type { StopOwnedAiClientResult } from "./stardew-ai-client-process-owner.js";
import type { StopOwnedPlayerHostResult } from "./stardew-player-host-process-owner.js";
import type { StardewPrivateFarmhandBridgeConnection, StardewPlayerHostRuntimeLaunchCollaborator } from "./games/stardew/lifecycle/stardew-private-bootstrap-composer.core.js";
import type { WindowsReparseInspectorCapability } from "./windows-reparse-inspector/index.js";
import { createTestWindowsStardewFolderPicker } from "./windows-stardew-folder-picker/index.test-support.js";
import type { StardewFolderPickerResult } from "./windows-stardew-folder-picker/index.js";
import type { StardewInstallationDiscoveryProvider } from "./windows-stardew-installation-discovery/index.js";
import {
  createStardewWorldBindingResolver,
  type CreateWorldBindingSeam,
  type StardewWorldBindingResolver,
} from "./stardew-owned-farmhand-game-world-binding-resolver.internal.js";
import type { ProductionGameSessionWorldBinding } from "./continuity-semantic-store/continuity-semantic-production-store.js";

export type StardewLifecycleCoordinatorTestingOverrides = Readonly<{
  closeBroker?(underlying: () => void): void;
  stopAiClient?(underlying: () => StopOwnedAiClientResult): StopOwnedAiClientResult;
  stopPlayerHost?(underlying: () => StopOwnedPlayerHostResult): StopOwnedPlayerHostResult;
  createInstallationInspector?(): Promise<WindowsReparseInspectorCapability>;
  selectStardewFolder?(): Promise<StardewFolderPickerResult>;
  /**
   * Integration-private world binding resolver seam. Absent, the coordinator
   * resolves every session as missing (fail-closed, no resume activation).
   */
  worldBindingResolver?(input: Readonly<{ gameSessionId: string; integrationId: string }>): Promise<ProductionGameSessionWorldBinding | null>;
  /**
   * Slice-0 durable create surface. Absent, every admitted `game.create`
   * fails closed as unavailable before any durable write.
   */
  gameSessionCreationAuthority?: StardewGameSessionCreationAuthority;
  /**
   * Integration-private world creation seam. Absent, `game.create` fails
   * closed at phase 2 (the production Stardew implementation is a later
   * integration task; this override stands in for any fake second
   * integration implementing the same seam).
   */
  createWorldBinding?(
    input: Readonly<{ gameSessionId: string; integrationId: string; worldRequest: unknown }>,
  ): Promise<Readonly<{ bindingRef: string }>>;
  connectFarmhandGameRuntimeFacade?(
    connection: StardewPrivateFarmhandBridgeConnection,
    deadlineMs: number,
  ): Promise<ConstructedUnmountedGameSemanticFacade>;
  /**
   * When provided, the testing coordinator routes BOTH role launches through
   * the same per-owner contained runtime and this collaborator (the
   * deterministic stand-in for the composition-owned runtime), and wires
   * contain/close teardown through it. Absent, it keeps the direct-spawn Stage
   * C/D consumers as the behavioral reference.
   */
  runtimeLaunchContained?: StardewPlayerHostRuntimeLaunchCollaborator;
  /**
   * Lifecycle-owned clock for the contained Player Host decision. Supplying a
   * stale clock makes the RoleLaunchOperation deadline invalid before any
   * native/session call (the pre-claim fail-closed path); default is Date.now.
   */
  containedLaunchNowMs?: () => number;
  /** Same clock control for the contained AI-client launch decision. */
  containedAiLaunchNowMs?: () => number;
  /** Test-only discovery overlay; production composition never accepts this dependency. */
  installationDiscoveryOverlay?: StardewInstallationDiscoveryProvider;
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
  const playerHostLaunch: StardewLifecyclePlayerHostLaunch = overrides.runtimeLaunchContained === undefined
    ? (owner, installation) => internal.launchStagedPlayerHost(owner, installation)
    : (owner, installation) => internal.launchStagedPlayerHostContained(
        owner,
        installation,
        (launch) => containedPlayerHostLaunchDecision(
          overrides.runtimeLaunchContained!,
          owner,
          launch,
          overrides.containedLaunchNowMs,
        ),
      );
  const worldBindingResolver: StardewWorldBindingResolver = createStardewWorldBindingResolver(
    overrides.worldBindingResolver ?? (async () => null),
  );
  const createWorldBindingSeam: CreateWorldBindingSeam | undefined = overrides.createWorldBinding === undefined
    ? undefined
    : Object.freeze({ createWorldBinding: overrides.createWorldBinding });
  const aiClientLaunch: StardewLifecycleAiClientLaunch = overrides.runtimeLaunchContained === undefined
    ? (owner, installation) => internal.launchMaterializedAiClient(owner, installation)
    : (owner, installation) => internal.launchMaterializedAiClientContained(
        owner,
        installation,
        (launch) => containedAiClientLaunchDecision(
          overrides.runtimeLaunchContained!,
          owner,
          launch,
          overrides.containedAiLaunchNowMs,
        ),
      );
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
    overrides.createInstallationInspector ?? (() => Promise.reject(new Error("test_installation_inspector_unbound"))),
    overrides.connectFarmhandGameRuntimeFacade ?? (async () => Object.freeze({
      authority: "SEMANTIC" as const,
      runEnter: async () => { throw new Error("test_game_runtime_facade_enter_unbound"); },
      recoverDeadOwner: async () => undefined,
      close: async () => undefined,
    })),
    createTestWindowsStardewFolderPicker(() => {
      const process = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true,
      });
      queueMicrotask(async () => {
        try {
          const result = await (overrides.selectStardewFolder?.() ?? Promise.resolve({ status: "selected" as const, path: "C:\\Games\\Stardew Valley" }));
          process.stdout.end(`${JSON.stringify(result.status === "selected" ? { schemaVersion: 1, status: "selected", path: result.path } : { schemaVersion: 1, status: "cancelled" })}\n`);
          process.stderr.end();
          queueMicrotask(() => process.emit("close", 0, null));
        } catch (error) {
          process.stdout.end();
          process.stderr.end();
          process.emit("error", error);
        }
      });
      return process as unknown as ChildProcess;
    }),
    worldBindingResolver,
    playerHostLaunch,
    aiClientLaunch,
    overrides.gameSessionCreationAuthority,
    createWorldBindingSeam,
    overrides.runtimeLaunchContained === undefined ? undefined : containedRuntimeTeardownFromCollaborator(overrides.runtimeLaunchContained),
    overrides.installationDiscoveryOverlay,
  );
}
