import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import {
  createIdentityProfileBinding,
  DEFAULT_IDENTITY_PROFILE,
  readIdentityProfile,
  identityProfileMetadata,
  type IdentityProfile,
  identityProfileHash,
  writeIdentityProfile,
  writeIdentityProfileBinding,
} from "../identity-profile.js";
import { withPathLock } from "../path-lock.js";
import { type CompanionIdentity, identityKey, resolveRuntimePaths } from "../runtime.js";
import { join } from "node:path";
import { TavernArtifactStore } from "./artifact-store.js";
import { writeCompanionCardExtensions } from "./card-extensions.js";
import { writeCompanionCardMetadata } from "./card-metadata.js";
import { companionAvatarPath, writeAvatarFile } from "./companion-avatar/index.js";
import { type ChatThreadStore, createChatThreadStore } from "./chat-thread-store.js";
import { createGreetingManagementService } from "./greeting-management/greeting-management.js";
import { createTavernLibraryService } from "./library-service.js";
import { type MacroTable, macroTable, renderMacros } from "./macro-engine.js";
import { writeCompanionPostHistoryInstructions } from "./post-history-instructions.js";
import { DEFAULT_COMPANION_LOCALE, type CompanionLocale } from "../settings/player-preference-store.js";
import { createScenarioManagementService } from "./scenario-management/scenario-management.js";
import { resolveTavernPaths } from "./tavern-paths.js";
import type { CharacterCandidate, TavernCompanion } from "./types.js";
import { validateWorldBook, worldBookMetadata, writeWorldBook, type WorldBook } from "../worldbook.js";

/** Explicit review boundary: candidates cannot alter an existing companion. */
export type NewCompanionReview = Readonly<{
  candidateId: string;
  candidateRevision: number;
  sourceHash: string;
  reviewedFields: readonly string[];
  approvedAtMs: number;
}>;
type NewCompanionMetadata = Readonly<{
  companionId: string;
  continuityId: string;
  name: string;
  profileId: string;
  profileRevision: number;
  profileHash: string;
}>;
export type NewCompanionWriter = Readonly<{ create(input: NewCompanionMetadata): Promise<TavernCompanion> }>;
export type NewCompanionService = Readonly<{
  review(
    candidate: CharacterCandidate,
    input: Readonly<{ reviewedFields: readonly string[]; approvedAtMs: number }>,
  ): NewCompanionReview;
  create(
    review: NewCompanionReview,
    candidate: CharacterCandidate,
    metadata: NewCompanionMetadata,
  ): Promise<TavernCompanion>;
}>;
export type NewCompanionProvision = Readonly<{
  companion: TavernCompanion;
  identity: CompanionIdentity;
  profile: IdentityProfile;
}>;
/**
 * The reviewed card material a provisioned companion owns beside her profile.
 *
 * Each member is a record written through its own product-owned writer: the
 * world book, the scenario, the greeting set, her picture, and the card's
 * open-by-design `extensions` object. A card that wrote none of one leaves that
 * member absent, so nothing is invented for her.
 */
type ProvisionedCardMaterial = Readonly<{
  approved?: ReadonlyMap<string, string>;
  /** The card's openings, macro-rendered with her reviewed name and the run's locale. */
  greetings?: readonly Readonly<{ label: string; text: string }>[];
  worldBookCandidates?: CharacterCandidate["worldBookCandidates"];
  worldBookScanDepth?: number;
  avatar?: Uint8Array;
  extensions?: Readonly<Record<string, unknown>>;
  /** The card's own closing direction, kept as her own record when it wrote one. */
  postHistoryInstructions?: string;
  /** The card's fields this product does not interpret, kept as her own record. */
  preservedFields?: Readonly<Record<string, unknown>>;
}>;

/**
 * Direct New Companion starts from a player-supplied display name only. It
 * never accepts an identity, continuity, profile, namespace, or source text
 * from the browser and cannot alter the active companion.
 */
export async function provisionDirectNewCompanion(
  root: string,
  playerId: string,
  name: string,
): Promise<NewCompanionProvision> {
  if (!text(name, 128)) throw new Error("invalid_new_companion_name");
  const companionId = `companion-${randomUUID()}`;
  const continuityId = `continuity-${randomUUID()}`;
  const identity: CompanionIdentity = Object.freeze({ playerId, companionId, continuityId });
  const profile = directProfile(name, companionId, continuityId);
  return provisionNewCompanionNamespace(root, identity, profile);
}

export function createNewCompanionService(writer: NewCompanionWriter): NewCompanionService {
  return Object.freeze({
    review(candidate, input) {
      const available = new Set(
        candidate.fields
          .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
          .map((field) => field.field),
      );
      const fields = [...input.reviewedFields];
      if (
        !Number.isSafeInteger(input.approvedAtMs) ||
        input.approvedAtMs < 0 ||
        fields.length === 0 ||
        new Set(fields).size !== fields.length ||
        !fields.every((field) => available.has(field))
      )
        throw new Error("invalid_new_companion_review");
      return Object.freeze({
        candidateId: candidate.candidateId,
        candidateRevision: candidate.revision,
        sourceHash: candidate.sourceHash,
        reviewedFields: Object.freeze(fields),
        approvedAtMs: input.approvedAtMs,
      });
    },
    async create(review, candidate, metadata) {
      if (
        review.candidateId !== candidate.candidateId ||
        review.candidateRevision !== candidate.revision ||
        review.sourceHash !== candidate.sourceHash
      )
        throw new Error("new_companion_review_required");
      validateMetadata(metadata);
      return writer.create(Object.freeze({ ...metadata }));
    },
  });
}

/**
 * Creates an entirely new Host-owned identity namespace. The imported candidate
 * is only used for fields that the persisted review explicitly approved; no
 * browser value supplies an ID, profile path, or continuity.
 */
export async function provisionNewCompanion(
  root: string,
  playerId: string,
  candidate: CharacterCandidate,
  review: NewCompanionReview,
  threads: ChatThreadStore,
  /**
   * The reviewed card's own picture, read from the staged import. Absent for a
   * `.json` card and for a PNG whose image the import could not keep - both of
   * which the player was told about at stage time.
   */
  avatar?: Uint8Array,
  /**
   * The run's companion language, the one authority every authored-text render
   * in the Host reads (`resolveCompanionLocale`). A reviewed card's macros need
   * it for the same reason the compiled preset path does: `{{user}}` is the
   * player *being addressed*, and the run's own word for them is what her
   * persona and her opening must say.
   */
  locale: CompanionLocale = DEFAULT_COMPANION_LOCALE,
): Promise<NewCompanionProvision> {
  // Validation is deliberately performed before any namespace or profile exists.
  if (
    review.candidateId !== candidate.candidateId ||
    review.candidateRevision !== candidate.revision ||
    review.sourceHash !== candidate.sourceHash
  )
    throw new Error("new_companion_review_required");
  const approved = new Map(
    candidate.fields
      .filter((field) => review.reviewedFields.includes(field.field))
      .map((field) => [field.field, field.text]),
  );
  const companionId = `companion-${randomUUID()}`;
  const continuityId = `continuity-${randomUUID()}`;
  const identity: CompanionIdentity = Object.freeze({ playerId, companionId, continuityId });
  const profile = reviewedProfile(approved, companionId, continuityId, locale);
  return provisionNewCompanionNamespace(
    root,
    identity,
    profile,
    threads,
    Object.freeze({
      approved,
      greetings: buildGreetingVariants(approved, macroTable({ char: profile.identity.name, locale })),
      ...(candidate.worldBookCandidates === undefined ? {} : { worldBookCandidates: candidate.worldBookCandidates }),
      ...(candidate.worldBookScanDepth === undefined ? {} : { worldBookScanDepth: candidate.worldBookScanDepth }),
      ...(avatar === undefined ? {} : { avatar }),
      ...(candidate.extensions === undefined ? {} : { extensions: candidate.extensions }),
      ...(candidate.postHistoryInstructions === undefined
        ? {}
        : { postHistoryInstructions: candidate.postHistoryInstructions }),
      ...(candidate.preservedFields === undefined ? {} : { preservedFields: candidate.preservedFields }),
    }),
  );
}

async function provisionNewCompanionNamespace(
  root: string,
  identity: CompanionIdentity,
  profile: IdentityProfile,
  suppliedThreads?: ChatThreadStore,
  card?: ProvisionedCardMaterial,
): Promise<NewCompanionProvision> {
  const paths = resolveRuntimePaths(identity, root);
  // The containment-aware lock creates and verifies each parent component
  // before entering the transaction. A pre-existing namespace is never
  // adopted or overwritten.
  return await withPathLock(
    paths.runtimeCwd,
    async () => {
      await mkdir(paths.runtimeCwd, { recursive: false });
      await writeIdentityProfile(paths.identityProfilePath, profile, { containmentRoot: paths.root });
      await writeIdentityProfileBinding(
        paths.identityProfileBindingPath,
        createIdentityProfileBinding(identityKey(identity), profile),
        { containmentRoot: paths.root },
      );
      // S3: the reviewed card's world book lands as the companion's bound
      // worldbook.json (WorldBookBinding) — constant entries become the Tier 2
      // m[0] lorebook_constant source, keyword entries stay queryable/volatile.
      // The thread carries only the metadata binding; the body stays at the
      // independently-audited runtime path.
      if (card?.worldBookCandidates !== undefined && card.worldBookCandidates.length > 0) {
        const book: WorldBook = validateWorldBook(
          Object.freeze({
            schemaVersion: 1,
            worldBookId: `gamebuddy-worldbook-${identity.companionId}`,
            revision: 1,
            alwaysOnPremise: "",
            ...(card.worldBookScanDepth === undefined ? {} : { scanDepth: card.worldBookScanDepth }),
            entries: Object.freeze(
              card.worldBookCandidates.map((entry) =>
                Object.freeze({
                  entryId: entry.entryId,
                  title: entry.title,
                  content: entry.content,
                  scope: entry.scope,
                  provenance: entry.provenance,
                  tokenBudget: entry.tokenBudget,
                  ...(entry.constant === undefined ? {} : { constant: entry.constant }),
                  ...(entry.keys === undefined ? {} : { keys: entry.keys }),
                  // The card's secondary gate and its logic are part of the book the companion
                  // carries: a provisioning that copied only `keys` would persist a book whose
                  // entries select where the card said they should not.
                  ...(entry.secondaryKeys === undefined ? {} : { secondaryKeys: entry.secondaryKeys }),
                  ...(entry.selectiveLogic === undefined ? {} : { selectiveLogic: entry.selectiveLogic }),
                }),
              ),
            ),
          }),
        );
        await writeWorldBook(join(paths.runtimeCwd, "worldbook.json"), book);
        // The metadata binding itself is currently unused by the thread creation
        // flow (b178a13); only the durable worldbook.json body is authoritative.
        void worldBookMetadata(book);
      }
      const tavernPaths = resolveTavernPaths(paths, identity);
      const scenarioService = createScenarioManagementService(
        new TavernArtifactStore(paths.root),
        tavernPaths.companionRoot,
      );
      const greetingService = createGreetingManagementService(
        new TavernArtifactStore(paths.root),
        tavernPaths.companionRoot,
      );
      const scenario = card?.approved?.get("scenario");
      if (scenario !== undefined && scenario.trim() !== "") {
        await scenarioService.create({ name: "Default Scenario", description: scenario });
      }
      if (card?.greetings !== undefined && card.greetings.length > 0) {
        await greetingService.create({ label: "Initial Greeting", variants: card.greetings });
      }
      // The card's own open-by-design `extensions` object, as her own record -
      // the same kind of authored card material her scenario and her openings are.
      // It is deliberately not a profile field: nothing renders it and nothing
      // executes it, and the card export writes it back so a player who exports
      // what they imported gets the same card. A card that wrote none writes
      // nothing, so absence stays absence rather than becoming an empty object.
      if (card?.extensions !== undefined)
        await writeCompanionCardExtensions(
          new TavernArtifactStore(paths.root),
          tavernPaths.companionRoot,
          card.extensions,
        );
      // The card's own closing direction, as her own record beside the scenario and
      // the openings above. A card that wrote none writes nothing, so "the card said
      // nothing" stays distinguishable from an empty string.
      if (card?.postHistoryInstructions !== undefined)
        await writeCompanionPostHistoryInstructions(
          new TavernArtifactStore(paths.root),
          tavernPaths.companionRoot,
          card.postHistoryInstructions,
        );
      // The fields the card wrote that this product does not interpret, kept so the export can write them back.
      // The compatibility manifest calls them `preserved_opaque`; until this record existed that was a
      // classification with nothing behind it, and an author's notes, tags, name and version were lost at import.
      if (card?.preservedFields !== undefined)
        await writeCompanionCardMetadata(
          new TavernArtifactStore(paths.root),
          tavernPaths.companionRoot,
          card.preservedFields,
        );
      // The reviewed card's own picture, written where the avatar face reads it.
      // The companion's root is created here if the card carried neither a
      // scenario nor a greeting, and the write is atomic: a half-written picture
      // is never a picture the browser can fetch.
      if (card?.avatar !== undefined)
        await writeAvatarFile(
          companionAvatarPath(paths.root, identity.playerId, {
            companionId: identity.companionId,
            continuityId: identity.continuityId!,
          }),
          card.avatar,
          paths.root,
        );
      const threads = suppliedThreads ?? createChatThreadStore(paths.runtimeCwd, identityKey(identity));
      try {
        const library = createTavernLibraryService(tavernPaths, new TavernArtifactStore(paths.root), threads, {
          async readExact() {
            return identityProfileMetadata(await readIdentityProfile(paths.identityProfilePath));
          },
        });
        const companion = await library.createNewCompanion({
          companionId: identity.companionId,
          continuityId: identity.continuityId!,
          name: profile.identity.name,
          profileId: profile.profileId,
          profileRevision: profile.revision,
          profileHash: identityProfileHash(profile),
        });
        return Object.freeze({ companion, identity, profile });
      } finally {
        // Only the store this call created is disposed here; a caller-supplied
        // store stays its own owner's for the caller's lifetime.
        if (suppliedThreads === undefined) threads.close?.();
      }
    },
    { containmentRoot: paths.root },
  );
}

/**
 * The default opening keeps its existing identity; each approved alternate
 * opening (candidate field `alternate_greeting_<n>`, decoded from the card's
 * `alternate_greetings`) becomes a labelled variant. Labels are the card's own
 * stable 1-based order - the ST v2/v3 spec attaches no per-entry label - so the
 * same card always produces the same labels. These are Thread History openings
 * (a new chat's first assistant message), never Stable Prefix Context, so they
 * are persisted on the greeting record and never published as a context source.
 */
function buildGreetingVariants(
  approved: ReadonlyMap<string, string>,
  macros: MacroTable,
): readonly Readonly<{ label: string; text: string }>[] {
  // An opening is the card's own prose exactly as a persona line is, so it is
  // rendered through the same table: a card that writes `{{user}}` in her
  // `first_mes` must not ship the placeholder - or a partition id - as the
  // conversation's own first line.
  const render = (value: string): string => renderMacros(value, macros);
  const variants: Readonly<{ label: string; text: string }>[] = [];
  const firstGreeting = approved.get("first_greeting");
  if (firstGreeting !== undefined && firstGreeting.trim() !== "")
    variants.push(Object.freeze({ label: "Default", text: render(firstGreeting) }));
  const alternates = [...approved.entries()]
    .filter(([field]) => /^alternate_greeting_\d+$/u.test(field))
    .sort(([left], [right]) => left.localeCompare(right, "en", { numeric: true }));
  for (const [field, text] of alternates) {
    if (text.trim() === "") continue;
    const order = Number(field.slice("alternate_greeting_".length));
    variants.push(Object.freeze({ label: `Alternate ${order}`, text: render(text) }));
  }
  return Object.freeze(variants);
}

function directProfile(name: string, companionId: string, continuityId: string): IdentityProfile {
  const base = DEFAULT_IDENTITY_PROFILE;
  return Object.freeze({
    ...base,
    profileId: `gamebuddy.${companionId}`,
    identity: Object.freeze({
      ...base.identity,
      name,
      continuity: `Host-owned continuity ${continuityId}; ${base.identity.continuity}`,
    }),
  });
}

/**
 * The companion's reviewed name: the card's own when the player approved it,
 * otherwise the default. It never applies silently, and it is bounded like every
 * other identity field. One decision, because her name is also the `{{char}}`
 * every piece of her reviewed card prose renders through.
 */
function reviewedName(fields: ReadonlyMap<string, string>): string {
  const reviewed = fields.get("name")?.trim();
  return reviewed === undefined || reviewed.length === 0
    ? DEFAULT_IDENTITY_PROFILE.identity.name
    : reviewed.slice(0, 128);
}

function reviewedProfile(
  fields: ReadonlyMap<string, string>,
  companionId: string,
  continuityId: string,
  locale: CompanionLocale,
): IdentityProfile {
  const base = DEFAULT_IDENTITY_PROFILE;
  const name = reviewedName(fields);
  const identity = Object.freeze({
    ...base.identity,
    name,
    continuity: `Host-owned continuity ${continuityId}; ${base.identity.continuity}`,
  });
  // The one player-reference decision (`macroTable`) and the one rendering call,
  // exactly as the compiled preset path (`candidateToIdentityProfile`) does them.
  // This path used to build its own table with the player's opaque partition id
  // (`player_01`), so a card that wrote `{{user}}` once froze that id into her
  // Tier-1 persona and repeated it to the model on every turn.
  const macros = macroTable({ char: name, locale });
  const render = (value: string): string => renderMacros(value, macros);
  const core = fields.get("persona_core");
  const interactionStyle = fields.get("persona_interaction_style");
  const expressionStyle = fields.get("persona_expression_style");
  // Only the reviewed dimensions the card actually wrote. The missing ones used
  // to be padded from `DEFAULT_IDENTITY_PROFILE` (or an inline English sentence),
  // so importing a Chinese card into a Chinese run froze English Host prose into
  // the companion's own Tier-1 persona. The card either says how she interacts
  // or it does not; the Host's floor lives in the system prompt, not in a
  // third-party card's persona.
  const persona =
    core === undefined && interactionStyle === undefined && expressionStyle === undefined
      ? undefined
      : Object.freeze({
          ...(core === undefined ? {} : { core: render(core) }),
          ...(interactionStyle === undefined ? {} : { interactionStyle: render(interactionStyle) }),
          ...(expressionStyle === undefined ? {} : { expressionStyle: render(expressionStyle) }),
        });
  // Reviewed example dialogues: fields are "example_N" with a JSON-encoded
  // {user, companion} pair written by candidateFromReport. Only approved rows
  // are consumed, each rendered through the same card macros as the persona.
  const examples = Object.freeze(
    Object.entries(Object.fromEntries([...fields.entries()].filter(([name]) => /^example_\d+$/u.test(name))))
      .sort(([a], [b]) => a.localeCompare(b, "en", { numeric: true }))
      .flatMap(([, raw]) => {
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            !("user" in parsed) ||
            !("companion" in parsed) ||
            typeof (parsed as { user?: unknown }).user !== "string" ||
            typeof (parsed as { companion?: unknown }).companion !== "string"
          )
            return [];
          const pair = parsed as { user: string; companion: string };
          return [Object.freeze({ user: render(pair.user), companion: render(pair.companion) })];
        } catch {
          return [];
        }
      }),
  );
  // The card's own performance directive, from the reviewed `system_prompt`
  // field. Only an approved field is consumed (like every other reviewed field),
  // and it renders AFTER the Host floor in `buildCompanionSystemPrompt`.
  const reviewedVoice = fields.get("system_prompt");
  const characterVoice =
    reviewedVoice === undefined || reviewedVoice.trim().length === 0
      ? undefined
      : Object.freeze({ text: render(reviewedVoice), source: "card" as const });
  return Object.freeze({
    ...base,
    profileId: `gamebuddy.${companionId}`,
    identity,
    ...(persona === undefined ? {} : { persona }),
    ...(examples.length === 0 ? {} : { examples }),
    ...(characterVoice === undefined ? {} : { characterVoice }),
  });
}
function validateMetadata(value: NewCompanionMetadata): void {
  if (
    ![value.companionId, value.continuityId, value.profileId].every(isId) ||
    !text(value.name, 128) ||
    !positive(value.profileRevision) ||
    !/^[a-f0-9]{64}$/u.test(value.profileHash)
  )
    throw new Error("invalid_new_companion_metadata");
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
function text(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/u.test(value)
  );
}
function positive(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
