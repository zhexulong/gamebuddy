/** Pure Tavern artifact schemas. These values are inert product data, never prompts or executable imports. */
export const TAVERN_SCHEMA_VERSION = 1 as const;
const ID = /^[A-Za-z0-9._-]{1,128}$/u;
const TEXT = /[\u0000-\u001f\u007f]/u;
export type RuntimeEligibility = "candidate_only" | "profile_eligible_after_explicit_review" | "never_runtime";
export type ArtifactRevision = Readonly<{ schemaVersion: typeof TAVERN_SCHEMA_VERSION; revision: number }>;
export type CharacterCandidate = ArtifactRevision &
  Readonly<{
    candidateId: string;
    sourceFormat: "st-v2" | "st-v3";
    sourceVersion: string;
    sourceHash: string;
    name: string;
    reviewState: "pending" | "reviewed";
    fields: readonly Readonly<{ field: string; text: string; eligibility: RuntimeEligibility }>[];
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
export type GreetingVariant = Readonly<{ variantId: string; label?: string; text: string }>;
export type GreetingSet = ArtifactRevision &
  Readonly<{ greetingSetId: string; label?: string; variants: readonly GreetingVariant[] }>;
export type WorldBookBinding = Readonly<{
  bindingId: string;
  worldBookId: string;
  revision: number;
  canonicalHash: string;
  scope: "companion" | "chat";
}>;
export type OpeningSelection =
  | Readonly<{ kind: "blank" }>
  | Readonly<{ kind: "greeting"; sourceRevision: number; variantId: string; messageId: string }>;
export type ChatThread = ArtifactRevision &
  Readonly<{
    chatThreadId: string;
    companionId: string;
    continuityId: string;
    personaId?: string;
    scenarioId?: string;
    openingSelection: OpeningSelection;
    openingLockedAtEventId?: string;
  }>;
export type TavernMessageVariant = Readonly<{ variantId: string; text: string }>;
export type TavernMessage = Readonly<{
  messageId: string;
  role: "player" | "companion";
  text: string;
  variants?: readonly TavernMessageVariant[];
}>;
export type TavernArtifact =
  | CharacterCandidate
  | StCardImportRecord
  | CandidateReviewRecord
  | TavernCompanion
  | UserPersona
  | Scenario
  | DialogueExamples
  | GreetingSet
  | ChatThread;

export function validateTavernArtifact(value: unknown): TavernArtifact {
  if (!record(value) || value.schemaVersion !== TAVERN_SCHEMA_VERSION || !revision(value.revision)) fail();
  if (typeof value.importId === "string" && typeof value.candidateId === "string") return candidateReview(value);
  if (typeof value.candidateId === "string") return candidate(value);
  if (typeof value.importId === "string") return importRecord(value);
  if (typeof value.companionId === "string" && typeof value.profileId === "string") return companion(value);
  if (typeof value.chatThreadId === "string") return thread(value);
  if (typeof value.personaId === "string") return persona(value);
  if (typeof value.scenarioId === "string") return scenario(value);
  if (typeof value.examplesId === "string") return examples(value);
  if (typeof value.greetingSetId === "string") return greetings(value);
  return fail();
}
function candidate(v: Record<string, unknown>): CharacterCandidate {
  const fields = array(v.fields, 32).map((x) => {
    if (!record(x)) fail();
    return freeze({
      field: requiredId(x.field),
      text: requiredText(x.text, 8_192),
      eligibility: requiredEligibility(x.eligibility),
    });
  });
  const candidateId = requiredId(v.candidateId);
  const sourceFormat = requiredSourceFormat(v.sourceFormat);
  const sourceVersion = requiredText(v.sourceVersion, 64);
  const sourceHash = requiredHash(v.sourceHash);
  const name = requiredText(v.name, 128);
  const reviewState = requiredReviewState(v.reviewState);
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
  });
}
function candidateReview(v: Record<string, unknown>): CandidateReviewRecord {
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
  const dispositions = array(v.dispositions, 256).map((x) => {
    if (!record(x)) fail();
    return freeze({
      field: requiredId(x.field),
      classification: requiredClassification(x.classification),
      reason: requiredText(x.reason, 128),
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
  });
}
function companion(v: Record<string, unknown>): TavernCompanion {
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    companionId: requiredId(v.companionId),
    continuityId: requiredId(v.continuityId),
    name: requiredText(v.name, 128),
    profileId: requiredId(v.profileId),
    profileRevision: requiredRevision(v.profileRevision),
    profileHash: requiredHash(v.profileHash),
  });
}
function persona(v: Record<string, unknown>): UserPersona {
  const description = optionalText(v.description, 4_096);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    personaId: requiredId(v.personaId),
    name: requiredText(v.name, 128),
    ...(description === undefined ? {} : { description }),
  });
}
function scenario(v: Record<string, unknown>): Scenario {
  if (!only(v, ["schemaVersion", "revision", "scenarioId", "name", "description", "text", "provenance", "owner"])) fail();
  const name = optionalText(v.name, 128);
  const description = optionalText(v.description, 8_192);
  const provenance = requiredProvenance(v.provenance);
  const owner = requiredOwner(v.owner);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    scenarioId: requiredId(v.scenarioId),
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    text: requiredText(v.text, 8_192),
    provenance,
    owner,
  });
}
function examples(v: Record<string, unknown>): DialogueExamples {
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
    const label = optionalText(x.label, 128);
    return freeze({
      variantId: requiredId(x.variantId),
      ...(label === undefined ? {} : { label }),
      text: requiredText(x.text, 8_192),
    });
  });
  if (new Set(variants.map((x) => x.variantId)).size !== variants.length) fail();
  const label = optionalText(v.label, 128);
  return freeze({
    schemaVersion: TAVERN_SCHEMA_VERSION,
    revision: requiredRevision(v.revision),
    greetingSetId: requiredId(v.greetingSetId),
    ...(label === undefined ? {} : { label }),
    variants: freeze(variants),
  });
}
function thread(v: Record<string, unknown>): ChatThread {
  if (!record(v.openingSelection)) fail();
  const personaId = optionalId(v.personaId);
  const scenarioId = optionalId(v.scenarioId);
  const openingLockedAtEventId = optionalId(v.openingLockedAtEventId);
  const selection = v.openingSelection;
  const opening =
    selection.kind === "blank"
      ? freeze({ kind: "blank" as const })
      : selection.kind === "greeting"
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
function fail(): never {
  throw new Error("invalid_tavern_artifact");
}
