import { join } from "node:path";
import type { ChatRuntimeBindingExecution } from "../continuity-semantic-chat-runtime-binding/continuity-semantic-chat-runtime-binding.internal.js";
import type { ProductionChatRuntimePermit } from "../continuity-semantic-store/continuity-semantic-production-store.js";
import type { PresentationRuntime } from "../presentation.js";
import type { CompanionIdentity, CompanionModelConfig } from "../runtime-identity.js";
import { identityKey, resolveRuntimePaths } from "../runtime-identity.js";
import { ModelProfileStore } from "../settings/model-profile-store.js";
import { resolveCompanionLocale } from "../settings/player-preference-store.js";
import { TavernConnectionStore } from "../tavern/connection-store.js";
import { DEFAULT_IDENTITY_PROFILE, identityProfileMetadata, readOrCreateIdentityProfile } from "../identity-profile.js";
import { TavernArtifactStore } from "../tavern/artifact-store.js";
import {
  materializeTavernAuthoredStableCatalog,
  type TavernAuthoredContextCatalog,
  type TavernCompanionWorldBookSource,
} from "../tavern/catalog-service.js";
import { createManagedWorldInfoBindingResolver } from "../tavern/world-info-binding/managed-world-info-binding.js";
import { createWorldInfoManagementRepository } from "../tavern/world-info-management/world-info-management.js";
import { hasUnrenderedMacro, macroTable, renderMacros, type MacroTable } from "../tavern/macro-engine.js";
import { readWorldBook, worldBookMetadata, type WorldBookEntry } from "../worldbook.js";
import { createChatThreadStore, type ChatThreadState, type ChatThreadStore } from "../tavern/chat-thread-store.js";
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
 */
export type ExactChatRuntimeModelSelection = Readonly<{
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
  let profileMetadata;
  try {
    profileMetadata = identityProfileMetadata(
      await readOrCreateIdentityProfile(paths.identityProfilePath, DEFAULT_IDENTITY_PROFILE),
    );
  } catch {
    throw new Error("chat_runtime_exact_content_unavailable");
  }
  if (
    selectedThread.profileId !== profileMetadata.profileId ||
    selectedThread.profileRevision !== profileMetadata.revision ||
    selectedThread.profileCanonicalHash !== profileMetadata.canonicalHash
  )
    throw new Error("chat_runtime_exact_content_unavailable");
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
      if (
        freshState.thread.profileId !== freshProfileMetadata.profileId ||
        freshState.thread.profileRevision !== freshProfileMetadata.revision ||
        freshState.thread.profileCanonicalHash !== freshProfileMetadata.canonicalHash
      )
        throw new Error("chat_runtime_exact_content_unavailable");
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
          ? freshState.thread
          : Object.freeze({
              ...freshState.thread,
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
          threadId: freshState.thread.chatThreadId,
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
    materializeStableContextForPiSession,
    materializeDesiredStableContextForPiSession,
    openingGreeting: openingGreetingOf(state),
    closeChatThreadStore: () => threads.close?.(),
    ...(options.tavernNarrativeGateNonceSha256 === undefined
      ? {}
      : { tavernNarrativeGateNonceSha256: options.tavernNarrativeGateNonceSha256 }),
  });
}

/**
 * The one place that decides which provider/model/thinking level a Chat runtime
 * runs with: the player's active connection, and nothing else.
 *
 * This product ships no model endpoint, so there is no fallback to resolve: a
 * root with no active connection has no model, and `null` is the honest answer
 * rather than a shipped gateway that does not exist on the player's machine. A
 * mount freezes this answer into its Pi session; activating a connection asks
 * the same function again for the mounted runtime, so a reload can never drift
 * from what a fresh mount would use.
 */
async function resolveExactChatRuntimeModelSelection(
  paths: Pick<ReturnType<typeof resolveRuntimePaths>, "agentDir" | "root">,
): Promise<ExactChatRuntimeModelSelection> {
  const modelProfile = await new ModelProfileStore(join(paths.root, "settings", "model-profiles.json")).read("chat");
  const modelConfig = await readActiveConnectionModelConfig(paths.agentDir);
  return Object.freeze({ modelConfig, modelProfileRevision: modelProfile.revision });
}

/**
 * Reads the one active player connection as the exact runtime model
 * configuration, or null while no player connection is selected.
 *
 * The record's own endpoint is not returned here: `runtime-core` merges the
 * selected provider entry into Pi's `models.json` from the same stored record,
 * so the endpoint keeps one owner. A store that cannot be read counts as no
 * connection: a Chat with no model is a state the surface states plainly, and
 * inventing a selection the player never made would be a worse lie than that.
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
    .filter((entry) => entry.constant === true)
    .flatMap((entry) => {
      const rendered = renderWorldBookEntry(entry, macros);
      return rendered === undefined ? [] : [Object.freeze({ ...entry, ...rendered })];
    });
  // Keyword-gated entries must ALSO be handed over: `deriveVolatileWorldInfoSources` turns a native
  // book's `keywordEntries` into per-turn volatile selection candidates (catalog-service.ts:303-328).
  // Without them it returns an empty list (catalog-service.ts:327), so the companion never surfaces what
  // its own card says - silently, with no error anywhere.
  const keywordEntries = book.entries
    .filter((entry) => entry.constant !== true)
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
