import type { SemanticGameProductionAuthority } from "../../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../../deployment-manifest.js";
import {
  composeGameProfile,
  GameBrowserValidatorsV1,
  type GameDiscoveryConfirmCommandV1,
  type GameDiscoveryMutationResultV1,
  type GameDiscoveryReadResultV1,
} from "../../game-browser-contract/index.js";
import { createGameBrowserStateProvider } from "../../game-browser/game-browser-state-provider.js";
import type { GameIntegrationProvider, GamePresentationProjection } from "../../integration-catalog.js";
import {
  createStardewProductionLifecycleCoordinator,
  type StardewProductionLifecycleCoordinator,
} from "../../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewPlayerHostRuntimeLaunchCollaborator } from "./lifecycle/stardew-private-bootstrap-composer.core.js";

/**
 * Opaque composition-injected picker capability.
 *
 * The lifecycle passes it straight through to the coordinator, which is the
 * only consumer that resolves it through the picker module's private WeakMap.
 * Declaring the brand here keeps the game adapter free of the Windows picker
 * module (a raw platform path it must never import) while still typing the
 * value it relays.
 */
declare const stardewFolderPickerCapabilityBrand: unique symbol;
export type InjectedStardewFolderPickerCapability = Readonly<{
  readonly [stardewFolderPickerCapabilityBrand]: never;
}>;

/**
 * Game-owned browser presentation projection of one Stardew lifecycle owner:
 * the declared Stardew game surface, the Host-owned game-state read over that
 * owner's own readers, and the owner's lifecycle activation owner projected to
 * the composed binding sink. Generic composition consumes only this projection;
 * the coordinator object, private activation snapshots, and launch authority
 * stay in this module's closure.
 */
const REDACTED_DISCOVERY_HINT = "Detected installation (path hidden)" as const;

function projectDiscoveryReadResult(
  result: Awaited<ReturnType<StardewProductionLifecycleCoordinator["activationOwner"]["readInstallationDiscovery"]>>,
): GameDiscoveryReadResultV1 {
  const projected = {
    apiVersion: 1 as const,
    candidates: result.candidates.map((candidate) => ({
      candidateId: candidate.candidateId,
      source: candidate.source,
      label: candidate.label,
      hint: candidate.displayPath === REDACTED_DISCOVERY_HINT ? REDACTED_DISCOVERY_HINT : null,
      status: candidate.status,
    })),
    diagnostics: [...result.diagnostics],
  };
  if (!GameBrowserValidatorsV1.GameDiscoveryReadResultV1Schema.Check(projected)) {
    throw new Error("stardew_installation_discovery_projection_invalid");
  }
  return Object.freeze(projected);
}

function projectDiscoveryMutationResult(
  result: Awaited<ReturnType<StardewProductionLifecycleCoordinator["activationOwner"]["confirmInstallation"]>>,
): GameDiscoveryMutationResultV1 {
  const projected = { apiVersion: 1 as const, status: result.status };
  if (!GameBrowserValidatorsV1.GameDiscoveryMutationResultV1Schema.Check(projected)) {
    throw new Error("stardew_installation_discovery_mutation_projection_invalid");
  }
  return Object.freeze(projected);
}

function createStardewGameDiscoveryBinding(
  owner: StardewProductionLifecycleCoordinator["activationOwner"],
): NonNullable<GamePresentationProjection["lifecycleActivationBindingSink"]["gameDiscovery"]> {
  const read = owner.readInstallationDiscovery.bind(owner);
  const confirm = owner.confirmInstallation.bind(owner);
  const retry = owner.retryInstallationDiscovery.bind(owner);
  const cancel = owner.cancelInstallationSelection.bind(owner);
  const manualPicker = owner.openInstallationPicker.bind(owner);
  return Object.freeze({
    read: async (admission) => projectDiscoveryReadResult(await read(admission)),
    confirm: async (admission, command: GameDiscoveryConfirmCommandV1) =>
      projectDiscoveryMutationResult(await confirm(admission, command.candidateId)),
    retry: async (admission) => projectDiscoveryReadResult(await retry(admission)),
    cancel: async (admission) => projectDiscoveryMutationResult(await cancel(admission)),
    manualPicker: async (admission) => projectDiscoveryMutationResult(await manualPicker(admission)),
  });
}

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
      "game.installation.discovery.read",
      "game.installation.discovery.confirm",
      "game.installation.discovery.retry",
      "game.installation.discovery.cancel",
      "game.installation.discovery.manual_picker",
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
  const lifecycleActivationBindingSink = Object.freeze({
    ...coordinator.activationOwner,
    gameDiscovery: createStardewGameDiscoveryBinding(coordinator.activationOwner),
  });
  return Object.freeze({
    gameProfile,
    readGame,
    lifecycleActivationBindingSink,
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
      folderPicker: InjectedStardewFolderPickerCapability;
      runtimeCollaborator: StardewPlayerHostRuntimeLaunchCollaborator;
    }>) {
      const coordinator = createStardewProductionLifecycleCoordinator(
        input.manifest,
        input.folderPicker,
        input.game,
        input.runtimeCollaborator,
      );
      return Object.freeze({
        close: () => coordinator.close(),
        presentation: createStardewGamePresentationProjection(coordinator),
      });
    },
  });
}
