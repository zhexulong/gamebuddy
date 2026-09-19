import { resolve } from "node:path";

import { composeReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { GamePresentationProjection } from "../integration-catalog.js";
import { composeTavernProfile, type ComposedTavernProfile } from "../tavern/browser-contract/index.js";
import type { ChatEventStream } from "../tavern/chat-event-stream.js";
import { createChatPipelineService } from "../tavern/chat-pipeline-service.js";
import { startComposedReferenceGameStaticShellComposition } from "../tavern/composed-reference-game-static-shell-composition.js";
import { createChatManagementService } from "../tavern/chat-management/chat-management-service.js";
import { createMemoryManagementService } from "../tavern/memory-management/memory-management.js";
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
  const inspector = input.inspector ?? await createPublishedWindowsReparseInspector(input.hostArtifactRoot);
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
    // pipeline service behind it; the mounted lease stays its own owner's.
    close: () => closePromise ??= server.close(),
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
  const inspector = input.inspector ?? await createPublishedWindowsReparseInspector(input.hostArtifactRoot);
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
    });
    createdServices.push(worldInfoService);
    const managementStateFacade = await createTavernManagementStateFacade(
      input.manifest,
      input.lease,
      tavernProfile,
      worldInfoService,
    );
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
    server = await startTavernManagementStaticShellComposition({
      managementStateFacade,
      managementService,
      memoryService,
      worldInfoService,
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
    close: () => closePromise ??= server.close(),
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
  const inspector = input.inspector ?? await createPublishedWindowsReparseInspector(input.hostArtifactRoot);
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
    // pipeline service behind it; the mounted lease stays its own owner's.
    close: () => closePromise ??= server.close(),
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
    routeIds: ["bootstrap", "state.read", "draft.read", "chat.submit", "chat.cancel", "chat.submission_status", "events"],
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
    routeIds: ["bootstrap", "state.read", "draft.read", "draft.save", "draft.discard", "chat.list", "chat.rename", "memory.read", "memory.mutate", "world-info.read", "world-info.bind"],
    operationIds: ["draft.save", "draft.discard", "chat.rename", "memory.mutate", "world-info.bind"],
    // A mounted Memory route is paired with the Memory navigation item; the
    // item only projects `available` after the exact-bound read succeeds.
    navigationItemIds: ["chat", "memory"],
  });
}
