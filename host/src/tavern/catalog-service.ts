import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, TavernArtifactStore } from "./artifact-store.js";
import type {
  ChatThread,
  TavernStableManagedWorldInfoBinding,
  TavernStableWorldBookBinding,
  TavernStableWorldInfoBinding,
} from "./chat-thread-store.js";
import { tavernRevisionPath, type TavernPaths } from "./tavern-paths.js";
import {
  validateTavernArtifact,
  type DialogueExamples,
  type GreetingSet,
  type Scenario,
  type TavernCompanion,
  type UserPersona,
  type WorldBookBinding,
} from "./types.js";

/**
 * Catalog and selection boundary for inert Tavern sources. It deliberately
 * returns references and metadata, never a prompt, runtime binding, or Game
 * capability. Persistence is supplied by the caller through this narrow port.
 */
export type TavernCatalog = Readonly<{
  personas: readonly UserPersona[];
  scenarios: readonly Scenario[];
  greetings: readonly GreetingSet[];
  worldBooks: readonly WorldBookBinding[];
}>;
export type TavernBindingScope =
  | Readonly<{ kind: "companion"; companionId: string }>
  | Readonly<{ kind: "chat"; companionId: string; continuityId: string; chatThreadId: string }>;
export type TavernCatalogSelection = Readonly<{
  schemaVersion: 1;
  revision: number;
  scope: TavernBindingScope;
  personaId?: string;
  scenarioId?: string;
  greetingSetId?: string;
  worldBookBindingIds: readonly string[];
}>;
export type TavernStableContextBinding = Readonly<{ continuityId: string; sessionId: string; surface: "tavern" }>;
export type TavernStableContextSnapshot = Readonly<{
  version: "gamebuddy-stable-context-source/v1";
  continuityId: string;
  sessionId: string;
  surface: "tavern";
  canonicalHash: string;
  sources: readonly Readonly<{
    sourceId: string;
    kind: "persona" | "scenario" | "dialogue_examples" | "worldbook";
    revision: string;
    canonicalHash: string;
    content: string;
    budgetTokens: number;
    totalOrderKey: string;
    provenance: string;
  }>[];
}>;
export type TavernAlwaysOnWorldBookSource = Readonly<{
  binding: TavernStableWorldBookBinding;
  alwaysOnPremise: string;
}>;
/** Managed World Info is source-aware and uses exact repository revision content. */
export type TavernManagedWorldInfoSource = Readonly<{ binding: TavernStableManagedWorldInfoBinding; content: string }>;
export type TavernWorldInfoSource = TavernAlwaysOnWorldBookSource | TavernManagedWorldInfoSource;

/** Conservative ceiling for Host-owned immutable stable source material. */
export const TAVERN_STABLE_CONTEXT_MAX_TOKENS = 2_048;

/**
 * Derives the only Host-publishable Tavern stable snapshot from exact selected
 * artifact revisions. Missing selected revisions, thread/binding mismatches,
 * and budget overflow reject before any model turn; absent selections produce
 * an explicit empty tombstone rather than invented sources.
 */
export async function materializeTavernStableContext(
  paths: TavernPaths,
  store: TavernArtifactStore,
  thread: ChatThread,
  binding: TavernStableContextBinding,
  worldInfoSource?: TavernWorldInfoSource,
): Promise<TavernStableContextSnapshot> {
  if (
    thread.companionId !== paths.companionId ||
    thread.continuityId !== paths.continuityId ||
    binding.continuityId !== paths.continuityId ||
    binding.surface !== "tavern"
  )
    throw new Error("tavern_stable_context_binding_mismatch");
  if ((thread.worldBookBinding === undefined) !== (worldInfoSource === undefined))
    throw new Error("tavern_stable_context_worldbook_binding_mismatch");
  if (
    worldInfoSource !== undefined &&
    (!sameWorldInfoBinding(thread.worldBookBinding!, worldInfoSource.binding) ||
      !validSourceContent(worldInfoContent(worldInfoSource)))
  )
    throw new Error("tavern_stable_context_worldbook_binding_mismatch");
  const selectedBindings = thread.stableArtifactBindings ?? [];
  if (
    (thread.personaId !== undefined &&
      !selectedBindings.some((selected) => selected.kind === "persona" && selected.sourceId === thread.personaId)) ||
    (thread.scenarioId !== undefined &&
      !selectedBindings.some((selected) => selected.kind === "scenario" && selected.sourceId === thread.scenarioId))
  )
    throw new Error("tavern_stable_context_source_binding_missing");
  const sources: Array<TavernStableContextSnapshot["sources"][number]> = [];
  for (const [index, selected] of selectedBindings.entries()) {
    const directory =
      selected.kind === "persona"
        ? join(paths.playerRoot, "personas", selected.sourceId)
        : selected.kind === "scenario"
          ? join(paths.companionRoot, "scenarios", selected.sourceId)
          : join(paths.companionRoot, "dialogue-examples", selected.sourceId);
    const envelope = await store.read(tavernRevisionPath(directory, selected.revision), validateTavernArtifact);
    if (envelope.canonicalHash !== selected.canonicalHash)
      throw new Error("tavern_stable_context_source_hash_mismatch");
    const artifact = envelope.artifact;
    const valid =
      selected.kind === "persona"
        ? "personaId" in artifact && artifact.personaId === selected.sourceId
        : selected.kind === "scenario"
          ? "scenarioId" in artifact && artifact.scenarioId === selected.sourceId
          : "examplesId" in artifact && artifact.examplesId === selected.sourceId;
    if (!valid) throw new Error("tavern_stable_context_source_mismatch");
    const content =
      selected.kind === "persona"
        ? canonicalJson({
            name: (artifact as UserPersona).name,
            ...((artifact as UserPersona).description === undefined
              ? {}
              : { description: (artifact as UserPersona).description }),
          })
        : selected.kind === "scenario"
          ? (artifact as Scenario).text
          : canonicalJson({ blocks: (artifact as DialogueExamples).blocks });
    sources.push(
      source(
        selected.kind,
        selected.sourceId,
        selected.revision,
        envelope.canonicalHash,
        content,
        String(index + 1).padStart(4, "0"),
      ),
    );
  }
  if (worldInfoSource !== undefined) {
    const sourceId =
      "source" in worldInfoSource.binding ? worldInfoSource.binding.publicTitle : worldInfoSource.binding.worldBookId;
    const provenance =
      "source" in worldInfoSource.binding
        ? `managed-world-info/${worldInfoSource.binding.publicTitle}/revision/${worldInfoSource.binding.revision}/canonical/${worldInfoSource.binding.canonicalHash}`
        : `worldbook/${worldInfoSource.binding.worldBookId}/revision/${worldInfoSource.binding.revision}/canonical/${worldInfoSource.binding.canonicalHash}/provenance/${worldInfoSource.binding.provenance}`;
    sources.push(
      source(
        "worldbook",
        sourceId,
        worldInfoSource.binding.revision,
        worldInfoSource.binding.canonicalHash,
        worldInfoContent(worldInfoSource),
        "0004",
        provenance,
      ),
    );
  }
  const budgetTokens = sources.reduce((total, item) => total + item.budgetTokens, 0);
  if (budgetTokens > TAVERN_STABLE_CONTEXT_MAX_TOKENS) throw new Error("tavern_stable_context_oversize");
  const body = {
    version: "gamebuddy-stable-context-source/v1" as const,
    continuityId: binding.continuityId,
    sessionId: binding.sessionId,
    surface: binding.surface,
    sources,
  };
  return Object.freeze({ ...body, canonicalHash: hash(canonicalJson(body)), sources: Object.freeze(sources) });
}

export type TavernCatalogBindingStore = Readonly<{
  read(scope: TavernBindingScope): Promise<TavernCatalogSelection | undefined>;
  write(selection: TavernCatalogSelection, expectedRevision: number | undefined): Promise<TavernCatalogSelection>;
}>;
export type TavernCatalogService = Readonly<{
  list(catalog: TavernCatalog): Readonly<{
    personas: readonly UserPersona[];
    scenarios: readonly Scenario[];
    greetings: readonly GreetingSet[];
    worldBooks: readonly WorldBookBinding[];
  }>;
  select(
    companion: TavernCompanion,
    catalog: TavernCatalog,
    selection: Readonly<{
      scope: TavernBindingScope;
      personaId?: string;
      scenarioId?: string;
      greetingSetId?: string;
      worldBookBindingIds?: readonly string[];
    }>,
  ): Promise<TavernCatalogSelection>;
  read(scope: TavernBindingScope): Promise<TavernCatalogSelection | undefined>;
}>;

export function createTavernCatalogService(store: TavernCatalogBindingStore): TavernCatalogService {
  return Object.freeze({
    list(catalog) {
      validateCatalog(catalog);
      return Object.freeze({
        personas: latest(catalog.personas, "personaId"),
        scenarios: latest(catalog.scenarios, "scenarioId"),
        greetings: latest(catalog.greetings, "greetingSetId"),
        worldBooks: freeze(catalog.worldBooks),
      });
    },
    async select(companion, catalog, input) {
      validateCatalog(catalog);
      validateScope(input.scope);
      if (
        input.scope.companionId !== companion.companionId ||
        (input.scope.kind === "chat" && input.scope.continuityId !== companion.continuityId)
      )
        throw new Error("tavern_catalog_scope_mismatch");
      selected(latest(catalog.personas, "personaId"), input.personaId, "personaId");
      selected(latest(catalog.scenarios, "scenarioId"), input.scenarioId, "scenarioId");
      selected(latest(catalog.greetings, "greetingSetId"), input.greetingSetId, "greetingSetId");
      const ids = input.worldBookBindingIds === undefined ? [] : [...input.worldBookBindingIds];
      if (
        new Set(ids).size !== ids.length ||
        !ids.every(isId) ||
        !ids.every((id) => catalog.worldBooks.some((book) => book.bindingId === id && book.scope === input.scope.kind))
      )
        throw new Error("invalid_tavern_worldbook_selection");
      const previous = await store.read(input.scope);
      const value: TavernCatalogSelection = Object.freeze({
        schemaVersion: 1,
        revision: (previous?.revision ?? 0) + 1,
        scope: freezeScope(input.scope),
        ...(input.personaId === undefined ? {} : { personaId: input.personaId }),
        ...(input.scenarioId === undefined ? {} : { scenarioId: input.scenarioId }),
        ...(input.greetingSetId === undefined ? {} : { greetingSetId: input.greetingSetId }),
        worldBookBindingIds: Object.freeze(ids),
      });
      return store.write(value, previous?.revision);
    },
    read(scope) {
      validateScope(scope);
      return store.read(scope);
    },
  });
}

function validateCatalog(catalog: TavernCatalog): void {
  for (const values of [catalog.personas, catalog.scenarios, catalog.greetings, catalog.worldBooks])
    if (!Array.isArray(values)) throw new Error("invalid_tavern_catalog");
  validRevisions(catalog.personas, "personaId");
  validRevisions(catalog.scenarios, "scenarioId");
  validRevisions(catalog.greetings, "greetingSetId");
  unique(catalog.worldBooks.map((value) => value.bindingId));
}
function validRevisions(
  values: readonly Readonly<Record<string, unknown>>[],
  key: "personaId" | "scenarioId" | "greetingSetId",
): void {
  const seen = new Set<string>();
  for (const value of values) {
    const id = value[key];
    if (
      !isId(id) ||
      !Number.isSafeInteger(value.revision) ||
      (value.revision as number) < 1 ||
      seen.has(`${id}\u001f${value.revision}`)
    )
      throw new Error("invalid_tavern_catalog");
    seen.add(`${id}\u001f${value.revision}`);
  }
}
function latest<T extends Readonly<Record<string, unknown>>>(
  values: readonly T[],
  key: "personaId" | "scenarioId" | "greetingSetId",
): readonly T[] {
  const current = new Map<string, T>();
  for (const value of values) {
    const id = value[key] as string;
    const selected = current.get(id);
    if (selected === undefined || (value.revision as number) > (selected.revision as number)) current.set(id, value);
  }
  return freeze([...current.values()].sort((left, right) => String(left[key]).localeCompare(String(right[key]))));
}
function selected(
  values: readonly Record<string, unknown>[],
  id: string | undefined,
  key: "personaId" | "scenarioId" | "greetingSetId",
): void {
  if (id !== undefined && (!isId(id) || !values.some((value) => value[key] === id)))
    throw new Error("invalid_tavern_catalog_selection");
}
function unique(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length || !ids.every(isId)) throw new Error("invalid_tavern_catalog");
}
function validateScope(scope: TavernBindingScope): void {
  if (
    !isId(scope.companionId) ||
    (scope.kind !== "companion" && scope.kind !== "chat") ||
    (scope.kind === "chat" && (!isId(scope.continuityId) || !isId(scope.chatThreadId)))
  )
    throw new Error("invalid_tavern_binding_scope");
}
function freezeScope(scope: TavernBindingScope): TavernBindingScope {
  return scope.kind === "companion"
    ? Object.freeze({ kind: "companion", companionId: scope.companionId })
    : Object.freeze({
        kind: "chat",
        companionId: scope.companionId,
        continuityId: scope.continuityId,
        chatThreadId: scope.chatThreadId,
      });
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
function source(
  kind: "persona" | "scenario" | "dialogue_examples" | "worldbook",
  sourceId: string,
  revision: number,
  artifactHash: string,
  content: string,
  totalOrderKey: string,
  provenance = `tavern-artifact/${kind}/${sourceId}/revision/${revision}/canonical/${artifactHash}`,
): TavernStableContextSnapshot["sources"][number] {
  const budgetTokens = Math.ceil(content.length / 4);
  if (!validSourceContent(content) || budgetTokens <= 0) throw new Error("tavern_stable_context_invalid_source");
  return Object.freeze({
    sourceId,
    kind,
    revision: String(revision),
    canonicalHash: hash(content),
    content,
    budgetTokens,
    totalOrderKey,
    provenance,
  });
}
function sameWorldInfoBinding(left: TavernStableWorldInfoBinding, right: TavernStableWorldInfoBinding): boolean {
  if ("source" in left || "source" in right)
    return (
      "source" in left &&
      "source" in right &&
      left.source === "managed_world_info" &&
      right.source === "managed_world_info" &&
      left.publicTitle === right.publicTitle &&
      left.revision === right.revision &&
      left.canonicalHash === right.canonicalHash
    );
  return (
    left.worldBookId === right.worldBookId &&
    left.revision === right.revision &&
    left.canonicalHash === right.canonicalHash &&
    left.provenance === right.provenance
  );
}
function worldInfoContent(source: TavernWorldInfoSource): string {
  return "content" in source ? source.content : source.alwaysOnPremise;
}
function validSourceContent(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !/[\u0000\u007f]/u.test(value);
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
function freeze<T>(values: readonly T[]): readonly T[] {
  return Object.freeze([...values]);
}
