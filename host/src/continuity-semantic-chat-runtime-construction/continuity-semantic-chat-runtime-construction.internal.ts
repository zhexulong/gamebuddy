import { join } from "node:path";
import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { PresentationRuntime } from "../presentation.js";
import type { CompanionIdentity, CompanionModelConfig } from "../runtime.js";
import { identityKey, resolveRuntimePaths } from "../runtime.js";
import { ModelProfileStore, resolveModelProfileConfig } from "../settings/model-profile-store.js";
import { identityProfileMetadata, readOrCreateIdentityProfile } from "../identity-profile.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import {
  materializeTavernAuthoredStableCatalog,
  type TavernAuthoredContextCatalog,
} from "../tavern/catalog-service.js";
import { createManagedWorldInfoBindingResolver } from "../tavern/world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { createChatThreadStore } from "../tavern/chat-thread-store.js";
import { resolveTavernPaths } from "../tavern/tavern-paths.js";

/**
 * Immutable construction facts for exactly one selected Chat runtime. This is
 * intentionally internal: neither a browser nor a semantic caller may supply
 * a model, identity profile, presentation sink, content snapshot, or root.
 */
export type ExactChatRuntimeConstruction = Readonly<{
  identity: CompanionIdentity;
  runtimeRoot: string;
  surfaceSessionId: string;
  modelConfig: CompanionModelConfig;
  modelProfileRevision: number;
  presentation: PresentationRuntime;
  /** Construction-owned materialization for the currently applied Chat catalog. */
  materializeStableContextForPiSession(piSessionId: string): Promise<TavernAuthoredContextCatalog>;
  /** Construction-private desired-state rebuild used only after terminal settlement. */
  materializeDesiredStableContextForPiSession(piSessionId: string): Promise<TavernAuthoredContextCatalog>;
  tavernNarrativeGateNonceSha256?: string;
}>;

export type ChatRuntimeConstructionOptions = Readonly<{
  tavernNarrativeGateNonceSha256?: string;
}>;

const CHAT_PRESENTATION_PROFILE = Object.freeze({ locale: "zh-CN", text: true, speech: null });

/**
 * Reads an already-selected Tavern thread from the binding-owned root and
 * derives every wide runtime input inside Host construction.
 * It creates neither a thread nor a selector and treats an unreadable exact
 * binding as an effect-admission failure.
 */
export async function prepareExactChatRuntimeConstruction(
  execution: ChatRuntimeBindingExecution,
  permit: ProductionChatRuntimePermit,
  options: ChatRuntimeConstructionOptions = {},
): Promise<ExactChatRuntimeConstruction> {
  assertExactPermit(execution, permit);
  const identity = Object.freeze({ ...execution.principal });
  const paths = resolveRuntimePaths(identity, execution.runtimeRoot, permit.chatSurfaceSessionId);
  const threads = createChatThreadStore(execution.runtimeRoot, identityKey(identity));
  let state;
  try {
    state = await threads.resumeThread(permit.chatThreadId, permit.chatSurfaceSessionId);
  } catch {
    throw new Error("chat_runtime_exact_content_unavailable");
  }
  if (
    state.thread.chatThreadId !== permit.chatThreadId ||
    state.thread.chatSurfaceSessionId !== permit.chatSurfaceSessionId ||
    state.thread.companionId !== identity.companionId ||
    state.thread.continuityId !== identity.continuityId ||
    state.thread.lifecycleStatus !== "active"
  )
    throw new Error("chat_runtime_exact_content_unavailable");
  const tavernPaths = resolveTavernPaths(paths, identity);
  const artifactStore = new TavernArtifactStore(paths.root);
  const managedWorldInfoResolver = createManagedWorldInfoBindingResolver(
    createWorldInfoManagementRepository(execution.runtimeRoot),
  );
  const selectedThread = state.thread;
  let profileMetadata;
  try {
    profileMetadata = identityProfileMetadata(await readOrCreateIdentityProfile(paths.identityProfilePath));
  } catch {
    throw new Error("chat_runtime_exact_content_unavailable");
  }
  if (
    selectedThread.profileId !== profileMetadata.profileId ||
    selectedThread.profileRevision !== profileMetadata.revision ||
    selectedThread.profileCanonicalHash !== profileMetadata.canonicalHash
  )
    throw new Error("chat_runtime_exact_content_unavailable");
  const materializeContextForPiSession = async (
    piSessionId: string,
    mode: "mounted" | "desired",
  ) => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(piSessionId)) throw new Error("chat_runtime_pi_session_rejected");
    try {
      const freshState = await threads.resumeThread(permit.chatThreadId, permit.chatSurfaceSessionId);
      if (
        freshState.thread.chatThreadId !== selectedThread.chatThreadId ||
        freshState.thread.chatSurfaceSessionId !== permit.chatSurfaceSessionId ||
        freshState.thread.companionId !== identity.companionId ||
        freshState.thread.continuityId !== identity.continuityId ||
        freshState.thread.lifecycleStatus !== "active"
      )
        throw new Error("chat_runtime_exact_content_unavailable");
      const freshProfileMetadata = identityProfileMetadata(await readOrCreateIdentityProfile(paths.identityProfilePath));
      if (
        freshState.thread.profileId !== freshProfileMetadata.profileId ||
        freshState.thread.profileRevision !== freshProfileMetadata.revision ||
        freshState.thread.profileCanonicalHash !== freshProfileMetadata.canonicalHash
      )
        throw new Error("chat_runtime_exact_content_unavailable");
      const desiredBinding = freshState.thread.worldBookBinding;
      const effectiveBinding =
        mode === "desired" || sameWorldInfoBinding(desiredBinding, freshState.thread.appliedWorldBookBinding)
          ? desiredBinding
          : freshState.thread.appliedWorldBookBinding;
      const materializationThread =
        sameWorldInfoBinding(effectiveBinding, desiredBinding) &&
        sameWorldInfoBinding(effectiveBinding, freshState.thread.appliedWorldBookBinding)
          ? freshState.thread
          : Object.freeze({
              ...freshState.thread,
              ...(effectiveBinding === undefined ? { worldBookBinding: undefined } : { worldBookBinding: effectiveBinding }),
            });
      return await materializeTavernAuthoredStableCatalog(
        tavernPaths,
        artifactStore,
        materializationThread,
        Object.freeze({
          continuityId: identity.continuityId!,
          sessionId: piSessionId,
          surface: "tavern",
          threadId: freshState.thread.chatThreadId,
          profile: Object.freeze({
            profileId: freshProfileMetadata.profileId,
            revision: freshProfileMetadata.revision,
            canonicalHash: freshProfileMetadata.canonicalHash,
          }),
        }),
        effectiveBinding === undefined
          ? undefined
          : "source" in effectiveBinding
            ? await managedWorldInfoResolver.resolve(effectiveBinding)
            : (() => {
                throw new Error("chat_runtime_exact_content_unavailable");
              })(),
      );
    } catch {
      throw new Error("chat_runtime_exact_content_unavailable");
    }
  };
  const materializeStableContextForPiSession = (piSessionId: string) =>
    materializeContextForPiSession(piSessionId, "mounted");
  const materializeDesiredStableContextForPiSession = (piSessionId: string) =>
    materializeContextForPiSession(piSessionId, "desired");

  const modelProfile = await new ModelProfileStore(join(paths.root, "settings", "model-profiles.json")).read("chat");
  const modelConfig = resolveModelProfileConfig(modelProfile);
  if (modelConfig === null) throw new Error("chat_runtime_model_configuration_unavailable");
  return Object.freeze({
    identity,
    runtimeRoot: execution.runtimeRoot,
    surfaceSessionId: permit.chatSurfaceSessionId,
    modelConfig,
    modelProfileRevision: modelProfile.revision,
    presentation: Object.freeze({
      profile: CHAT_PRESENTATION_PROFILE,
      surface: "chat",
      sessionId: permit.chatSurfaceSessionId,
    }),
    materializeStableContextForPiSession,
    materializeDesiredStableContextForPiSession,
    ...(options.tavernNarrativeGateNonceSha256 === undefined
      ? {}
      : { tavernNarrativeGateNonceSha256: options.tavernNarrativeGateNonceSha256 }),
  });
}

function sameWorldInfoBinding(
  left: import("../tavern/chat-thread-store.js").TavernStableWorldInfoBinding | undefined,
  right: import("../tavern/chat-thread-store.js").TavernStableWorldInfoBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if ("source" in left && "source" in right)
    return left.publicTitle === right.publicTitle && left.revision === right.revision && left.canonicalHash === right.canonicalHash;
  if (!("source" in left) && !("source" in right))
    return left.worldBookId === right.worldBookId && left.revision === right.revision && left.canonicalHash === right.canonicalHash && left.provenance === right.provenance;
  return false;
}

function assertExactPermit(execution: ChatRuntimeBindingExecution, permit: ProductionChatRuntimePermit): void {
  if (
    permit.principal.continuityId !== execution.principal.continuityId ||
    permit.principal.companionId !== execution.principal.companionId ||
    permit.principal.playerId !== execution.principal.playerId ||
    permit.runtimeBindingDigest !== execution.bindingFacts.runtimeBindingDigest ||
    permit.owner.ownerToken !== execution.bindingFacts.owner.ownerToken ||
    permit.owner.runtimeInstanceId !== execution.bindingFacts.owner.runtimeInstanceId ||
    permit.owner.ownerPid !== execution.bindingFacts.owner.ownerPid ||
    permit.owner.ownerProcessStartIdentity !== execution.bindingFacts.owner.ownerProcessStartIdentity ||
    Date.now() > permit.deadlineAtMs
  )
    throw new Error("chat_runtime_construction_permit_rejected");
}
