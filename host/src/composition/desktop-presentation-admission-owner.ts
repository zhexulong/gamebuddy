import { resolve } from "node:path";

import { composeReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import type { MountedChatRuntimeLease } from "../continuity-semantic-production-coordinator/continuity-semantic-production-coordinator.js";
import type { HostDeploymentManifest } from "../deployment-manifest.js";
import type { GamePresentationProjection } from "../integration-catalog.js";
import { composeTavernProfile, type ComposedTavernProfile } from "../tavern/browser-contract/index.js";
import type { ChatEventStream } from "../tavern/chat-event-stream.js";
import { createChatPipelineService } from "../tavern/chat-pipeline-service.js";
import { startComposedReferenceGameStaticShellComposition } from "../tavern/composed-reference-game-static-shell-composition.js";
import { createReferencePipelineStateFacade } from "../tavern/reference-pipeline-state.js";
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
}>;

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
  );
  const pipelineService = createChatPipelineService({
    manifest: input.manifest,
    lease: input.lease,
    profile: tavernProfile,
    eventStream: input.eventStream,
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
 * The one Chat surface the composed reference-game browser root serves. The
 * composed surface contract fixes this exact identity, so the declaration lives
 * here rather than in an operator-, bootstrap-, or browser-selected input.
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
