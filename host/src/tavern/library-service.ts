import { randomUUID } from "node:crypto";
import type { IdentityProfileMetadata } from "../identity-profile.js";
import { join } from "node:path";
import { type TavernArtifactStore, TavernRevisionConflict } from "./artifact-store.js";
import { createProfileAwareChatThreadCreationCapability } from "./chat-thread-store.js";
import type {
  ChatThread,
  ChatThreadState,
  ChatThreadStore,
  CreateChatThreadRequest,
  GreetingSource,
  TavernStableArtifactBinding,
  TavernStableWorldBookBinding,
} from "./chat-thread-store.js";
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
  worldBookBinding?: TavernStableWorldBookBinding;
  opening:
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
      const companion = await currentCompanion(store, companionPath);
      if (companion.companionId !== paths.companionId || companion.continuityId !== paths.continuityId)
        throw new Error("tavern_companion_scope_mismatch");
      const persona =
        input.personaId === undefined
          ? undefined
          : await latestExact<UserPersona>(
              store,
              join(paths.playerRoot, "personas", input.personaId),
              "personaId",
              input.personaId,
            );
      const scenario =
        input.scenarioId === undefined
          ? undefined
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
          await stableBinding(store, personaPath(persona.personaId, persona.revision), "persona", persona.personaId),
        );
      if (scenario !== undefined)
        stableArtifactBindings.push(
          await stableBinding(
            store,
            scenarioPath(scenario.scenarioId, scenario.revision),
            "scenario",
            scenario.scenarioId,
          ),
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
      const opening =
        input.opening.kind === "blank"
          ? "blank"
          : await greetingOpening(
              store,
              join(paths.companionRoot, "greetings", input.opening.greetingSetId),
              companion,
              scenario,
              input.opening,
            );
      const request: CreateChatThreadRequest = {
        chatThreadId: input.chatThreadId,
        companionId: companion.companionId,
        continuityId: companion.continuityId,
        chatSurfaceSessionId: input.chatSurfaceSessionId,
        ...(persona === undefined ? {} : { personaId: persona.personaId }),
        ...(scenario === undefined ? {} : { scenarioId: scenario.scenarioId }),
        stableArtifactBindings,
        ...(input.worldBookBinding === undefined ? {} : { worldBookBinding: input.worldBookBinding }),
        opening,
      };
      return threadCreation.createExplicit(request);
    },

    async commitOpeningVariant(input: CommitOpeningVariantRequest): Promise<ChatThreadState> {
      if ((input.direction === undefined) === (input.targetIndex === undefined))
        throw new Error("invalid_chat_opening_request");
      const state = await threads.resumeThread(input.chatThreadId, input.chatSurfaceSessionId);
      const companion = await currentCompanion(store, companionPath);
      if (
        companion.companionId !== paths.companionId ||
        companion.continuityId !== paths.continuityId ||
        state.thread.companionId !== companion.companionId ||
        state.thread.continuityId !== companion.continuityId
      )
        throw new Error("tavern_chat_scope_mismatch");
      // The durable lock is the whole legality of this operation: once the opening has been sealed
      // by a player/companion message it can no longer change, and that is a bounded refusal rather
      // than a silent no-op. `commitOpening` re-checks it under its own transaction.
      if (state.thread.openingLockedAtEventId !== null) throw new Error("chat_opening_locked");
      const opening = state.thread.openingSelection;
      if (opening.kind !== "greeting") throw new Error("chat_opening_not_greeting");
      const source = opening.source;
      let greetingEnvelope: Readonly<{ artifact: GreetingSet; canonicalHash: string }>;
      try {
        greetingEnvelope = await latestGreeting(
          store,
          source.greetingSetId,
          join(paths.companionRoot, "greetings", source.greetingSetId),
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
      return threads.commitOpening(
        input.chatThreadId,
        Object.freeze({ messageId: opening.messageId, text: variant.text, source: nextSource }),
      );
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
async function greetingOpening(
  store: TavernArtifactStore,
  directory: string,
  companion: TavernCompanion,
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
    profileRevision: companion.profileRevision,
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
