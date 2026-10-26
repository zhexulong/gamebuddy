/** Pure Tavern artifact schemas. These values are inert product data, never prompts or executable imports. */
const TAVERN_SCHEMA_VERSION = 1 as const;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const TEXT = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u;
const SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F]/u;
/** The same recent-message window bound the persisted `WorldBook` enforces. */
const MAX_CANDIDATE_WORLDBOOK_SCAN_DEPTH = 64;
type RuntimeEligibility = "candidate_only" | "profile_eligible_after_explicit_review" | "never_runtime";
type ArtifactRevision = Readonly<{ schemaVersion: typeof TAVERN_SCHEMA_VERSION; revision: number }>;
export type CharacterCandidate = ArtifactRevision &
  Readonly<{
    candidateId: string;
    sourceFormat: "st-v2" | "st-v3";
    sourceVersion: string;
    sourceHash: string;
    name: string;
    reviewState: "pending" | "reviewed";
    fields: readonly Readonly<{ field: string; text: string; eligibility: RuntimeEligibility }>[];
    /** Reviewed-card world book candidates (S3): the reviewed import folds the
     *  card's book into the companion's worldbook.json at provision time. */
    worldBookCandidates?: readonly Readonly<{
      entryId: string;
      title: string;
      content: string;
      scope: "companion" | "setting" | "integration" | "world";
      provenance: "authored" | "st-card-import" | "reviewed-import";
      tokenBudget: "small" | "medium";
      constant?: boolean;
      /**
       * The card's own trigger words, carried through review like the worldbook's
       * own `keys`: volatile selection matches them against what the player said,
       * so a keyword-gated entry is unreachable without them.
       */
      keys?: readonly string[];
      /**
       * The card's own secondary trigger words (`secondary_keys`), applied through
       * `selectiveLogic` once `keys` matched. They ride the reviewed candidate into
       * `worldbook.json` for the same reason `keys` do: the selector's four modes
       * need them, and an entry that lost them selects where its author excluded it.
       */
      secondaryKeys?: readonly string[];
      /** The card's `selectiveLogic`: 0 AND ANY, 1 NOT ALL, 2 NOT ANY, 3 AND ALL. */
      selectiveLogic?: 0 | 1 | 2 | 3;
    }>[];
    /**
     * The card's own `character_book.scan_depth`, when it declared one. It rides
     * the book into `worldbook.json` and bounds per-turn World Info selection;
     * absent means the Host applies its documented default depth.
     */
    worldBookScanDepth?: number;
    /**
     * The card's open-by-design `extensions` object, carried verbatim from the
     * staged decode so the provisioned companion owns it as her own record
     * (`card-extensions.json`) and the card export can write it back. Inert card
     * data: never a profile field, never prompt input, never executed.
     */
    extensions?: Readonly<Record<string, unknown>>;
    /**
     * The card's standard `post_history_instructions`, carried verbatim from the
     * staged decode so the provisioned companion owns it as her own record
     * (`post-history-instructions.json`) beside her scenario and her openings. The
     * Chat materialization publishes it as the catalogue's `postHistoryInstructions`,
     * rendered after the transcript rather than into the cached prefix. Never a
     * profile field.
     */
    postHistoryInstructions?: string;
    /**
     * The card's fields this product does not interpret - `creator_notes`, `tags`, `creator`,
     * `character_version` and anything else the format allows - carried verbatim from the staged decode
     * so the provisioned companion owns them as her own record (`card-metadata.json`) and the card export
     * writes them back. The compatibility manifest calls these `preserved_opaque`, and this is where that
     * classification is performed rather than merely reported. Never a profile field, never prompt input.
     */
    preservedFields?: Readonly<Record<string, unknown>>;
  }>;
/**
 * Player-scoped library metadata. This is deliberately not an IdentityProfile
 * and never provisions or changes a runtime session.
 */
export type TavernCompanion = ArtifactRevision &
  Readonly<{
    companionId: string;
    continuityId: string;
    name: string;
    profileId: string;
    profileRevision: number;
    profileHash: string;
  }>;
/** Immutable audit record for a decoded ST card. It contains no raw source payload. */
export type StCardImportRecord = ArtifactRevision &
  Readonly<{
    importId: string;
    source: "json" | "png";
    sourceFormat?: "st-v2" | "st-v3";
    sourceHash: string;
    dispositions: readonly Readonly<{
      field: string;
      classification: "accepted_typed" | "preserved_opaque" | "dropped_unsupported" | "rejected_invalid";
      reason: string;
    }>[];
    /**
     * The bounded, counted losses the decode took inside accepted fields (a
     * card's own `system_prompt` beyond the voice bound is the common one). The
     * audit record carries the ledger so a review surface reports a loss through
     * the decoder's own vocabulary instead of a second mechanism. Optional: an
     * artifact written before the ledger was persisted reads as no losses.
     */
    losses?: readonly Readonly<{ field: string; reason: string; count: number }>[];
  }>;
/** Durable, field-level confirmation for an inert import candidate. */
export type CandidateReviewRecord = ArtifactRevision &
  Readonly<{
    importId: string;
    candidateId: string;
    candidateRevision: number;
    sourceHash: string;
    reviewedFields: readonly string[];
    approvedAtMs: number;
  }>;
/**
 * Immutable evidence for one confirmed reviewed-card import: when it happened,
 * which card it came from, which companion it provisioned, and how many fields
 * the decoder kept or dropped per disposition class. It carries no card body
 * text, and no reader consults it to decide what an import keeps or drops.
 */
export type StCardImportHistoryDispositionCounts = Readonly<{
  accepted_typed: number;
  preserved_opaque: number;
  dropped_unsupported: number;
  rejected_invalid: number;
}>;
export type StCardImportHistoryRecord = ArtifactRevision &
  Readonly<{
    importId: string;
    occurredAtMs: number;
    cardName: string;
    companionId: string;
    counts: StCardImportHistoryDispositionCounts;
  }>;
export type UserPersona = ArtifactRevision & Readonly<{ personaId: string; name: string; description?: string }>;
export type Scenario = ArtifactRevision &
  Readonly<{
    scenarioId: string;
    name?: string;
    description?: string;
    text: string;
    provenance: "authored" | "imported";
    owner: "companion_default" | "chat_override" | "imported_candidate";
  }>;
export type DialogueExamples = ArtifactRevision & Readonly<{ examplesId: string; blocks: readonly string[] }>;
type GreetingVariant = Readonly<{ variantId: string; label?: string; text: string }>;
export type GreetingSet = ArtifactRevision &
  Readonly<{ greetingSetId: string; label?: string; variants: readonly GreetingVariant[] }>;
/**
 * The imported card's own open-by-design `extensions` object, kept as the
 * companion's own record.
 *
 * It is card data, not prompt data: nothing renders it into a prompt, nothing
 * executes it, and no profile field is derived from it. It exists so the facts a
 * card author wrote for a game integration (the shipped default card's
 * `extensions.gamebuddy.stardew`) survive both halves of the round trip - the
 * import that keeps them and the export that writes them back.
 */
export type CardExtensions = ArtifactRevision &
  Readonly<{ cardExtensionsId: string; extensions: Readonly<Record<string, unknown>> }>;
/**
 * Every field the card author wrote that this product does not interpret, kept verbatim.
 *
 * The compatibility manifest classifies such a field `preserved_opaque`, and the import reported that
 * classification while keeping none of the text - so an author's `creator_notes`, their `tags`, their
 * `creator` and their `character_version` survived neither half of the round trip. The manifest promised a
 * disposition the code did not perform.
 *
 * This record is where that promise is kept: one bounded, deep-frozen copy of those fields, never a profile
 * field, never rendered into a prompt, never executed. It is deliberately open rather than a fixed list of
 * four names, because the set of fields a card may carry is the format's, not ours - a field this product does
 * not know is exactly the kind of value that must come back out unchanged. Fields the import refuses as
 * executable controls are not here: those were never preserved, and saying so is what their disposition means.
 */
export type CardMetadata = ArtifactRevision &
  Readonly<{ cardMetadataId: string; fields: Readonly<Record<string, unknown>> }>;
/**
 * The imported card's own closing direction (`post_history_instructions`), kept as
 * the companion's own record.
 *
 * It is card data, not identity data: nothing derives a profile field from it and
 * no reader renders it yet. It exists beside her scenario and her openings so the
 * one instruction a card author wrote to be read LAST survives the import, bounded
 * by the same constant the compatibility manifest publishes.
 */
export type PostHistoryInstructions = ArtifactRevision & Readonly<{ postHistoryInstructionsId: string; text: string }>;
export type WorldBookBinding = Readonly<{
  bindingId: string;
  worldBookId: string;
  revision: number;
  canonicalHash: string;
  scope: "companion" | "chat";
}>;
type OpeningSelection =
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "greeting"; sourceRevision: number; variantId: string; messageId: string }>;
type ChatThread = ArtifactRevision &
  Readonly<{
    chatThreadId: string;
    companionId: string;
    continuityId: string;
    personaId?: string;
    scenarioId?: string;
    openingSelection: OpeningSelection;
    openingLockedAtEventId?: string;
  }>;
export type TavernArtifact =
  | CharacterCandidate
  | StCardImportRecord
  | CandidateReviewRecord
  | StCardImportHistoryRecord
  | TavernCompanion
  | UserPersona
  | Scenario
  | DialogueExamples
  | GreetingSet
  | CardExtensions
  | CardMetadata
  | PostHistoryInstructions
  | ChatThread;

export function validateTavernArtifact(value: unknown): TavernArtifact {
  if (!record(value) || value.schemaVersion !== TAVERN_SCHEMA_VERSION || !revision(value.revision)) fail();
  if (typeof value.importId === "string" && typeof value.candidateId === "string") return candidateReview(value);
  if (typeof value.candidateId === "string") return candidate(value);
  // A history record carries `importId` too, so it is discriminated by its own
  // immutable `occurredAtMs` fact before the generic import record below.
  if (typeof value.importId === "string" && typeof value.occurredAtMs === "number") return importHistory(value);
  if (typeof value.importId === "string") return importRecord(value);
  if (typeof value.companionId === "string" && typeof value.profileId === "string") return companion(value);
  if (typeof value.chatThreadId === "string") return thread(value);
  if (typeof value.personaId === "string") return persona(value);
  if (typeof value.scenarioId === "string") return scenario(value);
  if (typeof value.examplesId === "string") return examples(value);
  if (typeof value.greetingSetId === "string") return greetings(value);
  if (typeof value.cardExtensionsId === "string") return cardExtensions(value);
  if (typeof value.cardMetadataId === "string") return cardMetadata(value);
  if (typeof value.postHistoryInstructionsId === "string") return postHistoryInstructions(value);
  return fail();
}
function candidate(v: Record<string, unknown>): CharacterCandidate {
  if (
    !only(v, [
      "schemaVersion",
      "revision",
      "candidateId",
      "sourceFormat",
      "sourceVersion",
      "sourceHash",
      "name",
      "reviewState",
      "fields",
      "worldBookCandidates",
      "worldBookScanDepth",
      "extensions",
      "postHistoryInstructions",
      "preservedFields",
    ])
  )
    fail();
  const fields = array(v.fields, 32).map((x) => {
    if (!record(x) || !only(x, ["field", "text", "eligibility"])) fail();
    return freeze({
      field: requiredId(x.field),
      text: requiredText(x.text, 8_192),
      eligibility: requiredEligibility(x.eligibility),
    });
  });
  const worldBookCandidates =
    v.worldBookCandidates === undefined
      ? undefined
      : array(v.worldBookCandidates, 128).map((x) => {
          if (
            !record(x) ||
            !only(x, [
              "entryId",
              "title",
              "content",
              "scope",
              "provenance",
              "tokenBudget",
              "constant",
              "keys",
              "secondaryKeys",
              "selectiveLogic",
            ])
          )
            fail();
          const scope = x.scope;
          const provenance = x.provenance;
          const tokenBudget = x.tokenBudget;
          if (
            typeof scope !== "string" ||
            !["companion", "setting", "integration", "world"].includes(scope) ||
            typeof provenance !== "string" ||
            !["authored", "st-card-import", "reviewed-import"].includes(provenance) ||
            (tokenBudget !== "small" && tokenBudget !== "medium")
          )
            fail();
          return freeze({
            entryId: requiredId(x.entryId),
            title: requiredText(x.title, 256),
            content: requiredText(x.content, 65_536),
            scope: scope as "companion" | "setting" | "integration" | "world",
            provenance: provenance as "authored" | "st-card-import" | "reviewed-import",
            tokenBudget: tokenBudget as "small" | "medium",
            ...(x.constant === undefined ? {} : { constant: requiredConstant(x.constant) }),
            ...(x.keys === undefined ? {} : { keys: requiredWorldBookKeys(x.keys) }),
            ...(x.secondaryKeys === undefined ? {} : { secondaryKeys: requiredWorldBookKeys(x.secondaryKeys) }),
            ...(x.selectiveLogic === undefined ? {} : { selectiveLogic: requiredSelectiveLogic(x.selectiveLogic) }),
          });
        });
  const extensions = v.extensions === undefined ? undefined : requiredInertExtensions(v.extensions);
  // The card's own closing direction. Its 4 KB bound (one constant, published by
  // the compatibility manifest and enforced by the decoder) is the import's; this
  // schema applies the same general tavern-text ceiling every authored record uses.
  const postHistoryInstructions =
    v.postHistoryInstructions === undefined ? undefined : requiredText(v.postHistoryInstructions, 8_192);
  // The fields this product does not interpret. Same inert-data treatment as `extensions`: a private, deep-frozen
  // JSON copy, bounded by one constant, so nothing here can be mutated back into the import or read as prompt text.
  const preservedFields = v.preservedFields === undefined ? undefined : requiredInertExtensions(v.preservedFields);
  const candidateId = requiredId(v.candidateId);
  const sourceFormat = requiredSourceFormat(v.sourceFormat);
  const sourceVersion = requiredText(v.sourceVersion, 64);
  const sourceHash = requiredHash(v.sourceHash);
  const name = requiredSingleLine(v.name, 128);
  const reviewState = requiredReviewState(v.reviewState);
  const worldBookScanDepth = v.worldBookScanDepth;
  if (
    worldBookScanDepth !== undefined &&
    (!Number.isSafeInteger(worldBookScanDepth) ||
      (worldBookScanDepth as number) < 1 ||
      (worldBookScanDepth as number) > MAX_CANDIDATE_WORLDBOOK_SCAN_DEPTH)
  )
    fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    candidateId,
    sourceFormat,
    sourceVersion,
    sourceHash,
    name,
    reviewState,
    fields: freeze(fields),
    ...(worldBookCandidates === undefined ? {} : { worldBookCandidates: freeze(worldBookCandidates) }),
    ...(worldBookScanDepth === undefined ? {} : { worldBookScanDepth: worldBookScanDepth as number }),
    ...(extensions === undefined ? {} : { extensions }),
    ...(postHistoryInstructions === undefined ? {} : { postHistoryInstructions }),
    ...(preservedFields === undefined ? {} : { preservedFields }),
  });
}
function cardExtensions(v: Record<string, unknown>): CardExtensions {
  if (!only(v, ["schemaVersion", "revision", "cardExtensionsId", "extensions"])) fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    cardExtensionsId: requiredId(v.cardExtensionsId),
    extensions: requiredInertExtensions(v.extensions),
  });
}
function cardMetadata(v: Record<string, unknown>): CardMetadata {
  if (!only(v, ["schemaVersion", "revision", "cardMetadataId", "fields"])) fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    cardMetadataId: requiredId(v.cardMetadataId),
    fields: requiredInertExtensions(v.fields),
  });
}
function postHistoryInstructions(v: Record<string, unknown>): PostHistoryInstructions {
  if (!only(v, ["schemaVersion", "revision", "postHistoryInstructionsId", "text"])) fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    postHistoryInstructionsId: requiredId(v.postHistoryInstructionsId),
    text: requiredText(v.text, 8_192),
  });
}
function candidateReview(v: Record<string, unknown>): CandidateReviewRecord {
  if (
    !only(v, [
      "schemaVersion",
      "revision",
      "importId",
      "candidateId",
      "candidateRevision",
      "sourceHash",
      "reviewedFields",
      "approvedAtMs",
    ])
  )
    fail();
  const fields = array(v.reviewedFields, 32).map(requiredId);
  if (fields.length === 0 || new Set(fields).size !== fields.length) fail();
  const importId = requiredId(v.importId);
  const candidateId = requiredId(v.candidateId);
  const candidateRevision = requiredRevision(v.candidateRevision);
  const sourceHash = requiredHash(v.sourceHash);
  const approvedAtMs = requiredTimestamp(v.approvedAtMs);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    importId,
    candidateId,
    candidateRevision,
    sourceHash,
    reviewedFields: freeze(fields),
    approvedAtMs,
  });
}
function importRecord(v: Record<string, unknown>): StCardImportRecord {
  if (
    !only(v, [
      "schemaVersion",
      "revision",
      "importId",
      "source",
      "sourceFormat",
      "sourceHash",
      "dispositions",
      "losses",
    ])
  )
    fail();
  const dispositions = array(v.dispositions, 256).map((x) => {
    if (!record(x) || !only(x, ["field", "classification", "reason"])) fail();
    return freeze({
      field: requiredId(x.field),
      classification: requiredClassification(x.classification),
      reason: requiredText(x.reason, 128),
    });
  });
  const losses =
    v.losses === undefined
      ? undefined
      : array(v.losses, 64).map((x) => {
          if (!record(x) || !only(x, ["field", "reason", "count"])) fail();
          return freeze({
            field: requiredId(x.field),
            reason: requiredText(x.reason, 128),
            count: requiredRevision(x.count),
          });
        });
  const importId = requiredId(v.importId);
  const source = requiredSource(v.source);
  const sourceFormat = optionalSourceFormat(v.sourceFormat);
  const sourceHash = requiredHash(v.sourceHash);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    importId,
    source,
    ...(sourceFormat === undefined ? {} : { sourceFormat }),
    sourceHash,
    dispositions: freeze(dispositions),
    ...(losses === undefined ? {} : { losses: freeze(losses) }),
  });
}
function importHistory(v: Record<string, unknown>): StCardImportHistoryRecord {
  if (!only(v, ["schemaVersion", "revision", "importId", "occurredAtMs", "cardName", "companionId", "counts"])) fail();
  const counts = v.counts;
  if (
    !record(counts) ||
    !only(counts, ["accepted_typed", "preserved_opaque", "dropped_unsupported", "rejected_invalid"])
  )
    fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    importId: requiredId(v.importId),
    occurredAtMs: requiredTimestamp(v.occurredAtMs),
    cardName: requiredSingleLine(v.cardName, 128),
    companionId: requiredId(v.companionId),
    counts: freeze({
      accepted_typed: requiredCount(counts.accepted_typed),
      preserved_opaque: requiredCount(counts.preserved_opaque),
      dropped_unsupported: requiredCount(counts.dropped_unsupported),
      rejected_invalid: requiredCount(counts.rejected_invalid),
    }),
  });
}
function companion(v: Record<string, unknown>): TavernCompanion {
  if (
    !only(v, [
      "schemaVersion",
      "revision",
      "companionId",
      "continuityId",
      "name",
      "profileId",
      "profileRevision",
      "profileHash",
    ])
  )
    fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    companionId: requiredId(v.companionId),
    continuityId: requiredId(v.continuityId),
    name: requiredSingleLine(v.name, 128),
    profileId: requiredId(v.profileId),
    profileRevision: requiredRevision(v.profileRevision),
    profileHash: requiredHash(v.profileHash),
  });
}
function persona(v: Record<string, unknown>): UserPersona {
  if (!only(v, ["schemaVersion", "revision", "personaId", "name", "description"])) fail();
  const description = optionalText(v.description, 4_096);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    personaId: requiredId(v.personaId),
    name: requiredSingleLine(v.name, 128),
    ...(description === undefined ? {} : { description }),
  });
}
function scenario(v: Record<string, unknown>): Scenario {
  if (!only(v, ["schemaVersion", "revision", "scenarioId", "name", "description", "text", "provenance", "owner"]))
    fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    scenarioId: requiredId(v.scenarioId),
    name: requiredSingleLine(v.name, 128),
    description: requiredText(v.description, 8_192),
    text: requiredText(v.text, 8_192),
    provenance: requiredProvenance(v.provenance),
    owner: requiredOwner(v.owner),
  });
}
function examples(v: Record<string, unknown>): DialogueExamples {
  if (!only(v, ["schemaVersion", "revision", "examplesId", "blocks"])) fail();
  const blocks = array(v.blocks, 32).map((x) => requiredText(x, 8_192));
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    examplesId: requiredId(v.examplesId),
    blocks: freeze(blocks),
  });
}
function greetings(v: Record<string, unknown>): GreetingSet {
  if (!only(v, ["schemaVersion", "revision", "greetingSetId", "label", "variants"])) fail();
  const variants = array(v.variants, 16).map((x) => {
    if (!record(x) || !only(x, ["variantId", "label", "text"])) fail();
    const label = optionalSingleLine(x.label, 128);
    return freeze({
      variantId: requiredId(x.variantId),
      ...(label === undefined ? {} : { label }),
      text: requiredText(x.text, 8_192),
    });
  });
  if (new Set(variants.map((x) => x.variantId)).size !== variants.length) fail();
  const label = optionalSingleLine(v.label, 128);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    greetingSetId: requiredId(v.greetingSetId),
    ...(label === undefined ? {} : { label }),
    variants: freeze(variants),
  });
}
function thread(v: Record<string, unknown>): ChatThread {
  if (
    !only(v, [
      "schemaVersion",
      "revision",
      "chatThreadId",
      "companionId",
      "continuityId",
      "personaId",
      "scenarioId",
      "openingSelection",
      "openingLockedAtEventId",
    ]) ||
    !record(v.openingSelection)
  )
    fail();
  const personaId = optionalId(v.personaId);
  const scenarioId = optionalId(v.scenarioId);
  const openingLockedAtEventId = optionalId(v.openingLockedAtEventId);
  const selection = v.openingSelection;
  const opening =
    selection.kind === "blank" && only(selection, ["kind"])
      ? freeze({ kind: "blank" as const })
      : selection.kind === "greeting" && only(selection, ["kind", "sourceRevision", "variantId", "messageId"])
        ? freeze({
            kind: "greeting" as const,
            sourceRevision: requiredRevision(selection.sourceRevision),
            variantId: requiredId(selection.variantId),
            messageId: requiredId(selection.messageId),
          })
        : fail();
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    chatThreadId: requiredId(v.chatThreadId),
    companionId: requiredId(v.companionId),
    continuityId: requiredId(v.continuityId),
    ...(personaId === undefined ? {} : { personaId }),
    ...(scenarioId === undefined ? {} : { scenarioId }),
    openingSelection: opening,
    ...(openingLockedAtEventId === undefined ? {} : { openingLockedAtEventId }),
  });
}
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function only(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((key) => keys.includes(key));
}
function array(v: unknown, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) fail();
  return v;
}
function id(v: unknown): v is string {
  return typeof v === "string" && ID.test(v);
}
function text(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !TEXT.test(v);
}
function hash(v: unknown): v is string {
  return typeof v === "string" && /^[a-f0-9]{64}$/u.test(v);
}
function revision(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v > 0;
}
function eligibility(v: unknown): v is RuntimeEligibility {
  return v === "candidate_only" || v === "profile_eligible_after_explicit_review" || v === "never_runtime";
}
function classification(v: unknown): v is StCardImportRecord["dispositions"][number]["classification"] {
  return v === "accepted_typed" || v === "preserved_opaque" || v === "dropped_unsupported" || v === "rejected_invalid";
}
function requiredId(v: unknown): string {
  if (!id(v)) fail();
  return v;
}
function optionalId(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  return requiredId(v);
}
function requiredText(v: unknown, max: number): string {
  if (!text(v, max)) fail();
  return v;
}
function optionalText(v: unknown, max: number): string | undefined {
  if (v === undefined) return undefined;
  return requiredText(v, max);
}
function singleLine(v: unknown, max: number): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= max && !SINGLE_LINE.test(v);
}
function requiredSingleLine(v: unknown, max: number): string {
  if (!singleLine(v, max)) fail();
  return v;
}
function optionalSingleLine(v: unknown, max: number): string | undefined {
  if (v === undefined) return undefined;
  return requiredSingleLine(v, max);
}
function requiredHash(v: unknown): string {
  if (!hash(v)) fail();
  return v;
}
function requiredRevision(v: unknown): number {
  if (!revision(v)) fail();
  return v;
}
function requiredTimestamp(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail();
  return v;
}
function requiredCount(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) fail();
  return v;
}
function requiredEligibility(v: unknown): RuntimeEligibility {
  if (!eligibility(v)) fail();
  return v;
}
function requiredClassification(v: unknown): StCardImportRecord["dispositions"][number]["classification"] {
  if (!classification(v)) fail();
  return v;
}
function requiredSource(v: unknown): StCardImportRecord["source"] {
  if (v !== "json" && v !== "png") fail();
  return v;
}
function optionalSourceFormat(v: unknown): StCardImportRecord["sourceFormat"] {
  if (v === undefined) return undefined;
  return requiredSourceFormat(v);
}
function requiredSourceFormat(v: unknown): NonNullable<StCardImportRecord["sourceFormat"]> {
  if (v !== "st-v2" && v !== "st-v3") fail();
  return v;
}
function requiredReviewState(v: unknown): CharacterCandidate["reviewState"] {
  if (v !== "pending" && v !== "reviewed") fail();
  return v;
}
function requiredProvenance(v: unknown): Scenario["provenance"] {
  if (v !== "authored" && v !== "imported") fail();
  return v;
}
function requiredOwner(v: unknown): Scenario["owner"] {
  if (v !== "companion_default" && v !== "chat_override" && v !== "imported_candidate") fail();
  return v;
}
function freeze<T>(v: T): T {
  return Object.freeze(v);
}
/**
 * A card's open-by-design `extensions` object as inert JSON data.
 *
 * The value is JSON round-tripped and deep-frozen, so what the artifact holds is
 * a private copy of plain JSON - no member can be a function, a class instance or
 * a live reference back into the import. The bound here is a durability guard
 * against blowup; the card format's own ceiling for this field belongs to the
 * decoder (`ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars`) and is re-applied
 * by the export, not restated here.
 */
const MAX_INERT_EXTENSIONS_CHARS = 65_536;
function requiredInertExtensions(value: unknown): Readonly<Record<string, unknown>> {
  if (!record(value) || Object.keys(value).length === 0) fail();
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    fail();
  }
  if (json.length === 0 || json.length > MAX_INERT_EXTENSIONS_CHARS) fail();
  return deepFreeze(JSON.parse(json) as Record<string, unknown>);
}
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return Object.freeze(value);
}
function fail(): never {
  throw new Error("invalid_tavern_artifact");
}
function requiredConstant(v: unknown): boolean {
  if (typeof v !== "boolean") fail();
  return v;
}
/**
 * A candidate's world-book trigger words. Bounded exactly as the persisted
 * worldbook bounds them (`worldbook.ts` `validateEntry`): the decoder trims and
 * caps a card's `keys` to 16 words of 64 chars, and an empty list must read as
 * "no trigger words" (absent) rather than a malformed entry.
 */
function requiredWorldBookKeys(v: unknown): readonly string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 16) fail();
  if (!v.every((key) => typeof key === "string" && key.trim().length > 0 && key.length <= 64)) fail();
  return freeze([...v] as string[]);
}
/** SillyTavern's four selection modes, the only values the selector applies. */
function requiredSelectiveLogic(v: unknown): 0 | 1 | 2 | 3 {
  if (v !== 0 && v !== 1 && v !== 2 && v !== 3) fail();
  return v;
}
