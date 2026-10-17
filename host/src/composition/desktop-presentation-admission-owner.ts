import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

import { identityProfileMetadata, readIdentityProfile } from "../identity-profile.js";
import { projectCompanionVoice, updateMountedCompanionVoice } from "../tavern/companion-voice-service.js";
import { readCompanionWorldBook } from "../tavern/companion-world-book-service.js";
import { resolveRuntimePaths } from "../runtime-identity.js";
import { identityKey } from "../runtime.js";

import { mergeMountedCompanionList } from "./companion-library-list.js";

import { composeReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import { settleMountedAuthoredContext } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { GamePresentationProjection } from "../integration-catalog.js";
import { ModelProfileStore } from "../settings/model-profile-store.js";
import {
  PlayerPreferenceStore,
  playerPreferencePath,
  resolveCompanionLocale,
} from "../settings/player-preference-store.js";
import {
  type ComposedTavernProfile,
  composeReferenceTavernProfile,
  composeTavernProfile,
} from "../tavern/browser-contract/index.js";
import {
  type ChatCreateResultV1,
  type ChatSelectResultV1,
  type CompanionProfileV1,
  type CompanionWorldBookV1,
  type CreateChatCommandV1,
  type SelectChatCommandV1,
  TAVERN_BROWSER_API_VERSION,
  chatListPreviewText,
} from "../tavern/browser-contract/index.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import {
  COMPANION_PROFILE_NAME_MAX_LENGTH,
  COMPANION_PROFILE_TEXT_MAX_LENGTH,
  COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH,
} from "../tavern/browser-contract/index.js";
import { type MacroTable, macroTable, renderMacros } from "../tavern/macro-engine.js";
import type { ChatEventStream } from "../tavern/chat-event-stream.js";
import { createChatManagementService } from "../tavern/chat-management/chat-management-service.js";
import type { ChatManagementService } from "../tavern/chat-management/chat-management-service.js";
import { createChatThreadStore } from "../tavern/chat-thread-store.js";
import { createGreetingManagementService } from "../tavern/greeting-management/greeting-management.js";
import { createTavernLibraryService, isTavernArtifactUnreadable } from "../tavern/library-service.js";
import { provisionDirectNewCompanion, provisionNewCompanion } from "../tavern/new-companion-service.js";
import { createPersonaManagementService } from "../tavern/persona-management/persona-management.js";
import {
  createScenarioManagementService,
  withScenarioSurfaceMacros,
} from "../tavern/scenario-management/scenario-management.js";
import { StCardImportService } from "../tavern/st-card-import-service.js";
import { createStCardImportHistoryService } from "../tavern/st-card-import-history.js";
import { resolveTavernPaths } from "../tavern/tavern-paths.js";
import { createChatPipelineService } from "../tavern/chat-pipeline-service.js";
import type { ChatPipelineService } from "../tavern/chat-pipeline-service.js";
import { startComposedReferenceGameStaticShellComposition } from "../tavern/composed-reference-game-static-shell-composition.js";
import { createMemoryManagementService } from "../tavern/memory-management/memory-management.js";
import type { MemoryManagementService } from "../tavern/memory-management/memory-management.js";
import { createTavernConnectionService } from "../tavern/connection-service.js";
import type { TavernManagementDialogueWebOptions } from "../tavern-management-dialogue-web.js";
import type { TavernManagementDelegatedOptions } from "../tavern-management-dialogue-web.delegated.js";
import {
  createReferencePipelineStateFacade,
  type ReferencePipelineStateFacade,
  type VoiceSurfaceReader,
} from "../tavern/reference-pipeline-state.js";
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
  /**
   * The shared semantic authority's Chat selection capability (ADR 0009 / ADR-0010). When present, the
   * management domains mount `chat.select`: choosing another Chat switches the mounted conversation
   * inside the same process, aborting a still-generating turn through the same cancel path an explicit
   * browser Stop uses, so the switch always lands. Absent means the route is not mounted and the Chats
   * surface offers no selection control.
   */
  chatSelection?: Readonly<{
    requestChatSelection(
      input: Readonly<{
        kind: "select";
        selectionGeneration: number;
        chatThreadId: string;
        chatSurfaceSessionId: string;
      }>,
    ): Promise<Readonly<{ status: string }>>;
    /** Mints (or returns) the capability for the currently selected Chat. */
    startMountedChatRuntime(): Promise<MountedChatRuntimeLease>;
  }>;
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
      | "companionVoiceService"
      | "newCompanionProvisioner"
      | "newChatProvisioner"
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
    /** Present only when the shared semantic authority supplied the ADR 0009 selection capability. */
    chatSelectProvisioner?: TavernManagementDialogueWebOptions["chatSelectProvisioner"];
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
  chatSelection: DesktopPresentationAdmissionInput["chatSelection"],
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
  const modelProfileStore = new ModelProfileStore(resolve(manifest.runtimeRoot, "settings", "model-profiles.json"));
  // The one Host-owned player preference record: the companion language the
  // runtimes read at mount and the cloud TTS consent/output, at the one
  // root-level path every settings surface reads and writes.
  const playerPreferenceStore = new PlayerPreferenceStore(playerPreferencePath(manifest.runtimeRoot));
  // The Character / Persona / Scenario / Greeting library is the real durable
  // tavern artifact store (design/28 §2).
  const runtimePaths = resolveRuntimePaths(manifest.principal, manifest.runtimeRoot, lease.chatSurfaceSessionId);
  const tavernPaths = resolveTavernPaths(runtimePaths, manifest.principal);
  const artifactStore = new TavernArtifactStore(manifest.runtimeRoot);
  // The identity profile the runtime provisioned at mount is the mounted
  // companion's authoritative display name. It is read once here and reused by
  // the companion detail projection, the library list, and the macro table every
  // authored-text surface renders through.
  const mountedNamePromise = readIdentityProfile(runtimePaths.identityProfilePath)
    .then((identityProfile) => identityProfile.identity.name)
    .catch(() => undefined);
  const mountedMacros = async (): Promise<MacroTable> =>
    macroTable({
      char: (await mountedNamePromise) ?? "",
      locale: await resolveCompanionLocale(manifest.runtimeRoot),
    });
  const personaService = createPersonaManagementService(artifactStore, tavernPaths.playerRoot);
  // The scenario projection is the one surface a card's raw `{{user}}`/`{{char}}`
  // macros used to leak through: the durable record keeps them (they are the
  // authored content), so the browser read renders them through the run's macro
  // table with the companion's real name and the player's locale reference.
  const scenarioService = withScenarioSurfaceMacros(
    createScenarioManagementService(artifactStore, tavernPaths.companionRoot),
    mountedMacros,
  );
  const greetingService = createGreetingManagementService(artifactStore, tavernPaths.companionRoot);
  // The library service owns one lazily opened thread connection; it is opened
  // only if a Chat-creating route ever runs and is closed with this owner's drain.
  const libraryThreads = createChatThreadStore(manifest.runtimeRoot, identityKey(manifest.principal));
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
  /**
   * The roster companion one opaque handle names.
   *
   * The handle is a per-mount HMAC of the durable companion id, so it is not
   * invertible. The reverse map exists only by enumerating the very records the
   * roster was built from and comparing their handles through the SAME projection,
   * which is what makes it total over the roster by construction and impossible
   * for browser input to use to name a durable identity the roster never showed.
   * The mounted companion is spliced into the roster even when her own library
   * record is unreadable (`mergeMountedCompanionList`), so her handle is matched
   * explicitly too.
   */
  const companionForHandle = async (
    handle: string,
  ): Promise<Readonly<{ companionId: string; continuityId: string; name: string | null }> | null> => {
    if (handle === companionHandleFor(currentCompanionId)) {
      return Object.freeze({
        companionId: currentCompanionId,
        continuityId: manifest.principal.continuityId,
        name: (await mountedNamePromise) ?? null,
      });
    }
    const companions = await libraryBase.listCompanions();
    const match = companions.find((companion) => companionHandleFor(companion.companionId) === handle);
    return match === undefined
      ? null
      : Object.freeze({ companionId: match.companionId, continuityId: match.continuityId, name: match.name });
  };
  // The mounted companion is ALWAYS the current library entry: its projected
  // handle is the only handle the detail route will ever resolve. Created
  // companions join the library durably below.
  const libraryService = Object.freeze({
    async listCompanions() {
      const [mountedName, companions] = await Promise.all([mountedNamePromise, libraryBase.listCompanions()]);
      // The mounted companion is spliced in exactly once by its own
      // `companionId`; the library carries it too, so a plain concat renders the
      // current companion twice (same handle, same name).
      return mergeMountedCompanionList(companions, currentCompanionId, mountedName, companionHandleFor);
    },
  });
  /**
   * The mounted companion's own performance directive (the reviewed card's
   * `system_prompt`). `read` projects the durable identity profile; `update`
   * re-authors the text as the player's or clears it, CASed on the exact profile
   * revision the browser read. Only the mounted companion's handle resolves.
   */
  const companionVoiceService = Object.freeze({
    async read(handle: string) {
      if (handle !== companionHandleFor(currentCompanionId)) return null;
      const profile = await readIdentityProfile(runtimePaths.identityProfilePath);
      return Object.freeze({
        profileRevision: profile.revision,
        characterVoice: projectCompanionVoice(profile),
      });
    },
    async update(handle: string, command: Readonly<{ expectedProfileRevision: number; text?: string; clear?: true }>) {
      if (handle !== companionHandleFor(currentCompanionId)) return null;
      return await updateMountedCompanionVoice({
        identityProfilePath: runtimePaths.identityProfilePath,
        runtimeCwd: runtimePaths.runtimeCwd,
        containmentRoot: runtimePaths.root,
        identityKey: identityKey(manifest.principal),
        expectedProfileRevision: command.expectedProfileRevision,
        voice: command.clear === true || command.text === undefined ? null : { text: command.text },
      });
    },
  });
  /**
   * The companion's OWN world book: the reviewed card's `character_book`, which the
   * import persisted at `<runtimeCwd>/worldbook.json`. Read-only, and a different
   * thing from the World Info items a conversation can attach - the surface that
   * read only the library said "no world book" beside a companion that has one.
   * Only the mounted companion's handle resolves.
   */
  const companionWorldBookService = Object.freeze({
    async read(handle: string) {
      if (handle !== companionHandleFor(currentCompanionId)) return null;
      return await projectRenderedCompanionWorldBook(runtimePaths.runtimeCwd, await mountedMacros());
    },
  });
  /**
   * The read-only character inspector: one roster companion's own authored facts.
   *
   * Every other companion-addressed read resolves the MOUNTED companion only
   * (`companion.worldbook.read`, `characters.voice.read`) or is the PLAYER's own
   * record (`persona.read`), so no route projected what an archived companion
   * actually carries. This one resolves any handle the roster handed out - the
   * roster is built from the library's own records with `companionHandleFor`, so
   * enumerating them is total by construction - and reads her artifacts from the
   * roots her own `companion.json` derives, with the same `identityKey` the mount
   * derives them with. Nothing is written and no thread binding is read: this is a
   * companion, not a Chat.
   */
  const companionProfileService = Object.freeze({
    async read(handle: string): Promise<CompanionProfileV1 | null> {
      const companion = await companionForHandle(handle);
      if (companion === null) return null;
      const identity = Object.freeze({
        playerId: manifest.principal.playerId,
        companionId: companion.companionId,
        continuityId: companion.continuityId,
      });
      const companionRuntime = resolveRuntimePaths(identity, manifest.runtimeRoot);
      const companionTavern = resolveTavernPaths(companionRuntime, identity);
      // A missing identity profile is ordinary absence, not an error: the profile
      // is unreadable only when the producer never wrote one (both provisioning
      // paths write it), and the inspector then carries her library name and
      // reports no persona authored. A profile that is PRESENT but unreadable
      // still fails closed, so a corrupt profile never reads as "no persona".
      const identityProfile = existsSync(companionRuntime.identityProfilePath)
        ? await readIdentityProfile(companionRuntime.identityProfilePath)
        : null;
      const name = identityProfile?.identity.name ?? companion.name;
      // The roster only projects a handle for a companion it can name, so a handle
      // that resolves to no name at all is not a roster handle.
      if (name === null) return null;
      const macros = await macroTable({
        char: name,
        locale: await resolveCompanionLocale(manifest.runtimeRoot),
      });
      const scenario = await createScenarioManagementService(artifactStore, companionTavern.companionRoot).read();
      const greetings = await createGreetingManagementService(artifactStore, companionTavern.companionRoot).read();
      const persona = identityProfile?.persona;
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        name: renderProfileLabel(name, macros),
        persona: Object.freeze({
          present: persona !== undefined,
          core: renderProfileTextOrNull(persona?.core, macros),
          interactionStyle: renderProfileTextOrNull(persona?.interactionStyle, macros),
          expressionStyle: renderProfileTextOrNull(persona?.expressionStyle, macros),
        }),
        scenario: Object.freeze({
          present: scenario !== null,
          name: scenario === null ? null : renderProfileLabel(scenario.name, macros),
          description: scenario === null ? null : renderProfileText(scenario.description, macros),
        }),
        greetings: Object.freeze({
          present: greetings !== null,
          label: greetings?.label === undefined ? null : renderProfileLabel(greetings.label, macros),
          variants: Object.freeze(
            (greetings?.variants ?? []).map((variant) =>
              Object.freeze({
                label: variant.label === undefined ? null : renderProfileLabel(variant.label, macros),
                text: renderProfileText(variant.text, macros),
              }),
            ),
          ),
        }),
        worldBook: await projectRenderedCompanionWorldBook(companionRuntime.runtimeCwd, macros),
      });
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
  /**
   * New Chat (design/26 §4.4). The browser sends only the selection generation it read; the Host
   * mints the thread identity, resolves the mounted companion's own greeting as the opening and
   * projects the created Chat's metadata-only entry plus the durable message-zero text. The new
   * Chat is not selected here: it joins the active list and becomes the mounted Chat only through
   * the selection a later runtime start settles, so creation can never switch a running turn.
   */
  const newChatProvisioner = Object.freeze({
    async create(command: CreateChatCommandV1): Promise<ChatCreateResultV1> {
      if (command.selectionGeneration !== lease.browserProjection.selectionGeneration)
        throw new Error("chat_management_selection_conflict");
      const suffix = randomUUID().replaceAll("-", "");
      const chatThreadId = `chat-${suffix.slice(0, 16)}`;
      const chatSurfaceSessionId = `surface-${suffix.slice(16, 32)}`;
      let state;
      try {
        // The opening is omitted, not named: the library resolves the mounted
        // companion's own greeting, which is the exact record the opening-variant
        // route later pages through.
        state = await libraryBase.createNewChat({ chatThreadId, chatSurfaceSessionId });
      } catch (error) {
        throw new Error(chatCreationFailureCode(error));
      }
      const opening = state.messages.find((message) => message.kind === "opening");
      return Object.freeze({
        apiVersion: TAVERN_BROWSER_API_VERSION,
        chat: Object.freeze({
          handle: lease.browserProjection.projectChatHandle(chatThreadId, chatSurfaceSessionId),
          title: state.thread.title ?? null,
          status: "active" as const,
          managementRevision: state.thread.managementRevision ?? 1,
          isSelected: false,
          // The created Chat has exactly one message when it has one at all, so the
          // message-zero text IS its preview. The row carries the same two facts a
          // list row carries, projected the same way.
          updatedAtMs: state.thread.updatedAtMs,
          preview: chatListPreviewText(opening === undefined ? null : opening.text),
        }),
        opening: opening === undefined ? null : opening.text,
      });
    },
  });
  /**
   * Chat selection (ADR 0009 / ADR-0010). The browser names the exact Chat it read from `chat.list` and the
   * generation it read; the Host resolves the opaque handle to the exact persisted thread pair and
   * asks the semantic authority to make it the mounted conversation. The authority switches in
   * process and answers `switched`, aborting a still-generating turn through the same cancel path an
   * explicit browser Stop uses. The already-selected Chat is a no-op: the request names the mounted
   * Chat, so nothing is recorded and no second admission is created.
   */
  const chatSelectProvisioner =
    chatSelection === undefined
      ? undefined
      : Object.freeze({
          async select(command: SelectChatCommandV1): Promise<ChatSelectResultV1> {
            if (command.selectionGeneration !== lease.browserProjection.selectionGeneration)
              throw new Error("chat_management_selection_conflict");
            const threads = await libraryThreads.listThreads?.();
            if (threads === undefined) throw new Error("chat_management_service_unavailable");
            const target = threads.find(
              (thread) =>
                thread.companionId === manifest.principal.companionId &&
                thread.continuityId === manifest.principal.continuityId &&
                (thread.lifecycleStatus ?? "active") === "active" &&
                lease.browserProjection.projectChatHandle(thread.chatThreadId, thread.chatSurfaceSessionId) ===
                  command.chatHandle,
            );
            if (target === undefined) throw new Error("chat_management_selection_conflict");
            const alreadySelected =
              target.chatThreadId === lease.chatThreadId && target.chatSurfaceSessionId === lease.chatSurfaceSessionId;
            if (alreadySelected) return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, status: "switched" });
            let status: ChatSelectResultV1["status"];
            try {
              status = (
                await chatSelection.requestChatSelection({
                  kind: "select",
                  selectionGeneration: command.selectionGeneration,
                  chatThreadId: target.chatThreadId,
                  chatSurfaceSessionId: target.chatSurfaceSessionId,
                })
              ).status as ChatSelectResultV1["status"];
            } catch (error) {
              if (
                error instanceof Error &&
                (error.message === "semantic_chat_selection_generation_conflict" ||
                  error.message === "semantic_chat_selection_conflict")
              )
                throw new Error("chat_management_selection_conflict");
              throw error;
            }
            return Object.freeze({ apiVersion: TAVERN_BROWSER_API_VERSION, status });
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
      companionVoiceService,
      companionWorldBookService,
      companionProfileService,
      newCompanionProvisioner,
      newChatProvisioner,
      ...(chatSelectProvisioner === undefined ? {} : { chatSelectProvisioner }),
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

/**
 * One authored profile field, rendered through the run's macro table and bounded.
 *
 * Rendering happens BEFORE the bound is applied, so a macro that straddles it is
 * resolved whole instead of being cut into a stray `{{`; and a field that renders
 * past its bound is refused with one named code rather than silently shortened,
 * because a shortened field would read as the author's own text.
 */
function renderProfileText(text: string, macros: MacroTable): string {
  const rendered = renderMacros(text, macros);
  if (rendered.length > COMPANION_PROFILE_TEXT_MAX_LENGTH) throw new Error("companion_profile_text_too_long");
  return rendered;
}

/** One authored profile text field that may not be there at all. */
function renderProfileTextOrNull(text: string | undefined, macros: MacroTable): string | null {
  return text === undefined ? null : renderProfileText(text, macros);
}

/** One authored single-line profile label (a name, an opening's label), bounded. */
function renderProfileLabel(text: string, macros: MacroTable): string {
  const rendered = renderMacros(text, macros);
  if (rendered.length > COMPANION_PROFILE_NAME_MAX_LENGTH) throw new Error("companion_profile_text_too_long");
  return rendered;
}

/**
 * The one companion-world-book projection, served by BOTH the mounted read
 * (`companion.worldbook.read`) and the inspector (`companion.profile.read`).
 *
 * The bodies are authored text in the card's own words, so they carry the
 * author's `{{user}}`/`{{char}}` macros verbatim; the player reads them through
 * the run's own macro table, exactly as the scenario projection does
 * (`withScenarioSurfaceMacros`), never as a raw placeholder. Rendering happens
 * before the bound is applied, so a macro that straddles it is resolved whole. Two
 * projections of this one fact would bound it differently, so there is one.
 */
async function projectRenderedCompanionWorldBook(
  runtimeCwd: string,
  macros: MacroTable,
): Promise<CompanionWorldBookV1> {
  const book = await readCompanionWorldBook(runtimeCwd);
  const rendered = book.entries.map((entry) => {
    const content = renderMacros(entry.content, macros);
    if (content.length > COMPANION_WORLD_BOOK_CONTENT_MAX_LENGTH)
      throw new Error("companion_world_book_entry_too_long");
    return Object.freeze({
      title: entry.title,
      keys: [...entry.keys],
      constant: entry.constant,
      content,
    });
  });
  return Object.freeze({
    apiVersion: TAVERN_BROWSER_API_VERSION,
    present: book.present,
    entries: rendered,
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
  const profile =
    input.presentation === undefined
      ? composeReferenceGameBrowserProfile({ tavernProfile })
      : composeReferenceGameBrowserProfile({
          tavernProfile,
          gameProfile: input.presentation.gameProfile,
        });
  const inspector = input.inspector ?? (await createPublishedWindowsReparseInspector(input.hostArtifactRoot));
  const managementProfile = composeTavernManagementProfile();
  let lane: ChatLane | undefined;
  const currentLane = (): ChatLane => {
    if (lane === undefined) throw new Error("chat_lane_unavailable");
    return lane;
  };

  /**
   * Closes every service one lane built, in reverse creation order: the
   * management domains and the connection service first, then the Chat pipeline
   * service, then the state facade they project through.
   */
  const drainChatLane = async (target: ChatLane): Promise<void> => {
    for (let index = target.owned.length - 1; index >= 0; index -= 1) {
      try {
        await target.owned[index]!.close();
      } catch {
        // Keep draining the rest; one close failure must not leak the others.
      }
    }
    try {
      await target.pipelineService.close();
    } catch {
      // Preserve the caller's failure, not this one.
    }
    try {
      await target.referenceStateFacade.close();
    } catch {
      // Preserve the caller's failure, not this one.
    }
  };

  /**
   * Everything the admission serves for exactly one mounted Chat, built over
   * exactly one mounted lease: the state facade, the Chat pipeline service and
   * the management domains. A turn-level Chat switch replaces the whole lane,
   * because the mounted thread pair determines each of these services' bearer
   * projection, per-surface paths and stores.
   */
  async function buildChatLane(lease: MountedChatRuntimeLease): Promise<ChatLane> {
    const referenceStateFacade = await createReferencePipelineStateFacade(
      input.manifest,
      lease,
      tavernProfile,
      input.eventStream,
      input.voiceSurface,
    );
    const pipelineService = createChatPipelineService({
      manifest: input.manifest,
      lease,
      profile: tavernProfile,
      eventStream: input.eventStream,
      ...(input.speechSink === undefined ? {} : { speechSink: input.speechSink }),
    });
    const owned: { close(): Promise<void> }[] = [];
    try {
      const worldInfoService = createTavernManagedWorldInfoService(input.manifest, lease, managementProfile);
      owned.push(worldInfoService);
      const { domains, owned: domainOwned } = createTavernManagementDomains(
        input.manifest,
        lease,
        managementProfile,
        worldInfoService,
        input.chatSelection,
      );
      const { chatSelectProvisioner, ...domainsWithoutSelection } = domains;
      owned.push(...domainOwned);
      // The connection service owns the player's provider/model/credential
      // selection for the exact mounted Chat runtime. ADR-0010 makes a connection
      // switch Class B: it never disturbs the running turn; the next turn reads
      // the new selection, so this service is not wired to turn state at all.
      const connectionService = createTavernConnectionService({
        agentDir: managementAgentDir(input.manifest, lease),
      });
      owned.push(connectionService);
      const management = Object.freeze({
        profile: managementProfile,
        ...domainsWithoutSelection,
        ...(chatSelectProvisioner === undefined
          ? {}
          : {
              chatSelectProvisioner: Object.freeze({
                async select(command: SelectChatCommandV1): Promise<ChatSelectResultV1> {
                  const result = await chatSelectProvisioner.select(command);
                  // A turn-level switch already committed the successor mount;
                  // only the presentation lane still has to follow it.
                  if (result.status === "switched") await switchChatLane();
                  return result;
                },
              }),
            }),
        connectionService,
        ...(input.listVoiceOutputDevices === undefined ? {} : { listVoiceOutputDevices: input.listVoiceOutputDevices }),
      });
      return Object.freeze({
        referenceStateFacade,
        pipelineService,
        management,
        owned: Object.freeze(owned),
      });
    } catch (error) {
      await drainChatLane({ referenceStateFacade, pipelineService, management: Object.freeze({}), owned });
      throw error;
    }
  }

  /**
   * Follows a committed turn-level Chat switch: the coordinator has already
   * released the previous mounted runtime and mounted the selected Chat, so the
   * admission only has to replace its own lane with one built over the successor
   * lease and drain the previous lane's services.
   */
  async function switchChatLane(): Promise<void> {
    if (input.chatSelection === undefined) throw new Error("chat_selection_unavailable");
    const lease = await input.chatSelection.startMountedChatRuntime();
    const previous = lane;
    lane = await buildChatLane(lease);
    if (previous !== undefined) await drainChatLane(previous);
  }

  lane = await buildChatLane(input.lease);
  // The composed shell mounts its one delegated dispatcher and its one
  // reference dispatcher once, so it is handed stable members that resolve to
  // whichever lane is current when a request runs. A lane swap is therefore
  // invisible to the shell and no route can observe a half-switched lane.
  const stableReferenceStateFacade: ReferencePipelineStateFacade = Object.freeze({
    read: () => currentLane().referenceStateFacade.read(),
    readDraft: () => currentLane().referenceStateFacade.readDraft(),
    // The admission owns every lane's lifetime; the shell closes only its own
    // dispatchers, never a lane another owner built.
    close: async () => undefined,
  });
  const stablePipelineService: ChatPipelineService = Object.freeze({
    submitAfterResponseCommit: (command, idempotencyKey, commit202) =>
      currentLane().pipelineService.submitAfterResponseCommit(command, idempotencyKey, commit202),
    readSubmissionStatus: (query) => currentLane().pipelineService.readSubmissionStatus(query),
    cancel: (turnHandle, command) => currentLane().pipelineService.cancel(turnHandle, command),
    // Swipe selection and Regenerate are Chat-owned mutations the reference surface serves through
    // the same lane-swapped service: the delegated dispatcher must reach the current lane's own
    // implementation rather than a snapshot taken at admission time.
    selectSwipe: (command) => currentLane().pipelineService.selectSwipe!(command),
    regenerate: (command, idempotencyKey) => currentLane().pipelineService.regenerate!(command, idempotencyKey),
    close: async () => undefined,
  });
  const stableManagementOptions = createStableManagementOptions(currentLane);
  let server: Awaited<ReturnType<typeof startComposedReferenceGameStaticShellComposition>>;
  try {
    server = await startComposedReferenceGameStaticShellComposition({
      profile,
      bootstrapToken: input.bootstrapToken,
      referenceStateFacade: stableReferenceStateFacade,
      pipelineService: stablePipelineService,
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
      management: stableManagementOptions,
    });
  } catch (error) {
    // No listener exists yet; the lane this admission just built is the only
    // owner it holds, so drain it and preserve the construction failure.
    await drainChatLane(currentLane());
    lane = undefined;
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
          // Listener first, then the lane it served: creation order reversed.
          const current = lane;
          lane = undefined;
          if (current !== undefined) await drainChatLane(current);
        }
      })()),
  });
}

/** One mounted Chat lane: every service the admission built over one mounted lease. */
type ChatLane = Readonly<{
  referenceStateFacade: ReferencePipelineStateFacade;
  pipelineService: ChatPipelineService;
  management: Omit<TavernManagementDelegatedOptions, "capability">;
  owned: readonly { close(): Promise<void> }[];
}>;

/**
 * The lane-owned services the management dispatcher resolves per request and
 * the exact methods it may call on each. Forwarding is explicit rather than
 * reflective so a service method cannot silently escape the lane swap, and
 * `close` is deliberately absent: the presentation admission owns every lane's
 * lifetime, never the shell's delegated dispatcher.
 */
const LANE_SERVICE_METHODS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  managementService: [
    "listChats",
    "renameChatTitle",
    "transitionLifecycle",
    "commitOpeningVariant",
    "readDraft",
    "saveDraft",
    "discardDraft",
  ],
  memoryService: ["read", "mutate"],
  worldInfoService: ["read", "setBinding", "detail", "create", "update", "delete"],
  connectionService: ["read", "create", "test", "activate", "selectModel", "remove"],
  libraryService: ["listCompanions"],
  companionVoiceService: ["read", "update"],
  companionWorldBookService: ["read"],
  companionProfileService: ["read"],
  newCompanionProvisioner: ["create"],
  newChatProvisioner: ["create"],
  chatSelectProvisioner: ["select"],
  personaService: ["read", "update"],
  scenarioService: ["read", "update"],
  greetingService: ["read", "update"],
  stCardImportService: ["import", "read", "recordReview", "readReview"],
  stCardImportHistoryService: ["list"],
  modelProfileStore: ["read", "update"],
  playerPreferenceStore: ["read", "update"],
});

/**
 * The stable management-options projection the composed shell mounts once. Each
 * member resolves to the lane that is current when its route runs, so a
 * turn-level Chat switch replaces every thread-scoped service while the shell's
 * delegated dispatcher stays exactly where it was.
 */
function createStableManagementOptions(current: () => ChatLane): Omit<TavernManagementDelegatedOptions, "capability"> {
  const laneOptions = (): Record<string, unknown> => current().management as unknown as Record<string, unknown>;
  const sample = laneOptions();
  const stable: Record<string, unknown> = { profile: sample.profile };
  for (const [serviceName, methods] of Object.entries(LANE_SERVICE_METHODS)) {
    if (!(serviceName in sample)) continue;
    const forwarded: Record<string, unknown> = {};
    for (const method of methods) {
      const member = (laneOptions()[serviceName] as Record<string, unknown> | undefined)?.[method];
      if (typeof member !== "function") continue;
      forwarded[method] = (...args: unknown[]) =>
        (laneOptions()[serviceName] as Record<string, (...callArgs: unknown[]) => unknown>)[method]!(...args);
    }
    stable[serviceName] = Object.freeze(forwarded);
  }
  if (typeof sample.confirmStCardImport === "function")
    stable.confirmStCardImport = (importId: string) => current().management.confirmStCardImport!(importId);
  if (typeof sample.listVoiceOutputDevices === "function")
    stable.listVoiceOutputDevices = () => current().management.listVoiceOutputDevices!();
  return Object.freeze(stable) as Omit<TavernManagementDelegatedOptions, "capability">;
}

/**
 * The one Tavern-management surface the management browser root serves. The
 * composed surface contract fixes this exact identity, so the declaration
 * lives here rather than in an operator-, bootstrap-, or browser-selected
 * input. Exported so a gate can hold this exact declaration against the
 * dispatcher's canonical groups without mounting the surface.
 */
export function composeTavernManagementProfile(): ComposedTavernProfile {
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
      "companion.worldbook.read",
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
      "character.voice.read",
      "character.voice.update",
      "character.import.stage",
      "character.import.read",
      "character.import.review",
      "character.import.confirm",
      "character.import.history",
      // The optional new-chat opening variant is declared after every other
      // group, in the dispatcher's own canonical group order.
      "chat.opening",
      // New Chat follows the opening choice in that same canonical order.
      "chat.create",
      // Chat selection (ADR 0009) follows New Chat: choosing an existing Chat the
      // next runtime start mounts.
      "chat.select",
      // The managed World Info library's authoring surface follows the last group in
      // the dispatcher's own canonical order.
      "world-info.detail",
      "world-info.create",
      "world-info.update",
      "world-info.delete",
      // The read-only character inspector appends after the World Info authoring
      // group, in that same canonical order.
      "companion.profile.read",
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
      "companion.worldbook.read",
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
      "character.voice.read",
      "character.voice.update",
      "character.import.stage",
      "character.import.read",
      "character.import.review",
      "character.import.confirm",
      "character.import.history",
      "chat.opening",
      "chat.create",
      "chat.select",
      "world-info.detail",
      "world-info.create",
      "world-info.update",
      "world-info.delete",
      "companion.profile.read",
    ],
    // A mounted Memory route is paired with the Memory navigation item; the
    // item only projects `available` after the exact-bound read succeeds. The
    // characters item is paired with the companion library routes.
    navigationItemIds: ["chat", "memory", "characters"],
  });
}

/**
 * The one bounded vocabulary a failed New Chat may report: a durable storage
 * failure stays a storage failure, and nothing else escapes as a second
 * invented code. The dispatcher's own `problemFor` maps these to
 * `storage_unavailable` / `runtime_unavailable`.
 */
function chatCreationFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  // A companion record the library itself writes, but cannot read back, is a
  // data-integrity fact with its own bounded code. Mapping it to the runtime
  // outage code would answer a retryable 503 for something retrying cannot fix.
  if (isTavernArtifactUnreadable(error)) return "chat_management_companion_unreadable";
  if (/storage|sqlite|eio|enoent/i.test(message)) return "chat_management_storage_unavailable";
  return "chat_management_service_unavailable";
}
