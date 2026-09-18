import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopGuardianSession } from "../../containment/auth/desktop-guardian-session.internal.js";
import type { SemanticGameProductionAuthority } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import { composeGameProfile } from "../../game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "../../game-browser/game-browser-state-provider.js";
import type { GameIntegrationProvider, GamePresentationProjection } from "../../integration-catalog.js";
import {
  createStardewProductionLifecycleCoordinator,
  type StardewProductionLifecycleCoordinator,
} from "../../stardew-production-lifecycle-coordinator.internal.js";
import { createPublishedWindowsStardewFolderPicker } from "../../windows-stardew-folder-picker/index.js";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
} from "./lifecycle/contained-game-runtime-platform.private.js";

/**
 * Game-owned browser presentation projection of one Stardew lifecycle owner:
 * the declared Stardew game surface, the Host-owned game-state read over that
 * owner's own readers, and the owner's lifecycle activation owner projected to
 * the composed binding sink. Generic composition consumes only this projection;
 * the coordinator object, private activation snapshots, and launch authority
 * stay in this module's closure.
 */
export function createStardewGamePresentationProjection(
  coordinator: StardewProductionLifecycleCoordinator,
): GamePresentationProjection {
  const gameProfile = composeGameProfile({
    profileId: "gamebuddy.game.preview",
    releaseTier: "game_preview",
    operationIds: [
      "game.state.read",
      "game.prerequisites.setup",
      "game.launch",
      "game.stop",
      "game.resume",
      "game.resume.cancel",
      "game.reopen",
      "game.disconnect",
      "game.create",
      "game.stardew.cabins.read",
      "game.stardew.cabins.confirm",
    ],
    navigationItemIds: ["game"],
  });
  const readGame = createGameBrowserStateProvider(
    gameProfile,
    coordinator.lifecycleReader,
    coordinator.attachmentReader,
    coordinator.launchReadinessReader,
    coordinator.actionAuthorityReader,
  ).readState;
  return Object.freeze({
    gameProfile,
    readGame,
    lifecycleActivationBindingSink: coordinator.activationOwner,
  });
}

/**
 * Stardew game integration provider. Registers into the generic integration
 * catalog so composition layers consume only the abstract provider contract and
 * the narrow lifecycle capability it returns; no game-specific coordinator type
 * crosses the generic facade. All Stardew-specific launch assembly (folder
 * picker, contained guardian runtime collaborator, coordinator) stays in this
 * module's private closure.
 */
export function createStardewGameIntegrationProvider(): GameIntegrationProvider {
  return Object.freeze({
    gameId: "stardew",
    async createLifecycleCoordinator(input: Readonly<{
      manifest: HostDeploymentManifest;
      game: SemanticGameProductionAuthority;
      session: DesktopGuardianSession;
    }>) {
      const artifactRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
      const folderPicker = await createPublishedWindowsStardewFolderPicker(artifactRoot);
      const runtimeCollaboratorFactory = createStardewPlayerHostRuntimeLaunchCollaboratorFactory(
        createDesktopGuardianGameRuntimePlatform(input.session),
      );
      const coordinator = createStardewProductionLifecycleCoordinator(
        input.manifest,
        folderPicker,
        input.game,
        runtimeCollaboratorFactory,
      );
      return Object.freeze({
        close: () => coordinator.close(),
        presentation: createStardewGamePresentationProjection(coordinator),
      });
    },
  });
}
