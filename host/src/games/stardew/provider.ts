import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DesktopGuardianSession } from "../../containment/auth/desktop-guardian-session.internal.js";
import type { SemanticGameProductionAuthority } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import type { GameIntegrationProvider } from "../../integration-catalog.js";
import { createStardewProductionLifecycleCoordinator } from "../../stardew-production-lifecycle-coordinator.internal.js";
import { createPublishedWindowsStardewFolderPicker } from "../../windows-stardew-folder-picker/index.js";
import {
  createDesktopGuardianGameRuntimePlatform,
  createStardewPlayerHostRuntimeLaunchCollaboratorFactory,
} from "./lifecycle/contained-game-runtime-platform.private.js";

/**
 * Stardew game integration provider. Registers into the generic integration
 * catalog so composition layers consume only the abstract provider contract
 * and the narrow lifecycle handle it returns; no game-specific coordinator
 * type crosses the generic facade. All Stardew-specific launch assembly
 * (folder picker, contained guardian runtime collaborator, coordinator) stays
 * in this module's private closure.
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
      return Object.freeze({ close: () => coordinator.close() });
    },
  });
}