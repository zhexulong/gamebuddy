import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ConstructedUnmountedGameSemanticFacade } from "./continuity-semantic-deployment-composition/continuity-semantic-game-facade.internal.js";
import type { HostDeploymentManifest } from "./deployment-manifest.js";
import {
  createStardewProductionLifecycleCoordinatorFromTestingComposition,
  type StardewProductionLifecycleCoordinator,
} from "./stardew-production-lifecycle-coordinator.internal.js";
import { createStardewPrivateBootstrapCompositionForTesting } from "./stardew-private-bootstrap-composer.test-support-internal.js";
import type { StardewPrivateBootstrapCoreDependencies } from "./stardew-private-bootstrap-composer.test-support-internal.js";
import type { StopOwnedAiClientResult } from "./stardew-ai-client-process-owner.js";
import type { StopOwnedPlayerHostResult } from "./stardew-player-host-process-owner.js";
import type { StardewPrivateFarmhandBridgeConnection } from "./stardew-private-bootstrap-composer.core.js";
import type { WindowsReparseInspectorCapability } from "./windows-reparse-inspector/index.js";
import { createTestWindowsStardewFolderPicker } from "./windows-stardew-folder-picker/index.test-support.js";
import type { StardewFolderPickerResult } from "./windows-stardew-folder-picker/index.js";

export type StardewLifecycleCoordinatorTestingOverrides = Readonly<{
  closeBroker?(underlying: () => void): void;
  stopAiClient?(underlying: () => StopOwnedAiClientResult): StopOwnedAiClientResult;
  stopPlayerHost?(underlying: () => StopOwnedPlayerHostResult): StopOwnedPlayerHostResult;
  createInstallationInspector?(): Promise<WindowsReparseInspectorCapability>;
  selectStardewFolder?(): Promise<StardewFolderPickerResult>;
  connectFarmhandGameRuntimeFacade?(
    connection: StardewPrivateFarmhandBridgeConnection,
    deadlineMs: number,
  ): Promise<ConstructedUnmountedGameSemanticFacade>;
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
  );
}
