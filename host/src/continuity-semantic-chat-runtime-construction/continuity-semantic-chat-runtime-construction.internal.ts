import { join } from "node:path";
import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { PresentationRuntime } from "../presentation.js";
import type { CompanionIdentity, CompanionModelConfig } from "../runtime-identity.js";
import { identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { ModelProfileStore, resolveModelProfileConfig } from "../settings/model-profile-store.js";
import { TavernConnectionStore } from "../tavern/connection-store.js";
import { identityProfileMetadata, readOrCreateIdentityProfile } from "../identity-profile.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import {
  materializeTavernAuthoredStableCatalog,
  type TavernAuthoredContextCatalog,
} from "../tavern/catalog-service.js";
import { createManagedWorldInfoBindingResolver } from "../tavern/world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { readWorldBook, worldBookMetadata, type WorldBookEntry } from "../worldbook.js";
import { createChatThreadStore, type ChatThreadStore } from "../tavern/chat-thread-store.js";
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
  /** Durable revision of the model selection this construction used. */
  modelProfileRevision: number;
  presentation: PresentationRuntime;
  /** Construction-owned materialization for the currently applied Chat catalog. */
  materializeStableContextForPiSession(piSessionId: string): Promise<TavernAuthoredContextCatalog>;
  /** Construction-private desired-state rebuild used only after terminal settlement. */
  materializeDesiredStableContextForPiSession(piSessionId: string): Promise<TavernAuthoredContextCatalog>;
  /**
   * Releases the construction's own store. The construction keeps one store for
   * its whole lifetime, so the consumer that owns the mounted runtime owns this
   * release; the materializer's reverse-disposal calls it.
   */
  closeChatThreadStore(): void;
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
  // Everything past this line can refuse -- an absent thread, identity drift, a
  // missing model configuration -- and every refusal abandons this store. The
  // store now owns a live SQLite connection, so an abandoned one holds the
  // runtime root against removal on Windows for the life of the process, and the
  // caller never receives the object to release it. The release therefore belongs
  // on the throwing path.
  try {
    return await buildExactChatRuntimeConstruction(threads, execution, permit, identity, paths, options);
  } catch (error) {
    threads.close?.();
    throw error;
  }
}

async function buildExactChatRuntimeConstruction(
  threads: ChatThreadStore,
  execution: ChatRuntimeBindingExecution,
  permit: ProductionChatRuntimePermit,
  identity: CompanionIdentity,
  paths: ReturnType<typeof resolveRuntimePaths>,
  options: ChatRuntimeConstructionOptions,
): Promise<ExactChatRuntimeConstruction> {
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
              ...(effectiveBinding === undefined ? {} : { worldBookBinding: effectiveBinding }),
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
            : await resolveBoundWorldBookSource(effectiveBinding, paths.runtimeCwd),
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
  // The player's connection selection is the authority for the chat surface's
  // provider/model/thinking level. With no active connection the frozen chat
  // model profile is used unchanged, so a root without player connections keeps
  // exactly the previous runtime configuration.
  const activeConnection = await readActiveConnectionModelConfig(paths.agentDir);
  const modelConfig = activeConnection ?? resolveModelProfileConfig(modelProfile);
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
    closeChatThreadStore: () => threads.close?.(),
    ...(options.tavernNarrativeGateNonceSha256 === undefined
      ? {}
      : { tavernNarrativeGateNonceSha256: options.tavernNarrativeGateNonceSha256 }),
  });
}

/**
 * Reads the one active player connection as the exact runtime model
 * configuration, or null while no player connection is selected.
 *
 * The record's own endpoint is not returned here: `runtime-core` merges the
 * selected provider entry into Pi's `models.json` from the same stored record,
 * so the endpoint keeps one owner. An unreadable store reads as "no active
 * connection" so the frozen chat profile still applies; the runtime's own
 * fail-closed check on the resolved model prevents a silent downgrade once a
 * selection exists.
 */
async function readActiveConnectionModelConfig(agentDir: string): Promise<CompanionModelConfig | null> {
  try {
    const active = await new TavernConnectionStore(agentDir).active();
    if (active === null) return null;
    return Object.freeze({
      provider: active.providerId,
      modelId: active.modelId,
      thinkingLevel: active.thinkingLevel,
    });
  } catch {
    return null;
  }
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
/**
 * Resolves a native (non-managed) WorldBookBinding — the bound worldbook.json
 * the reviewed import wrote into the runtime root — into the always-on
 * `lorebook_constant` materialization input. The on-disk book must EXACTLY
 * match the thread binding (id/revision/hash): a drifted or manually edited
 * book refuses construction instead of silently materializing stale content,
 * mirroring the managed World Info hash gate.
 *
 * `constant: true` entries are reviewed always-on background and ride in the
 * stable lorebook_constant source (Tier 2 m[0]). The keyword-gated entries are
 * deliberately NOT forwarded: see the note in the assembly ledger
 * (design/tasks/active/p9-assembly-slice.md, row A13) — Magic Context binds the
 * volatile channel per turn, so publishing entry-keyed candidates from a
 * per-session catalog makes every turn refuse.
 */
async function resolveBoundWorldBookSource(
  binding: import("../tavern/chat-thread-store.js").TavernStableWorldBookBinding,
  runtimeCwd: string,
): Promise<import("../tavern/catalog-service.js").TavernWorldInfoSource> {
  let book;
  try {
    book = await readWorldBook(join(runtimeCwd, "worldbook.json"));
  } catch {
    throw new Error("chat_runtime_exact_content_unavailable");
  }
  const metadata = worldBookMetadata(book);
  if (
    book.worldBookId !== binding.worldBookId ||
    metadata.revision !== binding.revision ||
    metadata.canonicalHash !== binding.canonicalHash
  )
    throw new Error("chat_runtime_exact_content_unavailable");
  const constantEntries: readonly WorldBookEntry[] = book.entries.filter((entry) => entry.constant === true);
  return Object.freeze({
    binding,
    alwaysOnPremise: book.alwaysOnPremise,
    ...(constantEntries.length > 0 ? { constantEntries } : {}),
  });
}