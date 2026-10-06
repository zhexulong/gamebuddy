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
import { type ComposedTavernProfile, composeTavernProfile } from "../tavern/browser-contract/index.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import type { ChatEventStream } from "../tavern/chat-event-stream.js";
import { createChatManagementService } from "../tavern/chat-management/chat-management-service.js";
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
import { createTavernConnectionService } from "../tavern/connection-service.js";
import { createReferencePipelineStateFacade, type VoiceSurfaceReader } from "../tavern/reference-pipeline-state.js";
import { startReferencePipelineStaticShellComposition } from "../tavern/reference-pipeline-static-shell-composition.js";
import { createTavernManagementStateFacade } from "../tavern/tavern-management-state.js";
import { startTavernManagementStaticShellComposition } from "../tavern/tavern-management-static-shell-composition.js";
import { createWorldInfoBindingManagementService } from "../tavern/world-info-binding/world-info-binding-management-service.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import type { ChatVoiceSpeechPublisher } from "../voice.js";
import {
  createPublishedWindowsReparseInspector,
  type WindowsReparseInspectorCapability,
} from "../windows-reparse-inspector/index.js";

/**
 * Host-owned assembly input for the one composed reference-game browser
 * presentation. The composed surface declaration is not selected here or by
 * bootstrap: the owner serves the one reference Chat profile plus the game
 * profile of the supplied projection, over the exact mounted Chat lane and the
 * verified browser artifact of the owning Host generation.
 */
export type DesktopPresentationAdmissionInput = Readonly<{
  manifest: HostDeploymentManifest;
  /** Host generation root holding the browser artifact and native helpers. */
  hostArtifactRoot: string;
  bootstrapToken: string;
  /** The one mounted Chat event stream the state facade and the service share. */
  eventStream: ChatEventStream;
  lease: MountedChatRuntimeLease;
  /** Game-owned projection of the lifecycle owner this presentation serves. */
  presentation: GamePresentationProjection;
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
 * Host-owned assembly input for the Chat-only (Chat Core) and Tavern-management
 * presentation variants. These variants serve the Chat surface alone over the
 * exact mounted Chat lane; they never construct a Game coordinator or touch a
 * Game projection, and the mounted lease stays its own owner's.
 */
export type ChatOnlyPresentationAdmissionInput = Readonly<{
  manifest: HostDeploymentManifest;
  /** Host generation root holding the browser artifact and native helpers. */
  hostArtifactRoot: string;
  bootstrapToken: string;
  /** The one mounted Chat event stream the state facade and the service share. */
  eventStream: ChatEventStream;
  lease: MountedChatRuntimeLease;
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

export type TavernManagementPresentationAdmissionInput = ChatOnlyPresentationAdmissionInput;

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
 * Starts the Chat-only presentation admission (Chat Core surface) over the
 * exact supplied Chat lease and verified browser artifact, with the one
 * reference Chat profile declared here. A construction failure drains the Chat
 * pipeline service it created and never touches the Chat lease or the facade,
 * so those exact owners stay live for their own recovery.
 */
export async function startChatOnlyPresentationAdmission(
  input: ChatOnlyPresentationAdmissionInput,
): Promise<DesktopPresentationAdmission> {
  const tavernProfile = composeReferenceTavernProfile();
  const inspector = input.inspector ?? (await createPublishedWindowsReparseInspector(input.hostArtifactRoot));
  // The chat-only surface composes the same reference-pipeline lane as the
  // composed reference-game variant, without any game projection wiring.
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
  let server: Awaited<ReturnType<typeof startReferencePipelineStaticShellComposition>>;
  try {
    server = await startReferencePipelineStaticShellComposition({
      referenceStateFacade,
      pipelineService,
      eventStream: input.eventStream,
      profile: tavernProfile,
      bootstrapToken: input.bootstrapToken,
      inspector,
      // The immutable browser artifact destination of one Host generation.
      artifactRoot: resolve(input.hostArtifactRoot, "browser", "tavern", "v1"),
    });
  } catch (error) {
    // No listener exists yet; the Chat pipeline service is the only Chat-lane
    // admission owner this construction created, so drain it and preserve the
    // construction failure unchanged.
    try {
      await pipelineService.close();
    } catch {
      // Preserve the chat-only construction failure.
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
          await referenceStateFacade.close();
        }
      })()),
  });
}

/**
 * Starts the Tavern-management presentation admission over the exact supplied
 * Chat lease and verified browser artifact, with the one tavern_management
 * profile declared here. No Game coordinator or projection participates: the
 * durable managed World Info repository, binding service, state facade,
 * management service, and Memory service are all Chat-owned. A construction
 * failure drains every created service in reverse order and never touches the
 * Chat lease or the facade, so those exact owners stay live for their own
 * recovery.
 */
export async function startTavernManagementPresentationAdmission(
  input: TavernManagementPresentationAdmissionInput,
): Promise<DesktopPresentationAdmission> {
  const tavernProfile = composeTavernManagementProfile();
  const inspector = input.inspector ?? (await createPublishedWindowsReparseInspector(input.hostArtifactRoot));
  const createdServices: { close(): Promise<void> }[] = [];
  let server: Awaited<ReturnType<typeof startTavernManagementStaticShellComposition>>;
  try {
    // The real durable managed repository backs the lease-bound binding
    // service; no browser fixture or alternate resolver is ever injected.
    const worldInfoRepository = createWorldInfoManagementRepository(input.manifest.runtimeRoot);
    const worldInfoService = createWorldInfoBindingManagementService({
      manifest: input.manifest,
      lease: input.lease,
      profile: tavernProfile,
      repository: worldInfoRepository,
      // Pristine bindings settle immediately; message-bearing chats keep the
      // desired-state model and converge on the next turn's admission.
      settleAuthoredContext: () => settleMountedAuthoredContext(input.manifest, input.lease),
    });
    createdServices.push(worldInfoService);
    const managementStateFacade = await createTavernManagementStateFacade(
      input.manifest,
      input.lease,
      tavernProfile,
      worldInfoService,
    );
    createdServices.push(managementStateFacade);
    const managementService = createChatManagementService({
      manifest: input.manifest,
      lease: input.lease,
      profile: tavernProfile,
    });
    createdServices.push(managementService);
    const memoryService = createMemoryManagementService({
      manifest: input.manifest,
      lease: input.lease,
      profile: tavernProfile,
    });
    createdServices.push(memoryService);
    // The connection service owns the player's provider/model/credential
    // selection. It reports the durable turn state of the exact mounted Chat so
    // an activation cannot switch a running turn (design/28 §5.3).
    const connectionService = createTavernConnectionService({
      agentDir: resolveRuntimePaths(
        input.manifest.principal,
        input.manifest.runtimeRoot,
        input.lease.chatSurfaceSessionId,
      ).agentDir,
      readTurnState: async () => {
        const state = await managementStateFacade.read();
        const turn = state.turn;
        // Only a turn that is still in flight blocks activation; a terminal
        // ledger entry (completed/cancelled/failed) is a settled turn
        // (design/28 §5.3: "While a turn is active... returns dialogue_busy").
        const active =
          turn !== null && (turn.state === "queued" || turn.state === "running" || turn.state === "response_visible" || turn.state === "stopping");
        return { turnActive: active };
      },
    });
    createdServices.push(connectionService);
    // The one Host-owned Chat/Game model profile record (design/28 §2.3). It is
    // the same durable `settings/model-profiles.json` the Chat and Game runtime
    // construction reads at mount, so a profile saved here is the exact profile
    // the next runtime for that surface is built with.
    const modelProfileStore = new ModelProfileStore(
      resolve(input.manifest.runtimeRoot, "settings", "model-profiles.json"),
    );
    // The one Host-owned player preference record: the companion language the
    // runtimes read at mount and the cloud TTS consent/output, at the one
    // root-level path every settings surface reads and writes. Without this the
    // routes would fail closed ("A profile that advertises a route without the
    // exact service cannot serve it") and the player's choices would have
    // nowhere to live.
    const playerPreferenceStore = new PlayerPreferenceStore(
      playerPreferencePath(input.manifest.runtimeRoot),
    );
    // The Character / Persona / Scenario / Greeting library is the real
    // durable tavern artifact store (design/28 §2). Companion handles are
    // minted through the exact mounted lease projection, so the browser can
    // never decode a durable companion identifier; companion.create mints a
    // Host-owned namespace from the player-supplied display name alone.
    const runtimePaths = resolveRuntimePaths(
      input.manifest.principal,
      input.manifest.runtimeRoot,
      input.lease.chatSurfaceSessionId,
    );
    const tavernPaths = resolveTavernPaths(runtimePaths, input.manifest.principal);
    const artifactStore = new TavernArtifactStore(input.manifest.runtimeRoot);
    const personaService = createPersonaManagementService(artifactStore, tavernPaths.playerRoot);
    const scenarioService = createScenarioManagementService(artifactStore, tavernPaths.companionRoot);
    const greetingService = createGreetingManagementService(artifactStore, tavernPaths.companionRoot);
    // The library service owns one lazily opened thread connection; it is
    // opened only if a Chat-creating route ever runs and is closed with this
    // management owner's drain.
    const libraryThreads = createChatThreadStore(runtimePaths.runtimeCwd, identityKey(input.manifest.principal));
    createdServices.push({
      close: async () => {
        libraryThreads.close?.();
      },
    });
    const libraryBase = createTavernLibraryService(tavernPaths, artifactStore, libraryThreads, {
      async readExact() {
        return identityProfileMetadata(await readIdentityProfile(runtimePaths.identityProfilePath));
      },
    });
    const currentCompanionId = input.manifest.principal.companionId;
    const companionHandleFor = (companionId: string): string =>
      input.lease.browserProjection.projectCompanionHandle(companionId);
    // The mounted companion is ALWAYS the current library entry: the identity
    // profile the runtime provisioned at mount is its authoritative display
    // name, and its projected handle is the only handle the detail route will
    // ever resolve. Created companions join the library durably below.
    const mountedNamePromise = readIdentityProfile(runtimePaths.identityProfilePath)
      .then((profile) => profile.identity.name)
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
          // profile would leave the name undefined, but the runtime always
          // writes the profile at mount, so this is only a defense-in-depth
          // guard, never the normal path.
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
        // Only the exact mounted companion's handle resolves; any other
        // handle (foreign, forged, or a non-mounted library entry) is null
        // and reported 404 rather than projected as a different identity.
        if (handle !== companionHandleFor(currentCompanionId)) return null;
        const mountedName = await mountedNamePromise;
        if (mountedName === undefined) return null;
        // The mounted companion's canonical display name is the identity
        // profile the runtime provisioned at mount; the artifact-store
        // companion.json only exists for library-created companions.
        return Object.freeze({ name: mountedName });
      },
    });
    const newCompanionProvisioner = Object.freeze({
      async create(name: string) {
        // The provisioner mints a new Host-owned identity namespace; the
        // browser supplies a display name and receives the safe name back.
        const provision = await provisionDirectNewCompanion(
          input.manifest.runtimeRoot,
          input.manifest.principal.playerId,
          name,
        );
        return Object.freeze({ name: provision.companion.name });
      },
    });
    // Reviewed ST-card import pipeline: artifacts are persisted by the service
    // under the tavern import path; confirm re-reads the exact reviewed
    // candidate and provisions it (profile + reviewed world book) into a NEW
    // Host-owned namespace through the same library threads.
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
        input.manifest.runtimeRoot,
        input.manifest.principal.playerId,
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
    server = await startTavernManagementStaticShellComposition({
      managementStateFacade,
      managementService,
      memoryService,
      worldInfoService,
      playerPreferenceStore,
      connectionService,
      modelProfileStore,
      libraryService,
      companionDetailService,
      newCompanionProvisioner,
      personaService,
      scenarioService,
      greetingService,
      stCardImportService,
      stCardImportHistoryService,
      confirmStCardImport,
      ...(input.listVoiceOutputDevices === undefined
        ? {}
        : { listVoiceOutputDevices: input.listVoiceOutputDevices }),
      profile: tavernProfile,
      bootstrapToken: input.bootstrapToken,
      inspector,
      // The immutable browser artifact destination of one Host generation.
      artifactRoot: resolve(input.hostArtifactRoot, "browser", "tavern", "v1"),
    });
  } catch (error) {
    // No listener exists yet; drain the created Chat-owned services in reverse
    // creation order and preserve the construction failure unchanged. The
    // mounted lease and the facade are never touched.
    for (let index = createdServices.length - 1; index >= 0; index -= 1) {
      try {
        await createdServices[index]!.close();
      } catch {
        // Preserve the management construction failure.
      }
    }
    throw error;
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    launchUrl: server.launchUrl,
    // Closing the listener drains its delegated management, Memory, and World
    // Info services behind it; the mounted lease stays its own owner's.
    close: () => (closePromise ??= server.close()),
  });
}

/**
 * Starts the composed reference-game presentation admission over the exact
 * supplied Chat lease, game projection, and verified browser artifact. A
 * construction failure drains the Chat pipeline service it created and never
 * touches the Chat lease, the facade, or any Game authority, so those exact
 * owners stay live for their own recovery.
 */
export async function startDesktopPresentationAdmission(
  input: DesktopPresentationAdmissionInput,
): Promise<DesktopPresentationAdmission> {
  const tavernProfile = composeReferenceTavernProfile();
  const profile = composeReferenceGameBrowserProfile({
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
  let server: Awaited<ReturnType<typeof startComposedReferenceGameStaticShellComposition>>;
  try {
    server = await startComposedReferenceGameStaticShellComposition({
      profile,
      bootstrapToken: input.bootstrapToken,
      referenceStateFacade,
      pipelineService,
      eventStream: input.eventStream,
      readGame: input.presentation.readGame,
      lifecycleActivationBindingSink: input.presentation.lifecycleActivationBindingSink,
      inspector,
      // The immutable browser artifact destination of one Host generation.
      artifactRoot: resolve(input.hostArtifactRoot, "browser", "tavern", "v1"),
    });
  } catch (error) {
    // No listener and no Game-side effect exist yet; the Chat pipeline service is
    // the only admission owner this construction created, so drain it and
    // preserve the construction failure unchanged.
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
          await referenceStateFacade.close();
        }
      })()),
  });
}

/**
 * The one Chat surface the chat-only and composed reference-game browser roots
 * serve. The composed surface contract fixes this exact identity, so the
 * declaration lives here rather than in an operator-, bootstrap-, or
 * browser-selected input.
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
