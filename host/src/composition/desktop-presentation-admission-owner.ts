import { resolve } from "node:path";

import { identityProfileMetadata, readIdentityProfile } from "../identity-profile.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { identityKey } from "../runtime.js";

import { composeReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { settleMountedAuthoredContext } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { GamePresentationProjection } from "../integration-catalog.js";
import { ModelProfileStore } from "../settings/model-profile-store.js";
import { PlayerPreferenceStore, playerPreferencePath } from "../settings/player-preference-store.js";
import { type ComposedTavernProfile, composeTavernProfile, type BrowserTurnV1 } from "../tavern/browser-contract/index.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import type { ChatEventStream } from "../tavern/chat-event-stream.js";
import { createChatManagementService } from "../tavern/chat-management/chat-management-service.js";
import type { ChatManagementService } from "../tavern/chat-management/chat-management-service.js";
import { createChatThreadStore } from "../tavern/chat-thread-store.js";
import { createGreetingManagementService } from "../tavern/greeting-management/greeting-management.js";
import { createTavernLibraryService } from "../tavern/library-service.js";
import { provisionDirectNewCompanion, provisionNewCompanion } from "../tavern/new-companion-service.js";
import { createPersonaManagementService } from "../tavern/persona-management/persona-management.js";
import { createScenarioManagementService } from "../tavern/scenario-management/scenario-management.js";
import { StCardImportService } from "../tavern/st-card-import-service.js";
import { createStCardImportHistoryService } from "../tavern/st-card-import-history.js";
import { resolveTavernPaths } from "../tavern/tavern-paths.js";
import { createChatPipelineService } from "../tavern/chat-pipeline-service.js";
import { startComposedReferenceGameStaticShellComposition } from "../tavern/composed-reference-game-static-shell-composition.js";
import { createMemoryManagementService } from "../tavern/memory-management/memory-management.js";
import type { MemoryManagementService } from "../tavern/memory-management/memory-management.js";
import { createTavernConnectionService } from "../tavern/connection-service.js";
import type { TavernManagementDialogueWebOptions } from "../tavern-management-dialogue-web.js";
import type { TavernManagementDelegatedOptions } from "../tavern-management-dialogue-web.delegated.js";
import { createReferencePipelineStateFacade, type VoiceSurfaceReader } from "../tavern/reference-pipeline-state.js";
import { createWorldInfoBindingManagementService } from "../tavern/world-info-binding/world-info-binding-management-service.js";
import type { WorldInfoBindingManagementService } from "../tavern/world-info-binding/world-info-binding-management-service.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import type { ChatVoiceSpeechPublisher } from "../voice.js";
import {
  createPublishedWindowsReparseInspector,
  type WindowsReparseInspectorCapability,
} from "../windows-reparse-inspector/index.js";

/**
 * Host-owned assembly input for the one browser presentation this product
 * ships. The surface declaration is not selected here or by bootstrap: the
 * owner serves the one reference Chat profile, the management domains' own
 * profile, and - when a Game projection is supplied - that projection's game
 * profile, over the exact mounted Chat lane and the verified browser artifact
 * of the owning Host generation.
 *
 * `presentation` is optional because this product has one frontend but more
 * than one presentation entry point: the composed reference-game surface
 * supplies a Game projection, while the Chat-owned entry points (Chat Core and
 * the Tavern-management surface) serve the same single app and construct no
 * Game authority at all.
 */
export type DesktopPresentationAdmissionInput = Readonly<{
  manifest: HostDeploymentManifest;
  /** Host generation root holding the browser artifact and native helpers. */
  hostArtifactRoot: string;
  bootstrapToken: string;
  /** The one mounted Chat event stream the state facade and the service share. */
  eventStream: ChatEventStream;
  lease: MountedChatRuntimeLease;
  /**
   * Game-owned projection of the lifecycle owner this presentation serves.
   * Absent => the one app's Game surface renders the honest `game: null`
   * projection and no Game route or lifecycle admission exists.
   */
  presentation?: GamePresentationProjection;
  /** Dev/QA artifact roots supply their own inspector; production uses the published helper. */
  inspector?: WindowsReparseInspectorCapability;
  /** Optional Voice surface reader: projects the additive v1 `voice` snapshot field. */
  voiceSurface?: VoiceSurfaceReader;
  /** Optional Host-owned streaming speech sink: reads the Chat delta aloud while the turn streams. */
  speechSink?: ChatVoiceSpeechPublisher;
  /**
   * Optional read-only Voice output endpoint enumeration (forwarded to the
   * Voice Gateway). Absent => the settings surface offers the Windows default
   * selection only, never a fabricated device list.
   */
  listVoiceOutputDevices?: () => Promise<readonly Readonly<{ id: string; name: string }>[]>;
}>;

/**
 * The Chat Core and Tavern-management presentation entry points serve this
 * same input: one frontend means one assembly, and the two names remain only
 * because the Host's surface selector still calls each of them.
 */
export type ChatOnlyPresentationAdmissionInput = DesktopPresentationAdmissionInput;
export type TavernManagementPresentationAdmissionInput = DesktopPresentationAdmissionInput;

/**
 * Composition-owned presentation admission child. Its one loopback listener and
 * the Chat admission work it carries drain before the mounted Chat lane and the
 * Game lifecycle owner close; the launch URL is the only product-visible fact
 * and is never projectable through the composition facade.
 */
export type DesktopPresentationAdmission = Readonly<{
  launchUrl: string;
  close(): Promise<void>;
}>;

/**
 * The Chat Core presentation entry point: the one browser app over the exact
 * supplied Chat lease and the verified browser artifact, with no Game
 * projection - so no Game route, lifecycle admission or coordinator exists for
 * this mount, and the app's Game surface renders the honest `game: null`
 * projection.
 */
export async function startChatOnlyPresentationAdmission(
  input: ChatOnlyPresentationAdmissionInput,
): Promise<DesktopPresentationAdmission> {
  return await startDesktopPresentationAdmission(input);
}

/**
 * The management domains the one app's Chats/Characters/Settings/Memory
 * surfaces read and write (design/104 §2, design/26 §4.2). There is one
 * assembly for them, over the same durable stores and the same lease-bound
 * services, so a panel and its surface are two views of one state rather than
 * two owners of it.
 *
 * `owned` lists every created service in creation order: an assembly that fails
 * to construct drains it in reverse order, and one that starts closes it once
 * its listener has drained.
 */
type TavernManagementDomains = Readonly<
  Required<
    Pick<
      TavernManagementDialogueWebOptions,
      | "libraryService"
      | "companionDetailService"
      | "newCompanionProvisioner"
      | "personaService"
      | "scenarioService"
      | "greetingService"
      | "stCardImportService"
      | "stCardImportHistoryService"
      | "confirmStCardImport"
    >
  > & {
    managementService: ChatManagementService;
    memoryService: MemoryManagementService;
    worldInfoService: WorldInfoBindingManagementService;
    modelProfileStore: ModelProfileStore;
    playerPreferenceStore: PlayerPreferenceStore;
  }
>;

/**
 * The real durable managed repository backs the lease-bound binding service; no
 * browser fixture and no alternate resolver is ever injected. Pristine bindings
 * settle immediately; message-bearing chats keep the desired-state model and
 * converge on the next turn's admission.
 */
function createTavernManagedWorldInfoService(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  profile: ComposedTavernProfile,
): WorldInfoBindingManagementService {
  return createWorldInfoBindingManagementService({
    manifest,
    lease,
    profile,
    repository: createWorldInfoManagementRepository(manifest.runtimeRoot),
    settleAuthoredContext: () => settleMountedAuthoredContext(manifest, lease),
  });
}

/**
 * The identity's own PI agent directory for the exact mounted Chat session: the
 * connection service owns the provider/model/credential selection of that one
 * runtime, never a shared one.
 */
function managementAgentDir(manifest: HostDeploymentManifest, lease: MountedChatRuntimeLease): string {
  return resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId).agentDir;
}

/**
 * The connection service's one activation rule: only a turn that is still in
 * flight blocks activation; a terminal ledger entry (completed / cancelled /
 * failed) is a settled turn (design/28 §5.3: "While a turn is active... returns
 * dialogue_busy").
 */
function mountedTurnActive(turn: BrowserTurnV1 | null): boolean {
  return (
    turn !== null &&
    (turn.state === "queued" ||
      turn.state === "running" ||
      turn.state === "response_visible" ||
      turn.state === "stopping")
  );
}

/**
 * The management domains over the exact mounted lease and the one management
 * profile: the durable Chat management, Memory, World Info, model-profile,
 * player-preference and card-import services, and the Character library whose
 * companion handles are minted through the mounted lease projection so the
 * browser can never decode a durable companion identifier. `worldInfoService`
 * is supplied because the binding service must exist before the domains that
 * share its profile do.
 */
function createTavernManagementDomains(
  manifest: HostDeploymentManifest,
  lease: MountedChatRuntimeLease,
  profile: ComposedTavernProfile,
  worldInfoService: WorldInfoBindingManagementService,
): Readonly<{ domains: TavernManagementDomains; owned: readonly { close(): Promise<void> }[] }> {
  const owned: { close(): Promise<void> }[] = [];
  const managementService = createChatManagementService({ manifest, lease, profile });
  owned.push(managementService);
  const memoryService = createMemoryManagementService({ manifest, lease, profile });
  owned.push(memoryService);
  // The one Host-owned Chat/Game model profile record (design/28 §2.3). It is
  // the same durable `settings/model-profiles.json` the Chat and Game runtime
  // construction reads at mount, so a profile saved here is the exact profile
  // the next runtime for that surface is built with.
  const modelProfileStore = new ModelProfileStore(
    resolve(manifest.runtimeRoot, "settings", "model-profiles.json"),
  );
  // The one Host-owned player preference record: the companion language the
  // runtimes read at mount and the cloud TTS consent/output, at the one
  // root-level path every settings surface reads and writes.
  const playerPreferenceStore = new PlayerPreferenceStore(playerPreferencePath(manifest.runtimeRoot));
  // The Character / Persona / Scenario / Greeting library is the real durable
  // tavern artifact store (design/28 §2).
  const runtimePaths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId);
  const tavernPaths = resolveTavernPaths(runtimePaths, manifest.principal);
  const artifactStore = new TavernArtifactStore(manifest.runtimeRoot);
  const personaService = createPersonaManagementService(artifactStore, tavernPaths.playerRoot);
  const scenarioService = createScenarioManagementService(artifactStore, tavernPaths.companionRoot);
  const greetingService = createGreetingManagementService(artifactStore, tavernPaths.companionRoot);
  // The library service owns one lazily opened thread connection; it is opened
  // only if a Chat-creating route ever runs and is closed with this owner's drain.
  const libraryThreads = createChatThreadStore(runtimePaths.runtimeCwd, identityKey(manifest.principal));
  owned.push({
    close: async () => {
      libraryThreads.close?.();
    },
  });
  const libraryBase = createTavernLibraryService(tavernPaths, artifactStore, libraryThreads, {
    async readExact() {
      return identityProfileMetadata(await readIdentityProfile(runtimePaths.identityProfilePath));
    },
  });
  const currentCompanionId = manifest.principal.companionId;
  const companionHandleFor = (companionId: string): string =>
    lease.browserProjection.projectCompanionHandle(companionId);
  // The mounted companion is ALWAYS the current library entry: the identity
  // profile the runtime provisioned at mount is its authoritative display name,
  // and its projected handle is the only handle the detail route will ever
  // resolve. Created companions join the library durably below.
  const mountedNamePromise = readIdentityProfile(runtimePaths.identityProfilePath)
    .then((identityProfile) => identityProfile.identity.name)
    .catch(() => undefined);
  const libraryService = Object.freeze({
    async listCompanions() {
      const [mountedName, companions] = await Promise.all([
        mountedNamePromise,
        libraryBase.listCompanions(),
      ]);
      return [
        // The unchanged mounted companion is always first with its projected
        // handle and current marker; a provisioning failure of the identity
        // profile would leave the name undefined, but the runtime always writes
        // the profile at mount, so this is only a defense-in-depth guard, never
        // the normal path.
        ...(mountedName === undefined
          ? []
          : [
              Object.freeze({
                handle: companionHandleFor(currentCompanionId),
                name: mountedName,
                isCurrent: true,
              }),
            ]),
        ...companions.map((companion: Readonly<{ companionId: string; name: string }>) =>
          Object.freeze({
            handle: companionHandleFor(companion.companionId),
            name: companion.name,
            isCurrent: companion.companionId === currentCompanionId,
          }),
        ),
      ];
    },
  });
  const companionDetailService = Object.freeze({
    async read(handle: string) {
      // Only the exact mounted companion's handle resolves; any other handle
      // (foreign, forged, or a non-mounted library entry) is null and reported
      // 404 rather than projected as a different identity.
      if (handle !== companionHandleFor(currentCompanionId)) return null;
      const mountedName = await mountedNamePromise;
      if (mountedName === undefined) return null;
      // The mounted companion's canonical display name is the identity profile
      // the runtime provisioned at mount; the artifact-store companion.json
      // only exists for library-created companions.
      return Object.freeze({ name: mountedName });
    },
  });
  const newCompanionProvisioner = Object.freeze({
    async create(name: string) {
      // The provisioner mints a new Host-owned identity namespace; the browser
      // supplies a display name and receives the safe name back.
      const provision = await provisionDirectNewCompanion(manifest.runtimeRoot, manifest.principal.playerId, name);
      return Object.freeze({ name: provision.companion.name });
    },
  });
  // Reviewed ST-card import pipeline: artifacts are persisted by the service
  // under the tavern import path; confirm re-reads the exact reviewed candidate
  // and provisions it (profile + reviewed world book) into a NEW Host-owned
  // namespace through the same library threads.
  const stCardImportService = new StCardImportService(artifactStore, tavernPaths);
  // Durable evidence for every confirmed import (design/28 Import/export row):
  // the player-readable loss report a confirmed card leaves behind. It is
  // written from the same artifacts the import already produced and is never
  // consulted by any keep/drop decision.
  const stCardImportHistoryService = createStCardImportHistoryService(artifactStore, tavernPaths.playerRoot);
  const confirmStCardImport = async (importId: string) => {
    const imported = await stCardImportService.read(importId);
    const review = await stCardImportService.confirmedReview(importId);
    const provision = await provisionNewCompanion(
      manifest.runtimeRoot,
      manifest.principal.playerId,
      imported.candidate.artifact,
      review,
      libraryThreads,
    );
    await stCardImportHistoryService.record({
      importId,
      occurredAtMs: Date.now(),
      cardName: imported.candidate.artifact.name,
      companionId: provision.companion.companionId,
      dispositions: imported.report.artifact.dispositions,
    });
    return Object.freeze({ name: provision.companion.name });
  };
  return Object.freeze({
    domains: Object.freeze({
      managementService,
      memoryService,
      worldInfoService,
      modelProfileStore,
      playerPreferenceStore,
      libraryService,
      companionDetailService,
      newCompanionProvisioner,
      personaService,
      scenarioService,
      greetingService,
      stCardImportService,
      stCardImportHistoryService,
      confirmStCardImport,
    }),
    owned: Object.freeze(owned),
  });
}

export async function startTavernManagementPresentationAdmission(
  input: TavernManagementPresentationAdmissionInput,
): Promise<DesktopPresentationAdmission> {
  return await startDesktopPresentationAdmission(input);
}

/**
 * The one presentation admission this product starts, over the exact supplied
 * Chat lease and the verified browser artifact. It declares the one reference
 * Chat profile and the management domains' own profile, and serves the single
 * browser app on one loopback listener; when a Game projection was supplied it
 * also composes that projection's game profile and lifecycle admission on top.
 * A construction failure drains every service it created in reverse order and
 * never touches the Chat lease, the facade, or any Game authority, so those
 * exact owners stay live for their own recovery.
 */
export async function startDesktopPresentationAdmission(
  input: DesktopPresentationAdmissionInput,
): Promise<DesktopPresentationAdmission> {
  const tavernProfile = composeReferenceTavernProfile();
  const profile = input.presentation === undefined
    ? composeReferenceGameBrowserProfile({ tavernProfile })
    : composeReferenceGameBrowserProfile({
        tavernProfile,
        gameProfile: input.presentation.gameProfile,
      });
  const inspector = input.inspector ?? (await createPublishedWindowsReparseInspector(input.hostArtifactRoot));
  const referenceStateFacade = await createReferencePipelineStateFacade(
    input.manifest,
    input.lease,
    tavernProfile,
    input.eventStream,
    input.voiceSurface,
  );
  const pipelineService = createChatPipelineService({
    manifest: input.manifest,
    lease: input.lease,
    profile: tavernProfile,
    eventStream: input.eventStream,
    ...(input.speechSink === undefined ? {} : { speechSink: input.speechSink }),
  });
  // The management domains the one app's Chats/Characters/Settings/Memory
  // surfaces read and write (design/104 §2, design/26 §4.2). They come from the
  // one management-domain assembly, over the same durable stores and
  // lease-bound services, so a panel and its surface are two views of one state
  // rather than two owners of it.
  //
  // They are built against the MANAGEMENT tavern profile, not the composed shell's
  // frozen reference profile: the composed browser contract pins that profile's
  // route list verbatim (it is what the browser validates), while these services
  // require the routes they own - chat.list, chat.rename, draft.save, draft.discard,
  // memory.read, world-info.read and their operations - to be declared. The shell
  // mounts them under the management profile's own delegated dispatcher on the same
  // loopback origin, so one frozen Chat contract and the management domains coexist
  // instead of one masquerading as the other.
  const managementProfile = composeTavernManagementProfile();
  const createdManagement: { close(): Promise<void> }[] = [];
  let management: Omit<TavernManagementDelegatedOptions, "capability">;
  try {
    const worldInfoService = createTavernManagedWorldInfoService(
      input.manifest,
      input.lease,
      managementProfile,
    );
    createdManagement.push(worldInfoService);
    const { domains, owned } = createTavernManagementDomains(
      input.manifest,
      input.lease,
      managementProfile,
      worldInfoService,
    );
    createdManagement.push(...owned);
    // The connection service owns the player's provider/model/credential
    // selection for the exact mounted Chat runtime. Its turn-state reader is this
    // admission's own reference facade: the same durable turn the composed broker
    // already projects, so an activation cannot switch a running turn (design/28
    // §5.3).
    const connectionService = createTavernConnectionService({
      agentDir: managementAgentDir(input.manifest, input.lease),
      readTurnState: async () => ({
        turnActive: mountedTurnActive((await referenceStateFacade.read()).turn),
      }),
    });
    createdManagement.push(connectionService);
    management = Object.freeze({
      profile: managementProfile,
      ...domains,
      connectionService,
      ...(input.listVoiceOutputDevices === undefined
        ? {}
        : { listVoiceOutputDevices: input.listVoiceOutputDevices }),
    });
  } catch (error) {
    for (let index = createdManagement.length - 1; index >= 0; index -= 1) {
      try {
        await createdManagement[index]!.close();
      } catch {
        // Preserve the management construction failure.
      }
    }
    try {
      await pipelineService.close();
    } catch {
      // Preserve the management construction failure.
    }
    throw error;
  }
  let server: Awaited<ReturnType<typeof startComposedReferenceGameStaticShellComposition>>;
  try {
    server = await startComposedReferenceGameStaticShellComposition({
      profile,
      bootstrapToken: input.bootstrapToken,
      referenceStateFacade,
      pipelineService,
      eventStream: input.eventStream,
      // The Game projection's own routes and lifecycle admission exist exactly
      // when a projection was supplied: the Chat-owned entry points construct no
      // Game authority, so the one app's Game surface reads the honest
      // `game: null` projection and offers no mutation control.
      ...(input.presentation === undefined
        ? {}
        : {
            readGame: input.presentation.readGame,
            lifecycleActivationBindingSink: input.presentation.lifecycleActivationBindingSink,
          }),
      inspector,
      // The immutable browser artifact destination of one Host generation.
      artifactRoot: resolve(input.hostArtifactRoot, "browser", "tavern", "v1"),
      // The management domains' services: the composed shell serves the Chats,
      // drafts, Memory, World Info, Settings, Characters, Persona/Scenario/
      // Greeting and card-import routes under /api/tavern/v1/ from them.
      ...(management === undefined ? {} : { management }),
    });
  } catch (error) {
    // No listener and no Game-side effect exist yet; the Chat pipeline service and
    // the management services this admission created are the only owners it holds,
    // so drain them and preserve the construction failure unchanged.
    for (let index = createdManagement.length - 1; index >= 0; index -= 1) {
      try {
        await createdManagement[index]!.close();
      } catch {
        // Preserve the presentation construction failure.
      }
    }
    try {
      await pipelineService.close();
    } catch {
      // Preserve the presentation construction failure.
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    launchUrl: server.launchUrl,
    // Closing the listener drains its delegated Chat admission and the Chat
    // pipeline service behind it; the mounted lease stays its own owner's. The
    // state facade holds its own store, so it is released here too.
    close: () =>
      (closePromise ??= (async () => {
        try {
          await server.close();
        } finally {
          // Listener first, then the management domains it served, then the state
          // facade they projected: creation order reversed.
          for (let index = createdManagement.length - 1; index >= 0; index -= 1) {
            try {
              await createdManagement[index]!.close();
            } catch {
              // Keep draining the rest; one close failure must not leak the others.
            }
          }
          await referenceStateFacade.close();
        }
      })()),
  });
}

/**
 * The one Chat surface the single browser presentation serves. The composed
 * surface contract fixes this exact identity, so the declaration lives here
 * rather than in an operator-, bootstrap-, or browser-selected input.
 */
function composeReferenceTavernProfile(): ComposedTavernProfile {
  return composeTavernProfile({
    profileId: "gamebuddy.chat-core.reference-pipeline",
    releaseTier: "chat_core",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "chat.submit",
      "chat.cancel",
      "chat.submission_status",
      "events",
    ],
    operationIds: ["chat.submit", "chat.cancel"],
    navigationItemIds: ["chat"],
  });
}

/**
 * The one Tavern-management surface the management browser root serves. The
 * composed surface contract fixes this exact identity, so the declaration
 * lives here rather than in an operator-, bootstrap-, or browser-selected
 * input.
 */
function composeTavernManagementProfile(): ComposedTavernProfile {
  return composeTavernProfile({
    profileId: "gamebuddy.tavern-management.chat-list-title",
    releaseTier: "tavern_management",
    routeIds: [
      "bootstrap",
      "state.read",
      "draft.read",
      "draft.save",
      "draft.discard",
      "chat.list",
      "chat.rename",
      "memory.read",
      "memory.mutate",
      "world-info.read",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.voice.devices",
      "settings.language.read",
      "settings.language.update",
      "settings.connection.read",
      "settings.connection.create",
      "settings.connection.test",
      "settings.connection.activate",
      "settings.connection.model",
      "settings.connection.remove",
      "settings.profiles.read",
      "settings.profiles.update",
      "companion.list",
      "companion.detail",
      "companion.create",
      "persona.read",
      "persona.update",
      "scenario.read",
      "scenario.update",
      "greeting.read",
      "greeting.update",
      "chat.archive",
      "chat.restore",
      "chat.trash",
      "character.import.stage",
      "character.import.read",
      "character.import.review",
      "character.import.confirm",
      "character.import.history",
    ],
    operationIds: [
      "draft.save",
      "draft.discard",
      "chat.rename",
      "memory.mutate",
      "world-info.bind",
      "settings.voice.read",
      "settings.voice.consent",
      "settings.voice.devices",
      "settings.language.read",
      "settings.language.update",
      "settings.connection.read",
      "settings.connection.create",
      "settings.connection.test",
      "settings.connection.activate",
      "settings.connection.model",
      "settings.connection.remove",
      "settings.profiles.read",
      "settings.profiles.update",
      "companion.list",
      "companion.detail",
      "companion.create",
      "persona.read",
      "persona.update",
      "scenario.read",
      "scenario.update",
      "greeting.read",
      "greeting.update",
      "chat.archive",
      "chat.restore",
      "chat.trash",
      "character.import.stage",
      "character.import.read",
      "character.import.review",
      "character.import.confirm",
      "character.import.history",
    ],
    // A mounted Memory route is paired with the Memory navigation item; the
    // item only projects `available` after the exact-bound read succeeds. The
    // characters item is paired with the companion library routes.
    navigationItemIds: ["chat", "memory", "characters"],
  });
}
