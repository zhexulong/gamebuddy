import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { IdentityProfileMetadata } from "../identity-profile.js";
import { join } from "node:path";
import { readWorldBook, worldBookMetadata } from "../worldbook.js";
import { type TavernArtifactStore, TavernRevisionConflict } from "./artifact-store.js";
import { createProfileAwareChatThreadCreationCapability } from "./chat-thread-store.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import type {
  ChatThread,
  ChatThreadState,
  ChatThreadStore,
  CreateChatThreadRequest,
  GreetingSource,
  TavernStableArtifactBinding,
  TavernStableWorldBookBinding,
} from "./chat-thread-store.js";
import { playerPersonaId } from "./persona-management/persona-management.js";
import { companionScenarioId } from "./scenario-management/scenario-management.js";
import { type TavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import {
  type DialogueExamples,
  type GreetingSet,
  type Scenario,
  type TavernCompanion,
  type UserPersona,
  validateTavernArtifact,
} from "./types.js";

/**
 * Small application boundary for the Tavern library and chat selector.
 * It persists inert Tavern metadata only: companion runtime provisioning,
 * IdentityProfile mutation, Magic Context, and Game operations stay outside it.
 */
export type IdentityProfileMetadataReader = Readonly<{ readExact(): Promise<IdentityProfileMetadata> }>;

export type TavernLibraryService = Readonly<{
  listCompanions(): Promise<readonly TavernCompanion[]>;
  createNewCompanion(input: NewCompanionRequest): Promise<TavernCompanion>;
  listChats(): Promise<readonly ChatThread[]>;
  createNewChat(input: NewChatRequest): Promise<ChatThreadState>;
  /**
   * Commits variant N of the exact greeting set this Chat's opening already came from as the
   * Chat's message zero. It is legal exactly while the opening is not yet locked
   * (`opening_locked_at_event_id === null`) - the new-chat window design/28 describes - and is
   * refused with a bounded error otherwise. It reuses `ChatThreadStore.commitOpening` and the
   * existing `greeting_variant_id` record; it never creates a parallel opening record.
   */
  commitOpeningVariant(input: CommitOpeningVariantRequest): Promise<ChatThreadState>;
  /** Reads and validates one exact thread/surface route; runtime owner pins it only after activation. */
  openChat(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState>;
  activeChatSelection(): ReturnType<ChatThreadStore["readActiveThreadSelection"]>;
}>;

type CommitOpeningVariantRequest = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  /** Step from the committed variant; exactly one of `direction`/`targetIndex` is required. */
  direction?: "prev" | "next";
  /** 0-based position in the greeting set the opening came from. */
  targetIndex?: number;
}>;

type NewCompanionRequest = Readonly<{
  companionId: string;
  continuityId: string;
  name: string;
  profileId: string;
  profileRevision: number;
  profileHash: string;
}>;

type NewChatRequest = Readonly<{
  chatThreadId: string;
  chatSurfaceSessionId: string;
  personaId?: string;
  scenarioId?: string;
  dialogueExamplesId?: string;
  companionWorldBookBinding?: TavernStableWorldBookBinding;
  /**
   * An omitted opening means the companion's own greeting: the reviewed card's `first_mes` became
   * the greeting record's default variant at provisioning, so a card-provisioned companion HAS an
   * opening. A caller that genuinely means an empty first screen still says `"blank"`.
   */
  opening?:
    | Readonly<{ kind: "blank" }>
    | Readonly<{ kind: "greeting"; greetingSetId: string; variantId: string; messageId?: string }>;
}>;

export function createTavernLibraryService(
  paths: TavernPaths,
  store: TavernArtifactStore,
  threads: ChatThreadStore,
  profileMetadataReader: IdentityProfileMetadataReader,
): TavernLibraryService {
  const metadataReader = profileMetadataReader;
  const threadCreation = createProfileAwareChatThreadCreationCapability(threads, metadataReader);
  const companionPath = join(paths.companionRoot, "companion.json");
  const personaPath = (personaId: string, revision: number) =>
    tavernRevisionPath(join(paths.playerRoot, "personas", personaId), revision);
  const scenarioPath = (scenarioId: string, revision: number) =>
    tavernRevisionPath(join(paths.companionRoot, "scenarios", scenarioId), revision);
  const examplesPath = (examplesId: string, revision: number) =>
    tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", examplesId), revision);

  return Object.freeze({
    async listCompanions(): Promise<readonly TavernCompanion[]> {
      const root = join(paths.root, "companions");
      // Catalog-only namespaces have no exact companion artifact and are not
      // Library companions. Any extant companion artifact is authoritative:
      // unreadable or invalid data fails closed rather than being omitted.
      return store.listArtifactRepositories(root, (entry) =>
        companionRepository(store, join(root, entry, "companion.json")),
      );
    },

    async createNewCompanion(input): Promise<TavernCompanion> {
      if (input.companionId !== paths.companionId || input.continuityId !== paths.continuityId)
        throw new Error("tavern_companion_scope_mismatch");
      const artifact = validateTavernArtifact({ schemaVersion: 1, revision: 1, ...input });
      if (!isCompanion(artifact)) throw new Error("invalid_tavern_companion");
      try {
        return (await store.write(companionPath, artifact, validateTavernArtifact)).artifact as TavernCompanion;
      } catch (error) {
        if (error instanceof TavernRevisionConflict) throw new Error("tavern_companion_already_exists");
        throw error;
      }
    },

    async listChats(): Promise<readonly ChatThread[]> {
      if (threads.listThreads === undefined) throw new Error("tavern_thread_listing_unavailable");
      return threads.listThreads();
    },

    async createNewChat(input): Promise<ChatThreadState> {
      // The seeded/mounted companion and every library-created companion carries
      // this record: the seed installs it through the library's own creation
      // path, so a companion without one is a producer disagreement, not an
      // ordinary case. It fails closed rather than opening a Chat on a record
      // the library never wrote, and a present artifact is cross-checked against
      // the scope it claims, so a foreign companion can never be opened here.
      const companion = await currentCompanion(store, companionPath);
      if (companion.companionId !== paths.companionId || companion.continuityId !== paths.continuityId)
        throw new Error("tavern_companion_scope_mismatch");
      const profile = await metadataReader.readExact();
      // A Chat that names no scenario takes the companion's own - the reviewed card's
      // scenario, written at provisioning under the one derived id. Resolution lives
      // in ONE place (`resolveCompanionOwnScenario` below), shared with the unmounted
      // creation port, and is reached only when the caller names none: an explicitly
      // selected scenario is the caller's, never replaced or added to.
      const ownScenario =
        input.scenarioId === undefined ? await resolveCompanionOwnScenario(store, paths.companionRoot) : undefined;
      // A Chat that names no persona takes the player's own - there is exactly one, so
      // "which persona" is not a choice a caller makes. Resolution lives in ONE place
      // (`resolvePlayerOwnPersona` below), shared with the unmounted creation port, and
      // is reached only when the caller names none.
      const ownPersona =
        input.personaId === undefined ? await resolvePlayerOwnPersona(store, paths.playerRoot) : undefined;
      const persona =
        input.personaId === undefined
          ? ownPersona?.artifact
          : await latestExact<UserPersona>(
              store,
              join(paths.playerRoot, "personas", input.personaId),
              "personaId",
              input.personaId,
            );
      const scenario =
        input.scenarioId === undefined
          ? ownScenario?.artifact
          : await latestExact<Scenario>(
              store,
              join(paths.companionRoot, "scenarios", input.scenarioId),
              "scenarioId",
              input.scenarioId,
            );
      const examples =
        input.dialogueExamplesId === undefined
          ? undefined
          : await latestExact<DialogueExamples>(
              store,
              join(paths.companionRoot, "dialogue-examples", input.dialogueExamplesId),
              "examplesId",
              input.dialogueExamplesId,
            );
      const stableArtifactBindings: TavernStableArtifactBinding[] = [];
      if (persona !== undefined)
        stableArtifactBindings.push(
          ownPersona?.binding ??
            (await stableBinding(
              store,
              personaPath(persona.personaId, persona.revision),
              "persona",
              persona.personaId,
            )),
        );
      if (scenario !== undefined)
        stableArtifactBindings.push(
          ownScenario?.binding ??
            (await stableBinding(
              store,
              scenarioPath(scenario.scenarioId, scenario.revision),
              "scenario",
              scenario.scenarioId,
            )),
        );
      if (examples !== undefined)
        stableArtifactBindings.push(
          await stableBinding(
            store,
            examplesPath(examples.examplesId, examples.revision),
            "dialogue_examples",
            examples.examplesId,
          ),
        );
      // The companion's own reviewed world book, for a Chat that names none: the Chat
      // surface materializes only what the thread binds, so a card-provisioned
      // companion used to carry its backdrop into the first Chat and lose it in every
      // Chat the player opened afterwards. It seeds the companion slot, which the
      // managed World Info panel can neither fill nor clear.
      const companionWorldBookBinding =
        input.companionWorldBookBinding ?? (await resolveCompanionOwnWorldBookBinding(paths.runtimeCwd));
      const opening =
        input.opening === undefined
          ? ((await resolveCompanionOwnOpening(store, paths.companionRoot, profile.revision, scenario)) ?? "blank")
          : input.opening.kind === "blank"
            ? "blank"
            : await greetingOpening(
                store,
                join(paths.companionRoot, "greetings", input.opening.greetingSetId),
                profile.revision,
                scenario,
                input.opening,
              );
      const request: CreateChatThreadRequest = {
        chatThreadId: input.chatThreadId,
        companionId: paths.companionId,
        continuityId: paths.continuityId,
        chatSurfaceSessionId: input.chatSurfaceSessionId,
        ...(persona === undefined ? {} : { personaId: persona.personaId }),
        ...(scenario === undefined ? {} : { scenarioId: scenario.scenarioId }),
        stableArtifactBindings,
        ...(companionWorldBookBinding === undefined ? {} : { companionWorldBookBinding }),
        opening,
      };
      return threadCreation.createExplicit(request);
    },

    async commitOpeningVariant(input: CommitOpeningVariantRequest): Promise<ChatThreadState> {
      return (await commitGreetingOpeningVariant({ store, threads, paths, ...input })).state;
    },

    async openChat(chatThreadId, chatSurfaceSessionId): Promise<ChatThreadState> {
      const state = await threads.resumeThread(chatThreadId, chatSurfaceSessionId);
      const companion = await currentCompanion(store, companionPath);
      if (
        companion.companionId !== paths.companionId ||
        companion.continuityId !== paths.continuityId ||
        state.thread.companionId !== companion.companionId ||
        state.thread.continuityId !== companion.continuityId
      )
        throw new Error("tavern_chat_scope_mismatch");
      return state;
    },

    activeChatSelection(): ReturnType<ChatThreadStore["readActiveThreadSelection"]> {
      return threads.readActiveThreadSelection();
    },
  });
}

/** The exact variant position a committed opening names, for the browser's `< 1/N >` reading. */
export type TavernOpeningVariantProjection = Readonly<{
  variantId: string;
  /** 0-based position in the greeting set the opening was drawn from. */
  index: number;
  count: number;
  label: string | null;
}>;

/**
 * The one implementation of the new-chat opening choice, shared by the Library service and the
 * mounted management service. It is legal exactly while `opening_locked_at_event_id === null` - the
 * window in which design/28 lets a new Chat's opening be chosen; a sealed opening is refused with
 * the bounded `chat_opening_locked` rather than silently no-opped. It reuses
 * `ChatThreadStore.commitOpening` and the existing `greeting_variant_id` record, and returns the
 * committed variant's position so every caller projects the same fact.
 */
export async function commitGreetingOpeningVariant(
  input: Readonly<{
    store: TavernArtifactStore;
    threads: ChatThreadStore;
    paths: TavernPaths;
    chatThreadId: string;
    chatSurfaceSessionId: string;
    direction?: "prev" | "next";
    targetIndex?: number;
  }>,
): Promise<Readonly<{ state: ChatThreadState; variant: TavernOpeningVariantProjection }>> {
  if ((input.direction === undefined) === (input.targetIndex === undefined))
    throw new Error("invalid_chat_opening_request");
  const state = await input.threads.resumeThread(input.chatThreadId, input.chatSurfaceSessionId);
  const companion = await currentCompanion(input.store, join(input.paths.companionRoot, "companion.json"));
  if (
    companion.companionId !== input.paths.companionId ||
    companion.continuityId !== input.paths.continuityId ||
    state.thread.companionId !== companion.companionId ||
    state.thread.continuityId !== companion.continuityId
  )
    throw new Error("tavern_chat_scope_mismatch");
  // The durable lock is the whole legality of this operation; `commitOpening` re-checks it under
  // its own transaction, so a concurrent seal still fails closed instead of overwriting.
  if (state.thread.openingLockedAtEventId !== null) throw new Error("chat_opening_locked");
  const opening = state.thread.openingSelection;
  if (opening.kind !== "greeting") throw new Error("chat_opening_not_greeting");
  const source = opening.source;
  let greetingEnvelope: Readonly<{ artifact: GreetingSet; canonicalHash: string }>;
  try {
    greetingEnvelope = await latestGreeting(
      input.store,
      source.greetingSetId,
      join(input.paths.companionRoot, "greetings", source.greetingSetId),
    );
  } catch {
    throw new Error("chat_opening_variant_not_found");
  }
  const greeting = greetingEnvelope.artifact;
  const currentIndex = greeting.variants.findIndex((variant) => variant.variantId === source.variantId);
  if (currentIndex < 0) throw new Error("chat_opening_variant_not_found");
  const count = greeting.variants.length;
  let targetIndex: number;
  if (input.targetIndex !== undefined) {
    if (!Number.isSafeInteger(input.targetIndex) || input.targetIndex < 0 || input.targetIndex >= count)
      throw new Error("chat_opening_variant_not_found");
    targetIndex = input.targetIndex;
  } else if (input.direction === "prev") targetIndex = Math.max(0, currentIndex - 1);
  else if (input.direction === "next") targetIndex = Math.min(count - 1, currentIndex + 1);
  else throw new Error("invalid_chat_opening_request");
  const variant = greeting.variants[targetIndex]!;
  const nextSource: GreetingSource = Object.freeze({
    greetingSetId: greeting.greetingSetId,
    sourceRevision: greetingEnvelope.artifact.revision,
    canonicalHash: greetingEnvelope.canonicalHash,
    variantId: variant.variantId,
    profileRevision: source.profileRevision,
    scenarioRevision: source.scenarioRevision,
  });
  // The same messageId keeps the browser's opaque opening handle stable across a choice.
  const committed = await input.threads.commitOpening(
    input.chatThreadId,
    Object.freeze({ messageId: opening.messageId, text: variant.text, source: nextSource }),
  );
  return Object.freeze({
    state: committed,
    variant: Object.freeze({
      variantId: variant.variantId,
      index: targetIndex,
      count,
      label: variant.label ?? null,
    }),
  });
}

async function currentCompanion(store: TavernArtifactStore, path: string): Promise<TavernCompanion> {
  return companionRepository(store, path).read();
}
function companionRepository(store: TavernArtifactStore, path: string) {
  return store.openArtifactRepository<TavernCompanion, TavernCompanion>({
    path,
    validateArtifact: (value) => {
      const artifact = validateTavernArtifact(value);
      if (!isCompanion(artifact)) throw new Error("invalid_tavern_companion");
      return artifact;
    },
    project: (artifact) => artifact,
  });
}
async function latestExact<T extends UserPersona | Scenario | DialogueExamples>(
  store: TavernArtifactStore,
  directory: string,
  key: "personaId" | "scenarioId" | "examplesId",
  id: string,
): Promise<T> {
  const envelope = await selectionRepository<T>(
    store,
    directory,
    id,
    "invalid_tavern_selection",
    (artifact) => key in artifact && (artifact as Record<string, unknown>)[key] === id,
  ).readLatestArtifact();
  if (envelope === undefined) throw new Error("invalid_tavern_selection");
  return envelope.artifact;
}
async function stableBinding(
  store: TavernArtifactStore,
  path: string,
  kind: TavernStableArtifactBinding["kind"],
  sourceId: string,
): Promise<TavernStableArtifactBinding> {
  const envelope = await store.read(path, validateTavernArtifact);
  return Object.freeze({ kind, sourceId, revision: envelope.revision, canonicalHash: envelope.canonicalHash });
}
/**
 * The companion's own opening, for a thread creation that names none: the reviewed card's
 * `first_mes` became the greeting record's default variant at provisioning, so a card-provisioned
 * companion HAS an opening. It is drawn from the same durable record the new-chat variant choice
 * later pages through, and the `sourceRevision` + `canonicalHash` it commits are that record's, so
 * the browser's `< 1/N >` projection resolves against the set the opening actually came from.
 *
 * A missing greeting set is ordinary - a directly-named companion has no card - and yields
 * nothing, which leaves the genuinely empty opening in place. A present but unreadable set fails
 * closed rather than silently blanking the first screen.
 */
export async function resolveCompanionOwnOpening(
  store: TavernArtifactStore,
  companionRoot: string,
  profileRevision: number,
  scenario: Scenario | undefined,
): Promise<CreateChatThreadRequest["opening"] | undefined> {
  const record = await createGreetingManagementService(store, companionRoot).readExact();
  if (record === null || record.variants.length === 0) return undefined;
  const variant = record.variants[0]!;
  const source: GreetingSource = Object.freeze({
    greetingSetId: record.greetingSetId,
    sourceRevision: record.revision,
    canonicalHash: record.canonicalHash,
    variantId: variant.variantId,
    profileRevision,
    scenarioRevision: scenario?.revision ?? null,
  });
  return Object.freeze({ messageId: randomUUID(), text: variant.text, source });
}

/**
 * The companion's own scenario: the reviewed card's scenario, persisted at
 * provisioning under the ONE derived id (`companionScenarioId`), so the writer and
 * every reader agree by construction instead of by two copies of a hash.
 *
 * Absent is ordinary - a directly-named companion has no card, and a card whose
 * scenario was not approved has none - and yields nothing to bind. A present but
 * unreadable scenario fails closed (the same bounded `invalid_tavern_selection` an
 * explicitly selected one already reports) rather than opening a Chat that
 * silently lost the card's setting.
 *
 * The binding is returned with the artifact because the caller must PERSIST it on
 * the thread: the mount path materializes only what the thread binds, and an
 * acceptance check refuses a source whose thread carries no binding.
 */
export async function resolveCompanionOwnScenario(
  store: TavernArtifactStore,
  companionRoot: string,
): Promise<Readonly<{ artifact: Scenario; binding: TavernStableArtifactBinding }> | undefined> {
  const sourceId = companionScenarioId(companionRoot);
  const envelope = await selectionRepository<Scenario>(
    store,
    join(companionRoot, "scenarios", sourceId),
    sourceId,
    "invalid_tavern_selection",
    (artifact) => artifact.scenarioId === sourceId,
  ).readLatestArtifact();
  if (envelope === undefined) return undefined;
  return Object.freeze({
    artifact: envelope.artifact,
    binding: Object.freeze({
      kind: "scenario" as const,
      sourceId,
      revision: envelope.revision,
      canonicalHash: envelope.canonicalHash,
    }),
  });
}

/**
 * The player's own persona, for a Chat that names none.
 *
 * The Characters panel asks how the companion should know the player and persists the
 * answer under the ONE derived id (`playerPersonaId`). Until a Chat bound it, the record
 * reached nothing: the catalogue only publishes sources the thread binds, so the player's
 * own name and the description of how she knows them were written and never sent.
 *
 * The binding is returned with the artifact because the caller must PERSIST it on the
 * thread: the mount path materializes only what the thread binds, and acceptance refuses
 * a persona source whose thread carries no binding.
 *
 * Absent is ordinary - a player who has not filled the panel has no persona, and `{{user}}`
 * stays the locale's own word. A present but unreadable persona fails closed (the same
 * bounded `invalid_tavern_selection` an explicitly selected one already reports) rather
 * than opening a Chat that silently lost how she knows you.
 */
export async function resolvePlayerOwnPersona(
  store: TavernArtifactStore,
  playerRoot: string,
): Promise<Readonly<{ artifact: UserPersona; binding: TavernStableArtifactBinding }> | undefined> {
  const sourceId = playerPersonaId(playerRoot);
  const envelope = await selectionRepository<UserPersona>(
    store,
    join(playerRoot, "personas", sourceId),
    sourceId,
    "invalid_tavern_selection",
    (artifact) => artifact.personaId === sourceId,
  ).readLatestArtifact();
  if (envelope === undefined) return undefined;
  return Object.freeze({
    artifact: envelope.artifact,
    binding: Object.freeze({
      kind: "persona" as const,
      sourceId,
      revision: envelope.revision,
      canonicalHash: envelope.canonicalHash,
    }),
  });
}

/**
 * The companion's own world book, for a Chat that names none.
 *
 * The reviewed ST-card import writes `<runtimeCwd>/worldbook.json`, and the Game
 * surface compiles that file into its Tier 2 m[0] unconditionally. The Chat
 * surface materializes only what the thread binds, so a companion provisioned from
 * a card carried its backdrop in Game and, unless the thread bound the book, lost
 * it in Chat.
 *
 * The binding is PERSISTED on the thread rather than injected when the catalog is
 * materialized: acceptance re-materializes against the stored thread and refuses a
 * world-info source whose thread carries no binding
 * (`tavern_stable_context_worldbook_binding_mismatch`), so a transient override
 * makes the two disagree and every turn fail closed. Defaulting it at creation
 * keeps the stored thread, the materialized catalog and the acceptance check in
 * agreement.
 *
 * A missing book is ordinary - a companion need not have one - and yields nothing
 * to bind. A present but unreadable book fails closed rather than silently emptying
 * the backdrop.
 */
export async function resolveCompanionOwnWorldBookBinding(
  runtimeCwd: string,
): Promise<TavernStableWorldBookBinding | undefined> {
  const worldBookPath = join(runtimeCwd, "worldbook.json");
  if (!existsSync(worldBookPath)) return undefined;
  const metadata = worldBookMetadata(await readWorldBook(worldBookPath));
  return Object.freeze({
    worldBookId: metadata.worldBookId,
    revision: metadata.revision,
    canonicalHash: metadata.canonicalHash,
    provenance: "reviewed-import" as const,
  });
}

async function greetingOpening(
  store: TavernArtifactStore,
  directory: string,
  profileRevision: number,
  scenario: Scenario | undefined,
  input: Extract<NewChatRequest["opening"], { kind: "greeting" }>,
): Promise<CreateChatThreadRequest["opening"]> {
  const greetingEnvelope = await latestGreeting(store, input.greetingSetId, directory);
  const greeting = greetingEnvelope.artifact;
  const variant = greeting.variants.find((item) => item.variantId === input.variantId);
  if (variant === undefined) throw new Error("tavern_greeting_variant_not_found");
  const source: GreetingSource = Object.freeze({
    greetingSetId: greeting.greetingSetId,
    sourceRevision: greeting.revision,
    canonicalHash: greetingEnvelope.canonicalHash,
    variantId: variant.variantId,
    profileRevision,
    scenarioRevision: scenario?.revision ?? null,
  });
  return Object.freeze({ messageId: input.messageId ?? randomUUID(), text: variant.text, source });
}
async function latestGreeting(
  store: TavernArtifactStore,
  id: string,
  directory: string,
): Promise<Readonly<{ artifact: GreetingSet; canonicalHash: string }>> {
  const envelope = await selectionRepository<GreetingSet>(
    store,
    directory,
    id,
    "invalid_tavern_greeting",
    (artifact) => isGreetingSet(artifact) && artifact.greetingSetId === id,
  ).readLatestArtifact();
  if (envelope === undefined) throw new Error("invalid_tavern_greeting");
  return envelope;
}
function selectionRepository<T extends UserPersona | Scenario | DialogueExamples | GreetingSet>(
  store: TavernArtifactStore,
  root: string,
  id: string,
  invalidMessage: string,
  matchesId: (artifact: T) => boolean,
) {
  return store.openRevisionRepository<T, T>({
    root,
    artifactKind: "library_selection",
    id,
    validateArtifact: (value) => validateTavernArtifact(value) as T,
    matchesId: (artifact) => matchesId(artifact),
    project: (artifact) => artifact,
    invalidArtifact: () => new Error(invalidMessage),
    conflict: () => new Error("invalid_tavern_selection"),
  });
}
function isCompanion(value: unknown): value is TavernCompanion {
  return typeof value === "object" && value !== null && "profileId" in value && "companionId" in value;
}
function isGreetingSet(value: unknown): value is GreetingSet {
  return typeof value === "object" && value !== null && "greetingSetId" in value && "variants" in value;
}

/**
 * The one bounded vocabulary for "the durable record cannot be read": a present
 * but corrupt/incomplete artifact (`invalid_tavern_artifact`), or the artifact
 * the library itself writes when it is absent (`tavern_artifact_unreadable`).
 * Every caller must surface this as the bounded, non-retryable data-integrity
 * fact it is - never collapse it into a `..._service_unavailable` runtime outage,
 * which would tell the player to retry something that cannot succeed.
 */
export function isTavernArtifactUnreadable(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (
    error.message === "tavern_artifact_unreadable" ||
    error.message === "invalid_tavern_artifact" ||
    error.message === "invalid_tavern_companion"
  );
}
