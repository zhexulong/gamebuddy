import { createHash } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, type TavernArtifactStore } from "./artifact-store.js";
import { hasUnrenderedMacro, renderMacros, renderWorldBookText, type MacroTable } from "./macro-engine.js";
import type {
  ChatThread,
  TavernStableManagedWorldInfoBinding,
  TavernStableWorldBookBinding,
  TavernStableWorldInfoBinding,
} from "./chat-thread-store.js";
import { type TavernPaths, tavernRevisionPath } from "./tavern-paths.js";
import { type DialogueExamples, type Scenario, type UserPersona, validateTavernArtifact } from "./types.js";
import type { WorldBookBinding } from "../worldbook.js";

export type TavernStableContextBinding = Readonly<{
  continuityId: string;
  sessionId: string;
  surface: "tavern" | "game";
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
export type TavernCompanionWorldBookSource = Readonly<{
  binding: TavernStableWorldBookBinding;
  alwaysOnPremise: string;
  /** Reviewed always-on entries (card `constant: true`); ride the stable source. */
  constantEntries?: readonly Readonly<{ entryId: string; title: string; content: string }>[];
  /** Keyword-gated entries; stay out of the stable prefix, become volatile candidates. */
  keywordEntries?: readonly Readonly<{ entryId: string; title: string; content: string; keys?: readonly string[] }>[];
}>;
/** Managed World Info is source-aware and uses exact repository revision content. */
type TavernManagedWorldInfoSource = Readonly<{
  binding: TavernStableManagedWorldInfoBinding;
  content: string;
}>;
type TavernWorldInfoSource = TavernCompanionWorldBookSource | TavernManagedWorldInfoSource;
/**
 * The two World Info layers one Chat turn assembles. They coexist and neither
 * displaces the other: layer 1 is the companion's own reviewed Card book - part
 * of who she is, always applied - and layer 2 is the managed library item this
 * Chat attached, which the World Info panel's Attach/Detach governs.
 */
export type TavernWorldInfoLayers = Readonly<{
  companionWorldBook?: TavernCompanionWorldBookSource;
  managedWorldInfo?: TavernManagedWorldInfoSource;
}>;

/** Conservative ceiling for Host-owned immutable stable source material. */
const TAVERN_STABLE_CONTEXT_MAX_TOKENS = 2_048;

/**
 * Derives the only Host-publishable Tavern stable snapshot from exact selected
 * artifact revisions. Missing selected revisions, thread/binding mismatches,
 * and budget overflow reject before any model turn; absent selections produce
 * an explicit empty tombstone rather than invented sources. Authored text is
 * rendered through the run's macro table, so no `{{user}}`/`{{char}}` placeholder
 * is published as the companion's own context.
 *
 * Both World Info layers materialize here when their source is supplied. Layer 1
 * (the companion's own book) is emitted first, so its position and total order key
 * never depend on whether the player attached anything; layer 2 (the attached
 * managed item) follows. There is no per-layer budget: both share the single
 * Tier-2 stable ceiling this assembly already enforced for its one world-info
 * source. Keyword-gated entries of either layer become volatile candidates and
 * keep the per-turn key matching in
 * `selectAuthoredContextVolatileSourceRefs` (chat-thread-store.ts).
 */
export async function materializeTavernAuthoredStableCatalog(
  paths: TavernPaths,
  store: TavernArtifactStore,
  thread: ChatThread,
  binding: TavernStableContextBinding,
  macros: MacroTable,
  layers: TavernWorldInfoLayers = {},
): Promise<TavernAuthoredContextCatalog> {
  return materializeTavernAuthoredContextCatalog(paths, store, thread, binding, macros, layers);
}

export async function materializeTavernAuthoredContextCatalog(
  paths: TavernPaths,
  store: TavernArtifactStore,
  thread: ChatThread,
  binding: TavernStableContextBinding,
  macros: MacroTable,
  layers: TavernWorldInfoLayers = {},
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
  assertWorldInfoLayer(thread.companionWorldBookBinding, layers.companionWorldBook);
  assertWorldInfoLayer(thread.managedWorldInfoBinding, layers.managedWorldInfo);
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
          ? renderMacros((artifact as Scenario).text, macros)
          : canonicalJson({ blocks: (artifact as DialogueExamples).blocks });
    // A scenario is one bound stable source, so unlike a world book entry it cannot
    // be dropped. An authored macro the run's table cannot resolve still must not be
    // published as the companion's context, exactly as the Game surface refuses one.
    if (selected.kind === "scenario" && hasUnrenderedMacro(content))
      throw new Error("tavern_stable_context_unrendered_scenario_macro");
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
  const companionConstant =
    layers.companionWorldBook === undefined
      ? undefined
      : stableWorldInfoSource(layers.companionWorldBook, String(sources.length + 1).padStart(4, "0"));
  if (companionConstant !== undefined) sources.push(companionConstant);
  const managedConstant =
    layers.managedWorldInfo === undefined
      ? undefined
      : stableWorldInfoSource(layers.managedWorldInfo, String(sources.length + 1).padStart(4, "0"));
  if (managedConstant !== undefined) sources.push(managedConstant);
  const budgetTokens = sources.reduce((total, item) => total + item.budgetTokens, 0);
  if (budgetTokens > TAVERN_STABLE_CONTEXT_MAX_TOKENS) throw new Error("tavern_stable_context_oversize");
  // Per-turn candidates of BOTH layers ride one selection list, so their total order
  // keys must stay one strictly increasing sequence: layer 1 is numbered first and
  // layer 2 continues after it. Each keeps its own trigger keys.
  const companionVolatile =
    layers.companionWorldBook === undefined
      ? []
      : deriveVolatileWorldInfoSources(layers.companionWorldBook, companionConstant!.sourceId, 0);
  const managedVolatile =
    layers.managedWorldInfo === undefined
      ? []
      : deriveVolatileWorldInfoSources(layers.managedWorldInfo, managedConstant!.sourceId, companionVolatile.length);
  const volatileSources = Object.freeze([...companionVolatile, ...managedVolatile]);
  const body = {
    version: "gamebuddy-authored-context-catalog/v2" as const,
    scope: binding,
    stableSources: sources,
    volatileSources,
  };
  return Object.freeze({
    ...body,
    canonicalHash: hash(canonicalJson(body)),
    stableSources: Object.freeze(sources),
    volatileSources: Object.freeze(volatileSources),
  });
}
/**
 * The content a layer will PUBLISH is `deriveStableWorldInfoContent`, not the raw
 * premise: a reviewed card import lands its backdrop as the book's constant entries
 * and writes an empty `alwaysOnPremise` (`new-companion-service.ts`), so gating on
 * the premise alone refused every turn of a card-provisioned companion - the book
 * was bound, the entries were on disk, and the materialization failed closed before
 * it ever reached them. A book with neither a premise nor any always-on entry still
 * has no publishable content and is still refused here. A thread binding and a layer
 * source are all-or-nothing together, per layer.
 */
function assertWorldInfoLayer(
  threadBinding: TavernStableWorldInfoBinding | undefined,
  layer: TavernWorldInfoSource | undefined,
): void {
  if ((threadBinding === undefined) !== (layer === undefined))
    throw new Error("tavern_stable_context_worldbook_binding_mismatch");
  if (layer === undefined) return;
  if (
    !sameWorldInfoBinding(threadBinding!, layer.binding) ||
    !validSourceContent(deriveStableWorldInfoContent(layer)) ||
    ("source" in layer.binding && hash(worldInfoContent(layer)) !== layer.binding.canonicalHash)
  )
    throw new Error("tavern_stable_context_worldbook_binding_mismatch");
}
/** One layer's always-on content as its own `lorebook_constant` stable source. */
function stableWorldInfoSource(
  layer: TavernWorldInfoSource,
  totalOrderKey: string,
): TavernAuthoredContextCatalog["stableSources"][number] {
  if ("content" in layer)
    return source(
      "lorebook_constant",
      managedWorldInfoSourceId(layer.binding),
      layer.binding.revision,
      layer.binding.canonicalHash,
      deriveStableWorldInfoContent(layer),
      totalOrderKey,
      `managed-world-info/${layer.binding.publicTitle}/revision/${layer.binding.revision}/canonical/${layer.binding.canonicalHash}`,
    );
  return source(
    "lorebook_constant",
    layer.binding.worldBookId,
    layer.binding.revision,
    layer.binding.canonicalHash,
    deriveStableWorldInfoContent(layer),
    totalOrderKey,
    `worldbook/${layer.binding.worldBookId}/revision/${layer.binding.revision}/canonical/${layer.binding.canonicalHash}/provenance/${layer.binding.provenance}`,
  );
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
    // Native WorldBook: a raw text premise, PLUS the reviewed constant entries
    // the import folded in. Both are Tier 2 always-on: stable across the whole
    // session, 100% prefix-cache eligible. Budget-bound so an extreme book
    // degrades to the premise overview instead of blowing the stable ceiling.
    if (
      "constantEntries" in sourceValue &&
      sourceValue.constantEntries !== undefined &&
      sourceValue.constantEntries.length > 0
    ) {
      const constants = canonicalJson({
        worldBookId: sourceValue.binding.worldBookId,
        alwaysOnPremise: sourceValue.alwaysOnPremise,
        entries: sourceValue.constantEntries.map((entry) => ({
          entryId: entry.entryId,
          title: entry.title,
          content: entry.content,
        })),
      });
      return Math.ceil(constants.length / 4) <= TAVERN_STABLE_CONTEXT_MAX_TOKENS
        ? constants
        : boundedWorldInfoOverview(sourceValue.alwaysOnPremise);
    }
    return boundedWorldInfoOverview(rawContent);
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
/**
 * One layer's keyword-gated entries as per-turn candidates. `ordinalOffset` is the
 * number of candidates the layers before this one already contributed, so the
 * combined list keeps ONE strictly increasing total order key sequence.
 */
function deriveVolatileWorldInfoSources(
  sourceValue: TavernWorldInfoSource,
  parentSourceId: string,
  ordinalOffset: number,
): TavernAuthoredContextCatalog["volatileSources"] {
  // NATIVE WorldBook first: a companion's own book IS parseable JSON, so a JSON-parse-first order would
  // send it down the managed-World-Info branch and never reach the keyword entries at all. That ordering
  // was the reason keyword-gated facts could not reach the context no matter how correct the rest of the
  // chain was (and why the historical note read "per-session catalog makes every turn refuse").
  if (
    "keywordEntries" in sourceValue &&
    sourceValue.keywordEntries !== undefined &&
    sourceValue.keywordEntries.length > 0
  ) {
    const revision = sourceValue.binding.revision;
    const canonical = sourceValue.binding.canonicalHash;
    return Object.freeze(
      sourceValue.keywordEntries.flatMap((entry, index) => {
        const content = entry.content;
        if (!validSourceContent(content)) throw new Error("tavern_volatile_context_invalid_source");
        const sourceId = `${parentSourceId}_entry_${index + 1}`;
        return [
          Object.freeze({
            sourceId,
            kind: "lorebook_entry" as const,
            revision: String(revision),
            canonicalHash: hash(content),
            content,
            budgetTokens: Math.ceil(content.length / 4),
            totalOrderKey: String(ordinalOffset + index + 1).padStart(4, "0"),
            provenance: `tavern-world-book-entry/${sourceId}/revision/${revision}/canonical/${canonical}`,
            // The card's own trigger words when it has them; the title is only a fallback.
            selectionKeys: Object.freeze(
              entry.keys !== undefined && entry.keys.length > 0 ? [...entry.keys] : [entry.title],
            ),
          }),
        ];
      }),
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(worldInfoContent(sourceValue));
  } catch {
    // A native WorldBook that could not be parsed as managed World Info carries no keyword entries here.
    return Object.freeze([]);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return Object.freeze([]);
  // A NATIVE book is JSON too (it has `entries`), but its entries are `{entryId,title,content,…}`, not
  // `{publicTitle,summary,…}`. Without this shape test the managed branch below would THROW on a native book
  // and the throw would be swallowed into "no volatile sources" — the silent half of this defect.
  if (
    parsed.entries.some(
      (entry: unknown) =>
        !isRecord(entry) || typeof entry.publicTitle !== "string" || typeof entry.summary !== "string",
    )
  )
    return Object.freeze([]);
  const revision = sourceValue.binding.revision;
  const canonical = sourceValue.binding.canonicalHash;
  return Object.freeze(
    parsed.entries.flatMap((entry, index) => {
      if (!isRecord(entry)) throw new Error("tavern_volatile_context_invalid_source");
      if (entry.constant === true) return [];
      if (typeof entry.publicTitle !== "string" || typeof entry.summary !== "string")
        throw new Error("tavern_volatile_context_invalid_source");
      const content = entry.summary;
      if (!validSourceContent(content)) throw new Error("tavern_volatile_context_invalid_source");
      const sourceId = `${parentSourceId}_entry_${index + 1}`;
      const provenance = `tavern-world-info-entry/${sourceId}/revision/${revision}/canonical/${canonical}`;
      const selectionKeys = Array.isArray(entry.keys) && entry.keys.length > 0 ? entry.keys : [entry.publicTitle];
      if (selectionKeys.some((key) => typeof key !== "string" || key.trim().length === 0))
        throw new Error("tavern_volatile_context_invalid_source");
      const secondaryKeys =
        Array.isArray(entry.secondaryKeys) && entry.secondaryKeys.length > 0 ? entry.secondaryKeys : undefined;
      if (secondaryKeys && secondaryKeys.some((key: unknown) => typeof key !== "string" || key.trim().length === 0)) {
        throw new Error("tavern_volatile_context_invalid_source");
      }
      if (
        entry.selectiveLogic !== undefined &&
        !(
          typeof entry.selectiveLogic === "number" && ([0, 1, 2, 3] as readonly number[]).includes(entry.selectiveLogic)
        )
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
          totalOrderKey: String(ordinalOffset + index + 1).padStart(4, "0"),
          provenance,
          selectionKeys: Object.freeze([...selectionKeys]),
          ...(secondaryKeys !== undefined ? { secondaryKeys: Object.freeze([...secondaryKeys]) } : {}),
          ...(selectiveLogic !== undefined ? { selectiveLogic } : {}),
        }),
      ];
    }),
  );
}
function validSourceContent(value: string): boolean {
  return typeof value === "string" && value.length > 0 && !/[\u0000\u007f]/u.test(value);
}
function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Game-surface authored context.
 *
 * The reviewed always-on WorldBook is the companion's world backdrop: it
 * belongs in the Tier 2 m[0] baseline as the existing typed
 * `lorebook_constant` stable source — not in the Tier 1 system prompt, and not
 * behind a lookup tool the model has to remember to call. Only reviewed
 * always-on background (the card's `constant` entries plus the WorldBook's own
 * always-on premise) earns a permanent seat; the card's keyword-gated entries
 * become per-turn volatile candidates, exactly as they do on the Chat surface,
 * so the companion sharing the farm is told what her own card says about the
 * rain, the stamina, the season and the town when those are what is happening
 * now instead of waiting for the model to choose a lookup tool.
 *
 * The catalog reuses the tavern hashing and budget rules so the vendor
 * `gamebuddy-authored-context-catalog/v2` validator accepts it unchanged, and
 * the volatile half is built by the SAME `deriveVolatileWorldInfoSources` the
 * Chat surface uses: the Game scope invents no second selection rule. The
 * volatile total order keys continue AFTER the stable source so the catalog
 * keeps one strictly increasing sequence.
 */
export function buildGameSurfaceAuthoredCatalog(
  binding: TavernStableContextBinding,
  worldBook: WorldBookBinding,
  macros: Readonly<{ char: string | null }> = { char: null },
): TavernAuthoredContextCatalog {
  if (binding.surface !== "game") throw new Error("game_authored_context_surface_mismatch");
  // An entry the macro set cannot fully render is dropped instead of shipped
  // with a raw `{{...}}` placeholder as the companion's authored context. The
  // rule covers both halves: the always-on entries and the keyword-gated ones.
  const renderedEntries = worldBook.book.entries.flatMap((entry) => {
    const title = renderWorldBookText(entry.title, macros);
    const content = renderWorldBookText(entry.content, macros);
    return hasUnrenderedMacro(title) || hasUnrenderedMacro(content) ? [] : [Object.freeze({ entry, title, content })];
  });
  const constantEntries = renderedEntries
    .filter(({ entry }) => entry.constant === true)
    .map(({ entry, title, content }) => ({ entryId: entry.entryId, title, content }));
  const keywordEntries = renderedEntries
    .filter(({ entry }) => entry.constant !== true)
    .map(({ entry, title, content }) => ({
      entryId: entry.entryId,
      title,
      content,
      // The card's own trigger words ride along; the title is only a fallback.
      ...(entry.keys === undefined || entry.keys.length === 0 ? {} : { keys: entry.keys }),
    }));
  const alwaysOnPremise = renderWorldBookText(worldBook.book.alwaysOnPremise, macros);
  const content = canonicalJson({
    worldBookId: worldBook.book.worldBookId,
    alwaysOnPremise,
    entries: constantEntries,
  });
  const sources: Array<TavernAuthoredContextCatalog["stableSources"][number]> = [
    source(
      "lorebook_constant",
      worldBook.book.worldBookId,
      worldBook.metadata.revision,
      worldBook.metadata.canonicalHash,
      content,
      "0001",
      `game-worldbook/${worldBook.book.worldBookId}/revision/${worldBook.metadata.revision}/canonical/${worldBook.metadata.canonicalHash}`,
    ),
  ];
  const budgetTokens = sources.reduce((total, item) => total + item.budgetTokens, 0);
  if (budgetTokens > TAVERN_STABLE_CONTEXT_MAX_TOKENS) throw new Error("game_stable_context_oversize");
  // Rendering upstream is not enough discipline for this invariant: a hand-placed
  // or hand-edited worldbook reaches this function unchanged, and an unresolved
  // macro must never be published as the companion's authored context.
  for (const item of sources) {
    if (hasUnrenderedMacro(item.content)) throw new Error("game_authored_context_unrendered_macro");
  }
  const volatileSources =
    keywordEntries.length === 0
      ? Object.freeze([] as TavernAuthoredContextCatalog["volatileSources"])
      : deriveVolatileWorldInfoSources(
          Object.freeze({
            binding: Object.freeze({
              worldBookId: worldBook.metadata.worldBookId,
              revision: worldBook.metadata.revision,
              canonicalHash: worldBook.metadata.canonicalHash,
              // The companion's own book reaches the Game the same way it reaches a Chat - as
              // the reviewed import's durable artifact - so it carries the same provenance.
              provenance: "reviewed-import" as const,
            }),
            alwaysOnPremise,
            keywordEntries: Object.freeze(keywordEntries),
          }),
          worldBook.book.worldBookId,
          sources.length,
        );
  const body = {
    version: "gamebuddy-authored-context-catalog/v2" as const,
    scope: binding,
    stableSources: sources,
    volatileSources,
  };
  return Object.freeze({
    ...body,
    canonicalHash: hash(canonicalJson(body)),
    stableSources: Object.freeze(sources),
    volatileSources: Object.freeze(volatileSources),
  });
}
