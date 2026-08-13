import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCompanionRuntime,
  DEFAULT_COMPANION_MODEL_CONFIG,
  resolveRuntimePaths,
  type CompanionIdentity,
  type CompanionMemoryFacade,
  type CompanionModelConfig,
  type RuntimeSession,
} from "./runtime.js";
import {
  prepareChatSurface,
  rollbackChatSurface,
  selectContinuitySession,
  withContinuityLifecycleLock,
  type ContinuitySelection,
  type SurfaceSession,
} from "./continuity.js";
import { type IdentityProfile } from "./identity-profile.js";
import { type WorldBookBinding } from "./worldbook.js";
import { decodeSafeInterchange, exportSafeChat, exportSafeWorldBook } from "./tavern/interchange.js";
import { DialogueController, type DialogueControllerEvent, validateDialogueInput } from "./dialogue-controller.js";
import {
  type CompanionTextExpression,
  type CompanionTextPort,
  type HostPresentationBinding,
  type HostPresentationAdmissionProvider,
  type PresentationCommitAdmission,
  type PresentationRuntime,
} from "./presentation.js";
import {
  createChatThreadStore,
  type ChatThread,
  type TavernStableWorldBookBinding,
  type TavernStableWorldInfoBinding,
} from "./tavern/chat-thread-store.js";
import { openTavernConversation } from "./tavern/conversation.js";
import { TavernArtifactStore } from "./tavern/artifact-store.js";
import { createTavernLibraryService } from "./tavern/library-service.js";
import { createCompanionDetailService } from "./tavern/companion-detail/companion-detail-service.js";
import { characterDetailRouteEnabled } from "./tavern/selected-character-detail.v1.js";
import { StCardImportService } from "./tavern/st-card-import-service.js";
import { provisionDirectNewCompanion, provisionNewCompanion } from "./tavern/new-companion-service.js";
import { resolveTavernPaths, tavernRevisionPath } from "./tavern/tavern-paths.js";
import { materializeTavernStableContext, type TavernManagedWorldInfoSource } from "./tavern/catalog-service.js";
import { createManagedWorldInfoBindingResolver } from "./tavern/world-info-binding/managed-world-info-binding.js";
import {
  createWorldInfoManagementRepository,
  type UpdateWorldInfoRequest,
} from "./tavern/world-info-management/world-info-management.js";
import {
  selectedWorldInfoManagementBootstrapModel,
  worldInfoManagementRouteEnabled,
} from "./tavern/selected-world-info-management.v1.js";
import { validateTavernArtifact, type GreetingSet, type Scenario, type UserPersona } from "./tavern/types.js";
import { selectedL3BootstrapModel, selectedL3RouteEnabled } from "./tavern/selected-l3.v1.js";
import {
  selectedSettingsManagementBootstrapModel,
  settingsManagementRouteEnabled,
} from "./tavern/selected-settings-management.v1.js";
import { createChatTitleManagementService } from "./tavern/chat-management/chat-title-management.js";
import {
  chatManagementRouteEnabled,
  selectedChatManagementBootstrapModel,
} from "./tavern/selected-chat-management.v1.js";
import { chatLifecycleRouteEnabled, selectedChatLifecycleBootstrapModel } from "./tavern/selected-chat-lifecycle.v1.js";
import { createInternalChatLifecycleService } from "./tavern/chat-lifecycle/chat-lifecycle-service.js";
import type { ProductionGameContinuity } from "./production-game-continuity.js";
import { createChatDraftStore } from "./tavern/chat-draft/chat-draft-store.js";
import { ModelProfileStore, resolveModelProfileConfig } from "./settings/model-profile-store.js";
import { createPersonaManagementService } from "./tavern/persona-management/persona-management.js";
import {
  personaManagementRouteEnabled,
  selectedPersonaManagementBootstrapModel,
} from "./tavern/selected-persona-management.v1.js";
import {
  contentManagementRouteEnabled,
  selectedContentManagementBootstrapModel,
} from "./tavern/selected-content-management.v1.js";
import { createScenarioManagementService } from "./tavern/scenario-management/scenario-management.js";
import { createGreetingManagementService } from "./tavern/greeting-management/greeting-management.js";
import { projectGameStatus, type HostGameLifecycleSnapshot } from "./game-status/game-status.js";
import type { ConnectedIntegrationCompanion } from "./integration-bootstrap.js";

const BOOTSTRAP_TTL_MS = 60_000;
const BROWSER_TTL_SECONDS = 60 * 60 * 2;
const NEW_CHAT_SELECTION_TTL_MS = 5 * 60_000;
const MESSAGE_DRAFT_CLEAR_TTL_MS = 5 * 60_000;
const MAX_BODY_BYTES = 16 * 1024;
const LOOPBACK_HOST = "127.0.0.1";
const CURRENT_TURN_MEMORY_DELEGATION_TTL_MS = 5 * 60_000;

export type DialogueWebOptions = Readonly<{
  /** Internal test seam; never accepted from browser/operator configuration. */
  internalMagicContextFeatureTestOverride?: Readonly<{
    memoryEnabled?: boolean;
    historianEnabled?: boolean;
    historianExecuteThresholdTokens?: number;
    historianExecuteThresholdPercentage?: number;
  }>;
  identity: CompanionIdentity;
  runtimeRoot?: string;
  continuity?: ProductionGameContinuity;
  modelConfig?: CompanionModelConfig;
  staticDir?: string;
  initialProfile?: IdentityProfile;
  /** Explicitly resume one existing chat surface; omitted resumes the latest chat surface. */
  surfaceSessionId?: string;
  worldBook?: WorldBookBinding;
  /** Optional voice STOP hook; it never touches the Game bridge or actions. */
  stopVoice?: () => Promise<void> | void;
  /**
   * Explicit Magic Context facade injection for selected L3 memory management.
   * The Host derives its continuity identity below; browser requests cannot
   * supply a data path, Pi session, or continuity identifier. Omission leaves
   * these routes unavailable rather than opening Magic Context storage.
   */
  magicContextMemoryFacade?: DialogueMemoryFacade;
  /**
   * Host-owned lifecycle source for the read-only Game status projection.
   * Browser input cannot provide, select, or modify this source.
   */
  gameStatusProvider?: () => HostGameLifecycleSnapshot;
  /** Public connected-companion lifecycle seam; equivalent to gameStatusProvider. */
  connectedIntegrationCompanion?: Pick<ConnectedIntegrationCompanion, "lifecycleSnapshot">;
  /** Optional one-shot provider marker, installed only by the production gate runner. */
  tavernNarrativeGateNonceSha256?: string;
  /** Host-only callback correlating the Pi session selected for the gate. */
  onTavernNarrativeGateRuntime?: (runtime: TavernNarrativeGateRuntime) => void;
  /** Internal deterministic race-test seam; it is never browser-controlled. */
  internalDialogueWebTestHooks?: Readonly<{
    beforeAppendPlayer?: () => Promise<void>;
    beforeCommitResponse?: () => Promise<void>;
  }>;
}>;

export type TavernNarrativeGateRuntime = Readonly<{
  piSessionId: string;
}>;

export type DialogueMemoryCategory = "semantic" | "interaction";
export type DialogueMemoryStatus = "active" | "permanent" | "archived";
export type DialogueMemorySourceRef = string;
export type DialogueMemoryView = Readonly<{
  stateToken: string;
  content: string;
  category: DialogueMemoryCategory;
  status: DialogueMemoryStatus;
  sourceRefs?: readonly DialogueMemorySourceRef[];
}>;
export type DialogueMemoryFacade = Readonly<{
  /** Host-redeemed current-turn delegation; never called from browser input. */
  createDelegatedInferredSemanticMemory(
    input: Readonly<{
      continuityId: string;
      operationId: string;
      content: string;
      sourceRefs?: readonly DialogueMemorySourceRef[];
    }>,
  ): Promise<DialogueMemoryView>;
  listMemories(input: Readonly<{ continuityId: string }>): Promise<readonly DialogueMemoryView[]>;
  getMemory(input: Readonly<{ continuityId: string; stateToken: string }>): Promise<DialogueMemoryView>;
  /** Player-direct UI creation remains outside the companion read facade. */
  createMemory(
    input: Readonly<{
      continuityId: string;
      content: string;
      category: DialogueMemoryCategory;
      sourceRefs?: readonly DialogueMemorySourceRef[];
    }>,
  ): Promise<DialogueMemoryView>;
  updateMemory(
    input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string; content: string }>,
  ): Promise<DialogueMemoryView>;
  archiveMemory(
    input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
  ): Promise<DialogueMemoryView>;
  restoreMemory(
    input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
  ): Promise<DialogueMemoryView>;
  pinMemory(
    input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
  ): Promise<DialogueMemoryView>;
  unpinMemory(
    input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>,
  ): Promise<DialogueMemoryView>;
  mergeMemory(
    input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string; targetStateToken: string }>,
  ): Promise<DialogueMemoryView>;
  deleteEntry(input: Readonly<{ continuityId: string; stateToken: string; expectedStateToken: string }>): Promise<void>;
  excludeSource(
    input: Readonly<{
      continuityId: string;
      stateToken: string;
      expectedStateToken: string;
      sourceRef?: DialogueMemorySourceRef;
    }>,
  ): Promise<void>;
}>;

export type DialogueWebServer = Readonly<{
  url: string;
  runtime: RuntimeSession;
  surfaceSession: SurfaceSession;
  /** Bounded test probes may terminate idle local SSE keep-alive sockets first. */
  closeAllConnections(): void;
  close(): Promise<void>;
}>;

type BrowserSession = Readonly<{
  bearer: string;
  csrf: string;
  expiresAtMs: number;
}>;
type NewChatSelection = Readonly<{
  personaId?: string;
  scenarioId?: string;
  greetingSetId?: string;
  variantId?: string;
}>;
type ExpiringSelection = Readonly<{ selection: NewChatSelection; expiresAtMs: number }>;
type ExpiringChat = Readonly<{ chatThreadId: string; chatSurfaceSessionId: string; expiresAtMs: number }>;
type ExpiringCompanion = Readonly<{ companionId: string; continuityId: string; expiresAtMs: number }>;
type CompanionRowReference = Readonly<{ companionId: string; continuityId: string; rowRef: string }>;
type ChatDraftScope = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
}>;
type AcceptedDraftClear = Readonly<{ scope: ChatDraftScope; expiresAtMs: number }>;
type DelegatedMemoryCreate = {
  controller: DialogueController;
  generation: number;
  sessionId: string;
  runtime: RuntimeSession;
  continuityId: string;
  turnId: string;
  expiresAtMs: number;
  /** Claimed Host/Pi-issued tool-call ID; no model parameter can set this. */
  operationId?: string;
  result?: DialogueMemoryView;
};
type ExpiringLifecycleHandle = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  companionId: string;
  continuityId: string;
  managementRevision: number;
  browserBearer: string;
  expiresAtMs: number;
}>;

type OutboundEvent =
  | Readonly<{ type: "presentation_text"; expressionId: string; sourceEventId: string; text: string; locale: string }>
  | DialogueControllerEvent;

/**
 * GameBuddy's loopback-only Dialogue surface. Browser clients never select an
 * identity, model, tool set, runtime path, or Pi session; all are established
 * before the listener begins accepting connections.
 */
export async function startDialogueWebServer(options: DialogueWebOptions): Promise<DialogueWebServer> {
  if (options.identity.continuityId === undefined) throw new Error("dialogue_continuity_id_required");
  if (options.continuity === undefined) throw new Error("dialogue_continuity_dependencies_required");
  const continuity = options.continuity;
  const continuityPaths = resolveRuntimePaths(options.identity, options.runtimeRoot);
  // The selected Chat profile is Host-owned and is resolved before any
  // Companion runtime is created. An explicit Host option remains an internal
  // startup override; browser input cannot select a provider or model.
  const modelProfiles = new ModelProfileStore(join(continuityPaths.root, "settings", "model-profiles.json"));
  const selectedChatModel =
    options.modelConfig ??
    resolveModelProfileConfig(await modelProfiles.read("chat")) ??
    DEFAULT_COMPANION_MODEL_CONFIG;
  // These are assigned before the runtime receives its first prompt. Keeping
  // the adapter closure Host-owned avoids putting delegation proof in either a
  // browser payload or the model prompt/tool schema.
  let controller!: DialogueController;
  let controllerGeneration = 0;
  let closed = false;
  const initialPresentationOwner: ChatPresentationOwner = { generation: controllerGeneration };
  const initialAdmissionProvider = createChatPresentationAdmissionProvider(initialPresentationOwner, () =>
    Object.freeze({ closed, controller, generation: controllerGeneration, runtime }),
  );
  const delegatedMemoryCreates = new Map<string, DelegatedMemoryCreate>();
  const companionMemory = adaptDialogueMemoryFacade(
    options.magicContextMemoryFacade,
    options.identity.continuityId,
    async (content, operationId) => redeemDelegatedMemoryCreate(content, operationId),
  );
  let selection = await selectContinuitySession(continuityPaths, options.identity, {
    surface: "chat",
    ...(options.surfaceSessionId === undefined ? {} : { sessionId: options.surfaceSessionId }),
  });
  let presentation = new DialoguePresentationPort();
  let runtime: RuntimeSession;
  try {
    runtime = await createCompanionRuntime(
      options.identity,
      options.runtimeRoot,
      undefined,
      selectedChatModel,
      undefined,
      {
        profile: { locale: "zh-CN", text: true, speech: null },
        surface: "chat",
        sessionId: selection.session.sessionId,
        admissionProvider: initialAdmissionProvider,
        textPort: presentation,
      } satisfies PresentationRuntime,
      false,
      options.initialProfile,
      selection.session.sessionId,
      options.worldBook,
      "chat",
      options.internalMagicContextFeatureTestOverride,
      undefined,
      companionMemory,
      options.tavernNarrativeGateNonceSha256,
    );
  } catch (error) {
    if (selection.created) {
      try {
        await rollbackChatSurface(continuityPaths, options.identity, selection);
      } catch (compensationError) {
        throw new AggregateError([error, compensationError], "dialogue_bootstrap_failed_and_compensation_failed");
      }
    }
    throw error;
  }
  if (options.tavernNarrativeGateNonceSha256 !== undefined) {
    // The callback crosses only the Host launcher IPC boundary. It is emitted
    // before any browser/API turn and supplies an independent expected Pi
    // session ID for the runner's later marker correlation.
    options.onTavernNarrativeGateRuntime?.(Object.freeze({ piSessionId: runtime.piSessionId }));
  }
  const toolNames = runtime.session.agent.state.tools.map((tool) => tool.name).sort();
  const expectedTools = [
    "companion_status",
    "companion_text",
    "todowrite",
    ...(companionMemory === undefined ? [] : ["companion_memory"]),
    ...(options.worldBook === undefined ? [] : ["companion_worldbook_catalog", "companion_worldbook_query"]),
  ].sort();
  if (JSON.stringify(toolNames) !== JSON.stringify(expectedTools)) {
    runtime.clearTavernNarrativeGateMarker?.();
    runtime.session.dispose();
    if (selection.created) {
      try {
        await rollbackChatSurface(continuityPaths, options.identity, selection);
      } catch (compensationError) {
        throw new AggregateError(
          [new Error("dialogue_tool_isolation_failed"), compensationError],
          "dialogue_bootstrap_failed_and_compensation_failed",
        );
      }
    }
    throw new Error("dialogue_tool_isolation_failed");
  }

  const threads = continuity.chatThreads;
  const tavernPaths = resolveTavernPaths(runtime.paths, options.identity);
  // Tavern artifacts are rooted at RuntimePaths.root, while Pi and thread
  // state remain in the opaque continuity runtime directory. Do not narrow
  // this store to runtimeCwd: resolveTavernPaths intentionally lives above it.
  const artifacts = new TavernArtifactStore(runtime.paths.root);
  const library = createTavernLibraryService(tavernPaths, artifacts, threads);
  // The running identity has an inert Library record before any direct New
  // Companion request. Direct provisioning therefore never doubles as an
  // implicit initializer or mutates this active identity.
  if (!(await library.listCompanions()).some((companion) => companion.companionId === options.identity.companionId)) {
    await library.createNewCompanion({
      companionId: options.identity.companionId,
      continuityId: options.identity.continuityId,
      name: runtime.profile.identity.name,
      profileId: runtime.identityProfile.profileId,
      profileRevision: runtime.identityProfile.revision,
      profileHash: runtime.identityProfile.canonicalHash,
    });
  }
  const imports = new StCardImportService(artifacts, tavernPaths);
  const managedWorldInfo = createWorldInfoManagementRepository(runtime.paths.root);
  const managedWorldInfoResolver = createManagedWorldInfoBindingResolver(managedWorldInfo);
  const personas = createPersonaManagementService(artifacts, tavernPaths.playerRoot);
  const scenarios = createScenarioManagementService(artifacts, tavernPaths.companionRoot);
  const greetings = createGreetingManagementService(artifacts, tavernPaths.companionRoot);
  let conversation: Awaited<ReturnType<typeof openTavernConversation>>;
  try {
    conversation = await openTavernConversation(threads, {
      chatThreadId: selection.session.sessionId,
      companionId: options.identity.companionId,
      continuityId: options.identity.continuityId,
      chatSurfaceSessionId: selection.session.sessionId,
      ...(options.worldBook === undefined
        ? {}
        : { worldBookBinding: { ...options.worldBook.metadata, provenance: "authored" as const } }),
    });
  } catch (error) {
    runtime.clearTavernNarrativeGateMarker?.();
    runtime.session.dispose();
    if (selection.created) {
      try {
        await rollbackChatSurface(continuityPaths, options.identity, selection);
      } catch (compensationError) {
        throw new AggregateError([error, compensationError], "dialogue_bootstrap_failed_and_compensation_failed");
      }
    }
    throw error;
  }
  // Stable Tavern context is published only after exact durable-thread binding
  // and before the first model turn. No selection means an explicit empty
  // tombstone, never an invented source.
  try {
    const stableContextThread = await threads.resumeThread(selection.session.sessionId, selection.session.sessionId);
    // Startup obtains this exact pair from the Host-owned continuity ledger,
    // then persists a verified selection for restart readback.
    await continuity.coordinator.withTransition(options.identity.continuityId, async () => {
      await selectContinuitySession(continuityPaths, options.identity, {
        surface: "chat",
        sessionId: selection.session.sessionId,
      });
      await threads.selectActiveThread(selection.session.sessionId, selection.session.sessionId);
    });
    await publishExactTavernStableContext(runtime, stableContextThread.thread);
  } catch (error) {
    runtime.clearTavernNarrativeGateMarker?.();
    runtime.session.dispose();
    if (selection.created) {
      try {
        await rollbackChatSurface(continuityPaths, options.identity, selection);
      } catch (compensationError) {
        throw new AggregateError([error, compensationError], "dialogue_stable_context_failed_and_compensation_failed");
      }
    }
    throw error;
  }

  // Each queued browser turn must produce an explicit companion_text event.
  // Ordinary assistant output remains private and cannot complete the turn.
  let activePresentationCount = 0;
  controller = new DialogueController(runtime.session, Date.now, () => activePresentationCount > 0);
  initialPresentationOwner.runtime = runtime;
  initialPresentationOwner.controller = controller;
  let presentationCommit = Promise.resolve();
  // All durable conversation mutations and exact selection transitions share
  // this boundary. A mutation either completes for its captured selection
  // before a transition, or observes that transition and fails closed.
  let selectionMutation = Promise.resolve();
  async function withSelectionMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const previous = selectionMutation;
    let release!: () => void;
    selectionMutation = new Promise<void>((resolveRelease) => {
      release = resolveRelease;
    });
    await previous;
    try {
      return await mutation();
    } finally {
      release();
    }
  }
  // Lock order for lifecycle/selection coordination is continuity outer lock,
  // then the Tavern active-selection lock, then an exact thread lock. The
  // continuity APIs are never called while this outer callback is held.
  const lifecycle = createInternalChatLifecycleService(
    threads,
    {
      playerId: options.identity.playerId,
      companionId: options.identity.companionId,
      continuityId: options.identity.continuityId,
    },
    undefined,
    {
      withExactThreadManagementLock: async (_binding, operation) =>
        continuity.coordinator.withTransition(options.identity.continuityId!, operation),
    },
    undefined,
  );
  const bootstrap = randomToken();
  const bootstrapExpiresAtMs = Date.now() + BOOTSTRAP_TTL_MS;
  let bootstrapConsumed = false;
  let browser: BrowserSession | undefined;
  // Opaque, in-memory handles bind browser-visible catalog choices to this
  // Host session. Canonical artifact identifiers never cross the boundary.
  let newChatSelections = new Map<string, ExpiringSelection>();
  // Chat navigation uses the same Host-session-bound capability boundary as
  // selection catalogs. The browser never receives durable thread/surface IDs.
  let chatHandles = new Map<string, ExpiringChat>();
  let lifecycleHandles = new Map<string, ExpiringLifecycleHandle>();
  // Library detail handles are per-browser-session, expire quickly, and are
  // consumed before the domain is read so they cannot be replayed.
  let companionDetailHandles = new Map<string, ExpiringCompanion>();
  // A row reference is UI-only correlation metadata, not an authority. It is
  // scoped to this Host/browser lifetime and lets a fresh projection identify
  // the same row without exposing or deriving a domain identifier.
  const companionRowReferences = new Map<string, CompanionRowReference>();
  // This opaque capability is minted only after a message is durably accepted.
  // It captures the source draft scope and cannot be redirected by a later selection.
  const acceptedDraftClears = new Map<string, AcceptedDraftClear>();
  let eventStream: ServerResponse | undefined;
  const staticDir = options.staticDir ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../dialogue-web/dist");
  const isWorldBookBound = options.worldBook !== undefined;
  // The fixed model projection never contains credential material and cannot
  // alter the already constructed Companion runtime from browser input.

  const publish = (event: OutboundEvent): void => {
    if (closed || eventStream === undefined || eventStream.destroyed) return;
    eventStream.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  };
  function isExactActiveOrigin(
    origin: Readonly<{
      controller: DialogueController;
      conversation: Awaited<ReturnType<typeof openTavernConversation>>;
      generation: number;
      sessionId: string;
      ownerRuntime: RuntimeSession;
    }>,
  ): boolean {
    return (
      !closed &&
      origin.generation === controllerGeneration &&
      origin.controller === controller &&
      origin.conversation === conversation &&
      origin.sessionId === selection.session.sessionId &&
      origin.ownerRuntime === runtime
    );
  }
  let detachPresentation = attachPresentation(
    presentation,
    controllerGeneration,
    selection.session.sessionId,
    runtime,
    conversation,
  );
  function attachPresentation(
    port: DialoguePresentationPort,
    generation: number,
    sessionId: string,
    ownerRuntime: RuntimeSession,
    ownerConversation: Awaited<ReturnType<typeof openTavernConversation>>,
  ): () => void {
    return port.subscribe(async (expression, admission) => {
      // Serialize commit and selection transitions. A listener that is stale at
      // either boundary fails closed: it cannot write, publish, or count a turn.
      const origin = Object.freeze({
        controller,
        conversation: ownerConversation,
        generation,
        sessionId,
        ownerRuntime,
      });
      const commit = async () => {
        admission.assertHostCurrent(admission.hostBinding);
        await options.internalDialogueWebTestHooks?.beforeCommitResponse?.();
        admission.assertHostCurrent(admission.hostBinding);
        await withSelectionMutation(async () => {
          if (!isExactActiveOrigin(origin)) return;
          await ownerConversation.commitResponse(expression, Date.now());
          if (!isExactActiveOrigin(origin)) return;
          activePresentationCount++;
          publish({
            type: "presentation_text",
            expressionId: expression.expressionId,
            sourceEventId: expression.sourceEventId,
            text: expression.text,
            locale: expression.locale,
          });
        });
      };
      const next = presentationCommit.then(commit, commit);
      presentationCommit = next.catch(() => undefined);
      await next;
    });
  }
  function delegationKey(generation: number, turnId: string): string {
    return `${generation}:${turnId}`;
  }
  function delegationSourceRef(sessionId: string, turnId: string): DialogueMemorySourceRef {
    // Session IDs are Host-owned opaque identities but can contain '-' and
    // '_'; bind as one opaque ref segment without introducing content.
    return `pi-message:${sessionId}:${turnId}`;
  }
  function revokeDelegatedMemoryCreate(generation: number, turnId: string | null): void {
    if (turnId !== null) delegatedMemoryCreates.delete(delegationKey(generation, turnId));
  }
  function onControllerEvent(generation: number, event: DialogueControllerEvent): void {
    if (event.type === "turn_started") activePresentationCount = 0;
    if (event.type === "turn_completed" || event.type === "turn_cancelled" || event.type === "turn_failed") {
      revokeDelegatedMemoryCreate(generation, event.clientMessageId);
    }
    publish(event);
  }
  let detachController = controller.subscribe((event) => onControllerEvent(controllerGeneration, event));
  async function redeemDelegatedMemoryCreate(
    content: string,
    operationId: string | undefined,
  ): Promise<DialogueMemoryView> {
    const turnId = controller.currentTurnId();
    if (operationId === undefined || turnId === undefined) throw new Error("memory_delegation_unavailable");
    const key = delegationKey(controllerGeneration, turnId);
    const delegation = delegatedMemoryCreates.get(key);
    if (
      delegation === undefined ||
      delegation.expiresAtMs < Date.now() ||
      delegation.controller !== controller ||
      delegation.generation !== controllerGeneration ||
      delegation.sessionId !== selection.session.sessionId ||
      delegation.runtime !== runtime ||
      delegation.continuityId !== options.identity.continuityId ||
      delegation.turnId !== turnId
    ) {
      throw new Error("memory_delegation_unavailable");
    }
    if (delegation.operationId !== undefined) {
      if (delegation.operationId === operationId && delegation.result !== undefined) return delegation.result;
      throw new Error("memory_delegation_consumed");
    }
    // Claim before the async facade call: concurrent calls cannot both write.
    delegation.operationId = operationId;
    try {
      const result = await options.magicContextMemoryFacade!.createDelegatedInferredSemanticMemory({
        continuityId: delegation.continuityId,
        operationId,
        content,
        sourceRefs: [delegationSourceRef(delegation.sessionId, delegation.turnId)],
      });
      delegation.result = result;
      return result;
    } catch (error) {
      // The facade did not report a result, so do not invent a receipt. A
      // provider retry with the same opaque tool call ID may retry safely only
      // when the storage call itself failed before returning.
      delegation.operationId = undefined;
      throw error;
    }
  }
  let activation = Promise.resolve();
  let activationInProgress = false;
  async function activateExactChat(state: {
    thread: { chatThreadId: string; chatSurfaceSessionId: string };
  }): Promise<void> {
    const run = async () =>
      withSelectionMutation(async () => {
        if (closed || activationInProgress || !runtime.session.isIdle) throw new Error("tavern_runtime_busy");
        activationInProgress = true;
        // Revoke the old generation before any asynchronous activation work.
        // Queued source callbacks then cannot append or present into the target.
        controllerGeneration++;
        const previous = { selection, runtime, controller, conversation, detachController, detachPresentation };
        let candidateSelection: ContinuitySelection | undefined;
        let candidate: RuntimeSession | undefined;
        const candidatePresentationOwner: ChatPresentationOwner = { generation: controllerGeneration };
        const candidateAdmissionProvider = createChatPresentationAdmissionProvider(candidatePresentationOwner, () =>
          Object.freeze({ closed, controller, generation: controllerGeneration, runtime }),
        );
        try {
          candidateSelection = await selectContinuitySession(continuityPaths, options.identity, {
            surface: "chat",
            sessionId: state.thread.chatSurfaceSessionId,
          });
          candidate = await createCompanionRuntime(
            options.identity,
            options.runtimeRoot,
            undefined,
            options.modelConfig ??
              resolveModelProfileConfig(await modelProfiles.read("chat")) ??
              DEFAULT_COMPANION_MODEL_CONFIG,
            undefined,
            {
              profile: { locale: "zh-CN", text: true, speech: null },
              surface: "chat",
              sessionId: candidateSelection.session.sessionId,
              admissionProvider: candidateAdmissionProvider,
              textPort: presentation,
            },
            false,
            options.initialProfile,
            candidateSelection.session.sessionId,
            options.worldBook,
            "chat",
            options.internalMagicContextFeatureTestOverride,
            undefined,
            companionMemory,
            options.tavernNarrativeGateNonceSha256,
          );
          if (options.tavernNarrativeGateNonceSha256 !== undefined) {
            options.onTavernNarrativeGateRuntime?.(Object.freeze({ piSessionId: candidate.piSessionId }));
          }
          const candidateThreads = continuity.chatThreads;
          const candidateConversation = await openTavernConversation(candidateThreads, {
            chatThreadId: state.thread.chatThreadId,
            companionId: options.identity.companionId,
            continuityId: options.identity.continuityId!,
            chatSurfaceSessionId: candidateSelection.session.sessionId,
          });
          const exact = await candidateThreads.resumeThread(
            state.thread.chatThreadId,
            candidateSelection.session.sessionId,
          );
          await publishExactTavernStableContext(candidate, exact.thread);
          await continuity.coordinator.withTransition(options.identity.continuityId!, async () => {
            await selectContinuitySession(continuityPaths, options.identity, {
              surface: "chat",
              sessionId: exact.thread.chatSurfaceSessionId,
            });
            await candidateThreads.selectActiveThread(exact.thread.chatThreadId, exact.thread.chatSurfaceSessionId);
          });
          await previous.controller.stop();
          previous.detachController();
          delegatedMemoryCreates.clear();
          selection = candidateSelection;
          runtime = candidate;
          conversation = candidateConversation;
          detachPresentation();
          detachPresentation = attachPresentation(
            presentation,
            controllerGeneration,
            selection.session.sessionId,
            runtime,
            conversation,
          );
          controller = new DialogueController(candidate.session, Date.now, () => activePresentationCount > 0);
          candidatePresentationOwner.runtime = candidate;
          candidatePresentationOwner.controller = controller;
          delegatedMemoryCreates.clear();
          detachController = controller.subscribe((event) => onControllerEvent(controllerGeneration, event));
          await previous.runtime.clearTavernStableContext?.();
          previous.runtime.clearTavernNarrativeGateMarker?.();
          previous.runtime.session.dispose();
        } catch (error) {
          await candidate?.clearTavernStableContext?.();
          candidate?.clearTavernNarrativeGateMarker?.();
          candidate?.session.dispose();
          // A generation change invalidates the old listener even when candidate
          // setup fails. Replace it with the retained exact selection listener.
          detachPresentation();
          detachPresentation = attachPresentation(
            presentation,
            controllerGeneration,
            previous.selection.session.sessionId,
            previous.runtime,
            previous.conversation,
          );
          await continuity.coordinator.withTransition(options.identity.continuityId!, async () => {
            await selectContinuitySession(continuityPaths, options.identity, {
              surface: "chat",
              sessionId: previous.selection.session.sessionId,
            });
            await continuity.chatThreads.selectActiveThread(
              previous.selection.session.sessionId,
              previous.selection.session.sessionId,
            );
          });
          throw error;
        } finally {
          activationInProgress = false;
        }
      });
    const next = activation.then(run, run);
    activation = next.catch(() => undefined);
    return next;
  }

  async function publishExactTavernStableContext(targetRuntime: RuntimeSession, thread: ChatThread): Promise<void> {
    const worldBookSource = await exactWorldBookSource(thread.worldBookBinding);
    await targetRuntime.publishTavernStableContext?.(
      await materializeTavernStableContext(
        tavernPaths,
        artifacts,
        thread,
        {
          continuityId: options.identity.continuityId!,
          sessionId: targetRuntime.sessionManager.getSessionId(),
          surface: "tavern",
        },
        worldBookSource,
      ),
    );
  }

  async function exactWorldBookSource(
    binding: TavernStableWorldInfoBinding | undefined,
  ): Promise<
    { binding: TavernStableWorldBookBinding; alwaysOnPremise: string } | TavernManagedWorldInfoSource | undefined
  > {
    if (binding === undefined) return undefined;
    if ("source" in binding) return managedWorldInfoResolver.resolve(binding);
    const source = options.worldBook;
    if (
      source === undefined ||
      binding.worldBookId !== source.metadata.worldBookId ||
      binding.revision !== source.metadata.revision ||
      binding.canonicalHash !== source.metadata.canonicalHash ||
      binding.provenance !== "authored"
    ) {
      throw new Error("tavern_stable_context_worldbook_host_source_mismatch");
    }
    return Object.freeze({ binding, alwaysOnPremise: source.book.alwaysOnPremise });
  }

  const server = createServer(async (request, response) => {
    try {
      await handleRequest(request, response);
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: "request_failed" });
      else response.end();
    }
  });

  const port = await listenLoopback(server);
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  const url = `${origin}/#boot=${bootstrap}`;

  async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const requestUrl = new URL(request.url ?? "/", origin);
    if (!isExactLoopbackHost(request, port)) return sendJson(response, 403, { error: "forbidden" });
    setSecurityHeaders(response);
    if (request.method === "OPTIONS") return sendJson(response, 405, { error: "method_not_allowed" });

    if (routeEnabled("events") && request.method === "GET" && requestUrl.pathname === "/events") {
      const active = authenticate(request, false);
      if (active === null) return sendJson(response, 401, { error: "unauthorized" });
      eventStream?.end();
      eventStream = response;
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      response.write("event: ready\ndata: {}\n\n");
      request.on("close", () => {
        if (eventStream === response) eventStream = undefined;
      });
      return;
    }

    if (routeEnabled("bootstrap") && request.method === "POST" && requestUrl.pathname === "/bootstrap") {
      if (!isExactOrigin(request, origin)) return sendJson(response, 403, { error: "forbidden" });
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.token !== "string" ||
        bootstrapConsumed ||
        Date.now() > bootstrapExpiresAtMs ||
        !tokensEqual(body.token, bootstrap)
      ) {
        return sendJson(response, 401, { error: "unauthorized" });
      }
      bootstrapConsumed = true;
      browser = Object.freeze({
        bearer: randomToken(),
        csrf: randomToken(),
        expiresAtMs: Date.now() + BROWSER_TTL_SECONDS * 1_000,
      });
      newChatSelections = new Map();
      chatHandles = new Map();
      response.setHeader(
        "Set-Cookie",
        `gb_dialogue_session=${browser.bearer}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${BROWSER_TTL_SECONDS}`,
      );
      return await sendBootstrap(response);
    }

    // A cookie-authenticated reload has no bootstrap fragment. It can recover
    // precisely this in-memory Host runtime/session, but cannot select another
    // identity, thread, or surface from browser input.
    if (routeEnabled("refresh") && request.method === "GET" && requestUrl.pathname === "/refresh") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return await sendBootstrap(response);
    }

    if (routeEnabled("memories-read") && request.method === "GET" && requestUrl.pathname === "/memories") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      if (options.magicContextMemoryFacade === undefined) return sendJson(response, 404, { error: "not_found" });
      try {
        return sendJson(response, 200, {
          memories: projectMemoryViews(await options.magicContextMemoryFacade.listMemories(memoryContinuityIdentity())),
        });
      } catch {
        return sendJson(response, 503, { error: "memory_unavailable" });
      }
    }
    if (routeEnabled("memories-create") && request.method === "POST" && requestUrl.pathname === "/memories") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      if (options.magicContextMemoryFacade === undefined) return sendJson(response, 404, { error: "not_found" });
      const body = await readJsonBody(request);
      if (!isMemoryCreateRequest(body)) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 201, {
          memory: projectMemoryView(
            await options.magicContextMemoryFacade.createMemory({ ...memoryContinuityIdentity(), ...body }),
          ),
        });
      } catch {
        return sendJson(response, 503, { error: "memory_unavailable" });
      }
    }
    const memoryLifecycle = memoryLifecycleRequest(requestUrl.pathname, request.method ?? "", awaitMemoryMutation);
    if (memoryLifecycle !== undefined) return memoryLifecycle(response, request);

    if (
      chatManagementRouteEnabled("chat-draft-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/chat-draft"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, await chatDraftStore().read(chatDraftScope()));
    }
    if (
      chatManagementRouteEnabled("chat-draft-save") &&
      request.method === "PUT" &&
      requestUrl.pathname === "/chat-draft"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isChatDraftUpdate(body)) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 200, await chatDraftStore().update({ scope: chatDraftScope(), ...body }));
      } catch (error) {
        return sendJson(
          response,
          error instanceof Error && error.message === "chat_draft_revision_conflict" ? 409 : 400,
          { error: "chat_draft_rejected" },
        );
      }
    }
    if (
      chatManagementRouteEnabled("chat-draft-discard") &&
      request.method === "DELETE" &&
      requestUrl.pathname === "/chat-draft"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      const acceptedRequest = isAcceptedDraftClear(body) ? body : undefined;
      const manualRequest = isChatDraftDiscard(body) ? body : undefined;
      const acceptedClear =
        acceptedRequest === undefined ? undefined : acceptedDraftClears.get(acceptedRequest.clearToken);
      if (manualRequest === undefined && (acceptedClear === undefined || acceptedClear.expiresAtMs < Date.now()))
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const result = await chatDraftStore().discard({
          scope: acceptedClear?.scope ?? chatDraftScope(),
          expectedRevision: (acceptedRequest ?? manualRequest)!.expectedRevision,
        });
        if (acceptedRequest !== undefined && acceptedClear !== undefined)
          acceptedDraftClears.delete(acceptedRequest.clearToken);
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(
          response,
          error instanceof Error && error.message === "chat_draft_revision_conflict" ? 409 : 400,
          { error: "chat_draft_rejected" },
        );
      }
    }

    if (
      chatManagementRouteEnabled("chat-management-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/chat-management"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, await chatTitleService().read());
    }
    if (
      chatManagementRouteEnabled("chat-management-rename") &&
      request.method === "PUT" &&
      requestUrl.pathname === "/chat-management/title"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isChatTitleRename(body)) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 200, await chatTitleService().setTitle(body));
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(response, message === "chat_thread_management_revision_conflict" ? 409 : 400, {
          error: message === "chat_thread_management_revision_conflict" ? "chat_title_conflict" : "invalid_request",
        });
      }
    }

    if (
      personaManagementRouteEnabled("persona-management-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/persona-management"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, { persona: await personas.read() });
    }
    if (
      personaManagementRouteEnabled("persona-management-create") &&
      request.method === "POST" &&
      requestUrl.pathname === "/persona-management"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isPersonaCreate(body)) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 201, { persona: await personas.create(body) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(response, message === "persona_already_exists" ? 409 : 400, {
          error: message === "persona_already_exists" ? "persona_already_exists" : "invalid_request",
        });
      }
    }

    if (
      contentManagementRouteEnabled("scenario-management-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/scenario-management"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, { scenario: await scenarios.read() });
    }
    if (
      contentManagementRouteEnabled("scenario-management-create") &&
      request.method === "POST" &&
      requestUrl.pathname === "/scenario-management"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isScenarioCreate(body)) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 201, { scenario: await scenarios.create(body) });
      } catch (error) {
        return sendJson(response, error instanceof Error && error.message === "scenario_already_exists" ? 409 : 400, {
          error:
            error instanceof Error && error.message === "scenario_already_exists"
              ? "scenario_already_exists"
              : "invalid_request",
        });
      }
    }
    if (
      contentManagementRouteEnabled("greeting-management-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/greeting-management"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, { greetingSet: await greetings.read() });
    }
    if (
      contentManagementRouteEnabled("greeting-management-create") &&
      request.method === "POST" &&
      requestUrl.pathname === "/greeting-management"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isGreetingCreate(body)) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 201, { greetingSet: await greetings.create(body) });
      } catch (error) {
        return sendJson(response, error instanceof Error && error.message === "greeting_already_exists" ? 409 : 400, {
          error:
            error instanceof Error && error.message === "greeting_already_exists"
              ? "greeting_already_exists"
              : "invalid_request",
        });
      }
    }

    if (
      managementRouteEnabled("settings-profiles") &&
      request.method === "GET" &&
      requestUrl.pathname === "/settings/profiles"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      // The fixed configuration is informational only: there is no browser
      // choice to persist, activate, or apply to a running Companion runtime.
      const [chat, game] = await Promise.all([modelProfiles.read("chat"), modelProfiles.read("game")]);
      return sendJson(response, 200, {
        chat: { modelId: chat.modelId, thinkingLevel: chat.thinkingLevel },
        game: { modelId: game.modelId, thinkingLevel: game.thinkingLevel },
      });
    }
    if (managementRouteEnabled("game-status") && request.method === "GET" && requestUrl.pathname === "/game/status") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      // projectGameStatus is the only browser projection: it rejects malformed
      // lifecycle input and omits all adapter, identity, world, and receipt IDs.
      const lifecycleSnapshot =
        options.gameStatusProvider?.() ?? options.connectedIntegrationCompanion?.lifecycleSnapshot();
      return sendJson(response, 200, projectGameStatus(lifecycleSnapshot));
    }

    if (routeEnabled("library") && request.method === "GET" && requestUrl.pathname === "/library") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      const handles = new Map<string, ExpiringCompanion>();
      const companions = (await library.listCompanions()).map((companion) => {
        const handle = randomToken();
        const rowKey = `${companion.companionId}\u0000${companion.continuityId}`;
        let row = companionRowReferences.get(rowKey);
        if (row === undefined) {
          row = Object.freeze({
            companionId: companion.companionId,
            continuityId: companion.continuityId,
            rowRef: randomToken(),
          });
          companionRowReferences.set(rowKey, row);
        }
        handles.set(
          handle,
          Object.freeze({
            companionId: companion.companionId,
            continuityId: companion.continuityId,
            expiresAtMs: Date.now() + NEW_CHAT_SELECTION_TTL_MS,
          }),
        );
        return Object.freeze({ handle, rowRef: row.rowRef, name: companion.name });
      });
      companionDetailHandles = handles;
      return sendJson(response, 200, { companions });
    }
    const companionDetailMatch = /^\/library\/([A-Za-z0-9_-]{43})$/u.exec(requestUrl.pathname);
    if (
      characterDetailRouteEnabled("character-detail-read") &&
      request.method === "GET" &&
      companionDetailMatch !== null
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      const handle = companionDetailMatch[1]!;
      const target = companionDetailHandles.get(handle);
      // Delete before the asynchronous domain read: a valid handle has exactly
      // one attempt and cannot be replayed after success or a failed-closed read.
      companionDetailHandles.delete(handle);
      if (target === undefined || target.expiresAtMs < Date.now())
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const targetPaths = resolveTavernPaths(runtime.paths, {
          playerId: options.identity.playerId,
          companionId: target.companionId,
          continuityId: target.continuityId,
        });
        return sendJson(response, 200, await createCompanionDetailService(targetPaths, artifacts).read());
      } catch {
        return sendJson(response, 400, { error: "invalid_request" });
      }
    }
    if (routeEnabled("manage-chats") && request.method === "GET" && requestUrl.pathname === "/manage-chats") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      const active = await library.activeChatSelection();
      const handles = new Map<string, ExpiringChat>();
      const chat = (thread: ChatThread): object => {
        const handle = randomToken();
        handles.set(
          handle,
          Object.freeze({
            chatThreadId: thread.chatThreadId,
            chatSurfaceSessionId: thread.chatSurfaceSessionId,
            expiresAtMs: Date.now() + NEW_CHAT_SELECTION_TTL_MS,
          }),
        );
        return { handle, ...chatMetadata(thread) };
      };
      const chats = await library.listChats();
      const projected = chats.map(chat);
      chatHandles = handles;
      const activeHandle =
        active === null
          ? null
          : ([...handles].find(
              ([, value]) =>
                value.chatThreadId === active.chatThreadId &&
                value.chatSurfaceSessionId === active.chatSurfaceSessionId,
            )?.[0] ?? null);
      return sendJson(response, 200, { chats: projected, activeHandle });
    }
    if (
      chatLifecycleRouteEnabled("chat-lifecycle-active-list") &&
      request.method === "GET" &&
      requestUrl.pathname === "/chat-lifecycle"
    ) {
      const authenticated = authenticate(request, false);
      if (authenticated === null) return sendJson(response, 401, { error: "unauthorized" });
      const handles = new Map<string, ExpiringLifecycleHandle>();
      const rows = (await lifecycle.listInternal("active")).map((result) => {
        const handle = randomToken();
        handles.set(
          handle,
          Object.freeze({
            ...result.binding,
            companionId: options.identity.companionId,
            continuityId: options.identity.continuityId!,
            managementRevision: result.metadata.managementRevision,
            browserBearer: authenticated.bearer,
            expiresAtMs: Date.now() + NEW_CHAT_SELECTION_TTL_MS,
          }),
        );
        return Object.freeze({ handle, ...result.metadata });
      });
      lifecycleHandles = handles;
      return sendJson(response, 200, { chats: rows });
    }
    if (
      chatLifecycleRouteEnabled("chat-lifecycle-archive") &&
      request.method === "POST" &&
      requestUrl.pathname === "/chat-lifecycle/archive"
    ) {
      const authenticated = authenticate(request, true);
      if (authenticated === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isLifecycleArchiveRequest(body)) return sendJson(response, 400, { error: "invalid_request" });
      const target = lifecycleHandles.get(body.handle);
      // Consume before async work: both successful and rejected attempts are
      // single-use and cannot be redirected or replayed after a race.
      lifecycleHandles.delete(body.handle);
      if (
        target === undefined ||
        target.expiresAtMs < Date.now() ||
        target.browserBearer !== authenticated.bearer ||
        target.managementRevision !== body.expectedManagementRevision
      )
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const archived = await lifecycle.archive({
          chatThreadId: target.chatThreadId,
          chatSurfaceSessionId: target.chatSurfaceSessionId,
          expectedManagementRevision: body.expectedManagementRevision,
        });
        return sendJson(response, 200, { chat: archived });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(
          response,
          [
            "chat_thread_active_selection",
            "chat_thread_game_return_origin_protected",
            "chat_thread_management_revision_conflict",
          ].includes(message)
            ? 409
            : 400,
          { error: "chat_lifecycle_archive_rejected" },
        );
      }
    }
    if (routeEnabled("open-chat") && request.method === "POST" && requestUrl.pathname === "/open-chat") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.chatHandle !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(body.chatHandle)
      )
        return sendJson(response, 400, { error: "invalid_request" });
      const target = chatHandles.get(body.chatHandle);
      if (target === undefined || target.expiresAtMs < Date.now())
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const state = await library.openChat(target.chatThreadId, target.chatSurfaceSessionId);
        if (state.thread.chatThreadId !== selection.session.sessionId) await activateExactChat(state);
        chatHandles.delete(body.chatHandle);
        return sendJson(response, 200, { chat: chatMetadata(state.thread) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(
          response,
          ["chat_thread_not_found", "chat_thread_surface_mismatch", "tavern_chat_scope_mismatch"].includes(message)
            ? 404
            : 400,
          { error: "chat_open_failed" },
        );
      }
    }
    if (routeEnabled("new-companion-read") && request.method === "GET" && requestUrl.pathname === "/new-companion") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      // The active companion is shown only as a non-editable comparison. A
      // direct creation request always provisions a separate Host namespace.
      return sendJson(response, 200, {
        activeCompanionId: options.identity.companionId,
        activeProfileId: runtime.identityProfile.profileId,
        activeProfileRevision: runtime.identityProfile.revision,
      });
    }
    if (routeEnabled("new-companion") && request.method === "POST" && requestUrl.pathname === "/new-companion") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.name !== "string")
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const created = await provisionDirectNewCompanion(runtime.paths.root, options.identity.playerId, body.name);
        return sendJson(response, 201, { companion: companionMetadata(created.companion) });
      } catch {
        return sendJson(response, 400, { error: "invalid_request" });
      }
    }
    if (
      routeEnabled("new-chat-selections") &&
      request.method === "GET" &&
      requestUrl.pathname === "/new-chat/selections"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, await selectionCatalog());
    }
    if (routeEnabled("new-chat") && request.method === "POST" && requestUrl.pathname === "/new-chat") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      const requestValue = newChatRequest(body, newChatSelections);
      if (requestValue === null) return sendJson(response, 400, { error: "invalid_request" });
      let prepared: SurfaceSession | undefined;
      try {
        const id = randomToken();
        prepared = await prepareChatSurface(continuityPaths, options.identity, id);
        const state = await library.createNewChat({ chatThreadId: id, chatSurfaceSessionId: id, ...requestValue });
        // Creation is inert: it obtains its own empty Pi partition only when
        // the runtime owner explicitly activates this exact pair.
        const chatHandle = randomToken();
        chatHandles.set(
          chatHandle,
          Object.freeze({
            chatThreadId: state.thread.chatThreadId,
            chatSurfaceSessionId: state.thread.chatSurfaceSessionId,
            expiresAtMs: Date.now() + NEW_CHAT_SELECTION_TTL_MS,
          }),
        );
        return sendJson(response, 201, {
          chat: { handle: chatHandle, ...chatMetadata(state.thread) },
          opening: state.messages.map((message) => ({ role: message.role, text: message.text })),
        });
      } catch (error) {
        if (prepared !== undefined) {
          try {
            // Thread creation and surface preparation are one recoverable
            // transaction: a failed artifact selection must not leave a
            // player-visible continuity row with no exact ChatThread.
            await rollbackChatSurface(continuityPaths, options.identity, {
              session: prepared,
              created: true,
              previousActiveSessionId: null,
            });
          } catch (compensationError) {
            throw new AggregateError([error, compensationError], "new_chat_compensation_failed");
          }
        }
        return sendJson(response, 400, { error: "invalid_request" });
      }
    }
    if (
      worldInfoManagementRouteEnabled("managed-world-info-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/managed-world-info"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      return sendJson(response, 200, { items: await managedWorldInfo.list() });
    }
    if (
      worldInfoManagementRouteEnabled("managed-world-info-create") &&
      request.method === "POST" &&
      requestUrl.pathname === "/managed-world-info"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      try {
        return sendJson(response, 201, { item: await managedWorldInfo.create(body as never) });
      } catch (error) {
        return sendJson(response, error instanceof Error && error.message === "world_info_already_exists" ? 409 : 400, {
          error: "invalid_request",
        });
      }
    }
    if (
      worldInfoManagementRouteEnabled("managed-world-info-bindings-read") &&
      request.method === "GET" &&
      requestUrl.pathname === "/managed-world-info/bindings"
    ) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      const active = await library.activeChatSelection();
      const state =
        active === null ? undefined : await library.openChat(active.chatThreadId, active.chatSurfaceSessionId);
      return sendJson(response, 200, {
        items: await managedWorldInfo.list(),
        activeChat:
          state === undefined
            ? null
            : {
                chatThreadId: state.thread.chatThreadId,
                chatSurfaceSessionId: state.thread.chatSurfaceSessionId,
                updatedAtMs: state.thread.updatedAtMs,
              },
        selectedPublicTitle:
          state?.thread.worldBookBinding !== undefined && "source" in state.thread.worldBookBinding
            ? state.thread.worldBookBinding.publicTitle
            : null,
      });
    }
    if (
      worldInfoManagementRouteEnabled("managed-world-info-attach") &&
      request.method === "POST" &&
      requestUrl.pathname === "/managed-world-info/attach"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isManagedWorldInfoAttach(body)) return sendJson(response, 400, { error: "invalid_request" });
      const active = await library.activeChatSelection();
      if (
        active === null ||
        active.chatThreadId !== body.chatThreadId ||
        active.chatSurfaceSessionId !== body.chatSurfaceSessionId ||
        selection.session.sessionId !== body.chatSurfaceSessionId
      )
        return sendJson(response, 409, { error: "managed_world_info_chat_not_active" });
      try {
        const binding = body.publicTitle === null ? undefined : await managedWorldInfoResolver.bind(body.publicTitle);
        const state = await threads.setWorldBookBinding!({
          chatThreadId: body.chatThreadId,
          chatSurfaceSessionId: body.chatSurfaceSessionId,
          companionId: options.identity.companionId,
          continuityId: options.identity.continuityId!,
          expectedUpdatedAtMs: body.expectedUpdatedAtMs,
          ...(binding === undefined ? {} : { binding }),
        });
        await publishExactTavernStableContext(runtime, state.thread);
        return sendJson(response, 200, {
          selectedPublicTitle:
            state.thread.worldBookBinding !== undefined && "source" in state.thread.worldBookBinding
              ? state.thread.worldBookBinding.publicTitle
              : null,
          chatThreadId: state.thread.chatThreadId,
          chatSurfaceSessionId: state.thread.chatSurfaceSessionId,
          updatedAtMs: state.thread.updatedAtMs,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(
          response,
          ["chat_thread_revision_conflict", "chat_thread_worldbook_locked"].includes(message) ? 409 : 400,
          { error: "managed_world_info_attach_rejected" },
        );
      }
    }
    const managedWorldInfoMatch = /^\/managed-world-info\/([^/]+)$/u.exec(requestUrl.pathname);
    if (
      worldInfoManagementRouteEnabled("managed-world-info-update") &&
      request.method === "PUT" &&
      managedWorldInfoMatch !== null
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      try {
        return sendJson(response, 200, {
          item: await managedWorldInfo.update(
            decodeURIComponent(managedWorldInfoMatch[1]!),
            (await readJsonBody(request)) as UpdateWorldInfoRequest,
          ),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(
          response,
          message === "world_info_revision_conflict" ? 409 : message === "world_info_not_found" ? 404 : 400,
          { error: "invalid_request" },
        );
      }
    }

    if (routeEnabled("worldbook-read") && request.method === "GET" && requestUrl.pathname === "/worldbook") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      const active = await library.activeChatSelection();
      const state =
        active === null ? undefined : await library.openChat(active.chatThreadId, active.chatSurfaceSessionId);
      const selected = state?.thread.worldBookBinding;
      return sendJson(response, 200, {
        // Deliberately player-readable metadata only: the browser does not
        // receive the opaque artifact id, revision, hash, body, or provenance.
        bindings: isWorldBookBound
          ? [
              {
                bindingId: "active",
                label: "World Info",
                selected:
                  selected !== undefined &&
                  !("source" in selected) &&
                  selected.worldBookId === options.worldBook!.metadata.worldBookId &&
                  selected.revision === options.worldBook!.metadata.revision &&
                  selected.canonicalHash === options.worldBook!.metadata.canonicalHash,
              },
            ]
          : [],
        activeChat:
          state === undefined
            ? null
            : {
                chatThreadId: state.thread.chatThreadId,
                chatSurfaceSessionId: state.thread.chatSurfaceSessionId,
                updatedAtMs: state.thread.updatedAtMs,
              },
      });
    }
    if (routeEnabled("worldbook-bind") && request.method === "POST" && requestUrl.pathname === "/worldbook") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 4 ||
        !isTavernId(body.chatThreadId) ||
        !isTavernId(body.chatSurfaceSessionId) ||
        !isTimestamp(body.expectedUpdatedAtMs) ||
        (body.bindingId !== null && body.bindingId !== "active")
      )
        return sendJson(response, 400, { error: "invalid_request" });
      const active = await library.activeChatSelection();
      if (
        active === null ||
        active.chatThreadId !== body.chatThreadId ||
        active.chatSurfaceSessionId !== body.chatSurfaceSessionId ||
        selection.session.sessionId !== body.chatSurfaceSessionId
      )
        return sendJson(response, 409, { error: "worldbook_chat_not_active" });
      if (!isWorldBookBound && body.bindingId !== null)
        return sendJson(response, 409, { error: "worldbook_binding_unavailable" });
      try {
        const threadStore = createChatThreadStore(runtime.paths.runtimeCwd, runtime.identityKey);
        if (threadStore.setWorldBookBinding === undefined) throw new Error("worldbook_binding_unavailable");
        const state = await threadStore.setWorldBookBinding({
          chatThreadId: body.chatThreadId,
          chatSurfaceSessionId: body.chatSurfaceSessionId,
          companionId: options.identity.companionId,
          continuityId: options.identity.continuityId!,
          expectedUpdatedAtMs: body.expectedUpdatedAtMs,
          ...(body.bindingId === null
            ? {}
            : { binding: { ...options.worldBook!.metadata, provenance: "authored" as const } }),
        });
        await runtime.publishTavernStableContext?.(
          await materializeTavernStableContext(
            tavernPaths,
            artifacts,
            state.thread,
            {
              continuityId: options.identity.continuityId!,
              sessionId: runtime.sessionManager.getSessionId(),
              surface: "tavern",
            },
            await exactWorldBookSource(state.thread.worldBookBinding),
          ),
        );
        return sendJson(response, 200, {
          bindingId: state.thread.worldBookBinding === undefined ? null : "active",
          chatThreadId: state.thread.chatThreadId,
          chatSurfaceSessionId: state.thread.chatSurfaceSessionId,
          updatedAtMs: state.thread.updatedAtMs,
          ...(state.thread.worldBookBinding === undefined
            ? {}
            : {
                revision: state.thread.worldBookBinding.revision,
                canonicalHash: state.thread.worldBookBinding.canonicalHash,
              }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(
          response,
          ["chat_thread_revision_conflict", "chat_thread_worldbook_locked"].includes(message) ? 409 : 400,
          { error: "worldbook_binding_rejected" },
        );
      }
    }
    if (
      routeEnabled("interchange-import") &&
      request.method === "POST" &&
      requestUrl.pathname === "/interchange/import"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 1 || typeof body.document !== "string")
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const document = decodeSafeInterchange(body.document);
        // Inbound interchange stays inert and browser-visible only as an audit
        // projection. It never creates a binding, thread, or runtime context.
        return sendJson(response, 201, {
          format: document.format,
          kind: document.kind,
          canonicalHash: document.canonicalHash,
          dispositions: document.dispositions,
          imported: "inert_unbound",
        });
      } catch {
        return sendJson(response, 400, { error: "invalid_interchange" });
      }
    }
    if (
      routeEnabled("interchange-chat-export") &&
      request.method === "POST" &&
      requestUrl.pathname === "/interchange/chat/export"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 0)
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const state = await threads.resumeThread(selection.session.sessionId, selection.session.sessionId);
        // JSONL-compatible structured export is delivered only after explicit
        // CSRF-protected user action; no raw Pi or private Host data is used.
        return sendJson(response, 200, { document: exportSafeChat(state.thread.chatThreadId, state.messages) });
      } catch {
        return sendJson(response, 404, { error: "not_found" });
      }
    }
    if (
      routeEnabled("interchange-worldbook-export") &&
      request.method === "POST" &&
      requestUrl.pathname === "/interchange/worldbook/export"
    ) {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 0 || options.worldBook === undefined)
        return sendJson(response, 400, { error: "invalid_request" });
      return sendJson(response, 200, { document: exportSafeWorldBook(options.worldBook.book) });
    }
    if (routeEnabled("imports") && request.method === "POST" && requestUrl.pathname === "/imports") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 2 ||
        typeof body.importId !== "string" ||
        typeof body.card !== "string"
      )
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const result = await imports.import(body.importId, body.card);
        return sendJson(response, 201, importMetadata(result));
      } catch {
        return sendJson(response, 400, { error: "invalid_import" });
      }
    }
    const reviewMatch = /^\/imports\/([A-Za-z0-9_-]{1,128})\/review$/u.exec(requestUrl.pathname);
    if (routeEnabled("import-review") && reviewMatch !== null && request.method === "POST") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 2 ||
        !Array.isArray(body.reviewedFields) ||
        !body.reviewedFields.every(isPlayerReviewKey) ||
        typeof body.approvedAtMs !== "number"
      )
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const imported = await imports.read(reviewMatch[1]!);
        const eligible = imported.candidate.artifact.fields.filter(
          (field) => field.eligibility === "profile_eligible_after_explicit_review",
        );
        const reviewedFields = body.reviewedFields
          .map((key) => eligible[Number.parseInt(key.slice("field-".length), 10) - 1]?.field)
          .filter((field): field is string => field !== undefined);
        if (
          reviewedFields.length !== body.reviewedFields.length ||
          new Set(reviewedFields).size !== reviewedFields.length
        )
          return sendJson(response, 400, { error: "invalid_request" });
        const review = await imports.recordReview(reviewMatch[1]!, { reviewedFields, approvedAtMs: body.approvedAtMs });
        return sendJson(response, 201, reviewMetadata(review.artifact));
      } catch {
        return sendJson(response, 400, { error: "invalid_review" });
      }
    }
    if (routeEnabled("import-review-read") && reviewMatch !== null && request.method === "GET") {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      try {
        return sendJson(response, 200, reviewMetadata((await imports.readReview(reviewMatch[1]!)).artifact));
      } catch {
        return sendJson(response, 404, { error: "not_found" });
      }
    }
    const confirmMatch = /^\/imports\/([A-Za-z0-9_-]{1,128})\/confirm-new-companion$/u.exec(requestUrl.pathname);
    if (routeEnabled("import-confirm-new-companion") && confirmMatch !== null && request.method === "POST") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (!isRecord(body) || Object.keys(body).length !== 0)
        return sendJson(response, 400, { error: "invalid_request" });
      try {
        const imported = await imports.read(confirmMatch[1]!);
        const created = await provisionNewCompanion(
          runtime.paths.root,
          options.identity.playerId,
          imported.candidate.artifact,
          await imports.confirmedReview(confirmMatch[1]!),
          threads,
        );
        return sendJson(response, 201, { companion: companionMetadata(created.companion) });
      } catch {
        return sendJson(response, 400, { error: "confirmation_required" });
      }
    }
    const exportMatch = /^\/imports\/([A-Za-z0-9_-]{1,128})\/export$/u.exec(requestUrl.pathname);
    if (routeEnabled("import-export") && request.method === "GET" && exportMatch !== null) {
      if (authenticate(request, false) === null) return sendJson(response, 401, { error: "unauthorized" });
      try {
        return sendJson(response, 200, importMetadata(await imports.export(exportMatch[1]!)));
      } catch {
        return sendJson(response, 404, { error: "not_found" });
      }
    }

    if (routeEnabled("message") && request.method === "POST" && requestUrl.pathname === "/message") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      try {
        const input = validateDialogueInput(body);
        let clearToken: string | undefined;
        // Capture the complete owner tuple at HTTP acceptance, not when the
        // controller later invokes beforeQueue after an asynchronous boundary.
        const origin = Object.freeze({
          controller,
          conversation,
          generation: controllerGeneration,
          sessionId: selection.session.sessionId,
          ownerRuntime: runtime,
          draftScope: chatDraftScope(),
        });
        const result = await controller.submit(input, async (accepted) => {
          await options.internalDialogueWebTestHooks?.beforeAppendPlayer?.();
          await withSelectionMutation(async () => {
            if (!isExactActiveOrigin(origin)) throw new Error("dialogue_selection_changed");
            await origin.conversation.appendPlayer({
              messageId: accepted.clientMessageId,
              text: accepted.text,
              occurredAtMs: Date.now(),
            });
            if (!isExactActiveOrigin(origin)) throw new Error("dialogue_selection_changed");
            clearToken = randomToken();
            acceptedDraftClears.set(
              clearToken,
              Object.freeze({ scope: origin.draftScope, expiresAtMs: Date.now() + MESSAGE_DRAFT_CLEAR_TTL_MS }),
            );
            // This is the only grant point. It follows the durable player
            // append and binds to the exact controller generation. The player
            // must explicitly opt in on this exact submitted turn; the model
            // never self-asserts a grant in a tool payload.
            if (accepted.memoryDelegation === true) grantDelegatedMemoryCreate(origin, accepted.clientMessageId);
          });
        });
        return sendJson(response, 202, {
          accepted: result === "accepted",
          duplicate: result === "duplicate",
          ...(clearToken === undefined ? {} : { clearToken }),
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        return sendJson(
          response,
          message === "dialogue_queue_full" ? 429 : message === "dialogue_selection_changed" ? 409 : 400,
          {
            error:
              message === "dialogue_queue_full"
                ? "busy"
                : message === "dialogue_selection_changed"
                  ? "selection_changed"
                  : "invalid_request",
          },
        );
      }
    }

    if (routeEnabled("retry-response") && request.method === "POST" && requestUrl.pathname === "/retry-response") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const retry = retryResponseRequest(await readJsonBody(request));
      if (retry === null) return sendJson(response, 400, { error: "invalid_request" });
      try {
        return sendJson(response, 200, { receipt: await conversation.retryResponse(retry) });
      } catch (error) {
        const message = error instanceof Error ? error.message : "";
        if (
          [
            "tavern_retry_external_effect",
            "tavern_retry_game_effect",
            "tavern_retry_binding_mismatch",
            "tavern_retry_response_ineligible",
            "tavern_retry_unknown_target",
            "tavern_retry_stale_revision",
            "tavern_retry_conflicting_revision",
          ].includes(message)
        )
          return sendJson(response, 409, { error: message });
        return sendJson(response, 400, { error: "invalid_request" });
      }
    }

    if (routeEnabled("stop") && request.method === "POST" && requestUrl.pathname === "/stop") {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      const body = await readJsonBody(request);
      if (
        !isRecord(body) ||
        Object.keys(body).length !== 1 ||
        typeof body.clientStopId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(body.clientStopId)
      ) {
        return sendJson(response, 400, { error: "invalid_request" });
      }
      await controller.stop();
      await options.stopVoice?.();
      return sendJson(response, 202, { accepted: true });
    }

    if (routeEnabled("static") && request.method === "GET")
      return serveStatic(requestUrl.pathname, response, staticDir);
    return sendJson(response, 404, { error: "not_found" });
  }

  function routeEnabled(routeId: string): boolean {
    return selectedL3RouteEnabled(routeId);
  }
  function grantDelegatedMemoryCreate(
    origin: Readonly<{
      controller: DialogueController;
      generation: number;
      sessionId: string;
      ownerRuntime: RuntimeSession;
    }>,
    turnId: string,
  ): void {
    if (
      options.magicContextMemoryFacade === undefined ||
      !isExactActiveOrigin({
        controller: origin.controller,
        conversation,
        generation: origin.generation,
        sessionId: origin.sessionId,
        ownerRuntime: origin.ownerRuntime,
      })
    )
      return;
    delegatedMemoryCreates.set(delegationKey(origin.generation, turnId), {
      controller: origin.controller,
      generation: origin.generation,
      sessionId: origin.sessionId,
      runtime: origin.ownerRuntime,
      continuityId: options.identity.continuityId!,
      turnId,
      expiresAtMs: Date.now() + CURRENT_TURN_MEMORY_DELEGATION_TTL_MS,
    });
  }
  /** Continuity authority is captured at Host startup, never from browser input. */
  function memoryContinuityIdentity(): Readonly<{ continuityId: string }> {
    return Object.freeze({ continuityId: options.identity.continuityId! });
  }
  function memoryLifecycleRequest(
    pathname: string,
    method: string,
    invoke: (body: unknown) => Promise<{ status: number; body: object }>,
  ): ((response: ServerResponse, request: IncomingMessage) => Promise<void>) | undefined {
    const route =
      pathname === "/memories/update"
        ? "memories-update"
        : pathname === "/memories/archive"
          ? "memories-archive"
          : pathname === "/memories/restore"
            ? "memories-restore"
            : pathname === "/memories/pin"
              ? "memories-pin"
              : pathname === "/memories/unpin"
                ? "memories-unpin"
                : pathname === "/memories/merge"
                  ? "memories-merge"
                  : pathname === "/memories/delete-entry"
                    ? "memories-delete-entry"
                    : pathname === "/memories/exclude-source"
                      ? "memories-exclude-source"
                      : undefined;
    if (route === undefined || method !== "POST" || !routeEnabled(route)) return undefined;
    return async (response, request) => {
      if (authenticate(request, true) === null) return sendJson(response, 401, { error: "unauthorized" });
      if (options.magicContextMemoryFacade === undefined) return sendJson(response, 404, { error: "not_found" });
      const body = await readJsonBody(request);
      if (!isRecord(body)) return sendJson(response, 400, { error: "invalid_request" });
      const operation = route.slice("memories-".length);
      const result = await invoke({ ...body, operation });
      return sendJson(response, result.status, result.body);
    };
  }
  async function awaitMemoryMutation(body: unknown): Promise<{ status: number; body: object }> {
    const facade = options.magicContextMemoryFacade;
    if (facade === undefined) return { status: 404, body: { error: "not_found" } };
    const identity = memoryContinuityIdentity();
    try {
      if (isMemoryUpdateRequest(body))
        return {
          status: 200,
          body: {
            memory: projectMemoryView(
              await facade.updateMemory({
                ...identity,
                stateToken: body.stateToken,
                expectedStateToken: body.stateToken,
                content: body.content,
              }),
            ),
          },
        };
      if (isMemoryStateRequest(body)) {
        const operation = body.operation;
        const memory =
          operation === "archive"
            ? await facade.archiveMemory({
                ...identity,
                stateToken: body.stateToken,
                expectedStateToken: body.stateToken,
              })
            : operation === "restore"
              ? await facade.restoreMemory({
                  ...identity,
                  stateToken: body.stateToken,
                  expectedStateToken: body.stateToken,
                })
              : operation === "pin"
                ? await facade.pinMemory({
                    ...identity,
                    stateToken: body.stateToken,
                    expectedStateToken: body.stateToken,
                  })
                : operation === "unpin"
                  ? await facade.unpinMemory({
                      ...identity,
                      stateToken: body.stateToken,
                      expectedStateToken: body.stateToken,
                    })
                  : undefined;
        if (memory !== undefined) return { status: 200, body: { memory: projectMemoryView(memory) } };
        if (operation === "delete-entry") {
          await facade.deleteEntry({ ...identity, stateToken: body.stateToken, expectedStateToken: body.stateToken });
          return { status: 200, body: { deleted: true } };
        }
      }
      if (isMemoryMergeRequest(body))
        return {
          status: 200,
          body: {
            memory: projectMemoryView(
              await facade.mergeMemory({
                ...identity,
                stateToken: body.stateToken,
                expectedStateToken: body.stateToken,
                targetStateToken: body.targetStateToken,
              }),
            ),
          },
        };
      if (isMemoryExcludeSourceRequest(body)) {
        await facade.excludeSource({
          ...identity,
          stateToken: body.stateToken,
          expectedStateToken: body.stateToken,
          ...(body.sourceRef === undefined ? {} : { sourceRef: body.sourceRef }),
        });
        return { status: 200, body: { excluded: true } };
      }
      return { status: 400, body: { error: "invalid_request" } };
    } catch (error) {
      return {
        status: isMemoryRevisionConflict(error) ? 409 : 503,
        body: { error: isMemoryRevisionConflict(error) ? "memory_revision_conflict" : "memory_unavailable" },
      };
    }
  }
  function managementRouteEnabled(routeId: string): boolean {
    return settingsManagementRouteEnabled(routeId);
  }
  function chatDraftScope(): ChatDraftScope {
    return Object.freeze({
      chatThreadId: selection.session.sessionId,
      chatSurfaceSessionId: selection.session.sessionId,
      companionId: options.identity.companionId,
      continuityId: options.identity.continuityId!,
    });
  }
  function chatDraftStore() {
    return createChatDraftStore(runtime.paths.root);
  }

  function chatTitleService() {
    const store = createChatThreadStore(runtime.paths.runtimeCwd, runtime.identityKey);
    if (store.renameThreadTitle === undefined) throw new Error("chat_thread_title_management_unavailable");
    return createChatTitleManagementService(
      { resumeThread: store.resumeThread, renameThreadTitle: store.renameThreadTitle },
      {
        chatThreadId: selection.session.sessionId,
        chatSurfaceSessionId: selection.session.sessionId,
      },
    );
  }

  async function sendBootstrap(response: ServerResponse): Promise<void> {
    const draft = await chatDraftStore().read(chatDraftScope());
    sendJson(response, 200, {
      csrf: browser!.csrf,
      // The browser must know whether the selected L3 Memory route exists in
      // this Host instance.  Do not expose Memory rows in bootstrap: they are
      // fetched only through the authenticated /memories endpoint.
      memoryManagement: { available: options.magicContextMemoryFacade !== undefined },
      tavern: selectedL3BootstrapModel(),
      settings: selectedSettingsManagementBootstrapModel(),
      chatManagement: selectedChatManagementBootstrapModel(),
      chatLifecycle: selectedChatLifecycleBootstrapModel(),
      personaManagement: selectedPersonaManagementBootstrapModel(),
      contentManagement: selectedContentManagementBootstrapModel(),
      worldInfoManagement: selectedWorldInfoManagementBootstrapModel(),
      companion: { name: runtime.profile.identity.name },
      session: { id: selection.session.sessionId, surface: selection.session.surface },
      continuity: { id: options.identity.continuityId ?? null },
      transcript: conversation.bootstrapTranscript().map((entry) => ({
        entryId: entry.messageId,
        role: entry.role,
        text: entry.text,
        occurredAtMs: entry.occurredAtMs,
      })),
      draft,
      worldBook: isWorldBookBound
        ? { worldBookId: options.worldBook!.metadata.worldBookId, revision: options.worldBook!.metadata.revision }
        : null,
    });
  }

  async function selectionCatalog(): Promise<unknown> {
    const handles = new Map<string, ExpiringSelection>();
    const handle = (selection: NewChatSelection): string => {
      const value = randomToken();
      handles.set(
        value,
        Object.freeze({ selection: Object.freeze(selection), expiresAtMs: Date.now() + NEW_CHAT_SELECTION_TTL_MS }),
      );
      return value;
    };
    const personas = await listRevisionArtifacts<UserPersona>(
      runtime.paths.root,
      join(tavernPaths.playerRoot, "personas"),
      "personaId",
      (item) => ({
        handle: handle({ personaId: item.personaId }),
        name: item.name,
        ...(item.description === undefined ? {} : { description: item.description }),
      }),
    );
    const scenarios = await listRevisionArtifacts<Scenario>(
      runtime.paths.root,
      join(tavernPaths.companionRoot, "scenarios"),
      "scenarioId",
      (item) => ({
        handle: handle({ scenarioId: item.scenarioId }),
        name: item.name ?? "Scenario",
        preview: item.text.slice(0, 240),
      }),
    );
    const greetings = await listRevisionArtifacts<GreetingSet>(
      runtime.paths.root,
      join(tavernPaths.companionRoot, "greetings"),
      "greetingSetId",
      (item) => ({
        handle: handle({ greetingSetId: item.greetingSetId }),
        ...(item.label === undefined ? {} : { label: item.label }),
        variants: item.variants.map((variant, index) => ({
          handle: handle({ greetingSetId: item.greetingSetId, variantId: variant.variantId }),
          name: variant.label ?? (index === 0 ? "First message" : `Alternative ${index}`),
          preview: variant.text.slice(0, 240),
        })),
      }),
    );
    newChatSelections = handles;
    return { personas, scenarios, greetings };
  }

  function authenticate(request: IncomingMessage, requireCsrf: boolean): BrowserSession | null {
    if (browser === undefined || browser.expiresAtMs < Date.now()) return null;
    if ((requireCsrf && !isExactOrigin(request, origin)) || !isSameSiteFetch(request)) return null;
    const bearer = cookie(request.headers.cookie, "gb_dialogue_session");
    if (bearer === undefined || !tokensEqual(bearer, browser.bearer)) return null;
    if (
      requireCsrf &&
      (typeof request.headers["x-gamebuddy-csrf"] !== "string" ||
        !tokensEqual(request.headers["x-gamebuddy-csrf"], browser.csrf))
    )
      return null;
    return browser;
  }

  return Object.freeze({
    url,
    get runtime(): RuntimeSession {
      return runtime;
    },
    get surfaceSession(): SurfaceSession {
      return selection.session;
    },
    closeAllConnections(): void {
      server.closeAllConnections();
    },
    async close(): Promise<void> {
      if (closed) return;
      // Invalidate first. Any queued callback that reaches its serialized
      // mutation boundary after this point is a no-op.
      closed = true;
      controllerGeneration++;
      browser = undefined;
      delegatedMemoryCreates.clear();
      eventStream?.end();
      detachPresentation();
      detachController();
      controller.close();
      await presentationCommit;
      await withSelectionMutation(async () => undefined);
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      await runtime.clearTavernStableContext?.();
      runtime.clearTavernNarrativeGateMarker?.();
      runtime.session.dispose();
    },
  });
}

type ChatPresentationOwner = {
  generation: number;
  runtime?: RuntimeSession;
  controller?: DialogueController;
};

function createChatPresentationAdmissionProvider(
  owner: ChatPresentationOwner,
  current: () => Readonly<{
    closed: boolean;
    controller: DialogueController;
    generation: number;
    runtime: RuntimeSession;
  }>,
): HostPresentationAdmissionProvider {
  const bindings = new WeakSet<object>();
  const assertCurrent = (binding: HostPresentationBinding): void => {
    const active = current();
    if (
      !bindings.has(binding) ||
      active.closed ||
      owner.controller === undefined ||
      owner.runtime === undefined ||
      active.generation !== owner.generation ||
      active.controller !== owner.controller ||
      active.runtime !== owner.runtime ||
      active.controller.currentTurnId() === undefined
    )
      throw new Error("stale_presentation_admission");
  };
  return Object.freeze({
    capture() {
      const active = current();
      const sourceEventId = active.controller.currentTurnId();
      if (
        active.closed ||
        owner.controller === undefined ||
        owner.runtime === undefined ||
        active.generation !== owner.generation ||
        active.controller !== owner.controller ||
        active.runtime !== owner.runtime ||
        sourceEventId === undefined
      )
        throw new Error("presentation_admission_unbound");
      const hostBinding = Object.freeze({});
      bindings.add(hostBinding);
      return Object.freeze({
        sourceEventId,
        admission: Object.freeze({ hostBinding, assertHostCurrent: assertCurrent }),
      });
    },
  });
}

class DialoguePresentationPort implements CompanionTextPort {
  readonly #listeners = new Set<
    (expression: CompanionTextExpression, admission: PresentationCommitAdmission) => void | Promise<void>
  >();
  public async present(expression: CompanionTextExpression, admission: PresentationCommitAdmission): Promise<void> {
    await Promise.all([...this.#listeners].map(async (listener) => listener(expression, admission)));
  }
  public subscribe(
    listener: (expression: CompanionTextExpression, admission: PresentationCommitAdmission) => void | Promise<void>,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string" || address.address !== LOOPBACK_HOST)
    throw new Error("dialogue_loopback_bind_failed");
  return address.port;
}

async function serveStatic(pathname: string, response: ServerResponse, staticDir: string): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  if (!/^[A-Za-z0-9._/-]{1,512}$/.test(relative) || relative.includes(".."))
    return sendJson(response, 404, { error: "not_found" });
  try {
    const path = join(staticDir, relative);
    const content = await readFile(path);
    const type =
      extname(path) === ".js"
        ? "text/javascript; charset=utf-8"
        : extname(path) === ".css"
          ? "text/css; charset=utf-8"
          : "text/html; charset=utf-8";
    response.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(content);
  } catch {
    sendJson(response, 404, { error: "not_found" });
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:;|$)/i.test(request.headers["content-type"] ?? ""))
    throw new Error("invalid_content_type");
  const parts: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += part.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8")) as unknown;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'none'; connect-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cache-Control", "no-store");
}
function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(body));
}
function isExactLoopbackHost(request: IncomingMessage, port: number): boolean {
  return request.headers.host === `${LOOPBACK_HOST}:${port}`;
}
function isExactOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin;
}
function isSameSiteFetch(request: IncomingMessage): boolean {
  const site = request.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}
function randomToken(): string {
  return randomBytes(32).toString("base64url");
}
function tokensEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function cookie(header: string | undefined, name: string): string | undefined {
  return header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isManagedWorldInfoAttach(value: unknown): value is {
  chatThreadId: string;
  chatSurfaceSessionId: string;
  expectedUpdatedAtMs: number;
  publicTitle: string | null;
} {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    isTavernId(value.chatThreadId) &&
    isTavernId(value.chatSurfaceSessionId) &&
    isTimestamp(value.expectedUpdatedAtMs) &&
    (typeof value.publicTitle === "string" || value.publicTitle === null)
  );
}
function isChatDraftUpdate(value: unknown): value is { expectedRevision: number; text: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isTimestamp(value.expectedRevision) &&
    typeof value.text === "string"
  );
}
function isChatDraftDiscard(value: unknown): value is { expectedRevision: number } {
  return isRecord(value) && Object.keys(value).length === 1 && isTimestamp(value.expectedRevision);
}
function isAcceptedDraftClear(value: unknown): value is { expectedRevision: number; clearToken: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    isTimestamp(value.expectedRevision) &&
    typeof value.clearToken === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.clearToken)
  );
}
function isChatTitleRename(value: unknown): value is { title: string; expectedRevision: number } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.title === "string" &&
    isTimestamp(value.expectedRevision)
  );
}
function isLifecycleArchiveRequest(value: unknown): value is { handle: string; expectedManagementRevision: number } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.handle === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(value.handle) &&
    isPositiveRevision(value.expectedManagementRevision)
  );
}
function isScenarioCreate(value: unknown): value is { name: string; description: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.name === "string" &&
    typeof value.description === "string"
  );
}
function isGreetingCreate(
  value: unknown,
): value is { label: string; variants: readonly { label: string; text: string }[] } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    typeof value.label === "string" &&
    Array.isArray(value.variants) &&
    value.variants.every(
      (variant) =>
        isRecord(variant) &&
        Object.keys(variant).length === 2 &&
        typeof variant.label === "string" &&
        typeof variant.text === "string",
    )
  );
}
function isPersonaCreate(value: unknown): value is { name: string; description?: string } {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "name" || key === "description") &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value.name) &&
    (value.description === undefined ||
      (typeof value.description === "string" &&
        value.description.length > 0 &&
        value.description.length <= 4_096 &&
        !/[\u0000-\u001f\u007f]/u.test(value.description)))
  );
}
/**
 * The dialogue facade remains the sole Magic Context boundary. Companion
 * access is strictly read-only until Host-authenticated delegation exists.
 * Player-direct UI creation is a separate authenticated route below.
 */
function adaptDialogueMemoryFacade(
  facade: DialogueMemoryFacade | undefined,
  continuityId: string,
  redeemDelegatedCreate: (content: string, operationId: string | undefined) => Promise<DialogueMemoryView>,
): CompanionMemoryFacade | undefined {
  if (facade === undefined) return undefined;
  return Object.freeze({
    async execute(command, operationId) {
      if (command.operation === "list") return facade.listMemories({ continuityId });
      if (command.operation === "get") return facade.getMemory({ continuityId, stateToken: command.stateToken });
      return redeemDelegatedCreate(command.content, operationId);
    },
  });
}

function isMemoryCreateRequest(
  value: unknown,
): value is { content: string; category: DialogueMemoryCategory; sourceRefs?: readonly DialogueMemorySourceRef[] } {
  return (
    isRecord(value) &&
    Object.keys(value).every((key) => key === "content" || key === "category" || key === "sourceRefs") &&
    isMemoryContent(value.content) &&
    (value.category === "semantic" || value.category === "interaction") &&
    (value.sourceRefs === undefined ||
      (Array.isArray(value.sourceRefs) && value.sourceRefs.length <= 32 && value.sourceRefs.every(isMemorySourceRef)))
  );
}
function isMemoryUpdateRequest(value: unknown): value is { operation: "update"; stateToken: string; content: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.operation === "update" &&
    isMemoryStateToken(value.stateToken) &&
    isMemoryContent(value.content)
  );
}
function isMemoryStateRequest(
  value: unknown,
): value is { operation: "archive" | "restore" | "pin" | "unpin" | "delete-entry"; stateToken: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    (value.operation === "archive" ||
      value.operation === "restore" ||
      value.operation === "pin" ||
      value.operation === "unpin" ||
      value.operation === "delete-entry") &&
    isMemoryStateToken(value.stateToken)
  );
}
function isMemoryMergeRequest(
  value: unknown,
): value is { operation: "merge"; stateToken: string; targetStateToken: string } {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.operation === "merge" &&
    isMemoryStateToken(value.stateToken) &&
    isMemoryStateToken(value.targetStateToken) &&
    value.stateToken !== value.targetStateToken
  );
}
function isMemoryExcludeSourceRequest(
  value: unknown,
): value is { operation: "exclude-source"; stateToken: string; sourceRef?: string } {
  return (
    isRecord(value) &&
    (Object.keys(value).length === 2 || Object.keys(value).length === 3) &&
    value.operation === "exclude-source" &&
    isMemoryStateToken(value.stateToken) &&
    (value.sourceRef === undefined || isMemorySourceRef(value.sourceRef))
  );
}
function isMemoryContent(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4_096 && !/[\u0000]/u.test(value);
}
function isMemorySourceRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value);
}
function isMemoryStateToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(value);
}
function isMemoryRevisionConflict(error: unknown): boolean {
  // An opaque state token that no longer resolves is the expected CAS-loser
  // outcome after another mutation replaces or removes the prior revision.
  // Keep it distinct from a facade/storage outage so the browser can reload.
  return error instanceof Error && /(?:stale|conflict|revision|memory_not_found)/iu.test(error.message);
}
/** Deliberately project only opaque state and player supplied/content fields; no facade configuration leaks. */
function projectMemoryView(value: DialogueMemoryView): object {
  return Object.freeze({
    stateToken: value.stateToken,
    content: value.content,
    category: value.category,
    status: value.status,
    ...(value.sourceRefs === undefined ? {} : { sourceRefs: [...value.sourceRefs] }),
  });
}
function projectMemoryViews(values: readonly DialogueMemoryView[]): readonly object[] {
  return values.map(projectMemoryView);
}

function companionMetadata(value: {
  companionId: string;
  continuityId: string;
  name: string;
  profileId: string;
  profileRevision: number;
}): object {
  return {
    companionId: value.companionId,
    continuityId: value.continuityId,
    name: value.name,
    profileId: value.profileId,
    profileRevision: value.profileRevision,
  };
}
function chatMetadata(value: { title?: string | null; openingSelection: unknown }): object {
  // Durable thread/surface IDs, artifact selections, revisions, ownership and
  // timestamps remain Host-local. The navigation wrapper supplies the opaque
  // capability needed to select this player-readable row.
  const kind =
    isRecord(value.openingSelection) && typeof value.openingSelection.kind === "string"
      ? value.openingSelection.kind
      : "blank";
  return { ...(value.title == null ? {} : { title: value.title }), openingSelection: { kind } };
}
function importMetadata(value: {
  candidate: {
    canonicalHash: string;
    artifact: { candidateId: string; reviewState: string; fields: readonly { field: string; eligibility: string }[] };
  };
  report: {
    canonicalHash: string;
    artifact: {
      importId: string;
      source: string;
      sourceFormat?: string;
      dispositions: readonly { field: string; classification: string; reason: string }[];
    };
  };
}): object {
  // This is a player-facing, inert projection. Candidate values, raw ST source,
  // artifact IDs/hashes, schema fields and parser reasons never leave Host.
  // `reviewId` is an opaque Host handle used only in the subsequent POST.
  return {
    candidate: {
      reviewId: value.report.artifact.importId,
      fields: value.candidate.artifact.fields
        .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
        .map((field, index) => ({
          reviewKey: `field-${index + 1}`,
          label: importFieldLabel(field.field),
          eligible: true,
        })),
    },
    report: {
      reviewId: value.report.artifact.importId,
      dispositions: value.report.artifact.dispositions.map((disposition) => ({
        status: importDispositionStatus(disposition.classification),
      })),
    },
  };
}
function importFieldLabel(field: string): string {
  if (field === "persona_core") return "persona";
  if (field === "persona_interaction_style") return "interaction";
  if (field === "persona_expression_style") return "style";
  return "other";
}
function importDispositionStatus(classification: string): "available" | "excluded" | "unavailable" {
  return classification === "accepted_typed"
    ? "available"
    : classification === "dropped_unsupported"
      ? "excluded"
      : "unavailable";
}
function retryResponseRequest(value: unknown): {
  chatThreadId: string;
  chatSurfaceSessionId: string;
  messageId: string;
  expectedThreadRevision: number;
  expectedMessageRevision: number;
  effect: "none" | "external" | "game";
} | null {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 6 ||
    !isTavernId(value.chatThreadId) ||
    !isTavernId(value.chatSurfaceSessionId) ||
    !isTavernId(value.messageId) ||
    !isPositiveRevision(value.expectedThreadRevision) ||
    !isPositiveRevision(value.expectedMessageRevision) ||
    (value.effect !== "none" && value.effect !== "external" && value.effect !== "game")
  )
    return null;
  return {
    chatThreadId: value.chatThreadId,
    chatSurfaceSessionId: value.chatSurfaceSessionId,
    messageId: value.messageId,
    expectedThreadRevision: value.expectedThreadRevision,
    expectedMessageRevision: value.expectedMessageRevision,
    effect: value.effect,
  };
}
function reviewMetadata(value: {
  importId: string;
  candidateId: string;
  candidateRevision: number;
  sourceHash: string;
  reviewedFields: readonly string[];
  approvedAtMs: number;
}): object {
  return {
    importId: value.importId,
    candidateId: value.candidateId,
    candidateRevision: value.candidateRevision,
    sourceHash: value.sourceHash,
    reviewedFields: value.reviewedFields,
    approvedAtMs: value.approvedAtMs,
  };
}
function newChatRequest(
  value: unknown,
  selections: ReadonlyMap<string, ExpiringSelection>,
): {
  personaId?: string;
  scenarioId?: string;
  opening: { kind: "blank" } | { kind: "greeting"; greetingSetId: string; variantId: string };
} | null {
  if (
    !isRecord(value) ||
    !isRecord(value.opening) ||
    !Object.keys(value).every((key) => key === "opening" || key === "personaHandle" || key === "scenarioHandle")
  )
    return null;
  const resolve = (handle: unknown): NewChatSelection | undefined =>
    typeof handle === "string"
      ? (() => {
          const item = selections.get(handle);
          return item !== undefined && item.expiresAtMs >= Date.now() ? item.selection : undefined;
        })()
      : undefined;
  const persona = value.personaHandle === undefined ? undefined : resolve(value.personaHandle);
  const scenario = value.scenarioHandle === undefined ? undefined : resolve(value.scenarioHandle);
  if (
    (value.personaHandle !== undefined && (persona?.personaId === undefined || persona.scenarioId !== undefined)) ||
    (value.scenarioHandle !== undefined && (scenario?.scenarioId === undefined || scenario.personaId !== undefined))
  )
    return null;
  const greeting =
    value.opening.kind === "greeting" && Object.keys(value.opening).length === 2
      ? resolve(value.opening.greetingHandle)
      : undefined;
  const opening =
    value.opening.kind === "blank" && Object.keys(value.opening).length === 1
      ? { kind: "blank" as const }
      : greeting?.greetingSetId !== undefined && greeting.variantId !== undefined
        ? { kind: "greeting" as const, greetingSetId: greeting.greetingSetId, variantId: greeting.variantId }
        : null;
  return opening === null
    ? null
    : {
        ...(persona === undefined ? {} : { personaId: persona.personaId }),
        ...(scenario === undefined ? {} : { scenarioId: scenario.scenarioId }),
        opening,
      };
}
async function listRevisionArtifacts<T extends object>(
  runtimeRoot: string,
  root: string,
  key: keyof T,
  map: (artifact: T) => object,
): Promise<readonly object[]> {
  let ids: readonly string[];
  try {
    ids = await readdir(root);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const store = new TavernArtifactStore(runtimeRoot);
  const entries = await Promise.all(
    ids
      .filter(isTavernId)
      .sort()
      .map(async (id) => {
        let revisions: readonly string[];
        try {
          revisions = await readdir(join(root, id, "revisions"));
        } catch {
          return undefined;
        }
        for (const revision of revisions
          .map((name) => /^(\d+)\.json$/u.exec(name)?.[1])
          .filter((item): item is string => item !== undefined)
          .map(Number)
          .filter(Number.isSafeInteger)
          .sort((a, b) => b - a)) {
          try {
            const artifact = (await store.read(tavernRevisionPath(join(root, id), revision), validateTavernArtifact))
              .artifact as T;
            if (
              typeof artifact === "object" &&
              artifact !== null &&
              key in artifact &&
              artifact[key] === id &&
              (artifact as { revision?: unknown }).revision === revision
            )
              return map(artifact);
          } catch {
            /* invalid revision is never selected */
          }
        }
        return undefined;
      }),
  );
  return entries.filter((entry): entry is object => entry !== undefined);
}
function isPlayerReviewKey(value: unknown): value is string {
  return typeof value === "string" && /^field-[1-9][0-9]{0,2}$/u.test(value);
}
function isTavernId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
function isPositiveRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
