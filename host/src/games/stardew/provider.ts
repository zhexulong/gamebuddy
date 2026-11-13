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
  formatStardewBootstrapRegistrationReconcile,
  type StardewProductionLifecycleCoordinator,
} from "../../stardew-production-lifecycle-coordinator.internal.js";
import type { StardewPlayerHostRuntimeLaunchCollaborator } from "./lifecycle/stardew-private-bootstrap-composer.core.internal.js";

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

/**
 * Members of the lifecycle owner's candidate that this projection does not copy verbatim.
 *
 * `displayPath` is the one, and it is not read here: it becomes `hint` after redaction, so the player never receives
 * a filesystem path. Listed rather than skipped silently, because a guard below refuses to let any other member
 * disappear the same way.
 */
const CANDIDATE_MEMBERS_MAPPED_ELSEWHERE = new Set(["displayPath"]);

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
      location: candidate.location,
      status: candidate.status,
      // Whether this folder can load the companion Mod. Measured 2026-11-08: this line was missing, so
      // `installationModLoaderLabel` always received `undefined`, the panel's mod-loader chip could never render, and
      // the field the discovery provider goes to trouble to compute (`modLoaderFor`) reached nobody. The live run
      // showed it (`data-mod-loader` zero hits, candidate row reading only `《星露谷物语》（D: · steam） 通过 Steam 找到`).
      modLoader: candidate.modLoader,
    })),
    diagnostics: [...result.diagnostics],
  };
  // Population from the source, not a hand-written list: a member the owner publishes and this projection forgets is a
  // field that silently never reaches the player, which is the defect the line above was.
  const dropped = new Set<string>();
  for (const [index, candidate] of result.candidates.entries()) {
    const mirrored = projected.candidates[index];
    if (mirrored === undefined) continue;
    for (const member of Object.keys(candidate)) {
      if (CANDIDATE_MEMBERS_MAPPED_ELSEWHERE.has(member)) continue;
      if (!(member in mirrored)) dropped.add(member);
    }
  }
  if (dropped.size > 0) {
    throw new Error(`stardew_installation_discovery_projection_dropped:${[...dropped].sort().join(",")}`);
  }
  if (!GameBrowserValidatorsV1.GameDiscoveryReadResultV1Schema.Check(projected)) {
    throw new Error("stardew_installation_discovery_projection_invalid");
  }
  return Object.freeze(projected);
}

function projectDiscoveryMutationResult(
  result: Awaited<ReturnType<StardewProductionLifecycleCoordinator["activationOwner"]["confirmInstallation"]>>,
): GameDiscoveryMutationResultV1 {
  const projected = {
    apiVersion: 1 as const,
    status: result.status,
    ...(result.companionMod === undefined ? {} : { companionMod: result.companionMod }),
  };
  // Population from the source, not a hand-written list - the same guard as the read projection above, and for the
  // same measured reason: `companionMod` is published by the owner (`registerInstallationLocator` deploys the Mod as
  // the last step of registering) and this projection copied `status` alone, so a refused deployment and a successful
  // one left the Host as the same bytes.
  for (const [member, value] of Object.entries(result)) {
    if (value !== undefined && !(member in projected)) {
      throw new Error(`stardew_installation_discovery_mutation_projection_dropped:${member}`);
    }
  }
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
      "game.endgame",
      "game.create",
      "game.installation.discovery.read",
      "game.installation.discovery.confirm",
      "game.installation.discovery.retry",
      "game.installation.discovery.cancel",
      "game.installation.discovery.manual_picker",
      "game.stardew.cabins.read",
      "game.stardew.cabins.confirm",
      "game.stardew.settings.read",
      "game.stardew.settings.update",
    ],
    navigationItemIds: ["game"],
  });
  const readGame = createGameBrowserStateProvider(
    gameProfile,
    coordinator.lifecycleReader,
    coordinator.attachmentReader,
    coordinator.launchReadinessReader,
    coordinator.actionAuthorityReader,
    coordinator.installationReader,
    coordinator.worldBindingReader,
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
    async createLifecycleCoordinator(
      input: Readonly<{
        manifest: HostDeploymentManifest;
        game: SemanticGameProductionAuthority;
        folderPicker: InjectedStardewFolderPickerCapability;
        runtimeCollaborator: StardewPlayerHostRuntimeLaunchCollaborator;
      }>,
    ) {
      const coordinator = createStardewProductionLifecycleCoordinator(
        input.manifest,
        input.folderPicker,
        input.game,
        input.runtimeCollaborator,
      );
      // Host boot: a pointer left bound by an ordinary close or a crash is released
      // here, and only when the OS proves the attempt's Guardian-owned objects gone.
      console.error(
        formatStardewBootstrapRegistrationReconcile(await coordinator.reconcileHeldBootstrapRegistration()),
      );
      return Object.freeze({
        close: () => coordinator.close(),
        presentation: createStardewGamePresentationProjection(coordinator),
      });
    },
  });
}
