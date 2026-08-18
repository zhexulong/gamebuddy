import { join } from "node:path";

import type { CompanionIdentity, CompanionModelConfig } from "../runtime.js";
import { resolveRuntimePaths } from "../runtime.js";
import type { CompanionTextExpression, PresentationRuntime } from "../presentation.js";
import { createChatPresentationGate, type ChatPresentationGate } from "../tavern/chat-presentation-gate.internal.js";
import { ModelProfileStore, resolveModelProfileConfig } from "../settings/model-profile-store.js";
import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import { createChatThreadStore } from "../tavern/chat-thread-store.js";
import { materializeTavernStableContext, type TavernStableContextSnapshot } from "../tavern/catalog-service.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import { resolveTavernPaths } from "../tavern/tavern-paths.js";
import { identityKey } from "../runtime.js";

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
  /**
   * Coordinator-private Chat presentation gate. It implements both the Host
   * admission provider and the construction-owned text sink; it stays
   * default-unbound until the coordinator binds it to the exact P4 invocation.
   */
  presentationGate: ChatPresentationGate;
  /** Construction-owned re-materialization for the actual Pi session. */
  materializeStableContextForPiSession(piSessionId: string): Promise<TavernStableContextSnapshot>;
  tavernNarrativeGateNonceSha256?: string;
  playerMemoryNextRoundEvidence?: Readonly<{
    nonceSha256: string;
    onSourceMarker(marker: unknown): void;
  }>;
  attachPresentation(listener: (expression: CompanionTextExpression) => void | Promise<void>): () => void;
}>;

export type ChatRuntimeConstructionOptions = Readonly<{
  tavernNarrativeGateNonceSha256?: string;
  playerMemoryNextRoundEvidence?: Readonly<{
    nonceSha256: string;
    onSourceMarker(marker: unknown): void;
  }>;
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
  // A stable WorldBook binding names metadata but this construction boundary
  // does not yet own its immutable body/revision resolver. Reject it rather
  // than silently drop it, select latest content, or let a consumer inject a
  // WorldBook. Managed bindings are covered by the same rule.
  if (state.thread.worldBookBinding !== undefined) throw new Error("chat_runtime_exact_content_unavailable");
  const tavernPaths = resolveTavernPaths(paths, identity);
  const artifactStore = new TavernArtifactStore(paths.root);
  const selectedThread = state.thread;
  const materializeStableContextForPiSession = async (piSessionId: string): Promise<TavernStableContextSnapshot> => {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(piSessionId)) throw new Error("chat_runtime_pi_session_rejected");
    try {
      return await materializeTavernStableContext(
        tavernPaths,
        artifactStore,
        selectedThread,
        Object.freeze({ continuityId: identity.continuityId!, sessionId: piSessionId, surface: "tavern" }),
      );
    } catch {
      throw new Error("chat_runtime_exact_content_unavailable");
    }
  };
  const modelProfile = await new ModelProfileStore(join(paths.root, "settings", "model-profiles.json")).read("chat");
  const modelConfig = resolveModelProfileConfig(modelProfile);
  if (modelConfig === null) throw new Error("chat_runtime_model_configuration_unavailable");
  // The Chat presentation tool is registered at construction through a
  // default-unbound gate: companion_text exists in the mounted tool surface but
  // capture fails closed until the coordinator binds the gate to the exact P4
  // invocation, so no companion line can reach a sink outside a verified
  // provider run. The gate is also the Chat text sink: it commits the exact P5
  // presentation only after the durable running read-back and only then
  // forwards to construction listeners.
  const presentationGate = createChatPresentationGate();
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
      admissionProvider: presentationGate.admissionProvider,
      textPort: presentationGate.textPort,
    }),
    presentationGate,
    materializeStableContextForPiSession,
    ...(options.tavernNarrativeGateNonceSha256 === undefined
      ? {}
      : { tavernNarrativeGateNonceSha256: options.tavernNarrativeGateNonceSha256 }),
    ...(options.playerMemoryNextRoundEvidence === undefined
      ? {}
      : { playerMemoryNextRoundEvidence: options.playerMemoryNextRoundEvidence }),
    attachPresentation: presentationGate.attach.bind(presentationGate),
  });
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
