import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { readSafeDirectory } from "../path-lock.js";
import { TavernArtifactStore, TavernRevisionConflict } from "./artifact-store.js";
import type {
  ChatThread,
  ChatThreadState,
  ChatThreadStore,
  CreateChatThreadRequest,
  GreetingSource,
  TavernStableArtifactBinding,
  TavernStableWorldBookBinding,
} from "./chat-thread-store.js";
import { tavernRevisionPath, tavernRootForPath, type TavernPaths } from "./tavern-paths.js";
import {
  validateTavernArtifact,
  type DialogueExamples,
  type GreetingSet,
  type Scenario,
  type TavernCompanion,
  type UserPersona,
} from "./types.js";

/**
 * Small application boundary for the Tavern library and chat selector.
 * It persists inert Tavern metadata only: companion runtime provisioning,
 * IdentityProfile mutation, Magic Context, and Game operations stay outside it.
 */
export type TavernLibraryService = Readonly<{
  listCompanions(): Promise<readonly TavernCompanion[]>;
  createNewCompanion(input: NewCompanionRequest): Promise<TavernCompanion>;
  listChats(): Promise<readonly ChatThread[]>;
  createNewChat(input: NewChatRequest): Promise<ChatThreadState>;
  /** Reads and validates one exact thread/surface route; runtime owner pins it only after activation. */
  openChat(chatThreadId: string, chatSurfaceSessionId: string): Promise<ChatThreadState>;
  activeChatSelection(): ReturnType<ChatThreadStore["readActiveThreadSelection"]>;
}>;

export type NewCompanionRequest = Readonly<{
  companionId: string;
  continuityId: string;
  name: string;
  profileId: string;
  profileRevision: number;
  profileHash: string;
}>;

export type NewChatRequest = Readonly<{
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
): TavernLibraryService {
  const companionPath = join(paths.companionRoot, "companion.json");
  const personaPath = (personaId: string, revision: number) =>
    tavernRevisionPath(join(paths.playerRoot, "personas", personaId), revision);
  const scenarioPath = (scenarioId: string, revision: number) =>
    tavernRevisionPath(join(paths.companionRoot, "scenarios", scenarioId), revision);
  const greetingPath = (greetingSetId: string, revision: number) =>
    tavernRevisionPath(join(paths.companionRoot, "greetings", greetingSetId), revision);
  const examplesPath = (examplesId: string, revision: number) =>
    tavernRevisionPath(join(paths.companionRoot, "dialogue-examples", examplesId), revision);

  return Object.freeze({
    async listCompanions(): Promise<readonly TavernCompanion[]> {
      const root = join(paths.root, "companions");
      let entries: readonly string[];
      try {
        entries = await readSafeDirectory(root, paths.root);
      } catch (error) {
        if (nodeError(error, "ENOENT")) return Object.freeze([]);
        throw error;
      }
      // A companion namespace also owns Tavern catalog artifacts (Scenario,
      // Greeting, examples). It is not a Library companion until direct or
      // reviewed provisioning wrote its own companion.json. Skip namespaces
      // without that exact record rather than treating normal catalog folders
      // as corrupt Library entries.
      const companions = await Promise.all(
        [...entries].sort().map(async (entry) => {
          try {
            const artifact = await store.read(join(root, entry, "companion.json"), validateTavernArtifact);
            return isCompanion(artifact.artifact) ? artifact.artifact : undefined;
          } catch (error) {
            if (error instanceof Error && error.message === "tavern_artifact_unreadable") return undefined;
            throw error;
          }
        }),
      );
      return Object.freeze(companions.filter((companion): companion is TavernCompanion => companion !== undefined));
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
      return threads.createThread(request);
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
  const artifact = (await store.read(path, validateTavernArtifact)).artifact;
  if (!isCompanion(artifact)) throw new Error("invalid_tavern_companion");
  return artifact;
}
async function latestExact<T extends UserPersona | Scenario | DialogueExamples>(
  store: TavernArtifactStore,
  directory: string,
  key: "personaId" | "scenarioId" | "examplesId",
  id: string,
): Promise<T> {
  let names: readonly string[];
  try {
    names = await readSafeDirectory(join(directory, "revisions"), tavernRootForPath(directory));
  } catch {
    throw new Error("invalid_tavern_selection");
  }
  const revisions = names
    .map((name) => /^(\d+)\.json$/u.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((a, b) => b - a);
  for (const revision of revisions) {
    try {
      const envelope = await store.read(tavernRevisionPath(directory, revision), validateTavernArtifact);
      const artifact = envelope.artifact;
      if (
        envelope.revision === revision &&
        key in artifact &&
        (artifact as Record<string, unknown>)[key] === id &&
        artifact.revision === revision
      )
        return artifact as T;
    } catch {
      /* never select invalid revision files */
    }
  }
  throw new Error("invalid_tavern_selection");
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
  let names: readonly string[];
  try {
    names = await readSafeDirectory(join(directory, "revisions"), tavernRootForPath(directory));
  } catch {
    throw new Error("invalid_tavern_greeting");
  }
  const revisions = names
    .map((name) => /^(\d+)\.json$/u.exec(name)?.[1])
    .filter((value): value is string => value !== undefined)
    .map(Number)
    .filter(Number.isSafeInteger)
    .sort((a, b) => b - a);
  for (const revision of revisions) {
    try {
      const envelope = await store.read(tavernRevisionPath(directory, revision), validateTavernArtifact);
      if (
        isGreetingSet(envelope.artifact) &&
        envelope.artifact.greetingSetId === id &&
        envelope.revision === revision &&
        envelope.artifact.revision === revision
      )
        return envelope as Readonly<{ artifact: GreetingSet; canonicalHash: string }>;
    } catch {
      /* invalid revisions are never selected */
    }
  }
  throw new Error("invalid_tavern_greeting");
}
function isCompanion(value: unknown): value is TavernCompanion {
  return typeof value === "object" && value !== null && "profileId" in value && "companionId" in value;
}
function isGreetingSet(value: unknown): value is GreetingSet {
  return typeof value === "object" && value !== null && "greetingSetId" in value && "variants" in value;
}
function nodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
