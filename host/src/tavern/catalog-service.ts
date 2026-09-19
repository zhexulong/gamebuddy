import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, type TavernArtifactStore } from "./artifact-store.js";
import type {
  ChatThread,
  TavernStableManagedWorldInfoBinding,
  TavernStableWorldBookBinding,
  TavernStableWorldInfoBinding,
} from "./chat-thread-store.js";
import { type TavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import {
  type DialogueExamples,
  type Scenario,
  type UserPersona,
  validateTavernArtifact,
} from "./types.js";

export type TavernStableContextBinding = Readonly<{
  continuityId: string;
  sessionId: string;
  surface: "tavern";
  threadId: string;
  profile: Readonly<{ profileId: string; revision: number; canonicalHash: string }>;
}>;
export type TavernAuthoredContextCatalog = Readonly<{
  version: "gamebuddy-authored-context-catalog/v2";
  scope: TavernStableContextBinding;
  canonicalHash: string;
  stableSources: readonly Readonly<{
    sourceId: string;
    kind: "persona" | "scenario" | "dialogue_examples" | "lorebook_constant";
    revision: string;
    canonicalHash: string;
    content: string;
    budgetTokens: number;
    totalOrderKey: string;
    provenance: string;
  }>[];
  volatileSources: readonly Readonly<{
    sourceId: string;
    kind: "lorebook_entry";
    revision: string;
    canonicalHash: string;
    content: string;
    budgetTokens: number;
    totalOrderKey: string;
    provenance: string;
    /** Selection-only metadata; stripped before durable turn persistence. */
    selectionKeys: readonly string[];
    secondaryKeys?: readonly string[];
    selectiveLogic?: 0 | 1 | 2 | 3;
  }>[];
}>;
type TavernAlwaysOnWorldBookSource = Readonly<{
  binding: TavernStableWorldBookBinding;
  alwaysOnPremise: string;
}>;
/** Managed World Info is source-aware and uses exact repository revision content. */
type TavernManagedWorldInfoSource = Readonly<{ binding: TavernStableManagedWorldInfoBinding; content: string }>;
export type TavernWorldInfoSource = TavernAlwaysOnWorldBookSource | TavernManagedWorldInfoSource;

/** Conservative ceiling for Host-owned immutable stable source material. */
const TAVERN_STABLE_CONTEXT_MAX_TOKENS = 2_048;

/**
 * Derives the only Host-publishable Tavern stable snapshot from exact selected
 * artifact revisions. Missing selected revisions, thread/binding mismatches,
 * and budget overflow reject before any model turn; absent selections produce
 * an explicit empty tombstone rather than invented sources.
 */
export async function materializeTavernAuthoredStableCatalog(
  paths: TavernPaths,
  store: TavernArtifactStore,
  thread: ChatThread,
  binding: TavernStableContextBinding,
  worldInfoSource?: TavernWorldInfoSource,
): Promise<TavernAuthoredContextCatalog> {
  return materializeTavernAuthoredContextCatalog(paths, store, thread, binding, worldInfoSource);
}

export async function materializeTavernAuthoredContextCatalog(
  paths: TavernPaths,
  store: TavernArtifactStore,
  thread: ChatThread,
  binding: TavernStableContextBinding,
  worldInfoSource?: TavernWorldInfoSource,
): Promise<TavernAuthoredContextCatalog> {
  if (
    thread.companionId !== paths.companionId ||
    thread.continuityId !== paths.continuityId ||
    binding.continuityId !== paths.continuityId ||
    binding.surface !== "tavern" ||
    binding.threadId !== thread.chatThreadId ||
    binding.profile.profileId !== thread.profileId ||
    binding.profile.revision !== thread.profileRevision ||
    binding.profile.canonicalHash !== thread.profileCanonicalHash
  )
    throw new Error("tavern_stable_context_binding_mismatch");
  if ((thread.worldBookBinding === undefined) !== (worldInfoSource === undefined))
    throw new Error("tavern_stable_context_worldbook_binding_mismatch");
  if (
    worldInfoSource !== undefined &&
    (!sameWorldInfoBinding(thread.worldBookBinding!, worldInfoSource.binding) ||
      !validSourceContent(worldInfoContent(worldInfoSource)) ||
      ("source" in worldInfoSource.binding &&
        hash(worldInfoContent(worldInfoSource)) !== worldInfoSource.binding.canonicalHash))
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
  const sources: Array<TavernAuthoredContextCatalog["stableSources"][number]> = [];
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
      "source" in worldInfoSource.binding
        ? managedWorldInfoSourceId(worldInfoSource.binding)
        : worldInfoSource.binding.worldBookId;
    const provenance =
      "source" in worldInfoSource.binding
        ? `managed-world-info/${worldInfoSource.binding.publicTitle}/revision/${worldInfoSource.binding.revision}/canonical/${worldInfoSource.binding.canonicalHash}`
        : `worldbook/${worldInfoSource.binding.worldBookId}/revision/${worldInfoSource.binding.revision}/canonical/${worldInfoSource.binding.canonicalHash}/provenance/${worldInfoSource.binding.provenance}`;
    const stableWorldInfoContent = deriveStableWorldInfoContent(worldInfoSource);
    sources.push(
      source(
        "lorebook_constant",
        sourceId,
        worldInfoSource.binding.revision,
        worldInfoSource.binding.canonicalHash,
        stableWorldInfoContent,
        String(sources.length + 1).padStart(4, "0"),
        provenance,
      ),
    );
  }
  const budgetTokens = sources.reduce((total, item) => total + item.budgetTokens, 0);
  if (budgetTokens > TAVERN_STABLE_CONTEXT_MAX_TOKENS) throw new Error("tavern_stable_context_oversize");
  const volatileSources = worldInfoSource === undefined ? Object.freeze([]) : deriveVolatileWorldInfoSources(worldInfoSource, sources.find((item) => item.kind === "lorebook_constant")?.sourceId ?? "world-info");
  const body = {
    version: "gamebuddy-authored-context-catalog/v2" as const,
    scope: binding,
    stableSources: sources,
    volatileSources,
  };
  return Object.freeze({ ...body, canonicalHash: hash(canonicalJson(body)), stableSources: Object.freeze(sources), volatileSources: Object.freeze(volatileSources) });
}
function source(
  kind: "persona" | "scenario" | "dialogue_examples" | "lorebook_constant",
  sourceId: string,
  revision: number,
  artifactHash: string,
  content: string,
  totalOrderKey: string,
  provenance = `tavern-artifact/${kind}/${sourceId}/revision/${revision}/canonical/${artifactHash}`,
): TavernAuthoredContextCatalog["stableSources"][number] {
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
function managedWorldInfoSourceId(binding: TavernStableManagedWorldInfoBinding): string {
  return `managed_world_info_${createHash("sha256")
    .update(`${binding.publicTitle}\u001f${binding.revision}\u001f${binding.canonicalHash}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}
function worldInfoContent(source: TavernWorldInfoSource): string {
  return "content" in source ? source.content : source.alwaysOnPremise;
}

function deriveStableWorldInfoContent(sourceValue: TavernWorldInfoSource): string {
  const rawContent = worldInfoContent(sourceValue);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    return rawContent;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return boundedWorldInfoOverview(rawContent);
  const constantEntries = parsed.entries.filter((entry) => isRecord(entry) && entry.constant === true);
  const overview = canonicalJson({
    ...(typeof parsed.publicTitle === "string" ? { publicTitle: parsed.publicTitle } : {}),
    ...(typeof parsed.summary === "string" ? { summary: parsed.summary } : {}),
  });
  if (constantEntries.length === 0) return boundedWorldInfoOverview(overview);
  const constants = canonicalJson({
    ...(typeof parsed.publicTitle === "string" ? { publicTitle: parsed.publicTitle } : {}),
    entries: constantEntries,
  });
  return Math.ceil(constants.length / 4) <= TAVERN_STABLE_CONTEXT_MAX_TOKENS
    ? constants
    : boundedWorldInfoOverview(overview);
}
function boundedWorldInfoOverview(content: string): string {
  const maxCharacters = TAVERN_STABLE_CONTEXT_MAX_TOKENS * 4;
  return content.length <= maxCharacters ? content : content.slice(0, maxCharacters).trim();
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function deriveVolatileWorldInfoSources(sourceValue: TavernWorldInfoSource, parentSourceId: string): TavernAuthoredContextCatalog["volatileSources"] {
  let parsed: unknown;
  try { parsed = JSON.parse(worldInfoContent(sourceValue)); } catch { return Object.freeze([]); }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return Object.freeze([]);
  const revision = sourceValue.binding.revision;
  const canonical = sourceValue.binding.canonicalHash;
  return Object.freeze(parsed.entries.flatMap((entry, index) => {
    if (!isRecord(entry)) throw new Error("tavern_volatile_context_invalid_source");
    if (entry.constant === true) return [];
    if (typeof entry.publicTitle !== "string" || typeof entry.summary !== "string") throw new Error("tavern_volatile_context_invalid_source");
    const content = entry.summary;
    if (!validSourceContent(content)) throw new Error("tavern_volatile_context_invalid_source");
    const sourceId = `${parentSourceId}_entry_${index + 1}`;
    const provenance = `tavern-world-info-entry/${sourceId}/revision/${revision}/canonical/${canonical}`;
    const selectionKeys = Array.isArray(entry.keys) && entry.keys.length > 0 ? entry.keys : [entry.publicTitle];
    if (selectionKeys.some((key) => typeof key !== "string" || key.trim().length === 0)) throw new Error("tavern_volatile_context_invalid_source");
    const secondaryKeys = Array.isArray(entry.secondaryKeys) && entry.secondaryKeys.length > 0 ? entry.secondaryKeys : undefined;
    if (secondaryKeys && secondaryKeys.some((key: unknown) => typeof key !== "string" || key.trim().length === 0)) {
      throw new Error("tavern_volatile_context_invalid_source");
    }
    if (
      entry.selectiveLogic !== undefined &&
      !(typeof entry.selectiveLogic === "number" && ([0, 1, 2, 3] as readonly number[]).includes(entry.selectiveLogic))
    ) {
      throw new Error("tavern_volatile_context_invalid_source");
    }
    const selectiveLogic =
      typeof entry.selectiveLogic === "number" && ([0, 1, 2, 3] as readonly number[]).includes(entry.selectiveLogic)
        ? (entry.selectiveLogic as 0 | 1 | 2 | 3)
        : undefined;
    return [
      Object.freeze({
        sourceId,
        kind: "lorebook_entry" as const,
        revision: String(revision),
        canonicalHash: hash(content),
        content,
        budgetTokens: Math.ceil(content.length / 4),
        totalOrderKey: String(index + 1).padStart(4, "0"),
        provenance,
        selectionKeys: Object.freeze([...selectionKeys]),
        ...(secondaryKeys !== undefined ? { secondaryKeys: Object.freeze([...secondaryKeys]) } : {}),
        ...(selectiveLogic !== undefined ? { selectiveLogic } : {}),
      }),
    ];
  }));
}
function validSourceContent(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !/[\u0000\u007f]/u.test(value);
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
