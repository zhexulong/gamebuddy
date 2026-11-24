import { join } from "node:path";
import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { PresentationRuntime } from "../presentation.js";
import type { CompanionIdentity, CompanionModelConfig } from "../runtime-identity.js";
import { identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { resolveSurfaceModelSelection } from "../settings/model-selection.js";
import { resolveCompanionLocale } from "../settings/player-preference-store.js";
import { DEFAULT_IDENTITY_PROFILE, identityProfileMetadata, readOrCreateIdentityProfile } from "../identity-profile.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import {
  materializeTavernAuthoredStableCatalog,
  type TavernAuthoredContextCatalog,
  type TavernCompanionWorldBookSource,
  readBoundStableArtifact,
} from "../tavern/catalog-service.js";
import { createManagedWorldInfoBindingResolver } from "../tavern/world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { hasUnrenderedMacro, macroTable, renderMacros, type MacroTable } from "../tavern/macro-engine.js";
import { readWorldBook, worldBookMetadata, type WorldBookEntry } from "../worldbook.js";
import {
  createChatThreadStore,
  type ChatThread,
  type ChatThreadState,
  type ChatThreadStore,
} from "../tavern/chat-thread-store.js";
import type { PresetThreadSources } from "../tavern/preset-request-segments.js";
import { resolveTavernPaths, type TavernPaths } from "../tavern/tavern-paths.js";
import type { Scenario, UserPersona } from "../tavern/types.js";

/**
 * The profile behind the conversation moved while nothing was mounted, and this mount is what reconciled it.
 *
 * It is the mount's OWN event, which is why it is present only on the mount that found the divergence: the pin it
 * records is what leaves the next mount with nothing to reconcile. The durable half of the same fact lives on the
 * thread (`ChatThread.authoredProfileCanonicalHash`), because that is the object every reader of the transcript holds
 * and a mount-scoped fact would be gone by the next session.
 */
type ChatProfileReconciliation = Readonly<{
  /** The triple the thread was pinned to when this mount read it. */
  pinned: Readonly<{ revision: number; canonicalHash: string }>;
  /** The triple this mount bound it to: the profile the file holds, which is what the runtime runs with. */
  mounted: Readonly<{ revision: number; canonicalHash: string }>;
}>;

/**
 * Immutable construction facts for exactly one selected Chat runtime. This is
 * intentionally internal: neither a browser nor a semantic caller may supply
 * a model, identity profile, presentation sink, content snapshot, or root.
 */
export type ExactChatRuntimeConstruction = Readonly<{
  identity: CompanionIdentity;
  runtimeRoot: string;
  surfaceSessionId: string;
  /**
   * Present only when this mount had to carry the thread's profile pin forward, and it says which profile the pin
   * named and which one the runtime now runs with.
   */
  profileReconciliation?: ChatProfileReconciliation;
  modelConfig: CompanionModelConfig | null;
  /** Durable revision of the model selection this construction used. */
  modelProfileRevision: number;
  /**
   * Re-reads the very selection this mount resolved (`activeConnection ??
   * profile`) through the same function, for a reload of the mounted runtime in
   * place. It is not a second source of truth: a reload and a mount can never
   * disagree about which provider/model the player selected.
   */
  resolveModelSelection(): Promise<ExactChatRuntimeModelSelection>;
  presentation: PresentationRuntime;
  /**
   * The chat thread's own contribution to the preset's macros: the persona and the scenario this chat bound.
   *
   * It is a construction fact rather than a per-request read because a thread's `stableArtifactBindings` are
   * written when the thread is created and never updated (`readThreadPresetSources`).
   */
  presetThreadSources: PresetThreadSources;
  /** Construction-owned materialization for the currently applied Chat catalog. */
  materializeStableContextForPiSession(piSessionId: string): Promise<TavernAuthoredContextCatalog>;
  /** Construction-private desired-state rebuild used only after terminal settlement. */
  materializeDesiredStableContextForPiSession(piSessionId: string): Promise<TavernAuthoredContextCatalog>;
  /**
   * The greeting this Chat opened on, exactly as its own row zero holds it; `null` when it opened on
   * nothing. The mount anchors these words as the session's first assistant message, so the row the
   * player reads is the one authority for them (`validateOpeningConsistency`, `chat-thread-store`,
   * makes row zero the opening whenever the opening selection is a greeting).
   */
  openingGreeting: string | null;
  /**
   * The rows this construction read, in order.
   *
   * The store and the Pi session are two authorities over one conversation and they can disagree: a delete or rewind
   * performed while nothing was mounted changes only the store, while re-opening the session file lands the leaf where the
   * file last ended. The mount compares these rows with the session it just reopened, so the conversation the player sees
   * is the one the model reads.
   */
  transcriptRows: readonly Readonly<{ role: string; text: string }>[];
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

/**
 * The provider/model/thinking level a Chat runtime runs with, and the profile revision it read.
 *
 * `modelConfig: null` means the player has activated no connection, so this Chat has no model -
 * and it is a positive answer, not a missing one: the read happened and found nothing. That is why
 * the selection is a nullable value rather than a member that can be absent, and why a mount no
 * longer refuses: a product with no model must still open, so the player can read the conversation
 * while Settings is where a model is brought. `runtime-core` skips Pi's model configuration for a
 * null selection and the mounted session therefore keeps Pi's own `unknown` placeholder until the
 * player activates a connection; the same session then adopts it in place.
 *
 * Both "no connection" and "the connection store could not be read" arrive here as `null`: the Chat
 * mount opens either way (a store defect is reported by the Settings surface that owns it), and this
 * translation is the Chat surface's own answer rather than a rule the other surfaces share.
 */
type ExactChatRuntimeModelSelection = Readonly<{
  modelConfig: CompanionModelConfig | null;
  modelProfileRevision: number;
}>;

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
  // Everything past this line can refuse -- an absent thread, identity drift -- and
  // every refusal abandons this store. The store now owns a live SQLite
  // connection, so an abandoned one holds the runtime root against removal on
  // Windows for the life of the process, and the caller never receives the object
  // to release it. The release therefore belongs on the throwing path. A root with
  // no model is deliberately not one of these refusals: a product with no model
  // still opens, and the surface is what says the model is missing.
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
  let presetThreadSources: PresetThreadSources;
  try {
    presetThreadSources = await readThreadPresetSources(artifactStore, tavernPaths, selectedThread);
  } catch {
    throw new Error("chat_runtime_exact_content_unavailable");
  }
  let profileMetadata;
  try {
    profileMetadata = identityProfileMetadata(
      await readOrCreateIdentityProfile(paths.identityProfilePath, DEFAULT_IDENTITY_PROFILE),
    );
  } catch (error) {
    // The ONE profile failure that is still a refusal, and it names its cause: bytes that cannot be read or parsed
    // are not a profile that moved, they are no profile at all, so there is nothing to bind the transcript to. The
    // parse failure stays in the message because it is the only thing that tells a corrupt file from a missing one.
    throw new Error(
      `chat_runtime_exact_content_unavailable: the identity profile could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  // The pin is a CHANGE DETECTOR over a mutable file, never a precondition for reading a durable transcript.
  //
  // The profile file and the pins are two separate durable writes (`updateMountedCompanionVoice` writes the file, then
  // `refreshCompanionProfileBinding` moves the pins), and a process that dies between them - or a root restored by
  // hand - leaves every Chat of that companion pinned to a profile the file no longer holds. Refusing that divergence
  // as "exact content unavailable" let one interrupted save make a whole history permanently unreadable, which is the
  // wrong authority: the transcript is durable and the profile is mutable.
  //
  // So the mount opens on the profile the file holds NOW and records the pin it bound (`recordMountedProfileBinding`),
  // which is what makes the reconciliation one-shot: the next mount reads a thread that already agrees with the profile
  // and has nothing to report. What is NOT reconciled is a different `profileId`: that is another profile, not this one
  // carried forward, and attaching the conversation to it would claim her history belongs to someone she never was.
  if (selectedThread.profileId !== profileMetadata.profileId) throw new Error("chat_runtime_exact_content_unavailable");
  const profileReconciliation = await reconcileMountedProfileBinding(threads, selectedThread, profileMetadata);
  // The companion's language is the player's choice, held in the one preference
  // the management surface writes; the runtime reads it at mount instead of
  // carrying a locale of its own. It is read once here because the authored
  // context it renders (the world book's macros) is constructed with this mount.
  const presentationLocale = await resolveCompanionLocale(paths.root);
  const materializeContextForPiSession = async (piSessionId: string, mode: "mounted" | "desired") => {
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
      const freshProfile = await readOrCreateIdentityProfile(paths.identityProfilePath, DEFAULT_IDENTITY_PROFILE);
      const freshProfileMetadata = identityProfileMetadata(freshProfile);
      // A different PROFILE is still a refusal, and so is everything above: those are identity facts about the thread.
      // A moved profile is not - the same reconciliation the mount just made applies to the profile as it is read NOW,
      // because a save that landed while this runtime was open must reach the next prompt, not refuse it.
      if (freshState.thread.profileId !== freshProfileMetadata.profileId)
        throw new Error("chat_runtime_exact_content_unavailable");
      // The catalogue's own binding check compares the triple it is handed with the thread's, so the thread handed to
      // it is the one this materialization is bound to: a pin that still records the profile the file no longer holds
      // is carried here, and never published as the profile the runtime is running with (`freshProfileMetadata`, which
      // the scope below carries, is that profile).
      const boundThread =
        freshState.thread.profileRevision === freshProfileMetadata.revision &&
        freshState.thread.profileCanonicalHash === freshProfileMetadata.canonicalHash
          ? freshState.thread
          : Object.freeze({
              ...freshState.thread,
              profileRevision: freshProfileMetadata.revision,
              profileCanonicalHash: freshProfileMetadata.canonicalHash,
            });
      // Layer 1 (the companion's own book) is part of who she is and is always applied;
      // only layer 2, the attached managed item, has a desired/applied pair to reconcile.
      // The thread's own binding overrides the continuity activation; with none, the
      // continuity activation applies - the same fact the Game materializes, which is why
      // that record is continuity-scoped instead of living on a Chat thread.
      const companionBinding = freshState.thread.companionWorldBookBinding;
      const desiredManaged = freshState.thread.managedWorldInfoBinding;
      const effectiveManaged =
        mode === "desired" || sameWorldInfoBinding(desiredManaged, freshState.thread.appliedManagedWorldInfoBinding)
          ? desiredManaged
          : freshState.thread.appliedManagedWorldInfoBinding;
      // A pending binding is still the thread's own binding: the activation applies only to
      // a conversation that carries no managed state at all, so this fallback never stands
      // in for an unapplied change the mounted prefix is deliberately refusing.
      const activatedManaged =
        desiredManaged !== undefined || freshState.thread.appliedManagedWorldInfoBinding !== undefined
          ? undefined
          : await managedWorldInfoResolver.activated(identityKey(identity));
      const managedWorldInfo =
        effectiveManaged === undefined ? activatedManaged : await managedWorldInfoResolver.resolve(effectiveManaged);
      const managedBinding = effectiveManaged ?? activatedManaged?.binding;
      const materializationThread =
        sameWorldInfoBinding(effectiveManaged, desiredManaged) &&
        sameWorldInfoBinding(effectiveManaged, freshState.thread.appliedManagedWorldInfoBinding) &&
        activatedManaged === undefined
          ? boundThread
          : Object.freeze({
              ...boundThread,
              ...(managedBinding === undefined ? {} : { managedWorldInfoBinding: managedBinding }),
            });
      const macros = macroTable({ char: freshProfile.identity.name, locale: presentationLocale });
      return await materializeTavernAuthoredStableCatalog(
        tavernPaths,
        artifactStore,
        materializationThread,
        Object.freeze({
          continuityId: identity.continuityId!,
          sessionId: piSessionId,
          surface: "tavern",
          threadId: boundThread.chatThreadId,
          profile: Object.freeze({
            profileId: freshProfileMetadata.profileId,
            revision: freshProfileMetadata.revision,
            canonicalHash: freshProfileMetadata.canonicalHash,
          }),
        }),
        macros,
        Object.freeze({
          ...(companionBinding === undefined
            ? {}
            : { companionWorldBook: await resolveBoundWorldBookSource(companionBinding, paths.runtimeCwd, macros) }),
          ...(managedWorldInfo === undefined ? {} : { managedWorldInfo }),
        }),
      );
    } catch {
      throw new Error("chat_runtime_exact_content_unavailable");
    }
  };
  const materializeStableContextForPiSession = (piSessionId: string) =>
    materializeContextForPiSession(piSessionId, "mounted");
  const materializeDesiredStableContextForPiSession = (piSessionId: string) =>
    materializeContextForPiSession(piSessionId, "desired");

  const { modelConfig, modelProfileRevision } = await resolveExactChatRuntimeModelSelection(paths);
  return Object.freeze({
    identity,
    runtimeRoot: execution.runtimeRoot,
    surfaceSessionId: permit.chatSurfaceSessionId,
    modelConfig,
    modelProfileRevision,
    resolveModelSelection: () => resolveExactChatRuntimeModelSelection(paths),
    presentation: Object.freeze({
      profile: Object.freeze({ locale: presentationLocale, text: true, speech: null }),
      surface: "chat",
      sessionId: permit.chatSurfaceSessionId,
    }),
    presetThreadSources,
    materializeStableContextForPiSession,
    materializeDesiredStableContextForPiSession,
    openingGreeting: openingGreetingOf(state),
    ...(profileReconciliation === undefined ? {} : { profileReconciliation }),
    /**
     * The rows this mount read, in order. `runtime-core` compares them with the Pi session it reopens, because the two can
     * disagree: an offline delete or rewind changes only the store, and re-opening the session file lands the leaf where the
     * file last ended - which resurrects the rows that were removed while nothing was mounted.
     */
    transcriptRows: Object.freeze(
      state.messages.map((message) => Object.freeze({ role: message.role, text: message.text })),
    ),
    closeChatThreadStore: () => threads.close?.(),
    ...(options.tavernNarrativeGateNonceSha256 === undefined
      ? {}
      : { tavernNarrativeGateNonceSha256: options.tavernNarrativeGateNonceSha256 }),
  });
}

/**
 * The mount's own reconciliation of a profile the conversation outlived, and the helper that records it.
 *
 * The long reasoning is at the call site; what this function owns is the answer the mount needs - WHICH profile it bound
 * - and the one write that makes it one-shot: the same `refreshCompanionProfileBinding` a save uses, so no second writer
 * moves a pin. It is companion-scoped because that is what the interrupted save would have done: every Chat of that
 * companion is pinned to the profile the file no longer holds, and each of them is read by its own mount.
 *
 * Nothing here may refuse the mount. A refused or failed pass (`chat_profile_binding_turn_active` while a sibling turn
 * is live, or any store fault) leaves the divergence exactly where it was - reported by this mount and found again by
 * the next one - while the conversation opens either way. That asymmetry is the rule: the transcript is the authority
 * for whether this Chat can be read, and the pin only ever said which profile to run it with.
 */
async function reconcileMountedProfileBinding(
  threads: ChatThreadStore,
  thread: ChatThread,
  profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>,
): Promise<ChatProfileReconciliation | undefined> {
  if (thread.profileRevision === profile.revision && thread.profileCanonicalHash === profile.canonicalHash)
    return undefined;
  const pinned = Object.freeze({ revision: thread.profileRevision, canonicalHash: thread.profileCanonicalHash });
  const mounted = Object.freeze({ revision: profile.revision, canonicalHash: profile.canonicalHash });
  const refresh = threads.refreshCompanionProfileBinding;
  if (refresh === undefined) return Object.freeze({ pinned, mounted });
  try {
    await refresh({
      companionId: thread.companionId,
      continuityId: thread.continuityId,
      previous: Object.freeze({ profileId: thread.profileId, ...pinned }),
      binding: Object.freeze({ profileId: profile.profileId, ...mounted }),
    });
  } catch {
    // Deliberately silent on the mount's own log: the divergence is durable, so the next mount states it again.
  }
  return Object.freeze({ pinned, mounted });
}

/**
 * The Chat surface's reading of the one rule `resolveSurfaceModelSelection` owns: a selected model
 * is frozen into this mount, and both remaining outcomes mean this Chat mounts with no model.
 *
 * The Chat is the surface that opens without one: the player reads the conversation while Settings
 * is where a model is brought, so neither `no_model` nor `unreadable` may refuse the mount.
 */
async function resolveExactChatRuntimeModelSelection(
  paths: Pick<ReturnType<typeof resolveRuntimePaths>, "agentDir" | "root">,
): Promise<ExactChatRuntimeModelSelection> {
  const outcome = await resolveSurfaceModelSelection({
    runtimeRoot: paths.root,
    agentDir: paths.agentDir,
    surface: "chat",
  });
  return Object.freeze({
    modelConfig: outcome.status === "selected" ? outcome.modelConfig : null,
    modelProfileRevision: outcome.modelProfileRevision,
  });
}

function sameWorldInfoBinding(
  left: import("../tavern/chat-thread-store.js").TavernStableWorldInfoBinding | undefined,
  right: import("../tavern/chat-thread-store.js").TavernStableWorldInfoBinding | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if ("source" in left && "source" in right)
    return (
      left.publicTitle === right.publicTitle &&
      left.revision === right.revision &&
      left.canonicalHash === right.canonicalHash
    );
  if (!("source" in left) && !("source" in right))
    return (
      left.worldBookId === right.worldBookId &&
      left.revision === right.revision &&
      left.canonicalHash === right.canonicalHash &&
      left.provenance === right.provenance
    );
  return false;
}

/**
 * The greeting a Chat opened on, read from row zero of the very state this construction validated.
 *
 * The row and not the thread's `openingSelection` is what the player reads, and the store's own read
 * path already proved they agree; a thread that opened on nothing carries no opening row at all and
 * yields `null`, which is the mount's "nothing to anchor".
 */
function openingGreetingOf(state: ChatThreadState): string | null {
  const opening = state.messages[0];
  return state.thread.openingSelection.kind === "greeting" && opening !== undefined && opening.kind === "opening"
    ? opening.text
    : null;
}

/**
 * The persona and the scenario the chat thread bound, as the preset's `{{persona}}` and `{{scenario}}` read them.
 *
 * These are the THREAD's bindings, never `resolvePlayerOwnPersona` / `resolveCompanionOwnScenario`: a chat that bound a
 * different persona must render that one, or the preset would describe a player the authored context is not carrying.
 * Where a bound artifact lives and how its hash is verified is `catalog-service.ts`'s one reading
 * (`readBoundStableArtifact`), so the preset and the catalogue cannot resolve two different files for one binding.
 *
 * Read ONCE at mount, and that is not an optimisation. A thread's `stableArtifactBindings` are written when the thread
 * is created (`chat-thread-store.ts`) and copied with a fork; nothing updates `persona_id`, `scenario_id` or the binding
 * rows, so a different persona or scenario is a different chat. A per-request read here would return the same value
 * while paying a full transcript read on every prompt.
 */
async function readThreadPresetSources(
  store: TavernArtifactStore,
  paths: TavernPaths,
  thread: ChatThread,
): Promise<PresetThreadSources> {
  const bindings = thread.stableArtifactBindings ?? [];
  const personaBinding = bindings.find((binding) => binding.kind === "persona");
  const scenarioBinding = bindings.find((binding) => binding.kind === "scenario");
  const [persona, scenario] = await Promise.all([
    personaBinding === undefined ? undefined : readBoundStableArtifact(store, paths, personaBinding),
    scenarioBinding === undefined ? undefined : readBoundStableArtifact(store, paths, scenarioBinding),
  ]);
  return Object.freeze({
    ...(persona === undefined ? {} : { persona: persona.artifact as UserPersona }),
    ...(scenario === undefined ? {} : { scenario: scenario.artifact as Scenario }),
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
/**
 * The companion's own reviewed world book, for a thread that names no other one.
 *
 * The Game surface compiles `<runtimeCwd>/worldbook.json` into its Tier 2 m[0]
 * automatically. The Chat surface materializes only what the thread binds, so a
 * companion provisioned from a card carried its world book on the Game surface
 * and silently lost it in Chat. With no explicit binding, the book the reviewed
 * import wrote IS the companion's own background: bind it here (id, revision and
 * hash read from the file; the existing hash gate re-verifies them against the
 * bytes), so both surfaces materialize the same companion common sense.
 *
 * A missing book is ordinary - a companion need not have one - and yields
 * nothing to bind. A present but unreadable book fails closed, exactly like a
 * drifted managed binding: the backdrop must never be silently emptied.
 */
/**
 * Resolves a native (non-managed) WorldBookBinding — the bound worldbook.json
 * the reviewed import wrote into the runtime root — into layer 1's always-on
 * `lorebook_constant` materialization input. The on-disk book must EXACTLY
 * match the companion slot's binding (id/revision/hash): a drifted or manually
 * edited book refuses construction instead of silently materializing stale
 * content, mirroring the managed World Info hash gate.
 *
 * `constant: true` entries are reviewed always-on background and ride in the
 * stable lorebook_constant source (Tier 2 m[0]); the thread that carries this
 * binding is the one the reviewed import wrote for (see
 * `initial-chat-exact-content-port.ts`, which seeds a new thread's companion
 * slot with the companion's own book).
 */
async function resolveBoundWorldBookSource(
  binding: import("../tavern/chat-thread-store.js").TavernStableWorldBookBinding,
  runtimeCwd: string,
  macros: MacroTable,
): Promise<TavernCompanionWorldBookSource> {
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
  // The world book carries card macros; render them as authored content here so
  // no `{{...}}` placeholder reaches the Chat catalog. The `macros` table is the
  // caller's single run-scoped authority (`{{char}}` is the companion's own name
  // from the identity profile construction already verified against this thread's
  // binding, `{{user}}` the run's player reference). An entry the table still
  // cannot fully render is omitted from the companion's context, but never
  // silently: see renderWorldBookEntry.
  const constantEntries: readonly WorldBookEntry[] = book.entries
    // A disabled entry is not part of her background: it stays in the book, and it reaches
    // neither the always-on block nor the per-turn candidates.
    .filter((entry) => entry.enabled !== false && entry.constant === true)
    .flatMap((entry) => {
      const rendered = renderWorldBookEntry(entry, macros);
      return rendered === undefined ? [] : [Object.freeze({ ...entry, ...rendered })];
    });
  // Keyword-gated entries must ALSO be handed over: `deriveVolatileWorldInfoSources` turns a native
  // book's `keywordEntries` into per-turn volatile selection candidates (catalog-service.ts:303-328).
  // Without them it returns an empty list (catalog-service.ts:327), so the companion never surfaces what
  // its own card says - silently, with no error anywhere.
  const keywordEntries = book.entries
    .filter((entry) => entry.enabled !== false && entry.constant !== true)
    .flatMap((entry) => {
      const rendered = renderWorldBookEntry(entry, macros);
      return rendered === undefined
        ? []
        : [
            Object.freeze({
              entryId: entry.entryId,
              title: rendered.title,
              content: rendered.content,
              // The card's own trigger words ride along; without them the volatile selection can only ever match the
              // author-facing title, which a player does not say.
              ...(entry.keys === undefined || entry.keys.length === 0 ? {} : { keys: entry.keys }),
              // And so does its secondary gate: `keys` alone narrows an authored rule down to
              // "any of these words", which selects the entry where the card excluded it.
              ...(entry.secondaryKeys === undefined ? {} : { secondaryKeys: entry.secondaryKeys }),
              ...(entry.selectiveLogic === undefined ? {} : { selectiveLogic: entry.selectiveLogic }),
            }),
          ];
    });
  const alwaysOnPremise = renderMacros(book.alwaysOnPremise, macros);
  if (hasUnrenderedMacro(alwaysOnPremise)) throw new Error("chat_runtime_exact_content_unavailable");
  return Object.freeze({
    binding,
    alwaysOnPremise,
    ...(constantEntries.length > 0 ? { constantEntries } : {}),
    ...(keywordEntries.length > 0 ? { keywordEntries: Object.freeze(keywordEntries) } : {}),
  });
}

/**
 * Renders one world book entry through the run's macro table.
 *
 * An entry the table cannot fully render is omitted - a raw `{{...}}`
 * placeholder must never reach the companion's context or a tool result - but it
 * is not dropped in silence. A lorebook entry that disappears without a word is
 * a loss nobody notices until the companion contradicts her own background, so
 * the omission is named on stderr (the composed child's log): bounded,
 * non-fatal, and visible in exactly the place the construction's other gaps are
 * reported.
 */
function renderWorldBookEntry(
  entry: WorldBookEntry,
  macros: MacroTable,
): Readonly<{ title: string; content: string }> | undefined {
  const title = renderMacros(entry.title, macros);
  const content = renderMacros(entry.content, macros);
  if (!hasUnrenderedMacro(title) && !hasUnrenderedMacro(content)) return Object.freeze({ title, content });
  const named = entry.title.length > 80 ? `${entry.title.slice(0, 80)}…` : entry.title;
  process.stderr.write(
    `[worldbook] omitting world book entry ${entry.entryId} (${named}): it carries a macro the companion's context cannot resolve\n`,
  );
  return undefined;
}
